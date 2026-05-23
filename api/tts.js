const https = require("https");

const ALLOWED_VOICES = [
  "pt-BR-ThalitaNeural","pt-BR-FranciscaNeural","pt-BR-BrendaNeural",
  "pt-BR-GiovannaNeural","pt-BR-AntonioNeural","pt-BR-DonatoNeural",
  "pt-BR-FabioNeural","pt-BR-HumbertoNeural","pt-BR-JulioNeural",
];

function httpsPost(hostname, path, body) {
  return new Promise((resolve, reject) => {
    const bodyStr = JSON.stringify(body);
    const req = https.request({
      hostname, path, method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(bodyStr), "User-Agent": "Mozilla/5.0" },
    }, (res) => {
      const chunks = [];
      res.on("data", d => chunks.push(d));
      res.on("end", () => resolve({ status: res.statusCode, body: Buffer.concat(chunks) }));
      res.on("error", reject);
    });
    req.on("error", reject);
    req.write(bodyStr);
    req.end();
  });
}

function httpsGet(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { "User-Agent": "Mozilla/5.0" } }, (res) => {
      const chunks = [];
      res.on("data", d => chunks.push(d));
      res.on("end", () => resolve({ status: res.statusCode, body: Buffer.concat(chunks) }));
      res.on("error", reject);
    }).on("error", reject);
  });
}

module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") { res.status(200).end(); return; }
  if (req.method !== "POST") { res.status(405).json({ error: "Method not allowed" }); return; }

  let body = "";
  for await (const chunk of req) body += chunk;

  let text, voice, speed;
  try { ({ text, voice, speed } = JSON.parse(body)); }
  catch { res.status(400).json({ error: "JSON inválido" }); return; }

  if (!text || typeof text !== "string") { res.status(400).json({ error: "Texto inválido" }); return; }
  if (!ALLOWED_VOICES.includes(voice)) voice = "pt-BR-ThalitaNeural";
  speed = parseFloat(speed) || 1;

  const rate = Math.round((speed - 1) * 100);
  const rateStr = rate >= 0 ? `+${rate}%` : `${rate}%`;

  try {
    // Step 1: POST to FreeTTS to get file_id
    const genRes = await httpsPost("freetts.org", "/api/tts", {
      text: text.slice(0, 4000),
      voice,
      rate: rateStr,
      pitch: "+0Hz",
    });

    if (genRes.status !== 200) {
      throw new Error(`FreeTTS retornou ${genRes.status}: ${genRes.body.toString().slice(0, 200)}`);
    }

    const json = JSON.parse(genRes.body.toString());
    if (!json.file_id) throw new Error("Sem file_id na resposta: " + JSON.stringify(json));

    // Step 2: GET the MP3
    const audioRes = await httpsGet(`https://freetts.org/api/audio/${json.file_id}`);
    if (audioRes.status !== 200) throw new Error(`Erro ao baixar áudio: ${audioRes.status}`);

    res.setHeader("Content-Type", "audio/mpeg");
    res.setHeader("Content-Length", audioRes.body.length);
    res.setHeader("Cache-Control", "public, max-age=3600");
    res.status(200).end(audioRes.body);

  } catch(e) {
    console.error("TTS error:", e.message);
    res.status(500).json({ error: e.message });
  }
};

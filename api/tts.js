const { Readable } = require("stream");

const VOICES = [
  "pt-BR-ThalitaNeural","pt-BR-FranciscaNeural","pt-BR-BrendaNeural",
  "pt-BR-GiovannaNeural","pt-BR-AntonioNeural","pt-BR-DonatoNeural",
  "pt-BR-FabioNeural","pt-BR-HumbertoNeural","pt-BR-JulioNeural",
];

function buildSSML(text, voice, rate) {
  const rateStr = rate >= 0 ? `+${rate}%` : `${rate}%`;
  const escaped = text.replace(/[<>&'"]/g, c =>
    ({ "<":"&lt;",">":"&gt;","&":"&amp;","'":"&apos;",'"':"&quot;" }[c])
  );
  return `<speak version='1.0' xml:lang='pt-BR'><voice name='${voice}'><prosody rate='${rateStr}'>${escaped}</prosody></voice></speak>`;
}

function rateToPercent(speed) {
  return Math.round((parseFloat(speed) - 1) * 100);
}

async function edgeTTS(text, voice, speed) {
  const { default: WebSocket } = await import("ws");
  const connectionId = [...Array(32)].map(() => Math.floor(Math.random()*16).toString(16)).join("");
  const ENDPOINT = `wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1?TrustedClientToken=6A5AA1D4EAFF4E9FB37E23D68491D6F4&ConnectionId=${connectionId}`;

  return new Promise((resolve, reject) => {
    const ws = new WebSocket(ENDPOINT, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0",
        "Origin": "chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold",
        "Pragma": "no-cache",
        "Cache-Control": "no-cache",
      }
    });

    const chunks = [];
    const timeout = setTimeout(() => { ws.close(); reject(new Error("Timeout")); }, 20000);

    ws.on("open", () => {
      ws.send(`Path: speech.config\r\nX-RequestId: ${connectionId}\r\nX-Timestamp: ${new Date().toISOString()}\r\nContent-Type: application/json\r\n\r\n{"context":{"synthesis":{"audio":{"metadataoptions":{"sentenceBoundaryEnabled":false,"wordBoundaryEnabled":false},"outputFormat":"audio-24khz-48kbitrate-mono-mp3"}}}}`);
      ws.send(`Path: ssml\r\nX-RequestId: ${connectionId}\r\nX-Timestamp: ${new Date().toISOString()}\r\nContent-Type: application/ssml+xml\r\n\r\n${buildSSML(text, voice, rateToPercent(speed))}`);
    });

    ws.on("message", (data) => {
      if (typeof data === "string") {
        if (data.includes("Path:turn.end")) {
          clearTimeout(timeout);
          ws.close();
          resolve(Buffer.concat(chunks));
        }
      } else {
        const buf = Buffer.from(data);
        const separator = Buffer.from("Path:audio\r\n");
        const idx = buf.indexOf(separator);
        if (idx !== -1) chunks.push(buf.slice(idx + separator.length));
      }
    });

    ws.on("error", (e) => { clearTimeout(timeout); reject(e); });
  });
}

module.exports = async function handler(req, res) {
  // CORS
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") { res.status(200).end(); return; }
  if (req.method !== "POST") { res.status(405).json({ error: "Method not allowed" }); return; }

  let body = "";
  for await (const chunk of req) body += chunk;

  let text, voice, speed;
  try {
    ({ text, voice, speed } = JSON.parse(body));
  } catch {
    res.status(400).json({ error: "Invalid JSON" }); return;
  }

  if (!text || typeof text !== "string" || text.length > 5000) {
    res.status(400).json({ error: "Invalid text" }); return;
  }
  if (!VOICES.includes(voice)) voice = "pt-BR-ThalitaNeural";
  if (!speed) speed = 1;

  try {
    const audioBuffer = await edgeTTS(text.slice(0, 4000), voice, speed);
    res.setHeader("Content-Type", "audio/mpeg");
    res.setHeader("Content-Length", audioBuffer.length);
    res.setHeader("Cache-Control", "public, max-age=3600");
    res.status(200).end(audioBuffer);
  } catch (e) {
    console.error("TTS error:", e.message);
    res.status(500).json({ error: e.message });
  }
};

// api/tts.js — Edge TTS via WebSocket no servidor (sem restrições do browser)
const { WebSocket } = require("ws");
const { randomUUID } = require("crypto");

const ALLOWED_VOICES = [
  "pt-BR-ThalitaNeural","pt-BR-FranciscaNeural","pt-BR-BrendaNeural",
  "pt-BR-GiovannaNeural","pt-BR-AntonioNeural","pt-BR-DonatoNeural",
  "pt-BR-FabioNeural","pt-BR-HumbertoNeural","pt-BR-JulioNeural",
];

function buildSSML(text, voice, rateStr) {
  const esc = text.replace(/[<>&'"]/g, c => ({"<":"&lt;",">":"&gt;","&":"&amp;","'":"&apos;",'"':"&quot;"}[c]));
  return `<speak version='1.0' xml:lang='pt-BR'><voice name='${voice}'><prosody rate='${rateStr}'>${esc}</prosody></voice></speak>`;
}

function edgeTTS(text, voice, rateStr) {
  return new Promise((resolve, reject) => {
    const reqId = randomUUID().replace(/-/g,"").toUpperCase();
    const timestamp = new Date().toISOString().replace(/[:-]/g,"").replace(".",":").slice(0,19) + "Z";
    const url = `wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1?TrustedClientToken=6A5AA1D4EAFF4E9FB37E23D68491D6F4&ConnectionId=${reqId}`;
    
    const ws = new WebSocket(url, {
      headers: {
        "Pragma": "no-cache",
        "Cache-Control": "no-cache",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 Edg/120.0.0.0",
        "Origin": "chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold",
      }
    });

    const audioChunks = [];
    let audioStarted = false;
    const timeout = setTimeout(() => { ws.close(); reject(new Error("Timeout")); }, 20000);

    ws.on("open", () => {
      // Mensagem de configuração
      ws.send(
        `X-Timestamp:${timestamp}\r\nContent-Type:application/json; charset=utf-8\r\nPath:speech.config\r\n\r\n` +
        JSON.stringify({ context: { synthesis: { audio: { metadataoptions: { sentenceBoundaryEnabled: false, wordBoundaryEnabled: false }, outputFormat: "audio-24khz-48kbitrate-mono-mp3" } } } })
      );
      // Mensagem SSML
      ws.send(
        `X-RequestId:${reqId}\r\nContent-Type:application/ssml+xml\r\nX-Timestamp:${timestamp}\r\nPath:ssml\r\n\r\n` +
        buildSSML(text, voice, rateStr)
      );
    });

    ws.on("message", (data, isBinary) => {
      if (isBinary) {
        // Áudio binário — achar onde começa o MP3 (após header "Path:audio\r\n\r\n")
        const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
        if (!audioStarted) {
          const header = buf.slice(0, 2).readUInt16BE(0);
          const headerStr = buf.slice(2, 2 + header).toString();
          if (headerStr.includes("Path:audio")) {
            audioStarted = true;
            audioChunks.push(buf.slice(2 + header));
          }
        } else {
          audioChunks.push(buf);
        }
      } else {
        const msg = data.toString();
        if (msg.includes("Path:turn.end")) {
          clearTimeout(timeout);
          ws.close();
          if (!audioChunks.length) { reject(new Error("Nenhum áudio recebido")); return; }
          resolve(Buffer.concat(audioChunks));
        }
      }
    });

    ws.on("error", (err) => { clearTimeout(timeout); reject(err); });
    ws.on("close", () => { clearTimeout(timeout); });
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
    const audioBuffer = await edgeTTS(text.slice(0, 4000), voice, rateStr);
    res.setHeader("Content-Type", "audio/mpeg");
    res.setHeader("Content-Length", audioBuffer.length);
    res.setHeader("Cache-Control", "public, max-age=3600");
    res.status(200).end(audioBuffer);
  } catch(e) {
    console.error("TTS error:", e.message);
    res.status(500).json({ error: e.message });
  }
};

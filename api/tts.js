// api/tts.js — sem dependências externas, chama Microsoft Edge TTS direto
import { randomUUID } from "crypto";
import { createRequire } from "module";

export const config = { maxDuration: 30 };

// Gera o XML de configuração que o Edge TTS espera
function buildSSML(text, voice) {
  const escaped = text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .slice(0, 2800);
  return `<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='pt-BR'>` +
    `<voice name='${voice}'>${escaped}</voice></speak>`;
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") { res.status(200).end(); return; }
  if (req.method !== "POST") { res.status(405).end(); return; }

  const { text, voice = "pt-BR-ThalitaNeural" } = req.body || {};
  if (!text) { res.status(400).json({ error: "Texto obrigatório" }); return; }

  const requestId = randomUUID().replace(/-/g, "");
  const timestamp = new Date().toISOString().replace(/[:-]/g, "").replace(".", "").slice(0, 15) + "Z";

  const wsUrl = `wss://eastus.tts.speech.microsoft.com/cognitiveservices/websocket/v1?TrustedClientToken=6A5AA1D4EAFF4E9FB37E23D68491D6F4&ConnectionId=${requestId}`;

  try {
    // Dynamically import ws (available in Node.js on Vercel)
    let WebSocket;
    try {
      const { WebSocket: WS } = await import("ws");
      WebSocket = WS;
    } catch {
      // fallback to global
      WebSocket = globalThis.WebSocket;
    }

    await new Promise((resolve, reject) => {
      const ws = new WebSocket(wsUrl, {
        headers: {
          "User-Agent": "Mozilla/5.0",
          "Origin": "chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold",
        },
      });

      const audioChunks = [];
      let headersDone = false;

      ws.binaryType = "arraybuffer";

      ws.on("open", () => {
        // Send speech config
        ws.send(
          `X-Timestamp:${timestamp}\r\nContent-Type:application/json; charset=utf-8\r\nPath:speech.config\r\n\r\n` +
          JSON.stringify({ context: { synthesis: { audio: { metadataoptions: { sentenceBoundaryEnabled: false, wordBoundaryEnabled: false }, outputFormat: "audio-24khz-48kbitrate-mono-mp3" } } } })
        );

        // Send SSML
        const ssml = buildSSML(text, voice);
        ws.send(
          `X-RequestId:${requestId}\r\nContent-Type:application/ssml+xml\r\nX-Timestamp:${timestamp}\r\nPath:ssml\r\n\r\n${ssml}`
        );
      });

      ws.on("message", (data) => {
        if (typeof data === "string") {
          if (data.includes("Path:turn.end")) {
            ws.close();
          }
        } else {
          // Binary: find audio header separator
          const buf = Buffer.from(data);
          if (!headersDone) {
            const separator = buf.indexOf(Buffer.from("Path:audio\r\n"));
            if (separator !== -1) {
              headersDone = true;
              audioChunks.push(buf.slice(separator + "Path:audio\r\n".length + 2));
            }
          } else {
            audioChunks.push(buf);
          }
        }
      });

      ws.on("close", () => {
        if (!audioChunks.length) { reject(new Error("Nenhum áudio recebido")); return; }
        const audio = Buffer.concat(audioChunks);
        res.setHeader("Content-Type", "audio/mpeg");
        res.setHeader("Cache-Control", "public, max-age=3600");
        res.status(200).send(audio);
        resolve();
      });

      ws.on("error", reject);

      setTimeout(() => { ws.close(); reject(new Error("Timeout")); }, 25000);
    });
  } catch (err) {
    console.error("TTS error:", err.message);
    if (!res.headersSent) res.status(500).json({ error: err.message });
  }
}

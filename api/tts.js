// api/tts.js — Vercel Serverless Function
// Recebe texto + voz, devolve áudio MP3 usando Microsoft Edge TTS (gratuito)

export const config = { maxDuration: 30 };

export default async function handler(req, res) {
  // CORS
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") { res.status(200).end(); return; }
  if (req.method !== "POST") { res.status(405).json({ error: "Método não permitido" }); return; }

  const { text, voice = "pt-BR-ThalitaNeural" } = req.body || {};
  if (!text) { res.status(400).json({ error: "Texto obrigatório" }); return; }

  try {
    const { Communicate } = await import("edge-tts-universal");

    const chunks = [];
    const tts = new Communicate(text.slice(0, 3000), voice);

    for await (const chunk of tts) {
      if (chunk.type === "audio" && chunk.data) {
        chunks.push(chunk.data);
      }
    }

    if (!chunks.length) {
      res.status(500).json({ error: "Nenhum áudio gerado" });
      return;
    }

    const audioBuffer = Buffer.concat(chunks);
    res.setHeader("Content-Type", "audio/mpeg");
    res.setHeader("Cache-Control", "public, max-age=3600");
    res.status(200).send(audioBuffer);
  } catch (err) {
    console.error("TTS error:", err);
    res.status(500).json({ error: err.message || "Erro ao gerar áudio" });
  }
}

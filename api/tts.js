// api/tts.js — usa fetch HTTP direto, sem WebSocket, sem pacotes externos
export const config = { maxDuration: 30 };

const VOICES = [
  "pt-BR-ThalitaNeural","pt-BR-FranciscaNeural","pt-BR-BrendaNeural",
  "pt-BR-GiovannaNeural","pt-BR-AntonioNeural","pt-BR-DonatoNeural",
  "pt-BR-FabioNeural","pt-BR-HumbertoNeural","pt-BR-JulioNeural"
];

function buildSSML(text, voice) {
  const safe = text
    .replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;")
    .slice(0, 2800);
  return `<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' `+
    `xmlns:mstts='http://www.w3.org/2001/mstts' xml:lang='pt-BR'>`+
    `<voice name='${voice}'>${safe}</voice></speak>`;
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") { res.status(200).end(); return; }
  if (req.method !== "POST") { res.status(405).end(); return; }

  const { text, voice = "pt-BR-ThalitaNeural" } = req.body || {};
  if (!text) { res.status(400).json({ error: "Texto obrigatório" }); return; }

  const safeVoice = VOICES.includes(voice) ? voice : "pt-BR-ThalitaNeural";

  try {
    // Passo 1: pegar token de autenticação gratuito do Edge
    const tokenRes = await fetch(
      "https://eastus.api.speech.microsoft.com/sts/v1.0/issueToken",
      {
        method: "POST",
        headers: {
          "Ocp-Apim-Subscription-Key": "6A5AA1D4EAFF4E9FB37E23D68491D6F4",
          "Content-Type": "application/x-www-form-urlencoded",
        },
      }
    );

    let token = null;
    if (tokenRes.ok) {
      token = await tokenRes.text();
    }

    // Passo 2: chamar TTS com token ou chave direta
    const ttsHeaders = {
      "Content-Type": "application/ssml+xml",
      "X-Microsoft-OutputFormat": "audio-24khz-48kbitrate-mono-mp3",
      "User-Agent": "LeitorPDF",
    };

    if (token) {
      ttsHeaders["Authorization"] = `Bearer ${token}`;
    } else {
      ttsHeaders["Ocp-Apim-Subscription-Key"] = "6A5AA1D4EAFF4E9FB37E23D68491D6F4";
    }

    const ttsRes = await fetch(
      "https://eastus.tts.speech.microsoft.com/cognitiveservices/v1",
      {
        method: "POST",
        headers: ttsHeaders,
        body: buildSSML(text, safeVoice),
      }
    );

    if (!ttsRes.ok) {
      // fallback: tenta região diferente
      const ttsRes2 = await fetch(
        "https://westus.tts.speech.microsoft.com/cognitiveservices/v1",
        {
          method: "POST",
          headers: {
            ...ttsHeaders,
            "Ocp-Apim-Subscription-Key": "6A5AA1D4EAFF4E9FB37E23D68491D6F4",
          },
          body: buildSSML(text, safeVoice),
        }
      );
      if (!ttsRes2.ok) {
        const errText = await ttsRes2.text().catch(() => "");
        throw new Error(`TTS falhou: ${ttsRes2.status} — ${errText.slice(0,200)}`);
      }
      const buf2 = Buffer.from(await ttsRes2.arrayBuffer());
      res.setHeader("Content-Type", "audio/mpeg");
      res.setHeader("Cache-Control", "public, max-age=3600");
      return res.status(200).send(buf2);
    }

    const buf = Buffer.from(await ttsRes.arrayBuffer());
    res.setHeader("Content-Type", "audio/mpeg");
    res.setHeader("Cache-Control", "public, max-age=3600");
    return res.status(200).send(buf);

  } catch (err) {
    console.error("TTS error:", err.message);
    if (!res.headersSent) res.status(500).json({ error: err.message });
  }
}

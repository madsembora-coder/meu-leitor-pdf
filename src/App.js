import { useState, useEffect, useRef, useCallback } from "react";

// ── PDF.js ───────────────────────────────────────────────────────────────
function loadPdfJs() {
  return new Promise((resolve, reject) => {
    if (window.__pdfJsReady) { resolve(window["pdfjs-dist/build/pdf"]); return; }
    const s = document.createElement("script");
    s.src = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js";
    s.onload = () => {
      window.__pdfJsReady = true;
      const lib = window["pdfjs-dist/build/pdf"];
      lib.GlobalWorkerOptions.workerSrc =
        "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";
      resolve(lib);
    };
    s.onerror = reject;
    document.head.appendChild(s);
  });
}

async function renderCover(buffer) {
  try {
    const lib = await loadPdfJs();
    const pdf = await lib.getDocument({ data: buffer.slice(0) }).promise;
    const page = await pdf.getPage(1);
    const vp0 = page.getViewport({ scale: 1 });
    const scale = Math.min(300 / vp0.width, 420 / vp0.height);
    const vp = page.getViewport({ scale });
    const canvas = document.createElement("canvas");
    canvas.width = vp.width; canvas.height = vp.height;
    await page.render({ canvasContext: canvas.getContext("2d"), viewport: vp }).promise;
    return canvas.toDataURL("image/jpeg", 0.8);
  } catch { return null; }
}

async function extractAllText(buffer, onProgress) {
  const lib = await loadPdfJs();
  const pdf = await lib.getDocument({ data: buffer }).promise;
  let allText = "";
  const BATCH = 15;
  for (let i = 1; i <= pdf.numPages; i += BATCH) {
    const end = Math.min(i + BATCH - 1, pdf.numPages);
    const texts = await Promise.all(
      Array.from({ length: end - i + 1 }, async (_, j) => {
        const page = await pdf.getPage(i + j);
        const c = await page.getTextContent();
        return c.items.map(x => x.str).join(" ");
      })
    );
    allText += texts.join("\n\n") + "\n\n";
    onProgress?.(Math.round((end / pdf.numPages) * 100));
  }
  return { text: allText, numPages: pdf.numPages };
}

function toParagraphs(text) {
  return text.split(/\n{2,}/).map(p => p.replace(/\s+/g, " ").trim()).filter(p => p.length > 30);
}

// ── Edge TTS via Cloudflare Worker ───────────────────────────────────────
const audioCache = {};
const WORKER_KEY = "tts_worker_url";
const getWorkerUrl = () => (localStorage.getItem(WORKER_KEY) || "").replace(/\/$/, "");
const saveWorkerUrl = url => localStorage.setItem(WORKER_KEY, url.trim());

async function fetchTTS(text, voice) {
  const workerUrl = getWorkerUrl();
  if (!workerUrl) throw new Error("Configure a URL do Cloudflare Worker primeiro!");

  const key = `${voice}::${text.slice(0, 60)}`;
  if (audioCache[key]) return audioCache[key];

  const res = await fetch(workerUrl + "/v1/audio/speech", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ input: text.slice(0, 2800), voice, model: "tts-1" }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `Erro ${res.status}`);
  }
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  audioCache[key] = url;
  return url;
}

// ── Voices ────────────────────────────────────────────────────────────────
const VOICES = [
  { id: "pt-BR-ThalitaNeural",   label: "Thalita — natural e suave 🌸" },
  { id: "pt-BR-FranciscaNeural", label: "Francisca — séria e clara" },
  { id: "pt-BR-BrendaNeural",    label: "Brenda — moderna" },
  { id: "pt-BR-GiovannaNeural",  label: "Giovanna — limpa e clara" },
  { id: "pt-BR-AntonioNeural",   label: "Antonio — masculino" },
  { id: "pt-BR-DonatoNeural",    label: "Donato — masculino grave" },
  { id: "pt-BR-FabioNeural",     label: "Fabio — masculino" },
  { id: "pt-BR-HumbertoNeural",  label: "Humberto — masculino" },
  { id: "pt-BR-JulioNeural",     label: "Julio — masculino" },
];

// ── Storage ───────────────────────────────────────────────────────────────
const LIB_KEY = "pdflib_v3";
const PROG_KEY = "pdfprog_v3";
const VOICE_KEY = "pdfvoice_v3";

const getLib = () => { try { return JSON.parse(localStorage.getItem(LIB_KEY) || "[]"); } catch { return []; } };
const saveLib = d => { try { localStorage.setItem(LIB_KEY, JSON.stringify(d)); } catch {} };
const getProgress = h => { try { return JSON.parse(localStorage.getItem(PROG_KEY) || "{}")[h] ?? 0; } catch { return 0; } };
const saveProgress = (h, i) => { try { const d = JSON.parse(localStorage.getItem(PROG_KEY) || "{}"); d[h] = i; localStorage.setItem(PROG_KEY, JSON.stringify(d)); } catch {} };
const getSavedVoice = () => localStorage.getItem(VOICE_KEY) || "pt-BR-ThalitaNeural";
const saveVoice = v => localStorage.setItem(VOICE_KEY, v);

async function hashBuffer(buf) {
  const h = await crypto.subtle.digest("SHA-1", buf.slice(0, 65536));
  return Array.from(new Uint8Array(h)).map(b => b.toString(16).padStart(2,"0")).join("").slice(0,14);
}

// ── Colors ────────────────────────────────────────────────────────────────
const C = {
  bg: "#0e0c14", s1: "#17141f", s2: "#211d2e",
  border: "#2d2840", acc: "#e8c97a", acc2: "#f5dfa0",
  text: "#f0ebe0", muted: "#7a7490", red: "#f87171",
};

const SPEEDS = [0.75, 1, 1.1, 1.25, 1.5, 1.75, 2];

// ── BookCard ──────────────────────────────────────────────────────────────
function BookCard({ book, onOpen, onDelete }) {
  const [hov, setHov] = useState(false);
  const pct = book.totalParas ? Math.round(((book.lastPara + 1) / book.totalParas) * 100) : 0;
  const fallbacks = [
    "linear-gradient(135deg,#b5451b,#7c1d0f)",
    "linear-gradient(135deg,#1a4a7a,#0d2844)",
    "linear-gradient(135deg,#2d5a27,#173314)",
    "linear-gradient(135deg,#5a2d7a,#2e1540)",
    "linear-gradient(135deg,#7a5a1a,#3d2d0a)",
  ];
  const fb = fallbacks[(book.hash?.charCodeAt(0) || 0) % fallbacks.length];

  return (
    <div onClick={() => onOpen(book)}
      onMouseEnter={() => setHov(true)} onMouseLeave={() => setHov(false)}
      style={{ cursor: "pointer", transform: hov ? "translateY(-5px)" : "none", transition: "transform .2s", display: "flex", flexDirection: "column" }}>
      <div style={{
        width: "100%", aspectRatio: "2/3", borderRadius: 10, overflow: "hidden",
        boxShadow: hov ? "0 20px 40px rgba(0,0,0,0.7)" : "0 6px 20px rgba(0,0,0,0.5)",
        background: fb, position: "relative", transition: "box-shadow .2s",
      }}>
        {book.cover
          ? <img src={book.cover} alt={book.title} style={{ width: "100%", height: "100%", objectFit: "cover" }} />
          : <div style={{ width: "100%", height: "100%", background: fb, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: 12 }}>
              <div style={{ fontSize: 28, marginBottom: 8, opacity: 0.6 }}>📖</div>
              <div style={{ color: "rgba(255,255,255,0.9)", fontSize: 12, fontWeight: 700, textAlign: "center", lineHeight: 1.4 }}>{book.title}</div>
            </div>
        }
        {pct > 0 && <div style={{ position: "absolute", bottom: 0, left: 0, right: 0, height: 4, background: "rgba(0,0,0,0.4)" }}>
          <div style={{ height: "100%", width: pct + "%", background: C.acc }} />
        </div>}
        <button onClick={e => { e.stopPropagation(); onDelete(book.hash); }}
          style={{ position: "absolute", top: 5, right: 5, background: "rgba(0,0,0,0.65)", color: "#fff", border: "none", borderRadius: "50%", width: 22, height: 22, fontSize: 11, cursor: "pointer", display: hov ? "flex" : "none", alignItems: "center", justifyContent: "center" }}>✕</button>
      </div>
      <div style={{ padding: "7px 2px 0" }}>
        <div style={{ fontSize: 12, fontWeight: 700, color: C.text, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{book.title}</div>
        <div style={{ fontSize: 11, color: C.muted, marginTop: 2 }}>{pct > 0 ? `${pct}% lido` : "Novo"} • {book.numPages} págs</div>
      </div>
    </div>
  );
}

// ── MAIN ──────────────────────────────────────────────────────────────────
export default function App() {
  const [view, setView] = useState("library");
  const [library, setLibrary] = useState([]);
  const [activeBook, setActiveBook] = useState(null);
  const [loadPct, setLoadPct] = useState(0);
  const [loadMsg, setLoadMsg] = useState("");
  const [errMsg, setErrMsg] = useState("");

  const [paras, setParas] = useState([]);
  const [cur, setCur] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [loadingAudio, setLoadingAudio] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [voice, setVoice] = useState(getSavedVoice);
  const [statusMsg, setStatusMsg] = useState("");
  const [workerUrl, setWorkerUrl] = useState(() => localStorage.getItem("tts_worker_url") || "");
  const [workerInput, setWorkerInput] = useState("");
  const [workerSet, setWorkerSet] = useState(() => !!localStorage.getItem("tts_worker_url"));

  const audioRef = useRef(null);
  const parasRef = useRef([]);
  const curRef = useRef(0);
  const playingRef = useRef(false);
  const speedRef = useRef(1);
  const voiceRef = useRef(voice);
  const activeHashRef = useRef("");
  const paraEls = useRef([]);

  parasRef.current = paras;
  curRef.current = cur;
  playingRef.current = playing;
  speedRef.current = speed;
  voiceRef.current = voice;

  useEffect(() => { setLibrary(getLib()); }, []);

  const stopAudio = useCallback(() => {
    if (audioRef.current) { audioRef.current.pause(); audioRef.current.src = ""; }
    setPlaying(false); playingRef.current = false; setLoadingAudio(false);
  }, []);

  const playPara = useCallback(async (idx) => {
    const ps = parasRef.current;
    if (!ps.length || idx >= ps.length) return;
    stopAudio();
    setLoadingAudio(true);
    setCur(idx); curRef.current = idx;
    saveProgress(activeHashRef.current, idx);
    setLibrary(prev => { const u = prev.map(b => b.hash === activeHashRef.current ? { ...b, lastPara: idx, totalParas: ps.length } : b); saveLib(u); return u; });
    paraEls.current[idx]?.scrollIntoView({ behavior: "smooth", block: "center" });
    setStatusMsg(`⏳ Gerando áudio… parágrafo ${idx + 1}`);

    try {
      const url = await fetchTTS(ps[idx], voiceRef.current);
      const audio = new Audio(url);
      audio.playbackRate = speedRef.current;
      audioRef.current = audio;

      audio.onplay = () => { setPlaying(true); playingRef.current = true; setLoadingAudio(false); setStatusMsg(`▶ Parágrafo ${idx + 1} de ${ps.length}`); };
      audio.onended = () => { if (playingRef.current && idx + 1 < ps.length) playPara(idx + 1); else { setPlaying(false); playingRef.current = false; if (idx + 1 >= ps.length) setStatusMsg("Leitura concluída 🎉"); } };
      audio.onerror = () => { setPlaying(false); playingRef.current = false; setLoadingAudio(false); setStatusMsg("Erro ao reproduzir."); };
      await audio.play();

      // pre-fetch next
      if (idx + 1 < ps.length) fetchTTS(ps[idx + 1], voiceRef.current).catch(() => {});
    } catch (e) {
      setLoadingAudio(false); setPlaying(false);
      setStatusMsg("Erro: " + e.message);
    }
  }, [stopAudio]);

  const openBook = useCallback(async (book) => {
    stopAudio();
    setView("loading"); setLoadPct(0); setLoadMsg("Abrindo livro…");
    try {
      const byteStr = atob(book.b64);
      const bytes = new Uint8Array(byteStr.length);
      for (let i = 0; i < byteStr.length; i++) bytes[i] = byteStr.charCodeAt(i);
      const { text } = await extractAllText(bytes.buffer, p => { setLoadPct(p); setLoadMsg(`Carregando… ${p}%`); });
      const ps = toParagraphs(text);
      if (!ps.length) throw new Error("Sem texto.");
      const saved = Math.min(getProgress(book.hash), ps.length - 1);
      setParas(ps); parasRef.current = ps;
      setCur(saved); curRef.current = saved;
      activeHashRef.current = book.hash;
      setActiveBook(book); setView("reader");
      setStatusMsg(saved > 0 ? `📌 Retomando do parágrafo ${saved + 1}` : `${ps.length} parágrafos • Toque ▶ para ouvir`);
    } catch (e) { setErrMsg(e.message); setView("library"); }
  }, [stopAudio]);

  const addBook = useCallback(async (file) => {
    if (!file || file.type !== "application/pdf") return;
    stopAudio(); setView("loading"); setErrMsg(""); setLoadPct(0); setLoadMsg("Lendo PDF…");
    try {
      const buffer = await file.arrayBuffer();
      const hash = await hashBuffer(buffer);
      const existing = getLib().find(b => b.hash === hash);
      if (existing) { openBook(existing); return; }
      setLoadMsg("Gerando capa…"); setLoadPct(10);
      const cover = await renderCover(buffer.slice(0));
      const { text, numPages } = await extractAllText(buffer.slice(0), p => { setLoadPct(15 + Math.round(p * 0.8)); setLoadMsg(`Extraindo texto… ${15 + Math.round(p * 0.8)}%`); });
      const ps = toParagraphs(text);
      if (!ps.length) throw new Error("Nenhum texto encontrado. PDF pode ser escaneado.");
      setLoadMsg("Salvando…"); setLoadPct(98);
      const bytes = new Uint8Array(buffer);
      let b64 = "";
      for (let i = 0; i < bytes.length; i += 8192) b64 += String.fromCharCode(...bytes.subarray(i, i + 8192));
      const book = { hash, title: file.name.replace(/\.pdf$/i, ""), numPages, cover, b64: btoa(b64), lastPara: 0, totalParas: ps.length, addedAt: Date.now() };
      const updated = [book, ...getLib()]; saveLib(updated); setLibrary(updated);
      setParas(ps); parasRef.current = ps;
      setCur(0); curRef.current = 0;
      activeHashRef.current = hash; setActiveBook(book); setView("reader");
      setStatusMsg(`${ps.length} parágrafos prontos • Toque ▶ para ouvir!`);
    } catch (e) { setErrMsg(e.message || "Erro."); setView("library"); }
  }, [openBook, stopAudio]);

  const deleteBook = (hash) => { const u = getLib().filter(b => b.hash !== hash); saveLib(u); setLibrary(u); };

  const handlePlayPause = () => {
    if (loadingAudio) return;
    if (playing && audioRef.current) { audioRef.current.pause(); setPlaying(false); playingRef.current = false; setStatusMsg("Pausado ⏸"); }
    else if (!playing && audioRef.current?.src) { audioRef.current.play(); setPlaying(true); playingRef.current = true; }
    else playPara(curRef.current);
  };

  const jump = idx => playPara(idx);

  const changeSpeed = s => {
    setSpeed(s); speedRef.current = s;
    if (audioRef.current) audioRef.current.playbackRate = s;
  };

  const changeVoice = v => {
    setVoice(v); voiceRef.current = v; saveVoice(v);
    if (playing || loadingAudio) { const idx = curRef.current; stopAudio(); setTimeout(() => playPara(idx), 60); }
  };

  const pct = paras.length ? Math.round(((cur + 1) / paras.length) * 100) : 0;
  const btnLabel = loadingAudio ? "⏳ Carregando…" : playing ? "⏸ Pausar" : "▶ Ouvir";

  // helpers
  const card = (ex = {}) => ({ background: C.s1, border: `1px solid ${C.border}`, borderRadius: 14, padding: 18, marginBottom: 14, ...ex });
  const row = (ex = {}) => ({ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", ...ex });
  const btnP = (bg = C.acc, fg = C.bg) => ({ background: bg, color: fg, border: "none", borderRadius: 10, padding: "11px 22px", fontSize: 14, fontWeight: 700, cursor: "pointer", fontFamily: "inherit", whiteSpace: "nowrap" });
  const btnO = { background: C.s2, color: C.text, border: `1px solid ${C.border}`, borderRadius: 10, padding: "9px 16px", fontSize: 13, cursor: "pointer", fontFamily: "inherit", whiteSpace: "nowrap" };
  const btnT = (a) => ({ background: a ? C.acc : C.s2, color: a ? C.bg : C.muted, border: `1px solid ${a ? C.acc : C.border}`, borderRadius: 8, padding: "5px 11px", fontSize: 12, cursor: "pointer", fontFamily: "inherit" });
  const sel = { background: C.s2, border: `1px solid ${C.border}`, color: C.text, padding: "7px 10px", borderRadius: 8, fontSize: 13, fontFamily: "inherit", flex: 1, maxWidth: 280 };

  return (
    <div style={{ minHeight: "100vh", background: C.bg, color: C.text, fontFamily: "'Georgia', serif" }}>

      {/* LIBRARY */}
      {view === "library" && (
        <div style={{ maxWidth: 760, margin: "0 auto", padding: "28px 16px" }}>
          <div style={{ marginBottom: 28 }}>
            <div style={{ fontSize: "clamp(26px,5vw,38px)", fontWeight: 800, color: C.acc2, marginBottom: 4 }}>📚 Minha Biblioteca</div>
            <div style={{ color: C.muted, fontSize: 13 }}>{library.length === 0 ? "Adicione seu primeiro livro abaixo" : `${library.length} livro${library.length !== 1 ? "s" : ""}`}</div>
          </div>

          {errMsg && <div style={{ background: "#f8714922", border: "1px solid #f8714966", borderRadius: 10, padding: "12px 16px", color: C.red, fontSize: 14, marginBottom: 16 }}>⚠️ {errMsg}</div>}

          {/* Worker setup */}
          {!workerSet ? (
            <div style={{ background: C.s1, border: `1px solid ${C.border}`, borderRadius: 14, padding: 18, marginBottom: 20 }}>
              <div style={{ fontWeight: 700, marginBottom: 6, color: C.acc2, fontSize: 15 }}>🎙️ Configurar Voz Microsoft Neural</div>
              <div style={{ color: C.muted, fontSize: 13, marginBottom: 12, lineHeight: 1.6 }}>
                Cole abaixo a URL do seu Cloudflare Worker (ver passo a passo acima).
              </div>
              <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
                <input type="text" placeholder="https://meu-worker.workers.dev"
                  value={workerInput} onChange={e => setWorkerInput(e.target.value)}
                  onKeyDown={e => { if (e.key === "Enter" && workerInput.trim()) { const u = workerInput.trim(); saveWorkerUrl(u); setWorkerUrl(u); setWorkerSet(true); }}}
                  style={{ background: C.s2, border: `1px solid ${C.border}`, color: C.text, padding: "9px 14px", borderRadius: 8, fontSize: 13, fontFamily: "inherit", flex: 1, outline: "none" }} />
                <button style={{ background: C.acc, color: C.bg, border: "none", borderRadius: 8, padding: "10px 20px", fontSize: 13, fontWeight: 700, cursor: "pointer", fontFamily: "inherit" }}
                  onClick={() => { if (!workerInput.trim()) return; const u = workerInput.trim(); saveWorkerUrl(u); setWorkerUrl(u); setWorkerSet(true); }}>Salvar</button>
              </div>
            </div>
          ) : (
            <div style={{ background: C.s1, border: `1px solid ${C.border}`, borderRadius: 14, padding: "12px 16px", marginBottom: 20, display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
              <span style={{ fontSize: 13, color: C.green }}>✓ Voz Microsoft Neural ativa</span>
              <select style={{ background: C.s2, border: `1px solid ${C.border}`, color: C.text, padding: "6px 10px", borderRadius: 8, fontSize: 12, fontFamily: "inherit", flex: 1, maxWidth: 260 }}
                value={voice} onChange={e => { setVoice(e.target.value); saveVoice(e.target.value); }}>
                {VOICES.map(v => <option key={v.id} value={v.id}>{v.label}</option>)}
              </select>
              <button style={{ background: "none", border: `1px solid ${C.border}`, color: C.muted, padding: "5px 12px", borderRadius: 8, fontSize: 12, cursor: "pointer", fontFamily: "inherit" }}
                onClick={() => { localStorage.removeItem("tts_worker_url"); setWorkerSet(false); setWorkerInput(""); setWorkerUrl(""); }}>Trocar URL</button>
            </div>
          )}

          <label style={{ display: "block", border: `2px dashed ${C.border}`, borderRadius: 14, padding: "28px 20px", textAlign: "center", cursor: "pointer", background: C.s1, marginBottom: 32, position: "relative" }}>
            <div style={{ fontSize: 36, marginBottom: 8 }}>➕</div>
            <div style={{ fontWeight: 700, fontSize: 16, color: C.acc, marginBottom: 4 }}>Adicionar livro</div>
            <div style={{ color: C.muted, fontSize: 13 }}>Clique ou arraste um arquivo PDF</div>
            <input type="file" accept=".pdf" style={{ position: "absolute", inset: 0, opacity: 0, cursor: "pointer", width: "100%", height: "100%" }} onChange={e => addBook(e.target.files[0])} />
          </label>

          {library.length > 0
            ? <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(130px, 1fr))", gap: "24px 18px" }}>
                {library.map(book => <BookCard key={book.hash} book={book} onOpen={openBook} onDelete={deleteBook} />)}
              </div>
            : <div style={{ textAlign: "center", padding: "40px 0", color: C.muted }}>
                <div style={{ fontSize: 60, marginBottom: 16, opacity: 0.3 }}>📖</div>
                <div>Sua biblioteca está vazia</div>
                <div style={{ fontSize: 13, marginTop: 6 }}>Adicione PDFs para começar a ouvir</div>
              </div>
          }
        </div>
      )}

      {/* LOADING */}
      {view === "loading" && (
        <div style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", flexDirection: "column", padding: 32 }}>
          <div style={{ fontSize: 48, marginBottom: 20 }}>⏳</div>
          <div style={{ fontSize: 16, color: C.text, marginBottom: 20 }}>{loadMsg}</div>
          <div style={{ width: "100%", maxWidth: 320, height: 6, background: C.s2, borderRadius: 99, overflow: "hidden" }}>
            <div style={{ height: "100%", width: loadPct + "%", background: `linear-gradient(90deg, ${C.acc}, #e87070)`, borderRadius: 99, transition: "width .3s" }} />
          </div>
          <div style={{ fontSize: 12, color: C.muted, marginTop: 8 }}>{loadPct}%</div>
        </div>
      )}

      {/* READER */}
      {view === "reader" && (
        <div style={{ maxWidth: 700, margin: "0 auto", padding: "20px 14px" }}>
          {/* Top */}
          <div style={row({ marginBottom: 16 })}>
            <button style={{ ...btnO, padding: "7px 14px" }} onClick={() => { stopAudio(); setView("library"); }}>← Biblioteca</button>
            <div style={{ flex: 1, fontSize: 14, fontWeight: 700, color: C.acc2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", textAlign: "center" }}>{activeBook?.title}</div>
            <div style={{ fontSize: 11, color: C.muted, whiteSpace: "nowrap" }}>{activeBook?.numPages} págs</div>
          </div>

          {/* Cover + progress */}
          <div style={row({ marginBottom: 16, alignItems: "flex-start" })}>
            {activeBook?.cover && <img src={activeBook.cover} alt="" style={{ width: 55, borderRadius: 6, boxShadow: "0 4px 14px rgba(0,0,0,0.5)", flexShrink: 0 }} />}
            <div style={{ flex: 1 }}>
              <div style={row({ justifyContent: "space-between", fontSize: 12, color: C.muted, marginBottom: 6 })}>
                <span>{pct}% lido</span><span>§ {cur + 1} / {paras.length}</span>
              </div>
              <div style={{ height: 6, background: C.s2, borderRadius: 99, overflow: "hidden", cursor: "pointer" }}
                onClick={e => { const r = e.currentTarget.getBoundingClientRect(); jump(Math.max(0, Math.min(Math.floor((e.clientX - r.left) / r.width * paras.length), paras.length - 1))); }}>
                <div style={{ height: "100%", width: pct + "%", background: `linear-gradient(90deg, ${C.acc}, #e87070)`, borderRadius: 99, transition: "width .4s" }} />
              </div>
            </div>
          </div>

          {/* Controls */}
          <div style={card()}>
            <div style={row({ justifyContent: "center", marginBottom: 14 })}>
              <button style={{ ...btnO, opacity: cur === 0 ? 0.4 : 1 }} disabled={cur === 0} onClick={() => jump(cur - 1)}>⏮</button>
              <button style={btnP(loadingAudio ? C.muted : playing ? C.red : C.acc, C.bg)} disabled={loadingAudio} onClick={handlePlayPause}>{btnLabel}</button>
              <button style={{ ...btnO, opacity: cur >= paras.length - 1 ? 0.4 : 1 }} disabled={cur >= paras.length - 1} onClick={() => jump(cur + 1)}>⏭</button>
            </div>

            {/* Voice */}
            <div style={row({ justifyContent: "center", marginBottom: 12 })}>
              <span style={{ fontSize: 12, color: C.muted }}>Voz:</span>
              <select style={sel} value={voice} onChange={e => changeVoice(e.target.value)}>
                {VOICES.map(v => <option key={v.id} value={v.id}>{v.label}</option>)}
              </select>
            </div>

            {/* Speed */}
            <div style={row({ justifyContent: "center" })}>
              <span style={{ fontSize: 12, color: C.muted }}>Velocidade:</span>
              {SPEEDS.map(s => <button key={s} style={btnT(speed === s)} onClick={() => changeSpeed(s)}>{s}×</button>)}
            </div>
          </div>

          <div style={{ textAlign: "center", fontSize: 12, color: C.muted, marginBottom: 10, minHeight: 16 }}>{statusMsg}</div>

          {/* Text */}
          <div style={{ background: C.s1, border: `1px solid ${C.border}`, borderRadius: 14, padding: 16, maxHeight: 360, overflowY: "auto" }}>
            {paras.map((p, i) => (
              <div key={i} ref={el => paraEls.current[i] = el} onClick={() => jump(i)} title="Clique para ler daqui"
                style={{ fontSize: 14.5, lineHeight: 1.8, padding: "8px 12px", borderRadius: 8, marginBottom: 6, cursor: "pointer", borderLeft: `3px solid ${i === cur ? C.acc : "transparent"}`, background: i === cur ? "rgba(232,201,122,0.1)" : "transparent", color: i < cur ? "#3a3528" : i === cur ? C.acc2 : C.text, transition: "background .1s" }}>
                <span style={{ fontSize: 10, color: C.muted, marginRight: 6 }}>{i + 1}</span>{p}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

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
    const viewport = page.getViewport({ scale: 1 });
    const scale = Math.min(300 / viewport.width, 420 / viewport.height);
    const vp = page.getViewport({ scale });
    const canvas = document.createElement("canvas");
    canvas.width = vp.width;
    canvas.height = vp.height;
    await page.render({ canvasContext: canvas.getContext("2d"), viewport: vp }).promise;
    return canvas.toDataURL("image/jpeg", 0.8);
  } catch { return null; }
}

async function extractAllText(buffer, onProgress) {
  const lib = await loadPdfJs();
  const pdf = await lib.getDocument({ data: buffer }).promise;
  const numPages = pdf.numPages;
  let allText = "";
  const BATCH = 15;
  for (let i = 1; i <= numPages; i += BATCH) {
    const end = Math.min(i + BATCH - 1, numPages);
    const texts = await Promise.all(
      Array.from({ length: end - i + 1 }, async (_, j) => {
        const page = await pdf.getPage(i + j);
        const c = await page.getTextContent();
        return c.items.map(x => x.str).join(" ");
      })
    );
    allText += texts.join("\n\n") + "\n\n";
    onProgress && onProgress(Math.round((end / numPages) * 100));
  }
  return { text: allText, numPages };
}

function toParagraphs(text) {
  return text.split(/\n{2,}/).map(p => p.replace(/\s+/g, " ").trim()).filter(p => p.length > 30);
}

// ── Voice ────────────────────────────────────────────────────────────────
function getBestVoices() {
  const all = window.speechSynthesis?.getVoices() || [];
  return all.map(v => {
    let score = 0;
    const name = v.name.toLowerCase();
    const lang = (v.lang || "").toLowerCase();
    if (lang === "pt-br") score += 100;
    else if (lang.startsWith("pt")) score += 60;
    if (name.includes("google")) score += 50;
    if (name.includes("microsoft")) score += 40;
    if (name.includes("neural") || name.includes("natural") || name.includes("premium")) score += 30;
    return { voice: v, score };
  }).sort((a, b) => b.score - a.score).map(x => x.voice);
}

// ── Storage ──────────────────────────────────────────────────────────────
const LIBRARY_KEY = "pdflib_books_v1";
const PROGRESS_KEY = "pdflib_progress_v1";

function getLibrary() {
  try { return JSON.parse(localStorage.getItem(LIBRARY_KEY) || "[]"); } catch { return []; }
}
function saveLibrary(books) {
  try { localStorage.setItem(LIBRARY_KEY, JSON.stringify(books)); } catch {}
}
function getProgress(hash) {
  try { return JSON.parse(localStorage.getItem(PROGRESS_KEY) || "{}")[hash] ?? 0; } catch { return 0; }
}
function saveProgress(hash, idx) {
  try {
    const d = JSON.parse(localStorage.getItem(PROGRESS_KEY) || "{}");
    d[hash] = idx;
    localStorage.setItem(PROGRESS_KEY, JSON.stringify(d));
  } catch {}
}
async function hashBuffer(buf) {
  const h = await crypto.subtle.digest("SHA-1", buf.slice(0, 65536));
  return Array.from(new Uint8Array(h)).map(b => b.toString(16).padStart(2,"0")).join("").slice(0,14);
}

// ── Palette generator from cover ─────────────────────────────────────────
function dominantColor(dataUrl) {
  return new Promise(resolve => {
    if (!dataUrl) { resolve("#4a3728"); return; }
    const img = new Image();
    img.onload = () => {
      const c = document.createElement("canvas");
      c.width = c.height = 10;
      c.getContext("2d").drawImage(img, 0, 0, 10, 10);
      const d = c.getContext("2d").getImageData(0, 0, 10, 10).data;
      let r = 0, g = 0, bl = 0, n = 0;
      for (let i = 0; i < d.length; i += 4) { r += d[i]; g += d[i+1]; bl += d[i+2]; n++; }
      resolve(`rgb(${Math.floor(r/n)},${Math.floor(g/n)},${Math.floor(bl/n)})`);
    };
    img.onerror = () => resolve("#4a3728");
    img.src = dataUrl;
  });
}

const SPEEDS = [0.75, 1, 1.1, 1.25, 1.5, 1.75, 2];

// ── COLORS ───────────────────────────────────────────────────────────────
const C = {
  bg: "#0e0c14",
  s1: "#17141f",
  s2: "#211d2e",
  border: "#2d2840",
  acc: "#e8c97a",
  acc2: "#f5dfa0",
  text: "#f0ebe0",
  muted: "#7a7490",
  red: "#f87171",
  green: "#6ee7b7",
};

// ── BOOK CARD ─────────────────────────────────────────────────────────────
function BookCard({ book, onOpen, onDelete }) {
  const [hovered, setHovered] = useState(false);
  const pct = book.totalParas ? Math.round(((book.lastPara + 1) / book.totalParas) * 100) : 0;

  const coverColors = [
    "linear-gradient(135deg,#b5451b,#7c1d0f)",
    "linear-gradient(135deg,#1a4a7a,#0d2844)",
    "linear-gradient(135deg,#2d5a27,#173314)",
    "linear-gradient(135deg,#5a2d7a,#2e1540)",
    "linear-gradient(135deg,#7a5a1a,#3d2d0a)",
    "linear-gradient(135deg,#1a5a5a,#0a2d2d)",
  ];
  const fallbackColor = coverColors[book.hash?.charCodeAt(0) % coverColors.length || 0];

  return (
    <div
      onClick={() => onOpen(book)}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        cursor: "pointer",
        transform: hovered ? "translateY(-6px) scale(1.02)" : "translateY(0) scale(1)",
        transition: "transform 0.25s ease",
        display: "flex", flexDirection: "column",
      }}
    >
      {/* Cover */}
      <div style={{
        width: "100%", aspectRatio: "2/3",
        borderRadius: 10,
        overflow: "hidden",
        boxShadow: hovered
          ? "0 20px 50px rgba(0,0,0,0.7), 4px 0 0 rgba(255,255,255,0.07) inset"
          : "0 8px 30px rgba(0,0,0,0.5), 3px 0 0 rgba(255,255,255,0.05) inset",
        background: fallbackColor,
        position: "relative",
        transition: "box-shadow 0.25s",
      }}>
        {book.cover ? (
          <img src={book.cover} alt={book.title}
            style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }} />
        ) : (
          <div style={{
            width: "100%", height: "100%",
            background: fallbackColor,
            display: "flex", flexDirection: "column",
            alignItems: "center", justifyContent: "center",
            padding: 16, boxSizing: "border-box",
          }}>
            <div style={{ fontSize: 32, marginBottom: 12, opacity: 0.6 }}>📖</div>
            <div style={{
              color: "rgba(255,255,255,0.9)", fontSize: 13, fontWeight: 700,
              textAlign: "center", lineHeight: 1.4,
              fontFamily: "'Georgia', serif",
              textShadow: "0 1px 4px rgba(0,0,0,0.5)",
            }}>{book.title}</div>
          </div>
        )}

        {/* Progress overlay */}
        {pct > 0 && (
          <div style={{
            position: "absolute", bottom: 0, left: 0, right: 0,
            height: 4, background: "rgba(0,0,0,0.4)",
          }}>
            <div style={{
              height: "100%", width: pct + "%",
              background: C.acc,
              transition: "width .3s",
            }} />
          </div>
        )}

        {/* Delete btn */}
        <button
          onClick={e => { e.stopPropagation(); onDelete(book.hash); }}
          style={{
            position: "absolute", top: 6, right: 6,
            background: "rgba(0,0,0,0.6)", color: "#fff",
            border: "none", borderRadius: "50%",
            width: 24, height: 24, fontSize: 12,
            cursor: "pointer", display: hovered ? "flex" : "none",
            alignItems: "center", justifyContent: "center",
            opacity: 0.8,
          }}
          title="Remover da biblioteca"
        >✕</button>
      </div>

      {/* Title & progress */}
      <div style={{ padding: "8px 2px 0" }}>
        <div style={{
          fontSize: 12, fontWeight: 700, color: C.text,
          overflow: "hidden", textOverflow: "ellipsis",
          whiteSpace: "nowrap", lineHeight: 1.3,
        }}>{book.title}</div>
        <div style={{ fontSize: 11, color: C.muted, marginTop: 2 }}>
          {pct > 0 ? `${pct}% lido` : "Não iniciado"} • {book.numPages} págs
        </div>
      </div>
    </div>
  );
}

// ── MAIN ─────────────────────────────────────────────────────────────────
export default function App() {
  const [view, setView] = useState("library"); // library | loading | reader
  const [library, setLibrary] = useState([]);
  const [activeBook, setActiveBook] = useState(null);
  const [loadPct, setLoadPct] = useState(0);
  const [loadMsg, setLoadMsg] = useState("");
  const [errMsg, setErrMsg] = useState("");

  // Reader state
  const [paras, setParas] = useState([]);
  const [cur, setCur] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [voices, setVoices] = useState([]);
  const [voiceIdx, setVoiceIdx] = useState(0);
  const [statusMsg, setStatusMsg] = useState("");

  const synthRef = useRef(null);
  const parasRef = useRef([]);
  const curRef = useRef(0);
  const playingRef = useRef(false);
  const speedRef = useRef(1);
  const voiceIdxRef = useRef(0);
  const voicesRef = useRef([]);
  const activeHashRef = useRef("");
  const paraEls = useRef([]);

  parasRef.current = paras;
  curRef.current = cur;
  playingRef.current = playing;
  speedRef.current = speed;
  voiceIdxRef.current = voiceIdx;
  voicesRef.current = voices;

  // Load library from storage
  useEffect(() => {
    setLibrary(getLibrary());
  }, []);

  // Init speech
  useEffect(() => {
    if (!window.speechSynthesis) return;
    synthRef.current = window.speechSynthesis;
    const update = () => {
      const v = getBestVoices();
      setVoices(v); voicesRef.current = v;
      setVoiceIdx(0); voiceIdxRef.current = 0;
    };
    update();
    window.speechSynthesis.onvoiceschanged = update;
    setTimeout(update, 800);
  }, []);

  const stopAll = useCallback(() => {
    synthRef.current?.cancel();
    setPlaying(false); playingRef.current = false;
  }, []);

  const speakFrom = useCallback((idx) => {
    const ps = parasRef.current;
    const synth = synthRef.current;
    if (!ps.length || idx >= ps.length || !synth) return;
    synth.cancel();
    const u = new SpeechSynthesisUtterance(ps[idx]);
    u.rate = speedRef.current;
    u.lang = "pt-BR";
    const vl = voicesRef.current;
    if (vl.length) u.voice = vl[voiceIdxRef.current] || vl[0];

    u.onstart = () => {
      setPlaying(true); playingRef.current = true;
      setCur(idx); curRef.current = idx;
      saveProgress(activeHashRef.current, idx);
      // update library progress
      setLibrary(prev => {
        const updated = prev.map(b =>
          b.hash === activeHashRef.current
            ? { ...b, lastPara: idx, totalParas: ps.length }
            : b
        );
        saveLibrary(updated);
        return updated;
      });
      setStatusMsg(`▶ Parágrafo ${idx + 1} de ${ps.length}`);
      paraEls.current[idx]?.scrollIntoView({ behavior: "smooth", block: "center" });
    };
    u.onend = () => {
      if (playingRef.current && idx + 1 < ps.length) speakFrom(idx + 1);
      else if (idx + 1 >= ps.length) {
        setPlaying(false); playingRef.current = false;
        setStatusMsg("Leitura concluída 🎉");
      }
    };
    u.onerror = e => {
      if (e.error !== "interrupted" && e.error !== "canceled") {
        setPlaying(false); playingRef.current = false;
        setStatusMsg("Erro na leitura.");
      }
    };
    synth.speak(u);
  }, []);

  // Open book from library
  const openBook = useCallback(async (book) => {
    stopAll();
    setView("loading");
    setLoadMsg("Abrindo livro…");
    setLoadPct(10);
    try {
      // Re-read file from stored base64
      const byteStr = atob(book.b64);
      const bytes = new Uint8Array(byteStr.length);
      for (let i = 0; i < byteStr.length; i++) bytes[i] = byteStr.charCodeAt(i);
      const buffer = bytes.buffer;

      setLoadMsg("Extraindo texto…");
      const { text } = await extractAllText(buffer, p => {
        setLoadPct(10 + Math.round(p * 0.9));
        setLoadMsg(`Carregando… ${10 + Math.round(p * 0.9)}%`);
      });
      const ps = toParagraphs(text);
      if (!ps.length) throw new Error("Nenhum texto encontrado.");

      const savedIdx = Math.min(getProgress(book.hash), ps.length - 1);
      setParas(ps); parasRef.current = ps;
      setCur(savedIdx); curRef.current = savedIdx;
      activeHashRef.current = book.hash;
      setActiveBook(book);
      setView("reader");
      setStatusMsg(savedIdx > 0
        ? `📌 Retomando do parágrafo ${savedIdx + 1}`
        : `${ps.length} parágrafos • Toque ▶ para ouvir`);
    } catch (e) {
      setErrMsg(e.message);
      setView("library");
    }
  }, [stopAll]);

  // Add new book
  const addBook = useCallback(async (file) => {
    if (!file || file.type !== "application/pdf") return;
    stopAll();
    setView("loading");
    setErrMsg("");
    setLoadPct(0);
    setLoadMsg("Lendo PDF…");

    try {
      const buffer = await file.arrayBuffer();
      const hash = await hashBuffer(buffer);

      // Check duplicate
      const existing = getLibrary().find(b => b.hash === hash);
      if (existing) { openBook(existing); return; }

      setLoadMsg("Gerando capa…");
      setLoadPct(15);
      const cover = await renderCover(buffer.slice(0));

      setLoadMsg("Extraindo texto…");
      const { text, numPages } = await extractAllText(buffer.slice(0), p => {
        setLoadPct(20 + Math.round(p * 0.78));
        setLoadMsg(`Extraindo texto… ${20 + Math.round(p * 0.78)}%`);
      });
      const ps = toParagraphs(text);
      if (!ps.length) throw new Error("Nenhum texto encontrado. PDF pode ser escaneado.");

      setLoadMsg("Salvando na biblioteca…");
      setLoadPct(99);

      // Store as base64 (for re-reading later)
      const bytes = new Uint8Array(buffer);
      let b64 = "";
      const chunk = 8192;
      for (let i = 0; i < bytes.length; i += chunk) {
        b64 += String.fromCharCode(...bytes.subarray(i, i + chunk));
      }
      const b64str = btoa(b64);

      const book = {
        hash,
        title: file.name.replace(/\.pdf$/i, ""),
        numPages,
        cover,
        b64: b64str,
        lastPara: 0,
        totalParas: ps.length,
        addedAt: Date.now(),
      };

      const updated = [book, ...getLibrary()];
      saveLibrary(updated);
      setLibrary(updated);

      setParas(ps); parasRef.current = ps;
      setCur(0); curRef.current = 0;
      activeHashRef.current = hash;
      setActiveBook(book);
      setView("reader");
      setStatusMsg(`${ps.length} parágrafos prontos • Toque ▶ para ouvir!`);
    } catch (e) {
      setErrMsg(e.message || "Erro ao processar o PDF.");
      setView("library");
    }
  }, [openBook, stopAll]);

  const deleteBook = useCallback((hash) => {
    const updated = getLibrary().filter(b => b.hash !== hash);
    saveLibrary(updated);
    setLibrary(updated);
  }, []);

  const handlePlayPause = () => {
    const synth = synthRef.current;
    if (!synth) return;
    if (synth.paused) {
      synth.resume(); setPlaying(true);
      setStatusMsg(`▶ Parágrafo ${curRef.current + 1} de ${parasRef.current.length}`);
    } else if (playing) {
      synth.pause(); setPlaying(false); setStatusMsg("Pausado ⏸");
    } else {
      speakFrom(curRef.current);
    }
  };

  const jump = idx => {
    stopAll(); setCur(idx); curRef.current = idx;
    setTimeout(() => speakFrom(idx), 60);
  };

  const changeSpeed = s => {
    setSpeed(s); speedRef.current = s;
    if (playing || synthRef.current?.paused) {
      const idx = curRef.current; stopAll();
      setTimeout(() => speakFrom(idx), 60);
    }
  };

  const pct = paras.length ? Math.round(((cur + 1) / paras.length) * 100) : 0;
  const btnLabel = playing ? "⏸ Pausar" : synthRef.current?.paused ? "▶ Continuar" : "▶ Ouvir";

  // ── CSS helpers ──────────────────────────────────────────────────────
  const card = (extra = {}) => ({
    background: C.s1, border: `1px solid ${C.border}`,
    borderRadius: 14, padding: 18, marginBottom: 14, ...extra,
  });
  const row = (extra = {}) => ({ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", ...extra });
  const btnPrimary = (bg = C.acc, fg = C.bg) => ({
    background: bg, color: fg, border: "none", borderRadius: 10,
    padding: "11px 22px", fontSize: 14, fontWeight: 700,
    cursor: "pointer", fontFamily: "inherit", whiteSpace: "nowrap",
  });
  const btnOut = {
    background: C.s2, color: C.text, border: `1px solid ${C.border}`,
    borderRadius: 10, padding: "9px 16px", fontSize: 13,
    cursor: "pointer", fontFamily: "inherit", whiteSpace: "nowrap",
  };
  const btnTag = (active) => ({
    background: active ? C.acc : C.s2,
    color: active ? C.bg : C.muted,
    border: `1px solid ${active ? C.acc : C.border}`,
    borderRadius: 8, padding: "5px 11px", fontSize: 12,
    cursor: "pointer", fontFamily: "inherit",
  });

  // ── RENDER ───────────────────────────────────────────────────────────
  return (
    <div style={{
      minHeight: "100vh", background: C.bg, color: C.text,
      fontFamily: "'Georgia', serif",
    }}>

      {/* ── LIBRARY ── */}
      {view === "library" && (
        <div style={{ maxWidth: 760, margin: "0 auto", padding: "28px 16px" }}>
          {/* Header */}
          <div style={{ marginBottom: 28 }}>
            <div style={{
              fontSize: "clamp(26px,5vw,40px)", fontWeight: 800,
              color: C.acc2, letterSpacing: "-0.5px", marginBottom: 4,
              fontFamily: "'Georgia', serif",
            }}>📚 Minha Biblioteca</div>
            <div style={{ color: C.muted, fontSize: 13 }}>
              {library.length === 0
                ? "Adicione seu primeiro livro abaixo"
                : `${library.length} livro${library.length !== 1 ? "s" : ""} na coleção`}
            </div>
          </div>

          {errMsg && (
            <div style={{
              background: "#f8714922", border: "1px solid #f8714966",
              borderRadius: 10, padding: "12px 16px", color: C.red,
              fontSize: 14, marginBottom: 16,
            }}>⚠️ {errMsg}</div>
          )}

          {/* Add book */}
          <label style={{
            display: "block", border: `2px dashed ${C.border}`,
            borderRadius: 14, padding: "28px 20px", textAlign: "center",
            cursor: "pointer", background: C.s1, marginBottom: 32,
            transition: "border-color .2s",
            position: "relative",
          }}>
            <div style={{ fontSize: 36, marginBottom: 8 }}>➕</div>
            <div style={{ fontWeight: 700, fontSize: 16, color: C.acc, marginBottom: 4 }}>
              Adicionar livro
            </div>
            <div style={{ color: C.muted, fontSize: 13 }}>Clique ou arraste um arquivo PDF</div>
            <input type="file" accept=".pdf"
              style={{ position: "absolute", inset: 0, opacity: 0, cursor: "pointer", width: "100%", height: "100%" }}
              onChange={e => addBook(e.target.files[0])} />
          </label>

          {/* Grid */}
          {library.length > 0 && (
            <div style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fill, minmax(130px, 1fr))",
              gap: "24px 18px",
            }}>
              {library.map(book => (
                <BookCard key={book.hash} book={book} onOpen={openBook} onDelete={deleteBook} />
              ))}
            </div>
          )}

          {library.length === 0 && (
            <div style={{ textAlign: "center", padding: "40px 0", color: C.muted }}>
              <div style={{ fontSize: 60, marginBottom: 16, opacity: 0.3 }}>📖</div>
              <div style={{ fontSize: 16 }}>Sua biblioteca está vazia</div>
              <div style={{ fontSize: 13, marginTop: 6 }}>Adicione PDFs para começar a ouvir</div>
            </div>
          )}
        </div>
      )}

      {/* ── LOADING ── */}
      {view === "loading" && (
        <div style={{
          minHeight: "100vh", display: "flex", alignItems: "center",
          justifyContent: "center", flexDirection: "column", padding: 32,
        }}>
          <div style={{ fontSize: 48, marginBottom: 20 }}>⏳</div>
          <div style={{ fontSize: 16, color: C.text, marginBottom: 20 }}>{loadMsg}</div>
          <div style={{
            width: "100%", maxWidth: 320, height: 6,
            background: C.s2, borderRadius: 99, overflow: "hidden",
          }}>
            <div style={{
              height: "100%", width: loadPct + "%",
              background: `linear-gradient(90deg, ${C.acc}, #e87070)`,
              borderRadius: 99, transition: "width .3s",
            }} />
          </div>
          <div style={{ fontSize: 12, color: C.muted, marginTop: 8 }}>{loadPct}%</div>
        </div>
      )}

      {/* ── READER ── */}
      {view === "reader" && (
        <div style={{ maxWidth: 700, margin: "0 auto", padding: "20px 14px" }}>

          {/* Top bar */}
          <div style={row({ marginBottom: 16 })}>
            <button style={{ ...btnOut, padding: "7px 14px", fontSize: 13 }}
              onClick={() => { stopAll(); setView("library"); }}>
              ← Biblioteca
            </button>
            <div style={{
              flex: 1, fontSize: 14, fontWeight: 700, color: C.acc2,
              overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
              textAlign: "center",
            }}>{activeBook?.title}</div>
            <div style={{ fontSize: 11, color: C.muted, whiteSpace: "nowrap" }}>
              {activeBook?.numPages} págs
            </div>
          </div>

          {/* Cover + progress mini */}
          {activeBook?.cover && (
            <div style={{ display: "flex", gap: 14, marginBottom: 16, alignItems: "flex-start" }}>
              <img src={activeBook.cover} alt=""
                style={{ width: 60, borderRadius: 6, boxShadow: "0 4px 16px rgba(0,0,0,0.5)" }} />
              <div style={{ flex: 1 }}>
                <div style={row({ justifyContent: "space-between", fontSize: 12, color: C.muted, marginBottom: 6 })}>
                  <span>{pct}% lido</span>
                  <span>§ {cur + 1} / {paras.length}</span>
                </div>
                <div style={{
                  height: 6, background: C.s2, borderRadius: 99,
                  overflow: "hidden", cursor: "pointer",
                }}
                  onClick={e => {
                    const r = e.currentTarget.getBoundingClientRect();
                    jump(Math.max(0, Math.min(Math.floor((e.clientX - r.left) / r.width * paras.length), paras.length - 1)));
                  }}>
                  <div style={{
                    height: "100%", width: pct + "%",
                    background: `linear-gradient(90deg, ${C.acc}, #e87070)`,
                    borderRadius: 99, transition: "width .4s",
                  }} />
                </div>
              </div>
            </div>
          )}

          {!activeBook?.cover && (
            <div style={{ marginBottom: 16 }}>
              <div style={row({ justifyContent: "space-between", fontSize: 12, color: C.muted, marginBottom: 6 })}>
                <span>{pct}% lido</span><span>§ {cur + 1} / {paras.length}</span>
              </div>
              <div style={{ height: 6, background: C.s2, borderRadius: 99, overflow: "hidden", cursor: "pointer" }}
                onClick={e => {
                  const r = e.currentTarget.getBoundingClientRect();
                  jump(Math.max(0, Math.min(Math.floor((e.clientX - r.left) / r.width * paras.length), paras.length - 1)));
                }}>
                <div style={{ height: "100%", width: pct + "%", background: `linear-gradient(90deg, ${C.acc}, #e87070)`, borderRadius: 99, transition: "width .4s" }} />
              </div>
            </div>
          )}

          {/* Controls */}
          <div style={card({ marginBottom: 12 })}>
            <div style={row({ justifyContent: "center", marginBottom: 14 })}>
              <button style={{ ...btnOut, opacity: cur === 0 ? 0.4 : 1 }}
                disabled={cur === 0} onClick={() => jump(cur - 1)}>⏮</button>
              <button style={btnPrimary(playing ? C.red : C.acc, C.bg)}
                onClick={handlePlayPause}>{btnLabel}</button>
              <button style={{ ...btnOut, opacity: cur >= paras.length - 1 ? 0.4 : 1 }}
                disabled={cur >= paras.length - 1} onClick={() => jump(cur + 1)}>⏭</button>
            </div>

            <div style={row({ justifyContent: "center", marginBottom: 10 })}>
              <span style={{ fontSize: 12, color: C.muted }}>Velocidade:</span>
              {SPEEDS.map(s => (
                <button key={s} style={btnTag(speed === s)} onClick={() => changeSpeed(s)}>{s}×</button>
              ))}
            </div>

            {voices.length > 0 && (
              <div style={row({ justifyContent: "center" })}>
                <span style={{ fontSize: 12, color: C.muted }}>Voz:</span>
                <select
                  style={{
                    background: C.s2, border: `1px solid ${C.border}`, color: C.text,
                    padding: "6px 10px", borderRadius: 8, fontSize: 12,
                    fontFamily: "inherit", flex: 1, maxWidth: 260,
                  }}
                  value={voiceIdx} onChange={e => {
                    const i = +e.target.value;
                    setVoiceIdx(i); voiceIdxRef.current = i;
                    if (playing || synthRef.current?.paused) {
                      const idx = curRef.current; stopAll();
                      setTimeout(() => speakFrom(idx), 60);
                    }
                  }}>
                  {voices.map((v, i) => (
                    <option key={i} value={i}>{v.name} ({v.lang})</option>
                  ))}
                </select>
              </div>
            )}
          </div>

          <div style={{ textAlign: "center", fontSize: 12, color: C.muted, marginBottom: 10, minHeight: 16 }}>
            {statusMsg}
          </div>

          {/* Text */}
          <div style={{
            background: C.s1, border: `1px solid ${C.border}`,
            borderRadius: 14, padding: 16, maxHeight: 360, overflowY: "auto",
          }}>
            {paras.map((p, i) => (
              <div key={i} ref={el => paraEls.current[i] = el}
                onClick={() => jump(i)}
                title="Clique para ler daqui"
                style={{
                  fontSize: 14.5, lineHeight: 1.8, padding: "8px 12px",
                  borderRadius: 8, marginBottom: 6, cursor: "pointer",
                  borderLeft: `3px solid ${i === cur ? C.acc : "transparent"}`,
                  background: i === cur ? "rgba(232,201,122,0.1)" : "transparent",
                  color: i < cur ? "#3a3528" : i === cur ? C.acc2 : C.text,
                  transition: "background .1s",
                }}>
                <span style={{ fontSize: 10, color: C.muted, marginRight: 6 }}>{i + 1}</span>
                {p}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

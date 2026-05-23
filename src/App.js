import { useState, useEffect, useRef, useCallback } from "react";

// ── IndexedDB persistente ─────────────────────────────────────────────────
const DB_NAME = "leitorpdf_db";
const DB_VERSION = 1;

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = e => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains("books")) db.createObjectStore("books", { keyPath: "hash" });
      if (!db.objectStoreNames.contains("progress")) db.createObjectStore("progress", { keyPath: "hash" });
    };
    req.onsuccess = e => resolve(e.target.result);
    req.onerror = () => reject(req.error);
  });
}

async function dbGetAll(store) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, "readonly");
    const req = tx.objectStore(store).getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function dbPut(store, value) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, "readwrite");
    tx.objectStore(store).put(value);
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
}

async function dbDelete(store, key) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, "readwrite");
    tx.objectStore(store).delete(key);
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
}

async function dbGet(store, key) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, "readonly");
    const req = tx.objectStore(store).get(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

// ── PDF.js ────────────────────────────────────────────────────────────────
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
    canvas.width = vp.width; canvas.height = vp.height;
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

// ── Edge TTS ──────────────────────────────────────────────────────────────
const EDGE_VOICES = [
  { id: "pt-BR-ThalitaNeural",   label: "Thalita — natural e suave 🌸" },
  { id: "pt-BR-FranciscaNeural", label: "Francisca — mais séria 💼" },
  { id: "pt-BR-BrendaNeural",    label: "Brenda — moderna 🎧" },
  { id: "pt-BR-GiovannaNeural",  label: "Giovanna — limpa e clara ✨" },
  { id: "pt-BR-AntonioNeural",   label: "Antônio — masculina 🎙️" },
  { id: "pt-BR-DonatoNeural",    label: "Donato — masculina grave 🔊" },
  { id: "pt-BR-FabioNeural",     label: "Fábio — masculina 🎤" },
  { id: "pt-BR-HumbertoNeural",  label: "Humberto — masculina 📢" },
];

function buildSSML(text, voice, rate = 0) {
  const rateStr = rate >= 0 ? `+${rate}%` : `${rate}%`;
  const escaped = text.replace(/[<>&'"]/g, c => ({ "<":"&lt;",">":"&gt;","&":"&amp;","'":"&apos;",'"':"&quot;" }[c]));
  return `<speak version='1.0' xml:lang='pt-BR'><voice name='${voice}'><prosody rate='${rateStr}'>${escaped}</prosody></voice></speak>`;
}

function rateToPercent(speed) { return Math.round((speed - 1) * 100); }

async function edgeTTS(text, voice, speed = 1) {
  const ENDPOINT = "wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1?TrustedClientToken=6A5AA1D4EAFF4E9FB37E23D68491D6F4&ConnectionId=" + crypto.randomUUID().replace(/-/g, "");
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(ENDPOINT);
    const chunks = [];
    let audioStarted = false;
    const timeout = setTimeout(() => { ws.close(); reject(new Error("Timeout EdgeTTS")); }, 15000);
    ws.onopen = () => {
      ws.send(`Path: speech.config\r\nX-RequestId: ${crypto.randomUUID().replace(/-/g,"")}\r\nX-Timestamp: ${new Date().toISOString()}\r\nContent-Type: application/json\r\n\r\n{"context":{"synthesis":{"audio":{"metadataoptions":{"sentenceBoundaryEnabled":false,"wordBoundaryEnabled":false},"outputFormat":"audio-24khz-48kbitrate-mono-mp3"}}}}`);
      ws.send(`Path: ssml\r\nX-RequestId: ${crypto.randomUUID().replace(/-/g,"")}\r\nX-Timestamp: ${new Date().toISOString()}\r\nContent-Type: application/ssml+xml\r\n\r\n${buildSSML(text, voice, rateToPercent(speed))}`);
    };
    ws.onmessage = (event) => {
      if (typeof event.data === "string") {
        if (event.data.includes("Path:turn.end")) {
          clearTimeout(timeout); ws.close();
          resolve(URL.createObjectURL(new Blob(chunks, { type: "audio/mpeg" })));
        }
      } else {
        const arr = new Uint8Array(event.data);
        const sep = "Path:audio\r\n";
        for (let i = 0; i < arr.length - sep.length; i++) {
          if (String.fromCharCode(...arr.slice(i, i + sep.length)) === sep) {
            chunks.push(arr.slice(i + sep.length)); audioStarted = true; break;
          }
        }
      }
    };
    ws.onerror = () => { clearTimeout(timeout); reject(new Error("Erro WebSocket")); };
  });
}

async function hashBuffer(buf) {
  const h = await crypto.subtle.digest("SHA-1", buf.slice(0, 65536));
  return Array.from(new Uint8Array(h)).map(b => b.toString(16).padStart(2,"0")).join("").slice(0,14);
}

const SPEEDS = [0.75, 1, 1.1, 1.25, 1.5, 1.75, 2];
const C = { bg:"#0e0c14", s1:"#17141f", s2:"#211d2e", border:"#2d2840", acc:"#e8c97a", acc2:"#f5dfa0", text:"#f0ebe0", muted:"#7a7490", red:"#f87171" };

// ── Book Card ─────────────────────────────────────────────────────────────
function BookCard({ book, onOpen, onDelete }) {
  const [hovered, setHovered] = useState(false);
  const pct = book.totalParas ? Math.round(((book.lastPara + 1) / book.totalParas) * 100) : 0;
  const gradients = ["linear-gradient(135deg,#b5451b,#7c1d0f)","linear-gradient(135deg,#1a4a7a,#0d2844)","linear-gradient(135deg,#2d5a27,#173314)","linear-gradient(135deg,#5a2d7a,#2e1540)","linear-gradient(135deg,#7a5a1a,#3d2d0a)","linear-gradient(135deg,#1a5a5a,#0a2d2d)"];
  const fallback = gradients[(book.hash?.charCodeAt(0)||0) % gradients.length];
  return (
    <div onClick={()=>onOpen(book)} onMouseEnter={()=>setHovered(true)} onMouseLeave={()=>setHovered(false)}
      style={{ cursor:"pointer", transform:hovered?"translateY(-6px) scale(1.02)":"none", transition:"transform 0.2s", display:"flex", flexDirection:"column" }}>
      <div style={{ width:"100%", aspectRatio:"2/3", borderRadius:10, overflow:"hidden", boxShadow:hovered?"0 20px 50px rgba(0,0,0,0.7)":"0 8px 30px rgba(0,0,0,0.5)", background:fallback, position:"relative", transition:"box-shadow 0.2s" }}>
        {book.cover
          ? <img src={book.cover} alt={book.title} style={{ width:"100%", height:"100%", objectFit:"cover" }} />
          : <div style={{ width:"100%", height:"100%", background:fallback, display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center", padding:16 }}>
              <div style={{ fontSize:28, marginBottom:8, opacity:0.6 }}>📖</div>
              <div style={{ color:"rgba(255,255,255,0.9)", fontSize:12, fontWeight:700, textAlign:"center", lineHeight:1.4, fontFamily:"Georgia,serif" }}>{book.title}</div>
            </div>}
        {pct > 0 && <div style={{ position:"absolute", bottom:0, left:0, right:0, height:4, background:"rgba(0,0,0,0.4)" }}><div style={{ height:"100%", width:pct+"%", background:C.acc }} /></div>}
        <button onClick={e=>{e.stopPropagation();onDelete(book.hash);}} style={{ position:"absolute", top:6, right:6, background:"rgba(0,0,0,0.7)", color:"#fff", border:"none", borderRadius:"50%", width:24, height:24, fontSize:12, cursor:"pointer", display:hovered?"flex":"none", alignItems:"center", justifyContent:"center" }}>✕</button>
      </div>
      <div style={{ padding:"8px 2px 0" }}>
        <div style={{ fontSize:12, fontWeight:700, color:C.text, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{book.title}</div>
        <div style={{ fontSize:11, color:C.muted, marginTop:2 }}>{pct>0?`${pct}% lido`:"Não iniciado"} • {book.numPages} págs</div>
      </div>
    </div>
  );
}

// ── MAIN ─────────────────────────────────────────────────────────────────
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
  const [voice, setVoice] = useState("pt-BR-ThalitaNeural");
  const [statusMsg, setStatusMsg] = useState("");
  const [dbReady, setDbReady] = useState(false);

  const audioRef = useRef(null);
  const parasRef = useRef([]);
  const curRef = useRef(0);
  const playingRef = useRef(false);
  const speedRef = useRef(1);
  const voiceRef = useRef("pt-BR-ThalitaNeural");
  const activeHashRef = useRef("");
  const paraEls = useRef([]);
  const audioCache = useRef({});

  parasRef.current = paras;
  curRef.current = cur;
  playingRef.current = playing;
  speedRef.current = speed;
  voiceRef.current = voice;

  // Carrega biblioteca do IndexedDB
  useEffect(() => {
    async function init() {
      try {
        const books = await dbGetAll("books");
        books.sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0));
        setLibrary(books);
        setDbReady(true);
      } catch(e) {
        console.error("IndexedDB error:", e);
        setDbReady(true);
      }
    }
    init();
  }, []);

  // MediaSession — controles na tela bloqueada
  useEffect(() => {
    if (!("mediaSession" in navigator)) return;
    navigator.mediaSession.metadata = new MediaMetadata({
      title: activeBook?.title || "Leitor de PDF",
      artist: "Meu Leitor de PDF",
      album: "Biblioteca",
    });
    navigator.mediaSession.setActionHandler("play", () => { audioRef.current?.play(); setPlaying(true); playingRef.current = true; });
    navigator.mediaSession.setActionHandler("pause", () => { audioRef.current?.pause(); setPlaying(false); playingRef.current = false; });
    navigator.mediaSession.setActionHandler("previoustrack", () => { if (curRef.current > 0) playParagraph(curRef.current - 1); });
    navigator.mediaSession.setActionHandler("nexttrack", () => { if (curRef.current < parasRef.current.length - 1) playParagraph(curRef.current + 1); });
  }, [activeBook]);

  const stopAudio = useCallback(() => {
    if (audioRef.current) { audioRef.current.pause(); audioRef.current.src = ""; }
    setPlaying(false); playingRef.current = false; setLoadingAudio(false);
    if ("mediaSession" in navigator) navigator.mediaSession.playbackState = "paused";
  }, []);

  const playParagraph = useCallback(async (idx) => {
    const ps = parasRef.current;
    if (!ps.length || idx >= ps.length) return;
    stopAudio();
    setLoadingAudio(true);
    setCur(idx); curRef.current = idx;

    // Salva progresso no IndexedDB
    await dbPut("progress", { hash: activeHashRef.current, idx });

    // Atualiza lastPara na biblioteca
    const bookData = await dbGet("books", activeHashRef.current);
    if (bookData) {
      const updated = { ...bookData, lastPara: idx, totalParas: ps.length };
      await dbPut("books", updated);
      setLibrary(prev => prev.map(b => b.hash === activeHashRef.current ? updated : b));
    }

    paraEls.current[idx]?.scrollIntoView({ behavior:"smooth", block:"center" });
    setStatusMsg(`⏳ Gerando parágrafo ${idx+1} de ${ps.length}…`);

    try {
      const cacheKey = `${activeHashRef.current}_${idx}_${voiceRef.current}_${speedRef.current}`;
      let url = audioCache.current[cacheKey];
      if (!url) {
        url = await edgeTTS(ps[idx], voiceRef.current, speedRef.current);
        audioCache.current[cacheKey] = url;
      }
      const audio = new Audio(url);
      audio.preload = "auto";
      audioRef.current = audio;
      audio.onplay = () => {
        setPlaying(true); playingRef.current = true; setLoadingAudio(false);
        setStatusMsg(`▶ Parágrafo ${idx+1} de ${ps.length}`);
        if ("mediaSession" in navigator) navigator.mediaSession.playbackState = "playing";
      };
      audio.onended = () => {
        if (playingRef.current && idx+1 < ps.length) playParagraph(idx+1);
        else if (idx+1 >= ps.length) { setPlaying(false); playingRef.current = false; setStatusMsg("Leitura concluída 🎉"); if ("mediaSession" in navigator) navigator.mediaSession.playbackState = "paused"; }
      };
      audio.onerror = () => { setPlaying(false); playingRef.current = false; setLoadingAudio(false); setStatusMsg("Erro no áudio. Verifique sua conexão."); };
      await audio.play();
      // Pré-carrega próximo
      if (idx+1 < ps.length) {
        const nk = `${activeHashRef.current}_${idx+1}_${voiceRef.current}_${speedRef.current}`;
        if (!audioCache.current[nk]) edgeTTS(ps[idx+1], voiceRef.current, speedRef.current).then(u => { audioCache.current[nk] = u; }).catch(()=>{});
      }
    } catch(e) { setLoadingAudio(false); setPlaying(false); setStatusMsg("Erro: " + e.message); }
  }, [stopAudio]);

  const openBook = useCallback(async (book) => {
    stopAudio(); audioCache.current = {};
    setView("loading"); setLoadMsg("Abrindo livro…"); setLoadPct(10);
    try {
      const byteStr = atob(book.b64);
      const bytes = new Uint8Array(byteStr.length);
      for (let i=0;i<byteStr.length;i++) bytes[i]=byteStr.charCodeAt(i);
      const { text } = await extractAllText(bytes.buffer, p => { setLoadPct(10+Math.round(p*0.9)); setLoadMsg(`Carregando… ${10+Math.round(p*0.9)}%`); });
      const ps = toParagraphs(text);
      if (!ps.length) throw new Error("Nenhum texto encontrado.");
      const progressRec = await dbGet("progress", book.hash);
      const savedIdx = Math.min(progressRec?.idx ?? 0, ps.length-1);
      setParas(ps); parasRef.current = ps;
      setCur(savedIdx); curRef.current = savedIdx;
      activeHashRef.current = book.hash;
      setActiveBook(book); setView("reader");
      setStatusMsg(savedIdx>0 ? `📌 Retomando do parágrafo ${savedIdx+1}` : `${ps.length} parágrafos • Toque ▶ para ouvir`);
    } catch(e) { setErrMsg(e.message); setView("library"); }
  }, [stopAudio]);

  const addBook = useCallback(async (file) => {
    if (!file || file.type!=="application/pdf") return;
    stopAudio(); setView("loading"); setErrMsg(""); setLoadPct(0); setLoadMsg("Lendo PDF…");
    try {
      const buffer = await file.arrayBuffer();
      const hash = await hashBuffer(buffer);
      const existing = await dbGet("books", hash);
      if (existing) { openBook(existing); return; }
      setLoadMsg("Gerando capa…"); setLoadPct(15);
      const cover = await renderCover(buffer.slice(0));
      setLoadMsg("Extraindo texto…");
      const { text, numPages } = await extractAllText(buffer.slice(0), p => { setLoadPct(20+Math.round(p*0.78)); setLoadMsg(`Extraindo… ${20+Math.round(p*0.78)}%`); });
      const ps = toParagraphs(text);
      if (!ps.length) throw new Error("Nenhum texto encontrado. PDF pode ser escaneado.");
      setLoadMsg("Salvando na biblioteca…"); setLoadPct(99);
      const bytes = new Uint8Array(buffer);
      let b64=""; const chunk=8192;
      for (let i=0;i<bytes.length;i+=chunk) b64+=String.fromCharCode(...bytes.subarray(i,i+chunk));
      const book = { hash, title:file.name.replace(/\.pdf$/i,""), numPages, cover, b64:btoa(b64), lastPara:0, totalParas:ps.length, addedAt:Date.now() };
      await dbPut("books", book);
      setLibrary(prev => [book, ...prev]);
      setParas(ps); parasRef.current = ps;
      setCur(0); curRef.current = 0;
      activeHashRef.current = hash;
      setActiveBook(book); setView("reader");
      setStatusMsg(`${ps.length} parágrafos prontos • Toque ▶ para ouvir!`);
    } catch(e) { setErrMsg(e.message||"Erro ao processar o PDF."); setView("library"); }
  }, [openBook, stopAudio]);

  const deleteBook = useCallback(async (hash) => {
    await dbDelete("books", hash);
    await dbDelete("progress", hash);
    setLibrary(prev => prev.filter(b => b.hash !== hash));
  }, []);

  const handlePlayPause = () => {
    if (loadingAudio) return;
    if (playing && audioRef.current) { audioRef.current.pause(); setPlaying(false); playingRef.current = false; setStatusMsg("Pausado ⏸"); if ("mediaSession" in navigator) navigator.mediaSession.playbackState = "paused"; }
    else if (!playing && audioRef.current?.src) { audioRef.current.play(); setPlaying(true); playingRef.current = true; if ("mediaSession" in navigator) navigator.mediaSession.playbackState = "playing"; }
    else playParagraph(curRef.current);
  };

  const changeSpeed = s => { setSpeed(s); speedRef.current = s; audioCache.current = {}; if (playing || audioRef.current?.src) { const idx=curRef.current; stopAudio(); setTimeout(()=>playParagraph(idx),80); } };
  const changeVoice = v => { setVoice(v); voiceRef.current = v; audioCache.current = {}; if (playing || audioRef.current?.src) { const idx=curRef.current; stopAudio(); setTimeout(()=>playParagraph(idx),80); } };

  const pct = paras.length ? Math.round(((cur+1)/paras.length)*100) : 0;
  const btnLabel = loadingAudio ? "⏳ Gerando…" : playing ? "⏸ Pausar" : "▶ Ouvir";

  const card = (e={}) => ({ background:C.s1, border:`1px solid ${C.border}`, borderRadius:14, padding:18, marginBottom:14, ...e });
  const row = (e={}) => ({ display:"flex", alignItems:"center", gap:10, flexWrap:"wrap", ...e });
  const btnP = (bg=C.acc,fg=C.bg) => ({ background:bg, color:fg, border:"none", borderRadius:10, padding:"11px 22px", fontSize:14, fontWeight:700, cursor:"pointer", fontFamily:"inherit", whiteSpace:"nowrap" });
  const btnO = { background:C.s2, color:C.text, border:`1px solid ${C.border}`, borderRadius:10, padding:"9px 16px", fontSize:13, cursor:"pointer", fontFamily:"inherit", whiteSpace:"nowrap" };
  const btnT = a => ({ background:a?C.acc:C.s2, color:a?C.bg:C.muted, border:`1px solid ${a?C.acc:C.border}`, borderRadius:8, padding:"5px 11px", fontSize:12, cursor:"pointer", fontFamily:"inherit" });

  return (
    <div style={{ minHeight:"100vh", background:C.bg, color:C.text, fontFamily:"Georgia,serif" }}>

      {/* LIBRARY */}
      {view==="library" && (
        <div style={{ maxWidth:760, margin:"0 auto", padding:"28px 16px" }}>
          <div style={{ marginBottom:28 }}>
            <div style={{ fontSize:"clamp(26px,5vw,40px)", fontWeight:800, color:C.acc2, marginBottom:4 }}>📚 Minha Biblioteca</div>
            <div style={{ color:C.muted, fontSize:13 }}>{!dbReady ? "Carregando…" : library.length===0 ? "Adicione seu primeiro livro" : `${library.length} livro${library.length!==1?"s":""} na coleção`}</div>
          </div>
          {errMsg && <div style={{ background:"#f8714922", border:"1px solid #f8714966", borderRadius:10, padding:"12px 16px", color:C.red, fontSize:14, marginBottom:16 }}>⚠️ {errMsg}</div>}
          <label style={{ display:"block", border:`2px dashed ${C.border}`, borderRadius:14, padding:"28px 20px", textAlign:"center", cursor:"pointer", background:C.s1, marginBottom:32, position:"relative" }}>
            <div style={{ fontSize:36, marginBottom:8 }}>➕</div>
            <div style={{ fontWeight:700, fontSize:16, color:C.acc, marginBottom:4 }}>Adicionar livro</div>
            <div style={{ color:C.muted, fontSize:13 }}>Clique ou arraste um PDF</div>
            <input type="file" accept=".pdf" style={{ position:"absolute", inset:0, opacity:0, cursor:"pointer", width:"100%", height:"100%" }} onChange={e=>addBook(e.target.files[0])} />
          </label>
          {library.length>0
            ? <div style={{ display:"grid", gridTemplateColumns:"repeat(auto-fill,minmax(130px,1fr))", gap:"24px 18px" }}>
                {library.map(book=><BookCard key={book.hash} book={book} onOpen={openBook} onDelete={deleteBook}/>)}
              </div>
            : dbReady && <div style={{ textAlign:"center", padding:"40px 0", color:C.muted }}><div style={{ fontSize:60, marginBottom:16, opacity:0.3 }}>📖</div><div>Sua biblioteca está vazia</div></div>
          }
        </div>
      )}

      {/* LOADING */}
      {view==="loading" && (
        <div style={{ minHeight:"100vh", display:"flex", alignItems:"center", justifyContent:"center", flexDirection:"column", padding:32 }}>
          <div style={{ fontSize:48, marginBottom:20 }}>⏳</div>
          <div style={{ fontSize:16, color:C.text, marginBottom:20 }}>{loadMsg}</div>
          <div style={{ width:"100%", maxWidth:320, height:6, background:C.s2, borderRadius:99, overflow:"hidden" }}>
            <div style={{ height:"100%", width:loadPct+"%", background:`linear-gradient(90deg,${C.acc},#e87070)`, borderRadius:99, transition:"width .3s" }} />
          </div>
          <div style={{ fontSize:12, color:C.muted, marginTop:8 }}>{loadPct}%</div>
        </div>
      )}

      {/* READER */}
      {view==="reader" && (
        <div style={{ maxWidth:700, margin:"0 auto", padding:"20px 14px" }}>
          <div style={row({ marginBottom:16 })}>
            <button style={{ ...btnO, padding:"7px 14px" }} onClick={()=>{ stopAudio(); setView("library"); }}>← Biblioteca</button>
            <div style={{ flex:1, fontSize:14, fontWeight:700, color:C.acc2, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap", textAlign:"center" }}>{activeBook?.title}</div>
            <div style={{ fontSize:11, color:C.muted, whiteSpace:"nowrap" }}>{activeBook?.numPages} págs</div>
          </div>
          <div style={{ display:"flex", gap:14, marginBottom:16, alignItems:"flex-start" }}>
            {activeBook?.cover && <img src={activeBook.cover} alt="" style={{ width:60, borderRadius:6, boxShadow:"0 4px 16px rgba(0,0,0,0.5)", flexShrink:0 }} />}
            <div style={{ flex:1 }}>
              <div style={row({ justifyContent:"space-between", fontSize:12, color:C.muted, marginBottom:6 })}><span>{pct}% lido</span><span>§ {cur+1} / {paras.length}</span></div>
              <div style={{ height:6, background:C.s2, borderRadius:99, overflow:"hidden", cursor:"pointer" }}
                onClick={e=>{ const r=e.currentTarget.getBoundingClientRect(); playParagraph(Math.max(0,Math.min(Math.floor((e.clientX-r.left)/r.width*paras.length),paras.length-1))); }}>
                <div style={{ height:"100%", width:pct+"%", background:`linear-gradient(90deg,${C.acc},#e87070)`, borderRadius:99, transition:"width .4s" }} />
              </div>
            </div>
          </div>
          <div style={card()}>
            <div style={row({ justifyContent:"center", marginBottom:14 })}>
              <button style={{ ...btnO, opacity:cur===0?0.4:1 }} disabled={cur===0} onClick={()=>playParagraph(cur-1)}>⏮</button>
              <button style={btnP(loadingAudio?C.muted:playing?C.red:C.acc,C.bg)} disabled={loadingAudio} onClick={handlePlayPause}>{btnLabel}</button>
              <button style={{ ...btnO, opacity:cur>=paras.length-1?0.4:1 }} disabled={cur>=paras.length-1} onClick={()=>playParagraph(cur+1)}>⏭</button>
            </div>
            <div style={row({ justifyContent:"center", marginBottom:12 })}>
              <span style={{ fontSize:12, color:C.muted }}>Voz:</span>
              <select value={voice} onChange={e=>changeVoice(e.target.value)} style={{ background:C.s2, border:`1px solid ${C.border}`, color:C.text, padding:"7px 10px", borderRadius:8, fontSize:13, fontFamily:"inherit", flex:1, maxWidth:280 }}>
                {EDGE_VOICES.map(v=><option key={v.id} value={v.id}>{v.label}</option>)}
              </select>
            </div>
            <div style={row({ justifyContent:"center" })}>
              <span style={{ fontSize:12, color:C.muted }}>Velocidade:</span>
              {SPEEDS.map(s=><button key={s} style={btnT(speed===s)} onClick={()=>changeSpeed(s)}>{s}×</button>)}
            </div>
          </div>
          <div style={{ textAlign:"center", fontSize:12, color:C.muted, marginBottom:10, minHeight:16 }}>{statusMsg}</div>
          <div style={{ background:C.s1, border:`1px solid ${C.border}`, borderRadius:14, padding:16, maxHeight:360, overflowY:"auto" }}>
            {paras.map((p,i)=>(
              <div key={i} ref={el=>paraEls.current[i]=el} onClick={()=>playParagraph(i)}
                style={{ fontSize:14.5, lineHeight:1.8, padding:"8px 12px", borderRadius:8, marginBottom:6, cursor:"pointer", borderLeft:`3px solid ${i===cur?C.acc:"transparent"}`, background:i===cur?"rgba(232,201,122,0.1)":"transparent", color:i<cur?"#3a3528":i===cur?C.acc2:C.text, transition:"background .1s" }}>
                <span style={{ fontSize:10, color:C.muted, marginRight:6 }}>{i+1}</span>{p}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

import { useState, useEffect, useRef, useCallback } from "react";

// ── IndexedDB ─────────────────────────────────────────────────────────────
const DB_NAME = "leitorpdf_db", DB_VERSION = 1;
function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = e => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains("books")) db.createObjectStore("books", { keyPath:"hash" });
      if (!db.objectStoreNames.contains("progress")) db.createObjectStore("progress", { keyPath:"hash" });
    };
    req.onsuccess = e => resolve(e.target.result);
    req.onerror = () => reject(req.error);
  });
}
async function dbGetAll(store) {
  const db = await openDB();
  return new Promise((res,rej) => { const r=db.transaction(store,"readonly").objectStore(store).getAll(); r.onsuccess=()=>res(r.result); r.onerror=()=>rej(r.error); });
}
async function dbPut(store, value) {
  const db = await openDB();
  return new Promise((res,rej) => { const tx=db.transaction(store,"readwrite"); tx.objectStore(store).put(value); tx.oncomplete=res; tx.onerror=()=>rej(tx.error); });
}
async function dbDelete(store, key) {
  const db = await openDB();
  return new Promise((res,rej) => { const tx=db.transaction(store,"readwrite"); tx.objectStore(store).delete(key); tx.oncomplete=res; tx.onerror=()=>rej(tx.error); });
}
async function dbGet(store, key) {
  const db = await openDB();
  return new Promise((res,rej) => { const r=db.transaction(store,"readonly").objectStore(store).get(key); r.onsuccess=()=>res(r.result); r.onerror=()=>rej(r.error); });
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
      lib.GlobalWorkerOptions.workerSrc = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";
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
    const vp0 = page.getViewport({ scale:1 });
    const scale = Math.min(300/vp0.width, 420/vp0.height);
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
  const n = pdf.numPages;
  let text = "";
  const BATCH = 15;
  for (let i = 1; i <= n; i += BATCH) {
    const end = Math.min(i+BATCH-1, n);
    const texts = await Promise.all(Array.from({ length: end-i+1 }, async (_,j) => {
      const pg = await pdf.getPage(i+j);
      const c = await pg.getTextContent();
      return c.items.map(x=>x.str).join(" ");
    }));
    text += texts.join("\n\n") + "\n\n";
    onProgress && onProgress(Math.round((end/n)*100));
  }
  return { text, numPages: n };
}
function toParagraphs(text) {
  return text.split(/\n{2,}/).map(p=>p.replace(/\s+/g," ").trim()).filter(p=>p.length>30);
}

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

// ── TTS — WebSocket direto (funciona no APK nativo) ─────────────────────
function buildSSML(text, voice, rate) {
  const rateStr = rate >= 0 ? `+${rate}%` : `${rate}%`;
  const esc = text.replace(/[<>&'"]/g, c =>
    ({"<":"&lt;",">":"&gt;","&":"&amp;","'":"&apos;",'"':"&quot;"}[c]));
  return `<speak version='1.0' xml:lang='pt-BR'><voice name='${voice}'><prosody rate='${rateStr}'>${esc}</prosody></voice></speak>`;
}

function rateToPercent(speed) { return Math.round((speed - 1) * 100); }

function edgeTTSDirect(text, voice, speed) {
  return new Promise((resolve, reject) => {
    const reqId = Array.from(crypto.getRandomValues(new Uint8Array(16)))
      .map(b => b.toString(16).padStart(2,"0")).join("").toUpperCase();
    const url = `wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1?TrustedClientToken=6A5AA1D4EAFF4E9FB37E23D68491D6F4&ConnectionId=${reqId}`;
    const ws = new WebSocket(url);
    const chunks = [];
    let started = false;
    // Reduzido de 20s para 8s: o token usado aqui não é oficial da Microsoft e
    // pode ser limitado/bloqueado periodicamente. Quando isso acontece, a conexão
    // fica "pendurada" sem responder — 20s de espera é o que causava a sensação
    // de "está sempre carregando" ao trocar de parágrafo. Com 8s, falha mais rápido
    // e cai no fallback (ou mostra erro) sem prender o usuário esperando tanto.
    const timeout = setTimeout(() => { ws.close(); reject(new Error("Timeout")); }, 8000);

    ws.onopen = () => {
      const ts = new Date().toISOString();
      ws.send(
        `X-Timestamp:${ts}\r\nContent-Type:application/json; charset=utf-8\r\nPath:speech.config\r\n\r\n` +
        JSON.stringify({ context: { synthesis: { audio: { metadataoptions: { sentenceBoundaryEnabled: false, wordBoundaryEnabled: false }, outputFormat: "audio-24khz-48kbitrate-mono-mp3" } } } })
      );
      ws.send(
        `X-RequestId:${reqId}\r\nContent-Type:application/ssml+xml\r\nX-Timestamp:${ts}\r\nPath:ssml\r\n\r\n` +
        buildSSML(text, voice, rateToPercent(speed))
      );
    };

    ws.onmessage = (event) => {
      if (typeof event.data === "string") {
        if (event.data.includes("Path:turn.end")) {
          clearTimeout(timeout); ws.close();
          if (!chunks.length) { reject(new Error("Sem áudio")); return; }
          resolve(URL.createObjectURL(new Blob(chunks, { type: "audio/mpeg" })));
        }
      } else {
        event.data.arrayBuffer().then(buf => {
          const arr = new Uint8Array(buf);
          // Find "Path:audio\r\n" header end
          const headerLen = new DataView(buf).getUint16(0);
          const headerStr = new TextDecoder().decode(arr.slice(2, 2 + headerLen));
          if (headerStr.includes("Path:audio")) {
            started = true;
            chunks.push(arr.slice(2 + headerLen));
          } else if (started) {
            chunks.push(arr);
          }
        });
      }
    };

    ws.onerror = () => { clearTimeout(timeout); reject(new Error("Erro WebSocket — verifique sua conexão")); };
    ws.onclose = () => clearTimeout(timeout);
  });
}

async function fetchTTS(text, voice="pt-BR-ThalitaNeural", speed=1) {
  // Tenta WebSocket direto primeiro (funciona no APK)
  // Se falhar, tenta o servidor proxy (Vercel)
  try {
    return await edgeTTSDirect(text.slice(0, 4000), voice, speed);
  } catch(e) {
    console.warn("WebSocket direto falhou, tentando proxy:", e.message);
    const res = await fetch("/api/tts", {
      method:"POST",
      headers:{"Content-Type":"application/json"},
      body: JSON.stringify({ text: text.slice(0,4000), voice, speed }),
    });
    if (!res.ok) {
      const err = await res.json().catch(()=>({}));
      throw new Error(err.error || "Erro ao gerar áudio");
    }
    const blob = await res.blob();
    return URL.createObjectURL(blob);
  }
}

// ── Storage helpers ───────────────────────────────────────────────────────
async function hashBuffer(buf) {
  const h = await crypto.subtle.digest("SHA-1", buf.slice(0,65536));
  return Array.from(new Uint8Array(h)).map(b=>b.toString(16).padStart(2,"0")).join("").slice(0,14);
}

const SPEEDS = [0.75, 1, 1.1, 1.25, 1.5, 1.75, 2];
const C = { bg:"#0e0c14", s1:"#17141f", s2:"#211d2e", border:"#2d2840", acc:"#e8c97a", acc2:"#f5dfa0", text:"#f0ebe0", muted:"#7a7490", red:"#f87171", green:"#6ee7b7" };

// ── BookCard ──────────────────────────────────────────────────────────────
function BookCard({ book, onOpen, onDelete }) {
  const [hov, setHov] = useState(false);
  const pct = book.totalParas ? Math.round(((book.lastPara+1)/book.totalParas)*100) : 0;
  const grads = ["linear-gradient(135deg,#b5451b,#7c1d0f)","linear-gradient(135deg,#1a4a7a,#0d2844)","linear-gradient(135deg,#2d5a27,#173314)","linear-gradient(135deg,#5a2d7a,#2e1540)","linear-gradient(135deg,#7a5a1a,#3d2d0a)","linear-gradient(135deg,#1a5a5a,#0a2d2d)"];
  const fallback = grads[(book.hash?.charCodeAt(0)||0)%grads.length];
  return (
    <div onClick={()=>onOpen(book)} onMouseEnter={()=>setHov(true)} onMouseLeave={()=>setHov(false)}
      style={{cursor:"pointer",transform:hov?"translateY(-6px) scale(1.02)":"none",transition:"transform 0.2s",display:"flex",flexDirection:"column"}}>
      <div style={{width:"100%",aspectRatio:"2/3",borderRadius:10,overflow:"hidden",boxShadow:hov?"0 20px 50px rgba(0,0,0,0.7)":"0 8px 30px rgba(0,0,0,0.5)",background:fallback,position:"relative"}}>
        {book.cover
          ? <img src={book.cover} alt={book.title} style={{width:"100%",height:"100%",objectFit:"cover"}}/>
          : <div style={{width:"100%",height:"100%",background:fallback,display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",padding:16}}>
              <div style={{fontSize:28,marginBottom:8,opacity:0.6}}>📖</div>
              <div style={{color:"rgba(255,255,255,0.9)",fontSize:12,fontWeight:700,textAlign:"center",lineHeight:1.4,fontFamily:"Georgia,serif"}}>{book.title}</div>
            </div>}
        {pct>0 && <div style={{position:"absolute",bottom:0,left:0,right:0,height:4,background:"rgba(0,0,0,0.4)"}}><div style={{height:"100%",width:pct+"%",background:C.acc}}/></div>}
        <button onClick={e=>{e.stopPropagation();onDelete(book.hash);}} style={{position:"absolute",top:6,right:6,background:"rgba(0,0,0,0.7)",color:"#fff",border:"none",borderRadius:"50%",width:24,height:24,fontSize:12,cursor:"pointer",display:hov?"flex":"none",alignItems:"center",justifyContent:"center"}}>✕</button>
      </div>
      <div style={{padding:"8px 2px 0"}}>
        <div style={{fontSize:12,fontWeight:700,color:C.text,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{book.title}</div>
        <div style={{fontSize:11,color:C.muted,marginTop:2}}>{pct>0?`${pct}% lido`:"Não iniciado"} • {book.numPages} págs</div>
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
  const [voice, setVoice] = useState("pt-BR-ThalitaNeural");
  const [statusMsg, setStatusMsg] = useState("");
  const [cachedIdxs, setCachedIdxs] = useState(new Set());

  // Refs
  const audioRef = useRef(null);
  const parasRef = useRef([]);
  const curRef = useRef(0);
  const playingRef = useRef(false);
  const speedRef = useRef(1);
  const voiceRef = useRef("pt-BR-ThalitaNeural");
  const activeHashRef = useRef("");
  const paraEls = useRef([]);
  // Audio cache: idx -> url
  const audioCache = useRef({});
  // Mutex: prevents double-play
  const playLock = useRef(false);
  // Prefetch queue
  const prefetchQueue = useRef(new Set());

  parasRef.current = paras;
  curRef.current = cur;
  playingRef.current = playing;
  speedRef.current = speed;
  voiceRef.current = voice;

  useEffect(() => {
    async function init() {
      const books = await dbGetAll("books");
      books.sort((a,b)=>(b.addedAt||0)-(a.addedAt||0));
      setLibrary(books);
    }
    init();
  }, []);

  // MediaSession
  useEffect(() => {
    if (!("mediaSession" in navigator)) return;
    navigator.mediaSession.metadata = new MediaMetadata({
      title: activeBook?.title || "Leitor de PDF",
      artist: "Meu Leitor de PDF",
      album: "Biblioteca",
    });
    navigator.mediaSession.setActionHandler("play", () => { audioRef.current?.play(); setPlaying(true); playingRef.current=true; });
    navigator.mediaSession.setActionHandler("pause", () => { audioRef.current?.pause(); setPlaying(false); playingRef.current=false; });
    navigator.mediaSession.setActionHandler("previoustrack", () => { if(curRef.current>0) playParagraph(curRef.current-1); });
    navigator.mediaSession.setActionHandler("nexttrack", () => { if(curRef.current<parasRef.current.length-1) playParagraph(curRef.current+1); });
  }, [activeBook]);

  // ── Prefetch helper ──────────────────────────────────────────────────
  // Antes: só buscava 3 parágrafos à frente, e só quando o atual começava a
  // tocar — margem pequena demais. Agora busca PREFETCH_AHEAD parágrafos e
  // faz isso um de cada vez (sequencial), em vez de abrir várias conexões
  // simultâneas ao servidor da Microsoft (o que aumenta o risco de sermos
  // limitados/bloqueados, já que o endpoint usado não é oficial).
  const PREFETCH_AHEAD = 6;
  const prefetch = useCallback(async (idx, count = PREFETCH_AHEAD) => {
    const ps = parasRef.current;
    const end = Math.min(idx + count, ps.length);
    for (let i = idx; i < end; i++) {
      const key = `${activeHashRef.current}_${i}_${speedRef.current}`;
      if (audioCache.current[key] || prefetchQueue.current.has(key)) continue;
      prefetchQueue.current.add(key);
      try {
        const url = await fetchTTS(ps[i], voiceRef.current, speedRef.current);
        audioCache.current[key] = url;
        setCachedIdxs(prev => new Set([...prev, i]));
      } catch {
        // ignora falha de um parágrafo específico e continua tentando os próximos
      } finally {
        prefetchQueue.current.delete(key);
      }
    }
  }, []);

  // ── Stop all audio completely ────────────────────────────────────────
  const stopAudio = useCallback(() => {
    playLock.current = false;
    if (audioRef.current) {
      const old = audioRef.current;
      // Desconecta TODOS os handlers, inclusive onplay (antes só onended/onerror
      // eram limpos — se o play() anterior ainda estivesse "pendurado", o onplay
      // podia disparar depois do pause() e reativar o mediaSession como "playing").
      old.onplay = null;
      old.onended = null;
      old.onerror = null;
      old.pause();
      // Usar removeAttribute em vez de src="" evita que o WebView tente
      // (às vezes) recarregar a própria página como se fosse um arquivo de mídia.
      old.removeAttribute("src");
      // load() força o elemento a abortar qualquer play()/buffer pendente e
      // resetar o estado interno do player nativo do WebView — é isso que
      // realmente garante que o áudio antigo pare, em vez de só pause()+src=""
      // (que em muitos WebViews Android não é síncrono/confiável sozinho).
      old.load();
      audioRef.current = null;
    }
    setPlaying(false);
    playingRef.current = false;
    setLoadingAudio(false);
    if ("mediaSession" in navigator) navigator.mediaSession.playbackState = "paused";
  }, []);

  // ── Play a specific paragraph ────────────────────────────────────────
  const playParagraph = useCallback(async (idx) => {
    const ps = parasRef.current;
    if (!ps.length || idx >= ps.length) return;

    // Mutex — cancel any in-flight play
    playLock.current = false;
    stopAudio();

    // Small delay to ensure previous audio is fully stopped
    await new Promise(r => setTimeout(r, 50));

    const lockId = {};
    playLock.current = lockId;

    setCur(idx); curRef.current = idx;
    await dbPut("progress", { hash: activeHashRef.current, idx });

    // Update library progress
    const bookData = await dbGet("books", activeHashRef.current);
    if (bookData) {
      const updated = { ...bookData, lastPara:idx, totalParas:ps.length };
      await dbPut("books", updated);
      setLibrary(prev => prev.map(b => b.hash===activeHashRef.current ? updated : b));
    }

    paraEls.current[idx]?.scrollIntoView({ behavior:"smooth", block:"center" });

    const key = `${activeHashRef.current}_${idx}_${speedRef.current}`;
    const cached = audioCache.current[key];

    if (!cached) {
      setLoadingAudio(true);
      setStatusMsg(`⏳ Carregando ${idx+1}/${ps.length}…`);
    } else {
      setStatusMsg(`▶ Parágrafo ${idx+1} de ${ps.length}`);
    }

    try {
      let url = cached;
      if (!url) {
        url = await fetchTTS(ps[idx], voiceRef.current, speedRef.current);
        // Check lock still valid (user didn't skip/stop while loading)
        if (playLock.current !== lockId) return;
        audioCache.current[key] = url;
        setCachedIdxs(prev => new Set([...prev, idx]));
      }

      if (playLock.current !== lockId) return;

      const audio = new Audio(url);
      audio.preload = "auto";
      audioRef.current = audio;

      audio.onplay = () => {
        if (playLock.current !== lockId) { audio.pause(); return; }
        setPlaying(true); playingRef.current = true;
        setLoadingAudio(false);
        setStatusMsg(`▶ Parágrafo ${idx+1} de ${ps.length}`);
        if ("mediaSession" in navigator) navigator.mediaSession.playbackState = "playing";
        // Prefetch next 3 paragraphs while playing
        prefetch(idx+1);
      };

      audio.onended = () => {
        if (playLock.current !== lockId) return;
        if (idx+1 < ps.length) {
          playParagraph(idx+1);
        } else {
          setPlaying(false); playingRef.current = false;
          setStatusMsg("Leitura concluída 🎉");
          if ("mediaSession" in navigator) navigator.mediaSession.playbackState = "paused";
        }
      };

      audio.onerror = () => {
        if (playLock.current !== lockId) return;
        setPlaying(false); playingRef.current = false; setLoadingAudio(false);
        setStatusMsg("Erro no áudio. Verifique sua conexão.");
      };

      await audio.play();

    } catch(e) {
      if (playLock.current !== lockId) return;
      setLoadingAudio(false); setPlaying(false);
      setStatusMsg("Erro: " + e.message);
    }
  }, [stopAudio, prefetch]);

  // ── Open book ────────────────────────────────────────────────────────
  const openBook = useCallback(async (book) => {
    stopAudio();
    audioCache.current = {};
    prefetchQueue.current.clear();
    setCachedIdxs(new Set());
    setView("loading"); setLoadMsg("Abrindo livro…"); setLoadPct(10);
    try {
      const byteStr = atob(book.b64);
      const bytes = new Uint8Array(byteStr.length);
      for (let i=0;i<byteStr.length;i++) bytes[i]=byteStr.charCodeAt(i);
      const { text } = await extractAllText(bytes.buffer, p => {
        setLoadPct(10+Math.round(p*0.9)); setLoadMsg(`Carregando… ${10+Math.round(p*0.9)}%`);
      });
      const ps = toParagraphs(text);
      if (!ps.length) throw new Error("Nenhum texto encontrado.");
      const progressRec = await dbGet("progress", book.hash);
      const savedIdx = Math.min(progressRec?.idx??0, ps.length-1);
      setParas(ps); parasRef.current = ps;
      setCur(savedIdx); curRef.current = savedIdx;
      activeHashRef.current = book.hash;
      setActiveBook(book); setView("reader");
      const msg = savedIdx>0 ? `📌 Retomando do parágrafo ${savedIdx+1}` : `${ps.length} parágrafos • Toque ▶ para ouvir`;
      setStatusMsg(msg);
      // Começa a preparar os áudios ANTES de você apertar play — antes buscava
      // só 3 parágrafos; agora usa a mesma margem (PREFETCH_AHEAD) do resto do app.
      setTimeout(() => prefetch(savedIdx), 300);
    } catch(e) { setErrMsg(e.message); setView("library"); }
  }, [stopAudio, prefetch]);

  // ── Add book ─────────────────────────────────────────────────────────
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
      const { text, numPages } = await extractAllText(buffer.slice(0), p => {
        setLoadPct(20+Math.round(p*0.78)); setLoadMsg(`Extraindo… ${20+Math.round(p*0.78)}%`);
      });
      const ps = toParagraphs(text);
      if (!ps.length) throw new Error("Nenhum texto encontrado. PDF pode ser escaneado.");
      setLoadMsg("Salvando…"); setLoadPct(99);
      const bytes = new Uint8Array(buffer);
      let b64=""; const chunk=8192;
      for (let i=0;i<bytes.length;i+=chunk) b64+=String.fromCharCode(...bytes.subarray(i,i+chunk));
      const book = { hash, title:file.name.replace(/\.pdf$/i,""), numPages, cover, b64:btoa(b64), lastPara:0, totalParas:ps.length, addedAt:Date.now() };
      await dbPut("books", book);
      setLibrary(prev=>[book,...prev]);
      setParas(ps); parasRef.current=ps;
      setCur(0); curRef.current=0;
      activeHashRef.current=hash;
      audioCache.current={}; prefetchQueue.current.clear(); setCachedIdxs(new Set());
      setActiveBook(book); setView("reader");
      setStatusMsg(`${ps.length} parágrafos prontos • Toque ▶ para ouvir!`);
      setTimeout(() => prefetch(0), 300);
    } catch(e) { setErrMsg(e.message||"Erro ao processar o PDF."); setView("library"); }
  }, [openBook, stopAudio, prefetch]);

  const deleteBook = useCallback(async (hash) => {
    await dbDelete("books", hash); await dbDelete("progress", hash);
    setLibrary(prev=>prev.filter(b=>b.hash!==hash));
  }, []);

  const handlePlayPause = () => {
    if (loadingAudio) return;
    if (playing && audioRef.current) {
      // Pause
      audioRef.current.pause();
      setPlaying(false); playingRef.current=false;
      setStatusMsg("Pausado ⏸");
      if ("mediaSession" in navigator) navigator.mediaSession.playbackState="paused";
    } else if (!playing && audioRef.current && audioRef.current.src && !audioRef.current.ended) {
      // Resume
      audioRef.current.play();
      setPlaying(true); playingRef.current=true;
      if ("mediaSession" in navigator) navigator.mediaSession.playbackState="playing";
    } else {
      // Start fresh
      playParagraph(curRef.current);
    }
  };

  const changeSpeed = s => {
    // Clear cache since speed changed
    audioCache.current = {};
    prefetchQueue.current.clear();
    setCachedIdxs(new Set());
    speedRef.current = s;
    setSpeed(s);
    if (playing || loadingAudio) {
      const idx = curRef.current;
      stopAudio();
      setTimeout(() => playParagraph(idx), 80);
    }
  };

  const changeVoice = v => {
    audioCache.current = {};
    prefetchQueue.current.clear();
    setCachedIdxs(new Set());
    voiceRef.current = v;
    setVoice(v);
    if (playing || loadingAudio) {
      const idx = curRef.current;
      stopAudio();
      setTimeout(() => playParagraph(idx), 80);
    }
  };

  const pct = paras.length ? Math.round(((cur+1)/paras.length)*100) : 0;
  const btnLabel = loadingAudio ? "⏳ Carregando…" : playing ? "⏸ Pausar" : "▶ Ouvir";

  const card = (e={}) => ({background:C.s1,border:`1px solid ${C.border}`,borderRadius:14,padding:18,marginBottom:14,...e});
  const row = (e={}) => ({display:"flex",alignItems:"center",gap:10,flexWrap:"wrap",...e});
  const btnP = (bg=C.acc,fg=C.bg) => ({background:bg,color:fg,border:"none",borderRadius:10,padding:"11px 22px",fontSize:14,fontWeight:700,cursor:"pointer",fontFamily:"inherit",whiteSpace:"nowrap"});
  const btnO = {background:C.s2,color:C.text,border:`1px solid ${C.border}`,borderRadius:10,padding:"9px 16px",fontSize:13,cursor:"pointer",fontFamily:"inherit",whiteSpace:"nowrap"};
  const btnT = a => ({background:a?C.acc:C.s2,color:a?C.bg:C.muted,border:`1px solid ${a?C.acc:C.border}`,borderRadius:8,padding:"5px 11px",fontSize:12,cursor:"pointer",fontFamily:"inherit"});

  return (
    <div style={{minHeight:"100vh",background:C.bg,color:C.text,fontFamily:"Georgia,serif"}}>

      {/* LIBRARY */}
      {view==="library" && (
        <div style={{maxWidth:760,margin:"0 auto",padding:"28px 16px"}}>
          <div style={{marginBottom:28}}>
            <div style={{fontSize:"clamp(26px,5vw,40px)",fontWeight:800,color:C.acc2,marginBottom:4}}>📚 Minha Biblioteca</div>
            <div style={{color:C.muted,fontSize:13}}>{library.length===0?"Adicione seu primeiro livro":`${library.length} livro${library.length!==1?"s":""} na coleção`}</div>
          </div>
          {errMsg && <div style={{background:"#f8714922",border:"1px solid #f8714966",borderRadius:10,padding:"12px 16px",color:C.red,fontSize:14,marginBottom:16}}>⚠️ {errMsg}</div>}
          <label style={{display:"block",border:`2px dashed ${C.border}`,borderRadius:14,padding:"28px 20px",textAlign:"center",cursor:"pointer",background:C.s1,marginBottom:32,position:"relative"}}>
            <div style={{fontSize:36,marginBottom:8}}>➕</div>
            <div style={{fontWeight:700,fontSize:16,color:C.acc,marginBottom:4}}>Adicionar livro</div>
            <div style={{color:C.muted,fontSize:13}}>Clique ou arraste um PDF</div>
            <input type="file" accept=".pdf" style={{position:"absolute",inset:0,opacity:0,cursor:"pointer",width:"100%",height:"100%"}} onChange={e=>addBook(e.target.files[0])}/>
          </label>
          {library.length>0
            ? <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(130px,1fr))",gap:"24px 18px"}}>
                {library.map(book=><BookCard key={book.hash} book={book} onOpen={openBook} onDelete={deleteBook}/>)}
              </div>
            : <div style={{textAlign:"center",padding:"40px 0",color:C.muted}}><div style={{fontSize:60,marginBottom:16,opacity:0.3}}>📖</div><div>Sua biblioteca está vazia</div></div>
          }
        </div>
      )}

      {/* LOADING */}
      {view==="loading" && (
        <div style={{minHeight:"100vh",display:"flex",alignItems:"center",justifyContent:"center",flexDirection:"column",padding:32}}>
          <div style={{fontSize:48,marginBottom:20}}>⏳</div>
          <div style={{fontSize:16,color:C.text,marginBottom:20}}>{loadMsg}</div>
          <div style={{width:"100%",maxWidth:320,height:6,background:C.s2,borderRadius:99,overflow:"hidden"}}>
            <div style={{height:"100%",width:loadPct+"%",background:`linear-gradient(90deg,${C.acc},#e87070)`,borderRadius:99,transition:"width .3s"}}/>
          </div>
          <div style={{fontSize:12,color:C.muted,marginTop:8}}>{loadPct}%</div>
        </div>
      )}

      {/* READER */}
      {view==="reader" && (
        <div style={{maxWidth:700,margin:"0 auto",padding:"20px 14px"}}>
          <div style={row({marginBottom:16})}>
            <button style={{...btnO,padding:"7px 14px"}} onClick={()=>{stopAudio();setView("library");}}>← Biblioteca</button>
            <div style={{flex:1,fontSize:14,fontWeight:700,color:C.acc2,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap",textAlign:"center"}}>{activeBook?.title}</div>
            <div style={{fontSize:11,color:C.muted,whiteSpace:"nowrap"}}>{activeBook?.numPages} págs</div>
          </div>

          {/* Cover + progress */}
          <div style={{display:"flex",gap:14,marginBottom:16,alignItems:"flex-start"}}>
            {activeBook?.cover && <img src={activeBook.cover} alt="" style={{width:60,borderRadius:6,boxShadow:"0 4px 16px rgba(0,0,0,0.5)",flexShrink:0}}/>}
            <div style={{flex:1}}>
              <div style={row({justifyContent:"space-between",fontSize:12,color:C.muted,marginBottom:6})}>
                <span>{pct}% lido</span><span>§ {cur+1} / {paras.length}</span>
              </div>
              <div style={{height:6,background:C.s2,borderRadius:99,overflow:"hidden",cursor:"pointer"}}
                onClick={e=>{const r=e.currentTarget.getBoundingClientRect();playParagraph(Math.max(0,Math.min(Math.floor((e.clientX-r.left)/r.width*paras.length),paras.length-1)));}}>
                <div style={{height:"100%",width:pct+"%",background:`linear-gradient(90deg,${C.acc},#e87070)`,borderRadius:99,transition:"width .4s"}}/>
              </div>
            </div>
          </div>

          {/* Controls */}
          <div style={card()}>
            <div style={row({justifyContent:"center",marginBottom:14})}>
              <button style={{...btnO,opacity:cur===0?0.4:1}} disabled={cur===0} onClick={()=>playParagraph(cur-1)}>⏮</button>
              <button style={btnP(loadingAudio?C.muted:playing?C.red:C.acc,C.bg)} onClick={handlePlayPause}>{btnLabel}</button>
              <button style={{...btnO,opacity:cur>=paras.length-1?0.4:1}} disabled={cur>=paras.length-1} onClick={()=>playParagraph(cur+1)}>⏭</button>
            </div>
            <div style={row({justifyContent:"center",marginBottom:10})}>
              <span style={{fontSize:12,color:C.muted}}>Velocidade:</span>
              {SPEEDS.map(s=><button key={s} style={btnT(speed===s)} onClick={()=>changeSpeed(s)}>{s}×</button>)}
            </div>
            <div style={row({justifyContent:"center"})}>
              <span style={{fontSize:12,color:C.muted}}>Voz:</span>
              <select value={voice} onChange={e=>changeVoice(e.target.value)}
                style={{background:C.s2,border:`1px solid ${C.border}`,color:C.text,padding:"7px 10px",borderRadius:8,fontSize:13,fontFamily:"inherit",flex:1,maxWidth:280}}>
                {EDGE_VOICES.map(v=><option key={v.id} value={v.id}>{v.label}</option>)}
              </select>
            </div>
          </div>

          <div style={{textAlign:"center",fontSize:12,color:C.muted,marginBottom:10,minHeight:16}}>{statusMsg}</div>

          {/* Text */}
          <div style={{background:C.s1,border:`1px solid ${C.border}`,borderRadius:14,padding:16,maxHeight:360,overflowY:"auto"}}>
            {paras.map((p,i)=>(
              <div key={i} ref={el=>paraEls.current[i]=el} onClick={()=>playParagraph(i)}
                style={{fontSize:14.5,lineHeight:1.8,padding:"8px 12px",borderRadius:8,marginBottom:6,cursor:"pointer",
                  borderLeft:`3px solid ${i===cur?C.acc:"transparent"}`,
                  background:i===cur?"rgba(232,201,122,0.1)":"transparent",
                  color:i<cur?"#3a3528":i===cur?C.acc2:C.text,transition:"background .1s",
                  position:"relative"}}>
                <span style={{fontSize:10,color:C.muted,marginRight:6}}>{i+1}</span>
                {p}
                {/* Indicator: cached = green dot */}
                {cachedIdxs.has(i) && i!==cur && (
                  <span style={{position:"absolute",right:8,top:"50%",transform:"translateY(-50%)",width:6,height:6,borderRadius:"50%",background:C.green,opacity:0.6}}/>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

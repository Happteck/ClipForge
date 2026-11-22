'use strict';
const $ = (id) => document.getElementById(id);
const S = { multi: new Set(), media: [], clips: [], overlays: [], audios: [], texts: [], sel: null, t: 0, playing: false, pps: 60, aspect: '16:9', master: 1, file: null };
const vid = $('vid'), img = $('img'), stage = $('stage'), overlay = $('overlay'), ovMedia = $('ovMedia');
let inspTab = 'basic', uid = 1, curPath = null, last = 0, raf = 0, pushOnce = false, curRows = null;
const IC_PLAY = '<svg class="ic" viewBox="0 0 24 24"><path d="M7 4l13 8-13 8z"/></svg>';
const IC_PAUSE = '<svg class="ic" viewBox="0 0 24 24"><path d="M6 4h4v16H6zM14 4h4v16h-4z"/></svg>';
const undoS = [], redoS = [], ovEls = new Map(), audEls = new Map();

const url = (p) => encodeURI('file:///' + p.replace(/\\/g, '/')).replace(/#/g, '%23');
const spd = (c) => (c.kind === 'image' ? 1 : c.speed || 1);
const dur = (c) => (c.freeze ? c.fd : (c.out - c.in) / spd(c));
const fmt = (s) => { s = Math.max(0, s); const m = Math.floor(s / 60); return String(m).padStart(2, '0') + ':' + (s % 60).toFixed(1).padStart(4, '0'); };
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const find = (id) => S.clips.find((c) => c.id === id) || S.overlays.find((c) => c.id === id) || S.audios.find((c) => c.id === id) || S.texts.find((t) => t.id === id);
const isText = (x) => x.text !== undefined;
const isAudio = (x) => x.kind === 'audio';

/* ---------- layout (clips can overlap when a transition is set) ---------- */
const canExtend = (c) => c.kind === 'video' && !c.freeze && !c.rev && c.srcDur > 0;
function layOf(list) {
  const out = [];
  list.forEach((c, i) => {
    const d = dur(c), gap = c.gap || 0;
    let s = gap, od = 0, eb = 0, h = 0;
    if (i > 0) {
      const p = out[i - 1];
      h = c.trans && gap === 0 ? Math.min(c.trans.d, 0.45 * dur(p.c), 0.45 * d) : 0;
      if (h < 0.05) h = 0;
      if (h) {
        // centered transition: it straddles the cut, borrowing footage past A's end and before B's start
        const hA = canExtend(p.c) ? Math.max(0, (p.c.srcDur - p.c.out) / spd(p.c)) : 0;
        const hB = canExtend(c) ? Math.max(0, c.in / spd(c)) : 0;
        let ea = Math.min(h / 2, hA); eb = Math.min(h - ea, hB); ea = Math.min(h - eb, hA);
        p.ea = ea; od = h - ea - eb; // od = whatever the footage could not cover (the timeline shortens by that)
      }
      s = p.end - od + gap;
    }
    out.push({ c, start: s, end: s + d, od, h, eb, ea: 0 });
  });
  return out;
}
const lay = () => layOf(S.clips);
const total = () => { const L = lay(); return L.length ? L[L.length - 1].end : 0; };
function clipAt(t) { // returns {} while the playhead is in a gap
  const L = lay();
  for (let i = L.length - 1; i >= 0; i--) {
    if (t >= L[i].start - L[i].eb) return t < L[i].end || i === L.length - 1 ? { c: L[i].c, start: L[i].start } : {};
  }
  return {};
}
const startOf = (c) => (c.start !== undefined ? c.start : (lay().find((e) => e.c === c) || { start: 0 }).start);

/* ---------- animated values, fades, color ---------- */
const DEF = { scale: 1, rot: 0, px: 0, py: 0, opacity: 1 };
const anim = (c, k) => c.kf && c.kf[k] && c.kf[k].length;
function valAt(c, k, tr) {
  const p = c.kf && c.kf[k];
  if (p && p.length) {
    if (tr <= p[0][0]) return p[0][1];
    for (let i = 1; i < p.length; i++) if (tr <= p[i][0]) { const [t0, v0] = p[i - 1], [t1, v1] = p[i]; return t1 > t0 ? v0 + (v1 - v0) * (tr - t0) / (t1 - t0) : v1; }
    return p[p.length - 1][1];
  }
  return c[k] ?? DEF[k];
}
function setKf(c, k, t, v) {
  c.kf = c.kf || {}; const p = c.kf[k] = c.kf[k] || [];
  const e = p.find((q) => Math.abs(q[0] - t) < 0.04);
  if (e) e[1] = v; else p.push([+t.toFixed(2), v]);
  p.sort((a, b) => a[0] - b[0]);
}
const shiftKf = (c, off) => { if (!c.kf) return; c.kf = JSON.parse(JSON.stringify(c.kf)); for (const k in c.kf) c.kf[k].forEach((q) => { q[0] = +(q[0] - off).toFixed(2); }); };
function cssT(c, tr) {
  const s = valAt(c, 'scale', tr);
  return `translate(${valAt(c, 'px', tr) * 100}%,${valAt(c, 'py', tr) * 100}%) rotate(${valAt(c, 'rot', tr)}deg) scale(${s * (c.flipH ? -1 : 1)},${s * (c.flipV ? -1 : 1)})`;
}
function fadeF(c, tr) {
  const d = dur(c); let f = 1;
  if (c.fadeIn > 0) f = Math.min(f, tr / c.fadeIn);
  if (c.fadeOut > 0) f = Math.min(f, (d - tr) / c.fadeOut);
  return clamp(f, 0, 1);
}
const PRESETS = {
  bw: 'grayscale(1)', sepia: 'sepia(1)', warm: 'sepia(.35) saturate(1.2)', cool: 'hue-rotate(12deg) saturate(1.1)',
  vivid: 'saturate(1.6) contrast(1.1)', faded: 'contrast(.85) brightness(1.1) saturate(.8)'
};
const cssFilter = (c) => `${PRESETS[c.filter] || ''} brightness(${1 + (c.br || 0)}) contrast(${c.co ?? 1}) saturate(${c.sa ?? 1})`;

/* ---------- history ---------- */
function snap() { return JSON.stringify({ c: S.clips, o: S.overlays, a: S.audios, t: S.texts }); }
function push() { undoS.push(snap()); if (undoS.length > 60) undoS.shift(); redoS.length = 0; }
function restore(s) { const o = JSON.parse(s); S.clips = o.c; S.overlays = o.o || []; S.audios = o.a || []; S.texts = o.t; if (!find(S.sel)) S.sel = null; for (const id of [...S.multi]) if (!find(id)) S.multi.delete(id); seek(S.t); render(); }
function undo() { if (!undoS.length) return; redoS.push(snap()); restore(undoS.pop()); }
function redo() { if (!redoS.length) return; undoS.push(snap()); restore(redoS.pop()); }

/* ---------- media import ---------- */
const AUDIO_RE = /\.(mp3|wav|m4a|aac|ogg|flac|opus)$/i, MEDIA_RE = /\.(mp4|mov|mkv|webm|avi|m4v|jpe?g|png|webp|mp3|wav|m4a|aac|ogg|flac|opus)$/i;
function probe(path) {
  return new Promise((resolve) => {
    const th = document.createElement('canvas'); th.width = 160; th.height = 90;
    if (AUDIO_RE.test(path)) {
      const a = new Audio(); a.preload = 'metadata';
      a.onloadedmetadata = () => {
        const x = th.getContext('2d'); x.fillStyle = '#1f5f3f'; x.fillRect(0, 0, 160, 90); x.fillStyle = '#7dffb5'; [10, 24, 40, 28, 48, 30, 16, 36, 22, 12].forEach((h, i) => x.fillRect(22 + i * 12, 45 - h / 2, 7, h));
        resolve({ kind: 'audio', srcDur: a.duration, thumb: th.toDataURL('image/png') });
      };
      a.onerror = () => resolve(null);
      a.src = url(path); return;
    }
    if (/\.(jpe?g|png|webp)$/i.test(path)) {
      const im = new Image();
      im.onload = () => { th.getContext('2d').drawImage(im, 0, 0, 160, 90); resolve({ kind: 'image', srcDur: 5, thumb: th.toDataURL('image/jpeg', .7) }); };
      im.onerror = () => resolve(null);
      im.src = url(path); return;
    }
    const v = document.createElement('video'); v.muted = true; v.preload = 'auto';
    v.onloadedmetadata = () => { v.currentTime = Math.min(0.5, v.duration / 2); };
    v.onseeked = () => { th.getContext('2d').drawImage(v, 0, 0, 160, 90); resolve({ kind: 'video', srcDur: v.duration, thumb: th.toDataURL('image/jpeg', .7) }); v.removeAttribute('src'); };
    v.onerror = () => resolve(null);
    v.src = url(path);
  });
}
async function addFiles(paths) {
  for (const p of paths) {
    if (S.media.some((m) => m.path === p)) continue;
    const info = await probe(p);
    if (!info) { alert('Cannot read ' + p); continue; }
    S.media.push({ id: uid++, path: p, name: p.split(/[\\/]/).pop(), ...info });
  }
  renderBin();
}
const newItem = (m) => ({ id: uid++, path: m.path, name: m.name, kind: m.kind, in: 0, out: m.kind === 'image' ? 5 : m.srcDur, vol: 1, speed: 1, srcDur: m.kind === 'image' ? 600 : m.srcDur, thumb: m.thumb });
function addToTimeline(m, at = S.clips.length) {
  if (m.kind === 'audio') return addAudio(m, S.t);
  push();
  const c = newItem(m);
  S.clips.splice(at, 0, c); S.sel = c.id;
  seek(S.t); render();
}
function addOverlay(m, start, lane) { // lane 'v2' = the full-frame Video 2 track; otherwise the small picture-in-picture overlay
  if (m.kind === 'audio') return addAudio(m, start);
  push();
  const full = lane === 'v2';
  const o = { ...newItem(m), start: Math.max(0, start), lane: full ? 'v2' : undefined, scale: full ? 1 : 0.4, px: full ? 0 : 0.28, py: full ? 0 : -0.28 };
  S.overlays.push(o); S.sel = o.id;
  seek(S.t); render();
}
function addAudio(m, start) {
  push();
  const a = { ...newItem(m), start: Math.max(0, start) };
  S.audios.push(a); S.sel = a.id;
  seek(S.t); render();
}
const timeAt = (clientX) => (clientX - $('tlInner').getBoundingClientRect().left - 52) / S.pps;
function insertIndexAt(clientX) {
  const px = timeAt(clientX), L = lay();
  for (let i = 0; i < L.length; i++) if (px < L[i].start + dur(L[i].c) / 2) return i;
  return L.length;
}
$('tl').addEventListener('dragover', (e) => {
  if (![...e.dataTransfer.types].includes('text/qc-media')) return;
  e.preventDefault(); e.dataTransfer.dropEffect = 'copy';
});
$('tl').addEventListener('drop', (e) => {
  const id = e.dataTransfer.getData('text/qc-media');
  if (!id) return;
  e.preventDefault(); e.stopPropagation();
  const m = S.media.find((x) => x.id === +id);
  if (!m) return;
  if (m.kind === 'audio') addAudio(m, timeAt(e.clientX));
  else if (e.target.closest('#trackV2')) addOverlay(m, timeAt(e.clientX), 'v2');
  else if (e.target.closest('#trackO')) addOverlay(m, timeAt(e.clientX));
  else addToTimeline(m, insertIndexAt(e.clientX));
});
function renderBin() {
  const el = $('binList');
  if (!S.media.length) { el.innerHTML = '<div class="hint">Import or drop video, image or audio files here</div>'; return; }
  el.innerHTML = '';
  S.media.forEach((m) => {
    const d = document.createElement('div'); d.className = 'media';
    d.title = 'Drag to a track. Double-click: add to timeline. Right-click: add as overlay.';
    d.innerHTML = `<div class="th" style="background-image:url(${m.thumb})"></div><div class="nm"></div><div class="du">${m.kind === 'image' ? 'Image' : fmt(m.srcDur)}</div>`;
    d.querySelector('.nm').textContent = m.name;
    d.ondblclick = () => addToTimeline(m);
    d.oncontextmenu = (e) => { e.preventDefault(); addOverlay(m, S.t); };
    d.draggable = true;
    d.ondragstart = (e) => { e.dataTransfer.setData('text/qc-media', String(m.id)); e.dataTransfer.effectAllowed = 'copy'; };
    el.appendChild(d);
  });
}

/* ---------- chroma key preview ---------- */
const ckCan = new Map(), ckAct = new Map(); let ckRaf = 0;
function ckCanvas(key) {
  let cv = ckCan.get(key);
  if (!cv) {
    cv = document.createElement('canvas'); cv.className = 'ovm'; cv.style.display = 'none';
    if (key === 'main') stage.insertBefore(cv, ovMedia); else ovMedia.appendChild(cv);
    ckCan.set(key, cv);
  }
  return cv;
}
function ckOn(key, src, c) {
  const cv = ckCanvas(key); cv.style.display = 'block'; src.style.visibility = 'hidden';
  const a = ckAct.get(key);
  ckAct.set(key, { src, c, sig: a && a.src === src ? a.sig : '' });
  ckStart();
}
function ckOff(key) { ckAct.delete(key); const cv = ckCan.get(key); if (cv) cv.style.display = 'none'; }
function ckStart() {
  if (ckRaf) return;
  const run = () => {
    if (!ckAct.size) { ckRaf = 0; return; }
    for (const [k, a] of ckAct) {
      const s = a.src, w = s.videoWidth || s.naturalWidth, h = s.videoHeight || s.naturalHeight;
      if (!w) continue;
      const sig = `${s.currentTime}|${a.c.ckColor}|${a.c.ckSim}|${a.c.ckBlend}|${w}`;
      if (sig !== a.sig) { a.sig = sig; ckDraw(ckCanvas(k), s, a.c, w, h); }
    }
    ckRaf = requestAnimationFrame(run);
  };
  ckRaf = requestAnimationFrame(run);
}
function ckDraw(cv, s, c, w, h) {
  const sc = Math.min(1, 960 / w), cw = Math.max(2, Math.round(w * sc)), ch = Math.max(2, Math.round(h * sc));
  if (cv.width !== cw || cv.height !== ch) { cv.width = cw; cv.height = ch; }
  const x = cv.getContext('2d', { willReadFrequently: true });
  x.drawImage(s, 0, 0, cw, ch);
  const im = x.getImageData(0, 0, cw, ch), d = im.data, hex = c.ckColor || '#00ff00';
  const kr = parseInt(hex.slice(1, 3), 16), kg = parseInt(hex.slice(3, 5), 16), kb = parseInt(hex.slice(5, 7), 16);
  const ku = 128 - 0.169 * kr - 0.331 * kg + 0.5 * kb, kv = 128 + 0.5 * kr - 0.419 * kg - 0.081 * kb;
  const sim = c.ckSim ?? 0.3, bl = c.ckBlend ?? 0.1;
  for (let i = 0; i < d.length; i += 4) {
    const r = d[i], g = d[i + 1], b = d[i + 2];
    const du = 128 - 0.169 * r - 0.331 * g + 0.5 * b - ku, dv = 128 + 0.5 * r - 0.419 * g - 0.081 * b - kv;
    const diff = Math.sqrt((du * du + dv * dv) / 65025);
    d[i + 3] = bl > 1e-4 ? clamp((diff - sim) / bl, 0, 1) * 255 : diff > sim ? 255 : 0;
  }
  x.putImageData(im, 0, 0);
}

/* ---------- preview ---------- */
function ovEl(o) {
  let e = ovEls.get(o.id);
  if (!e) {
    e = document.createElement(o.kind === 'image' ? 'img' : 'video');
    e.className = 'ovm'; if (o.kind === 'video') e.playsInline = true;
    e.src = url(o.path); ovMedia.appendChild(e); ovEls.set(o.id, e);
  }
  return e;
}
function syncOvl(t, hard) {
  const ids = new Set(S.overlays.map((o) => o.id));
  for (const [id, e] of ovEls) if (!ids.has(id)) { e.remove(); ovEls.delete(id); ckOff(id); const cv = ckCan.get(id); if (cv) { cv.remove(); ckCan.delete(id); } }
  for (const o of S.overlays) {
    const e = ovEl(o), tr = t - o.start, on = tr >= 0 && tr < dur(o);
    if (!on) { e.style.display = 'none'; ckOff(o.id); if (e.pause) e.pause(); continue; }
    e.style.display = 'block'; e.style.visibility = 'visible';
    if (o.ck) ckOn(o.id, e, o); else ckOff(o.id);
    const tgt = o.ck ? ckCanvas(o.id) : e, f = fadeF(o, tr);
    e.style.zIndex = tgt.style.zIndex = o.lane === 'v2' ? 1 : 2; // Video 2 sits above the main track, under the overlays
    tgt.style.transform = cssT(o, tr); tgt.style.opacity = valAt(o, 'opacity', tr) * f; tgt.style.filter = cssFilter(o);
    if (o.kind !== 'video') continue;
    e.volume = clamp((o.vol ?? 1) * f * S.master, 0, 1); e.playbackRate = clamp(spd(o), 0.0625, 16);
    const want = o.freeze ? o.in : o.rev ? o.out - tr * spd(o) : o.in + tr * spd(o);
    const off = Math.abs(e.currentTime - want);
    if (hard || !S.playing || (o.freeze || o.rev ? off > 0.03 : off > 0.2)) e.currentTime = want;
    if (S.playing && !o.freeze && !o.rev) { if (e.paused) e.play().catch(() => {}); } else e.pause();
  }
}
function syncAud(t, hard) {
  const ids = new Set(S.audios.map((a) => a.id));
  for (const [id, e] of audEls) if (!ids.has(id)) { e.pause(); audEls.delete(id); }
  for (const a of S.audios) {
    let e = audEls.get(a.id);
    if (!e) { e = new Audio(url(a.path)); e.preload = 'auto'; audEls.set(a.id, e); }
    const tr = t - a.start;
    if (!(tr >= 0 && tr < dur(a))) { e.pause(); continue; }
    e.volume = clamp((a.vol ?? 1) * fadeF(a, tr) * S.master, 0, 1); e.playbackRate = clamp(spd(a), 0.0625, 16);
    const want = a.in + tr * spd(a);
    if (hard || !S.playing || Math.abs(e.currentTime - want) > 0.2) e.currentTime = want;
    if (S.playing) { if (e.paused) e.play().catch(() => {}); } else e.pause();
  }
}
/* transition preview: while two clips overlap, the outgoing one plays in vid2 underneath */
const vid2 = $('vid2'); let curPath2 = null;
function transState(t) {
  const L = lay();
  for (let i = 1; i < L.length; i++) {
    const e = L[i];
    const ts = e.start - e.eb;
    if (e.h > 0 && t >= ts && t < ts + e.h) return { p: (t - ts) / e.h, A: L[i - 1], B: e };
  }
  return null;
}
function transFx(type, p) {
  const q = 1 - p, fx = { aO: 1, bO: 1, aT: '', bT: '', aClip: '', bClip: '', bg: '', aV: q, bV: p };
  const dip = (bg) => { fx.aO = clamp(1 - 2 * p, 0, 1); fx.bO = clamp(2 * p - 1, 0, 1); fx.bg = bg; };
  switch (type) {
    case 'fadeblack': dip('#000'); break;
    case 'fadewhite': dip('#fff'); break;
    case 'fadegrays': dip('#808080'); break;
    case 'wipeleft': case 'smoothleft': fx.bClip = `inset(0 0 0 ${q * 100}%)`; break;
    case 'wiperight': case 'smoothright': fx.bClip = `inset(0 ${q * 100}% 0 0)`; break;
    case 'wipeup': case 'smoothup': fx.bClip = `inset(${q * 100}% 0 0 0)`; break;
    case 'wipedown': case 'smoothdown': fx.bClip = `inset(0 0 ${q * 100}% 0)`; break;
    case 'slideleft': fx.bT = `translateX(${q * 100}%)`; fx.aT = `translateX(${-p * 100}%)`; break;
    case 'slideright': fx.bT = `translateX(${-q * 100}%)`; fx.aT = `translateX(${p * 100}%)`; break;
    case 'slideup': fx.bT = `translateY(${q * 100}%)`; fx.aT = `translateY(${-p * 100}%)`; break;
    case 'slidedown': fx.bT = `translateY(${-q * 100}%)`; fx.aT = `translateY(${p * 100}%)`; break;
    case 'circleopen': case 'circlecrop': fx.bClip = `circle(${p * 75}% at 50% 50%)`; break;
    case 'circleclose': fx.aClip = `circle(${q * 75}% at 50% 50%)`; break;
    case 'rectcrop': fx.bClip = `inset(${q * 50}%)`; break;
    case 'vertopen': fx.bClip = `inset(0 ${q * 50}%)`; break;
    case 'horzopen': fx.bClip = `inset(${q * 50}% 0)`; break;
    case 'wipetl': case 'diagtl': fx.bClip = `polygon(0 0, ${p * 200}% 0, 0 ${p * 200}%)`; break;
    case 'wipebr': case 'diagbr': fx.bClip = `polygon(100% 100%, ${100 - p * 200}% 100%, 100% ${100 - p * 200}%)`; break;
    default: fx.bO = p; // dissolve-style effects preview as a crossfade
  }
  return fx;
}
function syncTrans(t, hard) {
  const st = transState(t);
  if (!st) { vid2.style.display = 'none'; vid2.pause(); return; }
  const A = st.A.c, fx = transFx(st.B.c.trans.type, st.p);
  if (A.kind !== 'video' || A.freeze || A.rev) { vid2.style.display = 'none'; vid2.pause(); return; }
  const tr = t - st.A.start;
  vid2.style.display = 'block';
  if (curPath2 !== A.path) { vid2.src = url(A.path); curPath2 = A.path; }
  vid2.playbackRate = clamp(spd(A), 0.0625, 16); vid2.volume = clamp((A.vol ?? 1) * fadeF(A, tr) * fx.aV * S.master, 0, 1);
  const want = A.in + tr * spd(A);
  if (hard || !S.playing || Math.abs(vid2.currentTime - want) > 0.2) vid2.currentTime = want;
  if (S.playing) { if (vid2.paused) vid2.play().catch(() => {}); } else vid2.pause();
  vid2.style.transform = `${fx.aT} ${cssT(A, tr)}`; vid2.style.opacity = valAt(A, 'opacity', tr) * fx.aO;
  vid2.style.filter = cssFilter(A); vid2.style.clipPath = fx.aClip;
}
function applyMain(t) {
  vid.style.clipPath = img.style.clipPath = ''; stage.style.background = '';
  const { c, start } = clipAt(t);
  if (!c) { vid2.style.display = 'none'; vid2.pause(); return; }
  const tr = t - start, f = fadeF(c, tr), st = transState(t);
  const fx = st && st.B.c === c ? transFx(c.trans.type, st.p) : null;
  const el = c.ck ? ckCan.get('main') : (c.kind === 'image' ? img : vid);
  if (el) {
    el.style.transform = `${fx ? fx.bT : ''} ${cssT(c, tr)}`; el.style.opacity = valAt(c, 'opacity', tr) * f * (fx ? fx.bO : 1);
    el.style.filter = cssFilter(c); el.style.clipPath = fx ? fx.bClip : '';
  }
  if (fx) stage.style.background = fx.bg;
  if (c.kind === 'video') vid.volume = clamp((c.vol ?? 1) * f * S.master * (fx ? fx.bV : 1), 0, 1);
  if (c.kind === 'video' && c.rev && !c.freeze) { // reversed clips are stepped backwards frame by frame (no sound in preview)
    const want = c.out - tr * spd(c);
    if (Math.abs(vid.currentTime - want) > 0.03) vid.currentTime = want;
  }
  syncTrans(t, !S.playing);
}
function showAt(t) {
  syncOvl(t, !S.playing); syncAud(t, !S.playing);
  const { c, start } = clipAt(t);
  vid.style.visibility = img.style.visibility = 'visible'; ckOff('main');
  if (c && c.ck) ckOn('main', c.kind === 'image' ? img : vid, c);
  if (!c) { vid.style.display = img.style.display = 'none'; vid.pause(); }
  else if (c.kind === 'image') {
    vid.pause(); vid.style.display = 'none'; img.style.display = 'block';
    if (curPath !== c.path) { img.src = url(c.path); curPath = c.path; }
  } else {
    img.style.display = 'none'; vid.style.display = 'block';
    if (curPath !== c.path) { vid.src = url(c.path); curPath = c.path; }
    vid.playbackRate = clamp(spd(c), 0.0625, 16);
    const want = c.freeze ? c.in : c.rev ? c.out - (t - start) * spd(c) : c.in + (t - start) * spd(c);
    if (Math.abs(vid.currentTime - want) > 0.05 || !S.playing || c.freeze || c.rev) vid.currentTime = want;
    if (S.playing && !c.freeze && !c.rev) { if (vid.paused) vid.play().catch(() => {}); } else vid.pause();
  }
  applyMain(t);
  updateOverlay(t);
}
const FONT_NAMES = ['Arial', 'Impact', 'Times New Roman', 'Verdana', 'Georgia', 'Courier New', 'Comic Sans MS', 'Trebuchet MS', 'Segoe UI'];
const TEXT_STYLES = {
  plain: { label: 'Plain', font: 'Arial', color: '#ffffff', size: 56 },
  impact: { label: 'Bold outline', font: 'Impact', color: '#ffffff', ow: 4, oc: '#000000', size: 72 },
  subtitle: { label: 'Subtitle', font: 'Arial', bold: true, color: '#ffffff', box: true, size: 44 },
  shadow: { label: 'Elegant shadow', font: 'Georgia', bold: true, color: '#ffffff', sh: true, size: 64 },
  retro: { label: 'Retro', font: 'Courier New', bold: true, color: '#ffe600', ow: 2, oc: '#ff2d7a', sh: true, size: 56 },
  comic: { label: 'Playful', font: 'Comic Sans MS', bold: true, color: '#ffffff', ow: 3, oc: '#2b6cff', size: 60 }
};
const TEXT_DIR = { slideup: [0, -1], slidedown: [0, 1], slideleft: [-1, 0], slideright: [1, 0] };
const TEXT_ANIMS = [['', 'None'], ['fade', 'Fade'], ['slideup', 'Slide up'], ['slidedown', 'Slide down'], ['slideleft', 'Slide left'], ['slideright', 'Slide right']];
const PRESET_Y = { top: 0.1, center: 0.5, bottom: 0.88 };
const txy = (x) => ({ x: x.x ?? 0.5, y: x.y ?? PRESET_Y[x.pos] ?? 0.88 });
function updateOverlay(t) {
  const h = stage.clientHeight, vis = S.texts.filter((x) => t >= x.start && t <= x.end);
  overlay.innerHTML = '';
  vis.forEach((x) => {
    const d = document.createElement('div');
    d.className = 'ov' + (x.box ? ' box' : '');
    d.textContent = x.text; d.style.color = x.color; d.style.fontSize = (x.size * h / 720) + 'px';
    d.style.fontFamily = `"${x.font || 'Arial'}", Arial, sans-serif`; d.style.fontWeight = x.bold ? '700' : '400'; d.style.fontStyle = x.italic ? 'italic' : 'normal';
    if (x.ow > 0) { d.style.webkitTextStroke = `${2 * x.ow * h / 720}px ${x.oc || '#000'}`; d.style.paintOrder = 'stroke fill'; }
    if (x.sh) d.style.textShadow = `${3 * h / 720}px ${3 * h / 720}px ${2 * h / 720}px rgba(0,0,0,.6)`;
    { // in / out animation: fade and slide
      const ad = x.animDur || 0.4, pin = x.animIn ? clamp((t - x.start) / ad, 0, 1) : 1, pout = x.animOut ? clamp((x.end - t) / ad, 0, 1) : 1;
      const dist = 80 * h / 720; let ox = 0, oy = 0, op = 1;
      if (x.animIn === 'fade') op *= pin; else if (TEXT_DIR[x.animIn]) { ox -= TEXT_DIR[x.animIn][0] * (1 - pin) * dist; oy -= TEXT_DIR[x.animIn][1] * (1 - pin) * dist; }
      if (x.animOut === 'fade') op *= pout; else if (TEXT_DIR[x.animOut]) { ox += TEXT_DIR[x.animOut][0] * (1 - pout) * dist; oy += TEXT_DIR[x.animOut][1] * (1 - pout) * dist; }
      d.style.opacity = op; d.style.transform = `translate(calc(-50% + ${ox}px), calc(-50% + ${oy}px))`;
    }
    d.style.left = (txy(x).x * 100) + '%'; d.style.top = (txy(x).y * 100) + '%';
    if (S.sel === x.id) d.style.outline = '1px dashed #00d1c1';
    d.onpointerdown = (e) => {
      e.preventDefault(); S.sel = x.id; pause(); renderInspector();
      const r = stage.getBoundingClientRect(); let first = true;
      drag(e, (_dx, ev) => {
        if (first) { push(); first = false; }
        x.x = clamp((ev.clientX - r.left) / r.width, 0, 1); x.y = clamp((ev.clientY - r.top) / r.height, 0, 1);
        updateOverlay(S.t);
      }, () => render());
    };
    overlay.appendChild(d);
  });
}
function seek(t) {
  S.t = clamp(t, 0, Math.max(0, total()));
  showAt(S.t); updateHead();
}
function updateHead() {
  $('playhead').style.left = (52 + S.t * S.pps) + 'px';
  $('timeLbl').textContent = fmt(S.t) + ' / ' + fmt(total());
  refreshKfUI();
}
function play() {
  if (!S.clips.length) return;
  if (S.t >= total() - 0.05) S.t = 0;
  S.playing = true; $('playBtn').innerHTML = IC_PAUSE; last = performance.now(); showAt(S.t);
  raf = requestAnimationFrame(tick);
}
function pause() {
  S.playing = false; $('playBtn').innerHTML = IC_PLAY; vid.pause(); vid2.pause(); cancelAnimationFrame(raf);
  ovEls.forEach((e) => e.pause && e.pause()); audEls.forEach((e) => e.pause());
}
function tick(now) {
  if (!S.playing) return;
  const { c, start } = clipAt(S.t);
  if (!S.clips.length) { pause(); return; }
  let t;
  if (!c) t = S.t + (now - last) / 1000; // inside a gap: just let time run
  else if (c.kind === 'video' && !c.freeze && !c.rev) {
    t = start + (vid.currentTime - c.in) / spd(c);
    if (vid.currentTime >= c.out - 0.03 || vid.ended) t = start + dur(c) + 1e-4;
  } else t = S.t + (now - last) / 1000;
  last = now;
  if (t >= total()) { S.t = total(); pause(); showAt(Math.max(0, total() - 1e-3)); updateHead(); return; }
  const changed = clipAt(t).c !== c;
  S.t = t;
  if (changed) showAt(t); else { updateOverlay(t); syncOvl(t, false); syncAud(t, false); applyMain(t); }
  updateHead();
  raf = requestAnimationFrame(tick);
}
function fitStage() {
  const [a, b] = S.aspect.split(':').map(Number), w = $('stageWrap');
  const mw = w.clientWidth - 24, mh = w.clientHeight - 24;
  let W = mw, H = W * b / a;
  if (H > mh) { H = mh; W = H * a / b; }
  stage.style.width = W + 'px'; stage.style.height = H + 'px';
  updateOverlay(S.t);
}

/* ---------- waveforms ---------- */
const WPS = 50; // peaks per second of source audio
const waves = new Map(); // path -> Float32Array of peaks, or 'pending' / 'none'
function getPeaks(item, done) {
  const w = waves.get(item.path);
  if (w && w !== 'pending') return w === 'none' ? null : w;
  if (!w) {
    waves.set(item.path, 'pending');
    api.extractAudio({ path: item.path, from: 0, len: item.srcDur || 3600 }).then((buf) => {
      if (buf.byteLength < 4000) { waves.set(item.path, 'none'); return; }
      const f = new Float32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength - (buf.byteLength % 4)));
      const win = 16000 / WPS, n = Math.ceil(f.length / win), p = new Float32Array(n);
      for (let i = 0; i < n; i++) { let m = 0; for (let j = i * win, e = Math.min(f.length, j + win); j < e; j++) { const v = Math.abs(f[j]); if (v > m) m = v; } p[i] = m; }
      let top = 0; for (const v of p) if (v > top) top = v;
      if (top > 0) for (let i = 0; i < n; i++) p[i] = Math.min(1, p[i] / top * 1.1);
      waves.set(item.path, p); render(true);
    }).catch(() => waves.set(item.path, 'none'));
  }
  return null;
}
function addWave(d, item, width) {
  const p = getPeaks(item); if (!p) return;
  const W = Math.max(1, Math.min(8000, Math.round(width * S.pps))), H = 40;
  const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
  cv.style.cssText = 'position:absolute;left:0;right:0;bottom:0;width:100%;height:55%;z-index:1;pointer-events:none';
  const g = cv.getContext('2d'); g.fillStyle = 'rgba(255,255,255,.55)';
  const sp = spd(item), len = item.out - item.in;
  for (let x = 0; x < W; x++) {
    const f0 = x / W, f1 = (x + 1) / W;
    let a = item.rev ? item.out - f1 * len : item.in + f0 * len, b = item.rev ? item.out - f0 * len : item.in + f1 * len;
    let i0 = Math.floor(a * WPS), i1 = Math.max(i0, Math.floor(b * WPS)), m = 0;
    for (let i = i0; i <= i1 && i < p.length; i++) if (p[i] > m) m = p[i];
    const h = Math.max(1, m * H); g.fillRect(x, (H - h) / 2, 1, h);
  }
  d.appendChild(cv);
}

/* ---------- timeline ---------- */
function block(cls, item, left, width, label) {
  const d = document.createElement('div'); d.className = cls + (S.sel === item.id || S.multi.has(item.id) ? ' sel' : ''); d.dataset.id = item.id;
  d.style.left = (52 + left * S.pps) + 'px'; d.style.width = (width * S.pps) + 'px';
  if (item.thumb && item.kind !== 'audio') d.style.backgroundImage = `url(${item.thumb})`;
  d.innerHTML = '<div class="h l"></div><div class="n"></div><div class="h r"></div>';
  d.querySelector('.n').textContent = label;
  if (item.path && !item.freeze && (item.kind === 'audio' || item.kind === 'video')) addWave(d, item, width);
  if (item.kf) {
    const ts = new Set(); Object.values(item.kf).forEach((p) => p.forEach((q) => ts.add(q[0])));
    ts.forEach((tt) => { const m = document.createElement('i'); m.className = 'kfm'; m.style.left = (tt * S.pps) + 'px'; d.appendChild(m); });
  }
  return d;
}
const clipLabel = (c) => (c.freeze ? 'Freeze frame' : c.name + (spd(c) !== 1 ? `  ${spd(c).toFixed(2)}x` : '')) + (c.trans ? '  [transition]' : '');
function render(noIns) {
  if (S.multi.size && !S.multi.has(S.sel)) S.multi.clear(); // a new single selection ends the group
  const tl = $('tlInner'), len = Math.max(total(), 10) + 10;
  tl.style.width = (52 + len * S.pps) + 'px';
  const r = $('ruler'); r.innerHTML = '';
  const step = S.pps >= 100 ? 1 : S.pps >= 40 ? 5 : 10;
  for (let s = 0; s <= len; s += step) {
    const k = document.createElement('div'); k.className = 'tick'; k.style.left = (52 + s * S.pps) + 'px'; k.textContent = fmt(s).slice(0, 5); r.appendChild(k);
  }
  const fill = (id, items) => { const t = $(id); t.querySelectorAll('.clip,.tb,.junc').forEach((n) => n.remove()); items.forEach((n) => t.appendChild(n)); };
  fill('trackV', lay().map(({ c, start }) => block('clip' + (c.freeze ? ' frz' : ''), c, start, dur(c), clipLabel(c))));
  lay().forEach(({ c, start, od }, i) => { // sparkle button between connected clips
    if (i === 0 || c.gap > 0) return;
    const b = document.createElement('button');
    b.className = 'junc' + (c.trans ? ' on' : ''); b.dataset.id = c.id; b.title = 'Transition';
    b.innerHTML = '<svg class="ic" viewBox="0 0 24 24"><path d="M12 2l2.2 7.8L22 12l-7.8 2.2L12 22l-2.2-7.8L2 12l7.8-2.2z"/></svg>';
    b.style.left = (52 + (start + od / 2) * S.pps) + 'px';
    $('trackV').appendChild(b);
  });
  fill('trackV2', S.overlays.filter((o) => o.lane === 'v2').map((o) => block('clip ovl v2' + (o.freeze ? ' frz' : ''), o, o.start, dur(o), clipLabel(o))));
  fill('trackO', S.overlays.filter((o) => o.lane !== 'v2').map((o) => block('clip ovl' + (o.freeze ? ' frz' : ''), o, o.start, dur(o), clipLabel(o))));
  fill('trackA', S.audios.map((a) => block('clip aud', a, a.start, dur(a), a.name)));
  fill('trackT', S.texts.map((x) => block('tb', x, x.start, x.end - x.start, x.text)));
  updateHead(); if (!noIns) renderInspector();
}

function drag(e, onMove, onDone) {
  const x0 = e.clientX; let moved = false;
  const mv = (ev) => { const dx = ev.clientX - x0; if (Math.abs(dx) > 2) moved = true; if (moved) onMove(dx, ev); };
  const up = (ev) => { removeEventListener('pointermove', mv); removeEventListener('pointerup', up); onDone && onDone(moved, ev); };
  addEventListener('pointermove', mv); addEventListener('pointerup', up);
}

/* drag a box on empty timeline space to select blocks */
function startMarquee(e, go) {
  const inner = $('tlInner'), r0 = inner.getBoundingClientRect(), x0 = e.clientX, y0 = e.clientY;
  const box = document.createElement('div'); box.id = 'marquee'; inner.appendChild(box);
  const base = e.shiftKey ? new Set(S.multi.size ? S.multi : (S.sel ? [S.sel] : [])) : new Set();
  let ids = base;
  const pick = (ev) => {
    const x1 = Math.min(x0, ev.clientX), x2 = Math.max(x0, ev.clientX), y1 = Math.min(y0, ev.clientY), y2 = Math.max(y0, ev.clientY);
    box.style.left = (x1 - r0.left) + 'px'; box.style.top = (y1 - r0.top) + 'px'; box.style.width = (x2 - x1) + 'px'; box.style.height = (y2 - y1) + 'px';
    const out = new Set(base);
    inner.querySelectorAll('.clip,.tb').forEach((n) => {
      const b = n.getBoundingClientRect(), hit = b.right > x1 && b.left < x2 && b.bottom > y1 && b.top < y2;
      if (hit) out.add(+n.dataset.id);
      n.classList.toggle('sel', out.has(+n.dataset.id));
    });
    return out;
  };
  drag(e, (_dx, ev) => { ids = pick(ev); }, (moved) => {
    box.remove();
    if (!moved) { go(e); return; }
    if (ids.size >= 2) { S.multi = ids; S.sel = [...ids][0]; }
    else { S.multi.clear(); S.sel = ids.size ? [...ids][0] : null; }
    render();
  });
}

/* snapping */
function snapPoints(ignore) {
  const pts = [0, S.t];
  lay().forEach(({ c, start, end }) => { if (c !== ignore) pts.push(start, end); });
  [...S.overlays, ...S.audios].forEach((o) => { if (o !== ignore) pts.push(o.start, o.start + dur(o)); });
  S.texts.forEach((x) => { if (x !== ignore) pts.push(x.start, x.end); });
  return pts;
}
function showSnap(x) {
  const g = $('snapLine');
  if (x == null) { g.style.display = 'none'; return; }
  g.style.display = 'block'; g.style.left = (52 + x * S.pps) + 'px';
}
const SNAP_PX = 60; // long range: blocks jump to a neighbor from up to 60px away (hold Alt to turn off)
function snapT(t, pts) {
  const th = SNAP_PX / S.pps; let best = t, bd = th;
  for (const p of pts) { const d = Math.abs(p - t); if (d < bd) { bd = d; best = p; } }
  showSnap(best !== t ? best : null);
  return best;
}
function snapBody(s, d, pts) { // snap either the start or the end of a block
  const th = SNAP_PX / S.pps; let best = s, bd = th, g = null;
  for (const p of pts) {
    const a = Math.abs(p - s), b = Math.abs(p - (s + d));
    if (a < bd) { bd = a; best = p; g = p; }
    if (b < bd) { bd = b; best = p - d; g = p; }
  }
  showSnap(g);
  return Math.max(0, best);
}

$('tlInner').addEventListener('pointerdown', (e) => {
  if (e.target.closest('.junc')) return;
  const el = e.target.closest('.clip,.tb');
  if (!el) {
    if (e.target.closest('.lbl')) return;
    const pts = snapPoints(null).filter((p) => p !== S.t);
    const go = (ev) => { pause(); seek(snapT(timeAt(ev.clientX), pts)); };
    if (e.target.closest('#ruler')) { go(e); drag(e, (_dx, ev) => go(ev), () => showSnap(null)); return; }
    startMarquee(e, go); // drag a box to select several blocks; a plain click moves the playhead
    return;
  }
  const item = find(+el.dataset.id), txt = isText(item), timed = S.overlays.includes(item) || isAudio(item);
  if (e.shiftKey || e.ctrlKey) { // add / remove from the selection
    if (!S.multi.size && S.sel) S.multi.add(S.sel);
    if (S.multi.has(item.id)) S.multi.delete(item.id); else S.multi.add(item.id);
    if (S.multi.size === 1) { S.sel = [...S.multi][0]; S.multi.clear(); } else S.sel = [...S.multi][0] ?? null;
    render(); return;
  }
  const inMulti = S.multi.has(item.id);
  if (!inMulti) { S.multi.clear(); S.sel = item.id; }
  pushOnce = false;
  const handle = e.target.classList.contains('h') ? (e.target.classList.contains('l') ? 'l' : 'r') : null;
  const base = { ...item }, sp = spd(item), t0 = startOf(item), bdur = txt ? item.end - item.start : dur(base), pts = e.altKey ? [] : snapPoints(item);
  let reorderTo = null, reorderGap = 0;
  drag(e, (dx) => {
    if (!pushOnce) { push(); pushOnce = true; }
    let dt = dx / S.pps;
    if (txt) {
      if (handle === 'l') item.start = clamp(snapT(base.start + dt, pts), 0, base.end - 0.2);
      else if (handle === 'r') item.end = Math.max(base.start + 0.2, snapT(base.end + dt, pts));
      else { item.start = snapBody(Math.max(0, base.start + dt), bdur, pts); item.end = item.start + bdur; }
    } else if (handle === 'l') {
      if (!item.freeze) {
        dt = snapT(Math.max(timed ? 0 : t0, t0 + dt), pts) - t0;
        if (item.rev) item.out = clamp(base.out - dt * sp, base.in + 0.1 * sp, item.srcDur);
        else item.in = clamp(base.in + dt * sp, 0, base.out - 0.1 * sp);
        if (timed) item.start = Math.max(0, base.start + (item.rev ? (base.out - item.out) : (item.in - base.in)) / sp);
      }
    } else if (handle === 'r') {
      dt = snapT(t0 + bdur + dt, pts) - (t0 + bdur);
      if (item.freeze) item.fd = Math.max(0.2, base.fd + dt);
      else if (item.kind === 'image') item.out = Math.max(base.in + 0.1, base.out + dt);
      else if (item.rev) item.in = clamp(base.in - dt * sp, 0, base.out - 0.1 * sp);
      else item.out = clamp(base.out + dt * sp, base.in + 0.1 * sp, item.srcDur);
    } else if (timed) item.start = snapBody(Math.max(0, base.start + dt), bdur, pts);
    else { // main clip: follows the cursor; drop it later to leave a gap, or next to a clip to close it
      el.style.transform = `translateX(${dx}px)`; el.style.zIndex = 10; el.style.opacity = 0.85; el.style.cursor = 'grabbing';
      const Lo = layOf(S.clips.filter((c) => c !== item)), center = t0 + bdur / 2 + dx / S.pps;
      let at = Lo.length;
      for (let i = 0; i < Lo.length; i++) if (center < Lo[i].start + dur(Lo[i].c) / 2) { at = i; break; }
      const prevEnd = at > 0 ? Lo[at - 1].end : 0;
      let gap = Math.max(0, snapT(Math.max(0, t0 + dx / S.pps), pts) - prevEnd);
      if (gap < 0.03) gap = 0;
      reorderTo = at; reorderGap = gap; showSnap(prevEnd + gap);
      return;
    }
    render(true);
  }, (moved) => {
    showSnap(null);
    if (!moved && inMulti) { S.multi.clear(); S.sel = item.id; }
    if (reorderTo != null) {
      const others = S.clips.filter((c) => c !== item);
      item.gap = reorderGap || undefined;
      others.splice(reorderTo, 0, item); S.clips = others;
    }
    render(); seek(S.t);
  });
});

/* ---------- editing ---------- */
function split() {
  const { c, start } = clipAt(S.t);
  if (!c || c.freeze) return;
  const off = S.t - start;
  if (off < 0.1 || off > dur(c) - 0.1) return;
  push();
  const b = { ...c, id: uid++, trans: undefined, fadeIn: 0, gap: undefined };
  shiftKf(b, off);
  if (c.rev) { const at = c.out - off * spd(c); c.in = at; b.out = at; } // reversed: the first part is the END of the source
  else { const at = c.in + off * spd(c); b.in = at; c.out = at; }
  c.fadeOut = 0;
  S.clips.splice(S.clips.indexOf(c) + 1, 0, b);
  S.sel = b.id; render();
}
function freeze() {
  const { c, start } = clipAt(S.t);
  if (!c || c.kind !== 'video' || c.freeze || c.rev) return;
  const off = S.t - start;
  if (off < 0.1 || off > dur(c) - 0.1) return;
  push();
  const at = c.in + off * spd(c);
  const b = { ...c, id: uid++, in: at, trans: undefined, fadeIn: 0, gap: undefined };
  shiftKf(b, off);
  const f = { ...c, id: uid++, in: at, out: at + 0.04, freeze: true, fd: 2, speed: 1, trans: undefined, fadeIn: 0, fadeOut: 0, kf: undefined, gap: undefined };
  c.out = at; c.fadeOut = 0;
  S.clips.splice(S.clips.indexOf(c) + 1, 0, f, b);
  S.sel = f.id; render(); seek(S.t);
}
function del() {
  const ids = new Set(S.multi.size ? S.multi : (S.sel ? [S.sel] : []));
  if (!ids.size) return;
  push();
  S.clips = S.clips.filter((c) => !ids.has(c.id));
  S.overlays = S.overlays.filter((c) => !ids.has(c.id));
  S.audios = S.audios.filter((c) => !ids.has(c.id));
  S.texts = S.texts.filter((t) => !ids.has(t.id));
  S.sel = null; S.multi.clear(); seek(S.t); render();
}
function addText() {
  push();
  const x = { id: uid++, text: 'Your text', start: S.t, end: S.t + 3, size: 56, color: '#ffffff', pos: 'bottom', x: 0.5, y: 0.88, box: false };
  S.texts.push(x); S.sel = x.id; render(); seek(S.t);
}

/* copy / paste */
let clipboard = null, clipType = null;
function copyItem() {
  const it = find(S.sel);
  if (!it) return;
  clipboard = JSON.stringify(it);
  clipType = isText(it) ? 'text' : S.overlays.includes(it) ? 'ov' : isAudio(it) ? 'aud' : 'clip';
}
function pasteItem() {
  if (!clipboard) return;
  push();
  const o = JSON.parse(clipboard);
  o.id = uid++;
  if (clipType === 'clip') {
    delete o.trans; delete o.gap;
    const at = lay().filter((e) => e.start < S.t - 1e-6).length;
    S.clips.splice(at, 0, o);
  } else if (clipType === 'text') {
    const d = o.end - o.start; o.start = S.t; o.end = S.t + d; S.texts.push(o);
  } else {
    o.start = S.t; (clipType === 'ov' ? S.overlays : S.audios).push(o);
  }
  S.sel = o.id; render(); seek(S.t);
}

/* ---------- transition picker (the sparkle between clips) ---------- */
let popFor = null;
function closeTransPop() { popFor = null; $('transPop').hidden = true; }
function openTransPop(id, anchor) {
  const c = find(id), pop = $('transPop');
  if (!c) return;
  popFor = id;
  let html = '<div class="tp-h">Transition</div><div class="tp-grid">';
  for (const [k, n] of TRANS) html += k === '--' ? `<div class="tp-g">${n}</div>` : `<button type="button" class="tp-b${k === ((c.trans && c.trans.type) || '') ? ' on' : ''}" data-k="${k}">${n}</button>`;
  html += `</div><div class="tp-len"><span>Length</span><input id="tpD" type="range" min="0.2" max="2" step="0.1" value="${(c.trans && c.trans.d) || 0.8}"><span id="tpV">${((c.trans && c.trans.d) || 0.8).toFixed(1)}s</span></div>`;
  pop.innerHTML = html;
  const r = anchor.getBoundingClientRect();
  pop.style.left = clamp(r.left - 150, 8, innerWidth - 328) + 'px';
  pop.style.bottom = (innerHeight - r.top + 8) + 'px';
  pop.hidden = false;
  const len = () => { $('tpD').parentElement.style.display = c.trans ? 'flex' : 'none'; };
  len();
  pop.querySelectorAll('.tp-b').forEach((b) => {
    b.onclick = () => {
      push();
      const d = +$('tpD').value;
      c.trans = b.dataset.k ? { type: b.dataset.k, d } : undefined;
      pop.querySelectorAll('.tp-b').forEach((x) => x.classList.toggle('on', x === b));
      len(); render(); seek(S.t);
    };
  });
  $('tpD').oninput = (e) => { if (!c.trans) return; if (!pushOnce) { push(); pushOnce = true; } c.trans.d = +e.target.value; $('tpV').textContent = c.trans.d.toFixed(1) + 's'; render(true); };
  $('tpD').onchange = () => { pushOnce = false; };
}
$('trackV').addEventListener('click', (e) => { const j = e.target.closest('.junc'); if (j) openTransPop(+j.dataset.id, j); });
addEventListener('pointerdown', (e) => { if (popFor !== null && !e.target.closest('#transPop') && !e.target.closest('.junc')) closeTransPop(); });
addEventListener('keydown', (e) => { if (e.key === 'Escape') closeTransPop(); });

function duplicateItem() { // the copy goes right after the original
  const it = find(S.sel);
  if (!it) return;
  push();
  const o = JSON.parse(JSON.stringify(it)); o.id = uid++;
  if (isText(it)) { const d = it.end - it.start; o.start = it.end; o.end = it.end + d; S.texts.push(o); }
  else if (S.overlays.includes(it)) { o.start = it.start + dur(it); S.overlays.push(o); }
  else if (isAudio(it)) { o.start = it.start + dur(it); S.audios.push(o); }
  else { delete o.trans; delete o.gap; S.clips.splice(S.clips.indexOf(it) + 1, 0, o); }
  S.multi.clear(); S.sel = o.id; render(); seek(S.t);
}

/* ---------- inspector ---------- */
const TRANS = [['', 'None (cut)'],
  ['--', 'Fades'], ['fade', 'Crossfade'], ['fadeblack', 'Dip to black'], ['fadewhite', 'Dip to white'], ['fadegrays', 'Dip to gray'], ['dissolve', 'Dissolve'], ['pixelize', 'Pixelate'], ['hblur', 'Blur'],
  ['--', 'Wipes'], ['wipeleft', 'Wipe left'], ['wiperight', 'Wipe right'], ['wipeup', 'Wipe up'], ['wipedown', 'Wipe down'], ['wipetl', 'Wipe from top-left'], ['wipebr', 'Wipe from bottom-right'], ['diagtl', 'Diagonal top-left'], ['diagbr', 'Diagonal bottom-right'],
  ['--', 'Slides'], ['slideleft', 'Slide left'], ['slideright', 'Slide right'], ['slideup', 'Slide up'], ['slidedown', 'Slide down'], ['smoothleft', 'Smooth left'], ['smoothright', 'Smooth right'], ['smoothup', 'Smooth up'], ['smoothdown', 'Smooth down'],
  ['--', 'Shapes'], ['circleopen', 'Circle open'], ['circleclose', 'Circle close'], ['circlecrop', 'Circle crop'], ['rectcrop', 'Rectangle crop'], ['radial', 'Radial'], ['distance', 'Distance'],
  ['--', 'Motion'], ['zoomin', 'Zoom in'], ['squeezeh', 'Squeeze horizontal'], ['squeezev', 'Squeeze vertical'], ['vertopen', 'Vertical open'], ['vertclose', 'Vertical close'], ['horzopen', 'Horizontal open'], ['horzclose', 'Horizontal close'], ['hlslice', 'Slice horizontal'], ['vuslice', 'Slice vertical']];
const FILTERS = [['', 'None'], ['bw', 'Black & white'], ['sepia', 'Sepia'], ['warm', 'Warm'], ['cool', 'Cool'], ['vivid', 'Vivid'], ['faded', 'Faded']];
function refreshKfUI() {
  if (!curRows) return;
  const { item: it, rows } = curRows;
  const tr = clamp(S.t - startOf(it), 0, dur(it));
  for (const [, k, , , , f, d, kf] of rows) {
    const s = $('s_' + k); if (!s) continue;
    const v = kf ? valAt(it, k, tr) : (it[k] ?? d);
    if (document.activeElement !== s) s.value = v;
    $('v_' + k).textContent = f(v);
    if (kf) {
      const b = $('k_' + k), has = anim(it, k), at = has && it.kf[k].some((p) => Math.abs(p[0] - tr) < 0.04);
      b.textContent = at ? '\u25C6' : '\u25C7'; b.className = 'kf' + (has ? ' on' : '');
    }
  }
}
/* click a number next to a slider to type an exact value (speed accepts anything from 0.05x to 100x) */
const PCT = new Set(['vol', 'scale', 'opacity', 'px', 'py', 'ckSim', 'ckBlend', 'co', 'sa', 'br']);
function wireNumber(k, setV, s) {
  const span = $('v_' + k);
  span.style.cursor = 'text'; span.title = 'Click to type a value';
  span.onclick = () => {
    const inp = document.createElement('input');
    inp.type = 'text'; inp.className = 'numin'; inp.value = span.textContent.replace(/[^0-9.+-]/g, '');
    span.style.display = 'none'; span.after(inp); inp.focus(); inp.select();
    const done = (ok) => {
      if (!inp.isConnected) return;
      const raw = parseFloat(inp.value);
      inp.remove(); span.style.display = '';
      if (!ok || !isFinite(raw)) return;
      let v = PCT.has(k) ? raw / 100 : raw;
      v = k === 'speed' ? clamp(v, 0.05, 100) : k === 'scale' ? clamp(v, 0.1, 10) : clamp(v, +s.min, +s.max);
      setV(v); pushOnce = false;
    };
    inp.onkeydown = (e) => { e.stopPropagation(); if (e.key === 'Enter') done(true); else if (e.key === 'Escape') done(false); };
    inp.onblur = () => done(true);
  };
}
/* several blocks selected: one set of controls that changes all of them at once */
function renderMultiInspector(el) {
  const items = [...S.multi].map(find).filter(Boolean);
  const texts = items.filter(isText), medias = items.filter((i) => !isText(i) && i.kind !== 'audio'), auds = items.filter(isAudio);
  const pc = (v) => Math.round(v * 100) + '%', sec = (v) => v.toFixed(1) + 's';
  const playable = (i) => i.kind === 'video' || i.kind === 'audio', notText = (i) => !isText(i), isMedia = (i) => !isText(i) && i.kind !== 'audio';
  const rows = [
    ['Volume', 'vol', 0, 2, 0.01, pc, 1, playable], ['Speed', 'speed', 0.25, 4, 0.05, (v) => v.toFixed(2) + 'x', 1, playable],
    ['Fade in', 'fadeIn', 0, 5, 0.1, sec, 0, notText], ['Fade out', 'fadeOut', 0, 5, 0.1, sec, 0, notText],
    ['Scale', 'scale', 0.1, 3, 0.01, pc, 1, isMedia], ['Rotate', 'rot', -180, 180, 1, (v) => Math.round(v) + '°', 0, isMedia],
    ['Position X', 'px', -1, 1, 0.01, pc, 0, isMedia], ['Position Y', 'py', -1, 1, 0.01, pc, 0, isMedia], ['Opacity', 'opacity', 0, 1, 0.01, pc, 1, isMedia],
    ['Brightness', 'br', -0.5, 0.5, 0.01, (v) => (v >= 0 ? '+' : '') + Math.round(v * 100), 0, isMedia], ['Contrast', 'co', 0, 2, 0.01, pc, 1, isMedia], ['Saturation', 'sa', 0, 3, 0.01, pc, 1, isMedia],
    ['Text size', 'size', 16, 160, 1, (v) => Math.round(v), 56, isText], ['Outline', 'ow', 0, 12, 1, (v) => Math.round(v), 0, isText]
  ].filter((r) => items.some(r[7]));
  const lines = [];
  if (medias.length) lines.push(`${medias.length} clip${medias.length > 1 ? 's' : ''}`);
  if (auds.length) lines.push(`${auds.length} audio`);
  if (texts.length) lines.push(`${texts.length} text`);
  const opt = (arr, v) => arr.map(([k, n]) => `<option value="${k}" ${k === (v || '') ? 'selected' : ''}>${n}</option>`).join('');
  el.innerHTML = `<div><b>${items.length} items selected</b> <span class="hint-inline">(${lines.join(', ')})</span></div>
    <div class="hint" style="text-align:left;padding:0">Changes apply to every selected item that supports them.</div>` +
    rows.map(([l, k, mn, mx, st]) => `<div class="row"><div class="rh"><span>${l}</span><span id="v_${k}"></span></div><input id="s_${k}" type="range" min="${mn}" max="${mx}" step="${st}"></div>`).join('') +
    (medias.length ? `<label>Filter<select id="mFlt">${opt(FILTERS, medias[0].filter)}</select></label>` : '') +
    (texts.length ? `<label>Font<select id="mFont">${FONT_NAMES.map((n) => `<option ${n === (texts[0].font || 'Arial') ? 'selected' : ''}>${n}</option>`).join('')}</select></label>
      <label>Text color<input id="mColor" type="color" value="${texts[0].color}"></label>
      <div style="display:flex;gap:14px"><label style="flex-direction:row;align-items:center;gap:6px"><input id="mBold" type="checkbox" ${texts[0].bold ? 'checked' : ''}> Bold</label>
      <label style="flex-direction:row;align-items:center;gap:6px"><input id="mBox" type="checkbox" ${texts[0].box ? 'checked' : ''}> Box</label></div>` : '') +
    `<div style="display:flex;gap:6px"><button id="mDel">Delete ${items.length} items</button><button id="mNone">Select none</button></div>`;
  const touch = () => { if (!pushOnce) { push(); pushOnce = true; } };
  const setAll = (k, v, pred) => {
    touch();
    items.forEach((i) => { if (pred(i)) { i[k] = v; if (i.kf && i.kf[k]) { delete i.kf[k]; if (!Object.keys(i.kf).length) delete i.kf; } } });
    if (k === 'speed') render(true);
    if (k === 'size' || k === 'ow') updateOverlay(S.t); else showAt(S.t);
  };
  rows.forEach(([, k, , , , f, d, pred]) => {
    const s = $('s_' + k), first = items.find(pred), v0 = first[k] ?? d;
    s.value = v0; $('v_' + k).textContent = f(v0);
    const setV = (v) => { setAll(k, v, pred); $('v_' + k).textContent = f(v); s.value = v; };
    s.oninput = () => setV(+s.value);
    s.onchange = () => { pushOnce = false; };
    wireNumber(k, setV, s);
  });
  if ($('mFlt')) $('mFlt').onchange = (e) => { push(); medias.forEach((i) => { i.filter = e.target.value || undefined; }); showAt(S.t); };
  if ($('mFont')) $('mFont').onchange = (e) => { push(); texts.forEach((t) => { t.font = e.target.value; }); updateOverlay(S.t); };
  if ($('mColor')) $('mColor').oninput = (e) => { touch(); texts.forEach((t) => { t.color = e.target.value; }); updateOverlay(S.t); };
  if ($('mColor')) $('mColor').onchange = () => { pushOnce = false; };
  if ($('mBold')) $('mBold').onchange = (e) => { push(); texts.forEach((t) => { t.bold = e.target.checked; }); updateOverlay(S.t); };
  if ($('mBox')) $('mBox').onchange = (e) => { push(); texts.forEach((t) => { t.box = e.target.checked; }); updateOverlay(S.t); };
  $('mDel').onclick = del;
  $('mNone').onclick = () => { S.multi.clear(); S.sel = null; render(); };
}
function renderInspector() {
  const el = $('insBody'), it = find(S.sel); curRows = null;
  if (S.multi.size > 1) return renderMultiInspector(el);
  if (!it) { el.innerHTML = '<div class="hint">Select a clip, audio or text on the timeline</div>'; return; }
  if (isText(it)) {
    el.innerHTML = `
      <label>Text<textarea id="iText" rows="3"></textarea></label>
      <label>Size <span id="iSizeV">${it.size}</span><input id="iSize" type="range" min="16" max="160" value="${it.size}"></label>
      <label>Color<input id="iColor" type="color" value="${it.color}"></label>
      <label>Style preset<select id="iPre"><option value="">Choose a style</option>${Object.entries(TEXT_STYLES).map(([k, v]) => `<option value="${k}">${v.label}</option>`).join('')}</select></label>
      <label>Font<select id="iFont">${FONT_NAMES.map((n) => `<option ${n === (it.font || 'Arial') ? 'selected' : ''}>${n}</option>`).join('')}</select></label>
      <div style="display:flex;gap:14px">
        <label style="flex-direction:row;align-items:center;gap:6px"><input id="iBold" type="checkbox" ${it.bold ? 'checked' : ''}> Bold</label>
        <label style="flex-direction:row;align-items:center;gap:6px"><input id="iItal" type="checkbox" ${it.italic ? 'checked' : ''}> Italic</label>
        <label style="flex-direction:row;align-items:center;gap:6px"><input id="iShad" type="checkbox" ${it.sh ? 'checked' : ''}> Shadow</label>
      </div>
      <label>Outline <span id="iOwV">${it.ow || 0}</span><input id="iOw" type="range" min="0" max="12" value="${it.ow || 0}"></label>
      <label>Outline color<input id="iOc" type="color" value="${it.oc || '#000000'}"></label>
      <label>Animate in<select id="iAin">${TEXT_ANIMS.map(([k, n]) => `<option value="${k}" ${k === (it.animIn || '') ? 'selected' : ''}>${n}</option>`).join('')}</select></label>
      <label>Animate out<select id="iAout">${TEXT_ANIMS.map(([k, n]) => `<option value="${k}" ${k === (it.animOut || '') ? 'selected' : ''}>${n}</option>`).join('')}</select></label>
      <label>Animation length <span id="iAdV">${(it.animDur || 0.4).toFixed(1)}s</span><input id="iAd" type="range" min="0.1" max="1.5" step="0.1" value="${it.animDur || 0.4}"></label>
      <label>Position<select id="iPos"><option value="top">Top</option><option value="center">Center</option><option value="bottom">Bottom</option></select></label>
      <label style="flex-direction:row;align-items:center;gap:8px"><input id="iBox" type="checkbox" ${it.box ? 'checked' : ''}> Background box</label>
      <div class="hint" style="text-align:left;padding:0">Drag the text in the preview to place it anywhere.</div>`;
    $('iText').value = it.text; $('iPos').value = it.pos;
    const live = (fn) => (e) => { if (!pushOnce) { push(); pushOnce = true; } fn(e); updateOverlay(S.t); document.querySelectorAll('.tb').forEach((n) => { const x = find(+n.dataset.id); if (x) n.querySelector('.n').textContent = x.text; }); };
    $('iText').oninput = live((e) => { it.text = e.target.value; });
    $('iSize').oninput = live((e) => { it.size = +e.target.value; $('iSizeV').textContent = it.size; });
    $('iColor').oninput = live((e) => { it.color = e.target.value; });
    $('iPos').onchange = live((e) => { it.pos = e.target.value; it.x = 0.5; it.y = PRESET_Y[it.pos]; });
    $('iBox').onchange = live((e) => { it.box = e.target.checked; });
    $('iFont').onchange = live((e) => { it.font = e.target.value; });
    $('iBold').onchange = live((e) => { it.bold = e.target.checked; });
    $('iItal').onchange = live((e) => { it.italic = e.target.checked; });
    $('iShad').onchange = live((e) => { it.sh = e.target.checked; });
    $('iOw').oninput = live((e) => { it.ow = +e.target.value; $('iOwV').textContent = it.ow; });
    $('iOc').oninput = live((e) => { it.oc = e.target.value; });
    $('iAin').onchange = live((e) => { it.animIn = e.target.value || undefined; });
    $('iAout').onchange = live((e) => { it.animOut = e.target.value || undefined; });
    $('iAd').oninput = live((e) => { it.animDur = +e.target.value; $('iAdV').textContent = it.animDur.toFixed(1) + 's'; });
    $('iPre').onchange = (e) => {
      const p = TEXT_STYLES[e.target.value]; if (!p) return;
      push(); const { label, ...vals } = p; Object.assign(it, { bold: false, italic: false, ow: 0, sh: false, box: false }, vals);
      renderInspector(); updateOverlay(S.t);
    };
    el.querySelectorAll('input,textarea,select').forEach((n) => n.addEventListener('change', () => { pushOnce = false; }));
    return;
  }
  const aud = isAudio(it), isImg = it.kind === 'image', fz = !!it.freeze, ov = S.overlays.includes(it);
  const mainIdx = S.clips.indexOf(it);
  const pc = (v) => Math.round(v * 100) + '%', sec = (v) => v.toFixed(1) + 's';
  const R = []; // [label, key, min, max, step, fmt, default, keyframeable]
  if (fz) R.push(['Hold', 'fd', 0.2, 10, 0.1, sec, 2]);
  if (!isImg && !fz) R.push(['Speed', 'speed', 0.25, 4, 0.05, (v) => v.toFixed(2) + 'x', 1], ['Volume', 'vol', 0, 2, 0.01, pc, 1]);
  R.push(['Fade in', 'fadeIn', 0, 5, 0.1, sec, 0], ['Fade out', 'fadeOut', 0, 5, 0.1, sec, 0]);
  if (!aud) {
    R.push(['Scale', 'scale', 0.1, 3, 0.01, pc, 1, 1], ['Rotate', 'rot', -180, 180, 1, (v) => Math.round(v) + '\u00B0', 0, 1],
      ['Position X', 'px', -1, 1, 0.01, pc, 0, 1], ['Position Y', 'py', -1, 1, 0.01, pc, 0, 1], ['Opacity', 'opacity', 0, 1, 0.01, pc, 1, 1]);
    if (it.ck && !fz) R.push(['Similarity', 'ckSim', 0.01, 0.6, 0.01, pc, 0.3], ['Smoothness', 'ckBlend', 0, 0.3, 0.01, pc, 0.1]);
    R.push(['Brightness', 'br', -0.5, 0.5, 0.01, (v) => (v >= 0 ? '+' : '') + Math.round(v * 100), 0], ['Contrast', 'co', 0, 2, 0.01, pc, 1], ['Saturation', 'sa', 0, 3, 0.01, pc, 1]);
  }
  const opt = (arr, v) => {
    let out = '', open = false;
    for (const [k, n] of arr) {
      if (k === '--') { if (open) out += '</optgroup>'; out += `<optgroup label="${n}">`; open = true; }
      else out += `<option value="${k}" ${k === (v || '') ? 'selected' : ''}>${n}</option>`;
    }
    return out + (open ? '</optgroup>' : '');
  };
  const TABOF = { fd: 'basic', speed: 'basic', vol: 'basic', fadeIn: 'basic', fadeOut: 'basic', scale: 'transform', rot: 'transform', px: 'transform', py: 'transform', opacity: 'transform', br: 'color', co: 'color', sa: 'color', ckSim: 'fx', ckBlend: 'fx' };
  const rowH = ([l, k, mn, mx, st, , , kf]) => `<div class="row"><div class="rh"><span>${l}</span><span id="v_${k}"></span>${kf ? `<button type="button" class="kf" id="k_${k}" title="Add / remove keyframe at the playhead">\u25C7</button>` : ''}</div><input id="s_${k}" type="range" min="${mn}" max="${mx}" step="${st}"></div>`;
  const P = { basic: '', transform: '', color: '', fx: '' };
  R.forEach((r) => { P[TABOF[r[1]]] += rowH(r); });
  const small = 'style="text-align:left;padding:0"';
  const ckHtml = aud || fz ? '' : `<label style="flex-direction:row;align-items:center;gap:6px"><input id="ck" type="checkbox" ${it.ck ? 'checked' : ''}> Chroma key (green screen)</label>
    ${it.ck ? `<div style="display:flex;gap:6px;align-items:center"><input id="ckc" type="color" value="${it.ckColor || '#00ff00'}"><button id="ckp" title="Click, then pick the background color in the preview">Pick color</button></div>` : ''}`;
  const trHtml = !aud && mainIdx > 0 ? `<label>Transition from previous clip<select id="trT">${opt(TRANS, it.trans && it.trans.type)}</select></label>
    ${it.trans ? `<div class="row"><div class="rh"><span>Length</span><span id="trV">${it.trans.d.toFixed(1)}s</span></div><input id="trD" type="range" min="0.2" max="2" step="0.1" value="${it.trans.d}"></div><div class="hint" ${small}>The transition is centered on the cut and uses footage beyond each clip's trim.</div>` : ''}` : '';
  P.basic += `${isImg || fz || aud ? '' : `<label style="flex-direction:row;align-items:center;gap:6px"><input id="rev" type="checkbox" ${it.rev ? 'checked' : ''}> Reverse (preview has no sound)</label>`}
    ${isImg || fz || aud ? '' : '<button id="mute">' + (it.vol === 0 ? 'Unmute' : 'Mute') + '</button>'}
    <div class="hint" ${small}>Duration: ${dur(it).toFixed(2)}s. Preview volume tops out at 100%; export uses the full level.</div>`;
  P.transform += `<div style="display:flex;gap:14px">
      <label style="flex-direction:row;align-items:center;gap:6px"><input id="fh" type="checkbox" ${it.flipH ? 'checked' : ''}> Flip H</label>
      <label style="flex-direction:row;align-items:center;gap:6px"><input id="fv" type="checkbox" ${it.flipV ? 'checked' : ''}> Flip V</label>
    </div>
    <button id="resetT">Reset transform</button>
    <div class="hint" ${small}>\u25C7 sets a keyframe at the playhead, so a value can change over time.</div>`;
  P.color = `<label>Filter<select id="flt">${opt(FILTERS, it.filter)}</select></label>` + P.color;
  P.fx = ckHtml + P.fx + trHtml;
  const names = [['basic', 'Basic'], ['transform', 'Transform'], ['color', 'Color'], ['fx', 'Effects']];
  if (aud || !names.some(([k]) => k === inspTab)) inspTab = 'basic';
  const tabBar = aud ? '' : `<div class="tabs">${names.map(([k, n]) => `<button type="button" class="tab${k === inspTab ? ' on' : ''}" data-t="${k}">${n}</button>`).join('')}</div>`;
  el.innerHTML = `<div><b></b> <span class="hint-inline">${ov ? (it.lane === 'v2' ? '(video 2)' : '(overlay)') : aud ? '(audio)' : ''}</span></div>` + tabBar +
    names.filter(([k]) => !aud || k === 'basic').map(([k]) => `<div class="pane" data-t="${k}" ${aud || k === inspTab ? '' : 'hidden'}>${P[k]}</div>`).join('');
  el.querySelectorAll('.tab').forEach((b) => {
    b.onclick = () => {
      inspTab = b.dataset.t;
      el.querySelectorAll('.tab').forEach((x) => x.classList.toggle('on', x === b));
      el.querySelectorAll('.pane').forEach((p) => { p.hidden = p.dataset.t !== inspTab; });
    };
  });
  el.querySelector('b').textContent = it.name;
  curRows = { item: it, rows: R };
  refreshKfUI();
  const apply = () => showAt(S.t);
  const trNow = () => clamp(S.t - startOf(it), 0, dur(it));
  R.forEach(([, k, , , , f, , kf]) => {
    const s = $('s_' + k);
    const setV = (v) => {
      if (!pushOnce) { push(); pushOnce = true; }
      if (kf && anim(it, k)) { setKf(it, k, trNow(), v); render(true); } else it[k] = v;
      $('v_' + k).textContent = f(v);
      if (k === 'speed' || k === 'fd') render(true);
      apply(); refreshKfUI();
    };
    s.oninput = () => setV(+s.value);
    wireNumber(k, setV, s);
    s.onchange = () => { pushOnce = false; };
    if (kf) {
      $('k_' + k).onclick = () => {
        push();
        const tr = trNow(), cur = valAt(it, k, tr);
        it.kf = it.kf || {};
        const pts = it.kf[k] = it.kf[k] || [], i = pts.findIndex((p) => Math.abs(p[0] - tr) < 0.04);
        if (i >= 0) { pts.splice(i, 1); if (!pts.length) { delete it.kf[k]; it[k] = cur; } }
        else { pts.push([+tr.toFixed(2), cur]); pts.sort((a, b) => a[0] - b[0]); }
        if (!Object.keys(it.kf).length) delete it.kf;
        render(true); refreshKfUI(); apply();
      };
    }
  });
  if (aud) { if ($('mute')) $('mute').onclick = () => { push(); it.vol = it.vol === 0 ? 1 : 0; apply(); renderInspector(); }; return; }
  if ($('rev')) $('rev').onchange = (e) => { push(); it.rev = e.target.checked || undefined; apply(); };
  $('flt').onchange = (e) => { push(); it.filter = e.target.value || undefined; apply(); };
  $('fh').onchange = (e) => { push(); it.flipH = e.target.checked; apply(); };
  $('fv').onchange = (e) => { push(); it.flipV = e.target.checked; apply(); };
  if ($('ck')) {
    $('ck').onchange = (e) => {
      push(); it.ck = e.target.checked;
      if (it.ck) { it.ckColor = it.ckColor || '#00ff00'; it.ckSim = it.ckSim ?? 0.3; it.ckBlend = it.ckBlend ?? 0.1; }
      renderInspector(); apply();
    };
  }
  if ($('ckc')) {
    $('ckc').oninput = (e) => { if (!pushOnce) { push(); pushOnce = true; } it.ckColor = e.target.value; };
    $('ckc').onchange = () => { pushOnce = false; };
    $('ckp').onclick = async () => {
      if (!window.EyeDropper) return alert('Color picker is not available here.');
      it.ck = false; apply();
      try { const r = await new window.EyeDropper().open(); push(); it.ckColor = r.sRGBHex; } catch (_) { /* cancelled */ }
      it.ck = true; renderInspector(); apply();
    };
  }
  if ($('trT')) {
    $('trT').onchange = (e) => { push(); it.trans = e.target.value ? { type: e.target.value, d: (it.trans && it.trans.d) || 0.8 } : undefined; render(); seek(S.t); };
  }
  if ($('trD')) {
    $('trD').oninput = (e) => { if (!pushOnce) { push(); pushOnce = true; } it.trans.d = +e.target.value; $('trV').textContent = it.trans.d.toFixed(1) + 's'; render(true); };
    $('trD').onchange = () => { pushOnce = false; };
  }
  if ($('mute')) $('mute').onclick = () => { push(); it.vol = it.vol === 0 ? 1 : 0; apply(); renderInspector(); };
  $('resetT').onclick = () => {
    const pip = ov && it.lane !== 'v2';
    push(); Object.assign(it, { scale: pip ? 0.4 : 1, rot: 0, px: pip ? 0.28 : 0, py: pip ? -0.28 : 0, opacity: 1, flipH: false, flipV: false });
    delete it.kf; render(); apply();
  };
}

/* ---------- export ---------- */
function exportSize() {
  const [a, b] = S.aspect.split(':').map(Number), q = +$('quality').value, ev = (n) => Math.round(n / 2) * 2;
  return a >= b ? { width: ev(q * a / b), height: q } : { width: q, height: ev(q * b / a) };
}
const exItem = (c, x) => ({
  xh: x && x.h, xea: x && x.ea, xeb: x && x.eb,
  rev: c.rev, gap: c.gap, path: c.path, kind: c.kind, in: c.in, out: c.out, vol: c.vol, speed: c.speed, freeze: c.freeze, fd: c.fd, start: c.start,
  flipH: c.flipH, flipV: c.flipV, rot: c.rot, scale: c.scale, px: c.px, py: c.py, opacity: c.opacity, kf: c.kf,
  fadeIn: c.fadeIn, fadeOut: c.fadeOut, br: c.br, co: c.co, sa: c.sa, filter: c.filter, trans: c.trans,
  ck: c.ck, ckColor: c.ckColor, ckSim: c.ckSim, ckBlend: c.ckBlend
});
async function doExport() {
  const out = await api.pickSave();
  if (!out) return;
  $('expGo').disabled = true; $('bar').style.width = '0'; $('expStatus').textContent = 'Exporting\u2026';
  const { width, height } = exportSize();
  const r = await api.exportVideo({
    clips: lay().map((e) => exItem(e.c, e)), overlays: S.overlays.slice().sort((a, b) => (a.lane === 'v2' ? 0 : 1) - (b.lane === 'v2' ? 0 : 1)).map(exItem), audios: S.audios.map(exItem),
    texts: S.texts.map((t) => ({ text: t.text, start: t.start, end: t.end, size: t.size, color: t.color, box: t.box, font: t.font, bold: t.bold, italic: t.italic, ow: t.ow, oc: t.oc, sh: t.sh, animIn: t.animIn, animOut: t.animOut, animDur: t.animDur, ...txy(t) })),
    width, height, fps: +$('fps').value, crf: +$('crf').value, out
  });
  $('expGo').disabled = false;
  if (r.ok) { $('bar').style.width = '100%'; $('expStatus').textContent = 'Done! Saved to ' + out; }
  else $('expStatus').textContent = 'Failed: ' + (r.error || '').slice(-300);
}

/* ---------- projects ---------- */
function setTitle() {
  const n = S.file ? S.file.split(/[\\/]/).pop() : 'Untitled';
  $('projName').textContent = n; document.title = n + ' - ClipForge';
}
async function saveProject(saveAs) {
  const data = JSON.stringify({ v: 3, aspect: S.aspect, media: S.media, clips: S.clips, overlays: S.overlays, audios: S.audios, texts: S.texts });
  const f = await api.saveProject({ file: S.file, data, saveAs });
  if (f) { S.file = f; setTitle(); lastAuto = data; api.autosaveClear(); noteRecent(); }
}
function noteRecent() { // remember this project on the home screen
  if (!S.file) return;
  const first = S.clips.find((c) => c.thumb);
  api.recentAdd({ file: S.file, name: S.file.split(/[\\/]/).pop().replace(/\.qcut$/i, ''), thumb: first ? first.thumb : '', dur: total(), time: Date.now() });
}
const projData = () => JSON.stringify({ v: 3, aspect: S.aspect, media: S.media, clips: S.clips, overlays: S.overlays, audios: S.audios, texts: S.texts });
let lastAuto = projData();
let lastTick = Date.now();
setInterval(() => { // autosave: write a recovery copy whenever something changed
  const every = (typeof CFG !== 'undefined' ? CFG.autosave : 10) * 1000;
  if (!every || Date.now() - lastTick < every - 1000) return;
  lastTick = Date.now();
  if (!(S.clips.length || S.overlays.length || S.audios.length || S.texts.length)) return;
  const d = projData(); if (d === lastAuto) return;
  lastAuto = d; api.autosaveWrite({ file: S.file, data: d });
}, 2000);
async function openProject() {
  const r = await api.openProject();
  if (!r) return;
  loadProject(r);
}
function loadProject(r) {
  try {
    const o = JSON.parse(r.data);
    pause(); curPath = null;
    S.media = o.media || []; S.clips = o.clips || []; S.overlays = o.overlays || []; S.audios = o.audios || []; S.texts = o.texts || [];
    S.aspect = o.aspect || '16:9'; $('aspect').value = S.aspect;
    uid = 1 + Math.max(0, ...[...S.media, ...S.clips, ...S.overlays, ...S.audios, ...S.texts].map((x) => x.id || 0));
    S.sel = null; S.file = r.file; undoS.length = redoS.length = 0;
    setTitle(); renderBin(); fitStage(); seek(0); render(); lastAuto = projData(); noteRecent(); if (typeof hideHome === 'function') hideHome();
  } catch (e) { alert('Could not open project: ' + e.message); }
}
function newProject() {
  if ((S.clips.length || S.texts.length || S.overlays.length || S.audios.length) && !confirm('Start a new project? Unsaved changes will be lost.')) return false;
  pause(); curPath = null;
  Object.assign(S, { media: [], clips: [], overlays: [], audios: [], texts: [], sel: null, t: 0, file: null });
  undoS.length = redoS.length = 0; setTitle(); renderBin(); seek(0); render(); lastAuto = projData(); api.autosaveClear();
  return true;
}
setTimeout(async () => { // offer to bring back work from a crash or an unsaved close
  try {
    const r = await api.autosaveRead();
    if (r && confirm('ClipForge found unsaved work from last time. Restore it?')) { loadProject({ file: r.file || null, data: r.data }); lastAuto = projData(); }
    else if (r) api.autosaveClear();
  } catch (e) {}
}, 400);

/* ---------- wiring ---------- */
$('newBtn').onclick = newProject; $('openBtn').onclick = openProject;
$('saveBtn').onclick = () => saveProject(false); $('saveAsBtn').onclick = () => saveProject(true);
$('master').oninput = (e) => { S.master = e.target.value / 100; showAt(S.t); };
$('importBtn').onclick = async () => addFiles(await api.importFiles());
$('playBtn').onclick = () => (S.playing ? pause() : play());
$('toStart').onclick = () => { pause(); seek(0); };
$('toEnd').onclick = () => { pause(); seek(total()); };
$('splitBtn').onclick = split; $('freezeBtn').onclick = freeze; $('delBtn').onclick = del; $('addTextBtn').onclick = addText;
$('undo').onclick = undo; $('redo').onclick = redo;
$('zoom').oninput = (e) => { S.pps = +e.target.value; render(true); };
function toggleGrid() {
  const g = $('grid'); g.hidden = !g.hidden; $('gridBtn').classList.toggle('on', !g.hidden);
  try { localStorage.setItem('qcGrid', g.hidden ? '0' : '1'); } catch (e) {}
}
$('gridBtn').onclick = toggleGrid;
try { if (localStorage.getItem('qcGrid') === '1') toggleGrid(); } catch (e) {}
function fitTimeline() {
  const ends = [total(), ...S.overlays.map((o) => o.start + dur(o)), ...S.audios.map((a) => a.start + dur(a)), ...S.texts.map((t) => t.end)];
  const end = Math.max(...ends, 1);
  const avail = $('tl').clientWidth - 52 - 24;
  S.pps = clamp(avail / (end + 1), 2, 300); $('zoom').value = S.pps;
  $('tl').scrollLeft = 0; render(true);
}
$('fitBtn').onclick = fitTimeline;
$('aspect').onchange =(e) => { S.aspect = e.target.value; fitStage(); };
$('exportBtn').onclick = () => {
  if (!S.clips.length) return alert('Add a clip to the timeline first.');
  pause(); $('expStatus').textContent = ''; $('bar').style.width = '0'; $('modal').classList.remove('hidden');
};
$('expCancel').onclick = () => { api.cancelExport(); $('modal').classList.add('hidden'); };
$('expGo').onclick = doExport;
api.onProgress((v) => { $('bar').style.width = (v * 100).toFixed(0) + '%'; });

addEventListener('keydown', (e) => {
  if (!$('home').hidden) return;
  if (/INPUT|TEXTAREA|SELECT/.test(e.target.tagName) && e.target.type !== 'range') return;
  if (e.ctrlKey && e.key.toLowerCase() === 's') { e.preventDefault(); saveProject(e.shiftKey); }
  else if (e.ctrlKey && e.key.toLowerCase() === 'o') { e.preventDefault(); openProject(); }
  else if (e.ctrlKey && e.key.toLowerCase() === 'a') {
    e.preventDefault();
    const all = [...S.clips, ...S.overlays, ...S.audios, ...S.texts].map((x) => x.id);
    S.multi = new Set(all.length > 1 ? all : []); S.sel = all[0] ?? null; render();
  }
  else if (e.shiftKey && !e.ctrlKey && e.key.toLowerCase() === 'z') fitTimeline();
  else if (!e.ctrlKey && !e.shiftKey && e.key.toLowerCase() === 'g') toggleGrid();
  else if (e.key === 'Escape' && (S.multi.size || S.sel)) { S.multi.clear(); S.sel = null; render(); }
  else if (e.ctrlKey && e.key.toLowerCase() === 'x') { e.preventDefault(); copyItem(); del(); }
  else if (e.ctrlKey && e.key.toLowerCase() === 'd') { e.preventDefault(); duplicateItem(); }
  else if (e.ctrlKey && e.key.toLowerCase() === 'c') { e.preventDefault(); copyItem(); }
  else if (e.ctrlKey && e.key.toLowerCase() === 'v') { e.preventDefault(); pasteItem(); }
  else if (e.ctrlKey && e.key.toLowerCase() === 'z') { e.preventDefault(); undo(); }
  else if (e.ctrlKey && e.key.toLowerCase() === 'y') { e.preventDefault(); redo(); }
  else if (e.key === ' ') { e.preventDefault(); S.playing ? pause() : play(); }
  else if (e.key.toLowerCase() === 's' && !e.ctrlKey) split();
  else if (e.key.toLowerCase() === 'f' && !e.ctrlKey) freeze();
  else if (e.key.toLowerCase() === 't' && !e.ctrlKey) addText();
  else if (e.key === 'Delete' || e.key === 'Backspace') del();
  else if (e.key === 'ArrowLeft') { pause(); seek(S.t - (e.shiftKey ? 1 : 1 / 30)); }
  else if (e.key === 'ArrowRight') { pause(); seek(S.t + (e.shiftKey ? 1 : 1 / 30)); }
});
addEventListener('dragover', (e) => e.preventDefault());
addEventListener('drop', (e) => {
  e.preventDefault();
  addFiles([...e.dataTransfer.files].map((f) => api.pathFor(f)).filter((p) => MEDIA_RE.test(p)));
});
/* drag the picture in the preview to move it (like the text) */
function layerAt(t) {
  const act = S.overlays.filter((o) => t >= o.start && t < o.start + dur(o));
  const sel = find(S.sel);
  if (sel && !isText(sel) && !isAudio(sel) && (S.overlays.includes(sel) ? act.includes(sel) : clipAt(t).c === sel)) return sel;
  return act.filter((o) => o.lane !== 'v2').pop() || act.filter((o) => o.lane === 'v2').pop() || clipAt(t).c || null;
}
stage.addEventListener('pointerdown', (e) => {
  if (e.target.closest('.ov')) return; // text has its own drag
  const it = layerAt(S.t);
  if (!it) return;
  e.preventDefault(); pause();
  S.sel = it.id; S.multi.clear();
  const r = stage.getBoundingClientRect(), tr = clamp(S.t - startOf(it), 0, dur(it));
  const bx = valAt(it, 'px', tr), by = valAt(it, 'py', tr);
  let first = true;
  drag(e, (_dx, ev) => {
    if (first) { push(); first = false; }
    let nx = bx + (ev.clientX - e.clientX) / r.width, ny = by + (ev.clientY - e.clientY) / r.height;
    if (Math.abs(nx) < 0.02) nx = 0; // sticks to the centre
    if (Math.abs(ny) < 0.02) ny = 0;
    if (anim(it, 'px')) setKf(it, 'px', tr, nx); else it.px = nx;
    if (anim(it, 'py')) setKf(it, 'py', tr, ny); else it.py = ny;
    showAt(S.t); refreshKfUI();
  }, () => render());
});
addEventListener('resize', fitStage);
new ResizeObserver(fitStage).observe($('stageWrap'));
setTitle(); fitStage(); render();

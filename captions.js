'use strict';
/* Auto-captions: Whisper tiny (English) running in a worker through WebAssembly. Nothing leaves this PC. */
let asrWorker = null, capBusy = false;
const capStatus = (t) => { $('capStatus').textContent = t; };

async function getAsrWorker() {
  if (asrWorker) return asrWorker;
  const base = `http://127.0.0.1:${await api.asrPort()}`;
  const src = `
const lib = import('${base}/vendor/transformers.web.min.js');
let asr = null;
onmessage = async (e) => {
  try {
    const { pipeline, env } = await lib;
    if (!asr) {
      postMessage({ t: 'status', s: 'Loading speech model' });
      env.allowRemoteModels = false; env.allowLocalModels = true;
      env.localModelPath = '${base}/models/';
      env.backends.onnx.wasm.wasmPaths = '${base}/vendor/';
      env.backends.onnx.wasm.numThreads = 1;
      env.backends.onnx.wasm.proxy = false;
      asr = await pipeline('automatic-speech-recognition', 'whisper-tiny.en', { dtype: 'q8', device: 'wasm' });
    }
    postMessage({ t: 'status', s: 'Listening' });
    const out = await asr(e.data.audio, { return_timestamps: true, chunk_length_s: 30, stride_length_s: 5 });
    postMessage({ t: 'done', chunks: out.chunks || [{ text: out.text, timestamp: [0, null] }] });
  } catch (err) { postMessage({ t: 'error', m: String((err && err.message) || err) }); }
};`;
  asrWorker = new Worker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })), { type: 'module' });
  return asrWorker;
}

function transcribe(audio) {
  return new Promise(async (resolve, reject) => {
    const w = await getAsrWorker();
    w.onmessage = (e) => {
      if (e.data.t === 'status') capStatus(e.data.s + '...');
      else if (e.data.t === 'done') resolve(e.data.chunks);
      else if (e.data.t === 'error') reject(new Error(e.data.m));
    };
    w.onerror = (e) => { asrWorker = null; reject(new Error('The speech engine could not start' + (e.message ? ': ' + e.message : ''))); };
    w.postMessage({ audio }, [audio.buffer]);
  });
}

// split a recognised sentence into short subtitle lines, sharing the time by length
function splitLines(text, t0, t1, max = 38) {
  const words = text.trim().split(/\s+/).filter(Boolean), lines = [];
  let cur = '';
  for (const w of words) {
    if (cur && (cur + ' ' + w).length > max) { lines.push(cur); cur = w; } else cur = cur ? cur + ' ' + w : w;
  }
  if (cur) lines.push(cur);
  if (lines.length > 1 && lines[lines.length - 1].length < 12 && lines[lines.length - 2].length + lines[lines.length - 1].length < max + 10) {
    lines.splice(-2, 2, lines[lines.length - 2] + ' ' + lines[lines.length - 1]); // avoid a one-word last line
  }
  const total = lines.reduce((a, l) => a + l.length, 0) || 1;
  let t = t0;
  return lines.map((l) => { const d = (t1 - t0) * l.length / total, o = { text: l, start: t, end: t + d }; t += d; return o; });
}

async function autoCaptions() {
  if (capBusy) return;
  const sel = find(S.sel);
  let targets = [];
  if (sel && !isText(sel) && sel.kind !== 'image') targets = [sel];
  else targets = S.clips.filter((c) => c.kind === 'video' && !c.freeze);
  targets = targets.filter((c) => !c.rev && c.kind !== 'image' && !c.freeze);
  if (!targets.length) { capStatus('Select a video or audio clip first'); return; }
  capBusy = true; $('capBtn').disabled = true;
  const made = [];
  try {
    for (let n = 0; n < targets.length; n++) {
      const c = targets[n], sp = spd(c), begin = startOf(c), len = c.out - c.in;
      capStatus(`Reading audio ${n + 1} of ${targets.length}...`);
      const buf = await api.extractAudio({ path: c.path, from: c.in, len });
      if (buf.byteLength < 4000) continue; // no sound track
      const audio = new Float32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength - (buf.byteLength % 4)));
      const chunks = await transcribe(audio);
      for (const ch of chunks) {
        const text = (ch.text || '').trim();
        if (!text || /^[\[(].*[\])]$/.test(text)) continue; // [BLANK_AUDIO], (music) ...
        const a = ch.timestamp[0] || 0, b = ch.timestamp[1] ?? a + 2;
        for (const l of splitLines(text, begin + a / sp, begin + Math.min(b, len) / sp)) {
          if (l.end - l.start >= 0.2) made.push(l);
        }
      }
    }
    if (!made.length) { capStatus('No speech found'); return; }
    push();
    for (const l of made) {
      S.texts.push({ id: uid++, text: l.text, start: l.start, end: l.end, size: 44, color: '#ffffff', pos: 'bottom', x: 0.5, y: 0.88, box: true, font: 'Arial', bold: true });
    }
    S.sel = null; render(); seek(S.t);
    capStatus(`Added ${made.length} captions`);
  } catch (err) {
    capStatus('Captions failed: ' + err.message);
  } finally {
    capBusy = false; $('capBtn').disabled = false;
  }
}
$('capBtn').onclick = autoCaptions;

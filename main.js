const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const { spawn, execFile } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

let ffmpeg = require('ffmpeg-static');
if (ffmpeg && ffmpeg.includes('app.asar')) ffmpeg = ffmpeg.replace('app.asar', 'app.asar.unpacked');

let win;
let job = null;

function createWindow() {
  win = new BrowserWindow({
    width: 1400, height: 860, minWidth: 1000, minHeight: 650,
    backgroundColor: '#14161a', title: 'ClipForge',
    autoHideMenuBar: true, icon: path.join(__dirname, 'icon.png'),
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true }
  });
  win.loadFile('index.html');
}

app.whenReady().then(createWindow);
app.on('window-all-closed', () => app.quit());

ipcMain.handle('import', async () => {
  const r = await dialog.showOpenDialog(win, {
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: 'Media', extensions: ['mp4', 'mov', 'mkv', 'webm', 'avi', 'm4v', 'jpg', 'jpeg', 'png', 'webp', 'mp3', 'wav', 'm4a', 'aac', 'ogg', 'flac', 'opus'] }]
  });
  return r.canceled ? [] : r.filePaths;
});

ipcMain.handle('pickSave', async () => {
  const r = await dialog.showSaveDialog(win, { defaultPath: 'export.mp4', filters: [{ name: 'MP4 video', extensions: ['mp4'] }] });
  return r.canceled ? null : r.filePath;
});

const projFilter = [{ name: 'ClipForge project', extensions: ['qcut'] }];
ipcMain.handle('saveProject', async (_e, { file, data, saveAs }) => {
  let f = file;
  if (!f || saveAs) {
    const r = await dialog.showSaveDialog(win, { defaultPath: f || 'project.qcut', filters: projFilter });
    if (r.canceled) return null;
    f = r.filePath;
  }
  fs.writeFileSync(f, data, 'utf8');
  return f;
});
ipcMain.handle('openProject', async () => {
  const r = await dialog.showOpenDialog(win, { properties: ['openFile'], filters: projFilter });
  if (r.canceled) return null;
  return { file: r.filePaths[0], data: fs.readFileSync(r.filePaths[0], 'utf8') };
});

const autoFile = () => path.join(app.getPath('userData'), 'autosave.json');
ipcMain.handle('autosaveWrite', (_e, o) => { try { fs.writeFileSync(autoFile(), JSON.stringify(o), 'utf8'); } catch (e) {} });
ipcMain.handle('autosaveRead', () => { try { return JSON.parse(fs.readFileSync(autoFile(), 'utf8')); } catch (e) { return null; } });
ipcMain.handle('autosaveClear', () => { try { fs.unlinkSync(autoFile()); } catch (e) {} });

const recentFile = () => path.join(app.getPath('userData'), 'recent.json');
const readRecent = () => { try { return JSON.parse(fs.readFileSync(recentFile(), 'utf8')); } catch (e) { return []; } };
const writeRecent = (l) => { try { fs.writeFileSync(recentFile(), JSON.stringify(l), 'utf8'); } catch (e) {} };
ipcMain.handle('recentList', () => readRecent().map((r) => ({ ...r, missing: !fs.existsSync(r.file) })));
ipcMain.handle('recentAdd', (_e, r) => writeRecent([r, ...readRecent().filter((x) => x.file !== r.file)].slice(0, 24)));
ipcMain.handle('recentRemove', (_e, f) => writeRecent(readRecent().filter((x) => x.file !== f)));
ipcMain.handle('recentClear', () => writeRecent([]));
ipcMain.handle('readProject', (_e, f) => { try { return { file: f, data: fs.readFileSync(f, 'utf8') }; } catch (e) { return null; } });

const hasAudio =(p) => new Promise((res) =>
  execFile(ffmpeg, ['-hide_banner', '-i', p], (e, so, se) => res(/Audio:/.test(se || ''))));

const esc = (p) => p.replace(/\\/g, '/').replace(/:/g, '\\:');



let FPS = 30;
const spd = (c) => (c.kind === 'image' ? 1 : c.speed || 1);
const cdur = (c) => (c.freeze ? c.fd : (c.out - c.in) / spd(c));
const DEF = { scale: 1, rot: 0, px: 0, py: 0, opacity: 1 };
const num = (v) => Number(v).toFixed(4);
const anim = (c, k) => c.kf && c.kf[k] && c.kf[k].length;
const val = (c, k) => c[k] ?? DEF[k];
const hasKf = (c) => c.kf && Object.values(c.kf).some((p) => p.length);

// piecewise-linear expression through [[t,value],...] using variable v
function pwl(pts, v) {
  pts = [...pts].sort((a, b) => a[0] - b[0]);
  if (pts.length === 1) return num(pts[0][1]);
  let e = num(pts[pts.length - 1][1]);
  for (let i = pts.length - 2; i >= 0; i--) {
    const [t0, v0] = pts[i], [t1, v1] = pts[i + 1];
    const seg = t1 > t0 ? `(${num(v0)}+(${num(v1 - v0)})*(${v}-${num(t0)})/${num(t1 - t0)})` : num(v1);
    e = `if(lt(${v},${num(t1)}),${seg},${e})`;
  }
  return `if(lt(${v},${num(pts[0][0])}),${num(pts[0][1])},${e})`;
}

const isXf = (c) => c.ck || hasKf(c) || val(c, 'scale') !== 1 || val(c, 'opacity') !== 1 || c.rot || c.flipH || c.flipV || c.px || c.py;
const tempo = (s) => {
  if (s === 1) return '';
  const f = [];
  while (s > 2) { f.push('atempo=2'); s /= 2; }
  while (s < 0.5) { f.push('atempo=0.5'); s /= 0.5; }
  f.push(`atempo=${s.toFixed(4)}`);
  return f.join(',') + ',';
};
const ckf = (c) => (c.ck ? `,chromakey=color=0x${(c.ckColor || '#00ff00').slice(1)}:similarity=${(c.ckSim ?? 0.3).toFixed(3)}:blend=${(c.ckBlend ?? 0.1).toFixed(3)}` : '');
const PRESET = {
  bw: 'hue=s=0',
  sepia: 'colorchannelmixer=.393:.769:.189:0:.349:.686:.168:0:.272:.534:.131',
  warm: 'colorbalance=rs=0.12:gs=0.02:bs=-0.12',
  cool: 'colorbalance=rs=-0.1:bs=0.12',
  vivid: 'eq=saturation=1.6:contrast=1.1',
  faded: 'eq=contrast=0.85:brightness=0.05:saturation=0.8'
};
const cf = (c) => {
  const f = [];
  if (PRESET[c.filter]) f.push(PRESET[c.filter]);
  if ((c.br || 0) !== 0 || (c.co ?? 1) !== 1 || (c.sa ?? 1) !== 1) f.push(`eq=brightness=${(c.br || 0).toFixed(3)}:contrast=${(c.co ?? 1).toFixed(3)}:saturation=${(c.sa ?? 1).toFixed(3)}`);
  return f.length ? ',' + f.join(',') : '';
};
const vfade = (c, d, alpha) => {
  const f = [], a = alpha ? ':alpha=1' : '';
  if (c.fadeIn > 0) f.push(`fade=t=in:st=0:d=${c.fadeIn.toFixed(3)}${a}`);
  if (c.fadeOut > 0) f.push(`fade=t=out:st=${Math.max(0, d - c.fadeOut).toFixed(3)}:d=${c.fadeOut.toFixed(3)}${a}`);
  return f.length ? (alpha ? ',format=yuva420p,' : ',') + f.join(',') : '';
};
const afade = (c, d) => {
  let s = '';
  if (c.fadeIn > 0) s += `afade=t=in:st=0:d=${c.fadeIn.toFixed(3)},`;
  if (c.fadeOut > 0) s += `afade=t=out:st=${Math.max(0, d - c.fadeOut).toFixed(3)}:d=${c.fadeOut.toFixed(3)},`;
  return s;
};

async function addSource(c, args, st) {
  const d = cdur(c), vi = st.idx++;
  if (c.kind === 'audio') {
    args.push('-ss', c.in.toFixed(3), '-t', (c.out - c.in).toFixed(3), '-i', c.path);
    return { vi, ai: vi, d };
  }
  if (c.kind === 'image') args.push('-loop', '1', '-t', d.toFixed(3), '-i', c.path);
  else if (c.freeze) args.push('-ss', c.in.toFixed(3), '-t', '1', '-i', c.path);
  else args.push('-ss', c.in.toFixed(3), '-t', (c.out - c.in).toFixed(3), '-i', c.path);
  const ai = c.kind === 'video' && !c.freeze && (await hasAudio(c.path)) ? vi : null;
  return { vi, ai, d };
}

function vbase(c, d) {
  const D = d.toFixed(3);
  if (c.kind === 'image') return `fps=${FPS},setpts=PTS-STARTPTS`;
  if (c.freeze) return `trim=end_frame=1,tpad=stop_mode=clone:stop_duration=${D},fps=${FPS},trim=duration=${D},setpts=PTS-STARTPTS`;
  return `${c.rev ? 'reverse,' : ''}setpts=(PTS-STARTPTS)/${spd(c)},fps=${FPS},trim=duration=${D},setpts=PTS-STARTPTS`;
}

function xform(c, W, H) {
  const f = [`scale=${W}:${H}:force_original_aspect_ratio=decrease`, 'setsar=1'];
  if (c.flipH) f.push('hflip');
  if (c.flipV) f.push('vflip');
  if (anim(c, 'rot')) {
    f.push('format=rgba', `rotate='(${pwl(c.kf.rot, 't')})*PI/180':ow='ceil(hypot(iw,ih)/2)*2':oh='ceil(hypot(iw,ih)/2)*2':c=black@0`);
  } else if (c.rot) {
    const a = ((c.rot * Math.PI) / 180).toFixed(5);
    f.push('format=rgba', `rotate=${a}:ow=rotw(${a}):oh=roth(${a}):c=black@0`);
  }
  if (anim(c, 'scale')) {
    const e = pwl(c.kf.scale, 't');
    f.push(`scale=w='trunc(iw*(${e})/2)*2':h='trunc(ih*(${e})/2)*2':eval=frame`);
  } else if (val(c, 'scale') !== 1) {
    const s = val(c, 'scale');
    f.push(`scale=trunc(iw*${s}/2)*2:trunc(ih*${s}/2)*2`);
  }
  if (anim(c, 'opacity')) {
    f.push('format=yuva420p', `geq=lum='lum(X,Y)':cb='cb(X,Y)':cr='cr(X,Y)':a='alpha(X,Y)*(${pwl(c.kf.opacity, 'T')})'`);
  } else if (val(c, 'opacity') !== 1) {
    f.push('format=rgba', `colorchannelmixer=aa=${val(c, 'opacity').toFixed(3)}`);
  }
  return f.join(',');
}

function place(c, W, H, off) {
  const v = off ? `(t-${off.toFixed(3)})` : 't';
  const ex = anim(c, 'px') ? `${W}*(${pwl(c.kf.px, v)})` : ((c.px || 0) * W).toFixed(2);
  const ey = anim(c, 'py') ? `${H}*(${pwl(c.kf.py, v)})` : ((c.py || 0) * H).toFixed(2);
  return `x='(main_w-overlay_w)/2+${ex}':y='(main_h-overlay_h)/2+${ey}'`;
}

const achain = (c, d) =>
  `aresample=44100,aformat=channel_layouts=stereo,${c.rev && !c.freeze && c.kind !== 'audio' ? 'areverse,' : ''}volume=${(c.vol ?? 1).toFixed(2)},${c.freeze ? '' : tempo(spd(c))}${afade(c, d)}atrim=0:${d.toFixed(3)},asetpts=PTS-STARTPTS`;

const XF = new Set(['fade', 'fadeblack', 'fadewhite', 'fadegrays', 'dissolve', 'pixelize', 'radial', 'distance', 'hblur', 'zoomin', 'wipeleft', 'wiperight', 'wipeup', 'wipedown', 'wipetl', 'wipebr', 'slideleft', 'slideright', 'slideup', 'slidedown', 'smoothleft', 'smoothright', 'smoothup', 'smoothdown', 'circleopen', 'circleclose', 'circlecrop', 'rectcrop', 'vertopen', 'vertclose', 'horzopen', 'horzclose', 'diagtl', 'diagbr', 'squeezeh', 'squeezev', 'hlslice', 'vuslice']);

ipcMain.handle('export', async (_e, { clips, overlays = [], audios = [], texts, width: W, height: H, fps = 30, crf = 20, out }) => {
  if (job) return { ok: false, error: 'An export is already running' };
  FPS = fps;
  // a clip with a gap in front of it gets a black, silent filler segment before it
  clips = clips.flatMap((c) => (c.gap > 0.02 ? [{ kind: 'gap', gapD: c.gap }, { ...c, trans: undefined }] : [c]));
  // centered transitions: stretch each clip into the footage around the cut so the cut itself stays put
  clips = clips.map((c) => {
    if (c.kind === 'gap' || !(c.xea > 0 || c.xeb > 0)) return c;
    const s = c.speed || 1, n = { ...c, in: c.in - (c.xeb || 0) * s, out: c.out + (c.xea || 0) * s };
    if (c.xeb > 0 && c.kf) { n.kf = {}; for (const k in c.kf) n.kf[k] = c.kf[k].map(([t, v]) => [t + c.xeb, v]); }
    return n;
  });
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'clipforge-'));
  const args = ['-y', '-hide_banner', '-nostats', '-progress', 'pipe:1'];
  const vf = [], st = { idx: 0 };
  const ds = [];

  for (let i = 0; i < clips.length; i++) {
    const c = clips[i];
    if (c.kind === 'gap') {
      ds.push(c.gapD);
      vf.push(`color=c=black:s=${W}x${H}:r=${FPS}:d=${c.gapD.toFixed(3)},format=yuv420p,setsar=1[v${i}]`);
      vf.push(`anullsrc=r=44100:cl=stereo:d=${c.gapD.toFixed(3)}[a${i}]`);
      continue;
    }
    const { vi, d, ai: ai0 } = await addSource(c, args, st);
    ds.push(d);
    const pre = `${vbase(c, d)}${ckf(c)}${cf(c)}${vfade(c, d, false)}`;
    if (!isXf(c)) {
      vf.push(`[${vi}:v]${pre},scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2,setsar=1,format=yuv420p[v${i}]`);
    } else {
      vf.push(`[${vi}:v]${pre},${xform(c, W, H)}[t${i}]`);
      vf.push(`color=c=black:s=${W}x${H}:r=${FPS}:d=${d.toFixed(3)}[bg${i}]`);
      vf.push(`[bg${i}][t${i}]overlay=${place(c, W, H, 0)}:shortest=1,format=yuv420p,setpts=PTS-STARTPTS[v${i}]`);
    }
    let ai = ai0;
    if (ai === null) { ai = st.idx++; args.push('-f', 'lavfi', '-t', d.toFixed(3), '-i', 'anullsrc=r=44100:cl=stereo'); }
    vf.push(`[${ai}:a]${achain(c, d)}[a${i}]`);
  }

  // join clips: crossfade where a transition is set, hard cut otherwise
  let V = '[v0]', A = '[a0]', D = ds[0];
  for (let i = 1; i < clips.length; i++) {
    const t = clips[i].trans;
    const od = t ? (clips[i].xh || 0) : 0;
    if (od > 0.05) {
      vf.push(`${V}[v${i}]xfade=transition=${XF.has(t.type) ? t.type : 'fade'}:duration=${od.toFixed(3)}:offset=${(D - od).toFixed(3)},fps=${FPS}[xv${i}]`);
      vf.push(`${A}[a${i}]acrossfade=d=${od.toFixed(3)}[xa${i}]`);
      D += ds[i] - od;
    } else {
      vf.push(`${V}${A}[v${i}][a${i}]concat=n=2:v=1:a=1[cv${i}][xa${i}]`);
      vf.push(`[cv${i}]fps=${FPS}[xv${i}]`);
      D += ds[i];
    }
    V = `[xv${i}]`; A = `[xa${i}]`;
  }
  vf.push(`${V}null[vc]`, `${A}anull[ac]`);
  const total = D;

  let last = 'vc';
  const oa = [];
  for (let k = 0; k < overlays.length; k++) {
    const o = overlays[k];
    const { vi, d, ai } = await addSource(o, args, st);
    const e = o.start + d;
    vf.push(`[${vi}:v]${vbase(o, d)}${ckf(o)}${cf(o)}${vfade(o, d, true)},${xform(o, W, H)},setpts=PTS+${o.start.toFixed(3)}/TB[ov${k}]`);
    vf.push(`[${last}][ov${k}]overlay=${place(o, W, H, o.start)}:eof_action=pass:enable='between(t,${o.start.toFixed(3)},${e.toFixed(3)})'[vo${k}]`);
    last = `vo${k}`;
    if (ai !== null) {
      const ms = Math.round(o.start * 1000);
      vf.push(`[${ai}:a]${achain(o, d)},adelay=${ms}|${ms}[oa${oa.length}]`);
      oa.push(`[oa${oa.length}]`);
    }
  }
  for (const a of audios) {
    const { vi, d } = await addSource(a, args, st);
    const ms = Math.round(a.start * 1000);
    vf.push(`[${vi}:a]${achain(a, d)},adelay=${ms}|${ms}[oa${oa.length}]`);
    oa.push(`[oa${oa.length}]`);
  }
  let aout = 'ac';
  if (oa.length) {
    vf.push(`[ac]${oa.join('')}amix=inputs=${oa.length + 1}:duration=first:normalize=0[am]`);
    aout = 'am';
  }

  const FONTS = {
    'Arial': ['arial', 'arialbd', 'ariali', 'arialbi'], 'Impact': ['impact', 'impact', 'impact', 'impact'],
    'Times New Roman': ['times', 'timesbd', 'timesi', 'timesbi'], 'Verdana': ['verdana', 'verdanab', 'verdanai', 'verdanaz'],
    'Georgia': ['georgia', 'georgiab', 'georgiai', 'georgiaz'], 'Courier New': ['cour', 'courbd', 'couri', 'courbi'],
    'Comic Sans MS': ['comic', 'comicbd', 'comici', 'comicz'], 'Trebuchet MS': ['trebuc', 'trebucbd', 'trebucit', 'trebucbi'],
    'Segoe UI': ['segoeui', 'segoeuib', 'segoeuii', 'segoeuiz']
  };
  const fontFile = (t) => {
    const f = FONTS[t.font] || FONTS.Arial, i = (t.bold ? 1 : 0) + (t.italic ? 2 : 0);
    for (const n of [f[i], f[0], 'arial']) { const p = `C:/Windows/Fonts/${n}.ttf`; if (fs.existsSync(p)) return p; }
    return 'C:/Windows/Fonts/arial.ttf';
  };
  const k = H / 720;
  texts.forEach((t, i) => {
    const tf = path.join(tmp, `t${i}.txt`);
    fs.writeFileSync(tf, t.text, 'utf8');
    const col = t.color.replace('#', '0x');
    const box = t.box ? ':box=1:boxcolor=black@0.5:boxborderw=12' : '';
    const next = `vt${i}`;
    const style = (t.ow > 0 ? `:borderw=${Math.round(t.ow * k)}:bordercolor=0x${(t.oc || '#000000').slice(1)}` : '') + (t.sh ? `:shadowx=${Math.max(1, Math.round(3 * k))}:shadowy=${Math.max(1, Math.round(3 * k))}:shadowcolor=black@0.6` : '');
    // fade / slide animation, written as ffmpeg expressions of time
    const ad = t.animDur || 0.4, dist = Math.round(80 * k), DIR = { slideup: [0, -1], slidedown: [0, 1], slideleft: [-1, 0], slideright: [1, 0] };
    const pin = `clip((t-${t.start.toFixed(3)})/${ad},0,1)`, pout = `clip((${t.end.toFixed(3)}-t)/${ad},0,1)`;
    const xo = [], yo = [], al = [];
    if (t.animIn === 'fade') al.push(pin); else if (DIR[t.animIn]) { xo.push(`${-DIR[t.animIn][0] * dist}*(1-${pin})`); yo.push(`${-DIR[t.animIn][1] * dist}*(1-${pin})`); }
    if (t.animOut === 'fade') al.push(pout); else if (DIR[t.animOut]) { xo.push(`${DIR[t.animOut][0] * dist}*(1-${pout})`); yo.push(`${DIR[t.animOut][1] * dist}*(1-${pout})`); }
    const alphaOpt = al.length ? `:alpha='${al.join('*')}'` : '';
    vf.push(`[${last}]drawtext=fontfile='${esc(fontFile(t))}':textfile='${esc(tf)}':fontsize=${Math.round(t.size * k)}:fontcolor=${col}:x='w*${t.x.toFixed(4)}-text_w/2+(${xo.join('+') || '0'})':y='h*${t.y.toFixed(4)}-text_h/2+(${yo.join('+') || '0'})'${alphaOpt}${box}${style}:enable='between(t,${t.start.toFixed(3)},${t.end.toFixed(3)})'[${next}]`);
    last = next;
  });

  args.push('-filter_complex', vf.join(';'), '-map', `[${last}]`, '-map', `[${aout}]`,
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', String(crf), '-pix_fmt', 'yuv420p', '-r', String(FPS),
    '-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart', out);

  return new Promise((resolve) => {
    let errBuf = '';
    job = spawn(ffmpeg, args);
    job.stdout.on('data', (d) => {
      const m = /out_time_us=(\d+)/.exec(d.toString());
      if (m) win.webContents.send('progress', Math.min(1, Number(m[1]) / 1e6 / total));
    });
    job.stderr.on('data', (d) => { errBuf = (errBuf + d).slice(-4000); });
    job.on('close', (code) => {
      const cancelled = job && job.killed;
      job = null;
      fs.rmSync(tmp, { recursive: true, force: true });
      resolve(code === 0 ? { ok: true } : { ok: false, error: cancelled ? 'Cancelled' : errBuf });
    });
  });
});

ipcMain.handle('cancelExport', () => { if (job) job.kill(); });

/* ---- auto-captions: Whisper runs in the app window via WebAssembly; this serves its files on loopback only ---- */
const http = require('http');
const ASSET_ROOT = app.isPackaged ? process.resourcesPath : __dirname;
let assetPort = null;
function startAssetServer() {
  if (assetPort) return Promise.resolve(assetPort);
  return new Promise((resolve) => {
    const srv = http.createServer((q, r) => {
      const u = decodeURIComponent(q.url.split('?')[0]);
      if (!/^\/(vendor|models)\//.test(u) || u.includes('..')) { r.writeHead(404); return r.end(); }
      const f = path.join(ASSET_ROOT, u);
      fs.stat(f, (e, s) => {
        if (e || !s.isFile()) { r.writeHead(404); return r.end(); }
        const t = { '.js': 'text/javascript', '.mjs': 'text/javascript', '.wasm': 'application/wasm', '.json': 'application/json' }[path.extname(f)] || 'application/octet-stream';
        r.writeHead(200, { 'Content-Type': t, 'Content-Length': s.size, 'Access-Control-Allow-Origin': '*' });
        fs.createReadStream(f).pipe(r);
      });
    });
    srv.listen(0, '127.0.0.1', () => { assetPort = srv.address().port; resolve(assetPort); });
  });
}
ipcMain.handle('asrPort', () => startAssetServer());
ipcMain.handle('extractAudio', (_e, { path: p, from, len }) => new Promise((resolve, reject) => {
  const chunks = [];
  const f = spawn(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-ss', String(from), '-t', String(len), '-i', p, '-vn', '-ac', '1', '-ar', '16000', '-f', 'f32le', 'pipe:1']);
  f.stdout.on('data', (d) => chunks.push(d));
  f.on('error', reject);
  f.on('close', (code) => (code === 0 ? resolve(Buffer.concat(chunks)) : reject(new Error('Could not read the audio'))));
}));



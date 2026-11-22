/* ---------- settings, themes and the home screen ---------- */
const THEMES = [
  ['midnight', 'Midnight', '#14161a', '#00d1c1'],
  ['violet', 'Violet', '#15131c', '#a78bfa'],
  ['ocean', 'Ocean', '#0f1720', '#38bdf8'],
  ['sunset', 'Sunset', '#1a1412', '#ff8a3d'],
  ['forest', 'Forest', '#121a15', '#4ade80'],
  ['light', 'Light', '#e9ecf1', '#0891b2']
];
const CFG = Object.assign({ theme: 'midnight', aspect: '16:9', quality: '1080', fps: '30', autosave: 10, home: true }, (() => {
  try { return JSON.parse(localStorage.getItem('qcSettings')) || {}; } catch (e) { return {}; }
})());
const saveCfg = () => { try { localStorage.setItem('qcSettings', JSON.stringify(CFG)); } catch (e) {} };

function applyTheme() {
  document.documentElement.dataset.theme = CFG.theme;
  document.querySelectorAll('.thm').forEach((b) => b.classList.toggle('on', b.dataset.t === CFG.theme));
}
function applyExportDefaults() { $('quality').value = CFG.quality; $('fps').value = CFG.fps; }

/* settings page */
$('themes').innerHTML = THEMES.map(([k, n, bg, ac]) =>
  `<button class="thm" data-t="${k}"><i style="background:linear-gradient(135deg,${bg} 55%,${ac} 55%)"></i><span>${n}</span></button>`).join('');
$('themes').onclick = (e) => { const b = e.target.closest('.thm'); if (b) { CFG.theme = b.dataset.t; saveCfg(); applyTheme(); } };
const bindSel = (id, key, after) => { const el = $(id); el.value = CFG[key]; el.onchange = () => { CFG[key] = key === 'autosave' ? +el.value : el.value; saveCfg(); if (after) after(); }; };
bindSel('sAspect', 'aspect'); bindSel('sQual', 'quality', applyExportDefaults); bindSel('sFps', 'fps', applyExportDefaults); bindSel('sAuto', 'autosave');
$('sHome').checked = CFG.home; $('sHome').onchange = () => { CFG.home = $('sHome').checked; saveCfg(); };
$('sClear').onclick = async () => { await api.recentClear(); drawRecent(); };
applyTheme(); applyExportDefaults();

/* home screen */
const homeEl = $('home');
const hasWork = () => S.clips.length || S.overlays.length || S.audios.length || S.texts.length || S.file;
function showHome() {
  pause(); homeEl.hidden = false; $('homeBack').hidden = !hasWork(); gotoPage('pgHome'); drawRecent();
}
function hideHome() { homeEl.hidden = true; }
function gotoPage(id) {
  homeEl.querySelectorAll('.pg').forEach((p) => { p.hidden = p.id !== id; });
  homeEl.querySelectorAll('.hn[data-pg]').forEach((b) => b.classList.toggle('on', b.dataset.pg === id));
}
homeEl.querySelectorAll('.hn[data-pg]').forEach((b) => { b.onclick = () => gotoPage(b.dataset.pg); });
$('homeBack').onclick = hideHome;
$('homeBtn').onclick = showHome;

const fmtDur = (s) => `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
const fmtDate = (t) => { const d = new Date(t), n = new Date(); return d.toDateString() === n.toDateString() ? 'Today' : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: d.getFullYear() === n.getFullYear() ? undefined : 'numeric' }); };
async function drawRecent() {
  const list = await api.recentList(), box = $('pList');
  box.innerHTML = '';
  if (!list.length) { box.innerHTML = '<div class="hint-inline">No projects yet. Create one, then save it and it will show up here.</div>'; return; }
  for (const r of list) {
    const d = document.createElement('div'); d.className = 'pcard' + (r.missing ? ' miss' : ''); d.title = r.file;
    const t = document.createElement('div'); t.className = 'pt';
    if (r.thumb) t.style.backgroundImage = `url(${r.thumb})`; else t.textContent = 'No preview';
    const n = document.createElement('div'); n.className = 'pn'; n.textContent = r.name;
    const m = document.createElement('div'); m.className = 'pm'; m.textContent = `${fmtDate(r.time)} | ${fmtDur(r.dur || 0)}${r.missing ? ' | file missing' : ''}`;
    const x = document.createElement('button'); x.className = 'px'; x.textContent = '×'; x.title = 'Remove from the list (the file is kept)';
    x.onclick = async (e) => { e.stopPropagation(); await api.recentRemove(r.file); drawRecent(); };
    d.append(t, n, m, x);
    d.onclick = async () => {
      if (r.missing) return alert('That project file was moved or deleted.');
      if (hasWork() && r.file !== S.file && !confirm('Open this project? Unsaved changes in the current one will be lost.')) return;
      const p = await api.readProject(r.file);
      if (!p) return alert('Could not read that project file.');
      loadProject(p);
    };
    box.appendChild(d);
  }
}

function createProject() {
  if (!newProject()) return;
  S.aspect = CFG.aspect; $('aspect').value = S.aspect; fitStage(); lastAuto = projData();
  hideHome();
}
$('hCreate').onclick = createProject;
$('newBtn').onclick = createProject;
$('hOpen').onclick = async () => { const r = await api.openProject(); if (r) loadProject(r); };

if (CFG.home) drawRecent(); else hideHome();

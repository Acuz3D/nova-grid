const grid = document.getElementById('grid');
const empty = document.getElementById('empty');
const count = document.getElementById('count');

const panes = []; // { id, cwd, effort, model, el, term, fit, statusEl, running }
let nextId = 1;
let focused = null;
let enlarged = null;

// The terminal itself is see-through; the pane behind it supplies the
// (possibly translucent) background colour so a background video can show.
const theme = {
  background: 'rgba(0, 0, 0, 0)',
  foreground: '#e4e4e4',
  cursor: '#f5f5f5',
  cursorAccent: '#0b0b0c',
  selectionBackground: 'rgba(255, 255, 255, 0.2)',
};

// Thin line icons (24×24, drawn with the text colour).
const ICONS = {
  plus: '<path d="M12 5v14M5 12h14"/>',
  close: '<path d="M6 6l12 12M18 6L6 18"/>',
  restart: '<path d="M20 12a8 8 0 1 1-2.34-5.66"/><path d="M20 4v5h-5"/>',
  enlarge: '<path d="M14 4h6v6M10 20H4v-6M20 4l-6.5 6.5M4 20l6.5-6.5"/>',
  image: '<rect x="3" y="5" width="18" height="14" rx="2.5"/><path d="M3 16l5-4.5 4 3.5 3-2.5 6 5"/><circle cx="16" cy="9.5" r="1.3"/>',
  slash: '<rect x="3" y="3" width="18" height="18" rx="4"/><path d="M14.5 7.5l-5 9"/>',
  soundOn: '<path d="M4 9.5h3.5L12 6v12l-4.5-3.5H4z"/><path d="M15.5 9.5a3.5 3.5 0 0 1 0 5M18 7a7 7 0 0 1 0 10"/>',
  soundOff: '<path d="M4 9.5h3.5L12 6v12l-4.5-3.5H4z"/><path d="M16 10l4 4M20 10l-4 4"/>',
  winMin: '<path d="M6 12h12"/>',
  winMax: '<rect x="6" y="6" width="12" height="12" rx="1.5"/>',
  winRestore: '<rect x="5" y="9" width="10" height="10" rx="1.5"/><path d="M9 9V6.5A1.5 1.5 0 0 1 10.5 5h7A1.5 1.5 0 0 1 19 6.5v7a1.5 1.5 0 0 1-1.5 1.5H15"/>',
  winClose: '<path d="M7 7l10 10M17 7L7 17"/>',
};
const icon = (name) => `<svg class="icon" viewBox="0 0 24 24">${ICONS[name]}</svg>`;
document.querySelectorAll('[data-icon]').forEach((el) => (el.outerHTML = icon(el.dataset.icon)));

function folderName(cwd) {
  return cwd.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || cwd;
}

function save() {
  window.api.savePanes(panes.map((p) => (p.app ? { app: p.app } : { cwd: p.cwd, effort: p.effort, model: p.model })));
}

// Pick a column count that keeps the panes close to square-ish.
function layout() {
  const visible = enlarged ? [enlarged] : panes;
  const n = visible.length;
  const cols = n <= 1 ? 1 : n <= 2 ? 2 : n <= 4 ? 2 : n <= 6 ? 3 : Math.ceil(Math.sqrt(n));
  const rows = Math.max(1, Math.ceil(n / cols));
  grid.style.gridTemplateColumns = `repeat(${cols}, 1fr)`;
  grid.style.gridTemplateRows = `repeat(${rows}, 1fr)`;

  panes.forEach((p, i) => {
    p.el.classList.toggle('hidden', !!enlarged && p !== enlarged);
    p.el.querySelector('.pane-num').textContent = i < 9 ? `${i + 1}` : '';
  });

  empty.classList.toggle('show', panes.length === 0);
  count.textContent = panes.length ? `${panes.length} open` : '';
  visible.forEach(fitPane);
  placeApps();
}

function fitPane(p) {
  if (p.app || p.el.classList.contains('hidden')) return;
  try {
    p.fit.fit();
  } catch {}
  if (p.running) window.api.resize(p.id, p.term.cols, p.term.rows);
}

function setFocus(p) {
  focused = p;
  panes.forEach((x) => x.el.classList.toggle('focused', x === p));
  if (p?.app) window.api.focusApp(p.id);
  else p?.term.focus();
}

function toggleEnlarge(p) {
  enlarged = enlarged === p ? null : p;
  layout();
  setFocus(p);
}

function setStatus(p, text, exited = false) {
  p.statusEl.textContent = text;
  p.statusEl.classList.toggle('exited', exited);
}

// resume: carry on the pane's current conversation instead of starting fresh.
async function startClaude(p, resume = false) {
  p.term.reset();
  p.startedAt = Date.now();
  setStatus(p, 'starting…');
  try {
    p.fit.fit();
  } catch {}
  const res = await window.api.start({ id: p.id, cwd: p.cwd, cols: p.term.cols, rows: p.term.rows, effort: p.effort, model: p.model, resume: resume ? p.session : null });
  if (res.error) {
    p.running = false;
    p.term.write(`\x1b[31m${res.error}\x1b[0m\r\n`);
    setStatus(p, 'failed', true);
    return;
  }
  p.running = true;
  setStatus(p, '');
}

// Handle copy/paste and app shortcuts before xterm turns them into control codes.
function keyHandler(p) {
  return (e) => {
    if (e.type !== 'keydown') return true;

    if (e.ctrlKey && !e.shiftKey && e.key === 'c' && p.term.hasSelection()) {
      window.api.copy(p.term.getSelection());
      p.term.clearSelection();
      return false;
    }
    if (e.ctrlKey && e.key.toLowerCase() === 'v') {
      e.preventDefault();
      window.api.paste().then((text) => text && p.term.paste(text));
      return false;
    }
    // Shift+Enter = new line inside a Claude prompt instead of sending it
    if (e.shiftKey && e.key === 'Enter') {
      if (p.running) window.api.write(p.id, '\x1b\r');
      return false;
    }
    if (isAppShortcut(e) || e.key === 'F1') return false;
    return true;
  };
}

function isAppShortcut(e) {
  if (!e.ctrlKey) return false;
  if (e.shiftKey && ['T', 'W', 'ENTER'].includes(e.key.toUpperCase())) return true;
  if (!e.shiftKey && /^[1-9]$/.test(e.key)) return true;
  return false;
}

function createPane(cwd, effort = '', model = '') {
  const id = `pane-${nextId++}`;
  const el = document.createElement('section');
  el.className = 'pane';
  el.innerHTML = `
    <div class="pane-header" title="Double-click to enlarge / shrink">
      <span class="pane-num"></span>
      <span class="pane-title"></span>
      <span class="pane-path"></span>
      <span class="pane-status"></span>
      <button class="mcp" title="MCP servers: checking…">MCP …</button>
      <select class="model" title="Which Claude model this terminal uses">
        <option value="">model: default</option>
        <option value="fable">Fable</option>
        <option value="opus">Opus</option>
        <option value="sonnet">Sonnet</option>
        <option value="haiku">Haiku</option>
      </select>
      <select class="effort" title="Claude's effort level for this terminal">
        <option value="">effort: default</option>
        <option value="low">effort: low</option>
        <option value="medium">effort: medium</option>
        <option value="high">effort: high</option>
        <option value="xhigh">effort: xhigh</option>
        <option value="max">effort: max</option>
      </select>
      <button class="restart icon-btn" title="Restart Claude in this folder">${icon('restart')}</button>
      <button class="enlarge icon-btn" title="Enlarge / shrink (Ctrl+Shift+Enter)">${icon('enlarge')}</button>
      <button class="close icon-btn" title="Close (Ctrl+Shift+W)">${icon('close')}</button>
    </div>
    <div class="pane-body"></div>`;
  el.querySelector('.pane-title').textContent = folderName(cwd);
  el.querySelector('.pane-path').textContent = cwd;
  el.querySelector('.pane-path').title = cwd;
  grid.appendChild(el);

  const term = new Terminal({
    fontFamily: "'Cascadia Mono', Consolas, monospace",
    fontSize: 13,
    cursorBlink: true,
    scrollback: 5000,
    allowProposedApi: true,
    allowTransparency: true,
    theme,
  });
  const fit = new FitAddon.FitAddon();
  term.loadAddon(fit);
  term.open(el.querySelector('.pane-body'));

  const p = { id, cwd, effort, model, el, term, fit, statusEl: el.querySelector('.pane-status'), running: false };
  panes.push(p);

  term.attachCustomKeyEventHandler(keyHandler(p));
  term.onData((data) => {
    if (p.running) window.api.write(id, data);
    else if (data === '\r') startClaude(p); // Enter restarts after exit
  });
  term.textarea?.addEventListener('focus', () => setFocus(p));
  el.addEventListener('mousedown', () => setFocus(p));

  const header = el.querySelector('.pane-header');
  header.addEventListener('dblclick', (e) => {
    if (e.target.tagName !== 'BUTTON') toggleEnlarge(p);
  });
  el.querySelector('.restart').addEventListener('click', () => restartPane(p));
  el.querySelector('.mcp').addEventListener('click', () => showMcp(p, true));
  showMcp(p);
  for (const option of ['model', 'effort']) {
    const select = el.querySelector(`.${option}`);
    select.value = p[option];
    select.addEventListener('change', () => setOption(p, option, select.value));
  }
  el.querySelector('.enlarge').addEventListener('click', () => toggleEnlarge(p));
  el.querySelector('.close').addEventListener('click', () => closePane(p));

  new ResizeObserver(() => fitPane(p)).observe(el.querySelector('.pane-body'));
  return p;
}

// The MCP servers Claude can use in this pane's folder: connected ones are
// listed by name, the rest are counted, and hovering shows each one's status.
const MCP_MARK = { connected: '✔', auth: '!', failed: '✗' };

async function showMcp(p, refresh = false) {
  const button = p.el.querySelector('.mcp');
  button.textContent = 'MCP …';
  button.title = 'MCP servers: checking…';
  button.className = 'mcp';
  const result = await window.api.listMcp(p.cwd, refresh);
  if (!p.el.isConnected) return; // pane closed meanwhile

  if (result.error) {
    button.textContent = 'MCP ?';
    button.title = `${result.error}. Click to try again.`;
    return;
  }
  const servers = result.servers;
  const connected = servers.filter((s) => s.status === 'connected').map((s) => s.name);
  const other = servers.length - connected.length;
  button.textContent = servers.length
    ? `MCP: ${connected.join(', ') || 'none connected'}${other ? ` (+${other} not connected)` : ''}`
    : 'MCP: none';
  button.classList.toggle('warn', other > 0);
  button.title =
    (servers.length ? servers.map((s) => `${MCP_MARK[s.status]} ${s.name}: ${s.statusText}`).join('\n') : 'No MCP servers set up for this folder') +
    '\n\nClick to check again';
}

// A running pane is restarted on the same conversation with the new
// --model / --effort. (Typing /model or /effort instead would also change
// the user's default for every other Claude session.)
function setOption(p, option, value) {
  p[option] = value;
  save();
  if (p.running) restartPane(p, true);
  p.term.focus();
}

function restartPane(p, resume = false) {
  if (p.running) window.api.kill(p.id);
  p.running = false;
  startClaude(p, resume);
}

function closePane(p) {
  if (p.app) window.api.releaseApp(p.id);
  else {
    window.api.kill(p.id);
    p.running = false;
    p.term.dispose();
  }
  p.el.remove();
  const i = panes.indexOf(p);
  panes.splice(i, 1);
  if (enlarged === p) enlarged = null;
  save();
  layout();
  setFocus(panes[Math.min(i, panes.length - 1)] || null);
}

async function addPane() {
  const cwd = await window.api.pickFolder();
  if (!cwd) return;
  enlarged = null;
  const p = createPane(cwd);
  save();
  layout();
  setFocus(p);
  startClaude(p);
}

window.api.onData((id, data) => {
  panes.find((p) => p.id === id)?.term.write(data);
});

window.api.onExit((id, code) => {
  const p = panes.find((x) => x.id === id);
  if (!p || !p.running) return;
  p.running = false;
  setStatus(p, `exited (${code})`, true);
  p.term.write('\r\n\x1b[90m[Claude exited — press Enter to start it again]\x1b[0m\r\n');
});

// Usage limits are for the whole account, so every pane reports the same
// numbers; show whichever pane reported most recently.
const LIMITS = [
  ['five_hour', 'Session', 'The rolling 5-hour usage limit'],
  ['seven_day', 'Weekly', 'The weekly usage limit'],
  ['fable', 'Fable', 'The weekly Fable limit'],
];

function formatReset(seconds) {
  // nearest minute: reset times can come back a moment either side of the hour
  const when = new Date(Math.round(seconds / 60) * 60 * 1000);
  const time = when.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const soon = when - Date.now() < 24 * 60 * 60 * 1000;
  return soon ? time : `${when.toLocaleDateString([], { weekday: 'short' })} ${time}`;
}

// Limits come from two places: the panes' status lines (session and weekly,
// only in some updates) and the app's own check with Anthropic every few
// minutes (which also has Fable). Keep the newest of each, including across
// restarts of the app, rather than blanking out.
let lastLimits = JSON.parse(localStorage.getItem('lastLimits') || 'null');
let accountError = null;

// Each limit keeps its own timestamp, since the two sources report different ones.
function mergeLimits(at, rateLimits) {
  const merged = { ...lastLimits?.rate_limits };
  for (const [key, limit] of Object.entries(rateLimits)) {
    if (!limit || at <= (merged[key]?.at ?? 0)) continue;
    merged[key] = { ...limit, at };
  }
  lastLimits = { rate_limits: merged };
  localStorage.setItem('lastLimits', JSON.stringify(lastLimits));
}

// Anthropic's answer -> the same shape the status line uses.
function fromAccountUsage(limits) {
  const toLimit = (percent, resetsAt) =>
    percent == null ? undefined : { used_percentage: percent, resets_at: resetsAt ? Date.parse(resetsAt) / 1000 : null };
  const fable = (limits.limits || []).find((l) => l.scope?.model?.display_name === 'Fable');
  const converted = {
    five_hour: toLimit(limits.five_hour?.utilization, limits.five_hour?.resets_at),
    seven_day: toLimit(limits.seven_day?.utilization, limits.seven_day?.resets_at),
    fable: fable ? toLimit(fable.percent, fable.resets_at) : toLimit(0, null),
  };
  return Object.fromEntries(Object.entries(converted).filter(([, v]) => v));
}

function renderUsage(byPane) {
  const newest = Object.values(byPane)
    .filter((d) => d.rate_limits)
    .sort((a, b) => b.at - a.at)[0];
  if (newest) mergeLimits(newest.at, newest.rate_limits);
  const latest = lastLimits;
  const usage = document.getElementById('usage');
  usage.replaceChildren();

  for (const [key, name, about] of LIMITS) {
    let limit = latest?.rate_limits[key];
    // past its reset time, the saved number no longer applies
    if (limit?.resets_at && limit.resets_at * 1000 < Date.now()) limit = { used_percentage: 0 };
    const pct = limit ? Math.round(limit.used_percentage) : null;
    const el = document.createElement('span');
    el.className = 'limit';
    el.title = about + (limit?.resets_at ? `\nResets ${formatReset(limit.resets_at)}` : '');
    if (key === 'fable' && accountError) el.title += `\nLast check failed: ${accountError}`;
    el.innerHTML = `<span class="limit-name"></span><span class="bar"><span class="fill"></span></span><span class="limit-pct"></span><span class="limit-reset"></span>`;
    el.querySelector('.limit-name').textContent = name;
    el.querySelector('.limit-pct').textContent = pct === null ? '–' : `${pct}%`;
    el.querySelector('.limit-reset').textContent = limit?.resets_at ? `resets ${formatReset(limit.resets_at)}` : '';
    const fill = el.querySelector('.fill');
    fill.style.width = `${Math.min(pct ?? 0, 100)}%`;
    fill.classList.toggle('warn', pct >= 70);
    fill.classList.toggle('high', pct >= 90);
    usage.appendChild(el);
  }
}

// Keep each pane's dropdowns in step with what Claude reports, so changes made
// with /model or /effort inside the terminal show up here too. While a dropdown
// is on "default", its label shows what the default turned out to be.
function syncOptions(byPane) {
  for (const p of panes) {
    const info = byPane[p.id];
    // ignore reports left over from before this pane last (re)started
    if (!info || info.at < p.startedAt) continue;
    if (info.session_id) p.session = { id: info.session_id, transcript: info.transcript_path };
    const modelId = info.model?.id || '';
    const reported = {
      model: ['fable', 'opus', 'sonnet', 'haiku'].find((m) => modelId.includes(m)),
      effort: info.effort?.level,
    };
    const shown = { model: info.model?.display_name, effort: reported.effort };

    for (const option of ['model', 'effort']) {
      const select = p.el.querySelector(`.${option}`);
      select.options[0].textContent = shown[option] ? `${option}: default (${shown[option]})` : `${option}: default`;
      if (p[option] && reported[option] && reported[option] !== p[option]) {
        p[option] = reported[option];
        select.value = reported[option];
        save();
      }
    }
  }
}

window.api.onAccountUsage((result) => {
  accountError = result.error || null;
  if (result.limits) mergeLimits(result.at, fromAccountUsage(result.limits));
  renderUsage({});
});

window.api.onUsage((byPane) => {
  renderUsage(byPane);
  syncOptions(byPane);
});
renderUsage({});
setInterval(() => renderUsage({}), 60 * 1000); // so passed reset times show up

// Background video. Terminal opacity only applies while a video is playing,
// so without one the panes stay solid.
const bgVideo = document.getElementById('bg-video');
const bgPanel = document.getElementById('bg-panel');
const bgOpacity = document.getElementById('bg-opacity');
const bgSound = document.getElementById('bg-sound');
const bgVolume = document.getElementById('bg-volume');
const bgAutoNext = document.getElementById('bg-auto-next');
let background = { path: null, url: null, opacity: 70, muted: true, volume: 30 };

function applyBackground() {
  const playing = !!background.url;
  if (playing && bgVideo.src !== background.url) bgVideo.src = background.url;
  if (!playing) bgVideo.removeAttribute('src');
  bgVideo.classList.toggle('show', playing);
  bgVideo.muted = background.muted;
  bgVideo.volume = background.volume / 100;
  if (playing) bgVideo.play().catch(() => {});
  else bgVideo.load();

  bgSound.innerHTML = icon(background.muted ? 'soundOff' : 'soundOn');
  bgSound.title = background.muted ? 'Sound is off. Click to turn it on' : 'Sound is on. Click to turn it off';
  bgSound.disabled = !playing;
  showLoopSection();

  bgVolume.value = background.volume;
  document.getElementById('bg-volume-value').textContent = `${background.volume}%`;
  bgOpacity.value = background.opacity;
  document.getElementById('bg-opacity-value').textContent = `${background.opacity}%`;
  document.getElementById('bg-remove').disabled = !playing;
  bgAutoNext.checked = !!background.autoNext;
  renderLibrary();
  document.documentElement.style.setProperty('--pane-alpha', playing ? background.opacity / 100 : 1);
}

async function saveBackground() {
  background = await window.api.saveBackground(background);
  applyBackground();
}

document.getElementById('bg-btn').addEventListener('click', () => bgPanel.classList.toggle('open'));
bgAutoNext.addEventListener('change', () => {
  background.autoNext = bgAutoNext.checked;
  saveBackground();
});
bgSound.addEventListener('click', () => {
  background.muted = !background.muted;
  saveBackground();
});
document.addEventListener('mousedown', (e) => {
  if (!e.target.closest('#bg-menu')) bgPanel.classList.remove('open');
});
// Library of imported backgrounds. Each video keeps its own loop section.
let library = [];
const fileName = (p) => (p || '').split(/[\\/]/).pop();
const isCurrent = (video) => fileName(background.path).toLowerCase() === video.file.toLowerCase();

function renderLibrary() {
  const list = document.getElementById('bg-list');
  list.replaceChildren();
  if (!library.length) {
    list.innerHTML = '<p class="bg-note">No backgrounds yet. Import a video to add one.</p>';
    return;
  }
  for (const video of library) {
    const row = document.createElement('div');
    row.className = 'bg-item' + (isCurrent(video) ? ' current' : '');
    row.innerHTML = '<button class="bg-pick"></button><button class="bg-delete" title="Move to the Recycle Bin">' + icon('close') + '</button>';
    row.querySelector('.bg-pick').textContent = video.name;
    row.querySelector('.bg-pick').title = `Play ${video.name}`;
    row.querySelector('.bg-pick').addEventListener('click', () => selectVideo(video.path));
    row.querySelector('.bg-delete').addEventListener('click', () => removeVideo(video));
    list.appendChild(row);
  }
}

function selectVideo(path) {
  background.loops = background.loops || {};
  // remember where the current video was looping before switching away
  if (background.path) background.loops[fileName(background.path)] = { start: background.start, end: background.end };
  const saved = path ? background.loops[fileName(path)] : null;
  background.path = path;
  background.start = saved?.start ?? 0;
  background.end = saved?.end ?? null; // null = to the end
  return saveBackground();
}

async function removeVideo(video) {
  if (isCurrent(video)) await selectVideo(null);
  delete background.loops?.[video.file];
  library = await window.api.removeVideo(video.file);
  await saveBackground();
}

document.getElementById('bg-import').addEventListener('click', async () => {
  const { library: updated, imported } = await window.api.importVideos();
  library = updated;
  if (imported.length) await selectVideo(imported[imported.length - 1]);
  else renderLibrary();
});
document.getElementById('bg-remove').addEventListener('click', () => selectVideo(null));

// Add from a link: the app downloads the video into the library.
const bgUrl = document.getElementById('bg-url');
const bgAddLink = document.getElementById('bg-add-link');
const bgStatus = document.getElementById('bg-status');

async function addFromLink() {
  const url = bgUrl.value.trim();
  if (!/^https?:\/\//i.test(url)) {
    bgStatus.textContent = 'Paste a full link starting with https://';
    return;
  }
  bgAddLink.disabled = bgUrl.disabled = true;
  bgStatus.textContent = 'Downloading…';
  const result = await window.api.downloadVideo(url);
  bgAddLink.disabled = bgUrl.disabled = false;
  if (result.error) {
    bgStatus.textContent = result.error;
    return;
  }
  bgUrl.value = '';
  bgStatus.textContent = `Added "${result.title}".`;
  library = result.library;
  await selectVideo(result.imported);
}

bgAddLink.addEventListener('click', addFromLink);
bgUrl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') addFromLink();
});
// yt-dlp fetches the picture and then the sound, so this runs to 100% twice for YouTube.
window.api.onDownloadProgress((pct) => {
  bgStatus.textContent = `Downloading… ${Math.floor(pct)}%`;
});
bgOpacity.addEventListener('input', () => {
  background.opacity = Number(bgOpacity.value);
  applyBackground();
});
bgOpacity.addEventListener('change', saveBackground);
// Turning the volume up also turns the sound on, so the slider does what it looks like.
bgVolume.addEventListener('input', () => {
  background.volume = Number(bgVolume.value);
  if (background.volume > 0) background.muted = false;
  applyBackground();
});
bgVolume.addEventListener('change', saveBackground);

// Loop section: only the part between "Play from" and "Play until" plays.
const bgStart = document.getElementById('bg-start');
const bgEnd = document.getElementById('bg-end');
const formatTime = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

function loopSection() {
  const duration = bgVideo.duration || 0;
  const start = Math.min(background.start || 0, Math.max(duration - 0.5, 0));
  const end = Math.min(background.end ?? duration, duration);
  return { duration, start, end: Math.max(end, start + 0.5) };
}

function showLoopSection() {
  const { duration, start, end } = loopSection();
  bgStart.max = bgEnd.max = duration;
  bgStart.value = start;
  bgEnd.value = end;
  document.getElementById('bg-start-value').textContent = formatTime(start);
  document.getElementById('bg-end-value').textContent = formatTime(end);
  document.getElementById('bg-length').textContent = duration ? `Playing ${formatTime(end - start)} of ${formatTime(duration)}.` : '';
  bgStart.disabled = bgEnd.disabled = !duration;
}

function onLoopSlider(which) {
  const value = Number((which === 'start' ? bgStart : bgEnd).value);
  const { duration, start, end } = loopSection();
  // keep at least half a second between the two
  if (which === 'start') background.start = Math.min(value, end - 0.5);
  else background.end = Math.max(value, start + 0.5) >= duration ? null : Math.max(value, start + 0.5);
  showLoopSection();
  bgVideo.currentTime = loopSection().start;
}

bgStart.addEventListener('input', () => onLoopSlider('start'));
bgEnd.addEventListener('input', () => onLoopSlider('end'));
bgStart.addEventListener('change', saveBackground);
bgEnd.addEventListener('change', saveBackground);
bgVideo.addEventListener('loadedmetadata', () => {
  showLoopSection();
  bgVideo.currentTime = loopSection().start;
});
// At the end of the looped part: start it again, or with "play the next video"
// on, switch to the next one in the library (back to the first after the last).
let switchingVideo = false;

function endOfSection() {
  if (switchingVideo) return;
  if (background.autoNext && library.length > 1) {
    switchingVideo = true;
    const next = library[(library.findIndex(isCurrent) + 1) % library.length];
    selectVideo(next.path).finally(() => (switchingVideo = false));
    return;
  }
  bgVideo.currentTime = loopSection().start;
  bgVideo.play().catch(() => {});
}

bgVideo.addEventListener('timeupdate', () => {
  const { start, end } = loopSection();
  if (bgVideo.currentTime >= end) endOfSection();
  else if (bgVideo.currentTime < start - 0.3) bgVideo.currentTime = start;
});
bgVideo.addEventListener('ended', endOfSection);
bgVideo.addEventListener('error', () => {
  if (background.url) console.error('Background video could not be played:', background.path);
});

Promise.all([window.api.loadBackground(), window.api.listLibrary()]).then(([saved, videos]) => {
  library = videos;
  background = { ...background, ...saved, opacity: saved?.opacity ?? background.opacity, muted: saved?.muted ?? true, volume: saved?.volume ?? background.volume };
  applyBackground();
});

// Commands sheet: Claude's / commands from commands.js, grouped, with a
// search box. Clicking one types it into the selected terminal.
const keysSheet = document.getElementById('keys-sheet');
const keysSearch = document.getElementById('keys-search');
const keysList = document.getElementById('keys-list');

// "/model [model]" -> /model in white, its options dimmed
function commandEl(command) {
  const [name, ...options] = command.split(' ');
  const el = document.createElement('span');
  el.className = 'cmd';
  el.innerHTML = '<span class="cmd-name"></span> <span class="cmd-args"></span>';
  el.firstChild.textContent = name;
  el.lastChild.textContent = options.join(' ');
  return el;
}

function typeCommand(command) {
  const name = command.split(' ')[0];
  toggleKeys(false);
  if (focused && !focused.app && focused.running) window.api.write(focused.id, `${name} `);
}

function renderKeys() {
  const words = keysSearch.value.toLowerCase().split(/\s+/).filter(Boolean);
  const cols = document.createElement('div');
  cols.className = 'keys-cols';
  keysList.replaceChildren(cols);
  for (const group of COMMANDS) {
    const rows = group.commands.filter(([command, what, note = '']) => {
      const text = `${group.title} ${command} ${what} ${note}`.toLowerCase();
      return words.every((w) => text.includes(w));
    });
    if (!rows.length) continue;
    const section = document.createElement('div');
    section.className = 'keys-group';
    section.innerHTML = '<h3></h3>';
    section.querySelector('h3').textContent = group.title;
    for (const [command, what, note] of rows) {
      const row = document.createElement('div');
      row.className = 'keys-row';
      row.title = 'Click to type this into the selected terminal';
      const desc = document.createElement('span');
      desc.className = 'keys-what';
      desc.textContent = what;
      if (note) {
        const small = document.createElement('span');
        small.className = 'keys-note';
        small.textContent = note;
        desc.append(small);
      }
      row.append(commandEl(command), desc);
      row.addEventListener('click', () => typeCommand(command));
      section.append(row);
    }
    cols.append(section);
  }
  if (!cols.children.length) keysList.innerHTML = '<p class="keys-none">No commands match that.</p>';
}

function toggleKeys(open = !keysSheet.classList.contains('open')) {
  keysSheet.style.top = `${document.getElementById('toolbar').offsetHeight}px`;
  keysSheet.classList.toggle('open', open);
  if (open) {
    keysSearch.select();
    keysSearch.focus();
  } else {
    setFocus(focused);
  }
  placeApps();
}

keysSearch.addEventListener('input', renderKeys);
document.getElementById('keys-btn').addEventListener('click', () => toggleKeys());

// Minimise / maximise / close, drawn here so they match the rest of the bar.
const winMax = document.getElementById('win-max');
function showMaximized(maximized) {
  winMax.innerHTML = icon(maximized ? 'winRestore' : 'winMax');
  winMax.title = maximized ? 'Restore' : 'Maximise';
}
document.getElementById('win-min').addEventListener('click', () => window.api.minimizeWindow());
winMax.addEventListener('click', () => window.api.maximizeWindow());
document.getElementById('win-close').addEventListener('click', () => window.api.closeWindow());
window.api.onMaximized(showMaximized);
window.api.isMaximized().then(showMaximized);
document.getElementById('keys-close').addEventListener('click', () => toggleKeys(false));
// Programs pulled in from outside sit on top of everything in the window, so
// they're hidden while a menu or the commands sheet is open.
const APP_NAMES = { chatgpt: 'ChatGPT', obsidian: 'Obsidian' };

function createAppPane(app) {
  const id = `pane-${nextId++}`;
  const el = document.createElement('section');
  el.className = 'pane app-pane';
  el.innerHTML = `
    <div class="pane-header" title="Double-click to enlarge / shrink">
      <span class="pane-num"></span>
      <span class="pane-title"></span>
      <span class="pane-path"></span>
      <span class="pane-status"></span>
      <button class="regrab icon-btn" title="Pull the window in again">${icon('restart')}</button>
      <button class="enlarge icon-btn" title="Enlarge / shrink (Ctrl+Shift+Enter)">${icon('enlarge')}</button>
      <button class="close icon-btn" title="Give the window back (the program keeps running)">${icon('close')}</button>
    </div>
    <div class="pane-body app-body"><p class="app-msg"></p></div>`;
  el.querySelector('.pane-title').innerHTML = `<span class="logo logo-${app}"></span>`;
  el.querySelector('.pane-title').append(APP_NAMES[app]);
  grid.appendChild(el);

  const p = { id, app, el, body: el.querySelector('.app-body'), statusEl: el.querySelector('.pane-status'), attached: false };
  panes.push(p);
  el.addEventListener('mousedown', () => setFocus(p));
  el.querySelector('.pane-header').addEventListener('dblclick', (e) => {
    if (e.target.tagName !== 'BUTTON') toggleEnlarge(p);
  });
  el.querySelector('.regrab').addEventListener('click', () => attachApp(p));
  el.querySelector('.enlarge').addEventListener('click', () => toggleEnlarge(p));
  el.querySelector('.close').addEventListener('click', () => closePane(p));
  return p;
}

async function attachApp(p) {
  if (p.attached) window.api.releaseApp(p.id);
  p.attached = false;
  p.lastPlace = null;
  p.el.querySelector('.app-msg').textContent = `Looking for ${APP_NAMES[p.app]}…`;
  setStatus(p, '');
  const res = await window.api.attachApp(p.id, p.app);
  if (!p.el.isConnected) return window.api.releaseApp(p.id); // closed meanwhile
  if (res.error) {
    p.el.querySelector('.app-msg').textContent = `${res.error}. Click the circular arrow to try again.`;
    setStatus(p, 'not inside', true);
    return;
  }
  p.attached = true;
  p.el.querySelector('.pane-path').textContent = res.title;
  p.el.querySelector('.app-msg').textContent = '';
  placeApps();
}

// Tell the main process where each pulled-in window goes, in screen pixels.
function placeApps() {
  const covered = keysSheet.classList.contains('open') || bgPanel.classList.contains('open');
  const scale = window.devicePixelRatio;
  for (const p of panes) {
    if (!p.attached) continue;
    const visible = !covered && !p.el.classList.contains('hidden');
    const r = p.body.getBoundingClientRect();
    const rect = { x: Math.round(r.left * scale), y: Math.round(r.top * scale), width: Math.round(r.width * scale), height: Math.round(r.height * scale) };
    const key = JSON.stringify([rect, visible]);
    if (key === p.lastPlace) continue;
    p.lastPlace = key;
    window.api.placeApp(p.id, rect, visible);
  }
}
// cheap catch-all for anything that moves a pane (layout, window resizing, menus)
setInterval(placeApps, 200);

async function addAppPane(app) {
  enlarged = null;
  const p = createAppPane(app);
  save();
  layout();
  setFocus(p);
  attachApp(p);
}

for (const button of document.querySelectorAll('#app-btns button')) {
  button.addEventListener('click', () => addAppPane(button.dataset.app));
}

window.api.onAppStatus((id, status) => {
  const p = panes.find((x) => x.id === id);
  if (p) p.el.querySelector('.app-msg').textContent = status;
});

// A program closed from inside (e.g. File > Quit) leaves its pane empty.
window.api.onAppCheck((gone, titles) => {
  for (const p of panes) {
    if (!p.app) continue;
    if (gone.includes(p.id)) {
      p.attached = false;
      p.el.querySelector('.app-msg').textContent = `${APP_NAMES[p.app]} was closed. Click the circular arrow to open it again.`;
      setStatus(p, 'closed', true);
    } else if (titles[p.id] != null) {
      p.el.querySelector('.pane-path').textContent = titles[p.id];
    }
  }
});

keysSheet.addEventListener('mousedown', (e) => {
  if (e.target === keysSheet) toggleKeys(false); // click outside the box
});
window.addEventListener('keydown', (e) => {
  if (e.key === 'F1') {
    e.preventDefault();
    toggleKeys();
  } else if (e.key === 'Escape' && keysSheet.classList.contains('open')) {
    toggleKeys(false);
  }
});
renderKeys();

// Hide the top-bar icon if icon.png is missing.
const brandIcon = document.querySelector('.brand-icon');
brandIcon.addEventListener('error', () => brandIcon.remove());
if (brandIcon.complete && !brandIcon.naturalWidth) brandIcon.remove();

document.getElementById('add-btn').addEventListener('click', addPane);
document.getElementById('empty-add-btn').addEventListener('click', addPane);

window.addEventListener('keydown', (e) => {
  if (!isAppShortcut(e)) return;
  e.preventDefault();
  const key = e.key.toUpperCase();
  if (e.shiftKey && key === 'T') addPane();
  else if (e.shiftKey && key === 'W' && focused) closePane(focused);
  else if (e.shiftKey && key === 'ENTER' && focused) toggleEnlarge(focused);
  else if (/^[1-9]$/.test(e.key)) {
    const p = panes[Number(e.key) - 1];
    if (p) {
      if (enlarged && enlarged !== p) {
        enlarged = p;
        layout();
      }
      setFocus(p);
    }
  }
});

// Reopen the folders from last time.
(async () => {
  const saved = await window.api.loadPanes();
  // (skips programs no longer offered)
  saved.filter((s) => !s.app || APP_NAMES[s.app]).forEach((s) => (s.app ? createAppPane(s.app) : createPane(s.cwd, s.effort || '', s.model || '')));
  layout();
  panes.forEach((p) => (p.app ? attachApp(p) : startClaude(p)));
  setFocus(panes[0] || null);
})();

// Nova Grid on a phone: the terminals open on the PC, live, with a box to type
// into and buttons for the keys a phone keyboard doesn't have. ChatGPT,
// Obsidian and Edge panes come as a live picture to tap, swipe and type into.
// Everything goes through Nova Grid on the PC (remote.js there); this page
// only shows it.

const ICONS = {
  restart: '<path d="M20 12a8 8 0 1 1-2.34-5.66"/><path d="M20 4v5h-5"/>',
  close: '<path d="M6 6l12 12M18 6L6 18"/>',
  send: '<path d="M5 12h13M13 6l6 6-6 6"/>',
  fitPhone: '<rect x="7" y="3" width="10" height="18" rx="2.5"/><path d="M11 18h2"/>',
  fitPc: '<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M9 20h6M12 16v4"/>',
};
const icon = (name) => `<svg class="icon" viewBox="0 0 24 24">${ICONS[name]}</svg>`;
const $ = (id) => document.getElementById(id);

const MODELS = [['fable', 'Fable'], ['opus', 'Opus'], ['sonnet', 'Sonnet'], ['haiku', 'Haiku']];
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];

// Keys a phone keyboard is missing. Claude's menus move with the arrows and
// Enter; Shift+Tab switches its mode; Esc stops it.
const KEYS = [
  ['Esc', '\x1b'],
  ['⇧Tab', '\x1b[Z'],
  ['↑', '\x1b[A'],
  ['↓', '\x1b[B'],
  ['Enter', '\r', 'wide'],
  ['/', null, 'commands'],
  ['1', '1'],
  ['2', '2'],
  ['3', '3'],
  ['←', '\x1b[D'],
  ['→', '\x1b[C'],
  ['Tab', '\t'],
  ['Ctrl+C', '\x03', 'wide'],
];

// The same for a program pane, sent as key presses by name.
const APP_KEYS = [
  ['Esc', 'Escape'],
  ['Tab', 'Tab'],
  ['↑', 'ArrowUp'],
  ['↓', 'ArrowDown'],
  ['←', 'ArrowLeft'],
  ['→', 'ArrowRight'],
  ['⌫', 'Backspace'],
  ['Enter', 'Enter', 'wide'],
];

// ---------- the secret key from the QR code ----------
// It comes after the # so it never leaves the phone in a request; it's kept,
// then taken out of the address bar so it doesn't show in screenshots.
let key = null;
try {
  const fromLink = new URLSearchParams(location.hash.slice(1)).get('k');
  if (fromLink) localStorage.setItem('novaKey', fromLink);
  key = fromLink || localStorage.getItem('novaKey');
} catch {
  key = new URLSearchParams(location.hash.slice(1)).get('k');
}
if (location.hash) history.replaceState(null, '', location.pathname);

// ---------- state ----------
let ws = null;
let connected = false;
let denied = false;
let retry = 0;
let state = { panes: [], usage: [], recent: [] };
let current = null; // id of the pane on screen
let viewSent = '';
let pendingFolder = null; // a terminal asked for from here, to switch to once it opens
let pictureState = null; // a program pane: 'ok', or why the PC can't show it
let pictureNext = false; // a picture is due as the next binary message
let fit = localStorage.getItem('novaFit') !== 'pc';
let fontSize = Number(localStorage.getItem('novaFont')) || 12;

const term = new Terminal({
  fontFamily: "ui-monospace, 'Cascadia Mono', Menlo, Consolas, monospace",
  fontSize,
  scrollback: 3000,
  disableStdin: true,
  cursorBlink: false,
  allowTransparency: true,
  theme: { background: 'rgba(0, 0, 0, 0)', foreground: '#e4e4e4', cursor: '#f5f5f5', selectionBackground: 'rgba(255, 255, 255, 0.2)' },
});
const fitAddon = new FitAddon.FitAddon();
term.loadAddon(fitAddon);
term.open($('term'));
// typing goes through the box at the bottom; tapping the terminal shouldn't pop the keyboard
if (term.textarea) {
  term.textarea.readOnly = true;
  term.textarea.setAttribute('inputmode', 'none');
}

// ---------- talking to the PC ----------

function connect() {
  if (!key) return gate('Open this page by scanning the code in Nova Grid on your PC: click the phone button in the top bar, then Turn on.');
  gate(connected ? null : 'Connecting to your PC…');
  ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
  ws.binaryType = 'blob';
  ws.onopen = () => ws.send(JSON.stringify({ t: 'hello', key }));
  ws.onmessage = (e) => (typeof e.data === 'string' ? onMessage(JSON.parse(e.data)) : onPicture(e.data));
  ws.onclose = () => {
    connected = false;
    viewSent = '';
    $('conn').classList.remove('ok');
    if (denied) return;
    gate('Lost the connection to your PC. Trying again…');
    setTimeout(connect, Math.min(1000 * 2 ** retry++, 10000));
  };
}

function send(message) {
  if (connected && ws?.readyState === 1) ws.send(JSON.stringify(message));
}

function onMessage(msg) {
  if (msg.t === 'denied') {
    denied = true;
    return gate('This link no longer works. In Nova Grid on your PC, click the phone button and scan the code again.');
  }
  if (msg.t === 'welcome') {
    connected = true;
    retry = 0;
    $('conn').classList.add('ok');
    gate(null);
    return;
  }
  if (msg.t === 'state') return onState(msg);
  if (msg.t === 'error') return toast(msg.message);
  if (msg.id !== current) return;
  if (msg.t === 'picture') {
    pictureNext = msg.state === 'ok';
    if (msg.state !== pictureState) {
      pictureState = msg.state;
      renderNotice();
    }
    return;
  }
  if (msg.t === 'screen') {
    term.reset();
    if (msg.cols && msg.rows) term.resize(msg.cols, msg.rows);
    term.write(msg.data || '', () => term.scrollToBottom());
  } else if (msg.t === 'data') {
    term.write(msg.data);
  } else if (msg.t === 'reset') {
    term.reset();
  }
}

// A new picture of the program pane on screen. The PC sends the next one
// once this one is showing.
const shot = $('shot');
let shotUrl = null;
function onPicture(blob) {
  if (!pictureNext) return;
  pictureNext = false;
  const url = URL.createObjectURL(blob);
  shot.onload = shot.onerror = () => {
    if (shotUrl && shotUrl !== url) URL.revokeObjectURL(shotUrl);
    shotUrl = url;
    send({ t: 'shown' });
  };
  shot.src = url;
}

function clearPicture() {
  shot.removeAttribute('src');
  if (shotUrl) URL.revokeObjectURL(shotUrl);
  shotUrl = null;
  pictureState = null;
  pictureNext = false;
}

function gate(text) {
  $('gate').classList.toggle('hide', !text);
  if (text) $('gate-text').textContent = text;
}

let toastTimer;
function toast(text) {
  $('toast').textContent = text;
  $('toast').hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => ($('toast').hidden = true), 3500);
}

// ---------- what's open ----------

function onState(next) {
  state = next;
  if (pendingFolder) {
    const opened = state.panes.find((p) => p.cwd && p.cwd.toLowerCase() === pendingFolder.toLowerCase() && !p.app);
    if (opened && opened.id !== current) {
      pendingFolder = null;
      current = opened.id;
    }
  }
  if (!state.panes.some((p) => p.id === current)) current = (state.panes.find((p) => !p.app) || state.panes[0])?.id || null;
  render();
}

const pane = () => state.panes.find((p) => p.id === current);

let rendered = null; // the pane on screen last time
function render() {
  if (current !== rendered) {
    rendered = current;
    clearPicture();
  }
  renderUsage();
  renderTabs();
  renderKeys();
  renderPaneBar();
  renderNotice();
  sizeTerminal();
}

function renderUsage() {
  const box = $('usage');
  box.replaceChildren();
  for (const limit of state.usage || []) {
    const el = document.createElement('span');
    el.className = 'limit';
    el.title = limit.reset ? `Resets ${limit.reset}` : '';
    el.innerHTML = '<span><span class="name"></span> <b></b></span><span class="bar"><span class="fill"></span></span>';
    el.querySelector('.name').textContent = limit.name;
    el.querySelector('b').textContent = limit.pct == null ? '–' : `${limit.pct}%`;
    const fill = el.querySelector('.fill');
    fill.style.width = `${Math.min(limit.pct || 0, 100)}%`;
    fill.classList.toggle('warn', limit.pct >= 70);
    fill.classList.toggle('high', limit.pct >= 90);
    box.append(el);
  }
}

function renderTabs() {
  const tabs = $('tabs');
  tabs.replaceChildren();
  for (const p of state.panes) {
    const tab = document.createElement('button');
    tab.className = 'tab' + (p.id === current ? ' current' : '') + (!p.app && !p.running ? ' exited' : '');
    tab.innerHTML = '<span class="num"></span><span class="title"></span>';
    tab.querySelector('.num').textContent = p.num;
    tab.querySelector('.title').textContent = p.title;
    tab.title = p.cwd || p.title;
    tab.addEventListener('click', () => {
      current = p.id;
      render();
    });
    tabs.append(tab);
  }
  const add = document.createElement('button');
  add.className = 'tab';
  add.textContent = '+ New';
  add.title = 'Open a new terminal on the PC';
  add.addEventListener('click', openNewSheet);
  tabs.append(add);
  tabs.querySelector('.current')?.scrollIntoView({ inline: 'nearest', block: 'nearest' });
}

function fillSelect(select, options, chosen, defaultLabel) {
  select.replaceChildren();
  for (const [value, label] of [['', defaultLabel], ...options]) {
    const o = document.createElement('option');
    o.value = value;
    o.textContent = label;
    select.append(o);
  }
  select.value = chosen;
}

function renderPaneBar() {
  const p = pane();
  const isTerminal = p && !p.app;
  for (const id of ['model', 'effort', 'text-size']) $(id).hidden = !isTerminal;
  for (const id of ['fit', 'restart', 'close']) $(id).hidden = !p;
  if (!p) return;
  if (isTerminal) {
    fillSelect($('model'), MODELS, p.model, p.modelDefault || 'model: default');
    fillSelect($('effort'), EFFORTS.map((e) => [e, `effort: ${e}`]), p.effort, p.effortDefault || 'effort: default');
  }
  $('restart').title = p.app ? `Pull the ${p.title} window into its pane again` : 'Restart Claude in this folder';
  $('close').title = p.app ? `Close this ${p.title} pane on the PC` : 'Close this terminal on the PC';
  $('fit').innerHTML = icon(fit ? 'fitPhone' : 'fitPc');
  $('fit').title = fit ? 'Fitted to the phone. Tap for the same size as on the PC' : 'Same size as on the PC. Tap to fit it to the phone';
  input.placeholder = p.app ? `Type into ${p.title}…` : 'Message Claude…';
}

function renderNotice() {
  const p = pane();
  let text = null;
  let button = null;
  let full = false;
  if (!state.panes.length) {
    text = 'Nothing is open in Nova Grid yet.';
    button = ['Open a terminal', openNewSheet];
    full = true;
  } else if (p?.app) {
    const reveal = ['Show it on the PC', () => send({ t: 'cmd', action: 'reveal', id: p.id })];
    if (!p.attached || pictureState === 'gone') {
      text = `${p.title} isn't in its pane on your PC right now.`;
      button = ['Pull it in again', () => send({ t: 'cmd', action: 'regrab', id: p.id })];
    } else if (pictureState === 'minimised') {
      text = `Nova Grid is minimised on your PC, so ${p.title} can't be shown.`;
      button = reveal;
    } else if (pictureState === 'hidden') {
      text = `${p.title} is hidden on your PC (another pane is enlarged, or a menu is open).`;
      button = reveal;
    }
    full = !!text;
  } else if (p && !p.running && p.status !== 'starting…') {
    text = p.status === 'failed' ? "Claude couldn't start in this folder." : `Claude has stopped${p.status ? ` (${p.status})` : ''}.`;
    button = ['Start it again', () => send({ t: 'cmd', action: 'restart', id: p.id })];
  }
  $('notice').hidden = !text;
  $('notice').classList.toggle('full', full);
  $('term-wrap').style.visibility = full || p?.app ? 'hidden' : '';
  $('shot-wrap').hidden = full || !p?.app;
  $('notice-text').textContent = text || '';
  $('notice-btn').hidden = !button;
  if (button) {
    $('notice-btn').textContent = button[0];
    $('notice-btn').onclick = button[1];
  }
}

// ---------- terminal size ----------
// "Fit to phone": the terminal on the PC takes the phone's size while it's
// watched here, so Claude lays its screen out for the phone. The height used
// is the tallest seen at this width, so the keyboard coming up doesn't make
// Claude redraw; the terminal sits at the bottom and its top slides out of
// view instead.
let tallest = { width: 0, height: 0 };

let tallestView = { width: 0, height: 0 };

function sizeTerminal() {
  const p = pane();
  const wrap = $('term-wrap');
  wrap.classList.toggle('pc-size', !fit);
  $('shot-wrap').classList.toggle('pc-size', !fit);
  if (!p || document.hidden) return sendView(null);

  // A program pane on the PC takes the phone's shape, in the phone's screen points.
  if (p.app) {
    if (!fit) return sendView({ id: p.id, fit: false });
    const view = $('view');
    if (view.clientWidth !== tallestView.width || view.clientHeight > tallestView.height) tallestView = { width: view.clientWidth, height: view.clientHeight };
    return sendView({ id: p.id, fit: true, width: tallestView.width, height: tallestView.height });
  }

  if (!fit) {
    $('term').style.height = '';
    if (p.cols && p.rows && (term.cols !== p.cols || term.rows !== p.rows)) term.resize(p.cols, p.rows);
    return sendView({ id: p.id, fit: false, cols: p.cols, rows: p.rows });
  }
  const width = wrap.clientWidth;
  const height = wrap.clientHeight;
  if (width !== tallest.width || height > tallest.height) tallest = { width, height };
  $('term').style.height = `${tallest.height}px`;
  const dims = fitAddon.proposeDimensions();
  if (!dims || !dims.cols || !dims.rows) return;
  if (term.cols !== dims.cols || term.rows !== dims.rows) term.resize(dims.cols, dims.rows);
  sendView({ id: p.id, fit: true, cols: dims.cols, rows: dims.rows });
}

// Only tell the PC when something changed; each view brings a fresh copy of the screen.
function sendView(view) {
  const key = JSON.stringify(view);
  if (key === viewSent || !connected) return;
  viewSent = key;
  send(view ? { t: 'view', ...view } : { t: 'view', id: null });
}

let sizeTimer;
const sizeSoon = () => {
  clearTimeout(sizeTimer);
  sizeTimer = setTimeout(sizeTerminal, 150);
};
new ResizeObserver(sizeSoon).observe($('view'));

// While the keyboard is up, the page is only as tall as what's still visible.
function fitToScreen() {
  const vv = window.visualViewport;
  $('app').style.height = vv ? `${vv.height}px` : '100%';
  window.scrollTo(0, 0);
}
window.visualViewport?.addEventListener('resize', fitToScreen);
window.visualViewport?.addEventListener('scroll', fitToScreen);
fitToScreen();

// A phone in a pocket shouldn't keep the PC terminal phone-sized.
document.addEventListener('visibilitychange', () => {
  viewSent = '';
  sizeTerminal();
});

// ---------- typing ----------

const input = $('input');

function write(data) {
  const p = pane();
  if (p && !p.app) send({ t: 'input', id: p.id, data });
}

// Sends the message as if typed and then Enter. New lines go in the way
// Shift+Enter does on the PC.
function sendMessage() {
  const text = input.value;
  const p = pane();
  if (!p) return;
  if (p.app) {
    // typed into whatever was last tapped in the picture, then Enter
    if (text) send({ t: 'type', id: p.id, text });
    setTimeout(() => send({ t: 'key', id: p.id, key: 'Enter' }), 60);
  } else if (text) {
    write(text.replace(/\r?\n/g, '\x1b\r'));
    setTimeout(() => write('\r'), 60);
  } else {
    write('\r');
  }
  input.value = '';
  growInput();
}

function growInput() {
  input.style.height = 'auto';
  input.style.height = `${input.scrollHeight + 2}px`;
}

$('send').innerHTML = icon('send');
$('send-row').addEventListener('submit', (e) => {
  e.preventDefault();
  sendMessage();
});
input.addEventListener('input', growInput);
input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    sendMessage();
  }
});

// Buttons that shouldn't take the focus from the typing box (the keyboard would drop).
function keepFocus(button) {
  button.addEventListener('pointerdown', (e) => e.preventDefault());
}

// The row of keys: the terminal's, or the program's.
let keysFor = null;
function renderKeys() {
  const forApp = !!pane()?.app;
  if (keysFor === forApp) return;
  keysFor = forApp;
  $('keys').replaceChildren();
  for (const [label, data, kind] of forApp ? APP_KEYS : KEYS) {
    const button = document.createElement('button');
    button.textContent = label;
    if (kind === 'wide' || kind === 'commands') button.className = 'wide';
    keepFocus(button);
    button.addEventListener('click', () => {
      if (kind === 'commands') return openCommands();
      if (!forApp) return write(data);
      if (pane()?.app) send({ t: 'key', id: current, key: data });
    });
    $('keys').append(button);
  }
}
keepFocus($('send'));

// ---------- tapping and swiping a program's picture ----------
// A tap clicks that spot on the PC; a swipe up or down scrolls it.

let gesture = null;
let scrollTimer = null;

// Where on the picture, as fractions of its size.
function spot(e) {
  const r = shot.getBoundingClientRect();
  return { x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height };
}

shot.addEventListener('pointerdown', (e) => {
  if (!pane()?.app) return;
  gesture = { startX: e.clientX, startY: e.clientY, lastY: e.clientY, moved: false, at: spot(e), pending: 0 };
  shot.setPointerCapture(e.pointerId);
});

shot.addEventListener('pointermove', (e) => {
  if (!gesture) return;
  if (!gesture.moved && Math.hypot(e.clientX - gesture.startX, e.clientY - gesture.startY) > 10) gesture.moved = true;
  if (!gesture.moved) return;
  gesture.pending += e.clientY - gesture.lastY;
  gesture.lastY = e.clientY;
  if (!scrollTimer) scrollTimer = setTimeout(flushScroll, 60);
});

// Finger up the screen scrolls down the page, as on a phone. The wheel counts
// 120 for about 100 of the program's pixels.
function flushScroll() {
  scrollTimer = null;
  const g = gesture || flushScroll.last;
  if (!g || !g.pending || !pane()?.app) return;
  const r = shot.getBoundingClientRect();
  const pixels = g.pending * ((shot.naturalHeight || r.height) / r.height);
  g.pending = 0;
  send({ t: 'scroll', id: current, x: g.at.x, y: g.at.y, delta: Math.round(pixels * 1.2) });
}

function endGesture(e) {
  if (!gesture) return;
  const g = gesture;
  gesture = null;
  if (g.moved) {
    flushScroll.last = g;
    flushScroll();
    return;
  }
  if (e.type !== 'pointerup') return;
  const at = spot(e);
  send({ t: 'tap', id: current, x: at.x, y: at.y });
  const dot = document.createElement('div');
  dot.className = 'tap-dot';
  const view = $('view').getBoundingClientRect();
  dot.style.left = `${e.clientX - view.left}px`;
  dot.style.top = `${e.clientY - view.top}px`;
  $('view').append(dot);
  setTimeout(() => dot.remove(), 500);
}
shot.addEventListener('pointerup', endGesture);
shot.addEventListener('pointercancel', endGesture);

// ---------- the pane's own buttons ----------

$('restart').innerHTML = icon('restart');
$('close').innerHTML = icon('close');
$('model').addEventListener('change', () => send({ t: 'cmd', action: 'model', id: current, value: $('model').value }));
$('effort').addEventListener('change', () => send({ t: 'cmd', action: 'effort', id: current, value: $('effort').value }));
$('restart').addEventListener('click', () => send({ t: 'cmd', action: pane()?.app ? 'regrab' : 'restart', id: current }));
$('fit').addEventListener('click', () => {
  fit = !fit;
  localStorage.setItem('novaFit', fit ? 'phone' : 'pc');
  renderPaneBar();
  sizeTerminal();
});

// Text size goes round 10 → 11 → … → 15 → 10. Smaller fits more of Claude's screen.
$('text-size').addEventListener('click', () => {
  fontSize = fontSize >= 15 ? 10 : fontSize + 1;
  localStorage.setItem('novaFont', fontSize);
  term.options.fontSize = fontSize;
  tallest = { width: 0, height: 0 };
  sizeTerminal();
  toast(`Text size ${fontSize}`);
});

// Closing asks for a second tap.
let closeTimer;
$('close').addEventListener('click', () => {
  const button = $('close');
  if (!button.classList.contains('confirm')) {
    button.classList.add('confirm');
    button.textContent = 'Close?';
    closeTimer = setTimeout(resetClose, 3000);
    return;
  }
  resetClose();
  send({ t: 'cmd', action: 'close', id: current });
});
function resetClose() {
  clearTimeout(closeTimer);
  $('close').classList.remove('confirm');
  $('close').innerHTML = icon('close');
}

// ---------- sheets ----------

function openSheet(id) {
  $(id).hidden = false;
}
function closeSheets() {
  document.querySelectorAll('.sheet').forEach((s) => (s.hidden = true));
}
document.querySelectorAll('.sheet').forEach((sheet) => {
  sheet.addEventListener('click', (e) => e.target === sheet && closeSheets());
  const close = sheet.querySelector('.sheet-close');
  close.innerHTML = icon('close');
  close.addEventListener('click', closeSheets);
});

// Claude's / commands; tapping one puts it in the typing box.
function openCommands() {
  $('commands-search').value = '';
  renderCommands();
  openSheet('sheet-commands');
}

function renderCommands() {
  const words = $('commands-search').value.toLowerCase().split(/\s+/).filter(Boolean);
  const list = $('commands-list');
  list.replaceChildren();
  for (const group of COMMANDS) {
    const rows = group.commands.filter(([command, what, note = '']) => {
      const text = `${group.title} ${command} ${what} ${note}`.toLowerCase();
      return words.every((w) => text.includes(w));
    });
    if (!rows.length) continue;
    const h = document.createElement('h3');
    h.textContent = group.title;
    list.append(h);
    for (const [command, what] of rows) {
      const [name, ...args] = command.split(' ');
      const row = document.createElement('button');
      row.className = 'cmd-row';
      row.innerHTML = '<span><span class="cmd-name"></span> <span class="cmd-args"></span></span><span class="cmd-what"></span>';
      row.querySelector('.cmd-name').textContent = name;
      row.querySelector('.cmd-args').textContent = args.join(' ');
      row.querySelector('.cmd-what').textContent = what;
      row.addEventListener('click', () => {
        closeSheets();
        input.value = `${name} `;
        growInput();
        input.focus();
      });
      list.append(row);
    }
  }
  if (!list.children.length) list.innerHTML = '<p class="note">No commands match that.</p>';
}
$('commands-search').addEventListener('input', renderCommands);

// A new terminal, in a folder used before or one typed in.
const folderName = (cwd) => cwd.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || cwd;

function openNewSheet() {
  const list = $('recent-list');
  list.replaceChildren();
  for (const cwd of state.recent || []) {
    const row = document.createElement('button');
    row.className = 'folder';
    row.innerHTML = '<span class="folder-name"></span><span class="folder-path"></span>';
    row.querySelector('.folder-name').textContent = folderName(cwd);
    row.querySelector('.folder-path').textContent = cwd;
    row.addEventListener('click', () => openFolder(cwd));
    list.append(row);
  }
  if (!list.children.length) list.innerHTML = '<p class="note">No folders yet. Type one below.</p>';
  $('new-path').value = '';
  openSheet('sheet-new');
}

function openFolder(cwd) {
  closeSheets();
  pendingFolder = cwd;
  send({ t: 'cmd', action: 'add', cwd });
}

$('new-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const cwd = $('new-path').value.trim();
  if (cwd) openFolder(cwd);
});

connect();

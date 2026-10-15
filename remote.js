// Phone remote: a small web page for watching and typing into the terminals
// (and the ChatGPT / Obsidian / Edge panes, as live pictures) from a phone,
// anywhere. Nova Grid serves it on this PC only (127.0.0.1) and
// Cloudflare's free "quick tunnel" gives it a public https address. The page
// itself holds nothing; the terminals only reach a phone that presents the
// secret key from the QR code (kept after the # so it is never sent in a
// request or logged along the way).
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { WebSocketServer } = require('ws');
const QRCode = require('qrcode');
const { nativeImage } = require('electron');

const CLOUDFLARED_URL = 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe';
const SNAPSHOT_TIMEOUT = 3000;
const MAX_INPUT = 64 * 1024;
const PICTURE_EVERY = 300; // ms between looks at a program pane a phone is watching
const PICTURE_MAX_WIDTH = 1600;
const PICTURE_WAIT = 5000; // a phone that hasn't said it showed the last picture gets the next anyway after this

let opts; // { dataDir, ptys, embed, showWindow, send, loadConfig, saveConfig, keepAwake, version }
let server = null;
let wss = null;
let port = 0;
let tunnel = null;
let stopping = false;
let status = { on: false, stage: 'off' };
let paneState = { panes: [], usage: [], recent: [] }; // pushed by the window
const clients = new Set();
const snapshots = new Map(); // request id -> { id, waiting: Set of clients, timer }
let nextSnapshot = 1;

const ROOT = __dirname;
const FILES = {
  '/': ['remote/index.html', 'text/html'],
  '/remote.css': ['remote/remote.css', 'text/css'],
  '/remote.js': ['remote/remote.js', 'text/javascript'],
  '/commands.js': ['renderer/commands.js', 'text/javascript'],
  '/xterm.js': ['node_modules/@xterm/xterm/lib/xterm.js', 'text/javascript'],
  '/xterm.css': ['node_modules/@xterm/xterm/css/xterm.css', 'text/css'],
  '/addon-fit.js': ['node_modules/@xterm/addon-fit/lib/addon-fit.js', 'text/javascript'],
  '/icon.png': ['icon.png', 'image/png'],
};

const cloudflaredPath = () => path.join(opts.dataDir(), 'bin', 'cloudflared.exe');

function init(options) {
  opts = options;
  // never leave the connector running after Nova Grid has gone
  process.on('exit', shutdown);
  if (opts.loadConfig().remote?.on) start();
}

function key() {
  let saved = opts.loadConfig().remote?.key;
  if (!saved) {
    saved = crypto.randomBytes(32).toString('base64url');
    opts.saveConfig({ remote: { ...opts.loadConfig().remote, key: saved } });
  }
  return saved;
}

async function setStatus(changes) {
  status = { ...status, ...changes, phones: [...clients].filter((c) => c.authed).length };
  if (status.url) {
    status.link = `${status.url}/#k=${key()}`;
    if (status.qrFor !== status.link) {
      status.qr = await QRCode.toDataURL(status.link, { margin: 1, width: 220, color: { dark: '#000000', light: '#ffffff' } });
      status.qrFor = status.link;
    }
  } else {
    status.link = status.qr = status.qrFor = null;
  }
  opts.send('remote:status', publicStatus());
}

const publicStatus = () => {
  const { qrFor, ...rest } = status;
  return rest;
};

// ---------- web server ----------

function serveFile(req, res) {
  const url = new URL(req.url, 'http://x');
  const entry = FILES[url.pathname];
  if (req.method !== 'GET' || !entry) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    return res.end('Not found');
  }
  fs.readFile(path.join(ROOT, entry[0]), (err, body) => {
    if (err) {
      res.writeHead(500);
      return res.end();
    }
    res.writeHead(200, {
      'Content-Type': `${entry[1]}; charset=utf-8`,
      'Cache-Control': 'no-store',
      'Content-Security-Policy': "default-src 'self'; connect-src 'self' wss: ws:; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'",
      'Referrer-Policy': 'no-referrer',
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
    });
    res.end(body);
  });
}

function startServer() {
  return new Promise((resolve, reject) => {
    server = http.createServer(serveFile);
    wss = new WebSocketServer({ server, path: '/ws', maxPayload: 1024 * 1024 });
    wss.on('connection', onConnection);
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      port = server.address().port;
      resolve();
    });
  });
}

// ---------- phones ----------

function sendTo(client, message) {
  if (client.ws.readyState === 1) client.ws.send(JSON.stringify(message));
}

function onConnection(ws, req) {
  // only the page Nova Grid serves may connect, not another site in the phone's browser
  const origin = req.headers.origin;
  if (origin && new URL(origin).host !== req.headers.host) return ws.close();

  const client = { ws, authed: false, viewing: null, fit: true, cols: 0, rows: 0, width: 0, height: 0, buffer: null, alive: true, picture: null };
  clients.add(client);
  ws.on('pong', () => (client.alive = true));
  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (!client.authed) return hello(client, msg);
    onMessage(client, msg);
  });
  ws.on('close', () => {
    clients.delete(client);
    if (client.authed) {
      updateSizes();
      setStatus({});
    }
  });
}

function hello(client, msg) {
  const expected = Buffer.from(key());
  const given = Buffer.from(String(msg.key || ''));
  if (msg.t !== 'hello' || given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) {
    // a moment's wait makes guessing slow, on top of the key being far too long to guess
    setTimeout(() => {
      sendTo(client, { t: 'denied' });
      client.ws.close();
    }, 1000);
    return;
  }
  client.authed = true;
  sendTo(client, { t: 'welcome', version: opts.version });
  sendTo(client, { t: 'state', ...paneState });
  setStatus({});
}

const terminal = (id) => paneState.panes.find((p) => p.id === id && !p.app);
const program = (id) => paneState.panes.find((p) => p.id === id && p.app);

function onMessage(client, msg) {
  if (msg.t === 'view') return view(client, msg);
  if (msg.t === 'shown') {
    if (client.picture) client.picture.waiting = 0;
    return;
  }
  if (['tap', 'scroll', 'type', 'key'].includes(msg.t)) return programInput(client, msg);
  if (msg.t === 'input') {
    const data = String(msg.data || '').slice(0, MAX_INPUT);
    if (terminal(msg.id)) opts.ptys.get(msg.id)?.write(data);
    return;
  }
  if (msg.t === 'cmd') {
    if (msg.action === 'add') {
      const cwd = String(msg.cwd || '').trim();
      let ok = false;
      try {
        ok = fs.statSync(cwd).isDirectory();
      } catch {}
      if (!ok) return sendTo(client, { t: 'error', message: `Folder not found: ${cwd}` });
      return opts.send('remote:command', { action: 'add', cwd });
    }
    if (!paneState.panes.some((p) => p.id === msg.id)) return;
    // a program pane hidden on the PC (Nova Grid minimised, another pane enlarged): show it
    if (msg.action === 'reveal' && program(msg.id)) opts.showWindow();
    if (['restart', 'close', 'reveal', 'regrab'].includes(msg.action)) opts.send('remote:command', { action: msg.action, id: msg.id });
    if (['model', 'effort'].includes(msg.action)) opts.send('remote:command', { action: msg.action, id: msg.id, value: String(msg.value || '') });
  }
}

// The phone shows one terminal at a time. Its screen so far comes from the
// window (exactly what the PC pane shows), then output streams live; anything
// that arrives in between is held back so nothing is lost or doubled.
// A program pane is shown as pictures instead (see further down).
function view(client, msg) {
  client.viewing = paneState.panes.some((p) => p.id === msg.id) ? msg.id : null;
  client.fit = !!msg.fit;
  client.cols = Math.max(20, Math.min(300, Number(msg.cols) || 0));
  client.rows = Math.max(8, Math.min(200, Number(msg.rows) || 0));
  client.width = Math.max(200, Math.min(2000, Number(msg.width) || 0));
  client.height = Math.max(200, Math.min(2000, Number(msg.height) || 0));
  client.picture = program(client.viewing) ? { state: null, hash: null, waiting: 0 } : null;
  updateSizes();
  if (client.picture) {
    client.buffer = null;
    return setTimeout(sendPictures, 50);
  }
  if (!client.viewing) return (client.buffer = null);

  client.buffer = [];
  const req = nextSnapshot++;
  const done = () => finishSnapshot(req, null);
  snapshots.set(req, { id: client.viewing, waiting: new Set([client]), timer: setTimeout(done, SNAPSHOT_TIMEOUT) });
  opts.send('remote:snapshot', req, client.viewing);
}

function snapshotReply(req, screen) {
  finishSnapshot(req, screen);
}

function finishSnapshot(req, screen) {
  const pending = snapshots.get(req);
  if (!pending) return;
  snapshots.delete(req);
  clearTimeout(pending.timer);
  for (const client of pending.waiting) {
    if (client.viewing !== pending.id || !client.buffer) continue; // moved on meanwhile
    sendTo(client, { t: 'screen', id: pending.id, ...(screen || { data: '' }) });
    for (const message of client.buffer) sendTo(client, message);
    client.buffer = null;
  }
}

function toViewers(id, message) {
  for (const client of clients) {
    if (!client.authed || client.viewing !== id) continue;
    if (client.buffer) client.buffer.push(message);
    else sendTo(client, message);
  }
}

const ptyData = (id, data) => toViewers(id, { t: 'data', id, data });
// Claude (re)started in a terminal: the window cleared it, so phones do too.
const ptyStarted = (id) => toViewers(id, { t: 'reset', id });

// While a phone watches a terminal with "fit to phone" on, the terminal takes
// the phone's size so Claude lays its screen out for it. A program pane's
// window shrinks to the phone's shape (in the phone's screen points), so
// ChatGPT and the rest switch to their phone layout. The newest phone wins;
// the PC pane gets its own size back when no phone is watching.
function updateSizes() {
  const sizes = {};
  for (const client of clients) {
    if (!client.authed || !client.viewing || !client.fit) continue;
    sizes[client.viewing] = client.picture ? { width: client.width, height: client.height } : { cols: client.cols, rows: client.rows };
  }
  opts.send('remote:sizes', sizes);
}

// ---------- program panes on the phone ----------
// A few times a second, each program pane a phone watches is copied as a
// picture. A phone gets a new one only when it changed and once the phone has
// shown the last, so a slow connection gets fewer pictures, not a backlog.

function takePicture(id) {
  const shot = opts.embed.picture(id);
  if (shot.state !== 'ok') return shot;
  const hash = crypto.createHash('sha1').update(shot.pixels).digest('base64');
  let jpeg = null;
  return {
    state: 'ok',
    hash,
    jpeg() {
      if (jpeg) return jpeg;
      let image = nativeImage.createFromBitmap(shot.pixels, { width: shot.width, height: shot.height });
      if (shot.width > PICTURE_MAX_WIDTH) image = image.resize({ width: PICTURE_MAX_WIDTH, quality: 'good' });
      return (jpeg = image.toJPEG(70));
    },
  };
}

function sendPictures() {
  const shots = new Map(); // one picture per pane, however many phones watch it
  for (const client of clients) {
    const pic = client.picture;
    if (!client.authed || !pic || !program(client.viewing)) continue;
    if (pic.waiting && Date.now() - pic.waiting < PICTURE_WAIT) continue;
    if (!shots.has(client.viewing)) {
      try {
        shots.set(client.viewing, takePicture(client.viewing));
      } catch {
        shots.set(client.viewing, { state: 'gone' });
      }
    }
    const shot = shots.get(client.viewing);
    if (shot.state !== 'ok') {
      if (pic.state !== shot.state) sendTo(client, { t: 'picture', id: client.viewing, state: shot.state });
      pic.state = shot.state;
      pic.hash = null;
      continue;
    }
    if (shot.hash === pic.hash) continue;
    pic.state = 'ok';
    pic.hash = shot.hash;
    pic.waiting = Date.now();
    // the picture itself follows as a binary message
    sendTo(client, { t: 'picture', id: client.viewing, state: 'ok' });
    if (client.ws.readyState === 1) client.ws.send(shot.jpeg());
  }
}
setInterval(sendPictures, PICTURE_EVERY);

let soonTimer;
const picturesSoon = () => {
  clearTimeout(soonTimer);
  soonTimer = setTimeout(sendPictures, 120);
};

// Taps, scrolling and typing from the phone (x, y: fractions of the picture).
function programInput(client, msg) {
  const id = msg.id;
  if (!program(id) || client.viewing !== id) return;
  if (msg.t === 'tap') opts.embed.tap(id, msg.x, msg.y);
  if (msg.t === 'type') opts.embed.type(id, String(msg.text || '').slice(0, MAX_INPUT));
  if (msg.t === 'key') opts.embed.key(id, String(msg.key || ''));
  if (msg.t === 'scroll' && !opts.embed.scroll(id, msg.x, msg.y, msg.delta)) {
    // something covers Nova Grid on the PC, and the wheel only works where the PC can see it
    opts.showWindow();
    setTimeout(() => opts.embed.scroll(id, msg.x, msg.y, msg.delta), 150);
  }
  picturesSoon();
}

function setState(state) {
  paneState = state;
  for (const client of clients) {
    if (!client.authed) continue;
    sendTo(client, { t: 'state', ...paneState });
    if (client.viewing && !paneState.panes.some((p) => p.id === client.viewing)) {
      client.viewing = null;
      client.picture = null;
    }
  }
}

// Phones that vanish without saying goodbye (signal lost, screen locked).
setInterval(() => {
  for (const client of clients) {
    if (!client.alive) {
      client.ws.terminate();
      continue;
    }
    client.alive = false;
    try {
      client.ws.ping();
    } catch {}
  }
}, 30000);

// ---------- the tunnel ----------

async function downloadCloudflared() {
  const file = cloudflaredPath();
  if (fs.existsSync(file)) return file;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const res = await fetch(CLOUDFLARED_URL, { signal: AbortSignal.timeout(10 * 60 * 1000) });
  if (!res.ok) throw new Error(`GitHub answered ${res.status}`);
  const total = Number(res.headers.get('content-length')) || 0;
  const temp = `${file}.download`;
  const out = fs.createWriteStream(temp);
  let got = 0;
  let shown = -1;
  for await (const chunk of res.body) {
    out.write(chunk);
    got += chunk.length;
    const percent = total ? Math.floor((got / total) * 100) : 0;
    if (percent !== shown) {
      shown = percent;
      setStatus({ stage: 'downloading', percent });
    }
  }
  await new Promise((resolve, reject) => out.end((err) => (err ? reject(err) : resolve())));
  fs.renameSync(temp, file);
  return file;
}

function startTunnel(exe) {
  // A config file of the user's own (for a tunnel of theirs) would stop a
  // quick tunnel from starting, so point it at one of ours.
  const config = path.join(opts.dataDir(), 'bin', 'cloudflared.yml');
  fs.writeFileSync(config, 'no-autoupdate: true\n');
  const proc = spawn(exe, ['tunnel', '--config', config, '--no-autoupdate', '--url', `http://127.0.0.1:${port}`], { windowsHide: true });
  tunnel = proc;
  let log = '';
  const onOutput = (chunk) => {
    log = (log + chunk).slice(-4000);
    if (!status.url) {
      const found = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/.exec(log);
      if (found) setStatus({ stage: 'connecting', url: found[0] });
    }
    if (status.stage === 'connecting' && /Registered tunnel connection/.test(log)) setStatus({ stage: 'ready' });
  };
  proc.stdout.on('data', onOutput);
  proc.stderr.on('data', onOutput);
  proc.on('error', (err) => setStatus({ stage: 'error', message: `Could not start the connector (${err.code || err.message})`, url: null }));
  proc.on('exit', () => {
    if (tunnel !== proc) return;
    tunnel = null;
    if (stopping || !status.on) return;
    // Lost it (the PC woke from sleep, the connector crashed): try again.
    // A new tunnel has a new address, so phones need the new code.
    setStatus({ stage: 'starting', url: null, message: 'The connection dropped. Reconnecting with a new link…' });
    setTimeout(() => status.on && !tunnel && startTunnel(exe), 5000);
  });
}

async function start() {
  if (status.on) return publicStatus();
  stopping = false;
  opts.saveConfig({ remote: { ...opts.loadConfig().remote, on: true } });
  await setStatus({ on: true, stage: 'starting', url: null, message: null, percent: null });
  opts.keepAwake(true);
  try {
    if (!server) await startServer();
    const exe = await downloadCloudflared();
    if (!status.on) return publicStatus(); // turned off while downloading
    setStatus({ stage: 'starting', percent: null });
    startTunnel(exe);
  } catch (err) {
    setStatus({ stage: 'error', message: `Could not get the connector: ${String(err.message || err).slice(0, 200)}` });
  }
  return publicStatus();
}

function stop() {
  stopping = true;
  opts.saveConfig({ remote: { ...opts.loadConfig().remote, on: false } });
  opts.keepAwake(false);
  try {
    tunnel?.kill();
  } catch {}
  tunnel = null;
  for (const client of clients) client.ws.close();
  clients.clear();
  updateSizes();
  setStatus({ on: false, stage: 'off', url: null, message: null, percent: null });
  return publicStatus();
}

// A new key: every phone that has the old link is cut off.
function newKey() {
  opts.saveConfig({ remote: { ...opts.loadConfig().remote, key: crypto.randomBytes(32).toString('base64url') } });
  for (const client of clients) {
    sendTo(client, { t: 'denied' });
    client.ws.close();
  }
  clients.clear();
  updateSizes();
  setStatus({});
  return publicStatus();
}

function shutdown() {
  stopping = true;
  try {
    tunnel?.kill();
  } catch {}
  tunnel = null;
}

module.exports = { init, start, stop, newKey, shutdown, ptyData, ptyStarted, setState, snapshotReply, status: publicStatus };

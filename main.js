const { app, BrowserWindow, ipcMain, dialog, clipboard, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { pathToFileURL } = require('url');
const { spawn } = require('child_process');
const pty = require('node-pty');
const embed = require('./embed');

// Let the background video play with sound without a click first.
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

// NOVA_GRID_DATA: keep settings somewhere else, for trying things out
// without touching the real ones.
if (process.env.NOVA_GRID_DATA) app.setPath('userData', process.env.NOVA_GRID_DATA);
else {
  // The app used to be called Claude Grid. Move its saved terminals, background
  // and usage numbers over to the new name; if that folder is still in use (an
  // old copy is open), keep using it so nothing is lost.
  const appData = app.getPath('appData');
  const oldDir = path.join(appData, 'Claude Grid');
  const newDir = path.join(appData, 'Nova Grid');
  if (fs.existsSync(oldDir) && !fs.existsSync(newDir)) {
    try {
      fs.renameSync(oldDir, newDir);
    } catch {
      app.setPath('userData', oldDir);
    }
  }
}

const ptys = new Map(); // pane id -> pty process
let win;

const configPath = () => path.join(app.getPath('userData'), 'panes.json');
const usageDir = () => path.join(app.getPath('userData'), 'usage');
const fwd = (p) => p.replace(/\\/g, '/');

// Saved settings: { panes: [...], background: { path, opacity, ... } }
function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(configPath(), 'utf8'));
  } catch {
    return {};
  }
}

function saveConfig(changes) {
  fs.mkdirSync(path.dirname(configPath()), { recursive: true });
  fs.writeFileSync(configPath(), JSON.stringify({ ...loadConfig(), ...changes }, null, 2));
}

// The window can only load the video through a file:// URL.
function withUrl(background) {
  if (!background?.path || !fs.existsSync(background.path)) return { ...background, path: null, url: null };
  return { ...background, url: pathToFileURL(background.path).href };
}

// Find claude on PATH so node-pty gets a full path to launch.
function findClaude() {
  const dirs = (process.env.PATH || '').split(path.delimiter);
  const exts = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : [''];
  for (const dir of dirs) {
    for (const ext of exts) {
      const full = path.join(dir, 'claude' + ext);
      if (fs.existsSync(full)) return full;
    }
  }
  return null;
}

// If Nova Grid was itself started from inside a Claude session, drop that
// session's markers so each pane starts as its own independent Claude.
const PARENT_SESSION_VARS = [
  'CLAUDECODE',
  'CLAUDE_CODE_CHILD_SESSION',
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_CODE_SESSION_ATTENDED',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_EXECPATH',
  'CLAUDE_CODE_MESSAGING_SOCKET',
  'CLAUDE_CODE_MESSAGING_TOKEN',
  'CLAUDE_PID',
  'CLAUDE_EFFORT',
  'AI_AGENT',
];

function cleanEnv() {
  const env = { ...process.env, COLORTERM: 'truecolor' };
  for (const key of PARENT_SESSION_VARS) delete env[key];
  return env;
}

// Terminal output can still arrive while the window is closing.
function send(channel, ...args) {
  if (!win || win.isDestroyed() || win.webContents.isDestroyed()) return;
  try {
    win.webContents.send(channel, ...args);
  } catch {}
}

function createWindow() {
  win = new BrowserWindow({
    width: 1600,
    height: 950,
    backgroundColor: '#1a1b1e',
    title: 'Nova Grid',
    icon: path.join(__dirname, 'icon.png'),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.setMenu(null);
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  // Hand back any pulled-in programs before the window goes, or Windows
  // would close them along with it.
  win.on('close', embed.releaseAll);
}

// Programs pulled into panes (see embed.js).
const parentHwnd = () => Number(win.getNativeWindowHandle().readBigUInt64LE(0));
ipcMain.handle('app:attach', (_e, id, appKey) =>
  embed.attach(id, appKey, parentHwnd(), (status) => send('app:status', id, status))
);
ipcMain.on('app:place', (_e, id, rect, visible) => embed.place(id, rect, visible));
ipcMain.on('app:focus', (_e, id) => embed.focus(id));
ipcMain.on('app:release', (_e, id) => embed.release(id));
setInterval(() => {
  const { gone, titles } = embed.check();
  if (gone.length || Object.keys(titles).length) send('app:check', gone, titles);
}, 2000);

ipcMain.handle('panes:load', () => loadConfig().panes || []);
ipcMain.handle('panes:save', (_e, panes) => saveConfig({ panes }));

ipcMain.handle('background:load', () => withUrl(loadConfig().background));
ipcMain.handle('background:save', (_e, background) => {
  // loops: each library video's own "play from / until", keyed by file name
  const { path: file, opacity, muted, volume, start, end, loops, autoNext } = background;
  saveConfig({ background: { path: file, opacity, muted, volume, start, end, loops, autoNext } });
  return withUrl(background);
});

// Imported backgrounds are copied into this folder, so they keep working even
// if the original file is moved or deleted.
const VIDEO_TYPES = ['mp4', 'webm', 'm4v', 'ogv', 'mov'];
const libraryDir = () => path.join(__dirname, 'backgrounds');

function listLibrary() {
  fs.mkdirSync(libraryDir(), { recursive: true });
  return fs
    .readdirSync(libraryDir())
    .filter((f) => VIDEO_TYPES.includes(path.extname(f).slice(1).toLowerCase()))
    .map((f) => ({ name: path.parse(f).name, file: f, path: path.join(libraryDir(), f) }));
}

// "clip.mp4" -> "clip (2).mp4" if that name is already taken
function freeName(file) {
  const { name, ext } = path.parse(file);
  let candidate = file;
  for (let n = 2; fs.existsSync(path.join(libraryDir(), candidate)); n++) candidate = `${name} (${n})${ext}`;
  return candidate;
}

ipcMain.handle('library:list', () => listLibrary());

ipcMain.handle('library:import', async () => {
  const result = await dialog.showOpenDialog(win, {
    title: 'Import background videos',
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: 'Videos', extensions: VIDEO_TYPES }],
  });
  if (result.canceled) return { library: listLibrary(), imported: [] };
  fs.mkdirSync(libraryDir(), { recursive: true });
  const imported = result.filePaths.map((src) => {
    const dest = path.join(libraryDir(), freeName(path.basename(src)));
    fs.copyFileSync(src, dest);
    return dest;
  });
  return { library: listLibrary(), imported };
});

// Downloading from a link (YouTube, Pinterest, ...) uses yt-dlp, plus ffmpeg to
// join YouTube's separate picture and sound. winget installs them under its
// Packages folder, which may not be on PATH yet.
function findTool(exe) {
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    const full = path.join(dir, exe);
    if (fs.existsSync(full)) return full;
  }
  const packages = path.join(os.homedir(), 'AppData', 'Local', 'Microsoft', 'WinGet', 'Packages');
  const search = (dir, depth) => {
    if (depth > 4 || !fs.existsSync(dir)) return null;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isFile() && entry.name.toLowerCase() === exe) return full;
      if (entry.isDirectory()) {
        const found = search(full, depth + 1);
        if (found) return found;
      }
    }
    return null;
  };
  return search(packages, 0);
}

const slug = (title) =>
  title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 50).replace(/-+$/, '') || 'video';

function runYtDlp(args, onProgress) {
  return new Promise((resolve) => {
    const proc = spawn(args.ytdlp, args.list, { windowsHide: true });
    let out = '';
    let err = '';
    proc.stdout.on('data', (chunk) => {
      out += chunk;
      const pct = /\[download\]\s+([\d.]+)%/.exec(String(chunk));
      if (pct) onProgress(Number(pct[1]));
    });
    proc.stderr.on('data', (chunk) => (err += chunk));
    proc.on('close', (code) => resolve({ code, out, err }));
  });
}

ipcMain.handle('library:download', async (_e, url) => {
  const ytdlp = findTool('yt-dlp.exe');
  if (!ytdlp) return { error: 'The downloader (yt-dlp) is not installed.' };
  const ffmpeg = findTool('ffmpeg.exe');
  const node = findTool('node.exe');
  fs.mkdirSync(libraryDir(), { recursive: true });

  const list = [
    '--no-playlist', '--newline', '--retries', '10', '--fragment-retries', '10',
    '-f', 'bv*[height<=1080][vcodec^=avc1]+ba[ext=m4a]/bv*[height<=1080]+ba/b',
    '--merge-output-format', 'mp4',
    '-o', path.join(libraryDir(), 'download-%(id)s.%(ext)s'),
    '--print', 'after_move:%(title)s\t%(filepath)s',
    ...(ffmpeg ? ['--ffmpeg-location', path.dirname(ffmpeg)] : []),
    ...(node ? ['--js-runtimes', `node:${node}`] : []),
    url,
  ];
  const progress = (pct) => send('library:progress', pct);

  // YouTube sometimes cuts a download off part-way; yt-dlp resumes on a retry.
  let result;
  for (let attempt = 0; attempt < 3; attempt++) {
    result = await runYtDlp({ ytdlp, list }, progress);
    if (result.code === 0) break;
  }
  const line = result.out.split(/\r?\n/).reverse().find((l) => l.includes('\t'));
  if (result.code !== 0 || !line) {
    const reason = (result.err.match(/ERROR: (.*)/) || [])[1] || 'the download failed';
    return { error: `Could not download that link: ${reason.slice(0, 200)}` };
  }

  // Rename "download-<id>.mp4" after the video's title.
  const [title, downloaded] = line.split('\t');
  const dest = path.join(libraryDir(), freeName(slug(title) + path.extname(downloaded)));
  fs.renameSync(downloaded, dest);
  return { library: listLibrary(), imported: dest, title };
});

// Moves the video to the Recycle Bin rather than deleting it outright.
ipcMain.handle('library:remove', async (_e, file) => {
  const target = path.join(libraryDir(), path.basename(file));
  if (fs.existsSync(target)) await shell.trashItem(target);
  return listLibrary();
});

ipcMain.handle('folder:pick', async () => {
  const result = await dialog.showOpenDialog(win, {
    title: 'Choose a folder for this Claude terminal',
    properties: ['openDirectory'],
  });
  return result.canceled ? null : result.filePaths[0];
});

const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
const MODELS = ['fable', 'opus', 'sonnet', 'haiku'];

// Give each pane a status line that reports its model and usage back to us.
function paneSettingsFile(id) {
  fs.mkdirSync(usageDir(), { recursive: true });
  const usageFile = fwd(path.join(usageDir(), `${id}.json`));
  const script = fwd(path.join(__dirname, 'statusline.js'));
  const settingsFile = path.join(usageDir(), `${id}.settings.json`);
  const settings = { statusLine: { type: 'command', command: `node "${script}" "${usageFile}"`, padding: 0 } };
  fs.writeFileSync(settingsFile, JSON.stringify(settings));
  return settingsFile;
}

ipcMain.handle('pty:start', (_e, { id, cwd, cols, rows, effort, model, resume }) => {
  const claude = findClaude();
  if (!claude) return { error: 'Could not find "claude" on your PATH.' };
  if (!fs.existsSync(cwd)) return { error: `Folder not found: ${cwd}` };

  // .cmd/.bat launchers have to go through cmd.exe
  const isScript = /\.(cmd|bat)$/i.test(claude);
  const file = isScript ? process.env.ComSpec || 'cmd.exe' : claude;
  const args = isScript ? ['/c', claude] : [];
  if (EFFORTS.includes(effort)) args.push('--effort', effort);
  if (MODELS.includes(model)) args.push('--model', model);
  args.push('--settings', paneSettingsFile(id));
  // A brand-new conversation has nothing saved yet, so there is nothing to resume.
  if (resume?.id && resume.transcript && fs.existsSync(resume.transcript)) args.push('--resume', resume.id);

  const proc = pty.spawn(file, args, {
    name: 'xterm-256color',
    cols: cols || 80,
    rows: rows || 24,
    cwd,
    env: cleanEnv(),
  });
  ptys.set(id, proc);

  proc.onData((data) => {
    send('pty:data', id, data);
  });
  proc.onExit(({ exitCode }) => {
    // Only report exits we didn't cause; a killed or replaced process is already gone from the map.
    if (ptys.get(id) !== proc) return;
    ptys.delete(id);
    send('pty:exit', id, exitCode);
  });
  return { ok: true };
});

// MCP servers available in a folder, from `claude mcp list` (which also checks
// whether each one connects). Takes several seconds, so panes in the same
// folder share one check.
const mcpChecks = new Map(); // folder -> promise of the list

function parseMcpList(text) {
  const servers = [];
  for (const line of text.split(/\r?\n/)) {
    const m = /^(.+?): .* - (\S+)\s+(.+)$/.exec(line.trim());
    if (!m) continue;
    const [, rawName, , statusText] = m;
    const status = /connected/i.test(statusText) ? 'connected' : /auth/i.test(statusText) ? 'auth' : 'failed';
    // "plugin:cloudflare:cloudflare" -> "cloudflare", "claude.ai Claude Docs" -> "Claude Docs"
    const name = rawName.replace(/^plugin:[^:]+:/, '').replace(/^claude\.ai /, '');
    servers.push({ name, status, statusText });
  }
  return servers;
}

function checkMcp(cwd) {
  const claude = findClaude();
  if (!claude || !fs.existsSync(cwd)) return Promise.resolve({ error: 'Cannot check this folder' });
  return new Promise((resolve) => {
    const proc = spawn(claude, ['mcp', 'list'], { cwd, env: cleanEnv(), windowsHide: true });
    let out = '';
    proc.stdout.on('data', (chunk) => (out += chunk));
    proc.stderr.on('data', (chunk) => (out += chunk));
    const timer = setTimeout(() => proc.kill(), 60000);
    proc.on('close', () => {
      clearTimeout(timer);
      resolve({ at: Date.now(), servers: parseMcpList(out) });
    });
    proc.on('error', () => resolve({ error: 'Could not run claude mcp list' }));
  });
}

ipcMain.handle('mcp:list', (_e, cwd, refresh) => {
  const key = path.resolve(cwd).toLowerCase();
  if (refresh || !mcpChecks.has(key)) {
    const check = checkMcp(cwd);
    mcpChecks.set(key, check);
    // forget failed checks so the next pane tries again
    check.then((r) => r.error && mcpChecks.delete(key));
  }
  return mcpChecks.get(key);
});

ipcMain.on('pty:write', (_e, id, data) => ptys.get(id)?.write(data));

ipcMain.on('pty:resize', (_e, id, cols, rows) => {
  try {
    ptys.get(id)?.resize(cols, rows);
  } catch {
    // the process may have just exited
  }
});

ipcMain.on('pty:kill', (_e, id) => {
  const proc = ptys.get(id);
  ptys.delete(id);
  try {
    proc?.kill();
  } catch {}
});

ipcMain.on('clipboard:write', (_e, text) => clipboard.writeText(text));
ipcMain.handle('clipboard:read', () => clipboard.readText());

function killAll() {
  for (const proc of ptys.values()) {
    try {
      proc.kill();
    } catch {}
  }
  ptys.clear();
}

// The Fable limit isn't passed to status lines, so ask Anthropic for the
// account's usage directly, using the login Claude Code saved (the same
// request its /usage screen makes). The token is only sent to Anthropic.
const ACCOUNT_USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
const ACCOUNT_USAGE_EVERY = 5 * 60 * 1000;

async function fetchAccountUsage() {
  let login;
  try {
    const file = path.join(os.homedir(), '.claude', '.credentials.json');
    login = JSON.parse(fs.readFileSync(file, 'utf8')).claudeAiOauth;
  } catch {
    return { error: 'No saved Claude login found' };
  }
  if (!login?.accessToken) return { error: 'No saved Claude login found' };
  // Claude Code renews the login when it next talks to Anthropic; try again then.
  if (login.expiresAt && login.expiresAt < Date.now()) return { error: 'Saved login has expired' };

  try {
    const res = await fetch(ACCOUNT_USAGE_URL, {
      headers: { Authorization: `Bearer ${login.accessToken}`, 'anthropic-beta': 'oauth-2025-04-20' },
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) return { error: `Anthropic answered ${res.status}` };
    return { at: Date.now(), limits: await res.json() };
  } catch (err) {
    return { error: `Could not reach Anthropic (${err.name})` };
  }
}

async function sendAccountUsage() {
  send('account-usage', await fetchAccountUsage());
}

ipcMain.on('account-usage:refresh', sendAccountUsage);

// Whenever a pane's status line writes new numbers, pass them all to the window.
function watchUsage() {
  fs.rmSync(usageDir(), { recursive: true, force: true });
  fs.mkdirSync(usageDir(), { recursive: true });
  let timer;
  fs.watch(usageDir(), (_event, file) => {
    if (!file || file.endsWith('.settings.json')) return;
    clearTimeout(timer);
    timer = setTimeout(sendUsage, 300);
  });
}

function sendUsage() {
  const byPane = {};
  for (const file of fs.readdirSync(usageDir())) {
    if (!file.endsWith('.json') || file.endsWith('.settings.json')) continue;
    try {
      byPane[file.slice(0, -5)] = JSON.parse(fs.readFileSync(path.join(usageDir(), file), 'utf8'));
    } catch {
      // half-written; the next change will pick it up
    }
  }
  send('usage', byPane);
}

app.whenReady().then(() => {
  watchUsage();
  createWindow();
  win.webContents.on('did-finish-load', sendAccountUsage);
  setInterval(sendAccountUsage, ACCOUNT_USAGE_EVERY);
});
app.on('before-quit', () => {
  embed.releaseAll();
  killAll();
});
app.on('window-all-closed', () => {
  killAll();
  app.quit();
});

// Pulls other programs' windows (ChatGPT, Obsidian, Microsoft Edge)
// into Nova Grid panes. Windows doesn't properly support this: the program's
// window is made a child of Nova Grid's window, which mostly works but can
// glitch. Windows are always handed back before Nova Grid closes, because
// Windows destroys a child window along with its parent.
// A faded (see-through) program can't be a child window: these programs draw
// with the graphics card, and a faded child window comes out blank. So while
// faded, the window floats on top of Nova Grid instead, borderless and kept
// over its pane, and goes back inside when made solid again.
const koffi = require('koffi');
const path = require('path');
const { execFile, spawn } = require('child_process');

const user32 = koffi.load('user32.dll');
const kernel32 = koffi.load('kernel32.dll');
const gdi32 = koffi.load('gdi32.dll');

const RECT = koffi.struct('RECT', { left: 'int32', top: 'int32', right: 'int32', bottom: 'int32' });
const POINT = koffi.struct('POINT', { x: 'int32', y: 'int32' });
const WINDOWPLACEMENT = koffi.struct('WINDOWPLACEMENT', {
  length: 'uint32',
  flags: 'uint32',
  showCmd: 'uint32',
  minPosition: POINT,
  maxPosition: POINT,
  normalPosition: RECT,
});
const BITMAPINFOHEADER = koffi.struct('BITMAPINFOHEADER', {
  biSize: 'uint32',
  biWidth: 'int32',
  biHeight: 'int32',
  biPlanes: 'uint16',
  biBitCount: 'uint16',
  biCompression: 'uint32',
  biSizeImage: 'uint32',
  biXPelsPerMeter: 'int32',
  biYPelsPerMeter: 'int32',
  biClrUsed: 'uint32',
  biClrImportant: 'uint32',
});
const EnumProc = koffi.proto('bool __stdcall EnumWindowsProc(intptr_t hwnd, intptr_t lParam)');
const w = {
  EnumWindows: user32.func('bool __stdcall EnumWindows(EnumWindowsProc *cb, intptr_t lParam)'),
  GetWindowThreadProcessId: user32.func('uint32 __stdcall GetWindowThreadProcessId(intptr_t hwnd, _Out_ uint32 *pid)'),
  IsWindow: user32.func('bool __stdcall IsWindow(intptr_t hwnd)'),
  IsWindowVisible: user32.func('bool __stdcall IsWindowVisible(intptr_t hwnd)'),
  IsIconic: user32.func('bool __stdcall IsIconic(intptr_t hwnd)'),
  GetWindow: user32.func('intptr_t __stdcall GetWindow(intptr_t hwnd, uint32 cmd)'),
  GetWindowTextW: user32.func('int __stdcall GetWindowTextW(intptr_t hwnd, uint8 *buf, int max)'),
  GetWindowRect: user32.func('bool __stdcall GetWindowRect(intptr_t hwnd, _Out_ RECT *rect)'),
  GetWindowPlacement: user32.func('bool __stdcall GetWindowPlacement(intptr_t hwnd, _Inout_ WINDOWPLACEMENT *wp)'),
  GetWindowLongPtrW: user32.func('intptr_t __stdcall GetWindowLongPtrW(intptr_t hwnd, int index)'),
  SetWindowLongPtrW: user32.func('intptr_t __stdcall SetWindowLongPtrW(intptr_t hwnd, int index, intptr_t value)'),
  SetParent: user32.func('intptr_t __stdcall SetParent(intptr_t child, intptr_t parent)'),
  SetWindowPos: user32.func('bool __stdcall SetWindowPos(intptr_t hwnd, intptr_t after, int x, int y, int cx, int cy, uint32 flags)'),
  ShowWindow: user32.func('bool __stdcall ShowWindow(intptr_t hwnd, int cmd)'),
  SetFocus: user32.func('intptr_t __stdcall SetFocus(intptr_t hwnd)'),
  SetForegroundWindow: user32.func('bool __stdcall SetForegroundWindow(intptr_t hwnd)'),
  ClientToScreen: user32.func('bool __stdcall ClientToScreen(intptr_t hwnd, _Inout_ POINT *pt)'),
  SetLayeredWindowAttributes: user32.func('bool __stdcall SetLayeredWindowAttributes(intptr_t hwnd, uint32 key, uint8 alpha, uint32 flags)'),
  PostMessageW: user32.func('bool __stdcall PostMessageW(intptr_t hwnd, uint32 msg, uintptr_t wParam, intptr_t lParam)'),
  GetClientRect: user32.func('bool __stdcall GetClientRect(intptr_t hwnd, _Out_ RECT *rect)'),
  ScreenToClient: user32.func('bool __stdcall ScreenToClient(intptr_t hwnd, _Inout_ POINT *pt)'),
  WindowFromPoint: user32.func('intptr_t __stdcall WindowFromPoint(POINT pt)'),
  IsChild: user32.func('bool __stdcall IsChild(intptr_t parent, intptr_t hwnd)'),
  GetClassNameW: user32.func('int __stdcall GetClassNameW(intptr_t hwnd, uint8 *buf, int max)'),
  GetCursorPos: user32.func('bool __stdcall GetCursorPos(_Out_ POINT *pt)'),
  SetCursorPos: user32.func('bool __stdcall SetCursorPos(int x, int y)'),
  MapVirtualKeyW: user32.func('uint32 __stdcall MapVirtualKeyW(uint32 code, uint32 type)'),
  GetDC: user32.func('intptr_t __stdcall GetDC(intptr_t hwnd)'),
  ReleaseDC: user32.func('int __stdcall ReleaseDC(intptr_t hwnd, intptr_t dc)'),
  PrintWindow: user32.func('bool __stdcall PrintWindow(intptr_t hwnd, intptr_t dc, uint32 flags)'),
  CreateCompatibleDC: gdi32.func('intptr_t __stdcall CreateCompatibleDC(intptr_t dc)'),
  CreateCompatibleBitmap: gdi32.func('intptr_t __stdcall CreateCompatibleBitmap(intptr_t dc, int width, int height)'),
  SelectObject: gdi32.func('intptr_t __stdcall SelectObject(intptr_t dc, intptr_t obj)'),
  GetDIBits: gdi32.func('int __stdcall GetDIBits(intptr_t dc, intptr_t bmp, uint32 start, uint32 lines, _Out_ uint8 *bits, BITMAPINFOHEADER *info, uint32 usage)'),
  DeleteObject: gdi32.func('bool __stdcall DeleteObject(intptr_t obj)'),
  DeleteDC: gdi32.func('bool __stdcall DeleteDC(intptr_t dc)'),
  OpenProcess: kernel32.func('intptr_t __stdcall OpenProcess(uint32 access, bool inherit, uint32 pid)'),
  QueryFullProcessImageNameW: kernel32.func('bool __stdcall QueryFullProcessImageNameW(intptr_t proc, uint32 flags, uint8 *buf, _Inout_ uint32 *size)'),
  CloseHandle: kernel32.func('bool __stdcall CloseHandle(intptr_t h)'),
};

const GWL_STYLE = -16;
const GWL_EXSTYLE = -20;
const GWLP_HWNDPARENT = -8; // on a top-level window: its owner
const GW_OWNER = 4;
const GW_HWNDNEXT = 2;
const GW_CHILD = 5;
const WS_CHILD = 0x40000000;
const WS_POPUP = 0x80000000 | 0;
const WS_FRAME = 0x00c00000 | 0x00040000 | 0x00080000 | 0x00020000 | 0x00010000; // caption, sizing border, system menu, min/max
const WS_EX_APPWINDOW = 0x00040000;
const WS_EX_TOPMOST = 0x00000008;
const WS_EX_LAYERED = 0x00080000;
const LWA_ALPHA = 0x2;
const SWP_NOACTIVATE = 0x10;
const SWP_FRAMECHANGED = 0x20;
const SWP_SHOWWINDOW = 0x40;
const SWP_NOZORDER = 0x4;
const SWP_NOSIZE = 0x1;
const SWP_NOMOVE = 0x2;
const SW_HIDE = 0;
const SW_SHOWNA = 8;
const SW_RESTORE = 9;
const SW_SHOW = 5;
const WM_CLOSE = 0x0010;
const WM_KEYDOWN = 0x0100;
const WM_KEYUP = 0x0101;
const WM_CHAR = 0x0102;
const WM_MOUSEMOVE = 0x0200;
const WM_LBUTTONDOWN = 0x0201;
const WM_LBUTTONUP = 0x0202;
const WM_MOUSEWHEEL = 0x020a;
const MK_LBUTTON = 0x1;
const PW_RENDERFULLCONTENT = 0x2;

// exe: the program's file name. startName: its name in the Start menu, used to launch it.
// ChatGPT and Obsidian have a single main window, so opening them again never
// gives a second one. Edge opens a new window each time (multiWindow), so each
// Edge pane can have its own, and closing the pane closes its window
// (closeWithPane). (Blender and Roblox Studio were tried too, but stay blank
// inside the pane.)
const APPS = {
  chatgpt: { name: 'ChatGPT', exe: 'chatgpt.exe', startName: /^ChatGPT$/ },
  obsidian: { name: 'Obsidian', exe: 'obsidian.exe', startName: /^Obsidian$/ },
  edge: { name: 'Microsoft Edge', exe: 'msedge.exe', startName: /^Microsoft Edge$/, multiWindow: true, closeWithPane: true },
};

const embedded = new Map(); // pane id -> { hwnd, parent, style, exStyle, rect, at, shown, floating, opacity }

function title(hwnd) {
  const buf = Buffer.alloc(1024);
  const n = w.GetWindowTextW(hwnd, buf, 512);
  return buf.toString('utf16le', 0, n * 2);
}

function exeOf(hwnd) {
  const pid = [0];
  w.GetWindowThreadProcessId(hwnd, pid);
  const proc = w.OpenProcess(0x1000, false, pid[0]); // query limited information
  if (!proc) return '';
  try {
    const buf = Buffer.alloc(2048);
    const size = [1024];
    if (!w.QueryFullProcessImageNameW(proc, 0, buf, size)) return '';
    return path.basename(buf.toString('utf16le', 0, size[0] * 2)).toLowerCase();
  } finally {
    w.CloseHandle(proc);
  }
}

function rectOf(hwnd) {
  const r = {};
  w.GetWindowRect(hwnd, r);
  return r;
}

// Where the window sits when not minimised (a minimised one is a tiny strip off-screen).
function normalRect(hwnd) {
  if (!w.IsIconic(hwnd)) return rectOf(hwnd);
  const wp = { length: koffi.sizeof(WINDOWPLACEMENT) };
  w.GetWindowPlacement(hwnd, wp);
  return wp.normalPosition;
}

// The program's main window: visible, not owned by another window, has a
// title, and is the biggest of its windows. Windows already in a pane are skipped.
function findWindow(exe) {
  const taken = new Set([...embedded.values()].map((e) => e.hwnd));
  let best = null;
  let bestArea = 0;
  w.EnumWindows((hwnd) => {
    if (taken.has(hwnd) || !w.IsWindowVisible(hwnd) || w.GetWindow(hwnd, GW_OWNER)) return true;
    if (!title(hwnd) || exeOf(hwnd) !== exe) return true;
    const r = normalRect(hwnd);
    const area = (r.right - r.left) * (r.bottom - r.top);
    if (r.right - r.left >= 400 && r.bottom - r.top >= 300 && area > bestArea) {
      best = hwnd;
      bestArea = area;
    }
    return true;
  }, 0);
  return best;
}

// Start the program the same way its Start menu entry does.
function launch(app) {
  return new Promise((resolve) => {
    const ps = 'Get-StartApps | ForEach-Object { "$($_.Name)`t$($_.AppID)" }';
    execFile('powershell.exe', ['-NoProfile', '-Command', ps], { windowsHide: true }, (err, out) => {
      const line = (out || '').split(/\r?\n/).find((l) => app.startName.test(l.split('\t')[0]));
      if (err || !line) return resolve(`${app.name} isn't in the Start menu, so it couldn't be opened`);
      spawn('explorer.exe', [`shell:AppsFolder\\${line.split('\t')[1]}`], { detached: true, stdio: 'ignore' }).unref();
      resolve(null);
    });
  });
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// One at a time: panes reopened together would otherwise all find the same
// window before any of them has taken it.
let queue = Promise.resolve();
function attach(...args) {
  const run = queue.then(() => attachNow(...args));
  queue = run.catch(() => {});
  return run;
}

async function attachNow(id, appKey, parentHwnd, onStatus) {
  const app = APPS[appKey];
  if (!app) return { error: 'Unknown app' };
  let hwnd = findWindow(app.exe);
  if (!hwnd && !app.multiWindow && [...embedded.values()].some((e) => e.exe === app.exe)) {
    return { error: `${app.name} is already in another pane` };
  }
  if (!hwnd) {
    onStatus(`Opening ${app.name}…`);
    const error = await launch(app);
    if (error) return { error };
    for (let i = 0; i < 120 && !hwnd; i++) {
      await wait(500);
      hwnd = findWindow(app.exe);
    }
    if (!hwnd) return { error: `${app.name} didn't open a window` };
    await wait(1500); // let it finish setting up before moving it
  }

  if (w.IsIconic(hwnd)) w.ShowWindow(hwnd, SW_RESTORE);
  const style = Number(w.GetWindowLongPtrW(hwnd, GWL_STYLE)) | 0;
  const exStyle = Number(w.GetWindowLongPtrW(hwnd, GWL_EXSTYLE)) | 0;
  const rect = normalRect(hwnd);
  w.ShowWindow(hwnd, SW_HIDE); // until the pane says where it goes
  w.SetWindowLongPtrW(hwnd, GWL_STYLE, (style & ~(WS_FRAME | WS_POPUP)) | WS_CHILD);
  w.SetWindowLongPtrW(hwnd, GWL_EXSTYLE, exStyle & ~(WS_EX_APPWINDOW | WS_EX_TOPMOST));
  if (!w.SetParent(hwnd, parentHwnd)) {
    w.SetWindowLongPtrW(hwnd, GWL_STYLE, style);
    w.SetWindowLongPtrW(hwnd, GWL_EXSTYLE, exStyle);
    w.ShowWindow(hwnd, SW_SHOW);
    return { error: `Windows wouldn't let ${app.name} be moved inside` };
  }
  embedded.set(id, { hwnd, parent: parentHwnd, exe: app.exe, closeWithPane: !!app.closeWithPane, style, exStyle, rect, shown: false, floating: false });
  return { title: title(hwnd) };
}

// Put the window where the pane last said, inside Nova Grid's content area
// (or over it on screen, while floating).
function move(e) {
  const r = e.at;
  const pt = { x: r.x, y: r.y };
  if (e.floating) w.ClientToScreen(e.parent, pt);
  // A floating window keeps its place in front of Nova Grid without help.
  const flags = SWP_NOACTIVATE | SWP_FRAMECHANGED | SWP_SHOWWINDOW | (e.floating ? SWP_NOZORDER : 0);
  w.SetWindowPos(e.hwnd, 0, pt.x, pt.y, r.width, r.height, flags);
  e.shown = true;
}

// rect is in the window's own pixels, relative to its content area.
function place(id, rect, visible) {
  const e = embedded.get(id);
  if (!e) return;
  if (!visible || !rect || rect.width < 10 || rect.height < 10) {
    if (e.shown) w.ShowWindow(e.hwnd, SW_HIDE);
    e.shown = false;
    return;
  }
  e.at = rect;
  move(e);
}

// Floating windows don't move with Nova Grid on their own, so they're moved
// along whenever it is.
function follow() {
  for (const e of embedded.values()) if (e.floating && e.shown) move(e);
}

// Inside the pane as a child window, or floating over it (see the top).
function setFloating(e, floating) {
  if (e.floating === floating) return;
  e.floating = floating;
  const style = e.style & ~(WS_FRAME | WS_POPUP | WS_CHILD);
  if (floating) {
    w.SetParent(e.hwnd, 0);
    w.SetWindowLongPtrW(e.hwnd, GWL_STYLE, style | WS_POPUP);
    // Owned by Nova Grid: always in front of it, minimised and hidden with it.
    w.SetWindowLongPtrW(e.hwnd, GWLP_HWNDPARENT, e.parent);
    w.SetWindowPos(e.hwnd, 0, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);
  } else {
    w.SetWindowLongPtrW(e.hwnd, GWLP_HWNDPARENT, 0);
    w.SetWindowLongPtrW(e.hwnd, GWL_STYLE, style | WS_CHILD);
    w.SetParent(e.hwnd, e.parent);
  }
  if (e.shown) move(e);
}

// See-through: the whole window (text too) is faded so the background video
// shows. 100 = solid. Undone in release() when the old styles go back.
function opacity(id, percent) {
  const e = embedded.get(id);
  if (!e || e.opacity === percent) return;
  e.opacity = percent;
  const exStyle = Number(w.GetWindowLongPtrW(e.hwnd, GWL_EXSTYLE)) | 0;
  if (percent >= 100) {
    w.SetWindowLongPtrW(e.hwnd, GWL_EXSTYLE, exStyle & ~WS_EX_LAYERED);
    setFloating(e, false);
    return;
  }
  setFloating(e, true);
  w.SetWindowLongPtrW(e.hwnd, GWL_EXSTYLE, exStyle | WS_EX_LAYERED);
  w.SetLayeredWindowAttributes(e.hwnd, 0, Math.round((percent / 100) * 255), LWA_ALPHA);
}

function focus(id) {
  const e = embedded.get(id);
  if (!e) return;
  if (e.floating) w.SetForegroundWindow(e.hwnd);
  else w.SetFocus(e.hwnd);
}

// Give the window back as it was: own frame, own taskbar button, old position.
function giveBack(e, show) {
  w.ShowWindow(e.hwnd, SW_HIDE);
  w.SetParent(e.hwnd, 0);
  w.SetWindowLongPtrW(e.hwnd, GWLP_HWNDPARENT, 0);
  w.SetWindowLongPtrW(e.hwnd, GWL_STYLE, e.style);
  w.SetWindowLongPtrW(e.hwnd, GWL_EXSTYLE, e.exStyle);
  const r = e.rect;
  w.SetWindowPos(e.hwnd, 0, r.left, r.top, r.right - r.left, r.bottom - r.top, SWP_NOZORDER | SWP_FRAMECHANGED | (show ? SWP_SHOWWINDOW : 0));
  if (show) w.ShowWindow(e.hwnd, SW_SHOW);
}

function release(id) {
  const e = embedded.get(id);
  if (!e) return;
  embedded.delete(id);
  if (w.IsWindow(e.hwnd)) giveBack(e, true);
}

// The pane's close button: closes the window for programs with
// closeWithPane (Edge), and gives it back for the rest. The window is given
// back hidden first, so if Edge asks "close all tabs?" it can be shown again
// to answer.
function close(id) {
  const e = embedded.get(id);
  if (!e?.closeWithPane) return release(id);
  embedded.delete(id);
  if (!w.IsWindow(e.hwnd)) return;
  giveBack(e, false);
  w.PostMessageW(e.hwnd, WM_CLOSE, 0, 0);
  setTimeout(() => {
    if (w.IsWindow(e.hwnd) && !w.IsWindowVisible(e.hwnd)) w.ShowWindow(e.hwnd, SW_SHOW);
  }, 1500);
}

function releaseAll() {
  for (const id of [...embedded.keys()]) release(id);
}

// Panes whose program was closed from inside (e.g. File > Quit), and the
// current titles of the rest.
function check() {
  const gone = [];
  const titles = {};
  for (const [id, e] of embedded) {
    if (w.IsWindow(e.hwnd)) titles[id] = title(e.hwnd);
    else {
      embedded.delete(id);
      gone.push(id);
    }
  }
  return { gone, titles };
}

// ---------- the phone remote ----------
// A phone can watch a program's pane as a picture and tap, scroll and type
// into it. The picture comes from the program itself, so it still works with
// other windows on top, but not while Nova Grid is minimised or the pane is
// hidden: the program draws nothing then. Taps and typing go straight to the
// program's window, so the PC's own mouse and keyboard are left alone
// (except for scrolling, see scroll()).

function className(hwnd) {
  const buf = Buffer.alloc(512);
  const n = w.GetClassNameW(hwnd, buf, 256);
  return buf.toString('utf16le', 0, n * 2);
}

// The picture as raw pixels (blue, green, red, alpha), or why there isn't one.
function picture(id) {
  const e = embedded.get(id);
  if (!e || !w.IsWindow(e.hwnd)) return { state: 'gone' };
  if (w.IsIconic(e.parent)) return { state: 'minimised' };
  if (!e.shown) return { state: 'hidden' };
  const r = {};
  w.GetClientRect(e.hwnd, r);
  const width = r.right;
  const height = r.bottom;
  if (width < 10 || height < 10) return { state: 'hidden' };

  const screen = w.GetDC(0);
  const dc = w.CreateCompatibleDC(screen);
  const bmp = w.CreateCompatibleBitmap(screen, width, height);
  const old = w.SelectObject(dc, bmp);
  // "full content" asks for what the program draws with the graphics card too
  w.PrintWindow(e.hwnd, dc, PW_RENDERFULLCONTENT);
  w.SelectObject(dc, old);
  const pixels = Buffer.alloc(width * height * 4);
  // a negative height gives the top row first
  const info = { biSize: koffi.sizeof(BITMAPINFOHEADER), biWidth: width, biHeight: -height, biPlanes: 1, biBitCount: 32 };
  w.GetDIBits(dc, bmp, 0, height, pixels, info, 0);
  w.DeleteObject(bmp);
  w.DeleteDC(dc);
  w.ReleaseDC(0, screen);
  for (let i = 3; i < pixels.length; i += 4) pixels[i] = 255; // the copy leaves the alpha unset
  return { state: 'ok', width, height, pixels };
}

const lparam = (x, y) => ((y & 0xffff) << 16) | (x & 0xffff);

// The innermost window at a spot in the pane (fx, fy: fractions of its size).
// These programs take the mouse in a child window over the page; their
// "Intermediate D3D Window" is only for drawing, so it's passed over.
function windowAt(e, fx, fy) {
  const r = {};
  w.GetClientRect(e.hwnd, r);
  const clamp = (f) => Math.min(Math.max(Number(f) || 0, 0), 1);
  const screen = { x: Math.round(clamp(fx) * (r.right - 1)), y: Math.round(clamp(fy) * (r.bottom - 1)) };
  w.ClientToScreen(e.hwnd, screen);
  let hwnd = e.hwnd;
  for (let depth = 0; depth < 8; depth++) {
    let inner = 0;
    for (let c = w.GetWindow(hwnd, GW_CHILD); c; c = w.GetWindow(c, GW_HWNDNEXT)) {
      if (!w.IsWindowVisible(c) || className(c) === 'Intermediate D3D Window') continue;
      const cr = rectOf(c);
      if (screen.x >= cr.left && screen.x < cr.right && screen.y >= cr.top && screen.y < cr.bottom) {
        inner = c;
        break;
      }
    }
    if (!inner) break;
    hwnd = inner;
  }
  const local = { ...screen };
  w.ScreenToClient(hwnd, local);
  return { hwnd, x: local.x, y: local.y, screen };
}

const belongs = (e, hwnd) => hwnd === e.hwnd || w.IsChild(e.hwnd, hwnd);

function tap(id, fx, fy) {
  const e = embedded.get(id);
  if (!e || !w.IsWindow(e.hwnd)) return;
  const at = windowAt(e, fx, fy);
  e.typeInto = at.hwnd; // typing goes where the last tap went
  const lp = lparam(at.x, at.y);
  w.PostMessageW(at.hwnd, WM_MOUSEMOVE, 0, lp);
  w.PostMessageW(at.hwnd, WM_LBUTTONDOWN, MK_LBUTTON, lp);
  setTimeout(() => w.IsWindow(at.hwnd) && w.PostMessageW(at.hwnd, WM_LBUTTONUP, 0, lp), 30);
}

// These programs only take the mouse wheel where the PC's pointer really is,
// so the pointer is moved over the spot while scrolling and put back a moment
// later. Returns false if something covers the spot on the PC's screen.
let pointerWas = null;
let pointerTimer;
function scroll(id, fx, fy, delta) {
  const e = embedded.get(id);
  if (!e || !w.IsWindow(e.hwnd)) return true;
  const at = windowAt(e, fx, fy);
  if (!belongs(e, w.WindowFromPoint(at.screen))) return false;
  if (!pointerWas) {
    pointerWas = {};
    w.GetCursorPos(pointerWas);
  }
  w.SetCursorPos(at.screen.x, at.screen.y);
  const amount = Math.max(-1200, Math.min(1200, Math.round(Number(delta) || 0)));
  w.PostMessageW(at.hwnd, WM_MOUSEWHEEL, ((amount & 0xffff) << 16) >>> 0, lparam(at.screen.x, at.screen.y));
  clearTimeout(pointerTimer);
  pointerTimer = setTimeout(() => {
    w.SetCursorPos(pointerWas.x, pointerWas.y);
    pointerWas = null;
  }, 400);
  return true;
}

function typeTarget(e) {
  if (e.typeInto && w.IsWindow(e.typeInto) && belongs(e, e.typeInto)) return e.typeInto;
  return windowAt(e, 0.5, 0.5).hwnd;
}

// Text as typed characters. New lines become spaces, as Enter would send a
// half-written ChatGPT message.
function type(id, text) {
  const e = embedded.get(id);
  if (!e || !w.IsWindow(e.hwnd)) return;
  const hwnd = typeTarget(e);
  const clean = String(text).replace(/\r?\n/g, ' ');
  for (let i = 0; i < clean.length; i++) w.PostMessageW(hwnd, WM_CHAR, clean.charCodeAt(i), 1);
}

// name -> [virtual key, also types a character (as the real key does), on the keyboard's extended part]
const KEYS = {
  Enter: [0x0d, true],
  Backspace: [0x08, true],
  Tab: [0x09, true],
  Escape: [0x1b, true],
  PageUp: [0x21, false, true],
  PageDown: [0x22, false, true],
  End: [0x23, false, true],
  Home: [0x24, false, true],
  ArrowLeft: [0x25, false, true],
  ArrowUp: [0x26, false, true],
  ArrowRight: [0x27, false, true],
  ArrowDown: [0x28, false, true],
  Delete: [0x2e, false, true],
};

function key(id, name) {
  const e = embedded.get(id);
  const k = KEYS[name];
  if (!e || !k || !w.IsWindow(e.hwnd)) return;
  const [vk, char, extended] = k;
  const hwnd = typeTarget(e);
  const lp = 1 | (w.MapVirtualKeyW(vk, 0) << 16) | (extended ? 1 << 24 : 0);
  w.PostMessageW(hwnd, WM_KEYDOWN, vk, lp);
  if (char) w.PostMessageW(hwnd, WM_CHAR, vk, lp);
  w.PostMessageW(hwnd, WM_KEYUP, vk, lp | 0xc0000000);
}

module.exports = { APPS, attach, place, follow, opacity, focus, release, close, releaseAll, check, picture, tap, scroll, type, key };

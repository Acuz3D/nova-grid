const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  loadPanes: () => ipcRenderer.invoke('panes:load'),
  savePanes: (panes) => ipcRenderer.invoke('panes:save', panes),
  pickFolder: () => ipcRenderer.invoke('folder:pick'),
  listLibrary: () => ipcRenderer.invoke('library:list'),
  importVideos: () => ipcRenderer.invoke('library:import'),
  removeVideo: (file) => ipcRenderer.invoke('library:remove', file),
  downloadVideo: (url) => ipcRenderer.invoke('library:download', url),
  onDownloadProgress: (cb) => ipcRenderer.on('library:progress', (_e, pct) => cb(pct)),
  loadBackground: () => ipcRenderer.invoke('background:load'),
  saveBackground: (background) => ipcRenderer.invoke('background:save', background),

  start: (opts) => ipcRenderer.invoke('pty:start', opts),
  listMcp: (cwd, refresh) => ipcRenderer.invoke('mcp:list', cwd, refresh),
  write: (id, data) => ipcRenderer.send('pty:write', id, data),
  resize: (id, cols, rows) => ipcRenderer.send('pty:resize', id, cols, rows),
  kill: (id) => ipcRenderer.send('pty:kill', id),
  onData: (cb) => ipcRenderer.on('pty:data', (_e, id, data) => cb(id, data)),
  onExit: (cb) => ipcRenderer.on('pty:exit', (_e, id, code) => cb(id, code)),

  onUsage: (cb) => ipcRenderer.on('usage', (_e, byPane) => cb(byPane)),
  onAccountUsage: (cb) => ipcRenderer.on('account-usage', (_e, usage) => cb(usage)),
  refreshAccountUsage: () => ipcRenderer.send('account-usage:refresh'),

  attachApp: (id, app) => ipcRenderer.invoke('app:attach', id, app),
  placeApp: (id, rect, visible) => ipcRenderer.send('app:place', id, rect, visible),
  focusApp: (id) => ipcRenderer.send('app:focus', id),
  releaseApp: (id) => ipcRenderer.send('app:release', id),
  onAppStatus: (cb) => ipcRenderer.on('app:status', (_e, id, status) => cb(id, status)),
  onAppCheck: (cb) => ipcRenderer.on('app:check', (_e, gone, titles) => cb(gone, titles)),

  minimizeWindow: () => ipcRenderer.send('win:minimize'),
  maximizeWindow: () => ipcRenderer.send('win:maximize'),
  closeWindow: () => ipcRenderer.send('win:close'),
  isMaximized: () => ipcRenderer.invoke('win:is-maximized'),
  onMaximized: (cb) => ipcRenderer.on('win:maximized', (_e, maximized) => cb(maximized)),

  copy: (text) => ipcRenderer.send('clipboard:write', text),
  paste: () => ipcRenderer.invoke('clipboard:read'),
});

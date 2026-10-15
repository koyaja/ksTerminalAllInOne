'use strict';
const { app, BrowserWindow, ipcMain, dialog, shell, Menu, clipboard, screen } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const { utils: sshUtils } = require('ssh2');
const { Vault } = require('./vault');
const { SshManager } = require('./ssh-manager');
const { installEditor, historyKey } = require('./remote-editor');
installEditor(SshManager);
const { parseSshConfig } = require('./ssh-config');
const { LocalManager } = require('./local-pty');
const { parsePrivateKey } = require('./keys');

const vault = new Vault(app.getPath('userData'));
let win = null;
const pendingHostKeys = new Map();

const manager = new SshManager({
  vault,
  emit: (channel, payload) => { if (win && !win.isDestroyed()) win.webContents.send(channel, payload); },
  askHostKey: (info) => new Promise(resolve => {
    const reqId = crypto.randomUUID();
    pendingHostKeys.set(reqId, resolve);
    if (win && !win.isDestroyed()) win.webContents.send('hostkey:ask', { reqId, ...info });
    else resolve(false);
  })
});

const localMgr = new LocalManager((channel, payload) => { if (win && !win.isDestroyed()) win.webContents.send(channel, payload); });

const uid = () => crypto.randomUUID();

function requireUnlocked() {
  if (!vault.isUnlocked()) throw new Error('Coffre verrouillé');
  return vault.data;
}

function publicState() {
  const d = requireUnlocked();
  return {
    hosts: d.hosts.map(({ password, sudoPassword, ...h }) => ({ ...h, hasPassword: !!password, hasSudoPassword: !!sudoPassword })),
    editHistory: Object.entries(d.editHistory || {}).map(([key, v]) => ({ key, ...v })).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
    keys: d.keys.map(({ privateKey, passphrase, ...k }) => ({ ...k, hasPassphrase: !!passphrase })),
    snippets: d.snippets,
    forwards: d.forwards,
    knownHosts: d.knownHosts,
    settings: d.settings,
    workspaces: d.workspaces || [],
    tunnels: manager.tunnelStatus()
  };
}

// Enveloppe les handlers : renvoie { ok, value } ou { ok:false, error } au renderer.
function handle(channel, fn) {
  ipcMain.handle(channel, async (_e, ...args) => {
    try { return { ok: true, value: await fn(...args) }; }
    catch (err) { return { ok: false, error: err && err.message ? err.message : String(err) }; }
  });
}

// ----- Coffre -----
handle('vault:status', () => ({ exists: vault.exists(), unlocked: vault.isUnlocked() }));
handle('vault:create', (pw) => { vault.create(pw); return publicState(); });
handle('vault:unlock', (pw) => { vault.unlock(pw); return publicState(); });
handle('vault:lock', () => { manager.closeAll(); localMgr.killAll(); vault.lock(); return true; });
handle('vault:changePassword', (oldPw, newPw) => { vault.changePassword(oldPw, newPw); return true; });
handle('vault:backup', async () => {
  const r = await dialog.showSaveDialog(win, { defaultPath: `kstermus-backup-${new Date().toISOString().slice(0, 10)}.kst` });
  if (r.canceled || !r.filePath) return false;
  vault.exportTo(r.filePath);
  return r.filePath;
});
handle('state:get', () => publicState());
handle('settings:save', (s) => { const d = requireUnlocked(); d.settings = { ...d.settings, ...s }; vault.save(); return publicState(); });

// ----- Hosts -----
handle('host:save', (input) => {
  const d = requireUnlocked();
  const existing = input.id ? d.hosts.find(h => h.id === input.id) : null;
  if (!input.hostname || !input.username) throw new Error('Adresse et utilisateur obligatoires');
  const host = {
    id: existing ? existing.id : uid(),
    label: (input.label || input.hostname).trim(),
    group: (input.group || '').trim(),
    hostname: input.hostname.trim(),
    port: Number(input.port) || 22,
    username: input.username.trim(),
    auth: input.auth || 'password',
    keyId: input.auth === 'key' ? input.keyId || null : null,
    startupCommand: input.startupCommand || '',
    color: input.color || '',
    notes: input.notes || '',
    password: existing ? existing.password : '',
    sudoPassword: existing ? existing.sudoPassword || '' : ''
  };
  if (typeof input.password === 'string' && input.password !== '') host.password = input.password;
  if (input.clearPassword) host.password = '';
  if (typeof input.sudoPassword === 'string' && input.sudoPassword !== '') host.sudoPassword = input.sudoPassword;
  if (input.clearSudoPassword) host.sudoPassword = '';
  if (host.auth === 'key' && !d.keys.some(k => k.id === host.keyId)) throw new Error('Choisis une clé du keychain');
  if (existing) Object.assign(existing, host); else d.hosts.push(host);
  vault.save();
  return publicState();
});
handle('host:delete', (id) => {
  const d = requireUnlocked();
  d.hosts = d.hosts.filter(h => h.id !== id);
  d.forwards = d.forwards.filter(f => f.hostId !== id);
  vault.save();
  return publicState();
});
handle('host:importSshConfig', async () => {
  const d = requireUnlocked();
  const def = path.join(os.homedir(), '.ssh', 'config');
  const r = await dialog.showOpenDialog(win, { defaultPath: def, properties: ['openFile', 'showHiddenFiles'] });
  if (r.canceled || !r.filePaths[0]) return { added: 0, state: publicState() };
  const entries = parseSshConfig(fs.readFileSync(r.filePaths[0], 'utf8'));
  let added = 0;
  for (const e of entries) {
    if (d.hosts.some(h => h.hostname === e.hostname && h.username === e.username && h.port === e.port)) continue;
    let keyId = null;
    if (e.identityFile) {
      try {
        const file = e.identityFile.replace(/^~/, os.homedir());
        const text = fs.readFileSync(file, 'utf8');
        let k = d.keys.find(x => x.sourceFile === file);
        if (!k) {
          const info = parsePrivateKey(text);
          k = { id: uid(), label: path.basename(file), privateKey: text, passphrase: '', sourceFile: file, createdAt: new Date().toISOString(), ...info };
          d.keys.push(k);
        }
        keyId = k.id;
      } catch { /* clé chiffrée ou illisible : on garde l'auth par mot de passe */ }
    }
    d.hosts.push({
      id: uid(), label: e.alias, group: 'Importés', hostname: e.hostname, port: e.port,
      username: e.username || os.userInfo().username, auth: keyId ? 'key' : 'password', keyId,
      startupCommand: '', color: '', notes: '', password: ''
    });
    added++;
  }
  vault.save();
  return { added, state: publicState() };
});

// ----- Keychain -----
handle('key:pickFile', async () => {
  const r = await dialog.showOpenDialog(win, { defaultPath: path.join(os.homedir(), '.ssh'), properties: ['openFile', 'showHiddenFiles'] });
  if (r.canceled || !r.filePaths[0]) return null;
  const st = fs.statSync(r.filePaths[0]);
  if (st.size > 64 * 1024) throw new Error('Fichier trop gros pour une clé SSH');
  return { name: path.basename(r.filePaths[0]), content: fs.readFileSync(r.filePaths[0], 'utf8') };
});
handle('key:import', ({ label, privateKey, passphrase }) => {
  const d = requireUnlocked();
  const info = parsePrivateKey(privateKey, passphrase);
  d.keys.push({ id: uid(), label: label || info.type, privateKey, passphrase: passphrase || '', createdAt: new Date().toISOString(), ...info });
  vault.save();
  return publicState();
});
handle('key:generate', ({ label, type, passphrase }) => {
  const d = requireUnlocked();
  const kind = type === 'rsa' ? 'rsa' : 'ed25519';
  const opts = { comment: label || `kstermus-${kind}` };
  if (kind === 'rsa') opts.bits = 4096;
  if (passphrase) { opts.passphrase = passphrase; opts.cipher = 'aes256-ctr'; }
  const kp = sshUtils.generateKeyPairSync(kind, opts);
  const info = parsePrivateKey(kp.private, passphrase);
  d.keys.push({ id: uid(), label: label || `${kind}-${new Date().toISOString().slice(0, 10)}`, privateKey: kp.private, passphrase: passphrase || '', createdAt: new Date().toISOString(), ...info, publicKey: kp.public.trim() });
  vault.save();
  return publicState();
});
handle('key:rename', (id, label) => {
  const d = requireUnlocked();
  const k = d.keys.find(x => x.id === id);
  if (k) { k.label = label; vault.save(); }
  return publicState();
});
handle('key:delete', (id) => {
  const d = requireUnlocked();
  const used = d.hosts.filter(h => h.keyId === id).map(h => h.label);
  if (used.length) throw new Error('Clé utilisée par : ' + used.join(', '));
  d.keys = d.keys.filter(k => k.id !== id);
  vault.save();
  return publicState();
});
handle('key:exportPrivate', async (id) => {
  const d = requireUnlocked();
  const k = d.keys.find(x => x.id === id);
  if (!k) throw new Error('Clé introuvable');
  const r = await dialog.showSaveDialog(win, { defaultPath: k.label.replace(/[^\w.-]+/g, '_') });
  if (r.canceled || !r.filePath) return false;
  fs.writeFileSync(r.filePath, k.privateKey, { mode: 0o600 });
  return r.filePath;
});

// ----- Snippets -----
handle('snippet:save', (s) => {
  const d = requireUnlocked();
  if (!s.command) throw new Error('Commande vide');
  const existing = s.id && d.snippets.find(x => x.id === s.id);
  const item = { id: existing ? existing.id : uid(), name: (s.name || s.command.slice(0, 40)).trim(), command: s.command, autoRun: !!s.autoRun };
  if (existing) Object.assign(existing, item); else d.snippets.push(item);
  vault.save();
  return publicState();
});
handle('snippet:delete', (id) => { const d = requireUnlocked(); d.snippets = d.snippets.filter(s => s.id !== id); vault.save(); return publicState(); });

// ----- Tunnels -----
handle('forward:save', (f) => {
  const d = requireUnlocked();
  if (!['L', 'R', 'D'].includes(f.type)) throw new Error('Type invalide');
  if (!d.hosts.some(h => h.id === f.hostId)) throw new Error('Choisis un host');
  const bindPort = Number(f.bindPort);
  if (!(bindPort > 0 && bindPort < 65536)) throw new Error('Port local invalide');
  if (f.type !== 'D' && (!f.destHost || !(Number(f.destPort) > 0))) throw new Error('Destination invalide');
  const existing = f.id && d.forwards.find(x => x.id === f.id);
  const item = {
    id: existing ? existing.id : uid(), label: f.label || '', type: f.type, hostId: f.hostId,
    bindHost: f.bindHost || '127.0.0.1', bindPort,
    destHost: f.type === 'D' ? '' : f.destHost, destPort: f.type === 'D' ? 0 : Number(f.destPort)
  };
  if (existing) Object.assign(existing, item); else d.forwards.push(item);
  vault.save();
  return publicState();
});
handle('forward:delete', (id) => { manager.stopTunnel(id); const d = requireUnlocked(); d.forwards = d.forwards.filter(f => f.id !== id); vault.save(); return publicState(); });
handle('tunnel:start', (id) => manager.startTunnel(id));
handle('tunnel:stop', (id) => { manager.stopTunnel(id); return true; });

// ----- Known hosts -----
handle('knownhost:delete', (k) => { const d = requireUnlocked(); delete d.knownHosts[k]; vault.save(); return publicState(); });
ipcMain.on('hostkey:answer', (_e, { reqId, ok }) => {
  const r = pendingHostKeys.get(reqId);
  if (r) { pendingHostKeys.delete(reqId); r(!!ok); }
});

// ----- Terminal -----
handle('ssh:open', (sessionId, hostId, cols, rows) => manager.openShell(sessionId, hostId, cols, rows));
ipcMain.on('ssh:write', (_e, { sessionId, data }) => localMgr.has(sessionId) ? localMgr.write(sessionId, data) : manager.write(sessionId, data));
ipcMain.on('ssh:resize', (_e, { sessionId, cols, rows }) => localMgr.has(sessionId) ? localMgr.resize(sessionId, cols, rows) : manager.resize(sessionId, cols, rows));
handle('ssh:close', (sessionId) => { if (localMgr.has(sessionId)) localMgr.kill(sessionId); else manager.close(sessionId); return true; });

// ----- Terminaux locaux (façon tmux) -----
handle('local:shells', (refresh) => localMgr.shells(!!refresh));
handle('local:spawn', (id, shellId, cols, rows, cwd) => { requireUnlocked(); return localMgr.spawn(id, shellId, cols, rows, cwd); });
handle('local:detach', (id) => localMgr.detach(id));
handle('local:attach', (id) => localMgr.attach(id));
handle('local:kill', (id) => { localMgr.kill(id); return true; });
handle('local:list', () => localMgr.list());
handle('local:title', (id, title) => { localMgr.setTitle(id, title); return true; });

// ----- Espaces de travail (dispositions de panneaux sauvegardées) -----
handle('workspace:save', (ws) => {
  const d = requireUnlocked();
  d.workspaces = d.workspaces || [];
  if (!ws.name || !ws.layout) throw new Error('Nom et disposition requis');
  const existing = d.workspaces.find(w => w.id === ws.id || w.name.toLowerCase() === ws.name.toLowerCase());
  const item = { id: existing ? existing.id : uid(), name: ws.name.trim().slice(0, 80), layout: ws.layout, broadcast: !!ws.broadcast, savedAt: new Date().toISOString() };
  if (existing) Object.assign(existing, item); else d.workspaces.push(item);
  vault.save();
  return publicState();
});
handle('workspace:delete', (id) => { const d = requireUnlocked(); d.workspaces = (d.workspaces || []).filter(w => w.id !== id); vault.save(); return publicState(); });

// ----- SFTP -----
handle('sftp:open', (sessionId, hostId) => manager.openSftp(sessionId, hostId));
handle('sftp:list', (sessionId, dir) => manager.sftpList(sessionId, dir));
handle('sftp:mkdir', (sessionId, p) => manager.sftpOp(sessionId, 'mkdir', p));
handle('sftp:rename', (sessionId, from, to) => manager.sftpOp(sessionId, 'rename', from, to));
handle('sftp:delete', (sessionId, p, isDir) => manager.sftpDelete(sessionId, p, isDir));
handle('sftp:download', async (sessionId, remotePath, transferId) => {
  const r = await dialog.showSaveDialog(win, { defaultPath: path.join(app.getPath('downloads'), path.posix.basename(remotePath)) });
  if (r.canceled || !r.filePath) return false;
  await manager.sftpTransfer(sessionId, 'download', remotePath, r.filePath, transferId);
  return r.filePath;
});
handle('sftp:pickUpload', async () => {
  const r = await dialog.showOpenDialog(win, { properties: ['openFile', 'multiSelections'] });
  return r.canceled ? [] : r.filePaths;
});
handle('sftp:upload', (sessionId, localPath, remoteDir, transferId) =>
  manager.sftpTransfer(sessionId, 'upload', path.posix.join(remoteDir, path.basename(localPath)), localPath, transferId));
handle('sftp:close', (sessionId) => { manager.close(sessionId); return true; });

handle('clipboard:write', (t) => { clipboard.writeText(String(t)); return true; });
// Copie d'un secret : effacé du presse-papiers après 30 s s'il n'a pas changé.
let secretTimer = null;
function copySecret(text) {
  clipboard.writeText(String(text));
  clearTimeout(secretTimer);
  secretTimer = setTimeout(() => { if (clipboard.readText() === String(text)) clipboard.clear(); }, 30000);
  return true;
}
handle('clipboard:writeSecret', (t) => copySecret(t));
handle('host:revealPassword', (id, which) => {
  const h = requireUnlocked().hosts.find(x => x.id === id);
  if (!h) throw new Error('Host introuvable');
  return which === 'sudo' ? (h.sudoPassword || '') : (h.password || '');
});
handle('host:copyPassword', (id, which) => {
  const h = requireUnlocked().hosts.find(x => x.id === id);
  const v = h && (which === 'sudo' ? h.sudoPassword : h.password);
  if (!v) throw new Error('Aucun mot de passe enregistré');
  return copySecret(v);
});
handle('key:revealPassphrase', (id) => {
  const k = requireUnlocked().keys.find(x => x.id === id);
  return k ? k.passphrase || '' : '';
});

// ----- Éditeur distant + historique -----
const MAX_VERSIONS = 40;
function addVersion(hostId, remotePath, content, kind, sudo) {
  const d = requireUnlocked();
  const key = historyKey(hostId, remotePath);
  const versions = vault.readHistory(key);
  const last = versions[versions.length - 1];
  if (last && last.content === content) return key;
  versions.push({ id: crypto.randomUUID(), at: new Date().toISOString(), kind, sudo: !!sudo, size: Buffer.byteLength(content), content });
  while (versions.length > MAX_VERSIONS) versions.shift();
  vault.writeHistory(key, versions);
  const host = d.hosts.find(h => h.id === hostId);
  d.editHistory = d.editHistory || {};
  d.editHistory[key] = { hostId, hostLabel: host ? host.label : '?', path: remotePath, count: versions.length, updatedAt: new Date().toISOString() };
  vault.save();
  return key;
}
function rememberSudo(hostId, opts) {
  if (!opts || !opts.rememberSudo || !opts.sudoPassword) return;
  const h = requireUnlocked().hosts.find(x => x.id === hostId);
  if (h) { h.sudoPassword = opts.sudoPassword; vault.save(); }
}
handle('editor:read', async (sessionId, hostId, remotePath, opts = {}) => {
  const r = await manager.editorRead(sessionId, hostId, remotePath, opts);
  rememberSudo(hostId, opts);
  if (r.exists) addVersion(hostId, remotePath, r.content, 'ouverture', opts.sudo);
  return r;
});
handle('editor:write', async (sessionId, hostId, remotePath, content, opts = {}) => {
  const r = await manager.editorWrite(sessionId, hostId, remotePath, content, opts);
  rememberSudo(hostId, opts);
  addVersion(hostId, remotePath, content, 'enregistrement', opts.sudo);
  return r;
});
handle('editor:open', async (sessionId, hostId) => { const s = await manager.editorSession(sessionId, hostId); return { home: s.home }; });
handle('editor:close', (sessionId) => { manager.close(sessionId); return true; });
handle('history:list', (hostId, remotePath) => vault.readHistory(historyKey(hostId, remotePath)).map(({ content, ...v }) => v).reverse());
handle('history:get', (hostId, remotePath, id) => {
  const v = vault.readHistory(historyKey(hostId, remotePath)).find(x => x.id === id);
  if (!v) throw new Error('Version introuvable');
  return v;
});
handle('history:delete', (key) => {
  const d = requireUnlocked();
  vault.writeHistory(key, []);
  if (d.editHistory) delete d.editHistory[key];
  vault.save();
  return publicState();
});
handle('history:saveLocal', async (hostId, remotePath, id) => {
  const v = vault.readHistory(historyKey(hostId, remotePath)).find(x => x.id === id);
  if (!v) throw new Error('Version introuvable');
  const r = await dialog.showSaveDialog(win, { defaultPath: path.posix.basename(remotePath) + '.' + v.at.slice(0, 19).replace(/[:T]/g, '-') });
  if (r.canceled || !r.filePath) return false;
  fs.writeFileSync(r.filePath, v.content);
  return r.filePath;
});
handle('clipboard:read', () => clipboard.readText());

// ----- Fenêtre -----
const TITLEBAR_H = 40;
const stateFile = path.join(app.getPath('userData'), 'window-state.json');
const DEFAULT_BOUNDS = { width: 1360, height: 860 };

// Restaure taille / position / état maximisé, en s'assurant que la fenêtre reste visible
// (écran débranché, changement de résolution…).
function loadWindowState() {
  let s = {};
  try { s = JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch { /* premier lancement */ }
  const b = { ...DEFAULT_BOUNDS, ...(s.bounds || {}) };
  b.width = Math.max(960, b.width);
  b.height = Math.max(600, b.height);
  if (typeof b.x === 'number' && typeof b.y === 'number') {
    const area = screen.getDisplayMatching({ x: b.x, y: b.y, width: b.width, height: b.height }).workArea;
    const visible = b.x < area.x + area.width - 100 && b.x + b.width > area.x + 100 && b.y >= area.y - 10 && b.y < area.y + area.height - 60;
    if (!visible) { delete b.x; delete b.y; }
    b.width = Math.min(b.width, area.width);
    b.height = Math.min(b.height, area.height);
  }
  return { bounds: b, maximized: !!s.maximized, fullscreen: !!s.fullscreen };
}

function saveWindowState() {
  if (!win || win.isDestroyed()) return;
  const state = {
    bounds: win.isMaximized() || win.isMinimized() || win.isFullScreen() ? win.getNormalBounds() : win.getBounds(),
    maximized: win.isMaximized(),
    fullscreen: win.isFullScreen()
  };
  try { fs.writeFileSync(stateFile, JSON.stringify(state)); } catch { /* ignore */ }
}

function sendWindowState() {
  if (win && !win.isDestroyed()) win.webContents.send('window:state', { maximized: win.isMaximized(), fullscreen: win.isFullScreen(), focused: win.isFocused() });
}

function activeCount() {
  return { sessions: manager.sessions.size + localMgr.size, tunnels: manager.tunnels.size };
}

function createWindow() {
  const st = loadWindowState();
  win = new BrowserWindow({
    ...st.bounds,
    minWidth: 960,
    minHeight: 600,
    show: false,
    backgroundColor: '#0f1419',
    title: 'KSTermus',
    icon: path.join(__dirname, '..', '..', 'assets', process.platform === 'win32' ? 'icon.ico' : 'icon.png'),
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#141b23', symbolColor: '#c9d4df', height: TITLEBAR_H },
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false
    }
  });
  Menu.setApplicationMenu(null);
  if (st.maximized) win.maximize();
  if (st.fullscreen) win.setFullScreen(true);
  win.once('ready-to-show', () => { win.show(); win.focus(); });
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.webContents.on('before-input-event', (e, input) => {
    if (input.type !== 'keyDown') return;
    const k = input.key.toLowerCase();
    if (input.control && input.shift && k === 'i') { win.webContents.toggleDevTools(); e.preventDefault(); }
    else if (k === 'f11') { win.setFullScreen(!win.isFullScreen()); e.preventDefault(); }
  });

  let saveTimer = null;
  const queueSave = () => { clearTimeout(saveTimer); saveTimer = setTimeout(saveWindowState, 400); };
  for (const ev of ['resize', 'move']) win.on(ev, queueSave);
  for (const ev of ['maximize', 'unmaximize', 'enter-full-screen', 'leave-full-screen', 'focus', 'blur']) {
    win.on(ev, () => { sendWindowState(); queueSave(); });
  }

  // Confirmation avant fermeture si des sessions ou tunnels tournent.
  let allowClose = false;
  win.on('close', (e) => {
    saveWindowState();
    if (allowClose) return;
    const { sessions, tunnels } = activeCount();
    if (!sessions && !tunnels) return;
    const parts = [];
    if (sessions) parts.push(`${sessions} session(s)`);
    if (tunnels) parts.push(`${tunnels} tunnel(s)`);
    const r = dialog.showMessageBoxSync(win, {
      type: 'question', buttons: ['Quitter', 'Annuler'], defaultId: 1, cancelId: 1,
      title: 'Quitter KSTermus', message: `${parts.join(' et ')} actif(s).`, detail: 'Tout sera déconnecté. Quitter quand même ?'
    });
    if (r !== 0) { e.preventDefault(); return; }
    allowClose = true;
  });
  win.on('closed', () => { win = null; });
}

handle('window:control', (action) => {
  if (!win) return false;
  if (action === 'minimize') win.minimize();
  else if (action === 'toggleMaximize') win.isMaximized() ? win.unmaximize() : win.maximize();
  else if (action === 'fullscreen') win.setFullScreen(!win.isFullScreen());
  else if (action === 'close') win.close();
  return { maximized: win.isMaximized(), fullscreen: win.isFullScreen() };
});
handle('window:info', () => ({ platform: process.platform, titlebarHeight: TITLEBAR_H, maximized: win ? win.isMaximized() : false, version: app.getVersion() }));

// Une seule instance : relancer l'app remet la fenêtre existante au premier plan.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  });
  app.whenReady().then(() => {
    if (process.platform === 'win32') app.setAppUserModelId('com.cyberisk.kstermus');
    createWindow();
    screen.on('display-removed', () => {
      if (!win) return;
      const b = win.getBounds();
      const area = screen.getDisplayMatching(b).workArea;
      if (b.x + b.width < area.x + 100 || b.x > area.x + area.width - 100) win.center();
    });
  });
}
app.on('window-all-closed', () => { manager.closeAll(); localMgr.killAll(); vault.lock(); app.quit(); });

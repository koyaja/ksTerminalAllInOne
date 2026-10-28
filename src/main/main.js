'use strict';
const { app, BrowserWindow, ipcMain, dialog, shell, Menu, clipboard, screen, powerMonitor, safeStorage, net } = require('electron');
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
const { LockController } = require('./lock');
const { Hello } = require('./hello');
const { Updater } = require('./updater');
const { VpnManager, parseWgConf, describeConf, defaultBinPath } = require('./vpn');
const { AuditLog, Recorder, newLogKey } = require('./audit');
const { SftpJobs } = require('./sftp-jobs');
const { SyncEngine } = require('./sync');

const vault = new Vault(app.getPath('userData'));
let win = null;
const hello = new Hello({ dir: app.getPath('userData'), safeStorage });
// Verrouillage d'écran : sessions conservées, interface et IPC bloqués.
const lock = new LockController({
  onLock: (reason) => {
    try { audit.log('lock', { method: 'écran', reason }); } catch { /* ignore */ }
    clearSecretClipboard();
    if (win && !win.isDestroyed()) win.webContents.send('app:locked', { reason });
  }
});
setInterval(() => { if (vault.isUnlocked()) lock.tick(); }, 10000).unref();

// ----- Mises à jour (GitHub Releases, archive signée) -----
const updater = new Updater({
  currentVersion: app.getVersion(),
  feed: process.env.KST_UPDATE_FEED || undefined,
  fetch: (u, o) => net.fetch(u, o),
  dir: path.join(app.getPath('temp'), 'kstermus-update'),
  isPackaged: app.isPackaged,
  appDir: path.dirname(process.execPath),
  exeName: path.basename(process.execPath),
  emit: (c, p) => { if (win && !win.isDestroyed()) win.webContents.send(c, p); }
});
// Préférence lue hors du coffre : la vérification tourne aussi avant le déverrouillage.
const updPrefsFile = path.join(app.getPath('userData'), 'update-prefs.json');
function autoUpdateEnabled() { try { return JSON.parse(fs.readFileSync(updPrefsFile, 'utf8')).autoUpdate !== false; } catch { return true; } }
async function autoUpdateCycle() {
  if (!autoUpdateEnabled()) return;
  const st = await updater.check();
  if (st.status === 'available' && st.downloadable && autoUpdateEnabled()) await updater.download();
}
setTimeout(autoUpdateCycle, 15000).unref();
setInterval(autoUpdateCycle, 6 * 3600 * 1000).unref();
let quittingForUpdate = false;
function applyLockSettings() {
  const st = vault.isUnlocked() ? vault.data.settings || {} : {};
  lock.configure({ minutes: st.autoLockMinutes === undefined ? 15 : st.autoLockMinutes });
}
const pendingHostKeys = new Map();
const pendingPrompts = new Map();

const manager = new SshManager({
  vault,
  emit: (channel, payload) => {
    if (channel === 'term:data') recorder.output(payload.sessionId, payload.data);
    else if (channel === 'term:exit') sessionEnded(payload.sessionId, payload.reason);
    if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
  },
  // Questions keyboard-interactive (2FA / OTP…) posées à l'utilisateur ; null = annulé.
  askPrompts: (info) => new Promise(resolve => {
    const reqId = crypto.randomUUID();
    pendingPrompts.set(reqId, resolve);
    if (win && !win.isDestroyed()) win.webContents.send('ssh:prompt', { reqId, ...info });
    else resolve(null);
    setTimeout(() => { if (pendingPrompts.has(reqId)) { pendingPrompts.delete(reqId); resolve(null); if (win && !win.isDestroyed()) win.webContents.send('ssh:promptCancel', { reqId }); } }, 5 * 60 * 1000);
  }),
  vpnSocket: async (host, h, port) => {
    const p = vpnProfileFor(host);
    return p ? vpnMgr.connect(p, h, port) : null;
  },
  askHostKey: (info) => new Promise(resolve => {
    const reqId = crypto.randomUUID();
    pendingHostKeys.set(reqId, resolve);
    if (win && !win.isDestroyed()) win.webContents.send('hostkey:ask', { reqId, ...info });
    else resolve(false);
  })
});

// ----- VPN WireGuard intégrés -----
const vpnMgr = new VpnManager({
  binPath: defaultBinPath({ isPackaged: app.isPackaged, resourcesPath: process.resourcesPath, appRoot: path.join(__dirname, '..', '..') }),
  emit: (c, p) => { if (win && !win.isDestroyed()) win.webContents.send(c, p); }
});
// VPN effectif d'un host : le sien, sinon celui de son groupe ; 'none' = aucun.
function vpnProfileFor(host) {
  const d = vault.data;
  if (!d) return null;
  const id = host.vpnId === 'none' ? null : host.vpnId || ((d.groupVpns || {})[host.group || ''] || null);
  if (!id) return null;
  const p = (d.vpns || []).find(v => v.id === id);
  if (!p) throw new Error(`Le VPN associé à « ${host.label} » n'existe plus`);
  return p;
}

const localMgr = new LocalManager((channel, payload) => { if (win && !win.isDestroyed()) win.webContents.send(channel, payload); });

const uid = () => crypto.randomUUID();

// ----- Journal d'audit + enregistrement des sessions (chiffrés, clé de données dans le coffre) -----
function logKey() {
  if (!vault.isUnlocked()) return null;
  const d = vault.data;
  d.secrets = d.secrets || {};
  if (!d.secrets.logKey) { d.secrets.logKey = newLogKey(); vault.save(); }
  return Buffer.from(d.secrets.logKey, 'base64');
}
const appSettings = () => (vault.isUnlocked() ? vault.data.settings || {} : {});
const audit = new AuditLog({ dir: path.join(app.getPath('userData'), 'audit'), getKey: logKey, enabled: () => appSettings().auditEnabled !== false });
const recorder = new Recorder({ dir: path.join(app.getPath('userData'), 'recordings'), getKey: logKey });
const sessionInfo = new Map(); // sessionId -> { hostId, host, user, at }
// Échecs de déverrouillage : le coffre est fermé (pas de clé), on les note en clair
// (date seulement, aucune donnée) et on les verse au journal au prochain déverrouillage.
const failFile = path.join(app.getPath('userData'), 'unlock-failures.json');
function noteUnlockFailure(kind) {
  let a = []; try { a = JSON.parse(fs.readFileSync(failFile, 'utf8')); } catch { /* vide */ }
  a.push({ at: new Date().toISOString(), kind }); if (a.length > 200) a = a.slice(-200);
  try { fs.writeFileSync(failFile, JSON.stringify(a), { mode: 0o600 }); } catch { /* ignore */ }
}
function flushUnlockFailures() {
  let a = []; try { a = JSON.parse(fs.readFileSync(failFile, 'utf8')); } catch { return; }
  for (const f of a) audit.log('unlock-failed', { method: f.kind, failedAt: f.at });
  try { fs.unlinkSync(failFile); } catch { /* ignore */ }
}
const sftpHosts = new Map(); // sessionId SFTP -> hostId
function sessionInfoSftp(sessionId) { return sftpHosts.has(sessionId) ? hostMeta(sftpHosts.get(sessionId)) : {}; }
function hostMeta(hostId) {
  const h = vault.isUnlocked() && vault.data.hosts.find(x => x.id === hostId);
  return h ? { hostId, host: h.label, user: h.username, address: `${h.hostname}:${h.port || 22}` } : { hostId, host: '?' };
}
function shouldRecord(hostId) {
  const mode = appSettings().recordSessions || 'marked';
  const h = vault.isUnlocked() && vault.data.hosts.find(x => x.id === hostId);
  return mode === 'all' || (mode === 'marked' && h && h.record);
}
function sessionEnded(sessionId, reason) {
  const info = sessionInfo.get(sessionId);
  if (!info) return;
  sessionInfo.delete(sessionId);
  const rec = recorder.stop(sessionId);
  audit.log('disconnect', { ...info.meta, sessionId, reason: reason || '', durationSec: Math.round((Date.now() - info.at) / 1000), recording: rec || undefined });
}
// Événements tirés des appels IPC réussis / échoués.
function auditHook(channel, args, result, error) {
  const A = (type, data) => audit.log(type, data);
  switch (channel) {
    case 'vault:unlock': case 'vault:create':
      if (!error) { flushUnlockFailures(); A('unlock', { method: channel === 'vault:create' ? 'création' : 'mot de passe' }); } else noteUnlockFailure('mot de passe'); break;
    case 'vault:unlockScreen': if (!error) A('unlock', { method: 'écran (mot de passe)' }); else A('unlock-failed', { method: 'écran verrouillé' }); break;
    case 'hello:unlock': if (!error) { flushUnlockFailures(); A('unlock', { method: 'Windows Hello' }); } break;
    case 'lock:screen': if (!error && result) A('lock', { method: 'écran (manuel)' }); break;
    case 'ssh:open': {
      const [sessionId, hostId, cols, rows] = args;
      const meta = hostMeta(hostId);
      if (error) { A('connect-failed', { ...meta, error: String(error.message || error) }); break; }
      const recId = shouldRecord(hostId) ? recorder.start(sessionId, { hostId, hostLabel: meta.host, user: meta.user, cols, rows }) : null;
      sessionInfo.set(sessionId, { meta, at: Date.now() });
      A('connect', { ...meta, sessionId, recording: recId || undefined });
      break;
    }
    case 'ssh:close': sessionEnded(args[0], 'onglet fermé'); break;
    case 'sftp:open': if (!error) sftpHosts.set(args[0], args[1]);
      if (!error) A('sftp', { ...hostMeta(args[1]), action: 'ouverture' }); else A('connect-failed', { ...hostMeta(args[1]), kind: 'SFTP', error: String(error.message || error) }); break;
    case 'sftp:download': if (!error && result) A('sftp', { action: 'téléchargement', remote: args[1], local: result }); break;
    case 'sftp:upload': if (!error) A('sftp', { action: 'envoi', local: args[1], remote: args[2] }); break;
    case 'sftp:enqueue': if (!error && args[0]) A('sftp', { ...(sessionInfoSftp(args[0].sessionId)), action: args[0].dir === 'up' ? 'envoi' : 'téléchargement', items: (args[0].items || []).join(', ').slice(0, 2000), [args[0].dir === 'up' ? 'remote' : 'local']: args[0].dest }); break;
    case 'sftp:chmod': if (!error) A('sftp', { action: 'chmod ' + args[2], remote: args[1] }); break;
    case 'sftp:delete': if (!error) A('sftp', { action: 'suppression', remote: args[1] }); break;
    case 'sftp:rename': if (!error) A('sftp', { action: 'renommage', remote: args[1] + ' → ' + args[2] }); break;
    case 'editor:write': if (!error) A('file-save', { ...hostMeta(args[1]), path: args[2], sudo: !!(args[4] && args[4].sudo), bytes: Buffer.byteLength(String(args[3] || '')) }); break;
    case 'host:revealPassword': if (!error) A('secret', { ...hostMeta(args[0]), action: 'affichage', what: args[1] === 'sudo' ? 'mot de passe sudo' : 'mot de passe' }); break;
    case 'host:copyPassword': if (!error) A('secret', { ...hostMeta(args[0]), action: 'copie', what: args[1] === 'sudo' ? 'mot de passe sudo' : 'mot de passe' }); break;
    case 'key:revealPassphrase': if (!error) A('secret', { action: 'affichage', what: 'passphrase de clé' }); break;
    case 'vault:backup': if (!error && result) A('backup', { file: result }); break;
    case 'vault:restore': if (!error) A('restore', {}); break;
    case 'vault:changePassword': if (!error) A('settings', { action: 'mot de passe maître changé' }); break;
    case 'vpn:start': if (!error) A('vpn', { action: 'démarrage', vpn: (vault.data.vpns || []).find(v => v.id === args[0])?.name }); else A('vpn', { action: 'échec', vpn: (vault.data.vpns || []).find(v => v.id === args[0])?.name, error: String(error.message || error) }); break;
    case 'vpn:stop': if (!error) A('vpn', { action: 'arrêt', vpn: (vault.data.vpns || []).find(v => v.id === args[0])?.name }); break;
    case 'host:delete': if (!error) A('settings', { action: 'host supprimé', hostId: args[0] }); break;
    case 'hello:configure': if (!error) A('settings', { action: 'Windows Hello', value: args[0] }); break;
    default: break;
  }
}

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
    tunnels: manager.tunnelStatus(),
    vpns: (d.vpns || []).map(({ config, ...v }) => { let info = null; try { info = describeConf(config); } catch (e) { info = { error: e.message }; } return { ...v, info, status: vpnMgr.status(v.id) }; }),
    groupVpns: d.groupVpns || {},
    sync: syncEngine.status()
  };
}

// Enveloppe les handlers : renvoie { ok, value } ou { ok:false, error } au renderer.
function handle(channel, fn) {
  ipcMain.handle(channel, async (_e, ...args) => {
    if (!lock.allowed(channel)) return { ok: false, error: 'Écran verrouillé' };
    try {
      const value = await fn(...args);
      try { auditHook(channel, args, value, null); } catch { /* le journal ne doit jamais casser l'action */ }
      if (SYNC_TRIGGERS.has(channel)) scheduleSync(8000);
      return { ok: true, value };
    } catch (err) {
      try { auditHook(channel, args, null, err); } catch { /* ignore */ }
      return { ok: false, error: err && err.message ? err.message : String(err) };
    }
  });
}

// ----- Coffre -----
handle('vault:status', () => ({
  exists: vault.exists(), unlocked: vault.isUnlocked(), screenLocked: lock.locked,
  helloStartup: process.platform === 'win32' && hello.hasStartupKey(),
  helloScreen: vault.isUnlocked() && !!(vault.data.settings || {}).helloScreen,
  version: app.getVersion()
}));
function afterUnlock() { lock.unlock(); applyLockSettings(); try { purgeOld(); } catch { /* ignore */ } scheduleSync(1500); return publicState(); }
handle('vault:create', (pw) => { vault.create(pw); return afterUnlock(); });
handle('vault:unlock', (pw) => {
  lock.checkThrottle();
  try { vault.unlock(pw); } catch (e) { lock.fail(); throw e; }
  return afterUnlock();
});
// Verrouillage complet : ferme tout et efface la clé de la mémoire.
handle('vault:lock', () => {
  audit.log('lock', { method: 'coffre (tout fermé)' });
  for (const sid of [...sessionInfo.keys()]) sessionEnded(sid, 'coffre verrouillé');
  manager.closeAll(); localMgr.killAll(); vpnMgr.stopAll(); recorder.stopAll(); vault.lock(); lock.unlock(); return true;
});
// Verrouillage d'écran : les sessions continuent.
handle('lock:screen', () => { if (!vault.isUnlocked()) return false; return lock.lock('manuel'); });
handle('vault:unlockScreen', (pw) => {
  if (!lock.locked) return publicState();
  lock.checkThrottle();
  if (!vault.verifyPassword(pw)) { lock.fail(); throw new Error('Mot de passe maître incorrect'); }
  return afterUnlock();
});
handle('vault:changePassword', (oldPw, newPw) => {
  vault.changePassword(oldPw, newPw);
  if (hello.hasStartupKey()) hello.storeStartupKey(vault.key, vault.salt); // garde Hello au démarrage valide
  return true;
});
handle('hello:status', async () => ({ ...(await hello.available()), startup: hello.hasStartupKey() }));
handle('hello:unlock', async () => {
  lock.checkThrottle();
  if (vault.isUnlocked()) {
    if (!lock.locked) return publicState();
    if (!(vault.data.settings || {}).helloScreen) throw new Error('Windows Hello n\'est pas activé pour l\'écran verrouillé');
    await hello.verify('Déverrouiller KSTermus');
    return afterUnlock();
  }
  if (!hello.hasStartupKey()) throw new Error('Windows Hello n\'est pas activé au démarrage');
  await hello.verify('Ouvrir le coffre KSTermus');
  const { key } = hello.readStartupKey();
  try { vault.unlockWithKey(key); } catch (e) { hello.clearStartupKey(); throw e; } finally { key.fill(0); }
  return afterUnlock();
});
handle('hello:configure', async ({ screen: onScreen, startup }) => {
  const d = requireUnlocked();
  if (onScreen || startup) await hello.verify('Activer Windows Hello pour KSTermus');
  d.settings = { ...d.settings, helloScreen: !!(onScreen || startup) };
  vault.save();
  if (startup) hello.storeStartupKey(vault.key, vault.salt); else hello.clearStartupKey();
  return publicState();
});
handle('vault:backup', async () => {
  const r = await dialog.showSaveDialog(win, { title: 'Exporter le coffre (chiffré)', defaultPath: path.join(app.getPath('documents'), `kstermus-backup-${new Date().toISOString().slice(0, 10)}.kst`), filters: [{ name: 'Sauvegarde KSTermus', extensions: ['kst'] }] });
  if (r.canceled || !r.filePath) return false;
  vault.exportTo(r.filePath);
  return r.filePath;
});
// Restauration : choisir le fichier (aucune donnée lue côté interface), puis restaurer avec le mot de passe.
let pendingRestore = null;
handle('vault:restorePick', async () => {
  const r = await dialog.showOpenDialog(win, { title: 'Restaurer une sauvegarde KSTermus', properties: ['openFile'], filters: [{ name: 'Sauvegarde KSTermus', extensions: ['kst', 'json'] }, { name: 'Tous les fichiers', extensions: ['*'] }] });
  if (r.canceled || !r.filePaths.length) return null;
  const b = Vault.readBackup(r.filePaths[0]); // valide le format tout de suite
  pendingRestore = r.filePaths[0];
  return { file: path.basename(r.filePaths[0]), createdAt: b.createdAt, history: Object.keys(b.history).length, replaces: vault.exists() };
});
handle('vault:restore', (pw) => {
  if (!pendingRestore) throw new Error('Choisis d\'abord le fichier de sauvegarde');
  lock.checkThrottle();
  manager.closeAll(); localMgr.killAll(); vpnMgr.stopAll();
  let summary;
  try { summary = vault.restoreFrom(pendingRestore, pw); } catch (e) { if (/Mot de passe/.test(e.message)) lock.fail(); throw e; }
  pendingRestore = null;
  hello.clearStartupKey(); // l'ancienne clé Hello ne correspond plus au coffre
  return { summary, state: afterUnlock() };
});
handle('state:get', () => publicState());
handle('settings:save', (s) => {
  const d = requireUnlocked(); d.settings = { ...d.settings, ...s }; vault.save(); applyLockSettings();
  if ('autoUpdate' in s) fs.writeFileSync(updPrefsFile, JSON.stringify({ autoUpdate: s.autoUpdate !== false }));
  return publicState();
});

// ----- Synchronisation chiffrée entre PC -----
const syncEngine = new SyncEngine({
  vault, fetch: (u, o) => net.fetch(u, o), deviceName: os.hostname(), platform: process.platform,
  emit: (c, p) => { if (win && !win.isDestroyed()) win.webContents.send(c, p); }
});
const SYNC_TRIGGERS = new Set(['host:save', 'host:delete', 'host:importSshConfig', 'key:import', 'key:generate', 'key:rename', 'key:delete', 'snippet:save', 'snippet:delete',
  'forward:save', 'forward:delete', 'vpn:save', 'vpn:delete', 'vpn:setGroup', 'workspace:save', 'workspace:delete', 'knownhost:delete', 'settings:save']);
let syncTimer = null;
function scheduleSync(delay = 5000) {
  clearTimeout(syncTimer);
  syncTimer = setTimeout(runSync, delay);
}
async function runSync() {
  if (!vault.isUnlocked() || !syncEngine.cfg()) return null;
  try {
    const r = await syncEngine.syncNow();
    if (r.localChanged && win && !win.isDestroyed() && vault.isUnlocked()) win.webContents.send('state:changed', publicState());
    if (r.conflicts) audit.log('settings', { action: `synchronisation : ${r.conflicts} conflit(s) résolu(s)` });
    return r;
  } catch (e) {
    audit.log('settings', { action: 'synchronisation en échec', error: e.message });
    return null;
  }
}
setInterval(() => { if (lock.locked) return; runSync(); }, 5 * 60 * 1000).unref();
handle('sync:status', () => syncEngine.status());
handle('sync:enable', async (cfg, password) => {
  const r = await syncEngine.enable(cfg || {}, password);
  audit.log('settings', { action: 'synchronisation activée', method: cfg && cfg.method });
  return { result: r, state: publicState() };
});
handle('sync:now', async () => { const r = await syncEngine.syncNow(); return { result: r, state: publicState() }; });
handle('sync:disable', () => { syncEngine.disable(); audit.log('settings', { action: 'synchronisation désactivée' }); return publicState(); });
handle('sync:pickFolder', async () => {
  const r = await dialog.showOpenDialog(win, { title: 'Dossier de synchronisation (Google Drive, OneDrive, Dropbox, Syncthing, partage réseau…)', properties: ['openDirectory', 'createDirectory'] });
  return r.canceled ? null : r.filePaths[0];
});

// ----- Journal d'audit / enregistrements -----
handle('audit:query', (q) => audit.query(q || {}));
handle('audit:exportCsv', async (q) => {
  const { entries } = audit.query({ ...(q || {}), limit: 100000 });
  const r = await dialog.showSaveDialog(win, { title: 'Exporter le journal (non chiffré)', defaultPath: path.join(app.getPath('documents'), `kstermus-audit-${new Date().toISOString().slice(0, 10)}.csv`), filters: [{ name: 'CSV', extensions: ['csv'] }] });
  if (r.canceled || !r.filePath) return false;
  const cols = ['at', 'type', 'host', 'user', 'address', 'command', 'path', 'action', 'method', 'reason', 'error', 'durationSec', 'danger', 'remote', 'local', 'vpn'];
  const esc = (v) => { const s = v === undefined || v === null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v); return /[";\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
  fs.writeFileSync(r.filePath, '\uFEFF' + [cols.join(';'), ...entries.map(e => cols.map(c => esc(e[c])).join(';'))].join('\r\n'));
  audit.log('backup', { action: 'export du journal', file: r.filePath });
  return r.filePath;
});
// Commande validée dans un terminal (texte lu à l'écran) ; danger = confirmée malgré l'alerte.
ipcMain.on('audit:command', (_e, { sessionId, command, danger, local }) => {
  if (!vault.isUnlocked() || typeof command !== 'string' || !command.trim()) return;
  const info = sessionInfo.get(sessionId);
  audit.log(danger ? 'danger-confirmed' : 'command', { ...(info ? info.meta : { host: local ? 'Terminal local' : '?' }), sessionId, command: command.slice(0, 4000), danger: Array.isArray(danger) ? danger.join(' · ') : undefined });
});
ipcMain.on('audit:dangerCancelled', (_e, { sessionId, command, reasons }) => {
  if (!vault.isUnlocked()) return;
  const info = sessionInfo.get(sessionId);
  audit.log('danger-cancelled', { ...(info ? info.meta : {}), sessionId, command: String(command || '').slice(0, 4000), danger: (reasons || []).join(' · ') });
});
handle('rec:list', () => recorder.list());
handle('rec:load', (id) => { requireUnlocked(); const r = recorder.load(id); audit.log('secret', { action: 'relecture d\'un enregistrement', host: r.header.kst && r.header.kst.hostLabel, recording: id }); return r; });
handle('rec:delete', (id) => { requireUnlocked(); recorder.remove(id); audit.log('settings', { action: 'enregistrement supprimé', recording: id }); return true; });
handle('rec:export', async (id) => {
  requireUnlocked();
  const r = await dialog.showSaveDialog(win, { title: 'Exporter l\'enregistrement (asciicast, non chiffré)', defaultPath: path.join(app.getPath('documents'), id + '.cast'), filters: [{ name: 'asciicast', extensions: ['cast'] }] });
  if (r.canceled || !r.filePath) return false;
  fs.writeFileSync(r.filePath, recorder.toCast(id));
  audit.log('backup', { action: 'export d\'un enregistrement', file: r.filePath, recording: id });
  return r.filePath;
});
// Rétention du journal (au déverrouillage, puis chaque jour).
function purgeOld() { const d = appSettings().auditRetentionDays; if (vault.isUnlocked() && d) audit.purge(Number(d)); }
setInterval(purgeOld, 24 * 3600 * 1000).unref();

// ----- VPN -----
handle('vpn:save', (input) => {
  const d = requireUnlocked();
  d.vpns = d.vpns || [];
  const existing = input.id ? d.vpns.find(v => v.id === input.id) : null;
  const name = String(input.name || '').trim();
  if (!name) throw new Error('Nom du VPN obligatoire');
  const config = typeof input.config === 'string' && input.config.trim() ? input.config : existing && existing.config;
  if (!config) throw new Error('Colle ou importe le fichier .conf WireGuard');
  parseWgConf(config); // valide avant d'enregistrer
  const v = { id: existing ? existing.id : uid(), name, config, notes: input.notes || '', updatedAt: new Date().toISOString() };
  if (existing) { Object.assign(existing, v); vpnMgr.stop(existing.id); } else d.vpns.push(v);
  vault.save();
  return publicState();
});
handle('vpn:delete', (id) => {
  const d = requireUnlocked();
  const users = d.hosts.filter(h => h.vpnId === id).map(h => h.label);
  const groups = Object.entries(d.groupVpns || {}).filter(([, v]) => v === id).map(([g]) => 'groupe ' + (g || 'sans groupe'));
  if (users.length || groups.length) throw new Error('VPN utilisé par : ' + [...users, ...groups].join(', '));
  vpnMgr.stop(id);
  d.vpns = (d.vpns || []).filter(v => v.id !== id);
  vault.save();
  return publicState();
});
handle('vpn:importFile', async () => {
  const r = await dialog.showOpenDialog(win, { title: 'Importer une configuration WireGuard', properties: ['openFile'], filters: [{ name: 'WireGuard', extensions: ['conf'] }, { name: 'Tous les fichiers', extensions: ['*'] }] });
  if (r.canceled || !r.filePaths.length) return null;
  const text = fs.readFileSync(r.filePaths[0], 'utf8');
  parseWgConf(text);
  return { name: path.basename(r.filePaths[0]).replace(/\.conf$/i, ''), config: text };
});
handle('vpn:start', async (id) => {
  const p = (requireUnlocked().vpns || []).find(v => v.id === id);
  if (!p) throw new Error('VPN introuvable');
  await vpnMgr.start(p);
  return vpnMgr.status(id);
});
handle('vpn:stop', (id) => { vpnMgr.stop(id); return true; });
handle('vpn:setGroup', (group, vpnId) => {
  const d = requireUnlocked();
  d.groupVpns = d.groupVpns || {};
  if (vpnId) d.groupVpns[group || ''] = vpnId; else delete d.groupVpns[group || ''];
  vault.save();
  return publicState();
});

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
    jumpHostId: input.jumpHostId || null,
    vpnId: input.vpnId || '',
    updatedAt: new Date().toISOString(),
    env: ['dev', 'staging', 'prod'].includes(input.env) ? input.env : '',
    record: !!input.record,
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
  if (host.jumpHostId) {
    if (host.jumpHostId === host.id) throw new Error('Un host ne peut pas être son propre jump host');
    // Détection de boucle (A → B → A)
    const seen = new Set([host.id]);
    let cur = host.jumpHostId;
    while (cur) {
      if (seen.has(cur)) throw new Error('Boucle de jump hosts détectée');
      seen.add(cur);
      const h = d.hosts.find(x => x.id === cur);
      if (!h) throw new Error('Jump host introuvable');
      cur = h.jumpHostId;
    }
  }
  if (existing) Object.assign(existing, host); else d.hosts.push(host);
  vault.save();
  return publicState();
});
handle('host:delete', (id) => {
  const d = requireUnlocked();
  const users = d.hosts.filter(h => h.jumpHostId === id).map(h => h.label);
  if (users.length) throw new Error('Ce host sert de jump host à : ' + users.join(', '));
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
  const importedIds = new Map();
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
    const newId = uid();
    importedIds.set(e.alias, { id: newId, proxyJump: e.proxyJump });
    d.hosts.push({
      id: newId, label: e.alias, group: 'Importés', hostname: e.hostname, port: e.port,
      username: e.username || os.userInfo().username, auth: keyId ? 'key' : 'password', keyId,
      startupCommand: '', color: '', notes: '', password: ''
    });
    added++;
  }
  // ProxyJump : relie chaque host importé à son bastion (alias importé, ou host existant de même nom / adresse).
  for (const [, v] of importedIds) {
    if (!v.proxyJump) continue;
    const m = v.proxyJump.match(/^(?:([^@]+)@)?([^:]+)(?::(\d+))?$/);
    const alias = m ? m[2] : v.proxyJump;
    const target = (importedIds.get(v.proxyJump) && d.hosts.find(h => h.id === importedIds.get(v.proxyJump).id))
      || d.hosts.find(h => h.label === alias || h.hostname === alias);
    const h = d.hosts.find(x => x.id === v.id);
    if (target && h && target.id !== h.id) h.jumpHostId = target.id;
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
  d.keys.push({ id: uid(), label: label || info.type, privateKey, passphrase: passphrase || '', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), ...info });
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
  d.keys.push({ id: uid(), label: label || `${kind}-${new Date().toISOString().slice(0, 10)}`, privateKey: kp.private, passphrase: passphrase || '', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), ...info, publicKey: kp.public.trim() });
  vault.save();
  return publicState();
});
handle('key:rename', (id, label) => {
  const d = requireUnlocked();
  const k = d.keys.find(x => x.id === id);
  if (k) { k.label = label; k.updatedAt = new Date().toISOString(); vault.save(); }
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
  const item = { id: existing ? existing.id : uid(), name: (s.name || s.command.slice(0, 40)).trim(), command: s.command, autoRun: !!s.autoRun, updatedAt: new Date().toISOString() };
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
    destHost: f.type === 'D' ? '' : f.destHost, destPort: f.type === 'D' ? 0 : Number(f.destPort),
    autoReconnect: f.autoReconnect !== false, updatedAt: new Date().toISOString()
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
ipcMain.on('ssh:promptAnswer', (_e, { reqId, answers }) => {
  const r = pendingPrompts.get(reqId);
  if (r) { pendingPrompts.delete(reqId); r(Array.isArray(answers) ? answers.map(a => String(a ?? '')) : null); }
});
ipcMain.on('hostkey:answer', (_e, { reqId, ok }) => {
  const r = pendingHostKeys.get(reqId);
  if (r) { pendingHostKeys.delete(reqId); r(!!ok); }
});

// ----- Terminal -----
handle('ssh:open', (sessionId, hostId, cols, rows) => manager.openShell(sessionId, hostId, cols, rows));
ipcMain.on('app:activity', () => lock.activity());
ipcMain.on('ssh:write', (_e, { sessionId, data }) => lock.locked ? undefined : localMgr.has(sessionId) ? localMgr.write(sessionId, data) : manager.write(sessionId, data));
ipcMain.on('ssh:resize', (_e, { sessionId, cols, rows }) => { if (recorder.isRecording(sessionId)) recorder.resize(sessionId, cols, rows); }); // enregistrement
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
  const item = { id: existing ? existing.id : uid(), name: ws.name.trim().slice(0, 80), layout: ws.layout, broadcast: !!ws.broadcast, savedAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
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
handle('sftp:close', (sessionId) => { sftpJobs.cancelSession(sessionId); manager.close(sessionId); return true; });

// ----- Transferts (file d'attente, dossiers, annulation) -----
const sftpJobs = new SftpJobs({ manager, emit: (c, p) => { if (win && !win.isDestroyed()) win.webContents.send(c, p); } });
handle('sftp:enqueue', (job) => sftpJobs.add(job || {}));
handle('sftp:jobs', (sessionId) => sftpJobs.list(sessionId));
handle('sftp:cancel', (id) => sftpJobs.cancel(id));
handle('sftp:clearDone', () => { sftpJobs.clearFinished(); return true; });
// Avant d'envoyer : quels éléments existent déjà à destination ?
handle('sftp:conflicts', async (sessionId, dir, items, dest) => {
  const out = [];
  if (dir === 'up') {
    const sftp = manager.sftpOf(sessionId);
    for (const it of items) {
      const target = path.posix.join(dest, path.basename(it));
      const ex = await new Promise(r => sftp.stat(target, (e, st) => r(e ? null : st)));
      if (ex) out.push({ name: path.basename(it), isDir: (ex.mode & 0o170000) === 0o040000 });
    }
  } else {
    for (const it of items) { const target = path.join(dest, path.posix.basename(it)); if (fs.existsSync(target)) out.push({ name: path.posix.basename(it), isDir: fs.statSync(target).isDirectory() }); }
  }
  return out;
});
handle('sftp:pick', async (kind) => {
  const props = kind === 'dir' ? ['openDirectory', 'multiSelections'] : kind === 'dest' ? ['openDirectory', 'createDirectory'] : ['openFile', 'multiSelections'];
  const r = await dialog.showOpenDialog(win, { title: kind === 'dest' ? 'Télécharger dans…' : kind === 'dir' ? 'Envoyer des dossiers' : 'Envoyer des fichiers', defaultPath: kind === 'dest' ? app.getPath('downloads') : undefined, properties: props });
  return r.canceled ? [] : r.filePaths;
});
handle('sftp:chmod', (sessionId, p, mode) => manager.sftpOp(sessionId, 'chmod', p, parseInt(String(mode), 8)));
handle('sftp:touch', (sessionId, p) => new Promise((resolve, reject) => {
  const sftp = manager.sftpOf(sessionId);
  sftp.open(p, 'wx', (e, h) => { if (e) return reject(new Error(e.message === 'Failure' ? 'Ce fichier existe déjà' : e.message)); sftp.close(h, () => resolve(true)); });
}));
handle('sftp:downloadsDir', () => app.getPath('downloads'));

// ----- Fichiers du PC (panneau local) -----
handle('lfs:list', (dir) => {
  const d = dir || os.homedir();
  const out = [];
  for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
    let st = null; try { st = fs.statSync(path.join(d, ent.name)); } catch { /* lien cassé, accès refusé */ }
    out.push({ name: ent.name, isDir: st ? st.isDirectory() : ent.isDirectory(), size: st ? st.size : 0, mtime: st ? st.mtimeMs : 0, hidden: ent.name.startsWith('.') });
  }
  return { dir: path.resolve(d), parent: path.dirname(path.resolve(d)) !== path.resolve(d) ? path.dirname(path.resolve(d)) : null, sep: path.sep, entries: out.sort((a, b) => (b.isDir - a.isDir) || a.name.localeCompare(b.name)) };
});
handle('lfs:roots', () => {
  if (process.platform !== 'win32') return [{ label: 'Dossier personnel', path: os.homedir() }, { label: '/', path: '/' }];
  const drives = [];
  for (const l of 'CDEFGHIJKLMNOPQRSTUVWXYZ') { try { fs.accessSync(l + ':\\'); drives.push({ label: l + ':', path: l + ':\\' }); } catch { /* absent */ } }
  return [{ label: 'Dossier personnel', path: os.homedir() }, { label: 'Bureau', path: app.getPath('desktop') }, { label: 'Téléchargements', path: app.getPath('downloads') }, ...drives];
});
handle('lfs:open', (p) => shell.openPath(p));

handle('clipboard:write', (t) => { clipboard.writeText(String(t)); return true; });
// Copie d'un secret : effacé du presse-papiers après 30 s s'il n'a pas changé.
let secretTimer = null;
let lastSecret = null;
function clearSecretClipboard() {
  if (lastSecret !== null && clipboard.readText() === lastSecret) clipboard.clear();
  lastSecret = null; clearTimeout(secretTimer);
}
function copySecret(text) {
  clipboard.writeText(String(text));
  lastSecret = String(text);
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
handle('editor:listDir', (sessionId, hostId, dir, opts = {}) => manager.editorListDir(sessionId, hostId, dir, opts));
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
  let winTheme = { color: '#2b2927', symbolColor: '#a89984', background: '#252423' };
  try { winTheme = { ...winTheme, ...JSON.parse(fs.readFileSync(path.join(app.getPath('userData'), 'theme-window.json'), 'utf8')) }; } catch { /* défaut */ }
  win = new BrowserWindow({
    ...st.bounds,
    minWidth: 960,
    minHeight: 600,
    show: false,
    backgroundColor: winTheme.background,
    title: 'KSTermus',
    icon: path.join(__dirname, '..', '..', 'assets', process.platform === 'win32' ? 'icon.ico' : 'icon.png'),
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: winTheme.color, symbolColor: winTheme.symbolColor, height: TITLEBAR_H },
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
handle('update:state', () => updater.set({}));
handle('update:check', async () => updater.check());
handle('update:download', async () => updater.download());
handle('update:install', () => {
  updater.apply({ relaunch: true });
  quittingForUpdate = true;
  manager.closeAll(); localMgr.killAll(); vpnMgr.stopAll(); vault.lock();
  setTimeout(() => app.exit(0), 200);
  return true;
});
handle('update:openPage', () => { shell.openExternal(updater.state.page || 'https://github.com/koyaja/ksTerminalAllInOne/releases'); return true; });
// Couleurs de la barre de titre selon le thème (mémorisées pour le prochain lancement).
const themeFile = path.join(app.getPath('userData'), 'theme-window.json');
handle('window:theme', ({ color, symbolColor, background }) => {
  const ok = (c) => typeof c === 'string' && /^#[0-9a-fA-F]{6}$/.test(c);
  if (!ok(color) || !ok(symbolColor) || !ok(background)) throw new Error('Couleurs invalides');
  if (win && !win.isDestroyed()) {
    try { win.setTitleBarOverlay({ color, symbolColor, height: TITLEBAR_H }); } catch { /* plateforme sans overlay */ }
    win.setBackgroundColor(background);
  }
  try { fs.writeFileSync(themeFile, JSON.stringify({ color, symbolColor, background })); } catch { /* ignore */ }
  return true;
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
    // Verrouille aussi quand Windows se verrouille ou se met en veille.
    const sysLock = () => { if (vault.isUnlocked() && (vault.data.settings || {}).lockOnSystemLock !== false) lock.lock('session Windows verrouillée'); };
    powerMonitor.on('lock-screen', sysLock);
    powerMonitor.on('suspend', sysLock);
    screen.on('display-removed', () => {
      if (!win) return;
      const b = win.getBounds();
      const area = screen.getDisplayMatching(b).workArea;
      if (b.x + b.width < area.x + 100 || b.x > area.x + area.width - 100) win.center();
    });
  });
}
app.on('window-all-closed', () => { manager.closeAll(); localMgr.killAll(); vpnMgr.stopAll(); vault.lock(); app.quit(); });
// Mise à jour prête mais pas appliquée : installée à la fermeture (sans relancer).
app.on('will-quit', () => {
  if (quittingForUpdate || !updater.stageReady) return;
  try { updater.apply({ relaunch: false }); } catch { /* ignore */ }
});

'use strict';
// Synchronisation chiffrée du coffre entre plusieurs PC.
//
// · Un seul fichier distant (dossier cloud ou dépôt GitHub privé), chiffré en
//   AES-256-GCM avec une clé dérivée (scrypt) d'un mot de passe de synchronisation :
//   le stockage ne voit jamais rien en clair.
// · Fusion à trois voies par élément (hosts, clés, snippets, tunnels, VPN, known
//   hosts, espaces de travail, réglages) : local / distant / dernier état commun.
//   Modifié d'un seul côté → ce côté gagne (suppression comprise) ; modifié des
//   deux côtés → le plus récent (updatedAt) gagne ; suppression contre
//   modification → la modification gagne.
// · Ce qui est propre au PC (historique des éditions, journal, enregistrements,
//   shell par défaut, dossier de téléchargement) n'est pas synchronisé.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const KDF = { N: 2 ** 17, r: 8, p: 1, keyLen: 32 };
const MAXMEM = 512 * 1024 * 1024;
const FILE_NAME = 'kstermus-sync.kst';

const ARRAYS = ['hosts', 'keys', 'snippets', 'forwards', 'vpns', 'workspaces'];
const MAPS = ['knownHosts', 'groupVpns'];
const SYNCED_SETTINGS = ['theme', 'fontSize', 'tmuxPrefix', 'autoReconnect', 'dangerMode', 'auditEnabled', 'auditRetentionDays',
  'recordSessions', 'autoLockMinutes', 'lockOnSystemLock', 'ctrlFSearch', 'helloScreen'];

// ----- Utilitaires -----
function stable(v) {
  if (Array.isArray(v)) return '[' + v.map(stable).join(',') + ']';
  if (v && typeof v === 'object') return '{' + Object.keys(v).sort().map(k => JSON.stringify(k) + ':' + stable(v[k])).join(',') + '}';
  return JSON.stringify(v === undefined ? null : v);
}
const same = (a, b) => stable(a) === stable(b);
const deriveKey = (password, salt, kdf = KDF) => crypto.scryptSync(Buffer.from(String(password), 'utf8'), salt, kdf.keyLen, { N: kdf.N, r: kdf.r, p: kdf.p, maxmem: MAXMEM });

function seal(key, obj) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([c.update(JSON.stringify(obj), 'utf8'), c.final()]);
  return { iv: iv.toString('base64'), tag: c.getAuthTag().toString('base64'), data: data.toString('base64') };
}
function unseal(key, doc) {
  const d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(doc.iv, 'base64'));
  d.setAuthTag(Buffer.from(doc.tag, 'base64'));
  return JSON.parse(Buffer.concat([d.update(Buffer.from(doc.data, 'base64')), d.final()]).toString('utf8'));
}

// Coffre → éléments { collection: { id: valeur } }
// Copie profonde : l'application modifie les objets du coffre sur place (Object.assign),
// le dernier état commun ne doit donc jamais partager d'objet avec lui.
const clone = (v) => (v === undefined ? v : JSON.parse(JSON.stringify(v)));
function toItems(data) {
  data = clone(data);
  const out = {};
  for (const c of ARRAYS) { out[c] = {}; for (const x of data[c] || []) if (x && x.id) out[c][x.id] = x; }
  for (const m of MAPS) out[m] = { ...(data[m] || {}) };
  out.settings = {};
  for (const k of SYNCED_SETTINGS) if (data.settings && data.settings[k] !== undefined) out.settings[k] = data.settings[k];
  return out;
}
// Éléments → coffre (garde l'ordre local, ajoute les nouveaux à la fin)
function applyItems(data, items) {
  items = clone(items);
  for (const c of ARRAYS) {
    const want = items[c] || {};
    const kept = (data[c] || []).filter(x => x && want[x.id]).map(x => want[x.id]);
    const known = new Set(kept.map(x => x.id));
    data[c] = [...kept, ...Object.values(want).filter(x => !known.has(x.id))];
  }
  for (const m of MAPS) data[m] = { ...(items[m] || {}) };
  data.settings = data.settings || {};
  for (const k of SYNCED_SETTINGS) { if (items.settings && k in items.settings) data.settings[k] = items.settings[k]; else delete data.settings[k]; }
  return data;
}

// Fusion à trois voies d'une collection.
function mergeColl(L = {}, R = {}, B = {}, stats, coll) {
  const out = {};
  const ts = (v) => (v && typeof v === 'object' && v.updatedAt) ? Date.parse(v.updatedAt) || 0 : 0;
  for (const id of new Set([...Object.keys(L), ...Object.keys(R), ...Object.keys(B)])) {
    const l = L[id], r = R[id], b = B[id];
    const lIn = id in L, rIn = id in R, bIn = id in B;
    const lChanged = bIn ? (!lIn || !same(l, b)) : lIn;
    const rChanged = bIn ? (!rIn || !same(r, b)) : rIn;
    let pick, from;
    if (lIn && rIn && same(l, r)) { pick = l; from = 'equal'; }
    else if (lChanged && !rChanged) { pick = lIn ? l : undefined; from = 'local'; }
    else if (rChanged && !lChanged) { pick = rIn ? r : undefined; from = 'remote'; }
    else if (!lIn && !rIn) { pick = undefined; from = 'equal'; }
    else if (!lIn) { pick = r; from = 'remote'; stats.conflicts.push({ coll, id, kept: 'distant (modifié ailleurs, supprimé ici)' }); }
    else if (!rIn) { pick = l; from = 'local'; stats.conflicts.push({ coll, id, kept: 'local (modifié ici, supprimé ailleurs)' }); }
    else { const winL = ts(l) > ts(r); /* égalité (réglages sans date) : le fichier partagé gagne, tous les PC convergent */ pick = winL ? l : r; from = winL ? 'local' : 'remote'; stats.conflicts.push({ coll, id, kept: winL ? 'local (plus récent)' : 'distant (plus récent)' }); }
    if (from === 'remote') stats.fromRemote++;
    if (from === 'local' && (lChanged)) stats.fromLocal++;
    if (pick !== undefined) out[id] = pick;
  }
  return out;
}
function merge(L, R, B) {
  const stats = { fromRemote: 0, fromLocal: 0, conflicts: [] };
  const out = {};
  for (const c of [...ARRAYS, ...MAPS, 'settings']) out[c] = mergeColl(L[c], R[c], (B || {})[c], stats, c);
  return { items: out, stats };
}

// ----- Stockages -----
class FolderBackend {
  constructor({ folder }) { this.file = path.join(folder, FILE_NAME); this.folder = folder; }
  describe() { return this.file; }
  async check() { if (!fs.existsSync(this.folder) || !fs.statSync(this.folder).isDirectory()) throw new Error('Dossier introuvable : ' + this.folder); fs.accessSync(this.folder, fs.constants.W_OK); }
  async read() {
    if (!fs.existsSync(this.file)) return null;
    const text = fs.readFileSync(this.file, 'utf8');
    return { text, ver: crypto.createHash('sha256').update(text).digest('hex') };
  }
  async write(text, ver) {
    const cur = await this.read();
    if ((cur ? cur.ver : null) !== (ver || null)) { const e = new Error('Modifié entre-temps par un autre PC'); e.code = 'CONFLICT'; throw e; }
    const tmp = this.file + '.' + process.pid + '.tmp';
    fs.writeFileSync(tmp, text);
    fs.renameSync(tmp, this.file);
  }
}

class GithubBackend {
  constructor({ owner, repo, branch = 'main', path: p = FILE_NAME, token, apiBase = 'https://api.github.com', fetch }) {
    Object.assign(this, { owner, repo, branch, path: p, token, apiBase, fetch });
  }
  describe() { return `github.com/${this.owner}/${this.repo} › ${this.path}`; }
  url(extra = '') { return `${this.apiBase}/repos/${encodeURIComponent(this.owner)}/${encodeURIComponent(this.repo)}${extra}`; }
  headers() { return { Authorization: `Bearer ${this.token}`, Accept: 'application/vnd.github+json', 'User-Agent': 'KSTermus', 'X-GitHub-Api-Version': '2022-11-28' }; }
  async check() {
    if (!this.owner || !this.repo || !this.token) throw new Error('Dépôt et jeton GitHub obligatoires');
    const r = await this.fetch(this.url(), { headers: this.headers() });
    if (r.status === 401) throw new Error('Jeton GitHub refusé');
    if (r.status === 404) throw new Error('Dépôt introuvable (ou jeton sans accès à ce dépôt)');
    if (!r.ok) throw new Error('GitHub : HTTP ' + r.status);
    const info = await r.json();
    if (info.private === false) throw new Error('Ce dépôt est PUBLIC : utilise un dépôt privé pour la synchronisation');
  }
  async read() {
    const r = await this.fetch(this.url(`/contents/${this.path.split('/').map(encodeURIComponent).join('/')}?ref=${encodeURIComponent(this.branch)}`), { headers: this.headers() });
    if (r.status === 404) return null;
    if (!r.ok) throw new Error('GitHub (lecture) : HTTP ' + r.status);
    const j = await r.json();
    return { text: Buffer.from(j.content || '', 'base64').toString('utf8'), ver: j.sha };
  }
  async write(text, ver) {
    const body = { message: `KSTermus : synchronisation ${new Date().toISOString()}`, content: Buffer.from(text).toString('base64'), branch: this.branch };
    if (ver) body.sha = ver;
    const r = await this.fetch(this.url(`/contents/${this.path.split('/').map(encodeURIComponent).join('/')}`), { method: 'PUT', headers: { ...this.headers(), 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (r.status === 409 || r.status === 422) { const e = new Error('Modifié entre-temps par un autre PC'); e.code = 'CONFLICT'; throw e; }
    if (r.status === 403 || r.status === 404) throw new Error('GitHub refuse l\'écriture (le jeton doit avoir « Contents : Read and write » sur ce dépôt)');
    if (!r.ok) throw new Error('GitHub (écriture) : HTTP ' + r.status);
  }
}

// ----- Moteur -----
class SyncEngine {
  constructor({ vault, fetch, deviceName, platform, emit = () => {}, now = () => new Date() }) {
    Object.assign(this, { vault, fetch, deviceName, platform, emit, now });
    this.running = null;
  }
  cfg() { return (this.vault.data && this.vault.data.sync) || null; }

  backendFor(c) {
    if (c.method === 'folder') return new FolderBackend({ folder: c.folder });
    if (c.method === 'github') return new GithubBackend({ ...c.github, fetch: this.fetch });
    throw new Error('Méthode de synchronisation inconnue');
  }

  status() {
    const c = this.cfg();
    if (!c || !c.method) return { enabled: false };
    let where = '';
    try { where = this.backendFor(c).describe(); } catch { /* ignore */ }
    return { enabled: true, method: c.method, where, lastSync: c.lastSync || null, lastError: c.lastError || null, lastStats: c.lastStats || null,
      devices: c.devices || [], running: !!this.running, deviceId: c.deviceId,
      github: c.method === 'github' ? { owner: c.github.owner, repo: c.github.repo, branch: c.github.branch, path: c.github.path, hasToken: !!c.github.token } : undefined,
      folder: c.method === 'folder' ? c.folder : undefined };
  }

  // Active la synchronisation : crée le fichier distant ou rejoint celui qui existe.
  async enable({ method, folder, github }, password) {
    if (!password || String(password).length < 8) throw new Error('Mot de passe de synchronisation : 8 caractères minimum');
    const prev = this.cfg();
    const c = { method, folder, github: github ? { branch: 'main', path: FILE_NAME, ...github } : undefined, deviceId: (prev && prev.deviceId) || crypto.randomUUID() };
    if (method === 'github' && prev && prev.github && !c.github.token) c.github.token = prev.github.token; // jeton déjà enregistré
    const be = this.backendFor(c);
    await be.check();
    const remote = await be.read();
    let salt, kdf = KDF;
    if (remote) {
      const doc = parseDoc(remote.text);
      salt = Buffer.from(doc.salt, 'base64'); kdf = doc.kdf || KDF;
      const key = deriveKey(password, salt, kdf);
      try { unseal(key, doc); } catch { throw new Error('Mot de passe de synchronisation incorrect pour le fichier existant (c\'est celui choisi sur le premier PC)'); }
      c.key = key.toString('base64');
    } else {
      salt = crypto.randomBytes(16);
      c.key = deriveKey(password, salt).toString('base64');
    }
    c.salt = salt.toString('base64'); c.kdf = kdf;
    c.base = null; // première synchro : union des deux côtés
    this.vault.data.sync = c;
    this.vault.save();
    return this.syncNow();
  }

  disable() { if (this.vault.data) { delete this.vault.data.sync; this.vault.save(); } return true; }

  syncNow() {
    if (this.running) return this.running;
    this.running = this._sync().finally(() => { this.running = null; this.emit('sync:status', this.status()); });
    this.emit('sync:status', { ...this.status(), running: true });
    return this.running;
  }

  async _sync(attempt = 0) {
    const c = this.cfg();
    if (!c || !c.method) throw new Error('Synchronisation non configurée');
    const key = Buffer.from(c.key, 'base64');
    const be = this.backendFor(c);
    try {
      const remote = await be.read();
      let R = { hosts: {} }, devices = [], rev = 0;
      if (remote) {
        const doc = parseDoc(remote.text);
        if (doc.salt !== c.salt) throw new Error('Le fichier distant a été recréé avec un autre mot de passe : désactive puis réactive la synchronisation');
        let payload;
        try { payload = unseal(key, doc); } catch { throw new Error('Impossible de déchiffrer le fichier distant (mot de passe de synchronisation changé ?)'); }
        R = payload.items; devices = payload.devices || []; rev = payload.rev || 0;
      }
      const L = toItems(this.vault.data);
      const { items, stats } = merge(L, R, c.base);
      const localChanged = !same(items, L);
      const remoteChanged = !remote || !same(items, R);
      const now = this.now().toISOString();
      const me = { id: c.deviceId, name: this.deviceName, platform: this.platform, lastSync: now };
      const prevMe = devices.find(d => d.id === me.id);
      // Écrire seulement si le contenu change (ou pour signaler ce PC 1 fois / 12 h) : pas de commit inutile.
      const announce = !prevMe || Date.parse(now) - Date.parse(prevMe.lastSync || 0) > 12 * 3600 * 1000;
      devices = [...devices.filter(d => d.id !== me.id), announce ? me : prevMe].slice(-20);
      if (remoteChanged || announce) {
        const doc = { v: 1, app: 'KSTermus', kdf: c.kdf || KDF, salt: c.salt, ...seal(key, { items, devices, rev: rev + 1, updatedAt: now, by: me.name }) };
        await be.write(JSON.stringify(doc), remote ? remote.ver : null);
      }
      if (localChanged) applyItems(this.vault.data, items);
      c.base = clone(items); c.lastSync = now; c.lastError = null; c.devices = devices;
      c.lastStats = { fromRemote: stats.fromRemote, fromLocal: stats.fromLocal, conflicts: stats.conflicts.length, localChanged };
      this.vault.save();
      return { ...c.lastStats, conflictsList: stats.conflicts, at: now };
    } catch (e) {
      if (e.code === 'CONFLICT' && attempt < 3) return this._sync(attempt + 1); // relire, refusionner, réessayer
      c.lastError = e.message; this.vault.save();
      throw e;
    }
  }
}

function parseDoc(text) {
  let doc;
  try { doc = JSON.parse(text); } catch { throw new Error('Fichier de synchronisation illisible'); }
  if (!doc || doc.app !== 'KSTermus' || !doc.salt || !doc.data) throw new Error('Ce fichier n\'est pas une synchronisation KSTermus');
  return doc;
}

module.exports = { SyncEngine, FolderBackend, GithubBackend, merge, toItems, applyItems, FILE_NAME, SYNCED_SETTINGS };

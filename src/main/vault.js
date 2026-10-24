'use strict';
// Coffre chiffré : AES-256-GCM, clé dérivée du mot de passe maître par scrypt.
// Tout le contenu (hosts, mots de passe, clés privées, snippets, tunnels,
// known hosts) est stocké dans un seul blob chiffré sur disque.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const KDF = { N: 2 ** 17, r: 8, p: 1, keyLen: 32 };
const MAXMEM = 512 * 1024 * 1024;

function emptyData() {
  return {
    hosts: [],
    groups: [],
    keys: [],
    snippets: [],
    forwards: [],
    knownHosts: {},
    editHistory: {},
    settings: { fontSize: 14, theme: 'dark' }
  };
}

function deriveKey(password, salt, kdf = KDF) {
  return crypto.scryptSync(Buffer.from(password, 'utf8'), salt, kdf.keyLen, {
    N: kdf.N, r: kdf.r, p: kdf.p, maxmem: MAXMEM
  });
}

function encrypt(key, obj) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(JSON.stringify(obj), 'utf8'), cipher.final()]);
  return { iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: ct.toString('base64') };
}

function decrypt(key, blob) {
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(blob.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(blob.tag, 'base64'));
  const pt = Buffer.concat([decipher.update(Buffer.from(blob.data, 'base64')), decipher.final()]);
  return JSON.parse(pt.toString('utf8'));
}

class Vault {
  constructor(dir) {
    this.file = path.join(dir, 'vault.kst');
    this.key = null;
    this.salt = null;
    this.data = null;
  }

  exists() { return fs.existsSync(this.file); }
  isUnlocked() { return this.key !== null; }

  create(password) {
    if (this.exists()) throw new Error('Un coffre existe déjà');
    if (!password || password.length < 8) throw new Error('Mot de passe maître : 8 caractères minimum');
    this.salt = crypto.randomBytes(16);
    this.key = deriveKey(password, this.salt);
    this.data = emptyData();
    this.save();
  }

  unlock(password) {
    const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    const salt = Buffer.from(raw.salt, 'base64');
    const key = deriveKey(password, salt, raw.kdf);
    let data;
    try { data = decrypt(key, raw); } catch { throw new Error('Mot de passe maître incorrect'); }
    this.salt = salt;
    this.key = key;
    this.data = Object.assign(emptyData(), data);
  }

  // Déverrouillage avec une clé déjà dérivée (Windows Hello au démarrage).
  unlockWithKey(key) {
    const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    let data;
    try { data = decrypt(Buffer.from(key), raw); } catch { throw new Error('Clé Windows Hello périmée — déverrouille avec le mot de passe maître'); }
    this.salt = Buffer.from(raw.salt, 'base64');
    this.key = Buffer.from(key);
    this.data = Object.assign(emptyData(), data);
  }

  // Vérifie le mot de passe maître sans toucher à l'état (écran verrouillé).
  verifyPassword(password) {
    if (!this.key) throw new Error('Coffre verrouillé');
    const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    const k = deriveKey(String(password || ''), this.salt, raw.kdf);
    return k.length === this.key.length && crypto.timingSafeEqual(k, this.key);
  }

  changePassword(oldPw, newPw) {
    const probe = new Vault(path.dirname(this.file));
    probe.unlock(oldPw); // lève une erreur si l'ancien mot de passe est faux
    if (!newPw || newPw.length < 8) throw new Error('Mot de passe maître : 8 caractères minimum');
    const oldKey = this.key;
    const salt = crypto.randomBytes(16);
    const newKey = deriveKey(newPw, salt);
    // Re-chiffre l'historique des éditions avec la nouvelle clé.
    for (const f of this.historyFiles()) {
      try {
        const obj = decrypt(oldKey, JSON.parse(fs.readFileSync(f, 'utf8')));
        fs.writeFileSync(f, JSON.stringify(encrypt(newKey, obj)), { mode: 0o600 });
      } catch { /* fichier illisible : ignoré */ }
    }
    this.salt = salt;
    this.key = newKey;
    this.save();
  }

  // ----- Historique des éditions (un fichier chiffré par fichier distant) -----
  get historyDir() { return path.join(path.dirname(this.file), 'history'); }
  historyFiles() {
    try { return fs.readdirSync(this.historyDir).filter(f => f.endsWith('.kst')).map(f => path.join(this.historyDir, f)); }
    catch { return []; }
  }
  historyFile(fileKey) {
    if (!/^[a-f0-9]{64}$/.test(fileKey)) throw new Error('Clé d\'historique invalide');
    return path.join(this.historyDir, fileKey + '.kst');
  }
  readHistory(fileKey) {
    if (!this.key) throw new Error('Coffre verrouillé');
    const f = this.historyFile(fileKey);
    if (!fs.existsSync(f)) return [];
    return decrypt(this.key, JSON.parse(fs.readFileSync(f, 'utf8')));
  }
  writeHistory(fileKey, versions) {
    if (!this.key) throw new Error('Coffre verrouillé');
    fs.mkdirSync(this.historyDir, { recursive: true });
    const f = this.historyFile(fileKey);
    if (!versions.length) { try { fs.unlinkSync(f); } catch { /* ignore */ } return; }
    const tmp = f + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(encrypt(this.key, versions)), { mode: 0o600 });
    fs.renameSync(tmp, f);
  }

  lock() {
    if (this.key) this.key.fill(0);
    this.key = null;
    this.data = null;
  }

  save() {
    if (!this.key) throw new Error('Coffre verrouillé');
    const blob = encrypt(this.key, this.data);
    const out = { v: 1, kdf: KDF, salt: this.salt.toString('base64'), ...blob };
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(out), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }

  // ----- Sauvegarde / restauration -----
  // Format « kstermus-backup » : le coffre ET l'historique des éditions, tous
  // deux restés chiffrés (rien n'est déchiffré pour l'export). Portable entre
  // Windows, Linux et macOS.
  exportTo(file) {
    const history = {};
    for (const f of this.historyFiles()) history[path.basename(f, '.kst')] = JSON.parse(fs.readFileSync(f, 'utf8'));
    const bundle = { type: 'kstermus-backup', v: 1, createdAt: new Date().toISOString(), vault: JSON.parse(fs.readFileSync(this.file, 'utf8')), history };
    fs.writeFileSync(file, JSON.stringify(bundle), { mode: 0o600 });
  }

  // Lit une sauvegarde : nouveau format (bundle) ou ancien vault.kst brut.
  static readBackup(file) {
    let raw;
    try { raw = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); }
    catch { throw new Error('Fichier illisible : ce n\'est pas une sauvegarde KSTermus'); }
    if (raw && raw.type === 'kstermus-backup' && raw.vault) return { vault: raw.vault, history: raw.history || {}, createdAt: raw.createdAt || null };
    if (raw && raw.salt && raw.iv && raw.tag && raw.data) return { vault: raw, history: {}, createdAt: null };
    throw new Error('Ce fichier n\'est pas une sauvegarde KSTermus (.kst)');
  }

  // Vérifie le mot de passe sur la sauvegarde, puis remplace le coffre local
  // (l'ancien est conservé en vault.kst.avant-restauration-<date>) et l'ouvre.
  restoreFrom(file, password) {
    const b = Vault.readBackup(file);
    const salt = Buffer.from(b.vault.salt, 'base64');
    const key = deriveKey(String(password || ''), salt, b.vault.kdf);
    let data;
    try { data = decrypt(key, b.vault); } catch { throw new Error('Mot de passe incorrect pour cette sauvegarde (c\'est le mot de passe maître du PC d\'origine)'); }
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    if (fs.existsSync(this.file)) fs.copyFileSync(this.file, `${this.file}.avant-restauration-${stamp}`);
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(b.vault), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
    let restored = 0;
    for (const [k, blob] of Object.entries(b.history)) {
      if (!/^[a-f0-9]{64}$/.test(k)) continue;
      fs.mkdirSync(this.historyDir, { recursive: true });
      fs.writeFileSync(this.historyFile(k), JSON.stringify(blob), { mode: 0o600 });
      restored++;
    }
    this.lock();
    this.salt = salt;
    this.key = key;
    this.data = Object.assign(emptyData(), data);
    return { hosts: this.data.hosts.length, keys: this.data.keys.length, snippets: this.data.snippets.length, forwards: this.data.forwards.length, history: restored, createdAt: b.createdAt };
  }
}

module.exports = { Vault, emptyData };

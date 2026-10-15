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

  // Export / import d'une sauvegarde chiffrée (même format que le coffre).
  exportTo(file) { fs.copyFileSync(this.file, file); }
}

module.exports = { Vault, emptyData };

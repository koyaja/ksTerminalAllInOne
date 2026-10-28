'use strict';
// Journal d'audit et enregistrements de sessions, chiffrés au repos.
//
// Clé de données aléatoire (32 octets) conservée DANS le coffre (data.secrets.logKey) :
// changer le mot de passe maître ne demande pas de re-chiffrer les journaux, et
// sans le coffre déverrouillé personne ne peut les lire.
// Format : une ligne par bloc = JSON { iv, tag, d } (AES-256-GCM) → ajout en fin de
// fichier sans réécrire, et une ligne abîmée n'empêche pas de lire les autres.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function sealLine(key, obj) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const d = Buffer.concat([c.update(JSON.stringify(obj), 'utf8'), c.final()]);
  return JSON.stringify({ iv: iv.toString('base64'), tag: c.getAuthTag().toString('base64'), d: d.toString('base64') }) + '\n';
}
function openLine(key, line) {
  const o = JSON.parse(line);
  const c = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(o.iv, 'base64'));
  c.setAuthTag(Buffer.from(o.tag, 'base64'));
  return JSON.parse(Buffer.concat([c.update(Buffer.from(o.d, 'base64')), c.final()]).toString('utf8'));
}
function readSealed(key, file) {
  const out = [];
  let bad = 0;
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return { items: out, bad }; }
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try { out.push(openLine(key, line)); } catch { bad++; }
  }
  return { items: out, bad };
}

class AuditLog {
  constructor({ dir, getKey, enabled = () => true }) {
    this.dir = dir;
    this.getKey = getKey;       // () => Buffer | null (null si coffre verrouillé)
    this.enabled = enabled;
  }
  fileFor(d) { return path.join(this.dir, `audit-${d.toISOString().slice(0, 7)}.kslog`); }

  // type : unlock, unlock-failed, lock, connect, connect-failed, disconnect, command,
  //        danger-confirmed, danger-cancelled, file-save, sftp, vpn, tunnel, secret, backup, restore, settings
  log(type, data = {}) {
    if (!this.enabled()) return false;
    const key = this.getKey();
    if (!key) return false;
    const at = new Date();
    const entry = { at: at.toISOString(), type, ...data };
    try {
      fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
      fs.appendFileSync(this.fileFor(at), sealLine(key, entry), { mode: 0o600 });
      return true;
    } catch { return false; }
  }

  files() {
    try { return fs.readdirSync(this.dir).filter(f => /^audit-\d{4}-\d{2}\.kslog$/.test(f)).sort(); } catch { return []; }
  }

  // Lecture filtrée, plus récent d'abord.
  query({ since = null, until = null, types = null, host = null, text = '', limit = 2000 } = {}) {
    const key = this.getKey();
    if (!key) throw new Error('Coffre verrouillé');
    const sinceT = since ? Date.parse(since) : 0, untilT = until ? Date.parse(until) : Infinity;
    const needle = String(text || '').toLowerCase();
    const out = [];
    let bad = 0;
    for (const f of this.files().reverse()) {
      const month = f.slice(6, 13);
      if (since && month < new Date(sinceT).toISOString().slice(0, 7)) break;
      const r = readSealed(key, path.join(this.dir, f));
      bad += r.bad;
      for (let i = r.items.length - 1; i >= 0; i--) {
        const e = r.items[i];
        const t = Date.parse(e.at);
        if (t < sinceT || t > untilT) continue;
        if (types && types.length && !types.includes(e.type)) continue;
        if (host && e.host !== host) continue;
        if (needle && !JSON.stringify(e).toLowerCase().includes(needle)) continue;
        out.push(e);
        if (out.length >= limit) return { entries: out, bad, truncated: true };
      }
    }
    return { entries: out, bad, truncated: false };
  }

  // Supprime les mois entièrement plus anciens que la rétention.
  purge(days) {
    if (!days) return 0;
    const limit = new Date(Date.now() - days * 86400000).toISOString().slice(0, 7);
    let n = 0;
    for (const f of this.files()) if (f.slice(6, 13) < limit) { try { fs.unlinkSync(path.join(this.dir, f)); n++; } catch { /* ignore */ } }
    return n;
  }
}

// ----- Enregistrement de sessions (asciicast v2, chiffré par blocs) -----
class Recorder {
  constructor({ dir, getKey, maxBytes = 50 * 1024 * 1024, flushMs = 500 }) {
    this.dir = dir;
    this.getKey = getKey;
    this.maxBytes = maxBytes;
    this.flushMs = flushMs;
    this.active = new Map(); // sessionId -> état
  }

  start(sessionId, { hostId, hostLabel, user, cols, rows }) {
    const key = this.getKey();
    if (!key || this.active.has(sessionId)) return null;
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const started = Date.now();
    const id = new Date(started).toISOString().replace(/[:.]/g, '-').slice(0, 19) + '_' + crypto.randomBytes(4).toString('hex');
    const file = path.join(this.dir, id + '.ksrec');
    const header = { version: 2, width: cols || 80, height: rows || 24, timestamp: Math.floor(started / 1000), title: `${hostLabel} (${user})`, kst: { hostId, hostLabel, user, sessionId } };
    fs.writeFileSync(file, sealLine(key, { header }), { mode: 0o600 });
    const st = { id, file, key, started, events: [], bytes: 0, timer: null, stopped: false, hostLabel };
    this.active.set(sessionId, st);
    return id;
  }

  isRecording(sessionId) { return this.active.has(sessionId); }

  push(sessionId, kind, data) {
    const st = this.active.get(sessionId);
    if (!st || st.stopped) return;
    st.bytes += Buffer.byteLength(String(data));
    if (st.bytes > this.maxBytes) { st.events.push([(Date.now() - st.started) / 1000, 'o', '\r\n[KSTermus : limite d\'enregistrement atteinte]\r\n']); this.stop(sessionId); return; }
    st.events.push([(Date.now() - st.started) / 1000, kind, data]);
    if (!st.timer) st.timer = setTimeout(() => this.flush(sessionId), this.flushMs);
  }
  output(sessionId, data) { this.push(sessionId, 'o', data); }
  resize(sessionId, cols, rows) { this.push(sessionId, 'r', `${cols}x${rows}`); }

  flush(sessionId) {
    const st = this.active.get(sessionId);
    if (!st) return;
    clearTimeout(st.timer); st.timer = null;
    if (!st.events.length) return;
    const events = st.events; st.events = [];
    try { fs.appendFileSync(st.file, sealLine(st.key, { events })); } catch { /* disque plein : on abandonne ce bloc */ }
  }

  stop(sessionId) {
    const st = this.active.get(sessionId);
    if (!st) return null;
    st.stopped = true;
    st.events.push([(Date.now() - st.started) / 1000, 'm', 'end']);
    this.flush(sessionId);
    this.active.delete(sessionId);
    return st.id;
  }
  stopAll() { for (const id of [...this.active.keys()]) this.stop(id); }

  list() {
    const key = this.getKey();
    if (!key) throw new Error('Coffre verrouillé');
    let files = [];
    try { files = fs.readdirSync(this.dir).filter(f => f.endsWith('.ksrec')).sort().reverse(); } catch { return []; }
    return files.map(f => {
      const full = path.join(this.dir, f);
      const size = fs.statSync(full).size;
      try {
        const first = fs.readFileSync(full, 'utf8').split('\n', 1)[0];
        const { header } = openLine(key, first);
        const live = [...this.active.values()].some(s => s.file === full);
        return { id: f.replace(/\.ksrec$/, ''), size, live, at: new Date(header.timestamp * 1000).toISOString(), title: header.title, hostId: header.kst.hostId, hostLabel: header.kst.hostLabel, user: header.kst.user, cols: header.width, rows: header.height };
      } catch { return { id: f.replace(/\.ksrec$/, ''), size, error: 'illisible (autre coffre ?)' }; }
    });
  }

  fileOf(id) {
    if (!/^[\w-]+$/.test(id)) throw new Error('Enregistrement invalide');
    return path.join(this.dir, id + '.ksrec');
  }

  // Renvoie { header, events } (asciicast v2 en mémoire).
  load(id) {
    const key = this.getKey();
    if (!key) throw new Error('Coffre verrouillé');
    const st = [...this.active.entries()].find(([, s]) => s.id === id);
    if (st) this.flush(st[0]);
    const { items } = readSealed(key, this.fileOf(id));
    const head = items.find(x => x.header);
    if (!head) throw new Error('Enregistrement illisible');
    const events = items.filter(x => x.events).flatMap(x => x.events);
    return { header: head.header, events };
  }

  toCast(id) {
    const { header, events } = this.load(id);
    const h = { ...header }; delete h.kst;
    return [JSON.stringify(h), ...events.filter(e => e[1] !== 'm').map(e => JSON.stringify(e))].join('\n') + '\n';
  }

  remove(id) { fs.unlinkSync(this.fileOf(id)); return true; }
}

function newLogKey() { return crypto.randomBytes(32).toString('base64'); }

module.exports = { AuditLog, Recorder, newLogKey, sealLine, openLine };

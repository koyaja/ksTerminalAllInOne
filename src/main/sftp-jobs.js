'use strict';
// File de transferts SFTP : fichiers ET dossiers (récursif), progression globale,
// vitesse, annulation, politique en cas de conflit (remplacer / ignorer / renommer).
//
// Chaque tâche ouvre son propre canal SFTP sur la connexion existante : annuler =
// fermer ce canal, ce qui interrompt aussitôt fastGet / fastPut (impossible à
// stopper autrement) sans toucher à la navigation en cours.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const P = path.posix;
const isDirMode = (m) => (m & 0o170000) === 0o040000;

function cb2p(fn) { return new Promise((res, rej) => fn((e, r) => (e ? rej(e) : res(r)))); }
const PARALLEL = 16; // fichiers / dossiers traités en même temps : masque la latence réseau (Wi-Fi, VPN)
async function pool(items, n, fn, stop = () => false) {
  let i = 0, err = null;
  const worker = async () => { while (!err && !stop() && i < items.length) { const it = items[i++]; try { await fn(it); } catch (e) { err = err || e; } } };
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker));
  if (err) throw err;
}

class SftpJobs {
  constructor({ manager, emit, concurrency = 2 }) {
    this.manager = manager;
    this.emit = emit;
    this.concurrency = concurrency;
    this.jobs = new Map();   // id -> job
    this.queue = [];
    this.running = 0;
  }

  // dir: 'up' | 'down' ; items: chemins source ; dest: dossier cible ;
  // policy: overwrite | skip | rename | resume (reprise : fichiers déjà présents à la bonne taille ignorés)
  add({ sessionId, dir, items, dest, policy = 'overwrite' }) {
    if (!['up', 'down'].includes(dir)) throw new Error('Sens de transfert invalide');
    if (!Array.isArray(items) || !items.length) throw new Error('Rien à transférer');
    const created = items.map((src) => {
      const id = crypto.randomUUID();
      const job = {
        id, sessionId, dir, src, dest, policy,
        name: dir === 'up' ? path.basename(src) : P.basename(src),
        state: 'queued', bytesDone: 0, bytesTotal: 0, filesDone: 0, filesTotal: 0, skipped: 0,
        speed: 0, error: null, startedAt: null, endedAt: null, cancel: false, channel: null, current: '', doneBytes: 0, inflight: new Map()
      };
      this.jobs.set(id, job);
      this.queue.push(job);
      this.push(job, true);
      return id;
    });
    this.pump();
    return created;
  }

  cancel(id) {
    const j = this.jobs.get(id);
    if (!j || ['done', 'error', 'cancelled'].includes(j.state)) return false;
    j.cancel = true;
    if (j.state === 'queued') { this.queue = this.queue.filter(x => x !== j); j.state = 'cancelled'; j.endedAt = Date.now(); this.push(j, true); }
    else if (j.channel) { try { j.channel.end(); } catch { /* ignore */ } }
    return true;
  }
  cancelSession(sessionId) { for (const j of this.jobs.values()) if (j.sessionId === sessionId) this.cancel(j.id); }
  clearFinished() { for (const [id, j] of this.jobs) if (['done', 'error', 'cancelled'].includes(j.state)) this.jobs.delete(id); }
  list(sessionId) { return [...this.jobs.values()].filter(j => !sessionId || j.sessionId === sessionId).map(pub); }
  activeCount() { let n = 0; for (const j of this.jobs.values()) if (['queued', 'scanning', 'running'].includes(j.state)) n++; return n; }

  push(job, force) {
    const now = Date.now();
    if (!force && now - (job.lastEmit || 0) < 200) return;
    job.lastEmit = now;
    this.emit('sftp:job', pub(job));
  }

  pump() {
    while (this.running < this.concurrency && this.queue.length) {
      const job = this.queue.shift();
      this.running++;
      this.run(job).finally(() => { this.running--; this.pump(); });
    }
  }

  async run(job) {
    // « scanning » : inventaire du dossier (le nombre de fichiers et la taille montent en direct),
    // puis « running » : copie, plusieurs fichiers à la fois.
    job.state = 'scanning'; job.startedAt = Date.now(); this.push(job, true);
    const s = this.manager.sessions.get(job.sessionId);
    let onLost = null;
    try {
      if (!s || !s.conn) throw new Error('Session SFTP fermée');
      // Connexion perdue (veille, Wi-Fi coupé) : certaines opérations ne rappellent jamais ;
      // on arrête la tâche tout de suite pour qu'elle passe en échec (et puisse être reprise).
      const lost = new Promise((_, reject) => { onLost = () => { job.lost = true; job.cancel = true; reject(new Error('Connexion perdue')); }; s.conn.once('close', onLost); });
      lost.catch(() => {});
      await Promise.race([this.work(job, s), lost]);
      if (job.cancel) throw Object.assign(new Error('Annulé'), { cancelled: true });
      job.state = 'done';
    } catch (e) {
      job.state = job.cancel && !job.lost ? 'cancelled' : 'error';
      job.error = job.state === 'cancelled' ? null : (e.message || String(e));
    } finally {
      if (onLost && s && s.conn) s.conn.removeListener('close', onLost);
      job.endedAt = Date.now(); job.current = ''; job.inflight.clear();
      if (job.channel) { try { job.channel.end(); } catch { /* ignore */ } job.channel = null; }
      this.push(job, true);
    }
  }

  async work(job, s) {
    job.channel = await cb2p(cb => s.conn.sftp(cb));
    const plan = job.dir === 'up' ? await this.planUp(job) : await this.planDown(job);
    if (job.cancel) return;
    job.filesTotal = plan.files.length;
    job.bytesTotal = plan.files.reduce((a, f) => a + f.size, 0);
    job.state = 'running'; job.copyStartedAt = Date.now();
    this.push(job, true);
    await this.ensureDirs(job, plan.dirs);
    await pool(plan.files, PARALLEL, f => this.transferFile(job, f), () => job.cancel);
  }

  // ----- Plans : liste des dossiers à créer et des fichiers à copier -----
  async planUp(job) {
    const st = fs.statSync(job.src);
    const destRoot = await this.resolveName(job, P.join(job.dest, path.basename(job.src)), 'remote', st.isDirectory());
    if (destRoot === null) return { dirs: [], files: [] };
    if (!st.isDirectory()) return { dirs: [], files: [{ from: job.src, to: destRoot, size: st.size }] };
    const dirs = [destRoot], files = [];
    const walk = async (local, remote) => {
      for (const ent of await fs.promises.readdir(local, { withFileTypes: true })) {
        if (job.cancel) return;
        const l = path.join(local, ent.name), r = P.join(remote, ent.name);
        if (ent.isDirectory()) { dirs.push(r); await walk(l, r); }
        else if (ent.isFile()) { const size = (await fs.promises.stat(l)).size; files.push({ from: l, to: r, size }); this.scanned(job, size); }
      }
    };
    await walk(job.src, destRoot);
    return { dirs, files };
  }

  async planDown(job) {
    const ch = job.channel;
    const st = await cb2p(cb => ch.stat(job.src, cb));
    const destRoot = await this.resolveName(job, path.join(job.dest, P.basename(job.src)), 'local', isDirMode(st.mode));
    if (destRoot === null) return { dirs: [], files: [] };
    if (!isDirMode(st.mode)) return { dirs: [], files: [{ from: job.src, to: destRoot, size: st.size }] };
    const dirs = [destRoot], files = [];
    // Sous-dossiers lus en parallèle (une lecture distante = un aller-retour réseau).
    const walk = async (remote, local) => {
      if (job.cancel) return;
      const list = await cb2p(cb => ch.readdir(remote, cb));
      const sub = [];
      for (const e of list) {
        if (e.filename === '.' || e.filename === '..') continue;
        const r = P.join(remote, e.filename), l = path.join(local, safeLocalName(e.filename));
        if (isDirMode(e.attrs.mode)) { dirs.push(l); sub.push([r, l]); }
        else if ((e.attrs.mode & 0o170000) === 0o100000) { files.push({ from: r, to: l, size: e.attrs.size }); this.scanned(job, e.attrs.size); }
      }
      await pool(sub, PARALLEL, ([r, l]) => walk(r, l), () => job.cancel);
    };
    await walk(job.src, destRoot);
    return { dirs, files };
  }

  // Conflit sur l'élément de premier niveau : rename → « nom (1) », skip → null.
  async resolveName(job, target, side, isDir) {
    const exists = side === 'remote' ? await this.remoteExists(job, target) : fs.existsSync(target);
    if (!exists || job.policy === 'overwrite' || job.policy === 'resume') return target;
    if (job.policy === 'skip' && !isDir) { job.skipped++; return null; }
    if (job.policy === 'skip' && isDir) return target; // fusion : les fichiers existants seront ignorés un par un
    const join = side === 'remote' ? P : path;
    const dir = join.dirname(target), base = join.basename(target);
    const m = base.match(/^(.*?)(\.[^.]+)?$/);
    for (let i = 1; i < 1000; i++) {
      const cand = join.join(dir, isDir ? `${base} (${i})` : `${m[1]} (${i})${m[2] || ''}`);
      const ex = side === 'remote' ? await this.remoteExists(job, cand) : fs.existsSync(cand);
      if (!ex) return cand;
    }
    throw new Error('Impossible de trouver un nom libre pour ' + base);
  }

  async remoteExists(job, p) {
    try { await cb2p(cb => job.channel.stat(p, cb)); return true; } catch { return false; }
  }

  scanned(job, size) { job.filesTotal++; job.bytesTotal += size; this.push(job); }

  // Dossiers créés niveau par niveau (parents d'abord), plusieurs à la fois par niveau.
  async ensureDirs(job, dirs) {
    const sep = job.dir === 'up' ? '/' : path.sep;
    const byDepth = new Map();
    for (const d of dirs) { const k = d.split(sep).length; if (!byDepth.has(k)) byDepth.set(k, []); byDepth.get(k).push(d); }
    for (const k of [...byDepth.keys()].sort((a, b) => a - b)) {
      if (job.cancel) return;
      await pool(byDepth.get(k), PARALLEL, d => this.ensureDir(job, d), () => job.cancel);
    }
  }

  async ensureDir(job, d) {
    if (job.dir === 'down') { fs.mkdirSync(d, { recursive: true }); return; }
    try { await cb2p(cb => job.channel.mkdir(d, cb)); } catch (e) {
      if (!(await this.remoteExists(job, d))) throw new Error(`${d} : ${e.message}`);
    }
  }

  async transferFile(job, f) {
    job.current = job.dir === 'up' ? path.basename(f.from) : P.basename(f.from);
    if (job.policy === 'resume') {
      // Reprise après coupure : un fichier déjà complet n'est pas recopié ; un fichier partiel est refait.
      const size = job.dir === 'up' ? await cb2p(cb => job.channel.stat(f.to, cb)).then(st => st.size, () => -1) : (fs.existsSync(f.to) ? fs.statSync(f.to).size : -1);
      if (size === f.size) { job.skipped++; job.filesDone++; job.doneBytes += f.size; job.bytesDone = job.doneBytes; this.push(job); return; }
    }
    if (job.policy === 'skip') {
      const exists = job.dir === 'up' ? await this.remoteExists(job, f.to) : fs.existsSync(f.to);
      if (exists) { job.skipped++; job.filesDone++; job.doneBytes += f.size; job.bytesDone = job.doneBytes; this.push(job); return; }
    }
    const t0 = Date.now();
    // Plusieurs fichiers en cours : progression = fichiers finis + part copiée des fichiers en cours.
    const refresh = () => {
      let inflight = 0; for (const v of job.inflight.values()) inflight += v;
      job.bytesDone = job.doneBytes + inflight;
      const el = (Date.now() - (job.copyStartedAt || job.startedAt)) / 1000;
      job.speed = el > 0.3 ? Math.round(job.bytesDone / el) : 0;
      this.push(job);
    };
    job.inflight.set(f, 0);
    const step = (done) => { job.inflight.set(f, done); refresh(); };
    await new Promise((resolve, reject) => {
      const cb = (e) => (e ? reject(job.cancel ? Object.assign(new Error('Annulé'), { cancelled: true }) : new Error(`${job.current} : ${e.message}`)) : resolve());
      if (f.size === 0) {
        // fastGet/fastPut et les fichiers vides : création directe
        if (job.dir === 'up') job.channel.writeFile(f.to, Buffer.alloc(0), cb);
        else { try { fs.writeFileSync(f.to, ''); resolve(); } catch (e) { reject(e); } }
        return;
      }
      if (job.dir === 'up') job.channel.fastPut(f.from, f.to, { step }, cb);
      else job.channel.fastGet(f.from, f.to, { step }, cb);
    }).catch((e) => {
      job.inflight.delete(f);
      if (job.dir === 'down') { try { fs.unlinkSync(f.to); } catch { /* fichier partiel */ } }
      throw e;
    });
    job.inflight.delete(f);
    job.doneBytes += f.size;
    job.filesDone++;
    job.lastFileMs = Date.now() - t0;
    refresh();
  }
}

function safeLocalName(n) {
  // Noms Windows interdits / caractères réservés
  let s = n.replace(/[<>:"\\|?*\x00-\x1f]/g, '_');
  if (process.platform === 'win32') s = s.replace(/[. ]+$/, '_').replace(/^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i, '_$1$2');
  return s || '_';
}

function pub(j) {
  const { channel, cancel, lastEmit, inflight, doneBytes, ...rest } = j;
  return rest;
}

module.exports = { SftpJobs, safeLocalName };

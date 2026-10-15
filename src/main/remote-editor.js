'use strict';
// Édition de fichiers distants : lecture / écriture par SFTP, ou via sudo.
// Ajoute des méthodes à SshManager (voir installEditor).

const crypto = require('crypto');
const path = require('path');

const MAX_SIZE = 8 * 1024 * 1024;            // taille max éditable
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const q = (s) => "'" + String(s).replace(/'/g, "'\\''") + "'"; // quote shell POSIX

function codedError(code, message) { const e = new Error(message); e.code = code; return e; }

// Exécute une commande et collecte stdout / stderr. `input` est écrit sur stdin puis fermé.
function execCollect(conn, cmd, input, limit = MAX_SIZE + 1024) {
  return new Promise((resolve, reject) => {
    conn.exec(cmd, (err, ch) => {
      if (err) return reject(err);
      const out = []; const errOut = []; let size = 0; let tooBig = false;
      ch.on('data', d => { size += d.length; if (size > limit) { tooBig = true; ch.close(); } else out.push(d); });
      ch.stderr.on('data', d => errOut.push(d));
      ch.on('close', (code) => {
        if (tooBig) return reject(codedError('TOO_BIG', `Fichier trop volumineux pour l'éditeur (> ${MAX_SIZE / 1024 / 1024} Mo)`));
        resolve({ code: code === undefined || code === null ? 0 : code, stdout: Buffer.concat(out), stderr: Buffer.concat(errOut).toString('utf8') });
      });
      if (input !== undefined && input !== null) ch.end(input); else ch.end();
    });
  });
}

function sudoError(stderr) {
  const s = stderr.toLowerCase();
  if (/incorrect password|sorry, try again|no password was provided|a password is required|mot de passe incorrect/.test(s)) {
    return codedError('SUDO_PASSWORD', 'Mot de passe sudo requis ou incorrect');
  }
  if (/not in the sudoers|is not allowed to|n'est pas dans le fichier sudoers|may not run sudo/.test(s)) {
    return codedError('SUDO_DENIED', 'Cet utilisateur n\'a pas le droit d\'utiliser sudo');
  }
  if (/command not found|sudo: not found/.test(s)) return codedError('SUDO_MISSING', 'sudo n\'est pas installé sur ce serveur');
  return null;
}

function installEditor(SshManager) {
  const P = SshManager.prototype;

  P.openEditorSession = async function (sessionId, hostId) {
    const conn = await this.connect(hostId);
    const sftp = await new Promise((res, rej) => conn.sftp((e, s) => e ? rej(e) : res(s)));
    const home = await new Promise((res) => sftp.realpath('.', (e, p) => res(e ? '/' : p)));
    this.sessions.set(sessionId, { conn, sftp, kind: 'editor', hostId, sudoMode: null, home });
    conn.on('close', () => { const cur = this.sessions.get(sessionId); if (cur && cur.conn === conn) this.sessions.delete(sessionId); });
    return { home };
  };

  P.editorSession = async function (sessionId, hostId) {
    let s = this.sessions.get(sessionId);
    if (!s || s.kind !== 'editor') { await this.openEditorSession(sessionId, hostId); s = this.sessions.get(sessionId); }
    return s;
  };

  // Détermine si sudo fonctionne sans mot de passe (NOPASSWD) — résultat mis en cache par session.
  P.sudoPrefix = async function (s, password) {
    if (s.sudoMode === null) {
      const r = await execCollect(s.conn, 'sudo -k -n true');
      if (r.code === 0) s.sudoMode = 'nopasswd';
      else {
        const e = sudoError(r.stderr);
        if (e && e.code !== 'SUDO_PASSWORD') throw e;
        s.sudoMode = 'password';
      }
    }
    if (s.sudoMode === 'nopasswd') return { prefix: 'sudo -n', input: '' };
    if (!password) throw codedError('SUDO_PASSWORD', 'Mot de passe sudo requis');
    // -k : ignore les identifiants en cache, donc sudo lit TOUJOURS le mot de passe sur stdin.
    return { prefix: "sudo -k -S -p ''", input: password + '\n' };
  };

  P.sudoPasswordFor = function (hostId, provided) {
    if (provided) return provided;
    const h = this.hostById(hostId);
    return h.sudoPassword || h.password || '';
  };

  // Lecture : renvoie le contenu (texte), son empreinte, ses fins de ligne et ses droits.
  P.editorRead = async function (sessionId, hostId, remotePath, opts = {}) {
    const s = await this.editorSession(sessionId, hostId);
    let buf; let exists = true; let mode = null;
    if (opts.sudo) {
      const pw = this.sudoPasswordFor(hostId, opts.sudoPassword);
      const { prefix, input } = await this.sudoPrefix(s, pw);
      const r = await execCollect(s.conn, `${prefix} sh -c 'if [ -e "$1" ]; then stat -c %a -- "$1" >&2; cat -- "$1"; else echo __KST_NOFILE__ >&2; fi' sh ${q(remotePath)}`, input);
      const se = sudoError(r.stderr); if (se) throw se;
      if (/__KST_NOFILE__/.test(r.stderr)) { exists = false; buf = Buffer.alloc(0); }
      else if (r.code !== 0) throw new Error(r.stderr.trim() || `Lecture impossible (code ${r.code})`);
      else { buf = r.stdout; const m = r.stderr.match(/^(\d{3,4})\s*$/m); mode = m ? m[1] : null; }
    } else {
      const { st, err } = await new Promise((res) => s.sftp.stat(remotePath, (e, a) => res({ st: e ? null : a, err: e })));
      if (err && (err.code === 3 || /permission denied/i.test(err.message))) throw codedError('PERMISSION', 'Permission refusée — ouvre ce fichier en sudo');
      if (!st) { if (!opts.create) throw codedError('NOT_FOUND', `${remotePath} n'existe pas`); exists = false; buf = Buffer.alloc(0); }
      else {
        if ((st.mode & 0o170000) === 0o040000) throw new Error('C\'est un dossier');
        if (st.size > MAX_SIZE) throw codedError('TOO_BIG', `Fichier trop volumineux pour l'éditeur (${(st.size / 1048576).toFixed(1)} Mo)`);
        mode = (st.mode & 0o7777).toString(8);
        buf = await new Promise((res, rej) => s.sftp.readFile(remotePath, (e, d) => {
          if (!e) return res(d);
          if (e.code === 3 || /permission denied/i.test(e.message)) return rej(codedError('PERMISSION', 'Permission refusée — ouvre ce fichier en sudo'));
          rej(e);
        }));
      }
    }
    if (buf.includes(0)) throw codedError('BINARY', 'Fichier binaire : édition impossible');
    const text = buf.toString('utf8');
    const eol = /\r\n/.test(text) ? 'crlf' : 'lf';
    return { content: text.replace(/\r\n/g, '\n'), hash: sha256(buf), eol, exists, mode, size: buf.length };
  };

  // Écriture. expectedHash = empreinte lue à l'ouverture : si le fichier a changé entre-temps → CONFLICT.
  P.editorWrite = async function (sessionId, hostId, remotePath, content, opts = {}) {
    const s = await this.editorSession(sessionId, hostId);
    const text = opts.eol === 'crlf' ? content.replace(/\r?\n/g, '\r\n') : content;
    const buf = Buffer.from(text, 'utf8');
    if (buf.length > MAX_SIZE) throw codedError('TOO_BIG', 'Contenu trop volumineux');

    if (!opts.force && opts.expectedHash) {
      let current = null;
      try { current = await this.editorRead(sessionId, hostId, remotePath, { sudo: opts.sudo, sudoPassword: opts.sudoPassword, create: true }); }
      catch (e) { if (e.code === 'SUDO_PASSWORD' || e.code === 'SUDO_DENIED') throw e; }
      if (current && current.exists && current.hash !== opts.expectedHash) {
        throw codedError('CONFLICT', 'Le fichier a été modifié sur le serveur depuis son ouverture');
      }
    }

    if (opts.sudo) {
      const pw = this.sudoPasswordFor(hostId, opts.sudoPassword);
      const { prefix, input } = await this.sudoPrefix(s, pw);
      const tmp = `/tmp/.kstermus-${crypto.randomBytes(8).toString('hex')}`;
      await new Promise((res, rej) => s.sftp.writeFile(tmp, buf, { mode: 0o600 }, e => e ? rej(e) : res()));
      try {
        // cat > cible : conserve propriétaire et droits du fichier existant.
        const r = await execCollect(s.conn, `${prefix} sh -c 'cat -- "$1" > "$2"' sh ${q(tmp)} ${q(remotePath)}`, input);
        const se = sudoError(r.stderr); if (se) throw se;
        if (r.code !== 0) throw new Error(r.stderr.trim() || `Écriture impossible (code ${r.code})`);
      } finally {
        await new Promise(res => s.sftp.unlink(tmp, () => res()));
      }
    } else {
      await new Promise((res, rej) => s.sftp.writeFile(remotePath, buf, e => {
        if (!e) return res();
        if (e.code === 3 || /permission denied/i.test(e.message)) return rej(codedError('PERMISSION', 'Permission refusée — enregistre en sudo'));
        rej(e);
      }));
    }
    return { hash: sha256(buf), size: buf.length };
  };
}

function historyKey(hostId, remotePath) {
  return sha256(Buffer.from(`${hostId}\n${path.posix.normalize(remotePath)}`, 'utf8'));
}

module.exports = { installEditor, historyKey, MAX_SIZE, sha256 };

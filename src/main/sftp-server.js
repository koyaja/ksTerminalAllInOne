'use strict';
// Serveur SFTP minimal sur le système de fichiers local, utilisé par les appareils liés :
// le PC appairé parcourt, envoie et récupère des fichiers avec le même client SFTP que pour
// un serveur Linux. Windows : chemins exposés en style POSIX (/C:/Users/…), « / » = les lecteurs.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { utils: { sftp: { STATUS_CODE, flagsToString } } } = require('ssh2');

const S_IFDIR = 0o040000, S_IFREG = 0o100000, S_IFLNK = 0o120000;

function makePaths(platform = process.platform) {
  const win = platform === 'win32';
  const toLocal = (p) => {
    let v = path.posix.normalize('/' + String(p || '/').replace(/\\/g, '/')).replace(/\/+$/, '') || '/';
    if (!win) return v;
    if (v === '/') return null; // racine virtuelle : liste des lecteurs
    const m = /^\/([A-Za-z]):(\/.*)?$/.exec(v);
    if (!m) { const e = new Error('Chemin Windows invalide : ' + v); e.code = 'ENOENT'; throw e; }
    return m[1].toUpperCase() + ':\\' + (m[2] || '').slice(1).replace(/\//g, '\\');
  };
  const toRemote = (l) => {
    if (!win) return l;
    const m = /^([A-Za-z]):\\?(.*)$/.exec(l);
    return m ? '/' + m[1].toUpperCase() + ':/' + m[2].replace(/\\/g, '/').replace(/\/+$/, '') : l.replace(/\\/g, '/');
  };
  const resolve = (p, home) => {
    const s = String(p || '');
    if (!s || s === '.') return toRemote(home);
    if (s.startsWith('/')) return path.posix.normalize(s).replace(/(.)\/+$/, '$1');
    return path.posix.normalize(path.posix.join(toRemote(home), s));
  };
  return { win, toLocal, toRemote, resolve };
}

function attrsOf(st) {
  const type = st.isDirectory() ? S_IFDIR : st.isSymbolicLink() ? S_IFLNK : S_IFREG;
  return { mode: type | (st.mode & 0o7777), uid: st.uid || 0, gid: st.gid || 0, size: st.size, atime: Math.floor(st.atimeMs / 1000), mtime: Math.floor(st.mtimeMs / 1000) };
}
function longname(name, a) {
  const d = (a.mode & S_IFDIR) === S_IFDIR ? 'd' : '-';
  const p = ['r', 'w', 'x'];
  let perm = ''; for (let i = 8; i >= 0; i--) perm += (a.mode >> i) & 1 ? p[(8 - i) % 3] : '-';
  return `${d}${perm} 1 ${a.uid} ${a.gid} ${a.size} ${new Date(a.mtime * 1000).toISOString().slice(0, 16).replace('T', ' ')} ${name}`;
}
function code(err) {
  if (!err) return STATUS_CODE.OK;
  if (err.code === 'ENOENT' || err.code === 'ENOTDIR') return STATUS_CODE.NO_SUCH_FILE;
  if (err.code === 'EACCES' || err.code === 'EPERM') return STATUS_CODE.PERMISSION_DENIED;
  return STATUS_CODE.FAILURE;
}

function windowsDrives() {
  const out = [];
  for (let c = 67; c <= 90; c++) { const d = String.fromCharCode(c) + ':\\'; try { fs.accessSync(d); out.push(String.fromCharCode(c)); } catch { /* absent */ } }
  if (fs.existsSync('A:\\')) out.unshift('A');
  return out;
}

// Branche les requêtes d'un flux SFTP (ssh2 Server, session.on('sftp')) sur fs.
function serveSftp(sftp, { platform = process.platform, home = os.homedir(), onEvent = () => {} } = {}) {
  const P = makePaths(platform);
  const handles = new Map();
  let next = 1;
  const newHandle = (obj) => { const id = next++; const b = Buffer.alloc(4); b.writeUInt32BE(id); handles.set(id, obj); return b; };
  const getHandle = (b) => (b && b.length === 4 ? handles.get(b.readUInt32BE(0)) : undefined);
  const local = (p) => P.toLocal(P.resolve(p, home));
  const guard = (reqid, fn) => { try { fn(); } catch (e) { sftp.status(reqid, code(e), e.message); } };
  const drivesDir = () => windowsDrives().map(l => ({ filename: l + ':', longname: `drwxr-xr-x 1 0 0 0 ${l}:`, attrs: { mode: S_IFDIR | 0o755, uid: 0, gid: 0, size: 0, atime: 0, mtime: 0 } }));

  sftp.on('REALPATH', (reqid, p) => guard(reqid, () => {
    const r = P.resolve(p, home);
    sftp.name(reqid, [{ filename: r, longname: r, attrs: {} }]);
  }));
  const stat = (fnName) => (reqid, p) => guard(reqid, () => {
    const l = local(p);
    if (l === null) return sftp.attrs(reqid, { mode: S_IFDIR | 0o755, uid: 0, gid: 0, size: 0, atime: 0, mtime: 0 });
    fs[fnName](l, (e, st) => (e ? sftp.status(reqid, code(e), e.message) : sftp.attrs(reqid, attrsOf(st))));
  });
  sftp.on('STAT', stat('stat'));
  sftp.on('LSTAT', stat('lstat'));
  sftp.on('FSTAT', (reqid, h) => {
    const o = getHandle(h);
    if (!o || o.type !== 'file') return sftp.status(reqid, STATUS_CODE.FAILURE, 'Handle invalide');
    fs.fstat(o.fd, (e, st) => (e ? sftp.status(reqid, code(e)) : sftp.attrs(reqid, attrsOf(st))));
  });
  sftp.on('OPENDIR', (reqid, p) => guard(reqid, () => {
    const l = local(p);
    if (l === null) return sftp.handle(reqid, newHandle({ type: 'dir', entries: drivesDir(), done: false }));
    fs.readdir(l, { withFileTypes: true }, (e, ents) => {
      if (e) return sftp.status(reqid, code(e), e.message);
      const entries = [];
      for (const d of ents) {
        try { const st = fs.lstatSync(path.join(l, d.name)); const a = attrsOf(st); entries.push({ filename: d.name, longname: longname(d.name, a), attrs: a }); } catch { /* fichier système inaccessible */ }
      }
      sftp.handle(reqid, newHandle({ type: 'dir', entries, done: false }));
    });
  }));
  sftp.on('READDIR', (reqid, h) => {
    const o = getHandle(h);
    if (!o || o.type !== 'dir') return sftp.status(reqid, STATUS_CODE.FAILURE, 'Handle invalide');
    if (o.done || !o.entries.length) { o.done = true; return sftp.status(reqid, STATUS_CODE.EOF); }
    sftp.name(reqid, o.entries.splice(0, 256));
  });
  sftp.on('OPEN', (reqid, p, flags) => guard(reqid, () => {
    const l = local(p);
    if (l === null) return sftp.status(reqid, STATUS_CODE.PERMISSION_DENIED);
    const mode = flagsToString(flags) || 'r';
    fs.open(l, mode, (e, fd) => {
      if (e) return sftp.status(reqid, code(e), e.message);
      if (/[wa+]/.test(mode)) onEvent({ type: 'write', path: l });
      sftp.handle(reqid, newHandle({ type: 'file', fd }));
    });
  }));
  sftp.on('READ', (reqid, h, offset, len) => {
    const o = getHandle(h);
    if (!o || o.type !== 'file') return sftp.status(reqid, STATUS_CODE.FAILURE, 'Handle invalide');
    const buf = Buffer.alloc(Math.min(len, 256 * 1024));
    fs.read(o.fd, buf, 0, buf.length, offset, (e, n) => {
      if (e) return sftp.status(reqid, code(e), e.message);
      if (!n) return sftp.status(reqid, STATUS_CODE.EOF);
      sftp.data(reqid, buf.subarray(0, n));
    });
  });
  sftp.on('WRITE', (reqid, h, offset, data) => {
    const o = getHandle(h);
    if (!o || o.type !== 'file') return sftp.status(reqid, STATUS_CODE.FAILURE, 'Handle invalide');
    fs.write(o.fd, data, 0, data.length, offset, (e) => sftp.status(reqid, code(e), e ? e.message : undefined));
  });
  sftp.on('CLOSE', (reqid, h) => {
    const o = getHandle(h);
    if (!o) return sftp.status(reqid, STATUS_CODE.FAILURE, 'Handle invalide');
    handles.delete(h.readUInt32BE(0));
    if (o.type === 'file') fs.close(o.fd, (e) => sftp.status(reqid, code(e)));
    else sftp.status(reqid, STATUS_CODE.OK);
  });
  const simple = (ev, fn) => sftp.on(ev, (reqid, ...args) => guard(reqid, () => fn(...args, (e) => sftp.status(reqid, code(e), e ? e.message : undefined))));
  simple('REMOVE', (p, cb) => fs.unlink(local(p), cb));
  simple('RMDIR', (p, cb) => fs.rmdir(local(p), cb));
  simple('MKDIR', (p, _a, cb) => fs.mkdir(local(p), cb));
  simple('RENAME', (a, b, cb) => fs.rename(local(a), local(b), cb));
  simple('SETSTAT', (p, attrs, cb) => applyAttrs(local(p), attrs, cb));
  sftp.on('FSETSTAT', (reqid, h, attrs) => {
    const o = getHandle(h);
    if (!o || o.type !== 'file') return sftp.status(reqid, STATUS_CODE.FAILURE);
    const done = (e) => sftp.status(reqid, code(e));
    if (attrs.mode !== undefined && platform !== 'win32') fs.fchmod(o.fd, attrs.mode & 0o7777, done);
    else if (attrs.mtime !== undefined) fs.futimes(o.fd, attrs.atime || attrs.mtime, attrs.mtime, done);
    else done(null);
  });
  sftp.on('READLINK', (reqid, p) => guard(reqid, () => fs.readlink(local(p), (e, t) => (e ? sftp.status(reqid, code(e)) : sftp.name(reqid, [{ filename: P.toRemote(t), longname: t, attrs: {} }])))));
  simple('SYMLINK', (link, target, cb) => fs.symlink(target, local(link), cb));
  sftp.on('end', () => { for (const o of handles.values()) if (o.type === 'file') fs.close(o.fd, () => {}); handles.clear(); });
  return { paths: P };
}

function applyAttrs(l, attrs, cb) {
  try {
    if (attrs.mode !== undefined && process.platform !== 'win32') fs.chmodSync(l, attrs.mode & 0o7777);
    if (attrs.mtime !== undefined) fs.utimesSync(l, attrs.atime || attrs.mtime, attrs.mtime);
    cb(null);
  } catch (e) { cb(e); }
}

module.exports = { serveSftp, makePaths };

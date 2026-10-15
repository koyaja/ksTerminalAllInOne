'use strict';
// Gestion des connexions SSH : terminaux, SFTP et tunnels (L / R / SOCKS).
// Indépendant d'Electron : reçoit un "bridge" { vault, emit, askHostKey }.

const net = require('net');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { StringDecoder } = require('string_decoder');
const { Client } = require('ssh2');

function keyInfo(rawKey) {
  const fp = 'SHA256:' + crypto.createHash('sha256').update(rawKey).digest('base64').replace(/=+$/, '');
  let type = 'inconnu';
  try { const len = rawKey.readUInt32BE(0); type = rawKey.subarray(4, 4 + len).toString('ascii'); } catch { /* ignore */ }
  return { fingerprint: fp, type };
}

function agentPath() {
  if (process.platform === 'win32') {
    return process.env.SSH_AUTH_SOCK || '\\\\.\\pipe\\openssh-ssh-agent';
  }
  return process.env.SSH_AUTH_SOCK;
}

class SshManager {
  constructor(bridge) {
    this.bridge = bridge;           // { vault, emit(channel, payload), askHostKey(info) => Promise<bool> }
    this.sessions = new Map();      // id -> { conn, stream, kind, sftp }
    this.tunnels = new Map();       // forwardId -> { conn, server }
  }

  get data() {
    const v = this.bridge.vault;
    if (!v.isUnlocked()) throw new Error('Coffre verrouillé');
    return v.data;
  }

  hostById(id) {
    const h = this.data.hosts.find(x => x.id === id);
    if (!h) throw new Error('Host introuvable');
    return h;
  }

  buildConfig(host) {
    const cfg = {
      host: host.hostname,
      port: Number(host.port) || 22,
      username: host.username,
      readyTimeout: 20000,
      keepaliveInterval: 15000,
      keepaliveCountMax: 4,
      tryKeyboard: true
    };
    const auth = host.auth || 'password';
    if (auth === 'password') {
      cfg.password = host.password || '';
    } else if (auth === 'key') {
      const key = this.data.keys.find(k => k.id === host.keyId);
      if (!key) throw new Error('Clé du keychain introuvable pour ce host');
      cfg.privateKey = key.privateKey;
      if (key.passphrase) cfg.passphrase = key.passphrase;
      if (host.password) cfg.password = host.password; // repli éventuel
    } else if (auth === 'agent') {
      cfg.agent = agentPath();
      if (!cfg.agent) throw new Error('Aucun agent SSH détecté');
    }
    return cfg;
  }

  // Ouvre une connexion SSH authentifiée avec vérification de la clé d'hôte (TOFU).
  connect(hostId) {
    const host = this.hostById(hostId);
    const cfg = this.buildConfig(host);
    const hostKeyId = `${cfg.host}:${cfg.port}`;
    const vault = this.bridge.vault;

    return new Promise((resolve, reject) => {
      const conn = new Client();
      let settled = false;
      const fail = (err) => { if (!settled) { settled = true; reject(err); } conn.end(); };

      cfg.hostVerifier = (rawKey, verify) => {
        const info = keyInfo(rawKey);
        const known = vault.data.knownHosts[hostKeyId];
        if (known && known.fingerprint === info.fingerprint) return verify(true);
        const payload = { host: hostKeyId, label: host.label, ...info, previous: known || null };
        this.bridge.askHostKey(payload).then(ok => {
          if (ok) {
            vault.data.knownHosts[hostKeyId] = { type: info.type, fingerprint: info.fingerprint, addedAt: new Date().toISOString() };
            vault.save();
          }
          verify(!!ok);
        }).catch(() => verify(false));
      };

      conn.on('keyboard-interactive', (_name, _instr, _lang, prompts, finish) => {
        finish(prompts.map(() => host.password || ''));
      });
      conn.on('ready', () => { settled = true; resolve(conn); });
      conn.on('error', (err) => {
        if (!settled) {
          let msg = err.message;
          if (err.level === 'client-authentication') msg = 'Authentification refusée (identifiant, mot de passe ou clé)';
          else if (/verification failed/i.test(msg)) msg = 'Clé d\'hôte refusée';
          fail(new Error(msg));
        }
      });
      try { conn.connect(cfg); } catch (e) { fail(e); }
    });
  }

  // ---------- Terminal ----------
  async openShell(sessionId, hostId, cols, rows) {
    const conn = await this.connect(hostId);
    const host = this.hostById(hostId);
    return new Promise((resolve, reject) => {
      conn.shell({ term: 'xterm-256color', cols: cols || 80, rows: rows || 24 }, (err, stream) => {
        if (err) { conn.end(); return reject(err); }
        const dec = new StringDecoder('utf8');
        const decErr = new StringDecoder('utf8');
        this.sessions.set(sessionId, { conn, stream, kind: 'shell' });
        stream.on('data', d => this.bridge.emit('term:data', { sessionId, data: dec.write(d) }));
        stream.stderr.on('data', d => this.bridge.emit('term:data', { sessionId, data: decErr.write(d) }));
        const done = (reason) => {
          if (!this.sessions.has(sessionId)) return;
          this.sessions.delete(sessionId);
          this.bridge.emit('term:exit', { sessionId, reason });
          conn.end();
        };
        stream.on('close', () => done('Session fermée'));
        conn.on('close', () => done('Connexion perdue'));
        conn.on('error', e => done(e.message));
        if (host.startupCommand) stream.write(host.startupCommand.replace(/\r?\n?$/, '\n'));
        resolve(true);
      });
    });
  }

  write(sessionId, data) {
    const s = this.sessions.get(sessionId);
    if (s && s.stream) s.stream.write(data);
  }

  resize(sessionId, cols, rows) {
    const s = this.sessions.get(sessionId);
    if (s && s.stream && s.stream.setWindow) s.stream.setWindow(rows, cols, 0, 0);
  }

  close(sessionId) {
    const s = this.sessions.get(sessionId);
    if (!s) return;
    this.sessions.delete(sessionId);
    try { s.conn.end(); } catch { /* ignore */ }
  }

  // ---------- SFTP ----------
  async openSftp(sessionId, hostId) {
    const conn = await this.connect(hostId);
    const sftp = await new Promise((res, rej) => conn.sftp((e, s) => e ? rej(e) : res(s)));
    this.sessions.set(sessionId, { conn, sftp, kind: 'sftp' });
    conn.on('close', () => {
      if (this.sessions.delete(sessionId)) this.bridge.emit('sftp:closed', { sessionId });
    });
    const home = await new Promise((res) => sftp.realpath('.', (e, p) => res(e ? '/' : p)));
    return { home };
  }

  sftpOf(sessionId) {
    const s = this.sessions.get(sessionId);
    if (!s || !s.sftp) throw new Error('Session SFTP fermée');
    return s.sftp;
  }

  sftpList(sessionId, dir) {
    const sftp = this.sftpOf(sessionId);
    return new Promise((resolve, reject) => {
      sftp.readdir(dir, (err, list) => {
        if (err) return reject(new Error(`${dir} : ${err.message}`));
        resolve(list.map(e => ({
          name: e.filename,
          size: e.attrs.size,
          mtime: e.attrs.mtime * 1000,
          mode: e.attrs.mode,
          isDir: (e.attrs.mode & 0o170000) === 0o040000,
          isLink: (e.attrs.mode & 0o170000) === 0o120000,
          perms: e.longname ? e.longname.split(/\s+/)[0] : ''
        })).sort((a, b) => (b.isDir - a.isDir) || a.name.localeCompare(b.name)));
      });
    });
  }

  sftpOp(sessionId, op, ...args) {
    const sftp = this.sftpOf(sessionId);
    return new Promise((resolve, reject) => sftp[op](...args, (e, r) => e ? reject(e) : resolve(r)));
  }

  async sftpDelete(sessionId, remotePath, isDir) {
    if (!isDir) return this.sftpOp(sessionId, 'unlink', remotePath);
    const entries = await this.sftpList(sessionId, remotePath);
    for (const e of entries) {
      if (e.name === '.' || e.name === '..') continue;
      await this.sftpDelete(sessionId, path.posix.join(remotePath, e.name), e.isDir);
    }
    return this.sftpOp(sessionId, 'rmdir', remotePath);
  }

  sftpTransfer(sessionId, direction, remotePath, localPath, transferId) {
    const sftp = this.sftpOf(sessionId);
    const step = (done, _chunk, total) => this.bridge.emit('sftp:progress', { sessionId, transferId, done, total });
    return new Promise((resolve, reject) => {
      const cb = e => e ? reject(e) : resolve(true);
      if (direction === 'download') sftp.fastGet(remotePath, localPath, { step }, cb);
      else sftp.fastPut(localPath, remotePath, { step }, cb);
    });
  }

  // ---------- Tunnels ----------
  tunnelStatus() {
    const out = {};
    for (const [id, t] of this.tunnels) out[id] = { active: true, since: t.since, connections: t.count };
    return out;
  }

  async startTunnel(forwardId) {
    if (this.tunnels.has(forwardId)) return true;
    const rule = this.data.forwards.find(f => f.id === forwardId);
    if (!rule) throw new Error('Règle de tunnel introuvable');
    const conn = await this.connect(rule.hostId);
    const t = { conn, server: null, since: Date.now(), count: 0 };
    const bindHost = rule.bindHost || '127.0.0.1';
    const bindPort = Number(rule.bindPort);

    const stop = (reason) => {
      if (!this.tunnels.has(forwardId)) return;
      this.tunnels.delete(forwardId);
      if (t.server) t.server.close();
      conn.end();
      this.bridge.emit('tunnel:status', { forwardId, active: false, reason });
    };
    conn.on('close', () => stop('Connexion SSH fermée'));
    conn.on('error', e => stop(e.message));

    if (rule.type === 'L' || rule.type === 'D') {
      t.server = net.createServer(sock => {
        t.count++;
        sock.on('error', () => {});
        if (rule.type === 'L') {
          conn.forwardOut(sock.remoteAddress || '127.0.0.1', sock.remotePort || 0, rule.destHost, Number(rule.destPort), (err, ch) => {
            if (err) return sock.destroy();
            sock.pipe(ch).pipe(sock);
            ch.on('error', () => sock.destroy());
          });
        } else {
          this.handleSocks(conn, sock);
        }
      });
      await new Promise((res, rej) => {
        t.server.once('error', rej);
        t.server.listen(bindPort, bindHost, res);
      }).catch(e => { conn.end(); throw new Error(`Impossible d'écouter sur ${bindHost}:${bindPort} : ${e.message}`); });
    } else if (rule.type === 'R') {
      await new Promise((res, rej) => conn.forwardIn(rule.bindHost || '127.0.0.1', bindPort, e => e ? rej(e) : res()))
        .catch(e => { conn.end(); throw new Error(`Le serveur refuse le tunnel distant : ${e.message}`); });
      conn.on('tcp connection', (_info, accept) => {
        t.count++;
        const ch = accept();
        const sock = net.connect(Number(rule.destPort), rule.destHost);
        sock.on('error', () => ch.close());
        ch.on('error', () => sock.destroy());
        sock.pipe(ch).pipe(sock);
      });
    } else {
      conn.end();
      throw new Error('Type de tunnel inconnu');
    }

    this.tunnels.set(forwardId, t);
    this.bridge.emit('tunnel:status', { forwardId, active: true });
    return true;
  }

  stopTunnel(forwardId) {
    const t = this.tunnels.get(forwardId);
    if (!t) return;
    this.tunnels.delete(forwardId);
    if (t.server) t.server.close();
    t.conn.end();
    this.bridge.emit('tunnel:status', { forwardId, active: false, reason: 'Arrêté' });
  }

  // Proxy SOCKS5 minimal (CONNECT, sans authentification) pour les tunnels dynamiques.
  handleSocks(conn, sock) {
    sock.once('data', greet => {
      if (greet[0] !== 0x05) return sock.destroy();
      sock.write(Buffer.from([0x05, 0x00]));
      sock.once('data', req => {
        if (req[0] !== 0x05 || req[1] !== 0x01) { sock.end(Buffer.from([0x05, 0x07, 0, 1, 0, 0, 0, 0, 0, 0])); return; }
        let host, off;
        const atyp = req[3];
        if (atyp === 0x01) { host = Array.from(req.subarray(4, 8)).join('.'); off = 8; }
        else if (atyp === 0x03) { const l = req[4]; host = req.subarray(5, 5 + l).toString(); off = 5 + l; }
        else if (atyp === 0x04) { host = req.subarray(4, 20).toString('hex').match(/.{4}/g).join(':'); off = 20; }
        else { sock.end(Buffer.from([0x05, 0x08, 0, 1, 0, 0, 0, 0, 0, 0])); return; }
        const port = req.readUInt16BE(off);
        conn.forwardOut('127.0.0.1', 0, host, port, (err, ch) => {
          if (err) { sock.end(Buffer.from([0x05, 0x05, 0, 1, 0, 0, 0, 0, 0, 0])); return; }
          sock.write(Buffer.from([0x05, 0x00, 0, 1, 0, 0, 0, 0, 0, 0]));
          sock.pipe(ch).pipe(sock);
          ch.on('error', () => sock.destroy());
        });
      });
    });
  }

  closeAll() {
    for (const id of [...this.sessions.keys()]) this.close(id);
    for (const id of [...this.tunnels.keys()]) this.stopTunnel(id);
  }
}

module.exports = { SshManager, keyInfo };

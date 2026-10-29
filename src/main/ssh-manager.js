'use strict';
const { Injector } = require('./shell-integration');
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
  // - jump host : si le host a un « jumpHostId », on se connecte d'abord au bastion (récursivement,
  //   donc plusieurs rebonds possibles) puis on ouvre un canal direct-tcpip vers la cible ;
  // - 2FA : les questions keyboard-interactive du serveur (code OTP…) sont posées à l'utilisateur ;
  //   seules les questions de type « mot de passe » sont remplies automatiquement, une fois.
  // opts.background : connexion de fond (surveillance) — jamais de question à l'utilisateur
  // (empreinte inconnue ou 2FA → échec explicite au lieu d'une fenêtre).
  async connect(hostId, chain = [], opts = {}) {
    const host = this.hostById(hostId);
    if (chain.includes(hostId)) throw new Error('Boucle de jump hosts : ' + [...chain, hostId].map(id => this.hostById(id).label).join(' → '));
    if (chain.length >= 5) throw new Error('Trop de rebonds (5 max.)');
    const cfg = this.buildConfig(host);
    const hostKeyId = `${cfg.host}:${cfg.port}`;
    const vault = this.bridge.vault;

    let jumpConn = null;
    if (host.jumpHostId) {
      if (!vault.data.hosts.some(h => h.id === host.jumpHostId)) throw new Error('Le jump host de « ' + host.label + ' » n\'existe plus');
      const jump = this.hostById(host.jumpHostId);
      try { jumpConn = await this.connect(host.jumpHostId, [...chain, hostId], opts); }
      catch (e) { throw new Error(`Jump host « ${jump.label} » : ${e.message}`); }
      try {
        cfg.sock = await new Promise((res, rej) => jumpConn.forwardOut('127.0.0.1', 0, cfg.host, cfg.port, (e, st) => e ? rej(e) : res(st)));
      } catch (e) {
        jumpConn.end();
        throw new Error(`Le jump host « ${jump.label} » ne peut pas joindre ${cfg.host}:${cfg.port} (${e.message})`);
      }
    }

    // VPN WireGuard associé au host (ou à son groupe) : seul le premier saut direct
    // passe par le tunnel ; les rebonds suivants voyagent dans la connexion du bastion.
    if (!jumpConn && this.bridge.vpnSocket) {
      const sock = await this.bridge.vpnSocket(host, cfg.host, cfg.port);
      if (sock) cfg.sock = sock;
    }

    return new Promise((resolve, reject) => {
      const conn = new Client();
      let settled = false;
      let bgError = null;
      const fail = (err) => { if (!settled) { settled = true; reject(err); } conn.end(); if (jumpConn) jumpConn.end(); };
      if (jumpConn) {
        conn.on('close', () => jumpConn.end());
        jumpConn.on('close', () => conn.end());
        conn.jumpConn = jumpConn;
      }

      cfg.hostVerifier = (rawKey, verify) => {
        const info = keyInfo(rawKey);
        const known = vault.data.knownHosts[hostKeyId];
        if (known && known.fingerprint === info.fingerprint) return verify(true);
        if (opts.background) { bgError = known ? 'Empreinte du serveur MODIFIÉE' : 'Serveur jamais connecté : ouvre-le une fois en SSH pour valider son empreinte'; return verify(false); }
        const payload = { host: hostKeyId, label: host.label, ...info, previous: known || null };
        this.bridge.askHostKey(payload).then(ok => {
          if (ok) {
            vault.data.knownHosts[hostKeyId] = { type: info.type, fingerprint: info.fingerprint, addedAt: new Date().toISOString() };
            vault.save();
          }
          verify(!!ok);
        }).catch(() => verify(false));
      };

      let autoPasswordUsed = false;
      const isPasswordPrompt = (p) => !p.echo && /pass(word|phrase)?|mot de passe|contrase/i.test(p.prompt) && !/code|otp|token|verification|vérification|one[- ]time/i.test(p.prompt);
      conn.on('keyboard-interactive', (name, instructions, _lang, prompts, finish) => {
        if (!prompts.length) return finish([]);
        // Cas simple : uniquement le mot de passe, connu, pas encore essayé → réponse automatique.
        if (host.password && !autoPasswordUsed && prompts.every(isPasswordPrompt)) {
          autoPasswordUsed = true;
          return finish(prompts.map(() => host.password));
        }
        // Sinon (code OTP, nouveau mot de passe, question inconnue…) : on demande à l'utilisateur.
        if (opts.background) { bgError = 'Authentification interactive (2FA) requise : surveillance impossible en arrière-plan'; return finish([]); }
        const ask = this.bridge.askPrompts;
        if (!ask) return finish(prompts.map(() => ''));
        ask({
          host: hostKeyId, label: host.label, name: name || '', instructions: instructions || '',
          prompts: prompts.map(p => ({ prompt: p.prompt, echo: !!p.echo, prefill: isPasswordPrompt(p) && host.password && !autoPasswordUsed ? 'stored' : null }))
        }).then(answers => {
          if (!answers) return finish([]);
          finish(prompts.map((p, i) => (answers[i] === '\u0000stored' ? host.password || '' : (answers[i] ?? ''))));
          if (prompts.some(isPasswordPrompt)) autoPasswordUsed = true;
        }).catch(() => finish([]));
      });
      conn.on('ready', () => { settled = true; resolve(conn); });
      conn.on('error', (err) => {
        if (!settled) {
          let msg = err.message;
          if (err.level === 'client-authentication') msg = 'Authentification refusée (identifiant, mot de passe, clé ou code 2FA)';
          else if (/verification failed/i.test(msg)) msg = 'Clé d\'hôte refusée';
          if (opts.background && bgError) msg = bgError;
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
        const sess = { conn, stream, kind: 'shell', inj: null };
        this.sessions.set(sessionId, sess);
        const out = (data) => { if (data) this.bridge.emit('term:data', { sessionId, data }); };
        const startup = () => { if (host.startupCommand) stream.write(host.startupCommand.replace(/\r?\n?$/, '\n')); };
        const vs = this.bridge.vault && this.bridge.vault.isUnlocked && this.bridge.vault.isUnlocked() ? (this.bridge.vault.data.settings || {}) : {};
        if (vs.shellIntegration !== false && host.shellIntegration !== false) {
          sess.inj = new Injector({
            emit: out, send: (d) => stream.write(d),
            onDone: (ok) => { sess.inj = null; this.bridge.emit('term:shell', { sessionId, integration: ok }); startup(); }
          });
        }
        stream.on('data', d => { const s2 = dec.write(d); if (sess.inj) sess.inj.data(s2); else out(s2); });
        stream.stderr.on('data', d => out(decErr.write(d)));
        // « clean » = le shell distant s'est terminé normalement (exit, logout) : pas de reconnexion auto.
        let exitInfo = null;
        stream.on('exit', (code, signal) => { exitInfo = { code, signal }; });
        const done = (reason) => {
          if (!this.sessions.has(sessionId)) return;
          if (sess.inj) { const i = sess.inj; sess.inj = null; i.onDone = () => {}; i.cancel(); }
          this.sessions.delete(sessionId);
          const clean = !!exitInfo;
          if (clean) reason = exitInfo.signal ? `Session terminée (signal ${exitInfo.signal})` : `Session terminée (code ${exitInfo.code ?? 0})`;
          this.bridge.emit('term:exit', { sessionId, reason, clean });
          conn.end();
        };
        stream.on('close', () => setTimeout(() => done(exitInfo ? '' : 'Connexion perdue'), 50));
        conn.on('close', () => done('Connexion perdue'));
        conn.on('error', e => done('Connexion perdue : ' + e.message));
        if (!sess.inj) startup();
        resolve(true);
      });
    });
  }

  write(sessionId, data) {
    const s = this.sessions.get(sessionId);
    if (s && s.stream) { if (s.inj && s.inj.write(data)) return; s.stream.write(data); }
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
    for (const [id, r] of this.tunnelRetry || []) if (!out[id]) out[id] = { active: false, reconnecting: true, attempt: r.attempt, nextAt: r.nextAt };
    return out;
  }

  // Reconnexion automatique d'un tunnel coupé (pas d'un tunnel arrêté par l'utilisateur).
  scheduleTunnelRetry(forwardId, reason) {
    this.tunnelRetry = this.tunnelRetry || new Map();
    const prev = this.tunnelRetry.get(forwardId);
    const attempt = prev ? prev.attempt + 1 : 1;
    if (attempt > 20) {
      this.tunnelRetry.delete(forwardId);
      this.bridge.emit('tunnel:status', { forwardId, active: false, reason: `${reason} — abandon après 20 tentatives` });
      return;
    }
    const delay = [2, 4, 8, 15, 30][Math.min(attempt - 1, 4)] * 1000;
    const r = { attempt, nextAt: Date.now() + delay, timer: null };
    r.timer = setTimeout(async () => {
      if (!this.tunnelRetry.has(forwardId)) return;
      try {
        await this.startTunnel(forwardId, { retry: true });
        this.tunnelRetry.delete(forwardId);
        this.bridge.emit('tunnel:status', { forwardId, active: true, reason: `Rétabli (tentative ${attempt})` });
      } catch (e) {
        if (!this.tunnelRetry.has(forwardId)) return;
        this.scheduleTunnelRetry(forwardId, e.message);
      }
    }, delay);
    this.tunnelRetry.set(forwardId, r);
    this.bridge.emit('tunnel:status', { forwardId, active: false, reconnecting: true, attempt, delay, reason });
  }

  cancelTunnelRetry(forwardId) {
    const r = this.tunnelRetry && this.tunnelRetry.get(forwardId);
    if (r) { clearTimeout(r.timer); this.tunnelRetry.delete(forwardId); }
  }

  async startTunnel(forwardId, opts = {}) {
    if (this.tunnels.has(forwardId)) return true;
    if (!opts.retry) this.cancelTunnelRetry(forwardId);
    const rule = this.data.forwards.find(f => f.id === forwardId);
    if (!rule) throw new Error('Règle de tunnel introuvable');
    const conn = await this.connect(rule.hostId);
    const t = { conn, server: null, since: Date.now(), count: 0 };
    const bindHost = rule.bindHost || '127.0.0.1';
    const bindPort = Number(rule.bindPort);

    const stop = (reason) => {
      if (this.tunnels.get(forwardId) !== t) return;
      this.tunnels.delete(forwardId);
      if (t.server) t.server.close();
      conn.end();
      const rule2 = this.bridge.vault.isUnlocked() && this.data.forwards.find(f => f.id === forwardId);
      if (rule2 && rule2.autoReconnect !== false) this.scheduleTunnelRetry(forwardId, reason);
      else this.bridge.emit('tunnel:status', { forwardId, active: false, reason });
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
    this.cancelTunnelRetry(forwardId);
    const t = this.tunnels.get(forwardId);
    if (!t) { this.bridge.emit('tunnel:status', { forwardId, active: false, reason: 'Arrêté' }); return; }
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
    for (const id of [...new Set([...this.tunnels.keys(), ...(this.tunnelRetry ? this.tunnelRetry.keys() : [])])]) this.stopTunnel(id);
  }
}

module.exports = { SshManager, keyInfo };

'use strict';
// Appareils liés : deux KSTermus du même réseau local (ex. Windows ⇄ Mac) se connectent
// directement, sans configuration :
//   · chaque appareil a une identité (clé ed25519) et un petit serveur SSH privé ;
//   · découverte automatique par diffusion UDP sur le réseau local ;
//   · appairage unique par code à 6 chiffres (HMAC lié aux deux clés : un intermédiaire
//     ne peut ni lire ni se faire passer pour l'un des deux) ;
//   · ensuite, seuls les appareils appairés entrent (authentification par clé, empreinte
//     épinglée des deux côtés) : fichiers (SFTP), terminal du PC, sessions partagées,
//     synchronisation des hosts et réglages.
// Rien n'est accepté tant que le coffre est verrouillé.

const os = require('os');
const path = require('path');
const crypto = require('crypto');
const dgram = require('dgram');
const { Server, utils } = require('ssh2');
const { serveSftp } = require('./sftp-server');

const DEFAULT_PORT = 47390;
const DISCOVERY_PORT = 47391;
const PAIR_TTL = 3 * 60 * 1000;
const PAIR_MAX_TRIES = 5;

const fpOf = (blob) => 'SHA256:' + crypto.createHash('sha256').update(blob).digest('base64').replace(/=+$/, '');
const pubBlob = (pubLine) => { const k = utils.parseKey(pubLine); if (k instanceof Error) throw k; return k.getPublicSSH(); };
const pairMac = (code, hostFp, clientPub) => crypto.createHmac('sha256', String(code)).update(`kst-pair|${hostFp}|${clientPub}`).digest('hex');
// Code de contrôle affiché sur les deux écrans après l'appairage (comme le Bluetooth) :
// dérivé des DEUX clés ; un intermédiaire sur le réseau obtiendrait deux codes différents.
function sasCode(pubA, pubB) {
  const [x, y] = [pubBlob(pubA), pubBlob(pubB)].sort(Buffer.compare);
  const n = crypto.createHash('sha256').update(Buffer.concat([Buffer.from('kst-sas'), x, y])).digest().readUInt32BE(0) % 1e6;
  return String(n).padStart(6, '0');
}
const safeEq = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };

function lanAddresses() {
  const out = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    for (const a of list || []) {
      if (a.family !== 'IPv4' || a.internal) continue;
      const ip = a.address.split('.').map(Number), mask = a.netmask.split('.').map(Number);
      out.push({ iface: name, address: a.address, broadcast: ip.map((b, i) => (b | (~mask[i] & 255))).join('.') });
    }
  }
  return out;
}

class PeerService {
  constructor(o) {
    this.vault = o.vault;
    this.local = o.local;                         // LocalManager : sessions locales partagées
    this.emit = o.emit || (() => {});
    this.notify = o.notify || (() => {});         // ({ title, body }) : notification à l'utilisateur de CE PC
    this.audit = o.audit || (() => {});
    this.isLocked = o.isLocked || (() => false);
    this.getSettings = o.getSettings || (() => ({}));
    this.deviceName = o.deviceName || os.hostname();
    this.platform = o.platform || process.platform;
    this.appVersion = o.appVersion || '';
    this.userDataDir = o.userDataDir || os.tmpdir();
    this.port = o.port ?? DEFAULT_PORT;
    this.discoveryPort = o.discoveryPort ?? DISCOVERY_PORT;
    this.discovery = o.discovery !== false;
    this.syncHub = o.syncHub || null;             // { join(peer) => { password }, read(), write(text, ver), changed() }
    this.spawnShell = o.spawnShell || null;       // (cols, rows) => pty : terminal de ce PC pour un pair
    this.connectPeer = null;                      // (peerId) => Promise<ssh2 Client> (fourni par main : ssh-manager)
    this.server = null; this.listenPort = null;
    this.sock = null; this.announceTimer = null;
    this.seen = new Map();                        // id -> { id, name, platform, port, fp, addr, version, at }
    this.pairing = null;                          // { code, expiresAt, tries }
    this.clients = new Set();
  }

  // ---------- Identité et liste des appareils appairés (dans le coffre, non synchronisées) ----------
  machineTag() { return crypto.createHash('sha256').update(os.hostname() + '|' + this.userDataDir).digest('hex').slice(0, 16); }
  identity() {
    const d = this.vault.data;
    // Coffre restauré depuis un autre PC : nouvelle identité (deux PC ne doivent jamais partager la même).
    if (!d.device || d.device.machine !== this.machineTag()) {
      const k = utils.generateKeyPairSync('ed25519', { comment: 'kstermus-device' });
      const fresh = !d.device;
      d.device = { id: crypto.randomUUID(), name: (d.device && d.device.name) || this.deviceName, key: k.private, pub: k.public, machine: this.machineTag() };
      if (!fresh) d.peers = [];
      this.vault.save();
    }
    if (!Array.isArray(d.peers)) d.peers = [];
    return d.device;
  }
  myFp() { return fpOf(pubBlob(this.identity().pub)); }
  peers() { return this.vault.isUnlocked() ? (this.identity(), this.vault.data.peers) : []; }
  peerById(id) { return this.peers().find(p => p.id === id); }

  state() {
    if (!this.vault.isUnlocked()) return { locked: true };
    const me = this.identity();
    const now = Date.now();
    const online = (id) => { const s = this.seen.get(id); return !!(s && now - s.at < 16000); };
    return {
      me: { id: me.id, name: me.name, platform: this.platform, port: this.listenPort, running: !!this.server, fingerprint: this.myFp(), addresses: lanAddresses().map(a => a.address) },
      pairing: this.pairing ? { code: this.pairing.code, expiresAt: this.pairing.expiresAt } : null,
      peers: this.peers().map(p => ({ id: p.id, name: p.name, platform: p.platform, pairedAt: p.pairedAt, addr: (this.seen.get(p.id) || {}).addr || p.addr, port: (this.seen.get(p.id) || {}).port || p.port, online: online(p.id), fingerprint: fpOf(pubBlob(p.pub)) })),
      discovered: [...this.seen.values()].filter(s => now - s.at < 16000 && !this.peerById(s.id)).map(({ id, name, platform, addr, port, fp, version }) => ({ id, name, platform, addr, port, fingerprint: fp, version }))
    };
  }
  changed() { this.emit('peers:update', this.state()); }

  rename(name) {
    const n = String(name || '').trim().slice(0, 60);
    if (!n) throw new Error('Nom vide');
    this.identity().name = n; this.vault.save(); this.announce(); this.changed();
    return this.state();
  }

  // ---------- Démarrage / arrêt (coffre déverrouillé uniquement) ----------
  wanted() { return this.vault.isUnlocked() && this.getSettings().peerEnabled !== false && (this.peers().length > 0 || !!this.pairing); }
  async start() {
    if (!this.vault.isUnlocked()) return;
    this.identity();
    if (this.discovery && !this.sock) this.startDiscovery();
    if (this.wanted() && !this.server) await this.startServer();
    if (!this.wanted() && this.server) this.stopServer();
    this.changed();
  }
  stop() {
    this.pairing = null;
    this.stopServer();
    clearInterval(this.announceTimer); this.announceTimer = null;
    if (this.sock) { try { this.sock.close(); } catch { /* ignore */ } this.sock = null; }
    this.seen.clear();
  }

  startServer() {
    const me = this.identity();
    this.server = new Server({ hostKeys: [me.key], ident: 'KSTermus_' + this.appVersion }, (client, info) => this.onClient(client, info));
    this.server.on('error', () => {});
    const listen = (port) => new Promise((resolve, reject) => {
      const onErr = (e) => reject(e);
      this.server.once('error', onErr);
      this.server.listen(port, '0.0.0.0', () => { this.server.off('error', onErr); resolve(); });
    });
    return listen(this.port).catch((e) => (e.code === 'EADDRINUSE' && this.port ? listen(0) : Promise.reject(e)))
      .then(() => { this.listenPort = this.server.address().port; this.announce(); })
      .catch((e) => { this.server = null; throw new Error('Impossible d\'ouvrir le port des appareils liés : ' + e.message); });
  }
  stopServer() {
    for (const c of this.clients) { try { c.end(); } catch { /* ignore */ } }
    this.clients.clear();
    if (this.server) { try { this.server.close(); } catch { /* ignore */ } }
    this.server = null; this.listenPort = null;
  }

  // ---------- Découverte (UDP, réseau local) ----------
  startDiscovery() {
    const s = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    this.sock = s;
    s.on('error', () => { try { s.close(); } catch { /* ignore */ } if (this.sock === s) this.sock = null; });
    s.on('message', (buf, rinfo) => this.onDiscovery(buf, rinfo));
    s.bind(this.discoveryPort, () => {
      try { s.setBroadcast(true); } catch { /* ignore */ }
      this.send({ t: 'query' });
      this.announce();
    });
    this.announceTimer = setInterval(() => { this.announce(); this.prune(); }, 5000);
  }
  send(msg, to) {
    if (!this.sock || !this.vault.isUnlocked()) return;
    const me = this.identity();
    const body = Buffer.from(JSON.stringify({ app: 'KSTermus', v: 1, id: me.id, name: me.name, platform: this.platform, version: this.appVersion, port: this.listenPort, fp: this.listenPort ? this.myFp() : null, ...msg }));
    const targets = to ? [to] : [...new Set(['255.255.255.255', ...lanAddresses().map(a => a.broadcast)])];
    for (const t of targets) this.sock.send(body, this.discoveryPort, t, () => {});
  }
  announce() { if (this.server && this.listenPort) this.send({ t: 'hello' }); }
  prune() {
    const now = Date.now(); let ch = false;
    for (const [id, s] of this.seen) if (now - s.at > 20000) { this.seen.delete(id); ch = true; }
    if (ch) this.changed();
  }
  onDiscovery(buf, rinfo) {
    let m; try { m = JSON.parse(buf.toString()); } catch { return; }
    if (!m || m.app !== 'KSTermus' || !m.id || !this.vault.isUnlocked() || m.id === this.identity().id) return;
    if (m.t === 'query') { this.announce(); if (this.server) this.send({ t: 'hello' }, rinfo.address); }
    if (!m.port) return;
    const prev = this.seen.get(m.id);
    this.seen.set(m.id, { id: m.id, name: String(m.name || '?').slice(0, 60), platform: m.platform, version: m.version, port: m.port, fp: m.fp, addr: rinfo.address, at: Date.now() });
    // Adresse mémorisée pour un appareil appairé (l'authentification, elle, reste par clé épinglée).
    const p = this.peerById(m.id);
    if (p && (p.addr !== rinfo.address || p.port !== m.port || p.name !== m.name)) { p.addr = rinfo.address; p.port = m.port; p.name = String(m.name || p.name).slice(0, 60); this.vault.save(); }
    if (!prev || prev.addr !== rinfo.address || prev.port !== m.port || prev.name !== m.name) this.changed();
  }
  // Ajout manuel (réseau sans diffusion) : IP:port.
  remember({ addr, port }) { this.manual = { addr, port: Number(port) || DEFAULT_PORT }; }

  // ---------- Appairage ----------
  async startPairing() {
    if (!this.vault.isUnlocked()) throw new Error('Coffre verrouillé');
    this.pairing = { code: String(crypto.randomInt(0, 1e6)).padStart(6, '0'), expiresAt: Date.now() + PAIR_TTL, tries: 0 };
    clearTimeout(this.pairTimer);
    this.pairTimer = setTimeout(() => this.cancelPairing(), PAIR_TTL);
    await this.start();
    return this.state();
  }
  cancelPairing() { clearTimeout(this.pairTimer); this.pairing = null; this.start().catch(() => {}); return true; }

  checkPair(password, info) {
    const pr = this.pairing;
    if (!pr || Date.now() > pr.expiresAt) return null;
    let req; try { req = JSON.parse(password); } catch { return null; }
    if (!req || !req.id || !req.pub || !req.mac) return null;
    try { pubBlob(req.pub); } catch { return null; }
    if (!safeEq(req.mac, pairMac(pr.code, this.myFp(), req.pub))) {
      if (++pr.tries >= PAIR_MAX_TRIES) { this.cancelPairing(); this.notify({ title: 'Appairage annulé', body: 'Trop de codes erronés.' }); }
      return null;
    }
    const peer = { id: String(req.id), name: String(req.name || 'Appareil').slice(0, 60), platform: String(req.platform || ''), pub: req.pub, addr: info.ip, port: Number(req.port) || null, pairedAt: new Date().toISOString() };
    const d = this.vault.data;
    d.peers = [...d.peers.filter(p => p.id !== peer.id), peer];
    this.vault.save();
    clearTimeout(this.pairTimer); this.pairing = null;
    this.audit('peer-paired', peer.name);
    this.notify({ title: 'Appareil appairé', body: `${peer.name} peut maintenant accéder à ce PC.` });
    const sas = sasCode(this.identity().pub, peer.pub);
    setImmediate(() => { this.changed(); this.emit('peers:paired', { id: peer.id, name: peer.name, sas }); });
    return peer;
  }

  // Côté appareil qui saisit le code : se connecte à l'autre, prouve la connaissance du code.
  async pairWith(opts) {
    // Ouvrir aussi notre port tout de suite : l'autre appareil pourra se connecter à nous en retour.
    if (!this.server && this.vault.isUnlocked() && this.getSettings().peerEnabled !== false) await this.startServer().catch(() => {});
    try { return await this._pairWith(opts); } finally { this.start().catch(() => {}); }
  }
  _pairWith({ id, addr, port, code }) {
    const s = id ? this.seen.get(id) : null;
    const host = (s && s.addr) || addr, p = (s && s.port) || Number(port) || DEFAULT_PORT;
    if (!host) throw new Error('Appareil introuvable sur le réseau');
    if (!/^\d{6}$/.test(String(code || '').trim())) throw new Error('Le code fait 6 chiffres');
    const me = this.identity();
    const { Client } = require('ssh2');
    return new Promise((resolve, reject) => {
      const c = new Client();
      let hostRaw = null, done = false, tried = false;
      const finish = (e, v) => { if (done) return; done = true; c.end(); e ? reject(e) : resolve(v); };
      c.on('ready', () => {
        c.exec('kst:info', (err, st) => {
          if (err) return finish(err);
          let out = ''; st.on('data', d => { out += d; }); st.stderr.on('data', () => {});
          st.on('close', () => {
            let inf; try { inf = JSON.parse(out); } catch { return finish(new Error('Réponse inattendue de l\'appareil')); }
            const peer = { id: String(inf.id), name: String(inf.name || 'Appareil').slice(0, 60), platform: String(inf.platform || ''), pub: 'ssh-ed25519 ' + hostRaw.subarray(0).toString('base64'), addr: host, port: p, pairedAt: new Date().toISOString() };
            if (hostRaw.readUInt32BE(0) !== 11) return finish(new Error('Clé d\'appareil inattendue'));
            const d = this.vault.data;
            d.peers = [...d.peers.filter(x => x.id !== peer.id), peer];
            this.vault.save();
            this.audit('peer-paired', peer.name);
            this.start().catch(() => {});
            this.changed();
            finish(null, { id: peer.id, name: peer.name, sas: sasCode(me.pub, peer.pub) });
          });
        });
      });
      c.on('close', () => finish(new Error('Code incorrect ou expiré (relance l\'appairage sur l\'autre appareil)')));
      c.on('error', (e) => finish(new Error(e.level === 'client-authentication' ? 'Code incorrect ou expiré (relance l\'appairage sur l\'autre appareil)' : 'Connexion à l\'appareil impossible : ' + e.message)));
      c.connect({
        host, port: p, username: 'kst-pair', readyTimeout: 15000, tryKeyboard: false,
        hostVerifier: (raw) => { hostRaw = Buffer.from(raw); return true; },
        authHandler: (methods, partial, cb) => {
          if (!hostRaw || tried) return cb(false);
          tried = true;
          const mac = pairMac(String(code).trim(), fpOf(hostRaw), me.pub);
          cb({ type: 'password', username: 'kst-pair', password: JSON.stringify({ id: me.id, name: me.name, platform: this.platform, pub: me.pub, port: this.listenPort, mac }) });
        }
      });
    });
  }

  unpair(id) {
    const d = this.vault.data;
    const p = d.peers.find(x => x.id === id);
    d.peers = d.peers.filter(x => x.id !== id);
    this.vault.save();
    for (const c of this.clients) if (c.peerId === id) { try { c.end(); } catch { /* ignore */ } }
    if (p) this.audit('peer-unpaired', p.name);
    this.start().catch(() => {});
    return this.state();
  }

  // Pseudo-host utilisé par ssh-manager pour se connecter à un appareil appairé.
  peerHost(id) {
    const p = this.peerById(id);
    if (!p) throw new Error('Appareil non appairé');
    const s = this.seen.get(id);
    const addr = (s && s.addr) || p.addr, port = (s && s.port) || p.port;
    if (!addr || !port) throw new Error(`${p.name} n'est pas visible sur le réseau (allumé, KSTermus ouvert et déverrouillé ?)`);
    return { id: 'peer:' + id, label: p.name, hostname: addr, port, username: 'kst', auth: 'peer', privateKey: this.identity().key, pinnedFp: fpOf(pubBlob(p.pub)), isPeer: true, shellIntegration: false };
  }

  // ---------- Côté serveur : ce que peut faire un appareil appairé ----------
  onClient(client, info) {
    // Sans TCP_NODELAY chaque petite requête SFTP attend ~40 ms (Nagle + ACK retardé) :
    // un dossier de milliers de fichiers prenait des dizaines de minutes.
    try { client.setNoDelay(true); } catch { /* ignore */ }
    this.clients.add(client);
    client.on('close', () => this.clients.delete(client));
    client.on('error', () => {});
    client.on('authentication', (ctx) => {
      if (this.isLocked() || !this.vault.isUnlocked()) return ctx.reject();
      if (ctx.username === 'kst-pair') {
        if (ctx.method !== 'password') return ctx.reject(['password']);
        const peer = this.checkPair(ctx.password, info);
        if (!peer) return ctx.reject(['password']);
        client.pairOnly = true; client.peerId = peer.id;
        return ctx.accept();
      }
      if (ctx.method !== 'publickey') return ctx.reject(['publickey']);
      const peer = this.peers().find(p => { try { return pubBlob(p.pub).equals(ctx.key.data); } catch { return false; } });
      if (!peer) return ctx.reject();
      if (ctx.signature) {
        const k = utils.parseKey(peer.pub);
        if (k.verify(ctx.blob, ctx.signature, ctx.hashAlgo) !== true) return ctx.reject();
      }
      client.peerId = peer.id; client.peerName = peer.name;
      ctx.accept();
    });
    client.on('ready', () => {
      if (!client.pairOnly) { const p = this.peerById(client.peerId); if (p && p.addr !== info.ip) { p.addr = info.ip; this.vault.save(); } }
      client.on('session', (accept) => this.onSession(client, accept()));
    });
  }

  onSession(client, session) {
    let ptyInfo = { cols: 80, rows: 24 };
    let proc = null;
    session.on('pty', (accept, _r, i) => { ptyInfo = { cols: i.cols || 80, rows: i.rows || 24 }; if (accept) accept(); });
    session.on('window-change', (accept, _r, i) => { if (proc && proc.resize) { try { proc.resize(i.cols, i.rows); } catch { /* ignore */ } } if (accept) accept(); });
    session.on('env', (accept) => accept && accept());
    const deny = (acceptOrReject) => { if (typeof acceptOrReject === 'function') acceptOrReject(); };
    if (client.pairOnly) {
      session.on('exec', (accept, reject, i) => {
        if (i.command !== 'kst:info') return deny(reject);
        const st = accept(); st.write(JSON.stringify(this.info())); st.exit(0); st.end();
      });
      session.on('shell', (_a, reject) => deny(reject));
      session.on('sftp', (_a, reject) => deny(reject));
      return;
    }
    const who = client.peerName || 'Un appareil';
    session.on('sftp', (accept) => {
      this.audit('peer-sftp', who);
      serveSftp(accept(), { platform: this.platform, home: os.homedir() });
    });
    session.on('shell', (accept, reject) => {
      if (!this.spawnShell) return deny(reject);
      const st = accept();
      try { proc = this.spawnShell(ptyInfo.cols, ptyInfo.rows); } catch (e) { st.stderr.write(e.message + '\r\n'); st.exit(1); return st.end(); }
      this.audit('peer-shell', who);
      this.notify({ title: 'Terminal ouvert à distance', body: `${who} a ouvert un terminal sur ce PC.` });
      proc.onData(d => { try { st.write(d); } catch { /* fermé */ } });
      proc.onExit(({ exitCode }) => { try { st.exit(exitCode || 0); st.end(); } catch { /* ignore */ } });
      st.on('data', d => proc.write(d.toString()));
      st.on('close', () => { try { proc.kill(); } catch { /* déjà fini */ } });
    });
    session.on('exec', (accept, reject, i) => this.onExec(client, String(i.command || ''), accept, reject, who));
  }

  info() { const me = this.identity(); return { id: me.id, name: me.name, platform: this.platform, version: this.appVersion }; }

  onExec(client, cmd, accept, reject, who) {
    const reply = (obj, code = 0) => { const st = accept(); st.write(typeof obj === 'string' ? obj : JSON.stringify(obj)); st.exit(code); st.end(); };
    const readAll = (st) => new Promise((res) => { const chunks = []; st.on('data', d => chunks.push(d)); st.on('end', () => res(Buffer.concat(chunks).toString('utf8'))); });
    if (cmd === 'kst:info') return reply(this.info());
    if (cmd === 'kst:sessions') return reply(this.local ? this.local.list().map(s => ({ id: s.id, title: s.title, shell: s.shell, createdAt: s.createdAt, cwd: s.cwd })) : []);
    let m = /^kst:attach ([\w:.-]{1,80})$/.exec(cmd);
    if (m) {
      const id = m[1];
      if (!this.local || !this.local.has(id)) return reply('Session terminée\r\n', 1);
      const st = accept();
      const s = this.local.watch(id, (d) => { try { st.write(d); } catch { /* fermé */ } }, () => { try { st.exit(0); st.end(); } catch { /* ignore */ } });
      st.write(s.buffer);
      st.on('data', d => this.local.write(id, d.toString()));
      st.on('close', () => s.unwatch());
      this.audit('peer-attach', `${who} › ${s.title}`);
      this.notify({ title: 'Session partagée', body: `${who} a rejoint « ${s.title} ».` });
      this.emit('peers:attached', { sessionId: id, by: who });
      return;
    }
    if (!this.syncHub) return deny(reject);
    if (cmd === 'kst:sync-join') {
      return Promise.resolve().then(() => this.syncHub.join(this.peerById(client.peerId))).then(r => reply(r), e => reply({ error: e.message }, 1));
    }
    if (cmd === 'kst:sync-read') return Promise.resolve(this.syncHub.read()).then(r => reply(r || { none: true }), e => reply({ error: e.message }, 1));
    m = /^kst:sync-write ([0-9a-f]{64}|-)$/.exec(cmd);
    if (m) {
      const st = accept();
      readAll(st).then(text => this.syncHub.write(text, m[1] === '-' ? null : m[1])).then(() => { st.write('{"ok":true}'); st.exit(0); st.end(); this.syncHub.changed(); },
        (e) => { st.write(JSON.stringify({ error: e.message, code: e.code || null })); st.exit(1); st.end(); });
      return;
    }
    return deny(reject);

    function deny(r) { if (typeof r === 'function') r(); }
  }

  // ---------- Côté client : commandes vers un appareil appairé ----------
  async exec(peerId, cmd, input) {
    if (!this.connectPeer) throw new Error('Connexion aux appareils indisponible');
    const conn = await this.connectPeer(peerId);
    try {
      return await new Promise((resolve, reject) => {
        conn.exec(cmd, (err, st) => {
          if (err) return reject(err);
          let out = '', code = 0;
          st.on('data', d => { out += d; }); st.stderr.on('data', () => {});
          st.on('exit', (c) => { code = c; });
          st.on('close', () => {
            let j; try { j = JSON.parse(out); } catch { return reject(new Error('Réponse inattendue de l\'appareil')); }
            if (code && j && j.error) { const e = new Error(j.error); if (j.code) e.code = j.code; return reject(e); }
            resolve(j);
          });
          if (input !== undefined) st.end(input); else st.end();
        });
      });
    } finally { conn.end(); }
  }
  remoteSessions(peerId) { return this.exec(peerId, 'kst:sessions'); }
}

// Stockage de synchronisation hébergé par un appareil lié (méthode « peer »).
class PeerBackend {
  constructor({ peers, peerId }) { this.peers = peers; this.peerId = peerId; }
  describe() { const p = this.peers.peerById(this.peerId); return `Appareil lié › ${p ? p.name : '?'}`; }
  async check() { await this.peers.exec(this.peerId, 'kst:info'); }
  async read() { const r = await this.peers.exec(this.peerId, 'kst:sync-read'); return r && r.none ? null : r; }
  async write(text, ver) { await this.peers.exec(this.peerId, `kst:sync-write ${ver || '-'}`, text); }
}

// Côté appareil qui héberge la synchronisation : crée la config « peerhub » au premier appareil qui rejoint.
function makeSyncHub({ vault, sync, dir }) {
  const { FolderBackend } = require('./sync');
  const fb = () => new FolderBackend({ folder: dir });
  const names = { folder: 'un dossier partagé', github: 'GitHub', gdrive: 'Google Drive', peer: 'un autre appareil lié' };
  return {
    async join() {
      const c = vault.data.sync;
      if (c && c.method && c.method !== 'peerhub') throw new Error(`L'autre PC synchronise déjà ses hosts via ${names[c.method] || c.method} : choisis la même méthode sur ce PC (Paramètres ▸ Synchronisation)`);
      if (!c || !c.hubPassword) {
        const pw = crypto.randomBytes(24).toString('base64url');
        await sync.enable({ method: 'peerhub', folder: dir }, pw);
        vault.data.sync.hubPassword = pw; vault.save();
      }
      return { password: vault.data.sync.hubPassword };
    },
    read: () => fb().read(),
    write: (t, v) => fb().write(t, v),
    changed: () => setTimeout(() => { if (vault.isUnlocked() && vault.data.sync) sync.syncNow().catch(() => {}); }, 200)
  };
}

module.exports = { PeerService, PeerBackend, makeSyncHub, sasCode, pairMac, fpOf, lanAddresses, DEFAULT_PORT, DISCOVERY_PORT };

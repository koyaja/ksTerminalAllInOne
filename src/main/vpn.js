'use strict';
// VPN WireGuard intégrés : un processus kst-wg (wireguard-go + netstack) par
// profil démarré. Aucun droit administrateur, aucune route système modifiée :
// seules les connexions SSH / SFTP / tunnels des hosts associés passent par le
// VPN, via un SOCKS5 local protégé par un identifiant aléatoire.

const fs = require('fs');
const net = require('net');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

// ----- Lecture d'un fichier .conf wg-quick -----
function b64KeyToHex(v, what) {
  const b = Buffer.from(String(v || '').trim(), 'base64');
  if (b.length !== 32) throw new Error(`${what} invalide (clé WireGuard base64 de 32 octets attendue)`);
  return b.toString('hex');
}
const list = (v) => String(v || '').split(',').map(s => s.trim()).filter(Boolean);

function parseWgConf(text) {
  const src = String(text || '').replace(/^﻿/, '');
  let section = null, cur = null;
  const iface = { addresses: [], dns: [] };
  const peers = [];
  for (const raw of src.split(/\r?\n/)) {
    const line = raw.replace(/[#;].*$/, '').trim();
    if (!line) continue;
    const sec = line.match(/^\[(\w+)\]$/);
    if (sec) {
      section = sec[1].toLowerCase();
      if (section === 'peer') { cur = { allowedIPs: [] }; peers.push(cur); }
      continue;
    }
    const m = line.match(/^([\w-]+)\s*=\s*(.*)$/);
    if (!m) continue;
    const k = m[1].toLowerCase(), v = m[2].trim();
    if (section === 'interface') {
      if (k === 'privatekey') iface.privateKey = v;
      else if (k === 'address') iface.addresses.push(...list(v));
      else if (k === 'dns') iface.dns.push(...list(v).filter(x => /^[\d.:a-fA-F]+$/.test(x)));
      else if (k === 'mtu') iface.mtu = Number(v) || undefined;
    } else if (section === 'peer' && cur) {
      if (k === 'publickey') cur.publicKey = v;
      else if (k === 'presharedkey') cur.presharedKey = v;
      else if (k === 'endpoint') cur.endpoint = v;
      else if (k === 'allowedips') cur.allowedIPs.push(...list(v));
      else if (k === 'persistentkeepalive') cur.keepalive = Number(v) || 0;
    }
  }
  if (!iface.privateKey) throw new Error('[Interface] PrivateKey manquant');
  if (!iface.addresses.length) throw new Error('[Interface] Address manquant');
  if (!peers.length) throw new Error('Aucune section [Peer]');
  for (const p of peers) {
    if (!p.publicKey) throw new Error('[Peer] PublicKey manquant');
    if (!p.endpoint) throw new Error('[Peer] Endpoint manquant');
    if (!p.allowedIPs.length) throw new Error('[Peer] AllowedIPs manquant');
  }
  return {
    privateKey: b64KeyToHex(iface.privateKey, 'PrivateKey'),
    addresses: iface.addresses, dns: iface.dns, mtu: iface.mtu || 1420,
    peers: peers.map(p => ({
      publicKey: b64KeyToHex(p.publicKey, 'PublicKey'),
      presharedKey: p.presharedKey ? b64KeyToHex(p.presharedKey, 'PresharedKey') : '',
      endpoint: p.endpoint, allowedIPs: p.allowedIPs, keepalive: p.keepalive || 25
    }))
  };
}

// Résumé affichable (sans aucune clé).
function describeConf(text) {
  const c = parseWgConf(text);
  return { addresses: c.addresses, dns: c.dns, endpoints: c.peers.map(p => p.endpoint), allowedIPs: [...new Set(c.peers.flatMap(p => p.allowedIPs))] };
}

function defaultBinPath({ isPackaged, resourcesPath, appRoot, platform = process.platform, arch = process.arch }) {
  const name = `kst-wg-${platform}-${arch}${platform === 'win32' ? '.exe' : ''}`;
  return isPackaged ? path.join(resourcesPath, 'kst-wg', name) : path.join(appRoot, 'native', 'kst-wg', name);
}

class VpnManager {
  constructor({ binPath, emit = () => {}, spawnFn = spawn }) {
    this.binPath = binPath;
    this.emit = emit;
    this.spawnFn = spawnFn;
    this.running = new Map();  // id -> { proc, socks, user, pass, status, startPromise }
  }

  status(id) {
    const r = this.running.get(id);
    if (!r) return { id, state: 'stopped' };
    const recent = r.handshake && (Date.now() / 1000 - r.handshake) < 180;
    return { id, state: r.state === 'up' && recent ? 'connected' : r.state, socks: r.socks || null, handshake: r.handshake || 0, rx: r.rx || 0, tx: r.tx || 0, error: r.error || null, name: r.name };
  }
  statuses() { return [...this.running.keys()].map(id => this.status(id)); }
  push(id) { this.emit('vpn:status', this.status(id)); }

  // Démarre (ou réutilise) le tunnel du profil. Résout quand le SOCKS local est prêt.
  start(profile) {
    const existing = this.running.get(profile.id);
    if (existing && existing.state !== 'error') return existing.startPromise;
    if (!fs.existsSync(this.binPath)) return Promise.reject(new Error('Moteur WireGuard introuvable : ' + this.binPath));
    let conf;
    try { conf = parseWgConf(profile.config); } catch (e) { return Promise.reject(new Error(`VPN « ${profile.name} » : ${e.message}`)); }
    const r = { state: 'starting', name: profile.name, user: crypto.randomBytes(9).toString('hex'), pass: crypto.randomBytes(18).toString('hex') };
    this.running.set(profile.id, r);
    this.push(profile.id);
    r.startPromise = new Promise((resolve, reject) => {
      const proc = this.spawnFn(this.binPath, [], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
      r.proc = proc;
      let settled = false, buf = '', errText = '';
      const done = (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (err) { r.state = 'error'; r.error = err.message; this.push(profile.id); try { proc.kill(); } catch { /* ignore */ } reject(err); }
        else resolve(r);
      };
      const timer = setTimeout(() => done(new Error(`VPN « ${profile.name} » : démarrage trop long`)), 15000);
      proc.on('error', (e) => done(new Error(`VPN « ${profile.name} » : ${e.message}`)));
      proc.stderr.on('data', d => { errText = (errText + d).slice(-2000); });
      proc.stdout.on('data', (d) => {
        buf += d;
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i); buf = buf.slice(i + 1);
          let ev; try { ev = JSON.parse(line); } catch { continue; }
          if (ev.event === 'ready') { r.socks = ev.socks; r.state = 'up'; this.push(profile.id); done(); }
          else if (ev.event === 'stats') {
            const changed = ev.handshake !== r.handshake;
            Object.assign(r, { handshake: ev.handshake, rx: ev.rx, tx: ev.tx });
            if (changed || this.emitStats !== false) this.push(profile.id);
          } else if (ev.event === 'error') { r.error = ev.error; done(new Error(`VPN « ${profile.name} » : ${ev.error}`)); }
        }
      });
      proc.on('exit', (code) => {
        const wasStopping = r.stopping;
        if (!settled) done(new Error(`VPN « ${profile.name} » arrêté (code ${code}) ${errText.trim().split('\n').pop() || ''}`.trim()));
        if (this.running.get(profile.id) === r) {
          if (wasStopping) this.running.delete(profile.id);
          else if (r.state !== 'error') { r.state = 'error'; r.error = r.error || `arrêté de façon inattendue (code ${code})`; }
        }
        this.push(profile.id);
      });
      // La configuration (clé privée comprise) passe par stdin, jamais par le disque.
      proc.stdin.write(JSON.stringify({ ...conf, listen: '127.0.0.1:0', user: r.user, pass: r.pass }) + '\n');
    });
    r.startPromise.catch(() => {});
    return r.startPromise;
  }

  stop(id) {
    const r = this.running.get(id);
    if (!r) return false;
    r.stopping = true;
    try { r.proc.stdin.end(); } catch { /* ignore */ }
    setTimeout(() => { try { r.proc.kill(); } catch { /* ignore */ } }, 1500).unref();
    if (r.state === 'error') this.running.delete(id);
    r.state = 'stopped';
    this.push(id);
    return true;
  }
  stopAll() { for (const id of [...this.running.keys()]) this.stop(id); }

  // Ouvre une connexion TCP vers host:port à travers le VPN (SOCKS5 + identifiant).
  async connect(profile, host, port) {
    const r = await this.start(profile);
    const [shost, sport] = splitHostPort(r.socks);
    return new Promise((resolve, reject) => {
      const s = net.connect(sport, shost);
      let stage = 0, acc = Buffer.alloc(0);
      const fail = (msg) => { s.destroy(); reject(new Error(`VPN « ${profile.name} » : ${msg}`)); };
      const timer = setTimeout(() => fail(`${host}:${port} ne répond pas à travers le tunnel (handshake WireGuard ou routage AllowedIPs ?)`), 25000);
      s.on('error', (e) => { clearTimeout(timer); fail(e.message); });
      s.on('connect', () => s.write(Buffer.from([5, 1, 2])));
      const onData = (d) => {
        acc = Buffer.concat([acc, d]);
        if (stage === 0 && acc.length >= 2) {
          if (acc[1] !== 2) return fail('proxy local refusé');
          acc = acc.subarray(2); stage = 1;
          const u = Buffer.from(r.user), p = Buffer.from(r.pass);
          s.write(Buffer.concat([Buffer.from([1, u.length]), u, Buffer.from([p.length]), p]));
        }
        if (stage === 1 && acc.length >= 2) {
          if (acc[1] !== 0) return fail('authentification au proxy local refusée');
          acc = acc.subarray(2); stage = 2;
          const isV4 = net.isIPv4(host), isV6 = net.isIPv6(host);
          const addr = isV4 ? Buffer.from([1, ...host.split('.').map(Number)])
            : isV6 ? Buffer.concat([Buffer.from([4]), ipv6Bytes(host)])
              : Buffer.concat([Buffer.from([3, Buffer.byteLength(host)]), Buffer.from(host)]);
          const pb = Buffer.alloc(2); pb.writeUInt16BE(Number(port));
          s.write(Buffer.concat([Buffer.from([5, 1, 0]), addr, pb]));
        }
        if (stage === 2 && acc.length >= 10) {
          clearTimeout(timer);
          s.removeListener('data', onData);
          const code = acc[1];
          if (code !== 0) {
            const why = { 4: `nom ${host} introuvable (DNS du VPN)`, 5: `${host}:${port} injoignable dans le tunnel (serveur éteint, AllowedIPs ou handshake WireGuard ?)` }[code] || `erreur SOCKS ${code}`;
            return fail(why);
          }
          const rest = acc.subarray(10);
          if (rest.length) s.unshift(rest);
          resolve(s);
        }
      };
      s.on('data', onData);
    });
  }
}

function splitHostPort(hp) { const i = hp.lastIndexOf(':'); return [hp.slice(0, i), Number(hp.slice(i + 1))]; }
function ipv6Bytes(ip) {
  const [a, b = ''] = ip.split('::');
  const pa = a ? a.split(':') : [], pb = b ? b.split(':') : [];
  const parts = [...pa, ...Array(8 - pa.length - pb.length).fill('0'), ...pb];
  const out = Buffer.alloc(16);
  parts.forEach((h, i) => out.writeUInt16BE(parseInt(h || '0', 16), i * 2));
  return out;
}

module.exports = { VpnManager, parseWgConf, describeConf, defaultBinPath };

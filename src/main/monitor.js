'use strict';
// Tableau de bord des serveurs : mesures périodiques par SSH, sans agent à installer.
// Une seule commande shell (POSIX, /proc) par mesure ; une connexion de fond gardée
// ouverte par host surveillé (VPN / jump host compris), jamais de question à l'utilisateur.

const SEP = '@@KST@@';

// Services : noms simples uniquement (pas d'injection dans la commande).
const safeService = (s) => /^[\w@.:-]{1,64}$/.test(s);

function probeScript(services = []) {
  const svc = services.filter(safeService);
  const S = (name) => `echo "${SEP}${name}"`;
  return [
    'LC_ALL=C; export LC_ALL',
    S('uname'), 'uname -srm 2>/dev/null',
    S('os'), '( . /etc/os-release 2>/dev/null && echo "$PRETTY_NAME" ) || uname -s',
    S('host'), 'hostname 2>/dev/null',
    S('uptime'), 'cat /proc/uptime 2>/dev/null',
    S('load'), 'cat /proc/loadavg 2>/dev/null',
    S('cpus'), 'getconf _NPROCESSORS_ONLN 2>/dev/null || nproc 2>/dev/null',
    S('stat'), 'head -1 /proc/stat 2>/dev/null',
    S('mem'), 'grep -E "^(MemTotal|MemAvailable|SwapTotal|SwapFree):" /proc/meminfo 2>/dev/null',
    S('disk'), 'df -P -k -x tmpfs -x devtmpfs -x overlay -x squashfs -x efivarfs 2>/dev/null | tail -n +2',
    S('net'), 'tail -n +3 /proc/net/dev 2>/dev/null',
    // systemd si disponible ; sinon (conteneur, Alpine/OpenRC…) présence du processus (nom ou nom + « d »).
    ...(svc.length ? [S('services'), `for s in ${svc.join(' ')}; do st=$(systemctl is-active "$s" 2>/dev/null); case "$st" in active|inactive|failed|activating|deactivating|reloading) ;; *) if command -v pgrep >/dev/null 2>&1; then if pgrep -x "$s" >/dev/null 2>&1 || pgrep -x "\${s}d" >/dev/null 2>&1; then st=active; else st=inactive; fi; else st=unknown; fi;; esac; printf '%s %s\\n' "$s" "$st"; done`] : []),
    S('docker'), 'command -v docker >/dev/null 2>&1 && (docker ps -q 2>/dev/null | wc -l; docker ps -aq 2>/dev/null | wc -l) || true',
    S('end')
  ].join('\n');
}

function sections(out) {
  const res = {};
  let cur = null;
  for (const line of String(out).split('\n')) {
    if (line.startsWith(SEP)) { cur = line.slice(SEP.length).trim(); res[cur] = []; continue; }
    if (cur) res[cur].push(line);
  }
  return res;
}

// Transforme la sortie brute en mesures ; `prev` (mesure précédente) sert aux taux.
function parse(out, prev, now = Date.now()) {
  const s = sections(out);
  if (!('end' in s)) throw new Error('Sortie de mesure incomplète');
  const first = (k) => ((s[k] || []).find(l => l.trim()) || '').trim();
  const m = { at: now, ok: true };
  m.kernel = first('uname'); m.os = first('os'); m.hostname = first('host');
  if (!s.stat || !first('stat').startsWith('cpu')) { m.unsupported = 'Mesures complètes disponibles pour les serveurs Linux uniquement'; }
  const up = parseFloat(first('uptime').split(/\s+/)[0]); if (!isNaN(up)) m.uptimeSec = Math.round(up);
  const ld = first('load').split(/\s+/).map(Number); if (ld.length >= 3 && !isNaN(ld[0])) m.load = ld.slice(0, 3);
  m.cpus = parseInt(first('cpus'), 10) || null;
  // CPU : différence entre deux lectures de /proc/stat
  const st = first('stat').split(/\s+/).slice(1).map(Number);
  if (st.length >= 4) {
    const idle = st[3] + (st[4] || 0), total = st.reduce((a, b) => a + b, 0);
    m._cpu = { idle, total };
    if (prev && prev._cpu && total > prev._cpu.total) m.cpu = Math.max(0, Math.min(100, Math.round((1 - (idle - prev._cpu.idle) / (total - prev._cpu.total)) * 1000) / 10));
  }
  const mem = {};
  for (const l of s.mem || []) { const x = l.match(/^(\w+):\s+(\d+)/); if (x) mem[x[1]] = Number(x[2]) * 1024; }
  if (mem.MemTotal) {
    m.memTotal = mem.MemTotal; m.memUsed = mem.MemTotal - (mem.MemAvailable ?? 0);
    m.mem = Math.round(m.memUsed / m.memTotal * 1000) / 10;
    if (mem.SwapTotal) { m.swapTotal = mem.SwapTotal; m.swap = Math.round((mem.SwapTotal - mem.SwapFree) / mem.SwapTotal * 1000) / 10; }
  }
  m.disks = [];
  for (const l of s.disk || []) {
    const p = l.trim().split(/\s+/);
    if (p.length < 6) continue;
    const size = Number(p[1]) * 1024, used = Number(p[2]) * 1024;
    if (!size || /^\/(snap|boot\/efi)\b/.test(p[5])) continue;
    m.disks.push({ fs: p[0], mount: p.slice(5).join(' '), size, used, pct: Math.round(used / size * 1000) / 10 });
  }
  m.disk = m.disks.length ? Math.max(...m.disks.map(d => d.pct)) : null;
  let rx = 0, tx = 0;
  for (const l of s.net || []) {
    const [ifc, rest] = l.split(':'); if (!rest || /^\s*lo\s*$/.test(ifc)) continue;
    const f = rest.trim().split(/\s+/).map(Number); rx += f[0] || 0; tx += f[8] || 0;
  }
  m._net = { rx, tx };
  if (prev && prev._net && now > prev.at && rx >= prev._net.rx) {
    const dt = (now - prev.at) / 1000;
    m.rxRate = Math.round((rx - prev._net.rx) / dt); m.txRate = Math.round((tx - prev._net.tx) / dt);
  }
  m.services = (s.services || []).filter(l => l.trim()).map(l => { const [name, state] = l.trim().split(/\s+/); return { name, state: state || 'unknown', ok: state === 'active' }; });
  const dk = (s.docker || []).filter(l => l.trim()).map(Number);
  if (dk.length === 2) m.docker = { running: dk[0], total: dk[1] };
  return m;
}

// Règles d'alerte → liste { key, level, msg }
function alerts(m, t = {}) {
  const th = { disk: 90, mem: 90, loadPerCpu: 2, ...t };
  const out = [];
  if (!m.ok) return [{ key: 'down', level: 'crit', msg: 'Injoignable : ' + (m.error || '?') }];
  for (const d of m.disks || []) if (d.pct >= th.disk) out.push({ key: 'disk:' + d.mount, level: d.pct >= 97 ? 'crit' : 'warn', msg: `Disque ${d.mount} plein à ${d.pct} %` });
  if (m.mem >= th.mem) out.push({ key: 'mem', level: 'warn', msg: `Mémoire utilisée à ${m.mem} %` });
  if (m.load && m.cpus && m.load[1] >= m.cpus * th.loadPerCpu) out.push({ key: 'load', level: 'warn', msg: `Charge ${m.load[1]} (${m.cpus} cœurs)` });
  for (const s of m.services || []) if (!s.ok) out.push({ key: 'svc:' + s.name, level: 'crit', msg: `Service ${s.name} : ${s.state}` });
  return out;
}

class Monitor {
  constructor({ manager, getHosts, getSettings = () => ({}), emit = () => {}, notify = () => {}, now = Date.now }) {
    Object.assign(this, { manager, getHosts, getSettings, emit, notify, now });
    this.state = new Map();   // hostId -> { conn, last, history[], alerts: Map, busy, timer }
    this.timer = null;
  }
  intervalMs() { return Math.max(15, Number(this.getSettings().monitorInterval) || 60) * 1000; }
  start() { this.stop(); this.tick(); this.timer = setInterval(() => this.tick(), this.intervalMs()); }
  stop() { clearInterval(this.timer); this.timer = null; for (const st of this.state.values()) this.dropConn(st); this.state.clear(); }
  restart() { if (this.timer) this.start(); }
  watched() { return (this.getHosts() || []).filter(h => h.monitor); }

  snapshot() {
    const out = {};
    for (const [id, st] of this.state) out[id] = { last: pub(st.last), history: st.history.map(h => ({ at: h.at, cpu: h.cpu, mem: h.mem, disk: h.disk, ok: h.ok })), alerts: [...st.alerts.values()] };
    return out;
  }

  async tick() {
    const hosts = this.watched();
    const ids = new Set(hosts.map(h => h.id));
    for (const [id, st] of this.state) if (!ids.has(id)) { this.dropConn(st); this.state.delete(id); }
    await Promise.all(hosts.map(h => this.measure(h).catch(() => {})));
  }

  dropConn(st) { if (st && st.conn) { try { st.conn.end(); } catch { /* ignore */ } st.conn = null; } }

  async measure(host) {
    let st = this.state.get(host.id);
    if (!st) { st = { history: [], alerts: new Map(), last: null }; this.state.set(host.id, st); }
    if (st.busy) return;
    st.busy = true;
    const services = String(host.monitorServices || '').split(/[\s,;]+/).filter(Boolean);
    let m;
    try {
      if (!st.conn) {
        st.conn = await this.manager.connect(host.id, [], { background: true });
        st.conn.on('close', () => { st.conn = null; });
        st.conn.on('error', () => { st.conn = null; });
      }
      const out = await execOnce(st.conn, probeScript(services), 20000);
      m = parse(out, st.last && st.last.ok ? st.last : null, this.now());
    } catch (e) {
      this.dropConn(st);
      m = { at: this.now(), ok: false, error: e.message };
    } finally { st.busy = false; }
    st.last = m;
    st.history.push({ at: m.at, cpu: m.cpu ?? null, mem: m.mem ?? null, disk: m.disk ?? null, ok: m.ok });
    while (st.history.length > 120) st.history.shift();
    this.updateAlerts(host, st, alerts(m, this.getSettings().monitorThresholds));
    this.emit('monitor:update', { hostId: host.id, last: pub(m), history: st.history.slice(-1)[0], alerts: [...st.alerts.values()] });
    return m;
  }

  // Notifie seulement les changements (nouvelle alerte, alerte levée).
  updateAlerts(host, st, list) {
    const now = new Map(list.map(a => [a.key, a]));
    for (const [k, a] of now) if (!st.alerts.has(k)) { st.alerts.set(k, { ...a, since: this.now() }); this.notify({ host: host.label, hostId: host.id, ...a, state: 'new' }); }
    for (const [k, a] of [...st.alerts]) if (!now.has(k)) { st.alerts.delete(k); this.notify({ host: host.label, hostId: host.id, ...a, state: 'resolved' }); }
  }
}

function pub(m) { if (!m) return null; const { _cpu, _net, ...rest } = m; return rest; }

function execOnce(conn, cmd, timeoutMs) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('Pas de réponse du serveur')), timeoutMs);
    conn.exec(cmd, (err, ch) => {
      if (err) { clearTimeout(t); return reject(err); }
      let out = '';
      ch.on('data', d => { out += d; if (out.length > 2e6) ch.close(); });
      ch.stderr.on('data', () => {});
      ch.on('close', () => { clearTimeout(t); resolve(out); });
    });
  });
}

module.exports = { Monitor, probeScript, parse, alerts, safeService };

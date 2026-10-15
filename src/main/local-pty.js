'use strict';
// Terminaux locaux (PowerShell, cmd, WSL, Git Bash, bash/zsh…) via ConPTY / forkpty.
// Les sessions survivent à la fermeture de leur panneau quand on les "détache" (comme tmux),
// tant que l'application tourne ; un tampon de sortie permet de les rattacher.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

let pty = null;
function loadPty() {
  if (!pty) pty = require('@lydell/node-pty');
  return pty;
}

const BUFFER_MAX = 400 * 1024; // caractères conservés pour le rattachement

function exists(p) { try { return fs.statSync(p).isFile(); } catch { return false; } }
function which(cmd) {
  const dirs = (process.env.PATH || '').split(path.delimiter);
  const exts = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : [''];
  for (const d of dirs) for (const e of exts) { const f = path.join(d, cmd + e); if (exists(f)) return f; }
  return null;
}

function detectShells() {
  const out = [];
  if (process.platform === 'win32') {
    const sys = process.env.SystemRoot || 'C:\\Windows';
    const pf = process.env.ProgramFiles || 'C:\\Program Files';
    const pwsh = which('pwsh') || [path.join(pf, 'PowerShell', '7', 'pwsh.exe'), path.join(pf, 'PowerShell', '7-preview', 'pwsh.exe')].find(exists);
    if (pwsh) out.push({ id: 'pwsh', name: 'PowerShell 7', icon: '⚡', file: pwsh, args: ['-NoLogo'] });
    const ps = path.join(sys, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    if (exists(ps)) out.push({ id: 'powershell', name: 'Windows PowerShell', icon: '🔷', file: ps, args: ['-NoLogo'] });
    const cmd = process.env.ComSpec || path.join(sys, 'System32', 'cmd.exe');
    if (exists(cmd)) out.push({ id: 'cmd', name: 'Invite de commandes', icon: '▪', file: cmd, args: [] });
    const gitBash = [path.join(pf, 'Git', 'bin', 'bash.exe'), path.join(process.env['ProgramFiles(x86)'] || '', 'Git', 'bin', 'bash.exe'),
      path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Git', 'bin', 'bash.exe')].find(exists);
    if (gitBash) out.push({ id: 'gitbash', name: 'Git Bash', icon: '🐙', file: gitBash, args: ['--login', '-i'] });
    const wsl = path.join(sys, 'System32', 'wsl.exe');
    if (exists(wsl)) {
      let distros = [];
      try {
        const raw = execFileSync(wsl, ['-l', '-q'], { timeout: 4000, windowsHide: true });
        distros = raw.toString('utf16le').replace(/\0/g, '').split(/\r?\n/).map(s => s.trim()).filter(Boolean);
      } catch { /* WSL non configuré */ }
      for (const d of distros) out.push({ id: 'wsl:' + d, name: `WSL · ${d}`, icon: '🐧', file: wsl, args: ['-d', d, '--cd', '~'] });
    }
  } else {
    const seen = new Set();
    const add = (id, name, file, args = ['-l']) => { if (file && !seen.has(file)) { seen.add(file); out.push({ id, name, icon: '❯', file, args }); } };
    if (process.env.SHELL) add('default', `Shell par défaut (${path.basename(process.env.SHELL)})`, process.env.SHELL);
    add('bash', 'Bash', which('bash'));
    add('zsh', 'Zsh', which('zsh'));
    add('fish', 'Fish', which('fish'));
    add('sh', 'sh', which('sh'), []);
  }
  return out;
}

class LocalManager {
  constructor(emit) {
    this.emit = emit;
    this.sessions = new Map(); // id -> { proc, shell, buffer, attached, title, createdAt, cwd }
    this._shells = null;
  }

  shells(refresh) {
    if (!this._shells || refresh) this._shells = detectShells();
    return this._shells.map(({ id, name, icon }) => ({ id, name, icon }));
  }

  has(id) { return this.sessions.has(id); }
  get size() { return this.sessions.size; }

  spawn(id, shellId, cols, rows, cwd) {
    const shells = this._shells || detectShells();
    this._shells = shells;
    const sh = shells.find(s => s.id === shellId) || shells[0];
    if (!sh) throw new Error('Aucun shell local trouvé');
    const dir = cwd && fs.existsSync(cwd) ? cwd : os.homedir();
    const env = { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor', TERM_PROGRAM: 'KSTermus' };
    const proc = loadPty().spawn(sh.file, sh.args, {
      name: 'xterm-256color', cols: Math.max(2, cols || 80), rows: Math.max(2, rows || 24), cwd: dir, env,
      useConpty: true
    });
    const s = { proc, shell: { id: sh.id, name: sh.name, icon: sh.icon }, buffer: '', attached: true, title: sh.name, createdAt: Date.now(), cwd: dir };
    this.sessions.set(id, s);
    proc.onData(d => {
      s.buffer += d;
      if (s.buffer.length > BUFFER_MAX) s.buffer = s.buffer.slice(-BUFFER_MAX);
      if (s.attached) this.emit('term:data', { sessionId: id, data: d });
    });
    proc.onExit(({ exitCode }) => {
      if (!this.sessions.has(id)) return;
      this.sessions.delete(id);
      this.emit('term:exit', { sessionId: id, reason: `Processus terminé (code ${exitCode})`, local: true });
      this.emit('local:changed', {});
    });
    this.emit('local:changed', {});
    return { shell: s.shell, pid: proc.pid, cwd: dir };
  }

  write(id, data) { const s = this.sessions.get(id); if (s) s.proc.write(data); }
  resize(id, cols, rows) { const s = this.sessions.get(id); if (s) { try { s.proc.resize(Math.max(2, cols), Math.max(2, rows)); } catch { /* ignore */ } } }
  setTitle(id, title) { const s = this.sessions.get(id); if (s && title) s.title = String(title).slice(0, 120); }

  detach(id) {
    const s = this.sessions.get(id);
    if (!s) return false;
    s.attached = false;
    this.emit('local:changed', {});
    return true;
  }

  attach(id) {
    const s = this.sessions.get(id);
    if (!s) throw new Error('Session locale terminée');
    s.attached = true;
    this.emit('local:changed', {});
    return { buffer: s.buffer, shell: s.shell, title: s.title };
  }

  kill(id) {
    const s = this.sessions.get(id);
    if (!s) return;
    this.sessions.delete(id);
    try { s.proc.kill(); } catch { /* déjà terminé */ }
    this.emit('local:changed', {});
  }

  list() {
    return [...this.sessions.entries()].map(([id, s]) => ({ id, shell: s.shell, title: s.title, attached: s.attached, createdAt: s.createdAt, pid: s.proc.pid, cwd: s.cwd }));
  }

  killAll() { for (const id of [...this.sessions.keys()]) this.kill(id); }
}

module.exports = { LocalManager, detectShells };

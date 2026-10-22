'use strict';
// Mises à jour automatiques depuis GitHub Releases.
//
// Une release contient :
//   · KSTermus-win-x64-<version>.zip  (dossier KSTermus/ complet)
//   · update.json                     ({ version, file, size, sha256, notes, date, sig })
// `sig` est une signature Ed25519 (clé privée détenue par l'éditeur) de :
//   KSTermus-update-v1\n<version>\n<file>\n<size>\n<sha256>\n<notes>
// Le zip n'est installé que si la signature, la taille et le SHA-256 concordent :
// un compte GitHub compromis ne suffit pas à pousser du code sur les postes.
//
// Installation (Windows, application empaquetée) :
//   1. extraction du zip dans <dossier app>.new (avant de quitter : échec = rien ne change) ;
//   2. KSTermus quitte ; un script PowerShell détaché attend la fin du process,
//      renomme l'ancien dossier, met le nouveau en place (retour arrière si échec),
//      relance l'app et supprime l'ancienne version.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn, execFile } = require('child_process');

const DEFAULT_FEED = 'https://api.github.com/repos/koyaja/ksTerminalAllInOne/releases/latest';
const RELEASES_PAGE = 'https://github.com/koyaja/ksTerminalAllInOne/releases';
const PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAWcPYEMUh2qX0ac7aqPjAZU7jUe8kBMqrAUDL7RMNeWA=
-----END PUBLIC KEY-----`;

function signedPayload(m) {
  return ['KSTermus-update-v1', m.version, m.file, String(m.size), m.sha256, m.notes || ''].join('\n');
}
function signManifest(m, privateKeyPem) {
  return crypto.sign(null, Buffer.from(signedPayload(m)), privateKeyPem).toString('base64');
}
function verifyManifest(m, publicKeyPem = PUBLIC_KEY) {
  if (!m || typeof m !== 'object') throw new Error('Manifeste de mise à jour invalide');
  for (const k of ['version', 'file', 'sha256', 'sig']) if (typeof m[k] !== 'string' || !m[k]) throw new Error('Manifeste incomplet : ' + k);
  if (!/^\d+\.\d+\.\d+$/.test(m.version)) throw new Error('Version invalide dans le manifeste');
  if (!/^[\w.-]+\.zip$/.test(m.file)) throw new Error('Nom de fichier invalide dans le manifeste');
  if (!/^[a-f0-9]{64}$/.test(m.sha256)) throw new Error('SHA-256 invalide dans le manifeste');
  if (!Number.isInteger(m.size) || m.size <= 0) throw new Error('Taille invalide dans le manifeste');
  let ok = false;
  try { ok = crypto.verify(null, Buffer.from(signedPayload(m)), publicKeyPem, Buffer.from(m.sig, 'base64')); } catch { ok = false; }
  if (!ok) throw new Error('Signature de la mise à jour invalide — ignorée');
  return true;
}

function cmpVersion(a, b) {
  const pa = String(a).split('.').map(Number), pb = String(b).split('.').map(Number);
  for (let i = 0; i < 3; i++) { const d = (pa[i] || 0) - (pb[i] || 0); if (d) return Math.sign(d); }
  return 0;
}

// Script PowerShell de remplacement, lancé détaché après la fermeture de KSTermus.
const SWAP_PS1 = String.raw`
$ErrorActionPreference = 'Stop'
$log = $env:KST_UPD_LOG
function Log($m) { Add-Content -Path $log -Value ((Get-Date -Format s) + ' ' + $m) }
try {
  $appDir = $env:KST_UPD_APP; $newDir = $env:KST_UPD_NEW; $exe = $env:KST_UPD_EXE; $old = $appDir + '.old'
  Log ('attente de la fin du process ' + $env:KST_UPD_PID)
  for ($i = 0; $i -lt 120; $i++) { if (-not (Get-Process -Id ([int]$env:KST_UPD_PID) -ErrorAction SilentlyContinue)) { break }; Start-Sleep -Milliseconds 250 }
  Start-Sleep -Milliseconds 500
  if (Test-Path $old) { Remove-Item $old -Recurse -Force -ErrorAction SilentlyContinue }
  $moved = $false
  for ($i = 0; $i -lt 20 -and -not $moved; $i++) { try { Rename-Item -Path $appDir -NewName (Split-Path $old -Leaf); $moved = $true } catch { Start-Sleep -Milliseconds 500 } }
  if (-not $moved) { throw 'ancien dossier verrouillé' }
  try { Move-Item -Path $newDir -Destination $appDir }
  catch { Log ('échec, retour arrière : ' + $_); Rename-Item -Path $old -NewName (Split-Path $appDir -Leaf); throw }
  Log 'nouvelle version en place'
  if ($env:KST_UPD_RELAUNCH -eq '1') { Start-Process -FilePath $exe -WorkingDirectory $appDir }
  Start-Sleep 2
  Remove-Item $old -Recurse -Force -ErrorAction SilentlyContinue
  Log 'terminé'
} catch {
  Log ('ERREUR ' + $_)
  if ($env:KST_UPD_RELAUNCH -eq '1' -and (Test-Path $exe)) { Start-Process -FilePath $exe }
  exit 1
}
`;

const EXTRACT_PS1 = String.raw`
$ErrorActionPreference = 'Stop'
$stage = $env:KST_UPD_STAGE
if (Test-Path $stage) { Remove-Item $stage -Recurse -Force }
Add-Type -AssemblyName System.IO.Compression.FileSystem
[IO.Compression.ZipFile]::ExtractToDirectory($env:KST_UPD_ZIP, $stage)
if (-not (Test-Path (Join-Path $stage 'KSTermus\KSTermus.exe'))) { throw 'Archive inattendue : KSTermus\KSTermus.exe absent' }
Write-Output 'OK'
`;

class Updater {
  constructor(opts) {
    this.current = opts.currentVersion;
    this.feed = opts.feed || DEFAULT_FEED;
    this.fetch = opts.fetch || ((u, o) => fetch(u, o));
    this.publicKey = opts.publicKey || PUBLIC_KEY;
    this.dir = opts.dir;                      // dossier de travail (téléchargements)
    this.platform = opts.platform || process.platform;
    this.isPackaged = !!opts.isPackaged;
    this.appDir = opts.appDir;                // dossier contenant KSTermus.exe
    this.exeName = opts.exeName || 'KSTermus.exe';
    this.emit = opts.emit || (() => {});
    this.runPs = opts.runPs || runPowerShell;
    this.spawnDetached = opts.spawnDetached || spawnPowerShellDetached;
    this.state = { status: 'idle' };
    this.manifest = null;
    this.zipPath = null;
    this.stageReady = false;
  }

  get canInstall() { return this.platform === 'win32' && this.isPackaged && !!this.appDir; }

  set(patch) {
    this.state = { ...this.state, ...patch, current: this.current, canInstall: this.canInstall, releasesPage: RELEASES_PAGE };
    this.emit('update:state', this.state);
    return this.state;
  }

  async getJson(url) {
    const r = await this.fetch(url, { headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'KSTermus/' + this.current } });
    if (!r.ok) {
      if (r.status === 404) return null;
      if (r.status === 403) throw new Error('GitHub limite les requêtes — nouvel essai plus tard');
      throw new Error('Serveur de mises à jour : HTTP ' + r.status);
    }
    return r.json();
  }

  // Interroge GitHub. Résultat : 'none' | 'available' (manifeste vérifié).
  async check() {
    if (['downloading', 'extracting', 'installing'].includes(this.state.status)) return this.state;
    this.set({ status: 'checking', error: null, checkedAt: new Date().toISOString() });
    try {
      const rel = await this.getJson(this.feed);
      const assets = (rel && rel.assets) || [];
      const mAsset = assets.find(a => a.name === 'update.json');
      if (!rel || !mAsset) return this.set({ status: 'none' });
      const m = await this.getJson(mAsset.browser_download_url);
      verifyManifest(m, this.publicKey);
      if (cmpVersion(m.version, this.current) <= 0) return this.set({ status: 'none' });
      const zAsset = assets.find(a => a.name === m.file);
      if (!zAsset) throw new Error('Archive ' + m.file + ' absente de la release');
      this.manifest = { ...m, url: zAsset.browser_download_url, page: rel.html_url || RELEASES_PAGE };
      if (this.stageReady && this.state.version === m.version) return this.set({ status: 'ready' });
      return this.set({ status: 'available', downloadable: this.platform === 'win32', version: m.version, notes: m.notes || '', size: m.size, date: m.date || rel.published_at || null, page: this.manifest.page });
    } catch (e) {
      return this.set({ status: 'error', error: e.message });
    }
  }

  // Télécharge et vérifie l'archive, puis la prépare (extraction) si l'install est possible.
  async download() {
    const m = this.manifest;
    if (!m) throw new Error('Aucune mise à jour à télécharger');
    if (this.platform !== 'win32') throw new Error('Archive Windows uniquement : télécharge la version Linux depuis la page de la release');
    if (this.state.status === 'downloading' || this.state.status === 'extracting') return this.state;
    fs.mkdirSync(this.dir, { recursive: true });
    const file = path.join(this.dir, m.file);
    const part = file + '.part';
    this.set({ status: 'downloading', progress: 0, error: null });
    try {
      const r = await this.fetch(m.url, { headers: { 'User-Agent': 'KSTermus/' + this.current } });
      if (!r.ok || !r.body) throw new Error('Téléchargement : HTTP ' + r.status);
      const hash = crypto.createHash('sha256');
      const out = fs.createWriteStream(part);
      let got = 0, lastEmit = 0;
      for await (const chunk of r.body) {
        const b = Buffer.from(chunk);
        got += b.length;
        if (got > m.size) throw new Error('Archive plus grande que prévu — interrompu');
        hash.update(b);
        if (!out.write(b)) await new Promise(res => out.once('drain', res));
        const now = Date.now();
        if (now - lastEmit > 300) { lastEmit = now; this.set({ progress: got / m.size }); }
      }
      await new Promise((res, rej) => out.end(err => (err ? rej(err) : res())));
      if (got !== m.size) throw new Error('Archive incomplète');
      if (hash.digest('hex') !== m.sha256) throw new Error('SHA-256 différent : archive rejetée');
      fs.renameSync(part, file);
      this.zipPath = file;
      if (!this.canInstall) return this.set({ status: 'downloaded', progress: 1, file });
      this.set({ status: 'extracting', progress: 1 });
      await this.runPs(EXTRACT_PS1, { KST_UPD_ZIP: file, KST_UPD_STAGE: this.stageDir });
      // Le dossier extrait contient KSTermus\ : on le remonte d'un niveau → <app>.new
      const inner = path.join(this.stageDir, 'KSTermus');
      fs.rmSync(this.newDir, { recursive: true, force: true });
      fs.renameSync(inner, this.newDir);
      fs.rmSync(this.stageDir, { recursive: true, force: true });
      fs.rmSync(file, { force: true });
      this.stageReady = true;
      return this.set({ status: 'ready', progress: 1 });
    } catch (e) {
      try { fs.rmSync(part, { force: true }); } catch { /* ignore */ }
      return this.set({ status: 'error', error: e.message });
    }
  }

  get newDir() { return this.appDir + '.new'; }
  get stageDir() { return this.appDir + '.stage'; }

  // Lance le remplacement (détaché). L'appelant doit quitter l'app juste après.
  apply({ relaunch, pid = process.pid }) {
    if (!this.stageReady) throw new Error('Aucune mise à jour prête');
    if (!this.canInstall) throw new Error('Installation automatique disponible uniquement sur la version Windows installée');
    const log = path.join(this.dir, 'update.log');
    this.spawnDetached(SWAP_PS1, {
      KST_UPD_PID: String(pid), KST_UPD_APP: this.appDir, KST_UPD_NEW: this.newDir,
      KST_UPD_EXE: path.join(this.appDir, this.exeName), KST_UPD_RELAUNCH: relaunch ? '1' : '0', KST_UPD_LOG: log
    }, this.dir);
    this.stageReady = false;
    this.set({ status: 'installing' });
    return true;
  }
}

function runPowerShell(script, env) {
  return new Promise((resolve, reject) => {
    const encoded = Buffer.from(script, 'utf16le').toString('base64');
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
      { windowsHide: true, timeout: 180000, env: { ...process.env, ...env } },
      (err, stdout, stderr) => err ? reject(new Error((String(stderr).trim().split('\n')[0]) || err.message)) : resolve(String(stdout).trim()));
  });
}

function spawnPowerShellDetached(script, env, dir) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'kstermus-update.ps1');
  fs.writeFileSync(file, '﻿' + script, 'utf8'); // BOM : accents corrects sous PowerShell 5.1
  const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', file],
    { detached: true, stdio: 'ignore', windowsHide: true, env: { ...process.env, ...env } });
  child.unref();
}

module.exports = { Updater, signManifest, verifyManifest, cmpVersion, signedPayload, DEFAULT_FEED, PUBLIC_KEY, SWAP_PS1, EXTRACT_PS1 };

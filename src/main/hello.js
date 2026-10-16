'use strict';
// Windows Hello (visage, empreinte ou code PIN) via l'API WinRT
// Windows.Security.Credentials.UI.UserConsentVerifier, appelée depuis
// Windows PowerShell 5.1 (pwsh 7 ne charge plus les types WinRT).
//
// Deux usages :
//  · déverrouiller l'écran (le coffre reste déchiffré en mémoire) : Hello
//    sert uniquement de preuve de présence, rien n'est stocké ;
//  · déverrouiller au démarrage (option) : la clé du coffre est conservée
//    dans hello.kst, chiffrée par DPAPI (safeStorage) — lisible seulement
//    par ta session Windows — et n'est libérée qu'après une vérification Hello.

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const PS_PRELUDE = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$asTask = [System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
  $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation` + '`' + String.raw`1' } | Select-Object -First 1
function Start-Op($op, [Type]$t) { $asTask.MakeGenericMethod($t).Invoke($null, @($op)) }
$V = [Windows.Security.Credentials.UI.UserConsentVerifier, Windows.Security.Credentials.UI, ContentType=WindowsRuntime]
$A = [Windows.Security.Credentials.UI.UserConsentVerifierAvailability, Windows.Security.Credentials.UI, ContentType=WindowsRuntime]
$R = [Windows.Security.Credentials.UI.UserConsentVerificationResult, Windows.Security.Credentials.UI, ContentType=WindowsRuntime]
`;

const PS_CHECK = PS_PRELUDE + String.raw`
$t = Start-Op ($V::CheckAvailabilityAsync()) $A
[void]$t.Wait(15000)
Write-Output ([string]$t.Result)
`;

// La fenêtre Hello s'ouvre parfois derrière KSTermus : on tente de la ramener
// au premier plan (titre localisé) pendant les premières secondes.
const PS_VERIFY = PS_PRELUDE + String.raw`
$t = Start-Op ($V::RequestVerificationAsync($env:KST_HELLO_MSG)) $R
$sh = New-Object -ComObject WScript.Shell
for ($i = 0; $i -lt 25 -and -not $t.IsCompleted; $i++) {
  Start-Sleep -Milliseconds 200
  foreach ($title in @('Sécurité Windows', 'Windows Security')) { try { if ($sh.AppActivate($title)) { $i = 99; break } } catch {} }
}
[void]$t.Wait(120000)
Write-Output ([string]$t.Result)
`;

function defaultRunner(script, env) {
  return new Promise((resolve, reject) => {
    const encoded = Buffer.from(script, 'utf16le').toString('base64');
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
      { windowsHide: true, timeout: 130000, env: { ...process.env, ...env } },
      (err, stdout, stderr) => {
        if (err) return reject(new Error((stderr || err.message || '').toString().trim().split('\n')[0] || 'PowerShell a échoué'));
        resolve(String(stdout).trim().split(/\r?\n/).pop() || '');
      });
  });
}

const RESULT_MSG = {
  DeviceNotPresent: 'Aucun capteur Windows Hello',
  NotConfiguredForUser: 'Windows Hello n\'est pas configuré (Paramètres › Comptes › Options de connexion)',
  DisabledByPolicy: 'Windows Hello est désactivé par une stratégie',
  DeviceBusy: 'Le capteur Windows Hello est occupé',
  RetriesExhausted: 'Trop d\'essais Windows Hello',
  Canceled: 'Vérification Windows Hello annulée'
};

class Hello {
  constructor({ dir, platform = process.platform, runner = defaultRunner, safeStorage = null }) {
    this.file = path.join(dir, 'hello.kst');
    this.platform = platform;
    this.runner = runner;
    this.safeStorage = safeStorage;
    this._avail = null;
  }

  async available() {
    if (this.platform !== 'win32') return { ok: false, reason: 'Windows uniquement' };
    if (!this._avail) {
      this._avail = this.runner(PS_CHECK, {}).then(r => (r === 'Available' ? { ok: true } : { ok: false, reason: RESULT_MSG[r] || r || 'Indisponible' }))
        .catch(err => { this._avail = null; return { ok: false, reason: err.message }; });
    }
    return this._avail;
  }

  // Résout si l'utilisateur est vérifié, sinon lève une erreur lisible.
  async verify(message = 'Déverrouiller KSTermus') {
    const a = await this.available();
    if (!a.ok) throw new Error(a.reason);
    const r = await this.runner(PS_VERIFY, { KST_HELLO_MSG: message });
    if (r !== 'Verified') throw new Error(RESULT_MSG[r] || ('Windows Hello : ' + (r || 'échec')));
    return true;
  }

  // ----- Clé du coffre pour le déverrouillage au démarrage -----
  hasStartupKey() { return fs.existsSync(this.file); }

  storeStartupKey(key, salt) {
    if (!this.safeStorage || !this.safeStorage.isEncryptionAvailable()) throw new Error('Chiffrement Windows (DPAPI) indisponible');
    const blob = this.safeStorage.encryptString(Buffer.from(key).toString('base64'));
    const out = { v: 1, salt: Buffer.from(salt).toString('base64'), blob: blob.toString('base64') };
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(out), { mode: 0o600 });
  }

  readStartupKey() {
    if (!this.safeStorage) throw new Error('Chiffrement Windows (DPAPI) indisponible');
    const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    return { key: Buffer.from(this.safeStorage.decryptString(Buffer.from(raw.blob, 'base64')), 'base64'), salt: Buffer.from(raw.salt, 'base64') };
  }

  clearStartupKey() { try { fs.unlinkSync(this.file); } catch { /* absent */ } }
}

module.exports = { Hello, PS_CHECK, PS_VERIFY };

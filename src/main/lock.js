'use strict';
// Verrouillage d'écran : l'interface est masquée et le renderer ne peut plus
// rien demander au process principal (hors canaux de déverrouillage), mais les
// sessions SSH, terminaux locaux et tunnels continuent de tourner.

const ALLOWED_WHEN_LOCKED = new Set([
  'vault:status', 'vault:unlock', 'vault:create', 'vault:unlockScreen', 'vault:lock',
  'hello:status', 'hello:unlock', 'window:control', 'window:info', 'lock:screen'
]);

class LockController {
  constructor({ now = Date.now, onLock = () => {} } = {}) {
    this.now = now;
    this.onLock = onLock;
    this.locked = false;
    this.minutes = 0;
    this.last = now();
    this.failures = 0;
    this.blockedUntil = 0;
  }

  configure({ minutes }) {
    this.minutes = Math.max(0, Number(minutes) || 0);
    this.last = this.now();
  }

  activity() { if (!this.locked) this.last = this.now(); }

  // Appelé périodiquement ; verrouille après `minutes` sans activité.
  tick() {
    if (this.locked || !this.minutes) return false;
    if (this.now() - this.last >= this.minutes * 60000) { this.lock('inactivité'); return true; }
    return false;
  }

  lock(reason = 'manuel') {
    if (this.locked) return false;
    this.locked = true;
    this.onLock(reason);
    return true;
  }

  unlock() {
    this.locked = false;
    this.failures = 0;
    this.blockedUntil = 0;
    this.last = this.now();
  }

  // Vrai si le canal IPC est utilisable dans l'état courant.
  allowed(channel) { return !this.locked || ALLOWED_WHEN_LOCKED.has(channel); }

  // Anti force brute : délai croissant après 3 échecs (2, 4, 8 … 60 s).
  checkThrottle() {
    const wait = this.blockedUntil - this.now();
    if (wait > 0) throw new Error(`Trop d'essais — réessaie dans ${Math.ceil(wait / 1000)} s`);
  }
  fail() {
    this.failures++;
    if (this.failures >= 3) this.blockedUntil = this.now() + Math.min(60000, 1000 * 2 ** (this.failures - 2));
  }
}

module.exports = { LockController, ALLOWED_WHEN_LOCKED };

'use strict';
const crypto = require('crypto');
const { utils: sshUtils } = require('ssh2');

// Valide une clé privée (avec passphrase éventuelle) et calcule sa clé publique + empreinte.
function parsePrivateKey(text, passphrase) {
  const parsed = sshUtils.parseKey(text, passphrase || undefined);
  const key = Array.isArray(parsed) ? parsed[0] : parsed;
  if (key instanceof Error) {
    if (/passphrase|encrypted|decrypt/i.test(key.message)) throw new Error('Passphrase manquante ou incorrecte');
    throw new Error('Clé privée invalide : ' + key.message);
  }
  if (!key.isPrivateKey()) throw new Error('Ceci est une clé publique, pas une clé privée');
  const pub = key.getPublicSSH();
  const fp = 'SHA256:' + crypto.createHash('sha256').update(pub).digest('base64').replace(/=+$/, '');
  return { type: key.type, publicKey: `${key.type} ${pub.toString('base64')}`, fingerprint: fp };
}

module.exports = { parsePrivateKey };

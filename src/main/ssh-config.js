'use strict';
// Lecture minimale d'un fichier ~/.ssh/config (Host, HostName, User, Port, IdentityFile).
function parseSshConfig(text) {
  const out = [];
  let cur = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*/, '').trim();
    if (!line) continue;
    const m = line.match(/^(\S+)\s*=?\s*(.+)$/);
    if (!m) continue;
    const k = m[1].toLowerCase();
    const v = m[2].trim().replace(/^"(.*)"$/, '$1');
    if (k === 'host') {
      cur = null;
      const alias = v.split(/\s+/)[0];
      if (/[*?!]/.test(alias)) continue; // motifs génériques ignorés
      cur = { alias, hostname: alias, port: 22, username: '', identityFile: '' };
      out.push(cur);
    } else if (k === 'match') {
      cur = null;
    } else if (cur) {
      if (k === 'hostname') cur.hostname = v;
      else if (k === 'user') cur.username = v;
      else if (k === 'port') cur.port = Number(v) || 22;
      else if (k === 'identityfile' && !cur.identityFile) cur.identityFile = v;
    }
  }
  return out;
}
module.exports = { parseSshConfig };

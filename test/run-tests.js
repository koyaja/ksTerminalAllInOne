'use strict';
// Tests d'intégration : nécessitent un sshd de test (voir README, section Tests).
// Variables : KST_HOST (127.0.0.1), KST_PORT (2222), KST_USER, KST_PASS, KST_AUTH_KEYS (chemin authorized_keys du user).
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const http = require('http');
const { utils } = require('ssh2');
const { Vault } = require('../src/main/vault');
const { SshManager } = require('../src/main/ssh-manager');
const { parseSshConfig } = require('../src/main/ssh-config');
const { parsePrivateKey } = require('../src/main/keys');

const H = process.env.KST_HOST || '127.0.0.1';
const P = Number(process.env.KST_PORT || 2222);
const U = process.env.KST_USER || 'kst';
const PW = process.env.KST_PASS || 'Test-Pass-2026';
const AUTH_KEYS = process.env.KST_AUTH_KEYS;

let pass = 0, failN = 0;
async function test(name, fn) {
  try { await fn(); pass++; console.log('  ✓', name); }
  catch (e) { failN++; console.log('  ✗', name, '\n     ', e && e.stack ? e.stack.split('\n').slice(0, 3).join('\n      ') : e); }
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kst-'));
  const vault = new Vault(dir);
  const events = [];
  let hostKeyAnswer = true, asked = 0;
  const mgr = new SshManager({
    vault,
    emit: (c, p) => events.push([c, p]),
    askHostKey: async () => { asked++; return hostKeyAnswer; }
  });

  console.log('Coffre');
  await test('création + mot de passe trop court refusé', () => {
    assert.throws(() => vault.create('court'), /8 caractères/);
    vault.create('MotDePasse-Maitre!');
    assert.ok(vault.exists() && vault.isUnlocked());
  });
  await test('contenu illisible sur disque (chiffré)', () => {
    vault.data.hosts.push({ id: 'h1', label: 'test', hostname: H, port: P, username: U, auth: 'password', password: PW });
    vault.save();
    const raw = fs.readFileSync(vault.file, 'utf8');
    assert.ok(!raw.includes(PW) && !raw.includes(H));
  });
  await test('mauvais mot de passe refusé, bon mot de passe OK', () => {
    vault.lock();
    assert.throws(() => vault.unlock('faux-mot-de-passe'), /incorrect/);
    vault.unlock('MotDePasse-Maitre!');
    assert.strictEqual(vault.data.hosts[0].password, PW);
  });
  await test('changement de mot de passe maître', () => {
    vault.changePassword('MotDePasse-Maitre!', 'Nouveau-Maitre-123');
    vault.lock();
    vault.unlock('Nouveau-Maitre-123');
    assert.strictEqual(vault.data.hosts.length, 1);
  });

  console.log('Config SSH');
  await test('parse ~/.ssh/config', () => {
    const r = parseSshConfig('Host *\n  User x\nHost prod web\n  HostName 10.0.0.5\n  User deploy\n  Port 2200\n  IdentityFile ~/.ssh/id_ed25519\nHost dev\n HostName dev.local');
    assert.deepStrictEqual(r.map(e => [e.alias, e.hostname, e.username, e.port]), [['prod', '10.0.0.5', 'deploy', 2200], ['dev', 'dev.local', '', 22]]);
    assert.strictEqual(r[0].identityFile, '~/.ssh/id_ed25519');
  });

  console.log('Clés');
  let genKey;
  await test('génération ed25519 + passphrase', () => {
    const kp = utils.generateKeyPairSync('ed25519', { comment: 'test', passphrase: 'pp-secret', cipher: 'aes256-ctr' });
    assert.throws(() => parsePrivateKey(kp.private, 'mauvaise'), /Passphrase/);
    const info = parsePrivateKey(kp.private, 'pp-secret');
    assert.strictEqual(info.type, 'ssh-ed25519');
    assert.ok(info.fingerprint.startsWith('SHA256:'));
    genKey = { kp, info };
  });
  await test('clé publique refusée comme clé privée', () => {
    assert.throws(() => parsePrivateKey(genKey.kp.public), /publique|invalide/);
  });

  console.log('SSH');
  await test('clé d\'hôte inconnue refusée → connexion refusée', async () => {
    hostKeyAnswer = false;
    await assert.rejects(mgr.connect('h1'), /refusée/);
    assert.strictEqual(Object.keys(vault.data.knownHosts).length, 0);
  });
  await test('TOFU : acceptée puis mémorisée (plus de question)', async () => {
    hostKeyAnswer = true; asked = 0;
    (await mgr.connect('h1')).end();
    (await mgr.connect('h1')).end();
    assert.strictEqual(asked, 1);
    assert.ok(vault.data.knownHosts[`${H}:${P}`].fingerprint.startsWith('SHA256:'));
  });
  await test('empreinte modifiée → alerte avec ancienne empreinte', async () => {
    const real = vault.data.knownHosts[`${H}:${P}`];
    vault.data.knownHosts[`${H}:${P}`] = { ...real, fingerprint: 'SHA256:faux' };
    let seen = null;
    mgr.bridge.askHostKey = async (info) => { seen = info; return false; };
    await assert.rejects(mgr.connect('h1'));
    assert.strictEqual(seen.previous.fingerprint, 'SHA256:faux');
    vault.data.knownHosts[`${H}:${P}`] = real;
    mgr.bridge.askHostKey = async () => true;
  });
  await test('mauvais mot de passe → message clair', async () => {
    vault.data.hosts.push({ id: 'bad', label: 'bad', hostname: H, port: P, username: U, auth: 'password', password: 'nope' });
    await assert.rejects(mgr.connect('bad'), /Authentification refusée/);
  });
  await test('shell : commande exécutée et sortie reçue', async () => {
    events.length = 0;
    await mgr.openShell('s1', 'h1', 120, 30);
    mgr.write('s1', 'echo KST_$((40+2))\n');
    for (let i = 0; i < 40 && !events.some(e => e[0] === 'term:data' && e[1].data.includes('KST_42')); i++) await sleep(100);
    assert.ok(events.some(e => e[0] === 'term:data' && e[1].data.includes('KST_42')), 'sortie attendue');
    mgr.resize('s1', 100, 40);
    mgr.write('s1', 'exit\n');
    for (let i = 0; i < 30 && !events.some(e => e[0] === 'term:exit'); i++) await sleep(100);
    assert.ok(events.some(e => e[0] === 'term:exit'));
  });

  if (AUTH_KEYS) {
    await test('authentification par clé du keychain (avec passphrase)', async () => {
      fs.appendFileSync(AUTH_KEYS, genKey.kp.public + '\n');
      vault.data.keys.push({ id: 'k1', label: 'k', privateKey: genKey.kp.private, passphrase: 'pp-secret', ...genKey.info });
      vault.data.hosts.push({ id: 'hk', label: 'cle', hostname: H, port: P, username: U, auth: 'key', keyId: 'k1', password: '' });
      (await mgr.connect('hk')).end();
    });
  }

  console.log('SFTP');
  await test('liste, envoi, téléchargement, renommage, suppression récursive', async () => {
    const { home } = await mgr.openSftp('f1', 'h1');
    const local = path.join(dir, 'up.bin');
    const payload = Buffer.alloc(300 * 1024, 7);
    fs.writeFileSync(local, payload);
    await mgr.sftpOp('f1', 'mkdir', home + '/kst-test');
    await mgr.sftpTransfer('f1', 'upload', home + '/kst-test/up.bin', local, 't1');
    const list = await mgr.sftpList('f1', home + '/kst-test');
    assert.ok(list.some(e => e.name === 'up.bin' && e.size === payload.length));
    await mgr.sftpOp('f1', 'rename', home + '/kst-test/up.bin', home + '/kst-test/renamed.bin');
    const back = path.join(dir, 'down.bin');
    await mgr.sftpTransfer('f1', 'download', home + '/kst-test/renamed.bin', back, 't2');
    assert.ok(fs.readFileSync(back).equals(payload));
    assert.ok(events.some(e => e[0] === 'sftp:progress'));
    await mgr.sftpDelete('f1', home + '/kst-test', true);
    const after = await mgr.sftpList('f1', home);
    assert.ok(!after.some(e => e.name === 'kst-test'));
    mgr.close('f1');
  });

  console.log('Éditeur distant');
  const { installEditor, historyKey } = require('../src/main/remote-editor');
  installEditor(SshManager);
  const SUDO_FILE = process.env.KST_SUDO_FILE || '/etc/kst-test/site.conf';
  await test('lecture / écriture SFTP + fins de ligne CRLF conservées', async () => {
    const { home } = await mgr.openEditorSession('e1', 'h1');
    const p = home + '/edit-test.txt';
    await mgr.sftpOp('e1', 'unlink', p).catch(() => {});
    let r = await mgr.editorRead('e1', 'h1', p, { create: true });
    assert.strictEqual(r.exists, false);
    await mgr.editorWrite('e1', 'h1', p, 'ligne1\nligne2\n', { eol: 'crlf' });
    r = await mgr.editorRead('e1', 'h1', p);
    assert.strictEqual(r.content, 'ligne1\nligne2\n');
    assert.strictEqual(r.eol, 'crlf');
    assert.strictEqual(r.size, 16);
  });
  await test('conflit détecté si le fichier change sur le serveur', async () => {
    const p = (await mgr.editorSession('e1', 'h1')).home + '/edit-test.txt';
    const r = await mgr.editorRead('e1', 'h1', p);
    await mgr.editorWrite('e1', 'h1', p, 'modifié ailleurs\n', { force: true });
    await assert.rejects(mgr.editorWrite('e1', 'h1', p, 'ma version\n', { expectedHash: r.hash }), e => e.code === 'CONFLICT');
    await mgr.editorWrite('e1', 'h1', p, 'ma version\n', { expectedHash: r.hash, force: true });
    assert.strictEqual((await mgr.editorRead('e1', 'h1', p)).content, 'ma version\n');
  });
  await test('fichier root sans sudo → permission refusée', async () => {
    await assert.rejects(mgr.editorRead('e1', 'h1', SUDO_FILE), e => e.code === 'PERMISSION' || /Permission|denied/i.test(e.message));
  });
  await test('sudo avec mot de passe : lecture, écriture, droits et propriétaire conservés', async () => {
    mgr.close('e1');
    const r = await mgr.editorRead('e2', 'h1', SUDO_FILE, { sudo: true });
    assert.ok(r.content.includes('listen 80;'));
    assert.strictEqual(r.eol, 'crlf');
    assert.strictEqual(r.mode, '640');
    await mgr.editorWrite('e2', 'h1', SUDO_FILE, r.content.replace('80', '8080'), { sudo: true, eol: r.eol, expectedHash: r.hash });
    const r2 = await mgr.editorRead('e2', 'h1', SUDO_FILE, { sudo: true });
    assert.ok(r2.content.includes('listen 8080;'));
    assert.strictEqual(r2.mode, '640');
    const st = fs.statSync(SUDO_FILE);
    assert.strictEqual(st.uid, 0, 'toujours root');
    assert.ok(!fs.readFileSync(SUDO_FILE, 'utf8').includes(PW), 'le mot de passe ne doit jamais finir dans le fichier');
    // la sudo est en cache côté serveur : -k force tout de même la lecture du mot de passe, pas d'injection dans le fichier
    await mgr.editorWrite('e2', 'h1', SUDO_FILE, r.content, { sudo: true, eol: r.eol });
    assert.ok(!fs.readFileSync(SUDO_FILE, 'utf8').includes(PW));
    mgr.close('e2');
  });
  await test('dossier ouvert dans l\'éditeur (sudo et SFTP) → IS_DIR + liste des fichiers', async () => {
    const dir = path.dirname(SUDO_FILE);
    await assert.rejects(mgr.editorRead('e6', 'h1', dir + '/', { sudo: true }), e => e.code === 'IS_DIR' && !/\d{3}/.test(e.message.replace(dir, '')));
    const list = await mgr.editorListDir('e6', 'h1', dir, { sudo: true });
    assert.ok(list.some(x => x.name === path.basename(SUDO_FILE) && !x.isDir));
    await assert.rejects(mgr.editorListDir('e6', 'h1', dir, {}), e => e.code === 'PERMISSION');
    const home = (await mgr.editorSession('e6', 'h1')).home;
    await assert.rejects(mgr.editorRead('e6', 'h1', home), e => e.code === 'IS_DIR');
    await assert.rejects(mgr.editorWrite('e6', 'h1', dir + '/', 'x', { sudo: true }), e => e.code === 'IS_DIR');
    mgr.close('e6');
  });
  await test('sudo : mauvais mot de passe → SUDO_PASSWORD', async () => {
    await assert.rejects(mgr.editorRead('e3', 'h1', SUDO_FILE, { sudo: true, sudoPassword: 'mauvais' }), e => e.code === 'SUDO_PASSWORD');
    mgr.close('e3');
  });
  await test('sudo NOPASSWD (sans mot de passe)', async () => {
    vault.data.hosts.push({ id: 'np', label: 'np', hostname: H, port: P, username: 'kstnp', auth: 'password', password: 'Np-Pass-2026' });
    const r = await mgr.editorRead('e4', 'np', SUDO_FILE, { sudo: true, sudoPassword: 'ignoré' });
    assert.ok(r.content.includes('listen'));
    assert.strictEqual(mgr.sessions.get('e4').sudoMode, 'nopasswd');
    mgr.close('e4');
  });
  await test('fichier binaire refusé', async () => {
    await assert.rejects(mgr.editorRead('e5', 'h1', '/bin/true'), e => e.code === 'BINARY');
    mgr.close('e5');
  });
  await test('historique chiffré + re-chiffrement au changement de mot de passe', () => {
    const key = historyKey('h1', '/etc/x.conf');
    vault.writeHistory(key, [{ id: '1', at: new Date().toISOString(), kind: 'enregistrement', content: 'secret-content-42' }]);
    assert.ok(!fs.readFileSync(vault.historyFile(key), 'utf8').includes('secret-content-42'));
    vault.changePassword('Nouveau-Maitre-123', 'Encore-Un-Autre-456');
    vault.lock(); vault.unlock('Encore-Un-Autre-456');
    assert.strictEqual(vault.readHistory(key)[0].content, 'secret-content-42');
  });

  console.log('Tunnels');
  const srv = http.createServer((req, res) => res.end('pong-' + req.url)).listen(0, '127.0.0.1');
  await new Promise(r => srv.once('listening', r));
  const target = srv.address().port;
  const get = (port) => new Promise((res, rej) => http.get({ host: '127.0.0.1', port, path: '/x' }, r => { let b = ''; r.on('data', d => b += d); r.on('end', () => res(b)); }).on('error', rej));
  const freePort = () => new Promise(r => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });

  await test('tunnel local -L', async () => {
    const bp = await freePort();
    vault.data.forwards.push({ id: 'fl', type: 'L', hostId: 'h1', bindHost: '127.0.0.1', bindPort: bp, destHost: '127.0.0.1', destPort: target });
    await mgr.startTunnel('fl');
    assert.strictEqual(await get(bp), 'pong-/x');
    assert.ok(mgr.tunnelStatus().fl.active);
    mgr.stopTunnel('fl');
    await assert.rejects(get(bp));
  });
  await test('port local déjà utilisé → erreur claire', async () => {
    vault.data.forwards.push({ id: 'fx', type: 'L', hostId: 'h1', bindHost: '127.0.0.1', bindPort: target, destHost: '127.0.0.1', destPort: 1 });
    await assert.rejects(mgr.startTunnel('fx'), /Impossible d'écouter/);
  });
  await test('tunnel distant -R', async () => {
    const rp = await freePort();
    vault.data.forwards.push({ id: 'fr', type: 'R', hostId: 'h1', bindHost: '127.0.0.1', bindPort: rp, destHost: '127.0.0.1', destPort: target });
    await mgr.startTunnel('fr');
    // le serveur sshd est local : son port distant est joignable directement
    assert.strictEqual(await get(rp), 'pong-/x');
    mgr.stopTunnel('fr');
  });
  await test('proxy SOCKS5 -D', async () => {
    const sp = await freePort();
    vault.data.forwards.push({ id: 'fd', type: 'D', hostId: 'h1', bindHost: '127.0.0.1', bindPort: sp });
    await mgr.startTunnel('fd');
    const body = await new Promise((res, rej) => {
      const s = net.connect(sp, '127.0.0.1');
      let stage = 0, buf = '';
      s.on('error', rej);
      s.on('connect', () => s.write(Buffer.from([5, 1, 0])));
      s.on('data', d => {
        if (stage === 0) { stage = 1; const hostB = Buffer.from('localhost'); const req = Buffer.concat([Buffer.from([5, 1, 0, 3, hostB.length]), hostB, Buffer.from([target >> 8, target & 255])]); s.write(req); }
        else if (stage === 1) { assert.strictEqual(d[1], 0); stage = 2; s.write('GET /socks HTTP/1.0\r\nHost: x\r\n\r\n'); }
        else buf += d;
      });
      s.on('end', () => res(buf));
    });
    assert.ok(body.endsWith('pong-/socks'));
    mgr.stopTunnel('fd');
  });

  console.log('Terminaux locaux');
  const { LocalManager } = require('../src/main/local-pty');
  await test('shell local : spawn, sortie, détacher (tampon), rattacher, terminer', async () => {
    const evs = [];
    const lm = new LocalManager((c, p) => evs.push([c, p]));
    const shells = lm.shells();
    assert.ok(shells.length > 0, 'au moins un shell détecté');
    lm.spawn('L1', shells[0].id, 100, 30);
    lm.write('L1', 'echo KST-LOCAL-$((20+22))\r');
    for (let i = 0; i < 40 && !evs.some(e => e[0] === 'term:data' && e[1].data.includes('KST-LOCAL-42')); i++) await sleep(100);
    assert.ok(evs.some(e => e[0] === 'term:data' && e[1].data.includes('KST-LOCAL-42')));
    lm.detach('L1');
    const before = evs.length;
    lm.write('L1', 'echo PENDANT-DETACHE\r');
    await sleep(600);
    assert.ok(!evs.slice(before).some(e => e[0] === 'term:data'), 'aucune donnée envoyée pendant le détachement');
    const r = lm.attach('L1');
    assert.ok(r.buffer.includes('PENDANT-DETACHE'), 'le tampon contient la sortie produite pendant le détachement');
    assert.strictEqual(lm.list()[0].attached, true);
    lm.kill('L1');
    assert.strictEqual(lm.size, 0);
  });

  mgr.closeAll();
  srv.close();
  console.log(`\n${pass} réussi(s), ${failN} échec(s)`);
  process.exit(failN ? 1 : 0);
})();

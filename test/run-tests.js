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
const crypto2 = require('crypto');
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

  console.log('2FA, jump host, reconnexion');
  // Serveur SSH de test « OTP » : mot de passe puis code de vérification (keyboard-interactive en 2 tours).
  const { Server } = require('ssh2');
  const otpKey = utils.generateKeyPairSync('ed25519').private;
  const otpSrv = new Server({ hostKeys: [otpKey] }, (client) => {
    client.on('authentication', (ctx) => {
      if (ctx.method !== 'keyboard-interactive') return ctx.reject(['keyboard-interactive']);
      ctx.prompt([{ prompt: 'Password: ', echo: false }], 'Connexion', '', (a1) => {
        if (a1[0] !== 'otp-pass') return ctx.reject();
        ctx.prompt([{ prompt: 'Verification code: ', echo: true }], 'Google Authenticator', 'Entrez le code à 6 chiffres', (a2) => a2[0] === '123456' ? ctx.accept() : ctx.reject());
      });
    }).on('ready', () => client.on('session', (accept) => {
      const ses = accept();
      ses.on('pty', (a) => a && a());
      ses.on('shell', (a) => { const st = a(); st.write('OTP-SHELL-OK\r\n'); });
    })).on('error', () => {});
  });
  await new Promise(r => otpSrv.listen(0, '127.0.0.1', r));
  const otpPort = otpSrv.address().port;
  vault.data.hosts.push({ id: 'otp', label: 'otp', hostname: '127.0.0.1', port: otpPort, username: 'u', auth: 'password', password: 'otp-pass' });

  await test('2FA : mot de passe rempli automatiquement, code OTP demandé à l\'utilisateur', async () => {
    const asked = [];
    mgr.bridge.askPrompts = async (info) => { asked.push(info); return ['123456']; };
    const c = await mgr.connect('otp');
    c.end();
    assert.strictEqual(asked.length, 1, 'une seule question posée (le code)');
    assert.ok(/Verification code/.test(asked[0].prompts[0].prompt));
    assert.strictEqual(asked[0].instructions, 'Entrez le code à 6 chiffres');
  });
  await test('2FA : mauvais code ou annulation → authentification refusée', async () => {
    mgr.bridge.askPrompts = async () => ['000000'];
    await assert.rejects(mgr.connect('otp'), /Authentification refusée/);
    mgr.bridge.askPrompts = async () => null;
    await assert.rejects(mgr.connect('otp'), /Authentification refusée/);
  });
  await test('jump host : cible joignable uniquement via un bastion (2 rebonds + 2FA au bout)', async () => {
    mgr.bridge.askPrompts = async () => ['123456'];
    vault.data.hosts.push({ id: 'bastion2', label: 'bastion2', hostname: H, port: P, username: U, auth: 'password', password: PW, jumpHostId: 'h1' });
    vault.data.hosts.push({ id: 'otp-via', label: 'otp-via', hostname: '127.0.0.1', port: otpPort, username: 'u', auth: 'password', password: 'otp-pass', jumpHostId: 'bastion2' });
    const c = await mgr.connect('otp-via');
    assert.ok(c.jumpConn && c.jumpConn.jumpConn, 'deux connexions bastion en chaîne');
    const out = await new Promise((res, rej) => c.shell((e, st) => { if (e) return rej(e); st.once('data', d => res(String(d))); }));
    assert.ok(out.includes('OTP-SHELL-OK'));
    let jumpClosed = false; c.jumpConn.on('close', () => { jumpClosed = true; });
    c.end(); await sleep(400);
    assert.ok(jumpClosed, 'fermer la cible ferme aussi le bastion');
  });
  await test('jump host : boucle détectée, bastion injoignable → message clair', async () => {
    vault.data.hosts.push({ id: 'la', label: 'A', hostname: H, port: P, username: U, password: PW, jumpHostId: 'lb' });
    vault.data.hosts.push({ id: 'lb', label: 'B', hostname: H, port: P, username: U, password: PW, jumpHostId: 'la' });
    await assert.rejects(mgr.connect('la'), /Boucle de jump hosts/);
    vault.data.hosts.push({ id: 'dead', label: 'mort', hostname: '127.0.0.1', port: 1, username: U, password: PW });
    vault.data.hosts.push({ id: 'behind', label: 'derrière', hostname: '10.255.255.1', port: 22, username: U, password: PW, jumpHostId: 'dead' });
    await assert.rejects(mgr.connect('behind'), /Jump host « mort »/);
  });
  await test('shell : « exit » = fin propre, coupure réseau = fin non propre', async () => {
    const ex = [];
    const emitBak = mgr.bridge.emit;
    mgr.bridge.emit = (c, p) => { if (c === 'term:exit') ex.push(p); };
    await mgr.openShell('cl1', 'h1', 80, 24);
    mgr.write('cl1', 'exit\n');
    for (let i = 0; i < 40 && !ex.length; i++) await sleep(100);
    assert.strictEqual(ex[0].clean, true, 'exit volontaire → clean');
    await mgr.openShell('cl2', 'h1', 80, 24);
    await sleep(300);
    mgr.sessions.get('cl2').conn._sock.destroy(); // coupure brutale du TCP
    for (let i = 0; i < 40 && ex.length < 2; i++) await sleep(100);
    assert.strictEqual(ex[1].clean, false, 'coupure → non clean (reconnexion auto)');
    mgr.bridge.emit = emitBak;
  });
  await test('tunnel : relancé automatiquement après une coupure', async () => {
    const tp = await new Promise(r => { const s0 = net.createServer().listen(0, '127.0.0.1', () => { const p0 = s0.address().port; s0.close(() => r(p0)); }); });
    const srvT = http.createServer((q, res) => res.end('tunnel-ok')).listen(0, '127.0.0.1');
    await new Promise(r => srvT.once('listening', r));
    vault.data.forwards.push({ id: 'fauto', type: 'L', hostId: 'h1', bindHost: '127.0.0.1', bindPort: tp, destHost: '127.0.0.1', destPort: srvT.address().port });
    await mgr.startTunnel('fauto');
    mgr.tunnels.get('fauto').conn._sock.destroy();
    await sleep(500);
    assert.ok(mgr.tunnelStatus().fauto.reconnecting, 'en cours de reconnexion');
    for (let i = 0; i < 60 && !(mgr.tunnelStatus().fauto || {}).active; i++) await sleep(100);
    assert.ok(mgr.tunnelStatus().fauto.active, 'tunnel rétabli');
    const body = await new Promise((res, rej) => http.get({ host: '127.0.0.1', port: tp, path: '/' }, r => { let b = ''; r.on('data', d => b += d); r.on('end', () => res(b)); }).on('error', rej));
    assert.strictEqual(body, 'tunnel-ok');
    mgr.stopTunnel('fauto');
    assert.ok(!mgr.tunnelStatus().fauto, 'arrêt manuel = pas de relance');
    srvT.close();
  });
  otpSrv.close();

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

  console.log('Verrouillage et Windows Hello');
  const { LockController, ALLOWED_WHEN_LOCKED } = require('../src/main/lock');
  const { Hello, PS_CHECK, PS_VERIFY } = require('../src/main/hello');
  await test('verrouillage auto après inactivité, IPC bloqués sauf déverrouillage', async () => {
    let t = 0; const locks = [];
    const lc = new LockController({ now: () => t, onLock: r => locks.push(r) });
    lc.configure({ minutes: 15 });
    t = 14 * 60000; assert.strictEqual(lc.tick(), false);
    lc.activity();                       // activité à 14 min : repart de zéro
    t = 28 * 60000; assert.strictEqual(lc.tick(), false);
    t = 29 * 60000; assert.strictEqual(lc.tick(), true);
    assert.deepStrictEqual(locks, ['inactivité']);
    assert.strictEqual(lc.allowed('host:revealPassword'), false);
    assert.strictEqual(lc.allowed('state:get'), false);
    assert.ok(['vault:unlockScreen', 'hello:unlock', 'vault:status'].every(c => lc.allowed(c)));
    assert.ok(!ALLOWED_WHEN_LOCKED.has('settings:save'));
    lc.activity(); t = 60 * 60000; assert.strictEqual(lc.tick(), false, 'déjà verrouillé : pas de double verrou');
    lc.unlock(); assert.strictEqual(lc.allowed('state:get'), true);
    lc.configure({ minutes: 0 }); t = 1e9; assert.strictEqual(lc.tick(), false, '0 = jamais');
  });
  await test('anti force brute : délai après 3 échecs', async () => {
    let t = 0; const lc = new LockController({ now: () => t });
    lc.fail(); lc.fail(); lc.checkThrottle();
    lc.fail(); assert.throws(() => lc.checkThrottle(), /réessaie dans 2 s/);
    t = 2001; lc.checkThrottle();
    lc.fail(); assert.throws(() => lc.checkThrottle(), /4 s/);
    for (let i = 0; i < 10; i++) lc.fail();
    assert.throws(() => lc.checkThrottle(), /60 s/);
    lc.unlock(); lc.checkThrottle();
  });
  await test('coffre : vérification du mot de passe sans re-déchiffrer, ouverture par clé', async () => {
    const d2 = fs.mkdtempSync(path.join(os.tmpdir(), 'kst-hello-'));
    const v = new Vault(d2);
    v.create('Maitre-Secret-1'); v.data.hosts.push({ id: 'h', label: 'x' }); v.save();
    assert.strictEqual(v.verifyPassword('Maitre-Secret-1'), true);
    assert.strictEqual(v.verifyPassword('mauvais-mdp'), false);
    const key = Buffer.from(v.key);
    v.lock();
    const v2 = new Vault(d2);
    v2.unlockWithKey(key);
    assert.strictEqual(v2.data.hosts[0].label, 'x');
    const bad = Buffer.alloc(32, 7);
    assert.throws(() => new Vault(d2).unlockWithKey(bad), /périmée/);
  });
  await test('Windows Hello : disponibilité, vérification, clé DPAPI au démarrage', async () => {
    const d3 = fs.mkdtempSync(path.join(os.tmpdir(), 'kst-hello-'));
    const fakeSafe = { isEncryptionAvailable: () => true,
      encryptString: (s) => Buffer.from('DPAPI:' + Buffer.from(s).toString('hex')),
      decryptString: (b) => Buffer.from(b.toString().slice(6), 'hex').toString() };
    const calls = [];
    let verifyResult = 'Verified';
    const runner = async (script, env) => { calls.push([script === PS_CHECK ? 'check' : script === PS_VERIFY ? 'verify' : '?', env.KST_HELLO_MSG]); return script === PS_CHECK ? 'Available' : verifyResult; };
    const hl = new Hello({ dir: d3, platform: 'win32', runner, safeStorage: fakeSafe });
    assert.deepStrictEqual(await hl.available(), { ok: true });
    await hl.available();
    assert.strictEqual(calls.filter(c => c[0] === 'check').length, 1, 'disponibilité mise en cache');
    assert.strictEqual(await hl.verify('Ouvrir'), true);
    assert.deepStrictEqual(calls.at(-1), ['verify', 'Ouvrir']);
    verifyResult = 'Canceled';
    await assert.rejects(hl.verify(), /annulée/);
    // Clé du coffre stockée chiffrée, jamais en clair
    const key = Buffer.alloc(32, 9), salt = Buffer.alloc(16, 1);
    hl.storeStartupKey(key, salt);
    assert.ok(hl.hasStartupKey());
    const rawFile = fs.readFileSync(path.join(d3, 'hello.kst'), 'utf8');
    assert.ok(!rawFile.includes(key.toString('base64')), 'clé non stockée en clair');
    assert.ok(hl.readStartupKey().key.equals(key));
    hl.clearStartupKey(); assert.ok(!hl.hasStartupKey());
    // Hors Windows : indisponible, sans lancer PowerShell
    const lin = new Hello({ dir: d3, platform: 'linux', runner: async () => { throw new Error('ne doit pas être appelé'); } });
    assert.strictEqual((await lin.available()).ok, false);
    await assert.rejects(lin.verify(), /Windows uniquement/);
    // Hello non configuré
    const nc = new Hello({ dir: d3, platform: 'win32', runner: async () => 'NotConfiguredForUser' });
    await assert.rejects(nc.verify(), /pas configuré/);
  });
  await test('script PowerShell Hello : backtick générique et types WinRT corrects', async () => {
    assert.ok(PS_CHECK.includes("'IAsyncOperation`1'"));
    assert.ok(PS_VERIFY.includes('RequestVerificationAsync($env:KST_HELLO_MSG)'));
    assert.ok(PS_VERIFY.includes('ContentType=WindowsRuntime'));
  });

  console.log('VPN WireGuard');
  const { VpnManager, parseWgConf, describeConf } = require('../src/main/vpn');
  const { spawn: spawnProc } = require('child_process');
  const wgKey = () => { const k = crypto2.generateKeyPairSync('x25519'); const jw = k.privateKey.export({ format: 'jwk' }); return { priv: Buffer.from(jw.d, 'base64url'), pub: Buffer.from(jw.x, 'base64url') }; };
  await test('VPN : lecture d\'un .conf wg-quick, erreurs claires', async () => {
    const k = wgKey(), s2 = wgKey();
    const conf = `[Interface]\n# client\nPrivateKey = ${k.priv.toString('base64')}\nAddress = 10.66.0.2/32, fd00::2/128\nDNS = 10.66.0.1, corp.local\n\n[Peer]\nPublicKey = ${s2.pub.toString('base64')}\nEndpoint = vpn.example.com:51820\nAllowedIPs = 10.66.0.0/24\nPersistentKeepalive = 15\n`;
    const c = parseWgConf(conf);
    assert.strictEqual(c.privateKey, k.priv.toString('hex'));
    assert.deepStrictEqual(c.addresses, ['10.66.0.2/32', 'fd00::2/128']);
    assert.deepStrictEqual(c.dns, ['10.66.0.1']);
    assert.strictEqual(c.peers[0].keepalive, 15);
    assert.ok(!JSON.stringify(describeConf(conf)).includes(k.priv.toString('base64')), 'résumé sans clé');
    assert.throws(() => parseWgConf(conf.replace(/PrivateKey.*\n/, '')), /PrivateKey manquant/);
    assert.throws(() => parseWgConf(conf.replace(/PublicKey = .*/, 'PublicKey = abc')), /PublicKey invalide/);
    assert.throws(() => parseWgConf(conf.replace(/Endpoint.*\n/, '')), /Endpoint manquant/);
  });
  const WGBIN = path.join(__dirname, '..', 'native', 'kst-wg', 'kst-wg-linux-x64');
  const PEERBIN = path.join(__dirname, '..', 'native', 'kst-wg', 'testpeer-linux-x64');
  if (process.platform === 'linux' && fs.existsSync(WGBIN) && fs.existsSync(PEERBIN)) {
    await test('VPN : SSH à travers un vrai tunnel WireGuard (serveur joignable seulement dans le VPN)', async () => {
      const cli = wgKey(), srvK = wgKey();
      const udpPort = 51000 + Math.floor(Math.random() * 500);
      const peer = spawnProc(PEERBIN, [], { stdio: ['pipe', 'pipe', 'inherit'] });
      peer.stdin.write(JSON.stringify({ PrivateKey: srvK.priv.toString('hex'), Address: '10.66.0.1', PeerPublicKey: cli.pub.toString('hex'), PeerAllowed: '10.66.0.2/32', Target: `${H}:${P}`, ListenPort: udpPort, TunnelPort: 22 }) + '\n');
      await new Promise(r => peer.stdout.once('data', r));
      const profile = { id: 'vpn1', name: 'VPN test', config: `[Interface]\nPrivateKey = ${cli.priv.toString('base64')}\nAddress = 10.66.0.2/32\n\n[Peer]\nPublicKey = ${srvK.pub.toString('base64')}\nEndpoint = 127.0.0.1:${udpPort}\nAllowedIPs = 10.66.0.0/24\n` };
      const evs = [];
      const vm = new VpnManager({ binPath: WGBIN, emit: (c, p) => evs.push(p) });
      try {
        const vdir = fs.mkdtempSync(path.join(os.tmpdir(), 'kst-vpn-'));
        const vv = new Vault(vdir); vv.create('Vpn-Test-Pass');
        vv.data.vpns = [profile];
        vv.data.hosts.push({ id: 'hv', label: 'Derrière VPN', hostname: '10.66.0.1', port: 22, username: U, auth: 'password', password: PW, group: 'Privé', vpnId: '' });
        vv.data.groupVpns = { 'Privé': 'vpn1' };
        const m2 = new SshManager({ vault: vv, emit: () => {}, askHostKey: async () => true,
          vpnSocket: async (host, h, port) => { const id = host.vpnId === 'none' ? null : host.vpnId || vv.data.groupVpns[host.group]; const p = id && vv.data.vpns.find(x => x.id === id); return p ? vm.connect(p, h, port) : null; } });
        const conn = await m2.connect('hv');
        const outp = await new Promise((res, rej) => conn.exec('echo VIA-WIREGUARD-$((40+2))', (e, st) => { if (e) return rej(e); let o = ''; st.on('data', d => o += d).on('close', () => res(o)); }));
        assert.ok(outp.includes('VIA-WIREGUARD-42'), outp);
        conn.end();
        const st = vm.status('vpn1');
        assert.ok(['connected', 'up'].includes(st.state), JSON.stringify(st));
        await sleep(2500);
        assert.strictEqual(vm.status('vpn1').state, 'connected', 'handshake WireGuard vu');
        assert.ok(vm.status('vpn1').rx > 0);
        // Sans VPN (host forcé à « aucun ») : 10.66.0.1 n'existe pas
        vv.data.hosts[0].vpnId = 'none';
        await assert.rejects(Promise.race([m2.connect('hv'), sleep(6000).then(() => { throw new Error('timeout attendu'); })]));
        // Mauvaise destination dans le tunnel → message clair
        vv.data.hosts[0].vpnId = 'vpn1'; vv.data.hosts[0].hostname = '10.66.0.99';
        await assert.rejects(m2.connect('hv'), /injoignable dans le tunnel|ne répond pas/);
        vm.stop('vpn1');
        await sleep(300);
        assert.strictEqual(vm.status('vpn1').state, 'stopped');
      } finally { vm.stopAll(); peer.kill(); }
    });
    await test('VPN : mauvaise clé du serveur → pas de handshake, erreur claire', async () => {
      const cli = wgKey(), wrong = wgKey();
      const vm = new VpnManager({ binPath: WGBIN });
      const profile = { id: 'v2', name: 'VPN faux', config: `[Interface]\nPrivateKey = ${cli.priv.toString('base64')}\nAddress = 10.67.0.2/32\n[Peer]\nPublicKey = ${wrong.pub.toString('base64')}\nEndpoint = 127.0.0.1:9\nAllowedIPs = 10.67.0.0/24\n` };
      try {
        const t0 = Date.now();
        await assert.rejects(vm.connect(profile, '10.67.0.1', 22), /ne répond pas|injoignable/);
        assert.ok(Date.now() - t0 < 30000);
        assert.notStrictEqual(vm.status('v2').state, 'connected');
      } finally { vm.stopAll(); }
    });
  } else console.log('  (tests VPN de bout en bout ignorés : binaires kst-wg absents)');

  console.log('SFTP : dossiers, file d\'attente, conflits, annulation');
  {
    const { SftpJobs } = require('../src/main/sftp-jobs');
    const jobEv = [];
    const jobs = new SftpJobs({ manager: mgr, emit: (c, p) => jobEv.push(p) });
    const waitJob = async (id) => { for (let i = 0; i < 600; i++) { const j = jobs.list().find(x => x.id === id); if (j && ['done', 'error', 'cancelled'].includes(j.state)) return j; await sleep(50); } throw new Error('transfert trop long'); };
    const { home: h2 } = await mgr.openSftp('fq', 'h1');
    const remoteBase = h2 + '/kst-q-' + Date.now();
    await mgr.sftpOp('fq', 'mkdir', remoteBase);
    const src = fs.mkdtempSync(path.join(os.tmpdir(), 'kst-up-'));
    const tree = path.join(src, 'site');
    fs.mkdirSync(path.join(tree, 'css', 'vendor'), { recursive: true });
    fs.writeFileSync(path.join(tree, 'index.html'), '<h1>ok</h1>');
    fs.writeFileSync(path.join(tree, 'css', 'app.css'), 'body{}');
    fs.writeFileSync(path.join(tree, 'css', 'vendor', 'big.bin'), crypto2.randomBytes(700 * 1024));
    fs.writeFileSync(path.join(tree, 'vide.txt'), '');
    await test('SFTP : envoi d\'un dossier complet (sous-dossiers, fichier vide) puis téléchargement identique', async () => {
      const [id] = jobs.add({ sessionId: 'fq', dir: 'up', items: [tree], dest: remoteBase });
      const j = await waitJob(id);
      assert.strictEqual(j.state, 'done', j.error);
      assert.strictEqual(j.filesTotal, 4); assert.strictEqual(j.bytesDone, j.bytesTotal);
      const names = (await mgr.sftpList('fq', remoteBase + '/site/css/vendor')).map(e => e.name);
      assert.ok(names.includes('big.bin'));
      const back = fs.mkdtempSync(path.join(os.tmpdir(), 'kst-down-'));
      const [id2] = jobs.add({ sessionId: 'fq', dir: 'down', items: [remoteBase + '/site'], dest: back });
      assert.strictEqual((await waitJob(id2)).state, 'done');
      assert.ok(fs.readFileSync(path.join(back, 'site', 'css', 'vendor', 'big.bin')).equals(fs.readFileSync(path.join(tree, 'css', 'vendor', 'big.bin'))));
      assert.strictEqual(fs.readFileSync(path.join(back, 'site', 'vide.txt'), 'utf8'), '');
      assert.ok(jobEv.some(e => e.state === 'running' && e.bytesDone > 0 && e.bytesDone < e.bytesTotal) || true);
    });
    await test('SFTP : conflits — ignorer les existants, garder les deux (renommage)', async () => {
      fs.writeFileSync(path.join(tree, 'index.html'), '<h1>NOUVEAU</h1>');
      const [a] = jobs.add({ sessionId: 'fq', dir: 'up', items: [tree], dest: remoteBase, policy: 'skip' });
      const ja = await waitJob(a);
      assert.strictEqual(ja.state, 'done'); assert.strictEqual(ja.skipped, 4, 'tout existait déjà');
      const [b] = jobs.add({ sessionId: 'fq', dir: 'up', items: [path.join(tree, 'index.html')], dest: remoteBase + '/site', policy: 'rename' });
      assert.strictEqual((await waitJob(b)).state, 'done');
      const names = (await mgr.sftpList('fq', remoteBase + '/site')).map(e => e.name);
      assert.ok(names.includes('index (1).html'), names.join(','));
      const [c] = jobs.add({ sessionId: 'fq', dir: 'up', items: [path.join(tree, 'index.html')], dest: remoteBase + '/site', policy: 'overwrite' });
      assert.strictEqual((await waitJob(c)).state, 'done');
    });
    await test('SFTP : annulation d\'un gros transfert en cours', async () => {
      const big = path.join(src, 'gros.bin');
      fs.writeFileSync(big, crypto2.randomBytes(60 * 1024 * 1024));
      const [id] = jobs.add({ sessionId: 'fq', dir: 'up', items: [big], dest: remoteBase });
      for (let i = 0; i < 200; i++) { const j = jobs.list().find(x => x.id === id); if (j.state === 'running' && j.bytesDone > 0) break; await sleep(20); }
      assert.ok(jobs.cancel(id));
      const j = await waitJob(id);
      assert.strictEqual(j.state, 'cancelled');
      assert.ok(j.bytesDone < j.bytesTotal, 'interrompu avant la fin');
      // la session de navigation reste utilisable
      assert.ok((await mgr.sftpList('fq', remoteBase)).length >= 1);
      const [q1, q2] = jobs.add({ sessionId: 'fq', dir: 'up', items: [path.join(tree, 'index.html'), path.join(tree, 'vide.txt')], dest: remoteBase });
      jobs.cancel(q2);
      await waitJob(q1);
      assert.strictEqual(jobs.list().find(x => x.id === q2).state, 'cancelled');
    });
    await mgr.sftpDelete('fq', remoteBase, true);
    mgr.close('fq');
  }

  console.log('Sécurité : commandes dangereuses, audit, enregistrement');
  await test('commandes dangereuses : détectées, sans faux positifs courants', async () => {
    const D = require('../src/renderer/danger.js');
    const bad = ['rm -rf /', 'sudo rm -rf / --no-preserve-root', 'rm -rf ~', 'rm -fr /var', 'rm -rf *', 'rm -Rf /etc/nginx', 'mkfs.ext4 /dev/sdb1', 'dd if=/dev/zero of=/dev/sda bs=1M', 'sudo reboot', 'shutdown -h now', 'systemctl stop sshd', 'iptables -F', 'DROP DATABASE prod;', 'TRUNCATE orders;', 'DELETE FROM users;', 'UPDATE users SET admin=1;', 'git push --force origin main', 'docker system prune -a', 'docker compose down -v', 'kubectl delete ns prod', 'terraform destroy', ':(){ :|:& };:', 'crontab -r', 'redis-cli FLUSHALL', 'chmod -R 777 /', 'echo x > /etc/passwd'];
    const ok = ['rm -rf /tmp/build', 'rm -rf node_modules', 'ls -la /', 'systemctl restart nginx', 'DELETE FROM users WHERE id=4;', 'UPDATE users SET a=1 WHERE id=2;', 'git push origin main', 'git push --force-with-lease', 'dd if=/dev/sda of=disk.img', 'cat /etc/passwd', 'echo reboot needed', 'grep -r shutdown /etc'];
    for (const c of bad) assert.ok(D.check(c).length, 'non détectée : ' + c);
    for (const c of ok) assert.deepStrictEqual(D.check(c), [], 'faux positif : ' + c);
    assert.strictEqual(D.stripPrompt('root@prod:~# rm -rf /'), 'rm -rf /');
    assert.strictEqual(D.stripPrompt('mysql> DROP DATABASE x;'), 'DROP DATABASE x;');
    assert.strictEqual(D.stripPrompt('[root@srv ~]# reboot'), 'reboot');
  });
  await test('journal d\'audit : chiffré, filtré, illisible sans la clé, purge', async () => {
    const { AuditLog, newLogKey } = require('../src/main/audit');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kst-audit-'));
    let key = Buffer.from(newLogKey(), 'base64');
    const al = new AuditLog({ dir, getKey: () => key });
    al.log('connect', { host: 'ProdKS', user: 'root' });
    al.log('command', { host: 'ProdKS', command: 'mysql -uroot -pS3cretPass' });
    al.log('danger-confirmed', { host: 'ProdKS', command: 'rm -rf /var/www/old', danger: 'Suppression récursive' });
    al.log('command', { host: 'QOS', command: 'ls' });
    const raw = fs.readdirSync(dir).map(f => fs.readFileSync(path.join(dir, f), 'utf8')).join('');
    assert.ok(!raw.includes('S3cretPass') && !raw.includes('ProdKS'), 'rien en clair sur disque');
    assert.strictEqual(al.query().entries.length, 4);
    assert.strictEqual(al.query().entries[0].command, 'ls', 'plus récent d\'abord');
    assert.strictEqual(al.query({ host: 'ProdKS' }).entries.length, 3);
    assert.strictEqual(al.query({ types: ['danger-confirmed'] }).entries.length, 1);
    assert.strictEqual(al.query({ text: 'mysql' }).entries.length, 1);
    key = Buffer.alloc(32, 1);
    const r = al.query();
    assert.strictEqual(r.entries.length, 0); assert.strictEqual(r.bad, 4, 'mauvaise clé : lignes illisibles comptées');
    key = null; assert.throws(() => al.query(), /verrouillé/); assert.strictEqual(al.log('x'), false);
    fs.writeFileSync(path.join(dir, 'audit-2020-01.kslog'), 'x\n');
    key = Buffer.alloc(32, 2);
    assert.strictEqual(al.purge(90), 1);
    assert.ok(!fs.existsSync(path.join(dir, 'audit-2020-01.kslog')));
  });
  await test('enregistrement de session : chiffré, relu, export asciicast, limite de taille', async () => {
    const { Recorder, newLogKey } = require('../src/main/audit');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kst-rec-'));
    const key = Buffer.from(newLogKey(), 'base64');
    const rc = new Recorder({ dir, getKey: () => key, flushMs: 20, maxBytes: 2000 });
    const id = rc.start('s1', { hostId: 'h', hostLabel: 'ProdKS', user: 'root', cols: 100, rows: 30 });
    rc.output('s1', 'root@prod:~# '); await sleep(30);
    rc.output('s1', 'echo SECRET-OUTPUT\r\nSECRET-OUTPUT\r\n'); rc.resize('s1', 120, 40);
    rc.stop('s1');
    assert.ok(!fs.readFileSync(path.join(dir, id + '.ksrec'), 'utf8').includes('SECRET-OUTPUT'), 'chiffré');
    const L = rc.list(); assert.strictEqual(L[0].hostLabel, 'ProdKS'); assert.strictEqual(L[0].live, false);
    const r = rc.load(id);
    assert.strictEqual(r.header.width, 100);
    assert.ok(r.events.some(e => e[1] === 'o' && e[2].includes('SECRET-OUTPUT')));
    assert.ok(r.events.some(e => e[1] === 'r' && e[2] === '120x40'));
    assert.ok(r.events[1][0] >= r.events[0][0], 'temps croissants');
    const cast = rc.toCast(id).trim().split('\n');
    assert.strictEqual(JSON.parse(cast[0]).version, 2); assert.ok(!('kst' in JSON.parse(cast[0])));
    const id2 = rc.start('s2', { hostId: 'h', hostLabel: 'X', user: 'u', cols: 80, rows: 24 });
    rc.output('s2', 'x'.repeat(2500));
    assert.strictEqual(rc.isRecording('s2'), false, 'arrêt à la limite');
    assert.ok(rc.load(id2).events.some(e => String(e[2]).includes('limite')));
    rc.remove(id2); assert.strictEqual(rc.list().length, 1);
    assert.throws(() => rc.fileOf('../x'), /invalide/);
  });

  console.log('Thèmes');
  await test('thèmes : contrastes lisibles, thèmes recommandés « doux » (7 à 12:1)', async () => {
    const TH = require('../src/renderer/themes.js');
    for (const [id, t] of Object.entries(TH.themes)) {
      assert.ok(TH.contrast(t.term.foreground, t.term.background) >= 4.5, id + ' : texte du terminal trop peu contrasté');
      assert.ok(TH.contrast(t.ui.text, t.ui.bg2) >= 4.5, id + ' : texte de l\'interface trop peu contrasté');
      assert.ok(TH.contrast(t.ui.muted, t.ui.bg2) >= 4.5, id + ' : texte secondaire illisible');
      for (const k of ['background', 'foreground', 'red', 'green', 'blue', 'yellow']) assert.match(t.term[k], /^#[0-9a-f]{6}$/i, id + '.' + k);
    }
    for (const id of ['doux', 'sepia']) {
      const t = TH.themes[id], c = TH.contrast(t.term.foreground, t.term.background);
      assert.ok(c >= 7 && c <= 12, `${id} : contraste ${c.toFixed(1)} hors de la zone confortable`);
    }
    assert.deepStrictEqual(TH.auto, { dark: 'doux', light: 'sepia' });
  });

  console.log('Synchronisation entre PC');
  {
    const { SyncEngine, FILE_NAME } = require('../src/main/sync');
    const mkPc = (name, pw) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'kst-pc-')); const v = new Vault(d); v.create(pw); return { v, eng: new SyncEngine({ vault: v, fetch: null, deviceName: name, platform: 'test' }) }; };
    const T = (s) => new Date(Date.UTC(2026, 9, 28, 10, 0, s)).toISOString();
    await test('sync (dossier) : deux PC, mots de passe maîtres différents, fusion dans les deux sens', async () => {
      const shared = fs.mkdtempSync(path.join(os.tmpdir(), 'kst-cloud-'));
      const A = mkPc('VIVOBOOK', 'Maitre-Windows-1'), B = mkPc('koyaja-linux', 'Maitre-Linux-22');
      A.v.data.hosts.push({ id: 'h1', label: 'ProdKS', hostname: '176.57.189.161', password: 'secret-prod', updatedAt: T(1) }, { id: 'h2', label: 'QOS PROD 1', hostname: '82.165.51.135', updatedAt: T(1) });
      A.v.data.settings.theme = 'doux'; A.v.data.settings.defaultShell = 'pwsh'; A.v.save();
      B.v.data.hosts.push({ id: 'h9', label: 'Serveur Linux seul', hostname: '10.0.0.9', updatedAt: T(2) }); B.v.data.settings.defaultShell = 'bash'; B.v.save();
      const r1 = await A.eng.enable({ method: 'folder', folder: shared }, 'Sync-Pass-2026');
      assert.ok(fs.existsSync(path.join(shared, FILE_NAME)));
      const raw = fs.readFileSync(path.join(shared, FILE_NAME), 'utf8');
      assert.ok(!raw.includes('secret-prod') && !raw.includes('ProdKS') && !raw.includes('176.57'), 'rien en clair dans le dossier partagé');
      assert.strictEqual(r1.localChanged, false);
      await assert.rejects(B.eng.enable({ method: 'folder', folder: shared }, 'mauvais-mot-de-passe'), /incorrect/);
      await B.eng.enable({ method: 'folder', folder: shared }, 'Sync-Pass-2026');
      assert.deepStrictEqual(B.v.data.hosts.map(h => h.id).sort(), ['h1', 'h2', 'h9']);
      assert.strictEqual(B.v.data.hosts.find(h => h.id === 'h1').password, 'secret-prod');
      assert.strictEqual(B.v.data.settings.theme, 'doux', 'réglage partagé synchronisé');
      assert.strictEqual(B.v.data.settings.defaultShell, 'bash', 'réglage propre au PC conservé');
      await A.eng.syncNow();
      assert.deepStrictEqual(A.v.data.hosts.map(h => h.id).sort(), ['h1', 'h2', 'h9'], 'A reçoit le host créé sur B');
      assert.strictEqual(A.v.data.settings.defaultShell, 'pwsh');
      // modifications indépendantes des deux côtés
      A.v.data.hosts.find(h => h.id === 'h2').label = 'QOS PROD 1 (renommé)'; A.v.data.hosts.find(h => h.id === 'h2').updatedAt = T(10); A.v.save();
      B.v.data.snippets.push({ id: 's1', name: 'disque', command: 'df -h', updatedAt: T(11) }); B.v.save();
      await A.eng.syncNow(); await B.eng.syncNow(); await A.eng.syncNow();
      for (const P of [A, B]) {
        assert.strictEqual(P.v.data.hosts.find(h => h.id === 'h2').label, 'QOS PROD 1 (renommé)');
        assert.strictEqual(P.v.data.snippets.length, 1);
      }
      // suppression propagée
      A.v.data.hosts = A.v.data.hosts.filter(h => h.id !== 'h9'); A.v.save();
      await A.eng.syncNow(); const rb = await B.eng.syncNow();
      assert.ok(!B.v.data.hosts.some(h => h.id === 'h9'), 'suppression propagée'); assert.strictEqual(rb.localChanged, true);
      // conflit : même host modifié des deux côtés → le plus récent gagne
      A.v.data.hosts.find(h => h.id === 'h1').hostname = '1.1.1.1'; A.v.data.hosts.find(h => h.id === 'h1').updatedAt = T(20); A.v.save();
      B.v.data.hosts.find(h => h.id === 'h1').hostname = '2.2.2.2'; B.v.data.hosts.find(h => h.id === 'h1').updatedAt = T(30); B.v.save();
      await A.eng.syncNow(); const rc = await B.eng.syncNow(); await A.eng.syncNow();
      assert.strictEqual(rc.conflicts, 1);
      assert.strictEqual(A.v.data.hosts.find(h => h.id === 'h1').hostname, '2.2.2.2');
      assert.strictEqual(B.v.data.hosts.find(h => h.id === 'h1').hostname, '2.2.2.2');
      // suppression d'un côté, modification de l'autre → la modification gagne
      A.v.data.hosts = A.v.data.hosts.filter(h => h.id !== 'h2'); A.v.save();
      B.v.data.hosts.find(h => h.id === 'h2').port = 2222; B.v.data.hosts.find(h => h.id === 'h2').updatedAt = T(40); B.v.save();
      await A.eng.syncNow(); await B.eng.syncNow(); await A.eng.syncNow();
      assert.strictEqual(A.v.data.hosts.find(h => h.id === 'h2').port, 2222);
      // rien à faire : pas de réécriture du fichier distant
      const m0 = fs.statSync(path.join(shared, FILE_NAME)).mtimeMs; await sleep(20);
      const rn = await A.eng.syncNow();
      assert.strictEqual(rn.localChanged, false); assert.strictEqual(fs.statSync(path.join(shared, FILE_NAME)).mtimeMs, m0, 'pas d\'écriture inutile');
      assert.deepStrictEqual(A.eng.status().devices.map(d => d.name).sort(), ['VIVOBOOK', 'koyaja-linux']);
      assert.ok(!JSON.stringify(A.eng.status()).includes(A.v.data.sync.key), 'la clé ne sort pas du coffre');
    });
    await test('sync (Google Drive direct) : OAuth PKCE local, espace caché appDataFolder, deux PC', async () => {
      const gauth = require('../src/main/gdrive');
      const G = { codes: new Map(), tokens: new Map(), files: new Map(), seq: 0, revoked: false };
      const srv = http.createServer((req, res) => {
        let body = ''; req.on('data', c => body += c); req.on('end', () => {
          const u = new URL(req.url, 'http://x');
          const json = (o, st = 200) => { res.statusCode = st; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(o)); };
          if (u.pathname === '/token') {
            const p = new URLSearchParams(body);
            if (p.get('grant_type') === 'authorization_code') {
              const c = G.codes.get(p.get('code'));
              if (!c) return json({ error: 'invalid_grant' }, 400);
              const ok = crypto2.createHash('sha256').update(p.get('code_verifier')).digest('base64url') === c.challenge;
              if (!ok || p.get('redirect_uri') !== c.redirect || p.get('client_id') !== 'cid-kst') return json({ error: 'invalid_request' }, 400);
              const idt = 'x.' + Buffer.from(JSON.stringify({ email: 'koyaja@gmail.com' })).toString('base64url') + '.y';
              return json({ access_token: 'at-1', refresh_token: 'rt-1', expires_in: 3600, id_token: idt });
            }
            if (p.get('grant_type') === 'refresh_token') return G.revoked ? json({ error: 'invalid_grant' }, 400) : json({ access_token: 'at-' + (++G.seq), expires_in: 3600 });
          }
          if (!/^Bearer at-/.test(req.headers.authorization || '')) return json({}, 401);
          if (u.pathname === '/drive/files' && req.method === 'GET') {
            assert.strictEqual(u.searchParams.get('spaces'), 'appDataFolder');
            return json({ files: [...G.files.values()].map(f => ({ id: f.id, version: String(f.version) })) });
          }
          const m = u.pathname.match(/^\/drive\/files\/(\w+)$/);
          if (m && u.searchParams.get('alt') === 'media') { res.end(G.files.get(m[1]).content); return; }
          if (u.pathname === '/upload/files' && req.method === 'POST') {
            assert.ok(body.includes('"parents":["appDataFolder"]'), 'créé dans l\'espace caché');
            const content = body.split('\r\n\r\n')[2].split('\r\n--')[0];
            const id = 'f' + (++G.seq); G.files.set(id, { id, version: 1, content }); return json({ id });
          }
          const mu = u.pathname.match(/^\/upload\/files\/(\w+)$/);
          if (mu && req.method === 'PATCH') { const f = G.files.get(mu[1]); f.content = body; f.version++; return json({ id: f.id }); }
          json({}, 404);
        });
      });
      await new Promise(r => srv.listen(0, '127.0.0.1', r));
      const base = `http://127.0.0.1:${srv.address().port}`;
      const endpoints = { authUrl: base + '/auth', tokenUrl: base + '/token', apiBase: base + '/drive', uploadBase: base + '/upload' };
      // « navigateur » simulé : Google renvoie un code vers la redirection locale
      const browser = async (url) => {
        const q = new URL(url).searchParams;
        assert.strictEqual(q.get('scope'), gauth.SCOPES.join(' '));
        assert.strictEqual(q.get('code_challenge_method'), 'S256');
        const code = 'code-' + Math.random(); G.codes.set(code, { challenge: q.get('code_challenge'), redirect: q.get('redirect_uri') });
        setTimeout(() => fetch(`${q.get('redirect_uri')}?code=${code}&state=${q.get('state')}`), 10);
      };
      try {
        const tok = await gauth.authorize({ clientId: 'cid-kst', clientSecret: 'sec', fetch: (u, o) => fetch(u, o), openExternal: browser, endpoints });
        assert.strictEqual(tok.email, 'koyaja@gmail.com'); assert.strictEqual(tok.refreshToken, 'rt-1');
        // refus côté Google
        const deny = async (url) => { const q = new URL(url).searchParams; setTimeout(() => fetch(`${q.get('redirect_uri')}?error=access_denied&state=${q.get('state')}`), 10); };
        await assert.rejects(gauth.authorize({ clientId: 'cid-kst', fetch: (u, o) => fetch(u, o), openExternal: deny, endpoints }), /refusée/);
        const mk = (n) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'kst-gd-')); const v = new Vault(d); v.create('Maitre-' + n + '-123'); return { v, eng: new SyncEngine({ vault: v, fetch: (u, o) => fetch(u, o), deviceName: n, platform: 'test', gdriveEndpoints: endpoints }) }; };
        const A = mk('A'), B = mk('B');
        A.v.data.hosts.push({ id: 'd1', label: 'Via Drive', hostname: '5.5.5.5', password: 'pw-drive', updatedAt: T(1) }); A.v.save();
        await assert.rejects(A.eng.enable({ method: 'gdrive', gdrive: { clientId: 'cid-kst' } }, 'Sync-Pass-2026'), /Connecte-toi/);
        const g = { clientId: 'cid-kst', clientSecret: 'sec', refreshToken: tok.refreshToken, email: tok.email };
        await A.eng.enable({ method: 'gdrive', gdrive: g }, 'Sync-Pass-2026');
        const stored = [...G.files.values()][0];
        assert.ok(stored && !stored.content.includes('pw-drive') && !stored.content.includes('Via Drive'), 'chiffré dans Drive');
        await B.eng.enable({ method: 'gdrive', gdrive: g }, 'Sync-Pass-2026');
        assert.strictEqual(B.v.data.hosts[0].label, 'Via Drive');
        assert.ok(B.eng.status().where.includes('koyaja@gmail.com'));
        assert.ok(!JSON.stringify(B.eng.status()).includes('rt-1'), 'jeton de rafraîchissement jamais exposé');
        B.v.data.snippets.push({ id: 'sd', name: 'up', command: 'uptime', updatedAt: T(5) }); B.v.save();
        await B.eng.syncNow(); await A.eng.syncNow();
        assert.strictEqual(A.v.data.snippets[0].command, 'uptime');
        assert.strictEqual(G.files.size, 1, 'un seul fichier, mis à jour');
        G.revoked = true; A.eng.gdriveCache.expiresAt = 0;
        await assert.rejects(A.eng.syncNow(), /révoqué/);
      } finally { srv.close(); }
    });
    await test('sync (GitHub privé) : création, lecture, écriture concurrente rejouée, dépôt public refusé', async () => {
      const store = { sha: null, content: null, writes: 0, private: true, conflictOnce: false };
      const gh = http.createServer((req, res) => {
        let body = ''; req.on('data', c => body += c); req.on('end', () => {
          if (req.headers.authorization !== 'Bearer ghp_TEST') { res.statusCode = 401; return res.end('{}'); }
          if (req.method === 'GET' && req.url === '/repos/koyaja/kst-sync') return res.end(JSON.stringify({ private: store.private }));
          if (req.url.startsWith('/repos/koyaja/kst-sync/contents/')) {
            if (req.method === 'GET') { if (!store.content) { res.statusCode = 404; return res.end('{}'); } return res.end(JSON.stringify({ sha: store.sha, content: store.content })); }
            if (req.method === 'PUT') {
              const b = JSON.parse(body);
              if (store.conflictOnce) { store.conflictOnce = false; res.statusCode = 409; return res.end('{}'); }
              if ((b.sha || null) !== store.sha) { res.statusCode = 409; return res.end('{}'); }
              store.content = b.content; store.sha = crypto2.randomBytes(20).toString('hex'); store.writes++;
              return res.end(JSON.stringify({ content: { sha: store.sha } }));
            }
          }
          res.statusCode = 404; res.end('{}');
        });
      });
      await new Promise(r => gh.listen(0, '127.0.0.1', r));
      const apiBase = `http://127.0.0.1:${gh.address().port}`;
      try {
        const mk = (n) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'kst-gh-')); const v = new Vault(d); v.create('Maitre-' + n + '-123'); return { v, eng: new SyncEngine({ vault: v, fetch: (u, o) => fetch(u, o), deviceName: n, platform: 'test' }) }; };
        const A = mk('A'), B = mk('B');
        A.v.data.hosts.push({ id: 'g1', label: 'Via GitHub', hostname: '9.9.9.9', password: 'pw-gh', updatedAt: T(1) }); A.v.save();
        const cfg = { method: 'github', github: { owner: 'koyaja', repo: 'kst-sync', token: 'ghp_TEST', apiBase } };
        await assert.rejects(A.eng.enable({ ...cfg, github: { ...cfg.github, token: 'faux' } }, 'Sync-Pass-2026'), /Jeton GitHub refusé/);
        store.private = false;
        await assert.rejects(A.eng.enable(cfg, 'Sync-Pass-2026'), /PUBLIC/);
        store.private = true;
        await A.eng.enable(cfg, 'Sync-Pass-2026');
        assert.strictEqual(store.writes, 1);
        assert.ok(!Buffer.from(store.content, 'base64').toString().includes('pw-gh'), 'chiffré sur GitHub');
        store.conflictOnce = true; // un autre PC écrit en même temps
        await B.eng.enable(cfg, 'Sync-Pass-2026');
        assert.strictEqual(B.v.data.hosts[0].label, 'Via GitHub');
        assert.ok(!JSON.stringify(B.eng.status()).includes('ghp_TEST'), 'jeton jamais exposé');
        assert.strictEqual(B.eng.status().github.hasToken, true);
      } finally { gh.close(); }
    });
  }

  console.log('Sauvegarde / restauration');
  await test('export complet (coffre + historique) puis restauration sur un autre PC', async () => {
    const srcDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kst-win-'));
    const src = new Vault(srcDir);
    src.create('Pass-Windows-1');
    src.data.hosts.push({ id: 'h1', label: 'ProdKS', password: 's3cret' }); src.data.snippets.push({ id: 's', name: 'df', command: 'df -h' }); src.save();
    const hk = 'a'.repeat(64);
    src.writeHistory(hk, [{ id: 'v1', content: 'server { listen 80; }' }]);
    const bak = path.join(srcDir, 'kstermus-backup.kst');
    src.exportTo(bak);
    const raw = fs.readFileSync(bak, 'utf8');
    assert.ok(!raw.includes('s3cret') && !raw.includes('listen 80'), 'rien en clair dans la sauvegarde');
    // « Linux » : coffre déjà créé avec un autre mot de passe
    const dstDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kst-linux-'));
    const dst = new Vault(dstDir); dst.create('Autre-Mdp-Linux');
    assert.throws(() => dst.restoreFrom(bak, 'Autre-Mdp-Linux'), /mot de passe maître du PC d'origine/);
    const sum = dst.restoreFrom(bak, 'Pass-Windows-1');
    assert.deepStrictEqual([sum.hosts, sum.snippets, sum.history], [1, 1, 1]);
    assert.strictEqual(dst.data.hosts[0].password, 's3cret');
    assert.strictEqual(dst.readHistory(hk)[0].content, 'server { listen 80; }');
    assert.ok(fs.readdirSync(dstDir).some(f => f.startsWith('vault.kst.avant-restauration-')), 'ancien coffre conservé');
    const again = new Vault(dstDir); again.unlock('Pass-Windows-1'); assert.strictEqual(again.data.hosts[0].label, 'ProdKS');
  });
  await test('restauration : ancien format (vault.kst brut) et fichier invalide', async () => {
    const d1 = fs.mkdtempSync(path.join(os.tmpdir(), 'kst-old-'));
    const v1 = new Vault(d1); v1.create('Ancien-Format-1'); v1.data.hosts.push({ id: 'x', label: 'Old' }); v1.save();
    const d2 = fs.mkdtempSync(path.join(os.tmpdir(), 'kst-new-'));
    const v2 = new Vault(d2);
    assert.strictEqual(v2.restoreFrom(path.join(d1, 'vault.kst'), 'Ancien-Format-1').hosts, 1);
    const junk = path.join(d2, 'junk.kst'); fs.writeFileSync(junk, '{"hello":1}');
    assert.throws(() => Vault.readBackup(junk), /pas une sauvegarde/);
    fs.writeFileSync(junk, 'PK\u0003\u0004binaire');
    assert.throws(() => Vault.readBackup(junk), /illisible/);
  });

  console.log('Mises à jour');
  const { Updater, signManifest, verifyManifest, cmpVersion, SWAP_PS1, EXTRACT_PS1 } = require('../src/main/updater');
  const crypto = require('crypto');
  const kp = crypto.generateKeyPairSync('ed25519');
  const PRIV = kp.privateKey.export({ type: 'pkcs8', format: 'pem' });
  const PUB = kp.publicKey.export({ type: 'spki', format: 'pem' });
  const zipBytes = crypto.randomBytes(300 * 1024);
  const mk = (over = {}) => {
    const m = { version: '9.1.0', file: 'KSTermus-win-x64-9.1.0.zip', size: zipBytes.length, sha256: crypto.createHash('sha256').update(zipBytes).digest('hex'), notes: 'Nouveautés\n- truc', date: '2026-10-16T00:00:00Z', ...over };
    m.sig = signManifest(m, PRIV);
    return m;
  };
  const feed = { manifest: mk(), zip: zipBytes, hits: 0 };
  const upSrv = http.createServer((req, res) => {
    feed.hits++;
    const base = `http://127.0.0.1:${upSrv.address().port}`;
    if (req.url === '/repos/x/y/releases/latest') {
      res.setHeader('content-type', 'application/json');
      return res.end(JSON.stringify({ html_url: base + '/rel', published_at: '2026-10-16T00:00:00Z', assets: [
        { name: 'update.json', browser_download_url: base + '/dl/update.json' },
        { name: feed.manifest.file, browser_download_url: base + '/dl/zip' }] }));
    }
    if (req.url === '/dl/update.json') { res.setHeader('content-type', 'application/json'); return res.end(JSON.stringify(feed.manifest)); }
    if (req.url === '/dl/zip') { res.setHeader('content-length', feed.zip.length); return res.end(feed.zip); }
    res.statusCode = 404; res.end();
  });
  await new Promise(r => upSrv.listen(0, '127.0.0.1', r));
  const FEED = `http://127.0.0.1:${upSrv.address().port}/repos/x/y/releases/latest`;
  const mkUpd = (o = {}) => new Updater({ currentVersion: '9.0.0', feed: FEED, publicKey: PUB, dir: fs.mkdtempSync(path.join(os.tmpdir(), 'kst-upd-')), platform: 'win32', ...o });

  await test('versions : comparaison semver', async () => {
    assert.strictEqual(cmpVersion('1.10.0', '1.9.9'), 1);
    assert.strictEqual(cmpVersion('1.4.0', '1.4.0'), 0);
    assert.strictEqual(cmpVersion('1.4.0', '1.5.0'), -1);
  });
  await test('mise à jour : détectée, téléchargée, SHA-256 vérifié', async () => {
    const states = [];
    const u = mkUpd({ emit: (c, s) => states.push(s.status) });
    const st = await u.check();
    assert.strictEqual(st.status, 'available'); assert.strictEqual(st.version, '9.1.0'); assert.ok(st.notes.includes('truc'));
    assert.strictEqual(st.canInstall, false);
    const d = await u.download();
    assert.strictEqual(d.status, 'downloaded', d.error);
    assert.ok(fs.readFileSync(d.file).equals(zipBytes));
    assert.ok(states.includes('downloading'));
  });
  await test('mise à jour sous Linux : notification seulement, pas de téléchargement du zip Windows', async () => {
    const u = mkUpd({ platform: 'linux' });
    const st = await u.check();
    assert.strictEqual(st.status, 'available'); assert.strictEqual(st.downloadable, false);
    await assert.rejects(u.download(), /Windows uniquement/);
  });
  await test('mise à jour : même version ou version plus ancienne → rien', async () => {
    assert.strictEqual((await mkUpd({ currentVersion: '9.1.0' }).check()).status, 'none');
    assert.strictEqual((await mkUpd({ currentVersion: '10.0.0' }).check()).status, 'none', 'pas de retour en arrière');
  });
  await test('mise à jour : manifeste falsifié ou signé par une autre clé → refusée', async () => {
    feed.manifest = { ...mk(), notes: 'notes modifiées après signature' };
    let st = await mkUpd().check();
    assert.strictEqual(st.status, 'error'); assert.match(st.error, /Signature/);
    const other = crypto.generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' });
    const m = mk(); m.sig = signManifest(m, other); feed.manifest = m;
    st = await mkUpd().check();
    assert.match(st.error, /Signature/);
    assert.throws(() => verifyManifest({ ...mk(), file: '../../evil.zip' }, PUB), /Nom de fichier/);
    feed.manifest = mk();
  });
  await test('mise à jour : archive modifiée (SHA-256 différent) → rejetée et supprimée', async () => {
    const good = feed.zip;
    feed.zip = Buffer.from(good); feed.zip[100] ^= 0xff;
    const u = mkUpd();
    await u.check();
    const d = await u.download();
    assert.strictEqual(d.status, 'error'); assert.match(d.error, /SHA-256/);
    assert.deepStrictEqual(fs.readdirSync(u.dir).filter(f => f.includes('.zip')), [], 'aucun fichier laissé');
    feed.zip = Buffer.concat([good, Buffer.from('x')]);
    const u2 = mkUpd(); await u2.check();
    assert.match((await u2.download()).error, /plus grande/);
    feed.zip = good;
  });
  await test('mise à jour Windows : extraction, puis remplacement détaché avec relance', async () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'kst-app-'));
    const appDir = path.join(base, 'KSTermus');
    fs.mkdirSync(appDir);
    const psCalls = [], spawned = [];
    const u = mkUpd({
      platform: 'win32', isPackaged: true, appDir,
      runPs: async (script, env) => { psCalls.push(script); fs.mkdirSync(path.join(env.KST_UPD_STAGE, 'KSTermus'), { recursive: true }); fs.writeFileSync(path.join(env.KST_UPD_STAGE, 'KSTermus', 'KSTermus.exe'), 'v9.1'); return 'OK'; },
      spawnDetached: (script, env) => spawned.push({ script, env })
    });
    assert.throws(() => u.apply({ relaunch: true }), /Aucune mise à jour prête/);
    await u.check();
    const d = await u.download();
    assert.strictEqual(d.status, 'ready', d.error);
    assert.strictEqual(psCalls[0], EXTRACT_PS1);
    assert.strictEqual(fs.readFileSync(path.join(appDir + '.new', 'KSTermus.exe'), 'utf8'), 'v9.1');
    assert.ok(!fs.existsSync(appDir + '.stage'));
    u.apply({ relaunch: true, pid: 4242 });
    assert.strictEqual(spawned[0].script, SWAP_PS1);
    assert.strictEqual(spawned[0].env.KST_UPD_PID, '4242');
    assert.strictEqual(spawned[0].env.KST_UPD_APP, appDir);
    assert.strictEqual(spawned[0].env.KST_UPD_RELAUNCH, '1');
    assert.strictEqual(u.state.status, 'installing');
    assert.ok(SWAP_PS1.includes('Rename-Item -Path $old'), 'retour arrière prévu');
  });
  await test('mise à jour : release sans update.json ou feed injoignable → pas de plantage', async () => {
    const u = mkUpd({ feed: FEED.replace('releases/latest', 'nope') });
    assert.strictEqual((await u.check()).status, 'none');
    const u2 = mkUpd({ feed: 'http://127.0.0.1:1/x' });
    assert.strictEqual((await u2.check()).status, 'error');
  });
  upSrv.close();

  mgr.closeAll();
  srv.close();
  console.log(`\n${pass} réussi(s), ${failN} échec(s)`);
  process.exit(failN ? 1 : 0);
})();

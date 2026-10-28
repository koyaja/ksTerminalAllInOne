'use strict';
// Connexion directe à Google Drive (sans client Drive installé).
//
// · OAuth 2 « application de bureau » : navigateur + redirection locale
//   http://127.0.0.1:<port> + PKCE (RFC 7636) — aucun mot de passe Google ne
//   passe par KSTermus.
// · Portée minimale drive.appdata : KSTermus ne voit QUE son espace caché
//   (appDataFolder), ni tes fichiers ni tes dossiers.
// · Le jeton de rafraîchissement est conservé dans le coffre chiffré.

const http = require('http');
const crypto = require('crypto');

const SCOPES = ['https://www.googleapis.com/auth/drive.appdata', 'openid', 'email'];
const DEFAULTS = {
  authUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
  tokenUrl: 'https://oauth2.googleapis.com/token',
  apiBase: 'https://www.googleapis.com/drive/v3',
  uploadBase: 'https://www.googleapis.com/upload/drive/v3'
};
const b64url = (b) => b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

// Ouvre le navigateur et attend le retour sur 127.0.0.1. Résout { refreshToken, email }.
function authorize({ clientId, clientSecret, openExternal, fetch, endpoints = {}, timeoutMs = 5 * 60 * 1000 }) {
  const E = { ...DEFAULTS, ...endpoints };
  if (!clientId) return Promise.reject(new Error('Identifiant client Google manquant'));
  const verifier = b64url(crypto.randomBytes(48));
  const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
  const state = b64url(crypto.randomBytes(16));
  return new Promise((resolve, reject) => {
    let done = false;
    const finish = (err, val) => { if (done) return; done = true; clearTimeout(timer); server.close(); err ? reject(err) : resolve(val); };
    const page = (title, msg) => `<!doctype html><meta charset="utf-8"><title>KSTermus</title><body style="font-family:system-ui;background:#252423;color:#d4be98;display:grid;place-items:center;height:100vh;margin:0"><div style="text-align:center"><h2>${title}</h2><p>${msg}</p></div>`;
    const server = http.createServer(async (req, res) => {
      const u = new URL(req.url, 'http://127.0.0.1');
      if (u.pathname !== '/callback') { res.statusCode = 404; return res.end(); }
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      if (u.searchParams.get('state') !== state) { res.end(page('Requête invalide', 'Recommence depuis KSTermus.')); return finish(new Error('Réponse OAuth invalide (state)')); }
      const err = u.searchParams.get('error');
      if (err) { res.end(page('Connexion annulée', 'Tu peux fermer cet onglet.')); return finish(new Error(err === 'access_denied' ? 'Autorisation refusée sur Google' : 'Google : ' + err)); }
      const code = u.searchParams.get('code');
      try {
        const body = new URLSearchParams({ code, client_id: clientId, code_verifier: verifier, grant_type: 'authorization_code', redirect_uri: redirectUri });
        if (clientSecret) body.set('client_secret', clientSecret);
        const r = await fetch(E.tokenUrl, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: body.toString() });
        const j = await r.json();
        if (!r.ok || !j.refresh_token) throw new Error('Échange du code refusé : ' + (j.error_description || j.error || r.status));
        let email = '';
        try { email = JSON.parse(Buffer.from(String(j.id_token).split('.')[1], 'base64url').toString()).email || ''; } catch { /* sans id_token */ }
        res.end(page('✓ KSTermus est connecté à Google Drive', `Compte ${email || ''} — tu peux fermer cet onglet et revenir dans KSTermus.`));
        finish(null, { refreshToken: j.refresh_token, accessToken: j.access_token, expiresAt: Date.now() + (j.expires_in || 3600) * 1000, email });
      } catch (e) { res.end(page('Échec', e.message)); finish(e); }
    });
    let redirectUri = '';
    const timer = setTimeout(() => finish(new Error('Délai dépassé : connexion Google non terminée')), timeoutMs);
    server.on('error', (e) => finish(e));
    server.listen(0, '127.0.0.1', () => {
      redirectUri = `http://127.0.0.1:${server.address().port}/callback`;
      const q = new URLSearchParams({ client_id: clientId, redirect_uri: redirectUri, response_type: 'code', scope: SCOPES.join(' '),
        code_challenge: challenge, code_challenge_method: 'S256', state, access_type: 'offline', prompt: 'consent' });
      Promise.resolve(openExternal(`${E.authUrl}?${q}`)).catch((e) => finish(e));
    });
  });
}

// Stockage de synchronisation dans l'espace caché « appDataFolder ».
class GdriveBackend {
  constructor({ clientId, clientSecret, refreshToken, email, fileName = 'kstermus-sync.kst', fetch, endpoints = {}, tokenCache }) {
    Object.assign(this, { clientId, clientSecret, refreshToken, email, fileName, fetch, E: { ...DEFAULTS, ...endpoints } });
    this.cache = tokenCache || {};
  }
  describe() { return `Google Drive${this.email ? ' (' + this.email + ')' : ''} › espace caché KSTermus`; }

  async token() {
    if (this.cache.accessToken && this.cache.expiresAt > Date.now() + 60000) return this.cache.accessToken;
    if (!this.refreshToken) throw new Error('Pas connecté à Google : clique « Se connecter à Google »');
    const body = new URLSearchParams({ client_id: this.clientId, refresh_token: this.refreshToken, grant_type: 'refresh_token' });
    if (this.clientSecret) body.set('client_secret', this.clientSecret);
    const r = await this.fetch(this.E.tokenUrl, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: body.toString() });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) {
      if (j.error === 'invalid_grant') throw new Error('Accès Google révoqué ou expiré : reconnecte-toi (Paramètres ▸ Synchronisation)');
      throw new Error('Google (jeton) : ' + (j.error_description || j.error || r.status));
    }
    this.cache.accessToken = j.access_token;
    this.cache.expiresAt = Date.now() + (j.expires_in || 3600) * 1000;
    return j.access_token;
  }
  async api(url, opts = {}) {
    const r = await this.fetch(url, { ...opts, headers: { Authorization: `Bearer ${await this.token()}`, ...(opts.headers || {}) } });
    if (r.status === 401) { this.cache.accessToken = null; }
    return r;
  }
  async find() {
    const q = encodeURIComponent(`name='${this.fileName}' and trashed=false`);
    const r = await this.api(`${this.E.apiBase}/files?spaces=appDataFolder&q=${q}&fields=files(id,version,modifiedTime)&pageSize=10`);
    if (!r.ok) throw new Error('Google Drive (liste) : HTTP ' + r.status);
    const j = await r.json();
    return (j.files || [])[0] || null;
  }
  async check() { await this.token(); await this.find(); }
  async read() {
    const f = await this.find();
    if (!f) return null;
    const r = await this.api(`${this.E.apiBase}/files/${f.id}?alt=media`);
    if (!r.ok) throw new Error('Google Drive (lecture) : HTTP ' + r.status);
    return { text: await r.text(), ver: `${f.id}:${f.version}` };
  }
  async write(text, ver) {
    const f = await this.find();
    const cur = f ? `${f.id}:${f.version}` : null;
    if (cur !== (ver || null)) { const e = new Error('Modifié entre-temps par un autre PC'); e.code = 'CONFLICT'; throw e; }
    if (f) {
      const r = await this.api(`${this.E.uploadBase}/files/${f.id}?uploadType=media`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: text });
      if (!r.ok) throw new Error('Google Drive (écriture) : HTTP ' + r.status);
      return;
    }
    const boundary = 'kst' + crypto.randomBytes(8).toString('hex');
    const meta = JSON.stringify({ name: this.fileName, parents: ['appDataFolder'] });
    const body = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n--${boundary}\r\nContent-Type: application/json\r\n\r\n${text}\r\n--${boundary}--`;
    const r = await this.api(`${this.E.uploadBase}/files?uploadType=multipart`, { method: 'POST', headers: { 'Content-Type': `multipart/related; boundary=${boundary}` }, body });
    if (!r.ok) throw new Error('Google Drive (création) : HTTP ' + r.status);
  }
}

module.exports = { authorize, GdriveBackend, SCOPES };

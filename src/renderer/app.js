'use strict';
/* global Terminal, FitAddon, WebLinksAddon, SearchAddon */
(() => {
  const api = window.kst;

  // replaceChildren / append ignorent les valeurs vides (null, undefined, false) : pas de « null » affiché.
  for (const m of ['replaceChildren', 'append', 'prepend']) {
    const orig = Element.prototype[m];
    Element.prototype[m] = function (...kids) { return orig.apply(this, kids.flat(Infinity).filter(k => k !== null && k !== undefined && k !== false)); };
  }

  // ---------- Utilitaires DOM (jamais d'innerHTML avec des données) ----------
  function h(tag, attrs = {}, ...children) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === undefined || v === null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
      else if (k === 'text') el.textContent = v;
      else if (k === 'value') el.value = v;
      else if (v === true) el.setAttribute(k, '');
      else el.setAttribute(k, v);
    }
    for (const c of children.flat(Infinity)) {
      if (c === null || c === undefined || c === false) continue;
      el.append(c instanceof Node ? c : document.createTextNode(String(c)));
    }
    return el;
  }
  const $ = (s, r = document) => r.querySelector(s);
  const uid = () => (crypto.randomUUID ? crypto.randomUUID() : String(Math.random()).slice(2));
  const COLORS = ['#2dd4a7', '#5ab0ff', '#f5b84a', '#f2555a', '#c39bff', '#ff8fb1', '#9be15d', '#8b99a8'];

  function toast(msg, isErr = false) {
    const t = h('div', { class: 'toast' + (isErr ? ' err' : ''), text: msg });
    $('#toasts').append(t);
    setTimeout(() => t.remove(), isErr ? 7000 : 3500);
  }
  // Copie unique : n'écrit pas deux fois de suite le même texte (évite les doublons dans Win+V).
  let lastCopy = { text: null, at: 0 };
  function copyText(text) {
    if (!text) return;
    const now = Date.now();
    if (text === lastCopy.text && now - lastCopy.at < 1500) return;
    lastCopy = { text, at: now };
    api.invoke('clipboard:write', text);
  }

  async function guard(fn) {
    try { return await fn(); } catch (e) { toast(e.message || String(e), true); return undefined; }
  }
  function fmtSize(n) {
    if (n === undefined || n === null) return '';
    const u = ['o', 'Ko', 'Mo', 'Go', 'To']; let i = 0;
    while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
    return (i ? n.toFixed(1) : n) + ' ' + u[i];
  }
  const fmtDate = (ms) => new Date(ms).toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' });
  const posixJoin = (a, b) => (a.endsWith('/') ? a : a + '/') + b;
  const posixParent = (p) => { if (p === '/' || !p) return '/'; const x = p.replace(/\/+$/, '').split('/'); x.pop(); return x.join('/') || '/'; };

  // ---------- Modale générique ----------
  function modal({ title, body, actions, onOpen, wide }) {
    return new Promise(resolve => {
      const root = $('#modal-root');
      const close = (v) => { bd.remove(); document.removeEventListener('keydown', onKey, true); resolve(v); };
      const onKey = (e) => { if (e.key === 'Escape' && bd.isConnected && bd === root.lastElementChild) { e.preventDefault(); e.stopPropagation(); close(null); } };
      let busy = false;
      const run = async (a) => {
        if (busy) return;
        if (!a.onClick) return close(a.value === undefined ? null : a.value);
        busy = true;
        try { const r = await a.onClick(); if (r !== undefined && r !== false) close(r); } finally { busy = false; }
      };
      const footer = h('footer', {}, actions.map(a => h('button', {
        class: 'btn ' + (a.class || ''), type: a.submit ? 'submit' : 'button',
        onclick: a.submit ? null : () => run(a)
      }, a.label)));
      const form = h('form', { class: 'modal', style: wide ? { width: '640px' } : null }, h('header', { text: title }), h('div', { class: 'body' }, body), footer);
      form.addEventListener('submit', (e) => {
        e.preventDefault();
        const a = actions.find(x => x.submit);
        if (a) run(a);
      });
      const bd = h('div', { class: 'backdrop', onmousedown: (e) => { if (e.target === bd) close(null); } }, form);
      root.append(bd);
      document.addEventListener('keydown', onKey, true);
      if (onOpen) onOpen(form);
      const first = form.querySelector('input:not([type=hidden]):not([type=checkbox]), textarea, select') || form.querySelector('footer button[type=submit], footer button');
      if (document.activeElement) document.activeElement.blur();
      if (first) setTimeout(() => first.focus(), 30);
    });
  }
  // Champ secret : bouton afficher / masquer + bouton copier (presse-papiers effacé après 30 s).
  // reveal() : récupère la valeur enregistrée quand le champ est vide (mot de passe déjà stocké).
  function secretInput(input, { reveal, copy = true } = {}) {
    const eye = h('button', { type: 'button', class: 'icon-btn secret-btn sb-eye', title: 'Afficher', tabindex: '-1' }, '👁');
    const cp = copy ? h('button', { type: 'button', class: 'icon-btn secret-btn sb-copy', title: 'Copier', tabindex: '-1' }, '⧉') : null;
    const fill = async () => {
      if (input.value || !reveal) return input.value;
      const v = await guard(reveal);
      if (v) { input.value = v; input.dispatchEvent(new Event('input')); }
      return v || '';
    };
    eye.addEventListener('click', async () => {
      if (input.type === 'password') { await fill(); input.type = 'text'; eye.textContent = '🙈'; eye.title = 'Masquer'; }
      else { input.type = 'password'; eye.textContent = '👁'; eye.title = 'Afficher'; }
      input.focus();
    });
    if (cp) cp.addEventListener('click', async () => {
      const v = await fill();
      if (!v) { toast('Champ vide', true); return; }
      await api.invoke('clipboard:writeSecret', v);
      toast('Copié — effacé du presse-papiers dans 30 s');
    });
    return h('div', { class: 'secret' + (cp ? ' has-copy' : '') }, input, eye, cp);
  }

  const field = (label, input, hint) => h('label', { class: 'field' }, h('span', { text: label }), input, hint ? h('small', { class: 'muted', text: hint }) : null);
  const confirmBox = (title, text, okLabel = 'Supprimer') => modal({
    title, body: h('p', { text }),
    actions: [{ label: 'Annuler', value: false }, { label: okLabel, class: 'danger solid', value: true, submit: true }]
  });

  function popupMenu(anchor, items) {
    document.querySelectorAll('.menu').forEach(m => m.remove());
    const r = anchor.getBoundingClientRect();
    const m = h('div', { class: 'menu' }, items.length ? items.map(it => h('button', {
      class: 'menu-item', onclick: () => { m.remove(); it.onClick(); }
    }, it.label, it.sub ? h('span', { class: 'mono', text: it.sub }) : null)) : h('div', { class: 'menu-empty', text: 'Aucun élément' }));
    document.body.append(m);
    const left = Math.min(r.left, window.innerWidth - m.offsetWidth - 8);
    m.style.left = left + 'px';
    m.style.top = (r.bottom + 4) + 'px';
    setTimeout(() => document.addEventListener('mousedown', function off(e) {
      if (!m.contains(e.target)) { m.remove(); document.removeEventListener('mousedown', off); }
    }), 0);
  }

  // ---------- État ----------
  let S = null;                // état public renvoyé par le process principal
  const ui = { section: 'hosts', search: '', activeTab: 'home', lastTerm: null, shells: [], prefixAt: 0, localSessions: [] };
  const tabs = new Map();      // id -> session

  function setState(s) {
    S = s;
    if (S && S.sync !== undefined) renderSyncInd(S.sync);
    const wanted = S && S.settings ? (S.settings.theme && S.settings.theme !== 'dark' ? S.settings.theme : 'auto') : themeId;
    if (wanted !== themeId) applyTheme(wanted);
    renderSection(); renderTabs();
  }

  // ---------- Verrouillage ----------
  let lockWrapped = false;
  function wrapLockInputs() {
    if (lockWrapped) return;
    lockWrapped = true;
    for (const id of ['lock-pw', 'lock-pw2']) {
      const inp = $('#' + id);
      const parent = inp.parentNode;
      const box = secretInput(inp, { copy: id === 'lock-pw2' ? false : true });
      parent.append(box);
    }
  }

  // Deux modes : 'vault' (coffre fermé : création ou ouverture) et 'screen'
  // (écran verrouillé : sessions conservées, on revérifie juste l'identité).
  let lockMode = 'vault';
  async function initLock() {
    wrapLockInputs();
    const st = await api.invoke('vault:status');
    $('#lock-version').textContent = st.version ? 'KSTermus v' + st.version : '';
    if (st.unlocked && st.screenLocked) { showScreenLock(null, st); return; }
    if (st.unlocked) { setState(await api.invoke('state:get')); showApp(); return; }
    lockMode = 'vault';
    const creating = !st.exists;
    showLockScreen({
      hint: creating ? 'Crée ton mot de passe maître pour chiffrer le coffre.' : 'Coffre verrouillé.',
      btn: creating ? 'Créer le coffre' : 'Déverrouiller',
      creating, hello: !creating && st.helloStartup, full: false
    });
    if (!creating && st.helloStartup && autoHello) { autoHello = false; setTimeout(unlockWithHello, 300); }
  }
  let autoHello = true; // propose Hello automatiquement au lancement

  function showLockScreen({ hint, btn, creating, hello, full }) {
    $('#lock').hidden = false;
    $('#app').hidden = true;
    $('#lock-pw2-wrap').hidden = !creating;
    $('#lock-pw2').required = !!creating;
    $('#lock-hint').textContent = hint;
    $('#lock-btn').textContent = btn;
    $('#lock-hello').hidden = !hello;
    $('#lock-full').hidden = !full;
    $('#lock-restore').hidden = !!full;
    $('#lock-restore').textContent = 'Restaurer une sauvegarde (.kst) depuis un autre PC…';
    $('#lock-note').hidden = !!full;
    $('#lock-pw').value = ''; $('#lock-pw2').value = '';
    $('#lock-error').hidden = true;
    setTimeout(() => $('#lock-pw').focus(), 50);
    $('#lock-form').onsubmit = async (e) => {
      e.preventDefault();
      const pw = $('#lock-pw').value;
      const err = $('#lock-error');
      err.hidden = true;
      if (creating && !restoreInfo && pw !== $('#lock-pw2').value) { err.textContent = 'Les deux mots de passe diffèrent'; err.hidden = false; return; }
      $('#lock-btn').disabled = true;
      $('#lock-btn').textContent = lockMode === 'screen' ? 'Vérification…' : 'Déchiffrement…';
      try {
        if (restoreInfo) {
          const r = await api.invoke('vault:restore', pw);
          restoreInfo = null;
          unlocked(r.state);
          toast(restoreSummary(r.summary));
          return;
        }
        const ch = lockMode === 'screen' ? 'vault:unlockScreen' : creating ? 'vault:create' : 'vault:unlock';
        const s = await api.invoke(ch, pw);
        unlocked(s);
      } catch (ex) {
        err.textContent = ex.message; err.hidden = false;
        $('#lock-pw').select();
      } finally {
        $('#lock-btn').disabled = false;
        $('#lock-btn').textContent = restoreInfo ? 'Restaurer' : btn;
      }
    };
  }

  function unlocked(s) {
    const wasScreen = lockMode === 'screen';
    lockMode = 'vault';
    if (wasScreen) {
      S = s;
      $('#lock').hidden = true; $('#app').hidden = false;
      renderSection(); renderTabs();
      const t = tabs.get(ui.activeTab);
      if (t) { fitTab(t); requestAnimationFrame(() => { fitTab(t); if (t.kind === 'term') { const p = t.panes.get(t.activePane); if (p) p.term.focus(); } }); }
    } else { setState(s); showApp(); }
  }

  function showApp() {
    $('#lock').hidden = true; $('#app').hidden = false; activateTab('home');
    loadMonSnapshot();
    api.invoke('local:shells').then(list => { ui.shells = list || []; if (ui.section === 'local') renderSection(); }).catch(() => {});
  }

  // ----- Restauration d'une sauvegarde (autre PC, autre système) -----
  let restoreInfo = null;
  function restoreSummary(x) {
    return `Sauvegarde restaurée : ${x.hosts} host(s), ${x.keys} clé(s), ${x.snippets} snippet(s), ${x.forwards} tunnel(s)` + (x.history ? `, ${x.history} historique(s)` : '');
  }
  $('#lock-restore').onclick = async () => {
    if (restoreInfo) { restoreInfo = null; initLock(); return; } // « Annuler »
    const err = $('#lock-error'); err.hidden = true;
    let info;
    try { info = await api.invoke('vault:restorePick'); } catch (ex) { err.textContent = ex.message; err.hidden = false; return; }
    if (!info) return;
    restoreInfo = info;
    $('#lock-pw2-wrap').hidden = true; $('#lock-pw2').required = false;
    $('#lock-hello').hidden = true;
    $('#lock-hint').textContent = `Sauvegarde « ${info.file} »` + (info.createdAt ? ` du ${new Date(info.createdAt).toLocaleString('fr-FR')}` : '') +
      `. Entre le mot de passe maître du PC d'origine.` + (info.replaces ? ' Le coffre actuel de ce PC sera remplacé (une copie est gardée).' : '');
    $('#lock-btn').textContent = 'Restaurer';
    $('#lock-restore').textContent = 'Annuler la restauration';
    $('#lock-pw').value = ''; $('#lock-pw').focus();
  };

  async function restoreFromSettings() {
    if (!(await confirmBox('Restaurer une sauvegarde', 'Le coffre actuel sera remplacé par la sauvegarde (une copie de l\'actuel est gardée à côté). Les sessions et tunnels ouverts seront fermés.', 'Choisir le fichier'))) return;
    const info = await guard(() => api.invoke('vault:restorePick'));
    if (!info) return;
    const pw = h('input', { type: 'password' });
    const r = await modal({
      title: 'Restaurer « ' + info.file + ' »',
      body: [h('p', { class: 'muted small', text: (info.createdAt ? `Sauvegarde du ${new Date(info.createdAt).toLocaleString('fr-FR')}. ` : '') + 'Mot de passe maître du PC d\'origine :' }), secretInput(pw, { copy: false })],
      actions: [{ label: 'Annuler', value: null }, { label: 'Restaurer', class: 'primary', submit: true, onClick: async () => {
        try { return await api.invoke('vault:restore', pw.value); } catch (ex) { toast(ex.message, true); return false; }
      } }]
    });
    if (!r) return;
    for (const id of [...tabs.keys()]) disposeTab(id);
    setState(r.state);
    activateTab('home');
    toast(restoreSummary(r.summary));
  }

  async function unlockWithHello() {
    const b = $('#lock-hello'), err = $('#lock-error');
    if (b.disabled) return;
    err.hidden = true;
    b.disabled = true; b.textContent = '🙂 Regarde la caméra ou pose ton doigt…';
    try { unlocked(await api.invoke('hello:unlock')); }
    catch (ex) { err.textContent = ex.message; err.hidden = false; }
    finally { b.disabled = false; b.textContent = '🙂 Windows Hello'; }
  }
  $('#lock-hello').onclick = unlockWithHello;
  // Double clic de confirmation (une modale serait masquée par l'écran de verrouillage).
  let fullArmed = 0;
  $('#lock-full').onclick = async () => {
    const b = $('#lock-full');
    if (Date.now() - fullArmed > 4000) {
      fullArmed = Date.now();
      b.textContent = 'Clique encore pour tout fermer (sessions, terminaux, tunnels)';
      setTimeout(() => { b.textContent = 'Fermer toutes les sessions et verrouiller le coffre'; }, 4000);
      return;
    }
    fullArmed = 0;
    b.textContent = 'Fermer toutes les sessions et verrouiller le coffre';
    await fullLock();
  };

  function showScreenLock(reason, st) {
    if (!$('#lock').hidden && lockMode === 'screen') return;
    lockMode = 'screen';
    document.querySelectorAll('.palette').forEach(x => x.remove());
    setPrefix(false);
    const helloOn = st ? st.helloScreen : !!(S && S.settings.helloScreen);
    const n = [...tabs.values()].filter(t => t.kind !== 'edit').length;
    showLockScreen({
      hint: (reason === 'inactivité' ? 'Verrouillé après inactivité.' : reason && reason !== 'manuel' ? 'Verrouillé (' + reason + ').' : 'Écran verrouillé.') +
        (n ? ` ${n} onglet(s) toujours actif(s).` : ''),
      btn: 'Déverrouiller', creating: false, hello: helloOn, full: true
    });
    if (helloOn && api.platform === 'win32' && reason !== 'session Windows verrouillée') setTimeout(() => { if (lockMode === 'screen') unlockWithHello(); }, 300);
  }
  api.on('app:locked', ({ reason }) => showScreenLock(reason));

  async function fullLock() {
    for (const id of [...tabs.keys()]) disposeTab(id);
    await api.invoke('vault:lock');
    S = null;
    lockMode = 'vault';
    autoHello = false;
    initLock();
  }

  // Activité utilisateur (pour le verrouillage auto) — envoyée au plus toutes les 5 s.
  let lastPing = 0;
  for (const ev of ['keydown', 'mousedown', 'mousemove', 'wheel', 'touchstart']) {
    window.addEventListener(ev, () => { const now = Date.now(); if (now - lastPing > 5000 && $('#lock').hidden) { lastPing = now; api.activity(); } }, { capture: true, passive: true });
  }

  $('#btn-lock').onclick = (e) => popupMenu(e.currentTarget, [
    { label: '🔒 Verrouiller l\'écran', sub: 'Sessions et tunnels continuent — Ctrl+Shift+L', onClick: () => api.invoke('lock:screen').catch(() => {}) },
    { label: '⏏ Tout fermer et verrouiller le coffre', sub: 'Déconnecte tout, efface la clé de la mémoire', onClick: async () => {
      if (tabs.size && !(await confirmBox('Verrouiller le coffre', 'Toutes les sessions et tunnels seront fermés.', 'Verrouiller'))) return;
      await fullLock();
    } }
  ]);

  // ---------- Mises à jour ----------
  let U = { status: 'idle' };
  let updNotified = '';
  function fmtMB(n) { return n ? (n / 1048576).toFixed(0) + ' Mo' : ''; }
  function renderUpdatePill() {
    const pill = $('#update-pill');
    const st = U.status;
    pill.className = 'update-pill no-drag';
    pill.hidden = !['available', 'downloading', 'extracting', 'ready', 'downloaded'].includes(st);
    if (st === 'available' || st === 'downloaded') { pill.textContent = `⬆ ${U.version} disponible`; pill.title = 'Voir la mise à jour'; }
    else if (st === 'downloading') { pill.textContent = `⬇ ${U.version} · ${Math.round((U.progress || 0) * 100)} %`; pill.classList.add('busy'); pill.title = 'Téléchargement en arrière-plan'; }
    else if (st === 'extracting') { pill.textContent = `⬇ ${U.version} · préparation…`; pill.classList.add('busy'); }
    else if (st === 'ready') { pill.textContent = `⟳ Redémarrer pour ${U.version}`; pill.classList.add('ready'); pill.title = 'Mise à jour prête — sinon installée à la fermeture'; }
    const modalBar = document.querySelector('.update-bar > i');
    if (modalBar) modalBar.style.width = Math.round((U.progress || 0) * 100) + '%';
  }
  api.on('update:state', (st) => {
    const prev = U.status;
    U = st;
    renderUpdatePill();
    if (ui.section === 'settings' && ui.activeTab === 'home' && $('#upd-status')) $('#upd-status').textContent = updateStatusText();
    if ((st.status === 'available' || st.status === 'ready' || st.status === 'downloaded') && updNotified !== st.status + st.version && prev !== st.status && S) {
      updNotified = st.status + st.version;
      toast(st.status === 'ready' ? `KSTermus ${st.version} est prête — clique sur « Redémarrer »` : `KSTermus ${st.version} est disponible`);
    }
  });
  api.invoke('update:state').then(st => { U = st; renderUpdatePill(); }).catch(() => {});
  $('#update-pill').onclick = () => showUpdateModal();

  function updateStatusText() {
    switch (U.status) {
      case 'checking': return 'Vérification…';
      case 'none': return `À jour (v${U.current})` + (U.checkedAt ? ' — vérifié à ' + new Date(U.checkedAt).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' }) : '');
      case 'available': return `Version ${U.version} disponible`;
      case 'downloading': return `Téléchargement de ${U.version} : ${Math.round((U.progress || 0) * 100)} %`;
      case 'extracting': return `Préparation de ${U.version}…`;
      case 'ready': return `${U.version} prête : redémarre, ou elle s'installera à la fermeture`;
      case 'downloaded': return `${U.version} téléchargée — installe-la avec INSTALLER-KSTermus.cmd`;
      case 'installing': return 'Installation…';
      case 'error': return 'Erreur : ' + U.error;
      default: return `v${U.current || ''}`;
    }
  }

  async function showUpdateModal() {
    const st = U;
    const sessions = [...tabs.values()].filter(t => t.kind !== 'edit').length;
    const body = [
      h('div', { class: 'update-meta' },
        h('span', { text: `Actuelle : v${st.current}` }), h('span', { text: `Nouvelle : v${st.version}` }),
        st.size ? h('span', { text: fmtMB(st.size) }) : null,
        st.date ? h('span', { text: new Date(st.date).toLocaleDateString('fr-FR') }) : null),
      st.notes ? h('pre', { class: 'update-notes', text: st.notes }) : h('p', { class: 'muted', text: 'Pas de notes de version.' }),
      ['downloading', 'extracting'].includes(st.status) ? h('div', { class: 'update-bar' }, h('i', { style: { width: Math.round((st.progress || 0) * 100) + '%' } })) : null,
      h('p', { class: 'muted small', text: st.downloadable === false ? 'Sous Linux : télécharge le paquet (AppImage / .deb / .tar.gz) depuis la page de la release.' : 'Archive signée (Ed25519) et vérifiée (SHA-256) avant installation.' }),
      st.status === 'ready' && sessions ? h('p', { class: 'small', style: { color: 'var(--warn)' }, text: `⚠ ${sessions} onglet(s) ouvert(s) seront fermés au redémarrage.` }) : null
    ];
    const actions = [{ label: 'Plus tard', value: null }, { label: 'Page de la release', value: 'page' }];
    if (st.status === 'available' && st.downloadable) actions.push({ label: st.canInstall ? 'Télécharger et préparer' : 'Télécharger', class: 'primary', value: 'download' });
    if (st.status === 'available' && !st.downloadable) { actions.pop(); actions.push({ label: 'Ouvrir la page de la release', class: 'primary', value: 'page' }); }
    if (st.status === 'ready') actions.push({ label: 'Redémarrer maintenant', class: 'primary', value: 'install' });
    const r = await modal({ title: `KSTermus ${st.version}`, body, actions, wide: true });
    if (r === 'page') api.invoke('update:openPage');
    else if (r === 'download') { const s2 = await guard(() => api.invoke('update:download')); if (s2 && s2.status === 'error') toast(s2.error, true); }
    else if (r === 'install') await guard(() => api.invoke('update:install'));
  }

  function updateRow() {
    const status = h('div', { class: 'muted small', id: 'upd-status', text: updateStatusText() });
    const auto = h('input', { type: 'checkbox', style: { width: '18px', height: '18px' }, title: 'Vérifier et télécharger automatiquement' });
    auto.checked = S.settings.autoUpdate !== false;
    auto.addEventListener('change', async () => { const s = await guard(() => api.invoke('settings:save', { autoUpdate: auto.checked })); if (s) S = s; });
    const btn = h('button', { class: 'btn sm', onclick: async () => {
      btn.disabled = true;
      const st = await guard(() => api.invoke('update:check'));
      btn.disabled = false;
      if (st && st.status === 'available') showUpdateModal();
      else if (st && st.status === 'none') toast('KSTermus est à jour');
    } }, 'Vérifier');
    return h('div', { class: 'row' },
      h('div', { class: 'row-main' }, h('div', { class: 'row-title', text: 'Mises à jour automatiques' }),
        h('div', { class: 'muted small', text: 'Depuis GitHub Releases, au démarrage puis toutes les 6 h. Téléchargement en arrière-plan ; jamais de redémarrage sans ton accord.' }), status),
      h('div', { style: { display: 'flex', gap: '10px', alignItems: 'center' } }, btn, auto));
  }

  // ---------- Navigation ----------
  document.querySelectorAll('.nav-item').forEach(b => b.addEventListener('click', () => {
    ui.section = b.dataset.section;
    document.querySelectorAll('.nav-item').forEach(x => x.classList.toggle('active', x === b));
    renderSection();
  }));

  function renderSection() {
    if (!S) return;
    const el = $('#section');
    el.replaceChildren(({
      hosts: viewHosts, keychain: viewKeychain, snippets: viewSnippets,
      forwards: viewForwards, vpn: viewVpn, audit: viewAudit, dashboard: viewDashboard, known: viewKnown, settings: viewSettings, history: viewHistory, local: viewLocal
    })[ui.section]());
  }

  // ---------- Hosts ----------
  const hostById = (id) => S.hosts.find(x => x.id === id);
  const initials = (s) => (s || '?').replace(/[^\p{L}\p{N} ]/gu, ' ').trim().split(/\s+/).slice(0, 2).map(w => w[0]).join('').toUpperCase() || '?';

  function viewHosts() {
    const q = ui.search.toLowerCase();
    const list = S.hosts.filter(x => !q || [x.label, x.hostname, x.username, x.group].join(' ').toLowerCase().includes(q));
    const search = h('input', { class: 'search', placeholder: 'Rechercher…', value: ui.search });
    search.addEventListener('input', () => {
      ui.search = search.value; renderSection();
      const s = $('#section .search'); s.focus(); s.setSelectionRange(s.value.length, s.value.length);
    });
    const head = h('div', { class: 'section-head' },
      h('h1', { text: 'Hosts' }), search,
      h('button', { class: 'btn', onclick: importConfig, title: 'Importer les hosts d\'un fichier ~/.ssh/config' }, 'Importer config'),
      h('button', { class: 'btn primary', onclick: () => editHost() }, '+ Nouveau host'));
    if (!S.hosts.length) {
      return h('div', {}, head, h('div', { class: 'empty' }, h('div', { text: 'Aucun host pour l\'instant.' }),
        h('button', { class: 'btn primary', onclick: () => editHost() }, 'Ajouter un host')));
    }
    const groups = new Map();
    for (const x of list) { const g = x.group || 'Sans groupe'; if (!groups.has(g)) groups.set(g, []); groups.get(g).push(x); }
    const names = [...groups.keys()].sort((a, b) => a === 'Sans groupe' ? 1 : b === 'Sans groupe' ? -1 : a.localeCompare(b));
    return h('div', {}, head, names.map(g => [
      groupTitle(g, groups.get(g).length),
      h('div', { class: 'grid' }, groups.get(g).sort((a, b) => a.label.localeCompare(b.label)).map(hostCard))
    ]), !list.length ? h('div', { class: 'empty', text: 'Aucun résultat.' }) : null);
  }

  function jumpChain(x) {
    const out = []; const seen = new Set([x.id]);
    let cur = x.jumpHostId && hostById(x.jumpHostId);
    while (cur && !seen.has(cur.id)) { out.unshift(cur.label); seen.add(cur.id); cur = cur.jumpHostId && hostById(cur.jumpHostId); }
    return out;
  }

  function envBadge(env) {
    if (!env) return null;
    const L = { prod: 'PROD', staging: 'RECETTE', dev: 'DEV' };
    return h('span', { class: 'env-badge env-' + env, text: L[env] || env });
  }
  function hostCard(x) {
    const authLabel = { password: 'mot de passe', key: 'clé', agent: 'agent' }[x.auth] || x.auth;
    const card = h('div', { class: 'card' + (x.env === 'prod' ? ' card-prod' : ''), ondblclick: () => openTerminal(x.id) },
      h('div', { class: 'card-top' },
        h('div', { class: 'avatar', style: { background: x.color || COLORS[0] }, text: initials(x.label) }),
        h('div', { style: { minWidth: 0, flex: 1 } },
          h('div', { class: 'card-title' }, h('span', { text: x.label }), envBadge(x.env), x.record ? h('span', { class: 'rec-badge', title: 'Sessions enregistrées' }, '●REC') : null),
          h('div', { class: 'card-sub-row' }, h('span', { class: 'card-sub', text: `${x.username}@${x.hostname}${x.port !== 22 ? ':' + x.port : ''}` }), h('span', { class: 'badge auth-badge', text: authLabel })),
          vpnBadge(x), monMini(x),
          x.jumpHostId && hostById(x.jumpHostId) ? h('div', { class: 'card-via', title: 'Connexion via un jump host', text: `↪ via ${jumpChain(x).join(' → ')}` }) : null)),
      h('div', { class: 'card-actions' },
        h('button', { class: 'btn primary sm', onclick: (e) => { e.stopPropagation(); openTerminal(x.id); } }, 'SSH'),
        h('button', { class: 'btn sm', onclick: (e) => { e.stopPropagation(); openSftp(x.id); } }, 'SFTP'),
        h('span', { class: 'spacer' }),
        x.hasPassword ? h('button', { class: 'icon-btn ci', title: 'Copier le mot de passe (effacé après 30 s)', onclick: async (e) => {
          e.stopPropagation();
          if (await guard(() => api.invoke('host:copyPassword', x.id))) toast('Mot de passe copié — effacé dans 30 s');
        } }, ico('key')) : null,
        h('button', { class: 'icon-btn ci', title: 'Modifier', onclick: (e) => { e.stopPropagation(); editHost(x); } }, ico('edit')),
        h('button', { class: 'icon-btn ci', title: 'Dupliquer', onclick: (e) => { e.stopPropagation(); editHost({ ...x, id: null, label: x.label + ' (copie)', hasPassword: false }); } }, ico('copy')),
        h('button', { class: 'icon-btn ci ci-danger', title: 'Supprimer', onclick: async (e) => {
          e.stopPropagation();
          if (await confirmBox('Supprimer le host', `Supprimer « ${x.label} » et ses tunnels ?`)) {
            const s = await guard(() => api.invoke('host:delete', x.id)); if (s) setState(s);
          }
        } }, ico('trash'))));
    return card;
  }
  // Icônes au trait (identiques sur Windows, Linux et macOS, contrairement aux emoji).
  const ICONS = {
    key: '<circle cx="5.5" cy="10.5" r="3"/><path d="M7.6 8.4 14 2M11.5 4.5l2 2M10 6l1.5 1.5"/>',
    edit: '<path d="M10.5 2.5l3 3L6 13H3v-3z"/><path d="M9 4l3 3"/>',
    copy: '<rect x="5.5" y="5.5" width="8" height="8" rx="1.5"/><path d="M10.5 5.5V3.8c0-.7-.6-1.3-1.3-1.3H3.8c-.7 0-1.3.6-1.3 1.3v5.4c0 .7.6 1.3 1.3 1.3h1.7"/>',
    trash: '<path d="M2.5 4.5h11M6.5 4.5V3c0-.3.2-.5.5-.5h2c.3 0 .5.2.5.5v1.5M4 4.5l.7 8.6c0 .5.5.9 1 .9h4.6c.5 0 1-.4 1-.9l.7-8.6M6.8 7v4.5M9.2 7v4.5"/>'
  };
  function ico(name) {
    const sp = document.createElement('span');
    sp.className = 'ico';
    sp.innerHTML = `<svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round">${ICONS[name]}</svg>`;
    return sp;
  }

  async function importConfig() {
    const r = await guard(() => api.invoke('host:importSshConfig'));
    if (!r) return;
    setState(r.state);
    toast(r.added ? `${r.added} host(s) importé(s) dans le groupe « Importés »` : 'Aucun nouveau host trouvé');
  }

  function editHost(x = {}) {
    const isNew = !x.id;
    const f = {
      label: h('input', { value: x.label || '', placeholder: 'Prod API' }),
      group: h('input', { value: x.group || '', placeholder: 'QOS, EFB, VPS…', list: 'groups-dl' }),
      hostname: h('input', { value: x.hostname || '', placeholder: '192.168.1.10 ou serveur.exemple.com', required: true }),
      port: h('input', { type: 'number', value: x.port || 22, min: 1, max: 65535 }),
      username: h('input', { value: x.username || 'root', required: true }),
      auth: h('select', {}, h('option', { value: 'password', text: 'Mot de passe' }), h('option', { value: 'key', text: 'Clé du keychain' }), h('option', { value: 'agent', text: 'Agent SSH (Pageant / OpenSSH)' })),
      password: h('input', { type: 'password', placeholder: x.hasPassword ? '•••••• (enregistré)' : 'Optionnel', autocomplete: 'off' }),
      clear: h('input', { type: 'checkbox' }),
      sudoPassword: h('input', { type: 'password', placeholder: x.hasSudoPassword ? '•••••• (enregistré)' : 'Vide = même que le mot de passe SSH', autocomplete: 'off' }),
      clearSudo: h('input', { type: 'checkbox' }),
      keyId: h('select', {}, S.keys.length ? S.keys.map(k => h('option', { value: k.id, text: `${k.label} (${k.type})` })) : h('option', { value: '', text: 'Aucune clé — ajoute-en une dans Keychain' })),
      startup: h('input', { value: x.startupCommand || '', placeholder: 'ex. cd /var/www && ls' }),
      jump: h('select', {}, h('option', { value: '', text: 'Connexion directe' }),
        S.hosts.filter(z => z.id !== x.id).sort((a, b) => a.label.localeCompare(b.label)).map(z => h('option', { value: z.id, text: `${z.label} (${z.username}@${z.hostname})` }))),
      env: h('select', {}, h('option', { value: '', text: '—' }), h('option', { value: 'dev', text: 'Développement' }), h('option', { value: 'staging', text: 'Recette / staging' }), h('option', { value: 'prod', text: '🔴 PRODUCTION' })),
      record: h('input', { type: 'checkbox' }),
      monitor: h('input', { type: 'checkbox' }),
      si: h('input', { type: 'checkbox' }),
      monitorServices: h('input', { placeholder: 'nginx, docker, mysql, php8.3-fpm…', spellcheck: 'false' }),
      vpn: h('select', {}, h('option', { value: '', text: 'Comme le groupe' }), h('option', { value: 'none', text: 'Aucun VPN' }),
        (S.vpns || []).map(v => h('option', { value: v.id, text: '🌐 ' + v.name })))
    };
    f.env.value = x.env || '';
    f.record.checked = !!x.record;
    f.monitor.checked = !!x.monitor;
    f.si.checked = x.shellIntegration !== false;
    f.monitorServices.value = x.monitorServices || '';
    f.vpn.value = x.vpnId && (x.vpnId === 'none' || (S.vpns || []).some(v => v.id === x.vpnId)) ? x.vpnId : '';
    const vpnHint = () => {
      const gv = (S.groupVpns || {})[f.group.value.trim()];
      const gName = gv && (S.vpns || []).find(v => v.id === gv);
      f.vpn.options[0].text = gName ? `Comme le groupe (🌐 ${gName.name})` : 'Comme le groupe (aucun VPN)';
    };
    f.group.addEventListener('input', vpnHint); vpnHint();
    f.auth.value = x.auth || 'password';
    f.jump.value = x.jumpHostId && S.hosts.some(z => z.id === x.jumpHostId) ? x.jumpHostId : '';
    if (x.keyId) f.keyId.value = x.keyId;
    let color = x.color || COLORS[0];
    const swatches = h('div', { class: 'swatches' }, COLORS.map(c => {
      const s = h('span', { class: 'swatch' + (c === color ? ' sel' : ''), style: { background: c }, onclick: () => {
        color = c; swatches.querySelectorAll('.swatch').forEach(z => z.classList.toggle('sel', z === s));
      } });
      return s;
    }));
    const groupsDl = h('datalist', { id: 'groups-dl' }, [...new Set(S.hosts.map(z => z.group).filter(Boolean))].map(g => h('option', { value: g })));
    const keyWrap = field('Clé', f.keyId);
    const pwWrap = field(f.auth.value === 'key' ? 'Mot de passe (repli, optionnel)' : 'Mot de passe',
      secretInput(f.password, { reveal: x.id && x.hasPassword ? () => api.invoke('host:revealPassword', x.id) : null }));
    const clearWrap = x.hasPassword ? h('label', { class: 'check' }, f.clear, 'Effacer le mot de passe enregistré') : null;
    const sudoWrap = field('Mot de passe sudo (éditeur en sudo)',
      secretInput(f.sudoPassword, { reveal: x.id && x.hasSudoPassword ? () => api.invoke('host:revealPassword', x.id, 'sudo') : null }));
    const clearSudoWrap = x.hasSudoPassword ? h('label', { class: 'check' }, f.clearSudo, 'Effacer le mot de passe sudo enregistré') : null;
    const sync = () => {
      keyWrap.hidden = f.auth.value !== 'key';
      pwWrap.hidden = f.auth.value === 'agent';
      pwWrap.querySelector('span').textContent = f.auth.value === 'key' ? 'Mot de passe (repli, optionnel)' : 'Mot de passe';
    };
    f.auth.addEventListener('change', sync); sync();

    return modal({
      title: isNew ? 'Nouveau host' : 'Modifier le host',
      body: [groupsDl,
        h('div', { class: 'form-row' }, field('Nom', f.label), field('Groupe', f.group)),
        h('div', { class: 'form-row' }, field('Adresse', f.hostname), h('div', { class: 'narrow' }, field('Port', f.port))),
        field('Utilisateur', f.username),
        field('Authentification', f.auth), keyWrap, pwWrap, clearWrap,
        sudoWrap, clearSudoWrap,
        h('div', { class: 'form-row' }, field('Environnement', f.env, 'PROD : confirmation obligatoire avant toute commande dangereuse (rm -rf, DROP, reboot…).'),
          h('label', { class: 'check', style: { alignSelf: 'center', marginTop: '14px' } }, f.record, 'Enregistrer les sessions')),
        h('div', { class: 'form-row' }, h('label', { class: 'check', style: { alignSelf: 'center', marginTop: '14px', whiteSpace: 'nowrap' } }, f.monitor, 'Surveiller (tableau de bord)'),
          field('Services à surveiller', f.monitorServices)),
        h('label', { class: 'check', title: 'bash / zsh : statut et durée de chaque commande, dossier courant, notification des commandes longues. Rien n\'est installé sur le serveur.' }, f.si, 'Intégration shell (bash / zsh)'),
        field('VPN WireGuard', f.vpn, 'Démarré automatiquement à la connexion. Avec un jump host, c\'est le VPN du bastion qui compte.'),
        field('Passer par (jump host / bastion)', f.jump, 'La connexion passe d\'abord par ce serveur, qui peut lui-même passer par un autre (plusieurs rebonds).'),
        field('Commande au démarrage', f.startup),
        field('Couleur', swatches)],
      actions: [{ label: 'Annuler', value: false }, {
        label: 'Enregistrer', class: 'primary', submit: true, onClick: async () => {
          const s = await guard(() => api.invoke('host:save', {
            id: x.id || null, label: f.label.value, group: f.group.value, hostname: f.hostname.value,
            port: f.port.value, username: f.username.value, auth: f.auth.value, keyId: f.keyId.value,
            password: f.password.value, clearPassword: f.clear.checked,
            sudoPassword: f.sudoPassword.value, clearSudoPassword: f.clearSudo.checked, startupCommand: f.startup.value, color,
            jumpHostId: f.jump.value || null, vpnId: f.vpn.value, env: f.env.value, record: f.record.checked,
            monitor: f.monitor.checked, monitorServices: f.monitorServices.value, shellIntegration: f.si.checked
          }));
          if (!s) return false;
          setState(s); return true;
        }
      }]
    });
  }

  // ---------- Keychain ----------
  function viewKeychain() {
    return h('div', {},
      h('div', { class: 'section-head' }, h('h1', { text: 'Keychain' }),
        h('button', { class: 'btn', onclick: importKey }, 'Importer une clé'),
        h('button', { class: 'btn primary', onclick: generateKey }, '+ Générer')),
      S.keys.length ? h('div', { class: 'list' }, S.keys.map(k => h('div', { class: 'row' },
        h('div', { class: 'avatar', style: { background: 'var(--bg-4)', color: 'var(--accent)' }, text: '🔑' }),
        h('div', { class: 'row-main' },
          h('div', { class: 'row-title' }, k.label, h('span', { class: 'badge', text: k.type }), k.hasPassphrase ? h('span', { class: 'badge ok', text: 'passphrase' }) : null,
            h('span', { class: 'muted small', text: `· ${S.hosts.filter(x => x.keyId === k.id).length} host(s)` })),
          h('div', { class: 'row-sub', text: k.fingerprint })),
        h('div', { class: 'row-actions' },
          h('button', { class: 'btn sm', onclick: async () => { await api.invoke('clipboard:write', k.publicKey); toast('Clé publique copiée'); } }, 'Copier la clé publique'),
          k.hasPassphrase ? h('button', { class: 'icon-btn', title: 'Copier la passphrase (effacée après 30 s)', onclick: async () => {
            const v = await guard(() => api.invoke('key:revealPassphrase', k.id));
            if (v) { await api.invoke('clipboard:writeSecret', v); toast('Passphrase copiée — effacée dans 30 s'); }
          } }, '🔑') : null,
          h('button', { class: 'icon-btn', title: 'Exporter la clé privée', onclick: async () => {
            if (!(await confirmBox('Exporter la clé privée', 'La clé sera écrite en clair (ou chiffrée par sa passphrase) dans le fichier choisi.', 'Exporter'))) return;
            const p = await guard(() => api.invoke('key:exportPrivate', k.id)); if (p) toast('Exportée : ' + p);
          } }, '⤓'),
          h('button', { class: 'icon-btn', title: 'Renommer', onclick: async () => {
            const inp = h('input', { value: k.label });
            const v = await modal({ title: 'Renommer la clé', body: field('Nom', inp), actions: [{ label: 'Annuler', value: false }, { label: 'OK', class: 'primary', submit: true, onClick: () => inp.value.trim() || false }] });
            if (v) { const s = await guard(() => api.invoke('key:rename', k.id, v)); if (s) setState(s); }
          } }, '✎'),
          h('button', { class: 'icon-btn', title: 'Supprimer', onclick: async () => {
            if (await confirmBox('Supprimer la clé', `Supprimer « ${k.label} » du keychain ?`)) { const s = await guard(() => api.invoke('key:delete', k.id)); if (s) setState(s); }
          } }, '🗑'))))) :
        h('div', { class: 'empty', text: 'Aucune clé. Importe ta clé existante ou génère une clé ed25519.' }));
  }

  function importKey() {
    const label = h('input', { placeholder: 'ma-cle-prod' });
    const text = h('textarea', { placeholder: '-----BEGIN OPENSSH PRIVATE KEY-----', rows: 8 });
    const pass = h('input', { type: 'password', placeholder: 'Si la clé est chiffrée', autocomplete: 'off' });
    const pick = h('button', { class: 'btn sm', type: 'button', onclick: async () => {
      const r = await guard(() => api.invoke('key:pickFile'));
      if (r) { text.value = r.content; if (!label.value) label.value = r.name; }
    } }, 'Choisir un fichier…');
    return modal({
      title: 'Importer une clé privée', wide: true,
      body: [field('Nom', label), h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center' } }, h('span', { class: 'muted small', text: 'OpenSSH, PEM (RSA / ECDSA / ed25519) ou PuTTY .ppk' }), pick), text, field('Passphrase', secretInput(pass))],
      actions: [{ label: 'Annuler', value: false }, { label: 'Importer', class: 'primary', submit: true, onClick: async () => {
        const s = await guard(() => api.invoke('key:import', { label: label.value.trim(), privateKey: text.value.trim() + '\n', passphrase: pass.value }));
        if (!s) return false; setState(s); toast('Clé importée'); return true;
      } }]
    });
  }

  function generateKey() {
    const label = h('input', { placeholder: 'vivobook-ed25519' });
    const type = h('select', {}, h('option', { value: 'ed25519', text: 'ed25519 (recommandé)' }), h('option', { value: 'rsa', text: 'RSA 4096' }));
    const pass = h('input', { type: 'password', placeholder: 'Optionnel' });
    return modal({
      title: 'Générer une paire de clés',
      body: [field('Nom', label), field('Type', type), field('Passphrase', secretInput(pass))],
      actions: [{ label: 'Annuler', value: false }, { label: 'Générer', class: 'primary', submit: true, onClick: async () => {
        const s = await guard(() => api.invoke('key:generate', { label: label.value.trim(), type: type.value, passphrase: pass.value }));
        if (!s) return false;
        setState(s);
        const k = s.keys[s.keys.length - 1];
        await api.invoke('clipboard:write', k.publicKey);
        toast('Clé générée — clé publique copiée dans le presse-papiers');
        return true;
      } }]
    });
  }

  // ---------- Snippets ----------
  function viewSnippets() {
    return h('div', {},
      h('div', { class: 'section-head' }, h('h1', { text: 'Snippets' }), h('button', { class: 'btn primary', onclick: () => editSnippet() }, '+ Nouveau snippet')),
      S.snippets.length ? h('div', { class: 'list' }, S.snippets.map(sn => h('div', { class: 'row' },
        h('div', { class: 'row-main' }, h('div', { class: 'row-title' }, sn.name, sn.autoRun ? h('span', { class: 'badge ok', text: 'exécution auto' }) : null), h('div', { class: 'row-sub', text: sn.command })),
        h('div', { class: 'row-actions' },
          h('button', { class: 'btn primary sm', onclick: () => runSnippet(sn) }, 'Exécuter'),
          h('button', { class: 'icon-btn', title: 'Copier', onclick: async () => { await api.invoke('clipboard:write', sn.command); toast('Copié'); } }, '⧉'),
          h('button', { class: 'icon-btn', title: 'Modifier', onclick: () => editSnippet(sn) }, '✎'),
          h('button', { class: 'icon-btn', title: 'Supprimer', onclick: async () => {
            if (await confirmBox('Supprimer le snippet', `Supprimer « ${sn.name} » ?`)) { const s = await guard(() => api.invoke('snippet:delete', sn.id)); if (s) setState(s); }
          } }, '🗑'))))) :
        h('div', { class: 'empty', text: 'Enregistre tes commandes fréquentes (déploiement, logs, docker…) et envoie-les dans un terminal en un clic.' }));
  }

  function editSnippet(sn = {}) {
    const name = h('input', { value: sn.name || '', placeholder: 'Logs nginx' });
    const cmd = h('textarea', { value: sn.command || '', placeholder: 'sudo tail -f /var/log/nginx/error.log', rows: 5 });
    const auto = h('input', { type: 'checkbox' }); auto.checked = sn.autoRun !== false;
    return modal({
      title: sn.id ? 'Modifier le snippet' : 'Nouveau snippet',
      body: [field('Nom', name), field('Commande(s)', cmd, 'Paramètres façon Warp : {{nom}} ou {{nom:valeur par défaut}} — demandés à l\'envoi. Ex. docker logs -f {{conteneur:api}}'), h('label', { class: 'check' }, auto, 'Appuyer sur Entrée après l\'envoi')],
      actions: [{ label: 'Annuler', value: false }, { label: 'Enregistrer', class: 'primary', submit: true, onClick: async () => {
        const s = await guard(() => api.invoke('snippet:save', { id: sn.id, name: name.value, command: cmd.value, autoRun: auto.checked }));
        if (!s) return false; setState(s); return true;
      } }]
    });
  }

  // Snippets paramétrés façon « workflows » Warp : {{nom}} ou {{nom:valeur par défaut}} est demandé avant l'envoi.
  async function snippetData(sn) {
    let cmd = sn.command;
    const params = [...new Map([...cmd.matchAll(/\{\{\s*([\w.-]+)(?::([^}]*))?\s*\}\}/g)].map(m => [m[1], m[2] || ''])).entries()];
    if (params.length) {
      const inputs = params.map(([name, def]) => [name, h('input', { value: def, placeholder: name })]);
      const vals = await modal({
        title: `Paramètres : ${sn.name}`,
        body: [h('pre', { class: 'snippet-preview', text: sn.command }), ...inputs.map(([n, i]) => field(n, i))],
        actions: [{ label: 'Annuler', value: false }, { label: 'Envoyer', class: 'primary', submit: true, onClick: () => Object.fromEntries(inputs.map(([n, i]) => [n, i.value])) }]
      });
      if (!vals) return null;
      cmd = cmd.replace(/\{\{\s*([\w.-]+)(?::[^}]*)?\s*\}\}/g, (_m, n) => vals[n] ?? '');
    }
    let data = cmd.replace(/\r?\n/g, '\r');
    if (sn.autoRun && !data.endsWith('\r')) data += '\r';
    if (!sn.autoRun) data = data.replace(/\r$/, '');
    return data;
  }

  // Envoie un snippet au panneau actif de l'onglet (ou à tous les panneaux si la diffusion est active).
  function sendSnippet(tabId, sn) {
    const t = tabs.get(tabId);
    if (!t || t.kind !== 'term') return;
    const targets = (t.broadcast ? [...t.panes.values()] : [t.panes.get(t.activePane)]).filter(p => p && p.status === 'on');
    if (!targets.length) { toast('Aucun terminal connecté dans cet onglet', true); return; }
    snippetData(sn).then(data => {
      if (data === null) return;
      for (const p of targets) { if (data.includes('\r')) markCommand(p); api.write(p.id, data); }
      activateTab(tabId);
    });
  }

  function runSnippet(sn) {
    const terms = [...tabs.values()].filter(t => t.kind === 'term' && statusOf(t) === 'on');
    if (!terms.length) { toast('Ouvre d\'abord un terminal (SSH ou local)', true); return; }
    const target = terms.find(t => t.id === ui.lastTerm) || terms[0];
    if (terms.length === 1) return sendSnippet(target.id, sn);
    const sel = h('select', {}, terms.map(t => h('option', { value: t.id, text: tabTitle(t) })));
    sel.value = target.id;
    modal({ title: 'Envoyer vers…', body: field('Onglet', sel), actions: [{ label: 'Annuler', value: false }, { label: 'Envoyer', class: 'primary', submit: true, onClick: () => { sendSnippet(sel.value, sn); return true; } }] });
  }

  // ---------- Port forwarding ----------
  function forwardDesc(f) {
    const host = hostById(f.hostId);
    const via = host ? host.label : '?';
    if (f.type === 'L') return `${f.bindHost}:${f.bindPort} → ${f.destHost}:${f.destPort}  (via ${via})`;
    if (f.type === 'R') return `${via}:${f.bindPort} → ${f.destHost}:${f.destPort}  (côté local)`;
    return `SOCKS5 ${f.bindHost}:${f.bindPort}  (via ${via})`;
  }
  function viewForwards() {
    const typeName = { L: 'Local', R: 'Distant', D: 'Dynamique' };
    return h('div', {},
      h('div', { class: 'section-head' }, h('h1', { text: 'Port forwarding' }), h('button', { class: 'btn primary', onclick: () => editForward() }, '+ Nouveau tunnel')),
      S.forwards.length ? h('div', { class: 'list' }, S.forwards.map(f => {
        const st = S.tunnels && S.tunnels[f.id];
        const active = !!(st && st.active);
        const retrying = !!(st && st.reconnecting);
        return h('div', { class: 'row' },
          h('span', { class: 'dot ' + (active ? 'on' : retrying ? 'wait' : '') }),
          h('div', { class: 'row-main' },
            h('div', { class: 'row-title' }, f.label || typeName[f.type], h('span', { class: 'badge ' + f.type, text: typeName[f.type] }),
              retrying ? h('span', { class: 'badge R', text: `reconnexion… (tentative ${st.attempt})` }) : null,
              f.autoReconnect === false ? h('span', { class: 'badge', text: 'sans relance auto' }) : null),
            h('div', { class: 'row-sub', text: forwardDesc(f) })),
          h('div', { class: 'row-actions' },
            (active || retrying) ? h('button', { class: 'btn sm', onclick: async () => { await guard(() => api.invoke('tunnel:stop', f.id)); refresh(); } }, 'Arrêter')
              : h('button', { class: 'btn primary sm', onclick: async (e) => {
                e.target.disabled = true; e.target.textContent = 'Connexion…';
                const ok = await guard(() => api.invoke('tunnel:start', f.id));
                if (ok) toast(`Tunnel actif : ${forwardDesc(f)}`);
                refresh();
              } }, 'Démarrer'),
            h('button', { class: 'icon-btn', title: 'Modifier', onclick: () => editForward(f) }, '✎'),
            h('button', { class: 'icon-btn', title: 'Supprimer', onclick: async () => {
              if (await confirmBox('Supprimer le tunnel', 'Supprimer cette règle ?')) { const s = await guard(() => api.invoke('forward:delete', f.id)); if (s) setState(s); }
            } }, '🗑')));
      })) : h('div', { class: 'empty', text: 'Local : accède à une base distante sur 127.0.0.1. Distant : expose un port local sur le serveur. Dynamique : proxy SOCKS5 via le serveur.' }));
  }

  function editForward(f = {}) {
    if (!S.hosts.length) { toast('Ajoute d\'abord un host', true); return; }
    const label = h('input', { value: f.label || '', placeholder: 'Postgres prod' });
    const type = h('select', {}, h('option', { value: 'L', text: 'Local (-L)' }), h('option', { value: 'R', text: 'Distant (-R)' }), h('option', { value: 'D', text: 'Dynamique SOCKS5 (-D)' }));
    type.value = f.type || 'L';
    const host = h('select', {}, S.hosts.map(x => h('option', { value: x.id, text: `${x.label} (${x.username}@${x.hostname})` })));
    if (f.hostId) host.value = f.hostId;
    const bindHost = h('input', { value: f.bindHost || '127.0.0.1' });
    const bindPort = h('input', { type: 'number', value: f.bindPort || '', placeholder: '5433', min: 1, max: 65535 });
    const destHost = h('input', { value: f.destHost || '127.0.0.1' });
    const destPort = h('input', { type: 'number', value: f.destPort || '', placeholder: '5432', min: 1, max: 65535 });
    const bindLbl = h('span', {}), destLbl = h('span', {});
    const bindRow = h('div', { class: 'form-row' }, h('label', { class: 'field' }, bindLbl, bindHost), h('label', { class: 'field narrow' }, h('span', { text: 'Port' }), bindPort));
    const destRow = h('div', { class: 'form-row' }, h('label', { class: 'field' }, destLbl, destHost), h('label', { class: 'field narrow' }, h('span', { text: 'Port' }), destPort));
    const help = h('div', { class: 'callout small' });
    const autoRc = h('input', { type: 'checkbox' }); autoRc.checked = f.autoReconnect !== false;
    const sync = () => {
      const t = type.value;
      bindLbl.textContent = t === 'R' ? 'Écoute sur le serveur' : 'Écoute locale';
      destLbl.textContent = t === 'R' ? 'Destination (depuis ton PC)' : 'Destination (depuis le serveur)';
      destRow.hidden = t === 'D';
      help.textContent = t === 'L' ? 'Ton PC écoute sur le port local ; le trafic sort du serveur SSH vers la destination.'
        : t === 'R' ? 'Le serveur écoute sur son port ; le trafic revient sur ton PC vers la destination. (GatewayPorts requis pour écouter hors 127.0.0.1.)'
          : 'Proxy SOCKS5 local : configure ton navigateur sur 127.0.0.1:port pour sortir par le serveur.';
    };
    type.addEventListener('change', sync); sync();
    return modal({
      title: f.id ? 'Modifier le tunnel' : 'Nouveau tunnel',
      body: [h('div', { class: 'form-row' }, field('Nom', label), field('Type', type)), field('Via le host', host), bindRow, destRow, help,
        h('label', { class: 'check' }, autoRc, 'Relancer automatiquement si la connexion tombe')],
      actions: [{ label: 'Annuler', value: false }, { label: 'Enregistrer', class: 'primary', submit: true, onClick: async () => {
        const s = await guard(() => api.invoke('forward:save', { id: f.id, label: label.value, type: type.value, hostId: host.value, bindHost: bindHost.value, bindPort: bindPort.value, destHost: destHost.value, destPort: destPort.value, autoReconnect: autoRc.checked }));
        if (!s) return false; setState(s); return true;
      } }]
    });
  }

  // ---------- Known hosts ----------
  // ---------- Tableau de bord (surveillance) ----------
  const MON = {};            // hostId -> { last, history[], alerts[] }
  function fmtUptime(sec) { if (!sec) return '—'; const d = Math.floor(sec / 86400), hh = Math.floor(sec % 86400 / 3600), mm = Math.floor(sec % 3600 / 60); return d ? `${d} j ${hh} h` : hh ? `${hh} h ${mm} min` : `${mm} min`; }
  const pctClass = (v, warn = 80, crit = 90) => v == null ? '' : v >= crit ? 'crit' : v >= warn ? 'warn' : 'ok';
  function sparkline(values, { max = 100, w = 120, hgt = 28 } = {}) {
    const vals = values.map(v => (v == null ? null : Math.max(0, Math.min(max, v))));
    const n = vals.length;
    if (n < 2) return h('svg', { class: 'spark', viewBox: `0 0 ${w} ${hgt}`, width: w, height: hgt });
    const pts = vals.map((v, i) => v == null ? null : `${(i / (n - 1) * w).toFixed(1)},${(hgt - 2 - v / max * (hgt - 4)).toFixed(1)}`).filter(Boolean);
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', `0 0 ${w} ${hgt}`); svg.setAttribute('width', w); svg.setAttribute('height', hgt); svg.setAttribute('class', 'spark');
    const area = document.createElementNS(svg.namespaceURI, 'polygon');
    area.setAttribute('points', `0,${hgt} ${pts.join(' ')} ${w},${hgt}`); area.setAttribute('class', 'spark-area');
    const line = document.createElementNS(svg.namespaceURI, 'polyline');
    line.setAttribute('points', pts.join(' ')); line.setAttribute('class', 'spark-line');
    svg.append(area, line);
    return svg;
  }
  function meter(label, value, extra) {
    return h('div', { class: 'meter ' + pctClass(value) },
      h('div', { class: 'meter-top' }, h('span', { text: label }), h('b', { text: value == null ? '—' : `${value} %` })),
      h('div', { class: 'meter-bar' }, h('i', { style: { width: (value || 0) + '%' } })),
      extra ? h('div', { class: 'meter-sub', text: extra }) : null);
  }
  function monMini(x) {
    if (!x.monitor) return null;
    const d = MON[x.id];
    if (!d || !d.last) return h('div', { class: 'card-mon muted', text: '📊 surveillance…' });
    const m = d.last;
    if (!m.ok) return h('div', { class: 'card-mon crit', title: m.error, text: '📊 injoignable' });
    return h('div', { class: 'card-mon' + (d.alerts && d.alerts.length ? ' warn' : '') },
      `📊 CPU ${m.cpu ?? '—'}% · RAM ${m.mem ?? '—'}% · Disque ${m.disk ?? '—'}%`, d.alerts && d.alerts.length ? ` · ⚠ ${d.alerts.length}` : '');
  }
  function monTile(x) {
    const d = MON[x.id] || {};
    const m = d.last;
    const hist = d.history || [];
    const ago2 = m ? Math.round((Date.now() - m.at) / 1000) : null;
    const state = !m ? 'wait' : !m.ok ? 'err' : (d.alerts || []).some(a => a.level === 'crit') ? 'err' : (d.alerts || []).length ? 'wait' : 'on';
    const memExtra = m && m.memTotal ? `${fmtSize(m.memUsed)} / ${fmtSize(m.memTotal)}` : '';
    const worst = m && m.disks && m.disks.length ? m.disks.reduce((a, b) => (b.pct > a.pct ? b : a)) : null;
    const tile = h('div', { class: 'mon-tile st-' + state, 'data-host': x.id },
      h('div', { class: 'mon-head' }, h('span', { class: 'dot ' + state }), h('span', { class: 'mon-name', text: x.label }), envBadge(x.env),
        h('span', { class: 'spacer' }),
        h('button', { class: 'icon-btn mini', title: 'Mesurer maintenant', onclick: async (e) => { e.stopPropagation(); e.currentTarget.disabled = true; const r = await guard(() => api.invoke('monitor:refresh', x.id)); if (r) { MON[x.id] = r; refreshMon(x.id); } } }, '⟳'),
        h('button', { class: 'icon-btn mini', title: 'Terminal SSH', onclick: (e) => { e.stopPropagation(); openTerminal(x.id); } }, '>_')),
      !m ? h('div', { class: 'muted small', text: 'Première mesure en cours…' })
        : !m.ok ? h('div', { class: 'mon-err', text: '⛔ ' + m.error })
          : [
            h('div', { class: 'mon-sub muted small', text: `${m.os || m.kernel || ''} · en marche depuis ${fmtUptime(m.uptimeSec)}` }),
            m.unsupported ? h('div', { class: 'muted small', text: m.unsupported }) : null,
            h('div', { class: 'mon-cpu' }, meter('CPU', m.cpu, m.load ? `charge ${m.load.join(' · ')} — ${m.cpus || '?'} cœur(s)` : ''), sparkline(hist.map(p => p.cpu))),
            h('div', { class: 'mon-cpu' }, meter('RAM', m.mem, memExtra + (m.swap ? ` · swap ${m.swap} %` : '')), sparkline(hist.map(p => p.mem))),
            meter('Disque', m.disk, worst ? `${worst.mount} : ${fmtSize(worst.used)} / ${fmtSize(worst.size)}${m.disks.length > 1 ? ` (+${m.disks.length - 1} autre(s))` : ''}` : ''),
            h('div', { class: 'mon-net muted small', text: `↓ ${fmtSize(m.rxRate || 0)}/s  ↑ ${fmtSize(m.txRate || 0)}/s` + (m.docker ? ` · 🐳 ${m.docker.running}/${m.docker.total} conteneurs` : '') }),
            m.services && m.services.length ? h('div', { class: 'mon-svcs' }, m.services.map(s2 => h('span', { class: 'svc ' + (s2.ok ? 'ok' : 'ko'), title: s2.state, text: (s2.ok ? '● ' : '○ ') + s2.name }))) : null
          ],
      (d.alerts || []).length ? h('div', { class: 'mon-alerts' }, d.alerts.map(a => h('div', { class: 'al ' + a.level, text: (a.level === 'crit' ? '🔴 ' : '🟠 ') + a.msg }))) : null,
      h('div', { class: 'mon-foot muted', text: m ? `mesuré il y a ${ago2 < 60 ? ago2 + ' s' : Math.round(ago2 / 60) + ' min'}` : '' }));
    tile.addEventListener('click', () => monDetail(x));
    return tile;
  }
  function monDetail(x) {
    const d = MON[x.id] || {}; const m = d.last;
    if (!m || !m.ok) return;
    modal({
      title: `📊 ${x.label}`, wide: true,
      body: [
        h('div', { class: 'muted small', text: `${m.hostname || ''} · ${m.os || ''} · ${m.kernel || ''}` }),
        h('table', { class: 'audit', style: { marginTop: '10px' } },
          h('thead', {}, h('tr', {}, h('th', { text: 'Montage' }), h('th', { text: 'Système de fichiers' }), h('th', { text: 'Utilisé' }), h('th', { text: 'Taille' }), h('th', { text: '%' }))),
          h('tbody', {}, (m.disks || []).map(dk => h('tr', {}, h('td', { text: dk.mount }), h('td', { class: 'det', text: dk.fs }), h('td', { text: fmtSize(dk.used) }), h('td', { text: fmtSize(dk.size) }), h('td', { class: pctClass(dk.pct), text: dk.pct + ' %' }))))),
        (m.services || []).length ? h('p', { class: 'small', text: 'Services : ' + m.services.map(s2 => `${s2.name} (${s2.state})`).join(', ') }) : null,
        h('p', { class: 'muted small', text: 'Historique : ~2 h (une mesure par intervalle). Seuils d\'alerte : disque 90 %, RAM 90 %, charge > 2 × cœurs, service arrêté, serveur injoignable.' })
      ],
      actions: [{ label: 'Fermer', value: null }]
    });
  }
  function refreshMon(hostId) {
    if (ui.activeTab !== 'home') return;
    const x = hostById(hostId); if (!x) return;
    if (ui.section === 'dashboard') {
      const old = document.querySelector(`.mon-tile[data-host="${hostId}"]`);
      if (old) { old.replaceWith(monTile(x)); const sm = document.querySelector('.mon-summary'); if (sm) sm.replaceWith(monSummary(S.hosts.filter(y => y.monitor))); } else renderSection();
    } else if (ui.section === 'hosts' && !document.activeElement.matches('.search')) {
      const card = [...document.querySelectorAll('.card')].find(c => c.querySelector('.card-title span') && c.querySelector('.card-title span').textContent === x.label);
      const mini = card && card.querySelector('.card-mon');
      if (mini) mini.replaceWith(monMini(x));
    }
  }
  function monSummary(watched) {
    const total = watched.length;
    const down = watched.filter(x => MON[x.id] && MON[x.id].last && !MON[x.id].last.ok).length;
    const alerting = watched.filter(x => MON[x.id] && (MON[x.id].alerts || []).length).length;
    return h('div', { class: 'mon-summary' },
      total - alerting ? h('span', { class: 'sum ok', text: `${total - alerting} OK` }) : null, alerting - down ? h('span', { class: 'sum warn', text: `${alerting - down} en alerte` }) : null, down ? h('span', { class: 'sum crit', text: `${down} injoignable(s)` }) : null);
  }
  function viewDashboard() {
    const watched = S.hosts.filter(x => x.monitor);
    const intervalSel = h('select', { style: { width: 'auto' } }, [[30, 'toutes les 30 s'], [60, 'chaque minute'], [300, 'toutes les 5 min']].map(([v, l]) => h('option', { value: String(v), text: l })));
    intervalSel.value = String(S.settings.monitorInterval || 60);
    intervalSel.addEventListener('change', async () => { const st = await guard(() => api.invoke('settings:save', { monitorInterval: Number(intervalSel.value) })); if (st) S = st; });
    const head = h('div', { class: 'section-head' }, h('h1', { text: 'Tableau de bord' }), h('span', { class: 'muted small', text: 'Mesure' }), intervalSel,
      h('button', { class: 'btn', onclick: () => editMonitored() }, 'Choisir les serveurs…'));
    if (!watched.length) {
      return h('div', {}, head, h('div', { class: 'empty' },
        h('div', { text: 'Aucun serveur surveillé.' }),
        h('div', { class: 'muted small', text: 'CPU, RAM, disques, charge, réseau, services et conteneurs, mesurés par SSH sans rien installer sur le serveur. Alertes et notifications en cas de problème.' }),
        h('button', { class: 'btn primary', onclick: () => editMonitored() }, 'Choisir les serveurs à surveiller')));
    }
    const summary = monSummary(watched);
    const sorted = [...watched].sort((a, b) => ((MON[b.id] || {}).alerts || []).length - ((MON[a.id] || {}).alerts || []).length || a.label.localeCompare(b.label));
    return h('div', {}, head, summary, h('div', { class: 'mon-grid' }, sorted.map(monTile)));
  }
  async function editMonitored() {
    const boxes = S.hosts.map(x => { const c = h('input', { type: 'checkbox' }); c.checked = !!x.monitor; const sv = h('input', { value: x.monitorServices || '', placeholder: 'services (nginx, docker…)', spellcheck: 'false' }); return { x, c, sv }; });
    const ok = await modal({
      title: 'Serveurs surveillés', wide: true,
      body: [h('p', { class: 'muted small', text: 'Les serveurs doivent avoir été ouverts une fois en SSH (empreinte validée). Les hosts avec 2FA ne peuvent pas être surveillés en arrière-plan.' }),
        h('div', { class: 'mon-pick' }, boxes.map(b => h('div', { class: 'mon-pick-row' }, h('label', { class: 'check' }, b.c, `${b.x.label}`, h('span', { class: 'muted small', text: ` ${b.x.username}@${b.x.hostname}` })), b.sv)))],
      actions: [{ label: 'Annuler', value: false }, { label: 'Enregistrer', class: 'primary', value: true }]
    });
    if (!ok) return;
    let st = null;
    for (const b of boxes) {
      if (!!b.x.monitor === b.c.checked && (b.x.monitorServices || '') === b.sv.value) continue;
      st = await guard(() => api.invoke('host:save', { ...b.x, monitor: b.c.checked, monitorServices: b.sv.value }));
    }
    if (st) { setState(st); toast('Surveillance mise à jour — premières mesures dans quelques secondes'); }
  }
  api.on('monitor:update', ({ hostId, last, history, alerts: al }) => {
    const d = MON[hostId] || (MON[hostId] = { history: [] });
    d.last = last; d.alerts = al; if (history) { d.history.push(history); while (d.history.length > 120) d.history.shift(); }
    refreshMon(hostId);
  });
  api.on('monitor:alert', (a) => toast(`${a.state === 'new' ? (a.level === 'crit' ? '🔴' : '🟠') : '✅ Rétabli —'} ${a.host} : ${a.msg}`, a.state === 'new' && a.level === 'crit'));
  api.on('monitor:focus', () => { activateTab('home'); ui.section = 'dashboard'; document.querySelectorAll('.nav-item').forEach(x => x.classList.toggle('active', x.dataset.section === 'dashboard')); renderSection(); });
  async function loadMonSnapshot() { const snap = await api.invoke('monitor:snapshot').catch(() => null); if (snap) { Object.assign(MON, snap); if (ui.section === 'dashboard') renderSection(); } }

  // ---------- Journal d'audit et enregistrements ----------
  const AUDIT_TYPES = {
    connect: ['🔌', 'Connexion'], 'connect-failed': ['⛔', 'Connexion échouée'], disconnect: ['⏏', 'Déconnexion'], command: ['❯', 'Commande'],
    'danger-confirmed': ['⚠', 'Commande dangereuse exécutée'], 'danger-cancelled': ['✋', 'Commande dangereuse annulée'],
    'file-save': ['💾', 'Fichier enregistré'], sftp: ['📁', 'SFTP'], vpn: ['🌐', 'VPN'], secret: ['🔑', 'Secret consulté'],
    unlock: ['🔓', 'Déverrouillage'], 'unlock-failed': ['🚫', 'Déverrouillage refusé'], lock: ['🔒', 'Verrouillage'],
    backup: ['📤', 'Export'], restore: ['📥', 'Restauration'], settings: ['⚙', 'Réglage']
  };
  const auditUi = { tab: 'events', period: '7', type: '', host: '', text: '' };
  function auditDetail(e) {
    const parts = [];
    if (e.command) parts.push(e.command);
    if (e.danger) parts.push('⚠ ' + e.danger);
    if (e.path) parts.push(e.path + (e.sudo ? ' (sudo)' : ''));
    if (e.action) parts.push(e.action);
    if (e.what) parts.push(e.what);
    if (e.method) parts.push(e.method);
    if (e.vpn) parts.push(e.vpn);
    if (e.remote) parts.push('distant : ' + e.remote);
    if (e.local) parts.push('local : ' + e.local);
    if (e.file) parts.push(e.file);
    if (e.reason) parts.push(e.reason);
    if (e.durationSec !== undefined) parts.push(`durée ${fmtDuration(e.durationSec)}`);
    if (e.error) parts.push('erreur : ' + e.error);
    if (e.failedAt) parts.push('le ' + new Date(e.failedAt).toLocaleString('fr-FR'));
    if (e.recording) parts.push('● enregistrée');
    return parts.join(' · ');
  }
  function fmtDuration(sec) { sec = Math.round(sec || 0); const hh = Math.floor(sec / 3600), mm = Math.floor(sec % 3600 / 60), ss = sec % 60; return (hh ? hh + ' h ' : '') + (hh || mm ? mm + ' min ' : '') + ss + ' s'; }
  function auditQuery() {
    const since = auditUi.period === 'all' ? null : new Date(Date.now() - Number(auditUi.period) * 86400000).toISOString();
    return { since, types: auditUi.type ? auditUi.type.split(',') : null, host: auditUi.host || null, text: auditUi.text, limit: 3000 };
  }
  function viewAudit() {
    const seg = h('div', { class: 'seg' },
      h('button', { class: auditUi.tab === 'events' ? 'on' : '', onclick: () => { auditUi.tab = 'events'; renderSection(); } }, 'Événements'),
      h('button', { class: auditUi.tab === 'rec' ? 'on' : '', onclick: () => { auditUi.tab = 'rec'; renderSection(); } }, 'Enregistrements'));
    const head = h('div', { class: 'section-head' }, h('h1', { text: 'Journal' }), seg);
    const box = h('div', {}, h('div', { class: 'muted small', text: 'Chargement…' }));
    if (auditUi.tab === 'rec') loadRecordings(box); else loadEvents(box);
    return h('div', {}, head, box);
  }
  async function loadEvents(box) {
    const sel = (key, opts) => { const el = h('select', {}, opts.map(([v, l]) => h('option', { value: v, text: l }))); el.value = auditUi[key]; el.addEventListener('change', () => { auditUi[key] = el.value; renderSection(); }); return el; };
    const search = h('input', { class: 'search', placeholder: 'Rechercher (commande, chemin…)', value: auditUi.text });
    let tmr; search.addEventListener('input', () => { clearTimeout(tmr); tmr = setTimeout(() => { auditUi.text = search.value; renderSection(); const s2 = $('#section .audit-filters .search'); if (s2) { s2.focus(); s2.setSelectionRange(s2.value.length, s2.value.length); } }, 300); });
    const filters = h('div', { class: 'audit-filters' },
      sel('period', [['1', '24 h'], ['7', '7 jours'], ['30', '30 jours'], ['365', '1 an'], ['all', 'Tout']]),
      sel('type', [['', 'Tous les événements'], ['command,danger-confirmed,danger-cancelled', 'Commandes'], ['danger-confirmed,danger-cancelled', 'Commandes dangereuses'], ['connect,connect-failed,disconnect', 'Connexions'], ['file-save,sftp', 'Fichiers'], ['unlock,unlock-failed,lock,secret', 'Accès au coffre'], ['vpn', 'VPN']]),
      sel('host', [['', 'Tous les hosts'], ...S.hosts.map(x => [x.label, x.label])]),
      search,
      h('button', { class: 'btn sm', onclick: async () => { const f = await guard(() => api.invoke('audit:exportCsv', auditQuery())); if (f) toast('Exporté : ' + f); } }, 'Exporter CSV'));
    let r;
    try { r = await api.invoke('audit:query', auditQuery()); }
    catch (e) { box.replaceChildren(filters, h('div', { class: 'empty', text: e.message })); return; }
    if (S.settings.auditEnabled === false) filters.append(h('span', { class: 'badge', text: 'journal désactivé (Paramètres)' }));
    const rows = r.entries.map(e => {
      const [ic, label] = AUDIT_TYPES[e.type] || ['•', e.type];
      return h('tr', { class: 't-' + e.type },
        h('td', { class: 'when', text: new Date(e.at).toLocaleString('fr-FR') }),
        h('td', { text: `${ic} ${label}` }),
        h('td', { text: e.host ? e.host + (e.user ? ` (${e.user})` : '') : '' }),
        h('td', { class: 'det', text: auditDetail(e) }));
    });
    box.replaceChildren(filters,
      r.entries.length ? h('div', { class: 'audit-wrap' }, h('table', { class: 'audit' }, h('thead', {}, h('tr', {}, h('th', { text: 'Date' }), h('th', { text: 'Événement' }), h('th', { text: 'Host' }), h('th', { text: 'Détail' }))), h('tbody', {}, rows)))
        : h('div', { class: 'empty', text: 'Aucun événement pour ces filtres.' }),
      h('p', { class: 'muted small', text: `${r.entries.length} événement(s)${r.truncated ? ' (limite atteinte, affine les filtres)' : ''}${r.bad ? ` · ${r.bad} ligne(s) illisible(s)` : ''}. Chiffré dans le dossier de KSTermus ; l'export CSV, lui, est en clair.` }));
  }
  async function loadRecordings(box) {
    let list;
    try { list = await api.invoke('rec:list'); } catch (e) { box.replaceChildren(h('div', { class: 'empty', text: e.message })); return; }
    const mode = S.settings.recordSessions || 'marked';
    const hint = h('p', { class: 'muted small', text: mode === 'off' ? 'Enregistrement désactivé (Paramètres).' : mode === 'all' ? 'Toutes les sessions SSH sont enregistrées.' : 'Seuls les hosts cochés « Enregistrer les sessions » sont enregistrés (formulaire du host).' });
    if (!list.length) { box.replaceChildren(hint, h('div', { class: 'empty', text: 'Aucun enregistrement.' })); return; }
    box.replaceChildren(hint, h('div', { class: 'list' }, list.map(r => h('div', { class: 'row' },
      h('span', { class: 'dot ' + (r.live ? 'on' : 'stop') }),
      h('div', { class: 'row-main' }, h('div', { class: 'row-title', text: r.error ? r.id : `${r.hostLabel} — ${r.user}` }),
        h('div', { class: 'muted small', text: r.error ? r.error : `${new Date(r.at).toLocaleString('fr-FR')} · ${fmtBytes(r.size)}${r.live ? ' · en cours' : ''}` })),
      r.error ? null : h('button', { class: 'btn sm primary', onclick: () => playRecording(r) }, '▶ Relire'),
      r.error ? null : h('button', { class: 'icon-btn', title: 'Exporter en .cast (asciinema, non chiffré)', onclick: async () => { const f = await guard(() => api.invoke('rec:export', r.id)); if (f) toast('Exporté : ' + f); } }, '⤓'),
      h('button', { class: 'icon-btn', title: 'Supprimer', onclick: async () => { if (await confirmBox('Supprimer l\'enregistrement', 'Supprimer définitivement cet enregistrement ?')) { if (await guard(() => api.invoke('rec:delete', r.id))) renderSection(); } } }, '🗑')))));
  }
  // Lecteur : temps morts plafonnés à 2 s, vitesse x1 à x8, barre de progression.
  async function playRecording(r) {
    const rec = await guard(() => api.invoke('rec:load', r.id));
    if (!rec) return;
    const IDLE = 2;
    let t = 0; const evs = [];
    let last = 0;
    for (const e of rec.events) { const gap = Math.min(e[0] - last, IDLE); t += Math.max(0, gap); last = e[0]; evs.push([t, e[1], e[2]]); }
    const total = evs.length ? evs[evs.length - 1][0] : 0;
    const host = h('div', { class: 'player-term' });
    const range = h('input', { type: 'range', min: 0, max: Math.max(1, Math.round(total * 10)), value: 0 });
    const time = h('span', { class: 'time' });
    const playBtn = h('button', { class: 'btn sm primary', type: 'button' }, '⏸');
    const speed = h('select', { style: { width: '80px' } }, [1, 2, 4, 8].map(v => h('option', { value: v, text: 'x' + v })));
    const term = new Terminal({ fontFamily: '"Cascadia Mono", Consolas, monospace', fontSize: 13, theme: TERM_THEME, cols: rec.header.width, rows: rec.header.height, disableStdin: true, scrollback: 5000 });
    let i = 0, pos = 0, playing = true, raf = 0, lastTick = 0;
    const fmt = (x) => { x = Math.floor(x); return `${Math.floor(x / 60)}:${String(x % 60).padStart(2, '0')}`; };
    const apply = (e) => { if (e[1] === 'o') term.write(e[2]); else if (e[1] === 'r') { const [c, rr] = String(e[2]).split('x').map(Number); if (c && rr) term.resize(c, rr); } };
    const seek = (to) => { term.reset(); term.resize(rec.header.width, rec.header.height); i = 0; pos = to; let buf = ''; while (i < evs.length && evs[i][0] <= to) { if (evs[i][1] === 'o') buf += evs[i][2]; else { term.write(buf); buf = ''; apply(evs[i]); } i++; } term.write(buf); };
    const tick = (now) => {
      if (!playing) return;
      const dt = lastTick ? (now - lastTick) / 1000 * Number(speed.value) : 0; lastTick = now;
      pos += dt;
      let buf = '';
      while (i < evs.length && evs[i][0] <= pos) { if (evs[i][1] === 'o') buf += evs[i][2]; else { term.write(buf); buf = ''; apply(evs[i]); } i++; }
      if (buf) term.write(buf);
      range.value = Math.round(pos * 10); time.textContent = `${fmt(pos)} / ${fmt(total)}`;
      if (i >= evs.length) { playing = false; playBtn.textContent = '↺'; return; }
      raf = requestAnimationFrame(tick);
    };
    playBtn.onclick = () => {
      if (i >= evs.length) { seek(0); }
      playing = !playing; playBtn.textContent = playing ? '⏸' : '▶'; lastTick = 0;
      if (playing) raf = requestAnimationFrame(tick);
    };
    range.addEventListener('input', () => { seek(Number(range.value) / 10); time.textContent = `${fmt(pos)} / ${fmt(total)}`; lastTick = 0; });
    const p = modal({
      title: `▶ ${r.hostLabel} — ${new Date(r.at).toLocaleString('fr-FR')}`, wide: true,
      body: [h('div', { class: 'player' }, host, h('div', { class: 'player-bar' }, playBtn, range, time, speed))],
      onOpen: (form) => { form.style.width = 'min(1100px, calc(100vw - 32px))'; term.open(host); raf = requestAnimationFrame(tick); },
      actions: [{ label: 'Fermer', value: null }]
    });
    await p;
    playing = false; cancelAnimationFrame(raf); term.dispose();
  }

  // ---------- VPN WireGuard ----------
  function vpnById(id) { return (S.vpns || []).find(v => v.id === id); }
  function effectiveVpn(x) {
    if (x.vpnId === 'none') return null;
    return vpnById(x.vpnId || (S.groupVpns || {})[x.group || ''] || '') || null;
  }
  function vpnState(v) { return (v && v.status && v.status.state) || 'stopped'; }
  const VPN_LABEL = { stopped: 'Arrêté', starting: 'Démarrage…', up: 'Actif — en attente du serveur', connected: 'Connecté', error: 'Erreur' };
  const VPN_DOT = { stopped: 'stop', starting: 'wait', up: 'wait', connected: 'on', error: 'err' };
  function vpnBadge(x) {
    const v = effectiveVpn(x);
    if (!v) return null;
    const inherited = !x.vpnId;
    return h('div', { class: 'card-vpn', title: `VPN ${v.name} — ${VPN_LABEL[vpnState(v)]}${inherited ? ' (via le groupe)' : ''}` },
      h('span', { class: 'dot ' + VPN_DOT[vpnState(v)] }), `🌐 ${v.name}${inherited ? ' · groupe' : ''}`);
  }
  function groupTitle(g, count) {
    const key = g === 'Sans groupe' ? '' : g;
    const v = vpnById((S.groupVpns || {})[key]);
    const btn = h('button', { class: 'group-vpn' + (v ? ' on' : ''), title: 'VPN du groupe : toutes ses connexions passent par ce VPN',
      onclick: (e) => popupMenu(e.currentTarget, [
        ...(S.vpns || []).map(p => ({ label: (v && v.id === p.id ? '✓ ' : '') + '🌐 ' + p.name, sub: (p.info && p.info.endpoints || []).join(', '), onClick: () => setGroupVpn(key, p.id) })),
        { label: v ? '✕ Retirer le VPN du groupe' : 'Aucun VPN', onClick: () => setGroupVpn(key, '') },
        { label: '+ Nouveau VPN…', onClick: () => editVpn() }
      ]) }, v ? `🌐 ${v.name}` : '🌐 VPN');
    return h('div', { class: 'group-title group-row' }, h('span', { text: `${g} · ${count}` }), btn);
  }
  async function setGroupVpn(group, id) {
    const s = await guard(() => api.invoke('vpn:setGroup', group, id));
    if (s) { setState(s); toast(id ? `Groupe « ${group || 'Sans groupe'} » → ${vpnById(id).name}` : 'VPN retiré du groupe'); }
  }
  function fmtBytes(n) { return n > 1048576 ? (n / 1048576).toFixed(1) + ' Mo' : n > 1024 ? (n / 1024).toFixed(0) + ' Ko' : (n || 0) + ' o'; }
  function vpnStatusText(st) {
    if (!st || st.state === 'stopped') return 'Arrêté';
    if (st.state === 'error') return 'Erreur : ' + (st.error || '?');
    if (st.state === 'starting') return 'Démarrage…';
    const ago = st.handshake ? Math.max(0, Math.round(Date.now() / 1000 - st.handshake)) : null;
    return (st.state === 'connected' ? 'Connecté' : 'Actif — en attente du serveur') +
      (ago !== null ? ` · handshake il y a ${ago < 90 ? ago + ' s' : Math.round(ago / 60) + ' min'}` : '') + ` · ↓ ${fmtBytes(st.rx)} ↑ ${fmtBytes(st.tx)}`;
  }
  function vpnUsers(v) {
    const hostsUsing = S.hosts.filter(x => effectiveVpn(x) && effectiveVpn(x).id === v.id);
    const groupsUsing = Object.entries(S.groupVpns || {}).filter(([, id]) => id === v.id).map(([g]) => g || 'Sans groupe');
    return { hostsUsing, groupsUsing };
  }
  function viewVpn() {
    const list = S.vpns || [];
    const head = h('div', { class: 'section-head' }, h('h1', { text: 'VPN WireGuard' }),
      h('button', { class: 'btn primary', onclick: () => editVpn() }, '+ Nouveau VPN'));
    const intro = h('p', { class: 'muted small', style: { maxWidth: '760px' },
      text: 'Associe un VPN à un host (formulaire du host) ou à tout un groupe (bouton 🌐 à côté du nom du groupe). Il démarre tout seul à la connexion. Le tunnel tourne dans KSTermus : pas de droits administrateur, pas de changement réseau sur le PC, seules les connexions SSH / SFTP / tunnels de ces hosts l\'empruntent.' });
    if (!list.length) return h('div', {}, head, intro, h('div', { class: 'empty' }, h('div', { text: 'Aucun VPN. Importe le fichier .conf fourni par ton administrateur.' }), h('button', { class: 'btn primary', onclick: () => editVpn() }, 'Ajouter un VPN')));
    return h('div', {}, head, intro, h('div', { class: 'list' }, list.map(v => {
      const st = v.status || { state: 'stopped' };
      const running = ['starting', 'up', 'connected'].includes(st.state);
      const { hostsUsing, groupsUsing } = vpnUsers(v);
      return h('div', { class: 'row vpn-row', 'data-vpn': v.id },
        h('span', { class: 'dot ' + VPN_DOT[st.state] }),
        h('div', { class: 'row-main' },
          h('div', { class: 'row-title', text: v.name }),
          h('div', { class: 'muted small mono', text: v.info && v.info.error ? '⚠ ' + v.info.error : `${(v.info.endpoints || []).join(', ')} · ${(v.info.addresses || []).join(', ')} · routes ${(v.info.allowedIPs || []).join(', ')}` }),
          h('div', { class: 'small vpn-status', text: vpnStatusText(st) }),
          h('div', { class: 'muted small', text: (groupsUsing.length ? 'Groupes : ' + groupsUsing.join(', ') + ' · ' : '') + `${hostsUsing.length} host(s) : ` + (hostsUsing.map(x => x.label).join(', ') || '—') })),
        h('button', { class: 'btn sm' + (running ? '' : ' primary'), onclick: async (e) => {
          const b = e.currentTarget; b.disabled = true;
          if (running) await guard(() => api.invoke('vpn:stop', v.id));
          else { b.textContent = 'Démarrage…'; const r = await guard(() => api.invoke('vpn:start', v.id)); if (r) toast(`VPN ${v.name} démarré`); }
          refresh();
        } }, running ? 'Arrêter' : 'Démarrer'),
        h('button', { class: 'icon-btn', title: 'Modifier', onclick: () => editVpn(v) }, '✎'),
        h('button', { class: 'icon-btn', title: 'Supprimer', onclick: async () => {
          if (await confirmBox('Supprimer le VPN', `Supprimer « ${v.name} » ?`)) { const s = await guard(() => api.invoke('vpn:delete', v.id)); if (s) setState(s); }
        } }, '🗑'));
    })));
  }
  function editVpn(v = {}) {
    const name = h('input', { value: v.name || '', placeholder: 'VPN Bienvenu, VPN QOS…' });
    const conf = h('textarea', { rows: 11, spellcheck: 'false', class: 'mono', placeholder: v.id ? 'Laisser vide pour garder la configuration actuelle (la clé privée n\'est jamais réaffichée).' : '[Interface]\nPrivateKey = …\nAddress = 10.8.0.2/32\nDNS = 10.8.0.1\n\n[Peer]\nPublicKey = …\nEndpoint = vpn.exemple.com:51820\nAllowedIPs = 10.8.0.0/24\nPersistentKeepalive = 25' });
    const notes = h('input', { value: v.notes || '', placeholder: 'Optionnel' });
    const importBtn = h('button', { class: 'btn sm', type: 'button', onclick: async () => {
      const r = await guard(() => api.invoke('vpn:importFile'));
      if (r) { conf.value = r.config; if (!name.value) name.value = r.name; }
    } }, '📂 Importer un fichier .conf');
    return modal({
      title: v.id ? 'Modifier le VPN' : 'Nouveau VPN WireGuard', wide: true,
      body: [field('Nom', name), h('div', { class: 'field' }, h('span', { text: 'Configuration WireGuard (.conf)' }), conf, h('div', { style: { marginTop: '6px' } }, importBtn)),
        h('p', { class: 'muted small', text: 'Format standard wg-quick (fourni par le serveur WireGuard, pfSense, OPNsense, Firezone…). Stocké chiffré dans le coffre. AllowedIPs indique quels réseaux passent par le VPN.' }),
        field('Notes', notes)],
      actions: [{ label: 'Annuler', value: false }, { label: 'Enregistrer', class: 'primary', submit: true, onClick: async () => {
        const s = await guard(() => api.invoke('vpn:save', { id: v.id || null, name: name.value, config: conf.value, notes: notes.value }));
        if (!s) return false; setState(s); return true;
      } }]
    });
  }
  api.on('vpn:status', (st) => {
    if (!S || !S.vpns) return;
    const v = S.vpns.find(x => x.id === st.id);
    if (!v) return;
    const prev = vpnState(v);
    v.status = st;
    if (ui.activeTab !== 'home') return;
    if (ui.section === 'vpn') {
      const row = document.querySelector(`.vpn-row[data-vpn="${st.id}"]`);
      if (prev !== st.state || !row) renderSection();
      else row.querySelector('.vpn-status').textContent = vpnStatusText(st);
    } else if (ui.section === 'hosts' && prev !== st.state && !document.activeElement.matches('.search')) renderSection();
  });

  function viewKnown() {
    const entries = Object.entries(S.knownHosts || {});
    return h('div', {},
      h('div', { class: 'section-head' }, h('h1', { text: 'Known hosts' })),
      h('p', { class: 'muted', text: 'Empreintes des serveurs acceptées. Une empreinte qui change déclenche une alerte (possible attaque man-in-the-middle ou serveur réinstallé).' }),
      entries.length ? h('div', { class: 'list' }, entries.map(([k, v]) => h('div', { class: 'row' },
        h('div', { class: 'row-main' }, h('div', { class: 'row-title' }, k, h('span', { class: 'badge', text: v.type })), h('div', { class: 'row-sub', text: `${v.fingerprint}  ·  ajouté ${fmtDate(Date.parse(v.addedAt))}` })),
        h('div', { class: 'row-actions' }, h('button', { class: 'icon-btn', title: 'Oublier', onclick: async () => {
          if (await confirmBox('Oublier cette empreinte', `La prochaine connexion à ${k} redemandera confirmation.`, 'Oublier')) { const s = await guard(() => api.invoke('knownhost:delete', k)); if (s) setState(s); }
        } }, '🗑'))))) : h('div', { class: 'empty', text: 'Aucune empreinte enregistrée.' }));
  }

  // ---------- Paramètres ----------
  function viewSettings() {
    const fs = h('input', { type: 'number', min: 10, max: 24, value: S.settings.fontSize || 14 });
    fs.addEventListener('change', async () => {
      const s = await guard(() => api.invoke('settings:save', { fontSize: Number(fs.value) }));
      if (s) { S = s; for (const t of tabs.values()) if (t.kind === 'term') { for (const p of t.panes.values()) p.term.options.fontSize = Number(fs.value); fitTab(t); } }
    });
    return h('div', { style: { maxWidth: '560px' } },
      h('div', { class: 'section-head' }, h('h1', { text: 'Paramètres' })),
      h('div', { class: 'list' },
        h('div', { class: 'row' }, h('div', { class: 'row-main' }, h('div', { class: 'row-title', text: 'Taille de police du terminal' })), h('div', { style: { width: '90px' } }, fs)),
        h('div', { class: 'row' }, h('div', { class: 'row-main' }, h('div', { class: 'row-title', text: 'Reconnexion automatique SSH' }), h('div', { class: 'muted small', text: 'Après une coupure réseau ou une mise en veille : nouvel essai à 2, 4, 8, 15 puis 30 s.' })),
          (() => { const c = h('input', { type: 'checkbox', style: { width: '18px', height: '18px' } }); c.checked = S.settings.autoReconnect !== false;
            c.addEventListener('change', async () => { const s = await guard(() => api.invoke('settings:save', { autoReconnect: c.checked })); if (s) S = s; }); return c; })()),
        themeRow(),
        syncRow(),
        updateRow(),
        securityRows(),
        h('div', { class: 'row' }, h('div', { class: 'row-main' }, h('div', { class: 'row-title', text: 'Recherche dans le terminal' }), h('div', { class: 'muted small', text: 'Ctrl+Shift+F ouvre toujours la recherche. Avec Ctrl+F, la touche n\'est plus envoyée au shell (avance d\'un caractère dans bash, page suivante dans vim/less).' })),
          (() => { const c = h('input', { type: 'checkbox', style: { width: '18px', height: '18px' }, title: 'Ctrl+F ouvre aussi la recherche' }); c.checked = !!S.settings.ctrlFSearch;
            c.addEventListener('change', async () => { const s = await guard(() => api.invoke('settings:save', { ctrlFSearch: c.checked })); if (s) S = s; }); return c; })()),
        h('div', { class: 'row' }, h('div', { class: 'row-main' }, h('div', { class: 'row-title', text: 'Préfixe façon tmux' }), h('div', { class: 'muted small', text: 'Touche à presser avant une commande de panneau (préfixe puis ? pour l\'aide).' })),
          (() => { const sel = h('select', { style: { width: '150px' } }, [['ctrl+b', 'Ctrl+B (tmux)'], ['ctrl+a', 'Ctrl+A (screen)'], ['off', 'Désactivé']].map(([v, l]) => h('option', { value: v, text: l })));
            sel.value = prefixKey(); sel.addEventListener('change', async () => { const s = await guard(() => api.invoke('settings:save', { tmuxPrefix: sel.value })); if (s) { S = s; toast('Préfixe : ' + sel.options[sel.selectedIndex].text); } }); return sel; })()),
        h('div', { class: 'row' }, h('div', { class: 'row-main' }, h('div', { class: 'row-title', text: 'Shell local par défaut' }), h('div', { class: 'muted small', text: 'Utilisé par Ctrl+Shift+T et le préfixe puis c.' })),
          (() => { const sel = h('select', { style: { width: '200px' } }, ui.shells.map(sh => h('option', { value: sh.id, text: sh.name })));
            sel.value = defaultShellId() || ''; sel.addEventListener('change', async () => { const s = await guard(() => api.invoke('settings:save', { defaultShell: sel.value })); if (s) S = s; }); return sel; })()),
        h('div', { class: 'row' }, h('div', { class: 'row-main' }, h('div', { class: 'row-title', text: 'Mot de passe maître' }), h('div', { class: 'muted small', text: 'Re-chiffre tout le coffre.' })),
          h('button', { class: 'btn sm', onclick: changeMaster }, 'Changer')),
        h('div', { class: 'row' }, h('div', { class: 'row-main' }, h('div', { class: 'row-title', text: 'Sauvegarde du coffre' }), h('div', { class: 'muted small', text: 'Fichier .kst chiffré (coffre + historique). Restaurer fonctionne entre Windows et Linux, avec le mot de passe maître d\'origine.' })),
          h('div', { style: { display: 'flex', gap: '8px' } },
            h('button', { class: 'btn sm', onclick: async () => { const p = await guard(() => api.invoke('vault:backup')); if (p) toast('Sauvegardé : ' + p); } }, 'Exporter'),
            h('button', { class: 'btn sm', onclick: restoreFromSettings }, 'Restaurer…'))),
        h('div', { class: 'row', style: { alignItems: 'flex-start' } }, h('div', { class: 'row-main' }, h('div', { class: 'row-title', text: 'Raccourcis clavier' }),
          h('div', { class: 'kbd-list' }, SHORTCUTS.map(([k, d]) => h('div', { class: 'kbd-row' }, h('kbd', { text: k }), h('span', { text: d }))))))));
  }

  function themeRow() {
    const TH = window.KST_THEMES;
    const order = ['auto', 'doux', 'sepia', 'nord', 'solarized', 'kstermus', 'clair', 'contraste'];
    const sysLight = window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches;
    const card = (id) => {
      const t = TH.themes[TH.resolve(id)];
      const isAuto = id === 'auto';
      const k = t.term;
      const mini = (kk, compact) => h('div', { class: 'th-preview', style: { background: kk.background, color: kk.foreground } },
        h('div', {}, h('span', { style: { color: kk.green }, text: compact ? 'kst' : 'kst@prod' }), h('span', { text: ':' }), h('span', { style: { color: kk.blue }, text: '~' }), h('span', { text: '$ ls' })),
        h('div', {}, h('span', { style: { color: kk.blue }, text: 'app ' }), h('span', { style: { color: kk.yellow }, text: 'logs ' }), compact ? null : h('span', { style: { color: kk.red }, text: 'err' })));
      const preview = isAuto ? h('div', { class: 'th-duo' }, mini(TH.themes.doux.term, true), mini(TH.themes.sepia.term, true)) : mini(k, false);
      const ratio = TH.contrast(k.foreground, k.background).toFixed(1);
      const badge = isAuto ? h('span', { class: 'th-badge', text: '★ Recommandé' })
        : t.recommended ? h('span', { class: 'th-badge soft', text: t.recommended === 'nuit' ? '☾ soir' : '☀ journée' }) : null;
      return h('button', { class: 'th-card' + (themeId === id ? ' sel' : ''), type: 'button', onclick: async () => {
        const s = await applyTheme(id, { save: true });
        if (s) { S = s; renderSection(); }
      } }, preview,
        h('div', { class: 'th-name' }, h('span', { text: isAuto ? 'Automatique' : t.name }), badge),
        h('div', { class: 'th-desc', text: isAuto ? `Suit le mode clair/sombre de ${api.platform === 'win32' ? 'Windows' : 'ton système'} : Sombre doux le soir, Clair sépia le jour (actuellement : ${sysLight ? 'Clair sépia' : 'Sombre doux'}).` : `${t.desc} Contraste ${ratio}:1.` }));
    };
    return h('div', { class: 'row', style: { alignItems: 'flex-start', flexDirection: 'column' } },
      h('div', { class: 'row-main' }, h('div', { class: 'row-title', text: 'Thème' }),
        h('div', { class: 'muted small', text: 'Interface, terminaux et éditeur. Pour les yeux : un contraste modéré (7 à 11:1) fatigue moins que du blanc pur sur noir pur ; règle aussi la luminosité de l\'écran sur celle de la pièce et active l\'éclairage nocturne du système le soir.' })),
      h('div', { class: 'th-grid' }, order.map(card)));
  }

  function checkbox(checked, onChange) {
    const c = h('input', { type: 'checkbox', style: { width: '18px', height: '18px' } });
    c.checked = checked;
    c.addEventListener('change', () => onChange(c));
    return c;
  }
  // ---------- Synchronisation entre PC ----------
  function ago(iso) {
    if (!iso) return 'jamais';
    const s2 = Math.round((Date.now() - Date.parse(iso)) / 1000);
    return s2 < 60 ? 'à l\'instant' : s2 < 3600 ? `il y a ${Math.round(s2 / 60)} min` : s2 < 86400 ? `il y a ${Math.round(s2 / 3600)} h` : new Date(iso).toLocaleString('fr-FR');
  }
  function renderSyncInd(st) {
    const b = $('#sync-ind');
    if (!st || !st.enabled) { b.hidden = true; return; }
    b.hidden = false;
    b.className = 'sync-ind' + (st.lastError ? ' err' : '') + (st.running ? ' run' : '');
    b.textContent = st.running ? '⟳ Synchronisation…' : st.lastError ? '⚠ Synchro en échec' : `⟳ Synchro ${ago(st.lastSync)}`;
    b.title = st.lastError ? st.lastError : `Synchronisé avec ${st.where}`;
  }
  $('#sync-ind').onclick = async () => { const r = await guard(() => api.invoke('sync:now')); if (r) { setState(r.state); syncToast(r.result); } };
  function syncToast(r) {
    if (!r) return;
    const parts = [];
    if (r.fromRemote) parts.push(`${r.fromRemote} reçu(s)`);
    if (r.fromLocal) parts.push(`${r.fromLocal} envoyé(s)`);
    if (r.conflicts) parts.push(`${r.conflicts} conflit(s) résolu(s) (le plus récent gagne)`);
    toast('Synchronisé' + (parts.length ? ' : ' + parts.join(', ') : ' — rien à changer'));
  }
  api.on('sync:status', (st) => { if (S) S.sync = st; renderSyncInd(st); if (ui.section === 'settings' && ui.activeTab === 'home' && $('#sync-info')) $('#sync-info').replaceChildren(...syncInfo(st)); });
  api.on('state:changed', (s2) => { if (!S || document.querySelector('.backdrop')) { S = s2; return; } setState(s2); toast('Mis à jour depuis un autre PC (synchronisation)'); });
  setInterval(() => { if (S && S.sync) renderSyncInd(S.sync); }, 30000);

  function syncInfo(st) {
    if (!st || !st.enabled) return [h('div', { class: 'muted small', text: 'Désactivée. Hosts, clés, snippets, tunnels, VPN et réglages restent sur ce PC.' })];
    return [
      h('div', { class: 'small', text: `${st.method === 'github' ? '🐙 GitHub' : st.method === 'gdrive' ? '🟢' : '📁 Dossier'} : ${st.where}` }),
      h('div', { class: 'small' + (st.lastError ? ' err-text' : ''), text: st.lastError ? '⚠ ' + st.lastError : `Dernière synchro : ${ago(st.lastSync)}` + (st.lastStats && st.lastStats.conflicts ? ` · ${st.lastStats.conflicts} conflit(s) résolu(s)` : '') }),
      st.devices && st.devices.length ? h('div', { class: 'muted small', text: 'PC : ' + st.devices.map(d => `${d.name}${d.id === st.deviceId ? ' (ce PC)' : ''} — ${ago(d.lastSync)}`).join(' · ') }) : null
    ];
  }
  function syncRow() {
    const st = S.sync || {};
    return h('div', { class: 'row', style: { alignItems: 'flex-start' } },
      h('div', { class: 'row-main' }, h('div', { class: 'row-title', text: 'Synchronisation entre PC' }),
        h('div', { class: 'muted small', text: 'Coffre chiffré partagé entre tes PC (Windows ↔ Linux) via Google Drive (connexion directe), un dossier cloud ou un dépôt GitHub privé. Fusion automatique, à chaque modification et toutes les 5 min.' }),
        h('div', { id: 'sync-info', class: 'sync-info' }, syncInfo(st))),
      h('div', { style: { display: 'flex', gap: '8px', flexWrap: 'wrap', justifyContent: 'flex-end' } },
        st.enabled ? h('button', { class: 'btn sm', onclick: async () => { const r = await guard(() => api.invoke('sync:now')); if (r) { setState(r.state); syncToast(r.result); } } }, '⟳ Synchroniser') : null,
        h('button', { class: 'btn sm' + (st.enabled ? '' : ' primary'), onclick: () => configureSync() }, st.enabled ? 'Configurer' : 'Activer…'),
        st.enabled ? h('button', { class: 'btn sm', onclick: async () => {
          if (!(await confirmBox('Désactiver la synchronisation', 'Ce PC garde ses données mais ne se synchronise plus. Le fichier partagé et les autres PC ne sont pas touchés.', 'Désactiver'))) return;
          const s2 = await guard(() => api.invoke('sync:disable')); if (s2) { setState(s2); renderSyncInd(s2.sync); }
        } }, 'Désactiver') : null));
  }
  async function configureSync() {
    const st = S.sync || {};
    let method = st.method || 'gdrive';
    const folder = h('input', { value: st.folder || '', placeholder: 'ex. C:\\Users\\moi\\OneDrive\\KSTermus  ou  ~/Dropbox/KSTermus' });
    const browse = h('button', { class: 'btn sm', type: 'button', onclick: async () => { const f = await guard(() => api.invoke('sync:pickFolder')); if (f) folder.value = f; } }, 'Parcourir…');
    const g = st.github || {};
    const repo = h('input', { value: g.owner ? `${g.owner}/${g.repo}` : '', placeholder: 'koyaja/kstermus-sync' });
    const branch = h('input', { value: g.branch || 'main' });
    const token = h('input', { type: 'password', placeholder: g.hasToken ? '•••••• (enregistré — vide = garder)' : 'github_pat_…', autocomplete: 'off' });
    const pw = h('input', { type: 'password', autocomplete: 'off' });
    const folderBox = h('div', {}, field('Dossier synchronisé', h('div', { class: 'form-row' }, folder, browse), 'Un dossier déjà synchronisé par Google Drive, OneDrive, Dropbox, Syncthing… ou un partage réseau. Choisis le même sur chaque PC.'));
    const ghBox = h('div', {},
      h('div', { class: 'form-row' }, field('Dépôt privé (propriétaire/nom)', repo), h('div', { class: 'narrow' }, field('Branche', branch))),
      field('Jeton GitHub', secretInput(token, { copy: false }), 'GitHub ▸ Settings ▸ Developer settings ▸ Fine-grained tokens : accès à CE dépôt seulement, permission « Contents : Read and write ». Le jeton reste chiffré dans le coffre.'));
    // Google Drive (connexion directe, sans client Drive installé)
    const gd = st.gdrive || {};
    const gClient = h('input', { value: gd.clientId || S.settings.googleClientId || '', placeholder: '123456789-abc….apps.googleusercontent.com', spellcheck: 'false' });
    const gSecret = h('input', { type: 'password', placeholder: 'GOCSPX-… (fourni avec l\'identifiant)', autocomplete: 'off' });
    const gState = h('div', { class: 'small', text: gd.connected ? `✓ Connecté : ${gd.email || 'compte Google'}` : 'Pas encore connecté.' });
    let gConnected = !!gd.connected;
    const gBtn = h('button', { class: 'btn sm primary', type: 'button', onclick: async () => {
      if (!gClient.value.trim()) { toast('Renseigne l\'identifiant client Google', true); return; }
      gBtn.disabled = true; gState.textContent = 'Valide dans le navigateur qui vient de s\'ouvrir…';
      try {
        const r = await api.invoke('sync:gdriveConnect', { clientId: gClient.value.trim(), clientSecret: gSecret.value.trim() });
        gConnected = true; gState.textContent = `✓ Connecté : ${r.email || 'compte Google'}`;
        const s3 = await guard(() => api.invoke('settings:save', { googleClientId: gClient.value.trim() })); if (s3) S = s3;
      } catch (ex) { gState.textContent = '⚠ ' + ex.message; }
      finally { gBtn.disabled = false; }
    } }, gd.connected ? 'Reconnecter' : 'Se connecter à Google');
    const gGuide = h('details', { class: 'guide small' }, h('summary', { text: 'Créer l\'identifiant client Google (une seule fois, 5 min)' }),
      h('ol', {}, ...[
        'console.cloud.google.com ▸ créer un projet « KSTermus ».',
        'API et services ▸ Bibliothèque ▸ « Google Drive API » ▸ Activer.',
        'Écran de consentement OAuth ▸ Externe ▸ nom « KSTermus », ton e-mail ▸ Portées : ajouter « …/auth/drive.appdata » ▸ puis « Publier l\'application » (En production : sinon l\'accès expire au bout de 7 jours ; aucune validation Google nécessaire pour cette portée).',
        'Identifiants ▸ Créer ▸ ID client OAuth ▸ type « Application de bureau » ▸ copier l\'ID client et le code secret ici.',
        'Utilise le même identifiant sur tous tes PC (l\'espace caché de Drive est lié à cet identifiant).'
      ].map(x => h('li', { text: x }))));
    const gBox = h('div', {},
      field('Identifiant client Google (OAuth « Application de bureau »)', gClient),
      field('Code secret du client', secretInput(gSecret, { copy: false }), 'Pour une application de bureau, Google le fournit avec l\'identifiant ; il n\'est pas confidentiel au sens strict mais reste chiffré dans le coffre.'),
      h('div', { class: 'form-row', style: { alignItems: 'center', gap: '10px' } }, gBtn, gState),
      h('p', { class: 'muted small', text: 'KSTermus n\'a accès qu\'à son espace caché dans ton Drive (portée drive.appdata) : il ne voit aucun de tes fichiers, et le fichier n\'apparaît pas dans ton Drive. Contenu chiffré avant l\'envoi.' }),
      gGuide);
    const seg = h('div', { class: 'seg' },
      h('button', { type: 'button', class: method === 'gdrive' ? 'on' : '', onclick: (e) => setM('gdrive', e) }, '🟢 Google Drive'),
      h('button', { type: 'button', class: method === 'folder' ? 'on' : '', onclick: (e) => setM('folder', e) }, '📁 Dossier cloud'),
      h('button', { type: 'button', class: method === 'github' ? 'on' : '', onclick: (e) => setM('github', e) }, '🐙 GitHub privé'));
    function setM(m, e) { method = m; seg.querySelectorAll('button').forEach(b => b.classList.toggle('on', b === e.currentTarget)); folderBox.hidden = m !== 'folder'; ghBox.hidden = m !== 'github'; gBox.hidden = m !== 'gdrive'; }
    folderBox.hidden = method !== 'folder'; ghBox.hidden = method !== 'github'; gBox.hidden = method !== 'gdrive';
    const r = await modal({
      title: 'Synchronisation entre PC', wide: true,
      body: [seg, h('div', { style: { height: '10px' } }), gBox, folderBox, ghBox,
        field('Mot de passe de synchronisation', secretInput(pw, { copy: false }), st.enabled ? 'Le même que sur les autres PC (celui choisi lors de la première activation).' : 'Premier PC : choisis-le (ton mot de passe maître convient). Autres PC : le même. Il chiffre le fichier partagé.'),
        h('p', { class: 'muted small', text: 'Synchronisés : hosts, clés, snippets, tunnels, VPN, known hosts, espaces de travail, thème et réglages de sécurité. Restent sur ce PC : historique des éditions, journal d\'audit, enregistrements, shell par défaut, dossier de téléchargement.' })],
      actions: [{ label: 'Annuler', value: null }, { label: st.enabled ? 'Enregistrer et synchroniser' : 'Activer', class: 'primary', submit: true, onClick: async () => {
        const [owner, name] = repo.value.trim().replace(/^https?:\/\/github\.com\//, '').replace(/\.git$/, '').split('/');
        if (method === 'gdrive' && !gConnected) { toast('Clique d\'abord « Se connecter à Google »', true); return false; }
        const cfg = method === 'folder' ? { method, folder: folder.value.trim() }
          : method === 'gdrive' ? { method, gdrive: { clientId: gClient.value.trim(), clientSecret: gSecret.value.trim() } }
            : { method, github: { owner, repo: name, branch: branch.value.trim() || 'main', token: token.value.trim() } };
        if (method === 'folder' && !cfg.folder) { toast('Choisis un dossier', true); return false; }
        if (method === 'github' && (!owner || !name)) { toast('Dépôt au format propriétaire/nom', true); return false; }
        try { return await api.invoke('sync:enable', cfg, pw.value); } catch (ex) { toast(ex.message, true); return false; }
      } }]
    });
    if (!r) return;
    setState(r.state); renderSyncInd(r.state.sync); syncToast(r.result);
  }

  function settingSelect(title, desc, key, def, options, numeric) {
    const sel = h('select', { style: { width: '220px' } }, options.map(([v, l]) => h('option', { value: String(v), text: l })));
    sel.value = String(S.settings[key] === undefined ? def : S.settings[key]);
    sel.addEventListener('change', async () => { const st = await guard(() => api.invoke('settings:save', { [key]: numeric ? Number(sel.value) : sel.value })); if (st) S = st; });
    return h('div', { class: 'row' }, h('div', { class: 'row-main' }, h('div', { class: 'row-title', text: title }), h('div', { class: 'muted small', text: desc })), sel);
  }
  function securityRows() {
    const lockSel = h('select', { style: { width: '150px' } }, [[0, 'Jamais'], [1, '1 minute'], [5, '5 minutes'], [15, '15 minutes'], [30, '30 minutes'], [60, '1 heure'], [240, '4 heures']].map(([v, l]) => h('option', { value: String(v), text: l })));
    lockSel.value = String(S.settings.autoLockMinutes === undefined ? 15 : S.settings.autoLockMinutes);
    lockSel.addEventListener('change', async () => { const s = await guard(() => api.invoke('settings:save', { autoLockMinutes: Number(lockSel.value) })); if (s) S = s; });

    const helloSel = h('select', { style: { width: '200px' }, disabled: true },
      h('option', { value: 'off', text: 'Désactivé' }), h('option', { value: 'screen', text: 'Écran verrouillé' }), h('option', { value: 'startup', text: 'Écran + démarrage' }));
    const helloInfo = h('div', { class: 'muted small', text: 'Vérification de Windows Hello…' });
    const helloDesc = 'Visage, empreinte ou code PIN Windows. « Démarrage » garde la clé du coffre chiffrée par Windows (DPAPI) : quiconque ouvre ta session Windows ET passe Hello ouvre le coffre.';
    let current = 'off';
    api.invoke('hello:status').then(st => {
      current = st.startup ? 'startup' : S.settings.helloScreen ? 'screen' : 'off';
      helloSel.value = current;
      helloSel.disabled = !st.ok && current === 'off';
      helloInfo.textContent = st.ok ? helloDesc : 'Indisponible : ' + (st.reason || 'Windows Hello absent');
    }).catch(e => { helloInfo.textContent = 'Indisponible : ' + e.message; });
    helloSel.addEventListener('change', async () => {
      const v = helloSel.value;
      helloSel.disabled = true;
      if (v !== 'off') helloInfo.textContent = 'Confirme avec Windows Hello…';
      const s = await guard(() => api.invoke('hello:configure', { screen: v !== 'off', startup: v === 'startup' }));
      helloSel.disabled = false;
      helloInfo.textContent = helloDesc;
      if (s) { S = s; current = v; toast(v === 'off' ? 'Windows Hello désactivé' : 'Windows Hello activé'); }
      else helloSel.value = current;
    });

    return [
      h('div', { class: 'row' }, h('div', { class: 'row-main' }, h('div', { class: 'row-title', text: 'Verrouillage automatique' }), h('div', { class: 'muted small', text: 'Après cette durée sans clavier ni souris dans KSTermus. Les sessions et tunnels continuent ; Ctrl+Shift+L verrouille tout de suite.' })), lockSel),
      h('div', { class: 'row' }, h('div', { class: 'row-main' }, h('div', { class: 'row-title', text: 'Verrouiller avec Windows' }), h('div', { class: 'muted small', text: 'Quand la session Windows se verrouille (Win+L) ou que le PC se met en veille.' })),
        checkbox(S.settings.lockOnSystemLock !== false, async (c) => { const s = await guard(() => api.invoke('settings:save', { lockOnSystemLock: c.checked })); if (s) S = s; })),
      h('div', { class: 'row' }, h('div', { class: 'row-main' }, h('div', { class: 'row-title', text: 'Windows Hello' }), helloInfo), helloSel),
      settingSelect('Alerte commandes dangereuses', 'rm -rf, DROP, mkfs, reboot, git push --force… : confirmation en retapant le nom du host.', 'dangerMode', 'prod',
        [['prod', 'Hosts marqués PROD'], ['all', 'Tous les terminaux'], ['off', 'Désactivée']]),
      settingSelect('Journal d\'audit', 'Connexions, commandes, fichiers modifiés, transferts, VPN, déverrouillages — chiffré, consultable dans Journal.', 'auditRetentionDays', 180,
        [[30, 'Garder 30 jours'], [90, 'Garder 90 jours'], [180, 'Garder 6 mois'], [365, 'Garder 1 an'], [0, 'Garder tout']], true),
      h('div', { class: 'row' }, h('div', { class: 'row-main' }, h('div', { class: 'row-title', text: 'Activer le journal d\'audit' })),
        checkbox(S.settings.auditEnabled !== false, async (c) => { const s = await guard(() => api.invoke('settings:save', { auditEnabled: c.checked })); if (s) S = s; })),
      h('div', { class: 'row' }, h('div', { class: 'row-main' }, h('div', { class: 'row-title', text: 'Notifications du tableau de bord' }), h('div', { class: 'muted small', text: 'Notification système quand un serveur surveillé est en alerte ou redevient normal.' })),
        checkbox(S.settings.monitorNotify !== false, async (c) => { const st2 = await guard(() => api.invoke('settings:save', { monitorNotify: c.checked })); if (st2) S = st2; })),
      h('div', { class: 'row' }, h('div', { class: 'row-main' }, h('div', { class: 'row-title', text: 'Intégration shell (SSH bash / zsh)' }), h('div', { class: 'muted small', text: 'Marque verte / rouge et durée de chaque commande, dossier courant (SFTP et éditeur s\'ouvrent dedans, retour au même dossier après une reconnexion). Une ligne invisible est tapée à la connexion ; rien n\'est écrit sur le serveur. Prend effet aux prochaines connexions.' })),
        checkbox(S.settings.shellIntegration !== false, async (c) => { const st2 = await guard(() => api.invoke('settings:save', { shellIntegration: c.checked })); if (st2) S = st2; })),
      settingSelect('Notifier les commandes longues', 'Quand une commande dure plus longtemps que ce seuil et se termine pendant que tu regardes ailleurs (autre onglet, autre fenêtre) : notification avec le résultat.', 'notifyLongCommands', 10,
        [[0, 'Jamais'], [10, 'Plus de 10 s'], [30, 'Plus de 30 s'], [60, 'Plus d\'1 min'], [300, 'Plus de 5 min']], true),
      settingSelect('Enregistrement des sessions SSH', 'Tout ce qui s\'affiche est enregistré (chiffré) pour être relu dans Journal ▸ Enregistrements. Les mots de passe tapés à une invite masquée ne s\'affichent pas, donc ne sont pas enregistrés.', 'recordSessions', 'marked',
        [['marked', 'Hosts cochés « Enregistrer »'], ['all', 'Toutes les sessions SSH'], ['off', 'Jamais']])
    ];
  }

  const SHORTCUTS = [
    ['Ctrl+Shift+P', 'Palette de commandes'],
    ['Ctrl+Shift+L', 'Verrouiller l\'écran (sessions conservées)'],
    ['Ctrl+Shift+F', 'Rechercher dans le terminal (Entrée / Maj+Entrée, Échap)'],
    ['Ctrl+T', 'Nouvelle connexion (local ou SSH)'],
    ['Ctrl+Shift+T', 'Nouveau terminal local (shell par défaut)'],
    ['Ctrl+B puis …', 'Préfixe façon tmux (voir Local)'],
    ['Ctrl+Shift+↑ / ↓', 'Commande précédente / suivante (blocs)'],
    ['Ctrl+Shift+O', 'Copier la sortie de la dernière commande'],
    ['Ctrl+Shift+D', 'Diviser le panneau à droite'],
    ['Ctrl+Shift+E', 'Diviser le panneau en bas'],
    ['Alt+Flèches', 'Passer d\'un panneau à l\'autre'],
    ['Ctrl+Shift+Entrée', 'Agrandir / restaurer le panneau'],
    ['Ctrl+Shift+B', 'Diffuser la saisie à tous les panneaux'],
    ['Ctrl+Shift+W', 'Fermer le panneau (ou l\'onglet)'],
    ['Ctrl+Tab · Ctrl+1…9', 'Changer d\'onglet'],
    ['Ctrl+Shift+C / V', 'Copier / coller (clic droit = coller)'],
    ['Ctrl + / Ctrl − / Ctrl 0', 'Taille du texte'],
    ['F11', 'Plein écran']
  ];

  function changeMaster() {
    const a = h('input', { type: 'password' }), b = h('input', { type: 'password', minlength: 8 }), c = h('input', { type: 'password', minlength: 8 });
    return modal({
      title: 'Changer le mot de passe maître',
      body: [field('Actuel', secretInput(a, { copy: false })), field('Nouveau', secretInput(b)), field('Confirmer', secretInput(c, { copy: false }))],
      actions: [{ label: 'Annuler', value: false }, { label: 'Changer', class: 'primary', submit: true, onClick: async () => {
        if (b.value !== c.value) { toast('Les deux mots de passe diffèrent', true); return false; }
        const ok = await guard(() => api.invoke('vault:changePassword', a.value, b.value));
        if (ok) toast('Mot de passe maître changé');
        return !!ok;
      } }]
    });
  }

  async function refresh() { const s = await guard(() => api.invoke('state:get')); if (s) setState(s); }

  // ---------- Onglets ----------
  // Un onglet "term" contient un arbre de panneaux :
  //   { type: 'pane', id }  |  { type: 'split', dir: 'row' | 'col', ratio, a, b }
  const panes = new Map();     // sessionId -> panneau (routage des données SSH)

  function statusOf(t) {
    if (t.kind !== 'term') return t.status;
    const st = [...t.panes.values()].map(p => p.status);
    if (st.includes('on')) return 'on';
    if (st.includes('wait')) return 'wait';
    return 'off';
  }
  function tabTitle(t) {
    if (t.kind !== 'term') return t.title;
    if (t.customTitle) return t.customTitle;
    const first = t.panes.get(t.activePane) || [...t.panes.values()][0];
    const base = first ? first.title : t.title;
    return t.panes.size > 1 ? `${base} (+${t.panes.size - 1})` : base;
  }

  function renderTabs() {
    const bar = $('#tabs');
    const homeTab = h('div', { class: 'tab home-tab' + (ui.activeTab === 'home' ? ' active' : ''), onclick: () => activateTab('home') }, h('span', { text: '🏠' }), h('span', { class: 'tab-title', text: 'Coffre' }));
    const tabEls = [...tabs.values()].map(t => h('div', {
      class: 'tab' + (ui.activeTab === t.id ? ' active' : ''), title: tabTitle(t),
      onclick: () => activateTab(t.id), onauxclick: (e) => { if (e.button === 1) closeTab(t.id); }
    }, h('span', { class: 'dot ' + statusOf(t) }),
    t.kind === 'sftp' ? h('span', { text: '📁' }) : t.kind === 'edit' ? h('span', { text: t.sudo ? '🛡' : '📝' }) : (t.panes.size > 1 ? h('span', { class: 'split-ind', title: `${t.panes.size} panneaux`, text: '◫' }) : null),
    t.broadcast ? h('span', { class: 'bc-ind', title: 'Diffusion active', text: '📡' }) : null,
    h('span', { class: 'tab-title', text: tabTitle(t) }), t.kind === 'edit' && t.dirty ? h('span', { class: 'dirty-dot', title: 'Non enregistré', text: '●' }) : null,
    h('span', { class: 'tab-close', title: 'Fermer l\'onglet', onclick: (e) => { e.stopPropagation(); closeTab(t.id); } }, '✕')));
    const plus = h('button', { class: 'tab-new', title: 'Nouvelle connexion (Ctrl+T)', onclick: (e) => quickConnect(e.currentTarget) }, '+');
    bar.replaceChildren(homeTab, ...tabEls, plus);
  }

  function quickConnect(anchor) {
    const items = specChoices(null, (spec) => openTermTab(spec));
    if (!items.length) { activateTab('home'); toast('Ajoute un host ou installe un shell', true); return; }
    popupMenu(anchor || $('.tab-new'), items);
  }

  function activateTab(id) {
    if (id !== 'home' && !tabs.has(id)) id = 'home';
    ui.activeTab = id;
    $('#home').hidden = id !== 'home';
    $('#sessions').hidden = id === 'home';
    for (const t of tabs.values()) t.el.hidden = t.id !== id;
    const t = tabs.get(id);
    if (t && t.kind === 'term') {
      ui.lastTerm = id;
      requestAnimationFrame(() => { fitTab(t); const p = t.panes.get(t.activePane); if (p) p.term.focus(); });
    }
    if (id === 'home') renderSection();
    renderTabs();
    document.title = t ? `${tabTitle(t)} — KSTermus` : 'KSTermus';
  }

  function setStatus(t, st) { t.status = st; renderTabs(); }

  function disposePane(p, opts = {}) {
    panes.delete(p.id);
    if (p.dispose) p.dispose();
    if (p.ro) p.ro.disconnect();
    p.term.dispose();
    p.el.remove();
    if (opts.detach) { p.detached = true; api.invoke('local:detach', p.id).catch(() => {}); }
    else api.invoke('ssh:close', p.id).catch(() => {});
  }

  function disposeTab(id) {
    const t = tabs.get(id);
    if (!t) return;
    tabs.delete(id);
    if (t.kind === 'term') for (const p of t.panes.values()) disposePane(p);
    else if (t.kind === 'edit') { api.invoke('editor:close', id).catch(() => {}); }
    else api.invoke('sftp:close', id).catch(() => {});
    t.el.remove();
  }
  async function closeTab(id) {
    const ct = tabs.get(id);
    if (ct && ct.kind === 'edit' && ct.dirty) {
      activateTab(id);
      const r = await modal({ title: 'Modifications non enregistrées', body: h('p', { text: `${ct.path} a des modifications non enregistrées.` }),
        actions: [{ label: 'Annuler', value: 'cancel' }, { label: 'Fermer sans enregistrer', class: 'danger', value: 'discard' }, { label: 'Enregistrer', class: 'primary', value: 'save', submit: true }] });
      if (!r || r === 'cancel') return;
      if (r === 'save') { await ct.save(); if (ct.dirty) return; }
    }
    const order = [...tabs.keys()];
    const idx = order.indexOf(id);
    disposeTab(id);
    if (ui.activeTab === id) {
      const rest = [...tabs.keys()];
      activateTab(rest[Math.min(idx, rest.length - 1)] || 'home');
    } else renderTabs();
  }

  // Taille de police (Ctrl + / Ctrl - / Ctrl 0)
  async function setFontSize(n) {
    n = Math.max(9, Math.min(28, n));
    for (const t of tabs.values()) if (t.kind === 'term') for (const p of t.panes.values()) p.term.options.fontSize = n;
    for (const t of tabs.values()) if (t.kind === 'term') fitTab(t);
    const s = await guard(() => api.invoke('settings:save', { fontSize: n }));
    if (s) S = s;
    toast(`Police : ${n}px`);
  }

  // ---------- Préfixe façon tmux ----------
  const PREFIX_MS = 2500;
  function prefixKey() { return (S && S.settings.tmuxPrefix) || 'ctrl+b'; }
  function isPrefix(e) {
    const pk = prefixKey();
    if (pk === 'off') return false;
    const letter = pk.split('+')[1];
    return e.ctrlKey && !e.shiftKey && !e.altKey && e.key.toLowerCase() === letter;
  }
  function setPrefix(on) {
    ui.prefixAt = on ? Date.now() : 0;
    document.body.classList.toggle('prefix-on', on);
    const badge = $('#prefix-badge');
    if (badge) badge.textContent = `PRÉFIXE ${prefixKey().replace('ctrl+', 'Ctrl+').toUpperCase().replace('CTRL', 'Ctrl')} — ? pour l'aide`;
    clearTimeout(ui.prefixTimer);
    if (on) ui.prefixTimer = setTimeout(() => setPrefix(false), PREFIX_MS);
  }

  // Exécute la commande tmux qui suit le préfixe. Renvoie true si la touche a été consommée.
  function runPrefixCommand(e, term) {
    const k = e.key;
    const kl = k.toLowerCase();
    const p = term && term.panes.get(term.activePane);
    if (isPrefix(e)) { if (p && p.status === 'on') p.writeInput(String.fromCharCode(prefixKey().split('+')[1].charCodeAt(0) - 96)); return true; }
    if (k === 'Escape') return true;
    if (k === '?') { showTmuxHelp(); return true; }
    if (k === ':') { openPalette(); return true; }
    if (k === 'c') { openLocal(); return true; }
    if (k === 's') { pickLocalSession(); return true; }
    if (k === 'w') { pickTab(); return true; }
    if (k === 'n' || k === 'p') { const ids = ['home', ...tabs.keys()]; const i = ids.indexOf(ui.activeTab); activateTab(ids[(i + (k === 'n' ? 1 : -1) + ids.length) % ids.length]); return true; }
    if (/^[0-9]$/.test(k)) { const ids = [...tabs.keys()]; const id = ids[Number(k) === 0 ? 9 : Number(k) - 1]; if (id) activateTab(id); return true; }
    if (!term) return true;
    if (k === '%') { splitPane(term, term.activePane, 'row'); return true; }
    if (k === '"') { splitPane(term, term.activePane, 'col'); return true; }
    if (k.startsWith('Arrow')) { focusNeighbor(term, kl.slice(5)); return true; }
    if (k === 'o') { const order = paneOrder(term.layout); const i = order.indexOf(term.activePane); const nx = term.panes.get(order[(i + 1) % order.length]); if (nx) { setActivePane(term, nx.id); nx.term.focus(); } return true; }
    if (k === 'x') { closePane(term, term.activePane); return true; }
    if (k === 'z') { toggleZoom(term, term.activePane); return true; }
    if (k === 'd') { detachPane(term, term.activePane); return true; }
    if (k === 'b') { toggleBroadcast(term); return true; }
    if (k === ',') { renameTab(term); return true; }
    if (k === 'S') { saveWorkspace(term); return true; }
    if (k === '[') { jumpCommand(p, -1); return true; }
    if (k === ']') { jumpCommand(p, 1); return true; }
    if (k === 'y') { copyLastOutput(p); return true; }
    if (k === '/') { openTermSearch(p); return true; }
    return true; // touche inconnue : consommée, comme tmux
  }

  // Raccourcis globaux (phase de capture : passent avant xterm)
  document.addEventListener('keydown', (e) => {
    // macOS : Cmd pour les raccourcis de l'application ; Ctrl reste au terminal.
    const mod = api.platform === 'darwin' ? e.metaKey : e.ctrlKey;
    if (!S || !$('#lock').hidden) return;
    if (['Control', 'Shift', 'Alt', 'Meta'].includes(e.key)) return;
    const k = e.key.toLowerCase();
    const t = tabs.get(ui.activeTab);
    const term = t && t.kind === 'term' ? t : null;
    const stop = () => { e.preventDefault(); e.stopPropagation(); };
    const inModal = !!document.querySelector('.backdrop, .palette');
    if (ui.prefixAt && Date.now() - ui.prefixAt < PREFIX_MS && !inModal) { stop(); setPrefix(false); runPrefixCommand(e, term); return; }
    if (!inModal && isPrefix(e) && (term || ui.activeTab === 'home')) { stop(); setPrefix(true); return; }
    if (term && mod && !e.altKey && e.code === 'KeyF' && (e.shiftKey || S.settings.ctrlFSearch) && !inModal) { stop(); openTermSearch(term.panes.get(term.activePane)); return; }
    if (mod && e.shiftKey && k === 'l') { stop(); api.invoke('lock:screen').catch(() => {}); return; }
    if (mod && e.shiftKey && k === 'p') { stop(); openPalette(); return; }
    if (inModal) return;
    if (mod && !e.shiftKey && k === 's' && t && t.kind === 'edit') { stop(); t.save(); return; }
    if (mod && e.key === 'Tab') {
      stop();
      const ids = ['home', ...tabs.keys()];
      const i = ids.indexOf(ui.activeTab);
      activateTab(ids[(i + (e.shiftKey ? -1 : 1) + ids.length) % ids.length]);
    } else if (mod && e.shiftKey && k === 't') { stop(); openLocal(); }
    else if (mod && !e.shiftKey && !e.altKey && k === 't') { stop(); quickConnect(); }
    else if (mod && e.shiftKey && k === 'w' && ui.activeTab !== 'home') {
      stop();
      if (term && term.panes.size > 1) closePane(term, term.activePane); else closeTab(ui.activeTab);
    } else if (term && mod && e.shiftKey && k === 'd') { stop(); splitPane(term, term.activePane, 'row'); }
    else if (term && mod && e.shiftKey && k === 'e') { stop(); splitPane(term, term.activePane, 'col'); }
    else if (term && mod && e.shiftKey && k === 'b') { stop(); toggleBroadcast(term); }
    else if (term && mod && e.shiftKey && k === 'enter') { stop(); toggleZoom(term, term.activePane); }
    else if (term && mod && e.shiftKey && (k === 'arrowup' || k === 'arrowdown')) { stop(); jumpCommand(term.panes.get(term.activePane), k === 'arrowup' ? -1 : 1); }
    else if (term && mod && e.shiftKey && k === 'o') { stop(); copyLastOutput(term.panes.get(term.activePane)); }
    else if (term && e.altKey && !mod && ['arrowleft', 'arrowright', 'arrowup', 'arrowdown'].includes(k)) { stop(); focusNeighbor(term, k.slice(5)); }
    else if (mod && !e.shiftKey && (k === '=' || k === '+')) { stop(); setFontSize((S.settings.fontSize || 14) + 1); }
    else if (mod && !e.shiftKey && k === '-') { stop(); setFontSize((S.settings.fontSize || 14) - 1); }
    else if (mod && !e.shiftKey && k === '0') { stop(); setFontSize(14); }
    else if (mod && /^[1-9]$/.test(e.key) && !e.shiftKey && !e.altKey) {
      stop();
      const ids = ['home', ...tabs.keys()];
      const n = Number(e.key);
      activateTab(n === 9 ? ids[ids.length - 1] : (ids[n - 1] || ids[ids.length - 1]));
    }
  }, true);

  function overlay(container, content) {
    const old = container.querySelector(':scope > .overlay'); if (old) old.remove();
    if (!content) return;
    container.append(h('div', { class: 'overlay' }, h('div', { class: 'overlay-card' }, content)));
  }

  // ---------- Terminal (avec split) ----------
  // ---------- Thèmes ----------
  let TERM_THEME = null;
  let themeId = 'auto';
  function applyTheme(id, { save = false } = {}) {
    const TH = window.KST_THEMES;
    themeId = !id || id === 'dark' ? 'auto' : id; // 'dark' : valeur par défaut des anciens coffres
    const rid = TH.resolve(themeId);
    const t = TH.themes[rid];
    const root = document.documentElement;
    for (const [k, v] of Object.entries(TH.cssVars(t))) root.style.setProperty(k, v);
    document.body.classList.toggle('theme-light', !!t.light);
    root.style.colorScheme = t.light ? 'light' : 'dark';
    TERM_THEME = { ...t.term, cursorAccent: t.term.background };
    for (const p of panes.values()) p.term.options.theme = TERM_THEME;
    try { localStorage.setItem('kst-theme', themeId); } catch { /* ignore */ }
    api.invoke('window:theme', { color: t.ui.bg2, symbolColor: t.ui.muted, background: t.ui.bg }).catch(() => {});
    if (save) return guard(() => api.invoke('settings:save', { theme: themeId }));
    return null;
  }
  try { if (window.matchMedia) window.matchMedia('(prefers-color-scheme: light)').addEventListener('change', () => { if (themeId === 'auto') applyTheme('auto'); }); } catch { /* ignore */ }

  function fitTab(t) { if (t.kind === 'term') for (const p of t.panes.values()) p.fit(); }

  // Un panneau est décrit par une "spec" : { type: 'ssh', hostId } ou { type: 'local', shellId, attachId? }
  function openTerminal(hostId) { if (hostById(hostId)) return openTermTab({ type: 'ssh', hostId }); }
  function openLocal(shellId, extra = {}) { return openTermTab({ type: 'local', shellId: shellId || defaultShellId(), ...extra }); }

  function defaultShellId() {
    const pref = S && S.settings.defaultShell;
    if (pref && ui.shells.some(s => s.id === pref)) return pref;
    return ui.shells[0] ? ui.shells[0].id : null;
  }
  const shellById = (id) => ui.shells.find(s => s.id === id);

  function newTermTab() {
    const id = uid();
    const body = h('div', { class: 'pane-root' });
    const info = h('span', { class: 'bar-info' });
    const bcBtn = h('button', { class: 'btn sm', title: 'Diffuser la saisie à tous les panneaux (Ctrl+Shift+B)' }, '📡 Diffusion');
    const snipBtn = h('button', { class: 'btn sm', title: 'Snippets' }, '⚡ Snippets');
    const splitR = h('button', { class: 'icon-btn bar-icon', title: 'Diviser à droite (Ctrl+Shift+D · préfixe %)' }, svgSplit('row'));
    const splitD = h('button', { class: 'icon-btn bar-icon', title: 'Diviser en bas (Ctrl+Shift+E · préfixe ")' }, svgSplit('col'));
    const sshOnly = (fn) => () => { const p = t.panes.get(t.activePane); if (!p) return; if (p.spec.type !== 'ssh') { toast('Disponible pour les panneaux SSH', true); return; } fn(p); };
    const bar = h('div', { class: 'session-bar' }, info, h('span', { class: 'spacer' }),
      splitR, splitD, bcBtn, snipBtn,
      h('button', { class: 'btn sm', title: 'Sauvegarder cette disposition comme espace de travail', onclick: () => saveWorkspace(t) }, '💾'),
      h('button', { class: 'btn sm ssh-only', title: 'Ouvrir et éditer un fichier du serveur (normal ou sudo)', onclick: sshOnly(p => promptOpenFile(p.spec.hostId, p.cwd)) }, '📝 Éditer'),
      h('button', { class: 'btn sm ssh-only', title: 'SFTP sur le host du panneau actif (ouvert dans le dossier courant du terminal)', onclick: sshOnly(p => openSftp(p.spec.hostId, p.cwd)) }, '📁 SFTP'));
    const el = h('div', { class: 'session' }, bar, h('div', { class: 'term-area' }, body));
    $('#sessions').append(el);
    const t = { id, kind: 'term', title: '', el, body, info, bcBtn, panes: new Map(), layout: null, activePane: null, broadcast: false, zoomed: null, customTitle: null };
    tabs.set(id, t);
    splitR.onclick = (e) => splitMenu(e.currentTarget, t, 'row');
    splitD.onclick = (e) => splitMenu(e.currentTarget, t, 'col');
    bcBtn.onclick = () => toggleBroadcast(t);
    snipBtn.onclick = () => popupMenu(snipBtn, S.snippets.map(sn => ({ label: sn.name, sub: sn.command, onClick: () => sendSnippet(id, sn) })));
    return t;
  }

  function openTermTab(spec) {
    if (spec.type === 'local' && !spec.shellId && !spec.attachId) { toast('Aucun shell local détecté', true); return; }
    const t = newTermTab();
    const p = createPane(t, spec);
    t.layout = { type: 'pane', id: p.id };
    t.activePane = p.id;
    renderLayout(t);
    activateTab(t.id);
    p.connect();
    return t;
  }

  function svgSplit(dir) {
    const ns = 'http://www.w3.org/2000/svg';
    const s = document.createElementNS(ns, 'svg');
    s.setAttribute('viewBox', '0 0 16 16'); s.setAttribute('width', '16'); s.setAttribute('height', '16');
    const r = document.createElementNS(ns, 'rect');
    Object.entries({ x: 1.5, y: 2.5, width: 13, height: 11, rx: 2, fill: 'none', stroke: 'currentColor', 'stroke-width': 1.4 }).forEach(([k, v]) => r.setAttribute(k, v));
    const l = document.createElementNS(ns, 'line');
    const c = dir === 'row' ? { x1: 8, y1: 2.5, x2: 8, y2: 13.5 } : { x1: 1.5, y1: 8, x2: 14.5, y2: 8 };
    Object.entries({ ...c, stroke: 'currentColor', 'stroke-width': 1.4 }).forEach(([k, v]) => l.setAttribute(k, v));
    s.append(r, l);
    return s;
  }

  function specChoices(cur, onPick) {
    const items = [];
    if (cur) items.push({ label: `↳ Même : ${cur.title}`, sub: 'nouvelle session', onClick: () => onPick(baseSpec(cur.spec)) });
    for (const sh of ui.shells) items.push({ label: `${sh.icon} ${sh.name}`, sub: 'terminal local', onClick: () => onPick({ type: 'local', shellId: sh.id }) });
    for (const x of S.hosts.slice().sort((a, b) => a.label.localeCompare(b.label))) {
      items.push({ label: x.label, sub: `ssh ${x.username}@${x.hostname}`, onClick: () => onPick({ type: 'ssh', hostId: x.id }) });
    }
    return items;
  }
  const baseSpec = (spec) => spec.type === 'ssh' ? { type: 'ssh', hostId: spec.hostId } : { type: 'local', shellId: spec.shellId };

  function splitMenu(anchor, t, dir) {
    popupMenu(anchor, specChoices(t.panes.get(t.activePane), (spec) => splitPane(t, t.activePane, dir, spec)));
  }

  function createPane(t, spec) {
    const isLocal = spec.type === 'local';
    const host = isLocal ? null : hostById(spec.hostId);
    const shell = isLocal ? shellById(spec.shellId) : null;
    const id = isLocal && spec.attachId ? spec.attachId : uid();
    const title0 = isLocal ? (shell ? shell.name : 'Terminal local') : host.label;
    const sub0 = isLocal ? 'local' : `${host.username}@${host.hostname}`;
    const termHost = h('div', { class: 'term-host' });
    const wrap = h('div', { class: 'term-wrap' }, termHost);
    const dot = h('span', { class: 'dot wait' });
    const titleEl = h('span', { class: 'pane-title', text: title0 });
    const head = h('div', { class: 'pane-head' },
      dot, h('span', { class: 'pane-kind', text: isLocal ? (shell ? shell.icon : '❯') : '🖧' }), titleEl, h('span', { class: 'pane-sub', text: sub0 }),
      !isLocal ? envBadge(host.env) : null, !isLocal && host.record || (!isLocal && S.settings.recordSessions === 'all') ? h('span', { class: 'rec-badge', title: 'Session enregistrée' }, '●REC') : null,
      h('span', { class: 'spacer' }),
      h('button', { class: 'icon-btn mini', title: 'Copier la sortie de la dernière commande', onclick: (e) => { e.stopPropagation(); copyLastOutput(p); } }, '⧉'),
      isLocal ? h('button', { class: 'icon-btn mini', title: 'Détacher (la session continue en arrière-plan) — préfixe d', onclick: (e) => { e.stopPropagation(); detachPane(t, id); } }, '⏏') : null,
      h('button', { class: 'icon-btn mini', title: 'Diviser à droite', onclick: (e) => { e.stopPropagation(); setActivePane(t, id); splitPane(t, id, 'row'); } }, '⫿'),
      h('button', { class: 'icon-btn mini', title: 'Diviser en bas', onclick: (e) => { e.stopPropagation(); setActivePane(t, id); splitPane(t, id, 'col'); } }, '⊟'),
      h('button', { class: 'icon-btn mini', title: 'Agrandir / restaurer (Ctrl+Shift+Entrée · préfixe z)', onclick: (e) => { e.stopPropagation(); toggleZoom(t, id); } }, '⤢'),
      h('button', { class: 'icon-btn mini', title: 'Fermer le panneau (Ctrl+Shift+W · préfixe x)', onclick: (e) => { e.stopPropagation(); closePane(t, id); } }, '✕'));
    const el = h('div', { class: 'pane' + (isLocal ? ' local' : '') + (!isLocal && host.env === 'prod' ? ' pane-prod' : '') }, head, wrap);
    head.addEventListener('dblclick', () => toggleZoom(t, id));

    const term = new Terminal({
      fontFamily: '"Cascadia Mono", "Cascadia Code", Consolas, "JetBrains Mono", monospace',
      fontSize: S.settings.fontSize || 14, cursorBlink: true, scrollback: 10000, theme: TERM_THEME, allowProposedApi: true
    });
    const fitAddon = new FitAddon.FitAddon();
    term.loadAddon(fitAddon);
    term.loadAddon(new WebLinksAddon.WebLinksAddon((_e, uri) => window.open(uri)));
    const searchAddon = new SearchAddon.SearchAddon();
    term.loadAddon(searchAddon);
    term.open(termHost);

    const p = { id, search: searchAddon, tabId: t.id, spec: { ...spec }, hostId: isLocal ? null : spec.hostId, isLocal, title: title0, el, wrap, dot, term, status: 'wait', ro: null, blocks: [] };
    p.fit = () => {
      if (t.el.hidden || !el.isConnected || el.offsetParent === null) return;
      try {
        fitAddon.fit();
        if (p.status === 'on' && (p.cols !== term.cols || p.rows !== term.rows)) { p.cols = term.cols; p.rows = term.rows; api.resize(id, term.cols, term.rows); }
      } catch { /* ignore */ }
    };
    let raf = 0;
    p.ro = new ResizeObserver(() => { cancelAnimationFrame(raf); raf = requestAnimationFrame(p.fit); });
    p.ro.observe(wrap);
    panes.set(id, p);
    t.panes.set(id, p);
    shellIntegrationHandlers(p, t);

    const setPaneStatus = (st) => { p.status = st; dot.className = 'dot ' + st; renderTabs(); };
    const sendInput = (d, danger) => {
      const targets = t.broadcast ? [...t.panes.values()].filter(q => q.status === 'on') : (p.status === 'on' ? [p] : []);
      for (const q of targets) {
        if (/[\r\n]/.test(d)) {
          if (q.term.buffer.active.type === 'normal') {
            const cmds = commandsIn(q, d);
            markCommand(q, cmds[0]);
            if (!q.isLocal) for (const c of cmds) api.auditCommand(q.id, c, danger || null, false);
          }
          resetTyping(q);
          const tail = d.split(/\r\n|\r|\n/).pop();
          if (tail) trackTyping(q, tail);
        } else trackTyping(q, d);
        api.write(q.id, d);
      }
    };
    const writeInput = (d) => {
      // Collage « bracketed paste » : le shell n'exécute rien avant un vrai Entrée.
      if (d.startsWith('\x1b[200~')) {
        for (const q of (t.broadcast ? [...t.panes.values()].filter(x => x.status === 'on') : (p.status === 'on' ? [p] : []))) {
          const inner = d.replace(/^\x1b\[200~/, '').replace(/\x1b\[201~$/, '');
          if (/[\r\n]/.test(inner)) q.typedOk = false; else trackTyping(q, inner);
          api.write(q.id, d);
        }
        return;
      }
      if (/[\r\n]/.test(d)) {
        const targets = t.broadcast ? [...t.panes.values()].filter(q => q.status === 'on') : [p];
        const risky = [];
        for (const q of targets) {
          if (!dangerCheckOn(q) || q.term.buffer.active.type !== 'normal') continue;
          const hits = commandsIn(q, d, true).map(c => ({ q, c, why: window.KST_DANGER.check(c) })).filter(x => x.why.length);
          // Variantes tapé / écran de la même ligne : on garde la plus complète.
          const firstLine = hits.filter(x => !d.split(/\r\n|\r|\n/).slice(1).includes(x.c)).sort((a2, b2) => b2.c.length - a2.c.length)[0];
          for (const x of hits) if (x === firstLine || d.split(/\r\n|\r|\n/).slice(1).includes(x.c)) risky.push(x);
        }
        if (risky.length) { confirmDanger(risky).then(ok => { if (ok) sendInput(d, risky.flatMap(r => r.why)); }); return; }
      }
      sendInput(d);
    };
    p.writeInput = writeInput;
    term.onData(writeInput);
    term.onTitleChange((title) => {
      if (!title) return;
      p.shellTitle = title;
      if (isLocal) { titleEl.textContent = title.length > 60 ? '…' + title.slice(-58) : title; api.invoke('local:title', id, title).catch(() => {}); }
      if (t.activePane === id) { updateBar(t); renderTabs(); }
    });
    // Presse-papiers — une seule écriture / un seul collage par action :
    //  · sélection à la souris : copiée UNE fois, au relâchement du bouton (pas à chaque mouvement) ;
    //  · Ctrl+Shift+C : copie (ignorée si ce texte vient déjà d'être copié) ;
    //  · Ctrl+C avec une sélection : copie native (comme Windows Terminal), sinon ^C part au shell ;
    //  · Ctrl+Shift+V (et Ctrl+V en local sous Windows) : collage NATIF du navigateur uniquement,
    //    géré par xterm (bracketed paste) — on ne recolle pas à la main, d'où l'ancien doublon ;
    //  · clic droit : colle via term.paste().
    termHost.addEventListener('mouseup', () => setTimeout(() => { if (term.hasSelection()) copyText(term.getSelection()); }, 0));
    term.attachCustomKeyEventHandler(ev => {
      if (ev.type !== 'keydown') return true;
      if (ev.ctrlKey && ev.shiftKey && ev.code === 'KeyC') { if (term.hasSelection()) copyText(term.getSelection()); return false; }
      if (ev.ctrlKey && ev.shiftKey && ev.code === 'KeyV') return false; // laisse le collage natif
      if (ev.ctrlKey && !ev.shiftKey && !ev.altKey && ev.code === 'KeyC' && term.hasSelection()) {
        copyText(term.getSelection());
        setTimeout(() => term.clearSelection(), 0);
        ev.preventDefault();
        return false;
      }
      if (ev.ctrlKey && !ev.shiftKey && !ev.altKey && ev.code === 'KeyV' && api.platform === 'win32') return false; // Ctrl+V colle sous Windows (collage natif)
      return true;
    });
    termHost.addEventListener('contextmenu', (e) => { e.preventDefault(); api.invoke('clipboard:read').then(x => { if (x && p.status === 'on') term.paste(x); }); });
    el.addEventListener('mousedown', () => setActivePane(t, id), true);
    term.textarea && term.textarea.addEventListener('focus', () => setActivePane(t, id));

    p.retry = { attempt: 0, timer: null, tick: null };
    const clearRetry = () => { clearTimeout(p.retry.timer); clearInterval(p.retry.tick); p.retry.timer = p.retry.tick = null; };
    const FATAL = /Authentification refusée|Clé d'hôte refusée|Boucle de jump|n'existe plus|Trop de rebonds|Coffre verrouillé/;
    // Reconnexion automatique : 2 s, 4 s, 8 s, 15 s puis toutes les 30 s (20 tentatives max).
    const scheduleReconnect = (reason) => {
      clearRetry();
      p.retry.attempt++;
      if (p.retry.attempt > 20) { p.retry.attempt = 0; showDisconnected(`${reason} — abandon après 20 tentatives`); return; }
      let left = [2, 4, 8, 15, 30][Math.min(p.retry.attempt - 1, 4)];
      setPaneStatus('wait');
      const label = h('div', { class: 'muted' });
      const upd = () => { label.textContent = `Reconnexion dans ${left} s · tentative ${p.retry.attempt}/20`; };
      upd();
      overlay(wrap, [
        h('div', { class: 'spinner' }),
        h('div', { style: { fontWeight: 600 }, text: 'Connexion perdue' }),
        h('div', { class: 'muted small', text: reason || '' }), label,
        h('div', { class: 'actions' },
          h('button', { class: 'btn primary', onclick: () => { clearRetry(); p.connect({ auto: true }); } }, 'Reconnecter maintenant'),
          h('button', { class: 'btn', onclick: () => { clearRetry(); p.retry.attempt = 0; setPaneStatus('off'); showDisconnected(reason); } }, 'Annuler'))
      ]);
      p.retry.tick = setInterval(() => { left = Math.max(0, left - 1); upd(); }, 1000);
      p.retry.timer = setTimeout(() => { clearRetry(); p.connect({ auto: true }); }, left * 1000);
    };
    p.retryNow = () => { if (p.retry.timer) { clearRetry(); p.connect({ auto: true }); } };
    p.dispose = () => clearRetry();

    p.connect = async (opts = {}) => {
      clearRetry();
      setPaneStatus('wait');
      if (opts.auto) term.write(`\r\n\x1b[90m--- reconnexion automatique (tentative ${p.retry.attempt}) ---\x1b[0m\r\n`);
      overlay(wrap, [h('div', { class: 'spinner' }), h('div', { text: isLocal ? `Démarrage de ${title0}…` : `Connexion à ${host.username}@${host.hostname}${host.jumpHostId && hostById(host.jumpHostId) ? ' via ' + hostById(host.jumpHostId).label : ''}…` })]);
      await new Promise(r => requestAnimationFrame(r));
      try { fitAddon.fit(); } catch { /* ignore */ }
      try {
        if (isLocal && spec.attachId && !p.attachedOnce) {
          const r = await api.invoke('local:attach', id);
          p.attachedOnce = true;
          term.write(r.buffer);
          if (r.title) titleEl.textContent = r.title;
          api.resize(id, term.cols, term.rows);
        } else if (isLocal) {
          const r = await api.invoke('local:spawn', id, spec.shellId, term.cols, term.rows, spec.cwd);
          p.spec.shellId = r.shell.id;
          titleEl.textContent = r.shell.name;
          p.title = r.shell.name;
        } else {
          await api.invoke('ssh:open', id, spec.hostId, term.cols, term.rows);
        }
        if (!panes.has(id)) { if (!p.detached) api.invoke('ssh:close', id); return; }
        p.cols = term.cols; p.rows = term.rows;
        overlay(wrap, null);
        setPaneStatus('on');
        if (opts.auto) toast(`✓ ${title0} reconnecté`);
        if (opts.auto && !isLocal && p.cwd && p.cwd !== '/') api.write(id, ` cd '${p.cwd.replace(/'/g, "'\\''")}'\r`);
        p.retry.attempt = 0;
        p.fit();
        if (t.activePane === id && ui.activeTab === t.id) term.focus();
      } catch (e) {
        if (!panes.has(id)) return;
        const msg = e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
        if (opts.auto && !isLocal && !FATAL.test(msg)) { scheduleReconnect(msg); return; }
        p.retry.attempt = 0;
        setPaneStatus('off');
        showDisconnected(msg);
      }
    };
    const showDisconnected = (reason) => overlay(wrap, [
      h('div', { style: { fontSize: '26px' }, text: isLocal ? '■' : '⚠' }),
      h('div', { style: { fontWeight: 600 }, text: isLocal ? 'Terminal arrêté' : 'Déconnecté' }),
      h('div', { class: 'muted', text: reason || '' }),
      h('div', { class: 'actions' },
        h('button', { class: 'btn primary', onclick: () => {
          term.write(`\r\n\x1b[90m--- ${isLocal ? 'redémarrage' : 'reconnexion'} ---\x1b[0m\r\n`);
          if (isLocal) { spec.attachId = null; p.spec.attachId = null; }
          p.connect();
        } }, isLocal ? 'Relancer' : 'Reconnecter'),
        h('button', { class: 'btn', onclick: () => closePane(t, id) }, 'Fermer'))
    ]);
    p.onExit = (reason, clean) => {
      // Coupure réseau / serveur injoignable → reconnexion automatique ; « exit » volontaire → on s'arrête.
      if (!isLocal && !clean && S.settings.autoReconnect !== false) { scheduleReconnect(reason); return; }
      setPaneStatus('off'); showDisconnected(reason);
    };
    return p;
  }

  // ---------- Blocs de commandes (façon Warp) ----------
  // Ligne de commande en cours (lue à l'écran, invite retirée), lignes repliées comprises.
  function currentLine(q) {
    const b = q.term.buffer.active;
    let y = b.baseY + b.cursorY;
    let line = b.getLine(y);
    if (!line) return '';
    let text = line.translateToString(true);
    while (line && line.isWrapped && y > 0) { y--; line = b.getLine(y); text = line.translateToString(true) + text; }
    return window.KST_DANGER.stripPrompt(text);
  }
  // Suivi des touches tapées depuis le dernier Entrée : l'écran peut être en retard
  // (écho du serveur pas encore revenu), donc on garde aussi ce qui a été tapé.
  function trackTyping(q, d) {
    if (q.typed === undefined) { q.typed = ''; q.typedOk = true; }
    for (let i = 0; i < d.length; i++) {
      const ch = d[i];
      if (ch === '\x1b') { q.typedOk = false; break; }                 // flèches, historique… : on se fie à l'écran
      if (ch === '\x7f' || ch === '\b') q.typed = q.typed.slice(0, -1);
      else if (ch === '\x15' || ch === '\x03') { q.typed = ''; q.typedOk = true; } // Ctrl+U, Ctrl+C
      else if (ch === '\t' || ch === '\x12' || ch === '\x17') q.typedOk = false; // complétion, recherche, Ctrl+W
      else if (ch >= ' ') q.typed += ch;
    }
  }
  // Commandes validées par cette saisie (Entrée simple ou collage multi-lignes).
  // `all` : renvoie aussi les variantes (tapé / lu à l'écran) pour le contrôle de danger.
  function commandsIn(q, d, all) {
    const parts = d.split(/\r\n|\r|\n/);
    const screen = (currentLine(q) + parts[0]).trim();
    const typed = q.typedOk !== false && q.typed ? (q.typed + parts[0]).trim() : '';
    const out = [];
    if (all) { for (const c of new Set([typed, screen])) if (c) out.push(c); }
    else { const best = typed || screen; if (best) out.push(best); }
    for (let i = 1; i < parts.length - 1; i++) if (parts[i].trim()) out.push(parts[i].trim());
    return out;
  }
  function resetTyping(q) { q.typed = ''; q.typedOk = true; }
  function dangerCheckOn(q) {
    const mode = (S && S.settings.dangerMode) || 'prod';
    if (mode === 'off') return false;
    if (mode === 'all') return true;
    const host = q.hostId && hostById(q.hostId);
    return !!(host && host.env === 'prod');
  }
  // Confirmation renforcée : retaper le nom du host (comme la suppression d'un dépôt GitHub).
  async function confirmDanger(risky) {
    const hosts = [...new Set(risky.map(r => r.q.isLocal ? 'Terminal local' : (hostById(r.q.hostId) || {}).label || '?'))];
    const target = hosts[0];
    const input = h('input', { placeholder: target, autocomplete: 'off', spellcheck: 'false' });
    const prod = risky.some(r => !r.q.isLocal && (hostById(r.q.hostId) || {}).env === 'prod');
    const body = [
      h('div', { class: 'callout danger' },
        h('div', { style: { fontWeight: 700, marginBottom: '6px' }, text: (prod ? '⚠ Serveur de PRODUCTION : ' : '⚠ ') + hosts.join(', ') }),
        risky.map(r => h('div', { style: { marginTop: '6px' } }, h('code', { class: 'danger-cmd', text: r.c }), h('div', { class: 'small', text: '→ ' + r.why.join(' · ') })))),
      h('p', { class: 'small', text: `Pour exécuter quand même, tape « ${target} » ci-dessous. Échap ou Annuler : la commande reste sur la ligne, non exécutée.` }),
      input
    ];
    let okBtn;
    const ok = await modal({
      title: 'Commande dangereuse', body, wide: true,
      onOpen: (form) => {
        okBtn = form.querySelector('footer button.danger');
        const sync = () => { okBtn.disabled = input.value.trim().toLowerCase() !== target.toLowerCase(); };
        input.addEventListener('input', sync); sync();
        setTimeout(() => input.focus(), 40);
      },
      actions: [{ label: 'Annuler', value: false }, { label: 'Exécuter', class: 'danger solid', submit: true, onClick: () => input.value.trim().toLowerCase() === target.toLowerCase() ? true : false }]
    });
    if (!ok) for (const r of risky) api.auditDangerCancelled(r.q.id, r.c, r.why);
    const tq = risky[0].q; setTimeout(() => tq.term.focus(), 30);
    return !!ok;
  }

  function markCommand(p, cmd, offset = 0) {
    const term = p.term;
    const marker = term.registerMarker(offset);
    if (!marker) return null;
    p.blocks = p.blocks.filter(b => !b.marker.isDisposed);
    const b = { marker, at: Date.now(), cmd: cmd || '' };
    p.blocks.push(b);
    if (p.blocks.length > 500) p.blocks.shift();
    try {
      const deco = term.registerDecoration({ marker, x: 0, width: 1, layer: 'top' });
      if (deco) deco.onRender(el => {
        el.classList.add('cmd-mark');
        el.classList.toggle('run', b.exit === undefined && !!b.running);
        el.classList.toggle('ok', b.exit === 0);
        el.classList.toggle('ko', b.exit !== undefined && b.exit !== 0);
        const when = new Date(b.at).toLocaleTimeString('fr-FR');
        el.title = b.exit === undefined ? `${b.running ? 'En cours depuis' : 'Exécutée à'} ${when}` : `${b.exit === 0 ? '✓ Réussie' : '✗ Échec — code ' + b.exit} · ${fmtDur(b.dur)} · ${when}`;
      });
    } catch { /* API indisponible : on garde juste les marqueurs */ }
    return b;
  }

  // ---------- Intégration shell (OSC 133 / OSC 7, injectée par le processus principal) ----------
  function fmtDur(ms) {
    if (ms == null) return '';
    if (ms < 1000) return ms + ' ms';
    const s2 = ms / 1000;
    if (s2 < 60) return s2.toFixed(s2 < 10 ? 1 : 0) + ' s';
    const m = Math.floor(s2 / 60), r = Math.round(s2 % 60);
    return m < 60 ? `${m} min ${r} s` : `${Math.floor(m / 60)} h ${m % 60} min`;
  }
  function shortPath(pth) { return pth.length > 40 ? '…' + pth.slice(-38) : pth; }
  function shellIntegrationHandlers(p, t) {
    const term = p.term;
    term.parser.registerOscHandler(133, (data) => {
      const [kind, arg] = data.split(';');
      if (kind === 'C') {
        // Bloc créé à l'Entrée (ligne de la commande) ; sinon ligne au-dessus du curseur.
        let b = p.blocks[p.blocks.length - 1];
        if (!b || b.marker.isDisposed || b.exit !== undefined || b.running || Date.now() - b.at > 3000) b = markCommand(p, '', -1);
        if (b) { b.running = true; b.start = Date.now(); b.outMarker = term.registerMarker(0); }
        p.runBlock = b;
        p.si = true;
      } else if (kind === 'D') {
        const b = p.runBlock; p.runBlock = null;
        if (b) {
          b.running = false; b.exit = Number(arg) || 0; b.dur = Date.now() - b.start;
          b.endMarker = term.registerMarker(0);
          p.lastExit = b.exit;
          term.refresh(0, term.rows - 1);
          commandFinished(p, t, b);
        }
      }
      return true;
    });
    term.parser.registerOscHandler(7, (data) => {
      const m = /^file:\/\/[^/]*(\/.*)$/.exec(data);
      if (m) {
        let dir = m[1];
        try { dir = decodeURIComponent(dir); } catch { /* chemin brut */ }
        if (dir !== p.cwd) { p.cwd = dir; p.si = true; if (t.activePane === p.id) updateBar(t); }
      }
      return true;
    });
    term.parser.registerOscHandler(633, () => true);
  }
  // Commande longue terminée alors qu'on regarde ailleurs → notification.
  function commandFinished(p, t, b) {
    const min = (S.settings.notifyLongCommands ?? 10) * 1000;
    if (!min || b.dur < min) return;
    const away = !document.hasFocus() || ui.activeTab !== t.id || t.activePane !== p.id;
    if (!away) return;
    const host = p.hostId && hostById(p.hostId);
    const where = host ? host.label : 'Terminal';
    const what = (b.cmd || 'Commande').slice(0, 80);
    const msg = b.exit === 0 ? `✓ ${what} — terminé en ${fmtDur(b.dur)}` : `✗ ${what} — échec (code ${b.exit}) après ${fmtDur(b.dur)}`;
    toast(`${where} : ${msg}`, b.exit !== 0);
    if (!document.hasFocus()) {
      try {
        const n = new Notification(`KSTermus — ${where}`, { body: msg, silent: false });
        n.onclick = () => { window.focus(); activateTab(t.id); setActivePane(t, p.id); };
      } catch { /* notifications indisponibles */ }
    }
  }

  function jumpCommand(p, dir) {
    if (!p) return;
    const buf = p.term.buffer.active;
    const lines = p.blocks.filter(b => !b.marker.isDisposed).map(b => b.marker.line);
    if (!lines.length) { toast('Aucune commande repérée dans ce panneau'); return; }
    const top = buf.viewportY;
    const target = dir < 0 ? [...lines].reverse().find(l => l < top) : lines.find(l => l > top);
    if (target === undefined) { if (dir > 0) p.term.scrollToBottom(); return; }
    p.term.scrollToLine(target);
  }

  function lastOutput(p) {
    const buf = p.term.buffer.active;
    const done = p.blocks.filter(b => b.outMarker && b.endMarker && !b.outMarker.isDisposed && !b.endMarker.isDisposed);
    if (done.length) {
      const b = done[done.length - 1];
      const out = [];
      for (let i = b.outMarker.line; i < b.endMarker.line; i++) { const l = buf.getLine(i); if (l) out.push(l.translateToString(true)); }
      return { command: b.cmd || (buf.getLine(b.marker.line) || { translateToString: () => '' }).translateToString(true).trim(), output: out.join('\n').replace(/\s+$/, ''), exit: b.exit };
    }
    const cursorLine = buf.baseY + buf.cursorY;
    const marks = p.blocks.filter(b => !b.marker.isDisposed && b.marker.line < cursorLine);
    if (!marks.length) return null;
    const start = marks[marks.length - 1].marker.line;
    const out = [];
    const cmd = buf.getLine(start);
    for (let i = start + 1; i < cursorLine; i++) { const l = buf.getLine(i); if (l) out.push(l.translateToString(true)); }
    return { command: cmd ? cmd.translateToString(true).trim() : '', output: out.join('\n').replace(/\s+$/, '') };
  }

  async function copyLastOutput(p) {
    if (!p) return;
    const r = lastOutput(p);
    if (!r) { toast('Aucune commande terminée à copier', true); return; }
    await api.invoke('clipboard:write', r.output);
    toast(`Sortie copiée (${r.output.split('\n').length} ligne(s)) : ${r.command.slice(0, 60)}`);
  }

  // ---------- Recherche dans le terminal (Ctrl+Shift+F) ----------
  const SEARCH_DECO = {
    matchBackground: '#4a3f1c', matchBorder: '#8a7130', matchOverviewRuler: '#f5b84a',
    activeMatchBackground: '#f5b84a', activeMatchBorder: '#ffd27a', activeMatchColorOverviewRuler: '#ffd27a'
  };
  function openTermSearch(p) {
    if (!p || !p.search) return;
    const sel = p.term.hasSelection() ? p.term.getSelection() : '';
    if (p.searchBar) {
      if (sel && !sel.includes('\n')) p.searchInput.value = sel;
      p.searchInput.focus(); p.searchInput.select();
      return;
    }
    const opts = { caseSensitive: false, regex: false, wholeWord: false };
    const input = h('input', { type: 'text', placeholder: 'Rechercher…', spellcheck: 'false', value: sel && !sel.includes('\n') ? sel : (p.lastSearch || '') });
    const count = h('span', { class: 'count' });
    const run = (incremental, back) => {
      const q = input.value;
      p.lastSearch = q;
      count.classList.remove('none');
      if (!q) { p.search.clearDecorations(); count.textContent = ''; return; }
      let found = false;
      try {
        const o = { ...opts, incremental: !!incremental, decorations: SEARCH_DECO };
        found = back ? p.search.findPrevious(q, o) : p.search.findNext(q, o);
      } catch { count.textContent = 'regex ?'; count.classList.add('none'); return; }
      if (!found) { count.textContent = 'aucun'; count.classList.add('none'); }
    };
    const opt = (key, label, title) => {
      const b = h('button', { class: 'opt', title, text: label });
      b.addEventListener('mousedown', (e) => e.preventDefault());
      b.onclick = () => { opts[key] = !opts[key]; b.classList.toggle('on', opts[key]); run(true); };
      return b;
    };
    const close = () => {
      p.search.clearDecorations();
      if (p.searchSub) { p.searchSub.dispose(); p.searchSub = null; }
      bar.remove(); p.searchBar = null; p.searchInput = null;
      p.term.focus();
    };
    const btn = (label, title, fn) => { const b = h('button', { class: 'icon-btn mini', title, text: label }); b.addEventListener('mousedown', (e) => e.preventDefault()); b.onclick = fn; return b; };
    const bar = h('div', { class: 'term-search' },
      input, count,
      opt('caseSensitive', 'Aa', 'Respecter la casse'), opt('wholeWord', 'ab', 'Mot entier'), opt('regex', '.*', 'Expression régulière'),
      btn('↑', 'Précédent (Maj+Entrée)', () => run(false, true)),
      btn('↓', 'Suivant (Entrée)', () => run(false, false)),
      btn('✕', 'Fermer (Échap)', close));
    p.searchSub = p.search.onDidChangeResults(({ resultIndex, resultCount }) => {
      if (!input.value) return;
      count.classList.toggle('none', resultCount === 0);
      count.textContent = resultCount === 0 ? 'aucun' : resultIndex >= 0 ? `${resultIndex + 1}/${resultCount}${resultCount >= 1000 ? '+' : ''}` : `${resultCount}${resultCount >= 1000 ? '+' : ''}`;
    });
    input.addEventListener('input', () => run(true));
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); run(false, e.shiftKey); }
      else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); }
    });
    bar.addEventListener('mousedown', (e) => e.stopPropagation());
    p.wrap.append(bar);
    p.searchBar = bar; p.searchInput = input;
    input.focus(); input.select();
    if (input.value) run(true);
  }

  function setActivePane(t, id) {
    if (t.activePane === id) return;
    t.activePane = id;
    for (const p of t.panes.values()) p.el.classList.toggle('active', p.id === id);
    updateBar(t);
    renderTabs();
  }

  function updateBar(t) {
    const p = t.panes.get(t.activePane);
    const host = p && !p.isLocal && hostById(p.hostId);
    t.el.classList.toggle('active-local', !!(p && p.isLocal));
    if (p && p.isLocal) {
      const sh = shellById(p.spec.shellId);
      t.info.replaceChildren(...[
        h('span', { class: 'avatar local-avatar', text: sh ? sh.icon : '❯' }),
        h('span', { class: 'title', text: sh ? sh.name : 'Terminal local' }),
        h('span', { class: 'sub', text: p.shellTitle ? p.shellTitle.slice(-70) : 'local' }),
        t.panes.size > 1 ? h('span', { class: 'badge', text: `${t.panes.size} panneaux` }) : null
      ].filter(Boolean));
      t.bcBtn.classList.toggle('on', t.broadcast);
      t.el.classList.toggle('broadcast', t.broadcast);
      return;
    }
    t.info.replaceChildren(...(host ? [
      h('span', { class: 'avatar', style: { width: '22px', height: '22px', fontSize: '10px', borderRadius: '6px', background: host.color || COLORS[0] }, text: initials(host.label) }),
      h('span', { class: 'title', text: host.label }),
      h('span', { class: 'sub', text: `${host.username}@${host.hostname}:${host.port}` }),
      p && p.cwd ? h('span', { class: 'bar-cwd', title: 'Dossier courant (intégration shell) — clic : ouvrir en SFTP', text: '📂 ' + shortPath(p.cwd), onclick: () => openSftp(p.spec.hostId, p.cwd) }) : null,
      p && p.si ? h('span', { class: 'bar-si', title: 'Intégration shell active : code de retour et durée de chaque commande, dossier courant' , text: '⚡' }) : null,
      t.panes.size > 1 ? h('span', { class: 'badge', text: `${t.panes.size} panneaux` }) : null
    ].filter(Boolean) : []));
    t.bcBtn.classList.toggle('on', t.broadcast);
    t.el.classList.toggle('broadcast', t.broadcast);
  }

  function renderLayout(t) {
    const build = (node) => {
      if (node.type === 'pane') return t.panes.get(node.id).el;
      const a = build(node.a), b = build(node.b);
      a.style.flex = `${node.ratio} 1 0`;
      b.style.flex = `${1 - node.ratio} 1 0`;
      const div = h('div', { class: 'divider divider-' + node.dir });
      const box = h('div', { class: 'split split-' + node.dir }, a, div, b);
      div.addEventListener('mousedown', (e) => startDrag(e, t, node, box, a, b));
      div.addEventListener('dblclick', () => { node.ratio = 0.5; a.style.flex = '0.5 1 0'; b.style.flex = '0.5 1 0'; fitTab(t); });
      return box;
    };
    let root;
    if (t.zoomed && t.panes.has(t.zoomed)) {
      root = t.panes.get(t.zoomed).el;
      root.style.flex = '1 1 0';
    } else {
      t.zoomed = null;
      root = build(t.layout);
      root.style.flex = '1 1 0';
    }
    t.body.replaceChildren(root);
    t.el.classList.toggle('multi', t.panes.size > 1);
    t.el.classList.toggle('zoomed', !!t.zoomed);
    for (const p of t.panes.values()) p.el.classList.toggle('active', p.id === t.activePane);
    updateBar(t);
    requestAnimationFrame(() => fitTab(t));
  }

  function startDrag(e, t, node, box, a, b) {
    e.preventDefault();
    const rect = box.getBoundingClientRect();
    document.body.classList.add(node.dir === 'row' ? 'dragging-row' : 'dragging-col');
    const move = (ev) => {
      const r = node.dir === 'row' ? (ev.clientX - rect.left) / rect.width : (ev.clientY - rect.top) / rect.height;
      node.ratio = Math.min(0.85, Math.max(0.15, r));
      a.style.flex = `${node.ratio} 1 0`;
      b.style.flex = `${1 - node.ratio} 1 0`;
    };
    const up = () => {
      document.removeEventListener('mousemove', move);
      document.removeEventListener('mouseup', up);
      document.body.classList.remove('dragging-row', 'dragging-col');
      fitTab(t);
    };
    document.addEventListener('mousemove', move);
    document.addEventListener('mouseup', up);
  }

  function replaceNode(node, id, fn) {
    if (node.type === 'pane') return node.id === id ? fn(node) : node;
    return { ...node, a: replaceNode(node.a, id, fn), b: replaceNode(node.b, id, fn) };
  }
  function removeNode(node, id) {
    if (node.type === 'pane') return node.id === id ? null : node;
    const a = removeNode(node.a, id), b = removeNode(node.b, id);
    if (!a) return b;
    if (!b) return a;
    return { ...node, a, b };
  }
  function paneOrder(node, out = []) {
    if (node.type === 'pane') out.push(node.id); else { paneOrder(node.a, out); paneOrder(node.b, out); }
    return out;
  }

  function splitPane(t, paneId, dir, spec) {
    const src = t.panes.get(paneId) || t.panes.get(t.activePane);
    if (!src) return;
    if (t.panes.size >= 8) { toast('8 panneaux maximum par onglet', true); return; }
    const p = createPane(t, spec || baseSpec(src.spec));
    t.layout = replaceNode(t.layout, src.id, (n) => ({ type: 'split', dir, ratio: 0.5, a: n, b: { type: 'pane', id: p.id } }));
    t.zoomed = null;
    t.activePane = p.id;
    renderLayout(t);
    renderTabs();
    p.connect();
  }

  function detachPane(t, paneId) {
    const p = t.panes.get(paneId);
    if (!p || !p.isLocal) { toast('Seuls les terminaux locaux se détachent', true); return; }
    if (p.status !== 'on') { closePane(t, paneId); return; }
    toast(`⏏ ${p.title} détaché — il continue en arrière-plan (Local ▸ Sessions, ou préfixe s)`);
    closePane(t, paneId, { detach: true });
  }

  function closePane(t, paneId, opts = {}) {
    const p = t.panes.get(paneId);
    if (!p) return;
    if (t.panes.size === 1) {
      if (opts.detach) { t.panes.delete(paneId); disposePane(p, opts); }
      closeTab(t.id);
      return;
    }
    const order = paneOrder(t.layout);
    const idx = order.indexOf(paneId);
    t.layout = removeNode(t.layout, paneId);
    t.panes.delete(paneId);
    disposePane(p, opts);
    if (t.zoomed === paneId) t.zoomed = null;
    const rest = paneOrder(t.layout);
    t.activePane = rest[Math.max(0, idx - 1)] || rest[0];
    renderLayout(t);
    renderTabs();
    const np = t.panes.get(t.activePane);
    if (np) np.term.focus();
  }

  function toggleZoom(t, paneId) {
    if (t.panes.size < 2) return;
    t.zoomed = t.zoomed ? null : paneId;
    if (t.zoomed) t.activePane = paneId;
    renderLayout(t);
    const p = t.panes.get(t.activePane);
    if (p) setTimeout(() => p.term.focus(), 30);
  }

  function toggleBroadcast(t) {
    if (t.panes.size < 2 && !t.broadcast) { toast('La diffusion sert avec au moins 2 panneaux'); }
    t.broadcast = !t.broadcast;
    updateBar(t);
    renderTabs();
    if (t.broadcast) toast('📡 Diffusion active : la saisie part vers tous les panneaux de l\'onglet');
    const p = t.panes.get(t.activePane);
    if (p) p.term.focus();
  }

  function focusNeighbor(t, dir) {
    const cur = t.panes.get(t.activePane);
    if (!cur || t.panes.size < 2) return;
    const r0 = cur.el.getBoundingClientRect();
    const c0 = { x: r0.left + r0.width / 2, y: r0.top + r0.height / 2 };
    let best = null, bestD = Infinity;
    for (const p of t.panes.values()) {
      if (p === cur) continue;
      const r = p.el.getBoundingClientRect();
      if (!r.width) continue;
      const c = { x: r.left + r.width / 2, y: r.top + r.height / 2 };
      const dx = c.x - c0.x, dy = c.y - c0.y;
      const ok = (dir === 'left' && dx < -10) || (dir === 'right' && dx > 10) || (dir === 'up' && dy < -10) || (dir === 'down' && dy > 10);
      if (!ok) continue;
      const d = (dir === 'left' || dir === 'right') ? Math.abs(dx) + Math.abs(dy) * 2 : Math.abs(dy) + Math.abs(dx) * 2;
      if (d < bestD) { bestD = d; best = p; }
    }
    if (best) { setActivePane(t, best.id); best.term.focus(); }
  }

  api.on('term:data', ({ sessionId, data }) => { const p = panes.get(sessionId); if (p) p.term.write(data); });
  api.on('term:exit', ({ sessionId, reason, clean }) => { const p = panes.get(sessionId); if (p && p.onExit) p.onExit(reason, clean); });
  // Le réseau revient : on retente tout de suite les panneaux en attente de reconnexion.
  window.addEventListener('online', () => { for (const p of panes.values()) if (p.retryNow) p.retryNow(); });

  // ---------- Local : shells, sessions détachées, espaces de travail ----------
  async function refreshLocalSessions() {
    ui.localSessions = (await guard(() => api.invoke('local:list'))) || [];
    return ui.localSessions;
  }

  function attachSession(sess, where) {
    for (const t of tabs.values()) if (t.kind === 'term' && t.panes.has(sess.id)) { activateTab(t.id); return; }
    const spec = { type: 'local', shellId: sess.shell.id, attachId: sess.id };
    const cur = tabs.get(ui.activeTab);
    if (where === 'split' && cur && cur.kind === 'term') splitPane(cur, cur.activePane, 'row', spec);
    else openTermTab(spec);
  }

  async function pickLocalSession() {
    const list = await refreshLocalSessions();
    const det = list.filter(x => !x.attached);
    if (!det.length) { toast('Aucune session locale détachée'); return; }
    const anchor = $('.tab-new') || $('#tabs');
    popupMenu(anchor, det.map(x => ({ label: `${x.shell.icon} ${x.title}`, sub: `pid ${x.pid} · depuis ${fmtDate(x.createdAt)}`, onClick: () => attachSession(x) })));
  }

  function pickTab() {
    popupMenu($('.tab-new') || $('#tabs'), [{ label: '🏠 Coffre', onClick: () => activateTab('home') },
      ...[...tabs.values()].map((t, i) => ({ label: `${i + 1}: ${tabTitle(t)}`, sub: t.kind === 'term' ? `${t.panes.size} panneau(x)` : t.kind, onClick: () => activateTab(t.id) }))]);
  }

  async function renameTab(t) {
    const inp = h('input', { value: tabTitle(t) });
    const v = await modal({ title: 'Renommer l\'onglet', body: field('Nom', inp, 'Vide = nom automatique'), actions: [{ label: 'Annuler', value: false }, { label: 'OK', class: 'primary', submit: true, onClick: () => ({ v: inp.value.trim() }) }] });
    if (!v) return;
    t.customTitle = v.v || null;
    renderTabs();
  }

  // Espaces de travail : on mémorise l'arbre de panneaux avec la spec de chacun (shell local ou host SSH).
  function layoutToSpec(t, node) {
    if (node.type === 'pane') { const p = t.panes.get(node.id); return { type: 'pane', spec: baseSpec(p.spec) }; }
    return { type: 'split', dir: node.dir, ratio: node.ratio, a: layoutToSpec(t, node.a), b: layoutToSpec(t, node.b) };
  }
  function describeLayout(node, acc = []) {
    if (node.type === 'pane') {
      const sp = node.spec;
      acc.push(sp.type === 'ssh' ? ((hostById(sp.hostId) || {}).label || 'host supprimé') : ((shellById(sp.shellId) || {}).name || sp.shellId));
    } else { describeLayout(node.a, acc); describeLayout(node.b, acc); }
    return acc;
  }

  async function saveWorkspace(t) {
    if (!t || t.kind !== 'term') { toast('Ouvre d\'abord un onglet terminal', true); return; }
    const inp = h('input', { value: t.customTitle || '', placeholder: 'Ex. Déploiement QOS' });
    const name = await modal({
      title: 'Sauvegarder l\'espace de travail',
      body: [field('Nom', inp), h('p', { class: 'muted small', text: `${t.panes.size} panneau(x) : ${describeLayout(layoutToSpec(t, t.layout)).join(' · ')}` })],
      actions: [{ label: 'Annuler', value: false }, { label: 'Sauvegarder', class: 'primary', submit: true, onClick: () => inp.value.trim() || false }]
    });
    if (!name) return;
    const s = await guard(() => api.invoke('workspace:save', { name, layout: layoutToSpec(t, t.layout), broadcast: t.broadcast }));
    if (s) { setState(s); t.customTitle = name; renderTabs(); toast(`Espace « ${name} » sauvegardé`); }
  }

  function openWorkspace(ws) {
    const t = newTermTab();
    const toDo = [];
    const build = (node) => {
      if (node.type === 'pane') {
        let spec = node.spec;
        if (spec.type === 'ssh' && !hostById(spec.hostId)) spec = { type: 'local', shellId: defaultShellId() };
        if (spec.type === 'local' && !shellById(spec.shellId)) spec = { type: 'local', shellId: defaultShellId() };
        const p = createPane(t, spec);
        toDo.push(p);
        return { type: 'pane', id: p.id };
      }
      return { type: 'split', dir: node.dir, ratio: node.ratio, a: build(node.a), b: build(node.b) };
    };
    t.layout = build(ws.layout);
    t.activePane = toDo[0].id;
    t.customTitle = ws.name;
    t.broadcast = !!ws.broadcast;
    renderLayout(t);
    activateTab(t.id);
    toDo.forEach((p, i) => setTimeout(() => p.connect(), i * 120));
  }

  function viewLocal() {
    const sessions = ui.localSessions || [];
    const root = h('div', {},
      h('div', { class: 'section-head' }, h('h1', { text: 'Local' }),
        h('button', { class: 'btn', title: 'Redétecter les shells installés', onclick: async () => { ui.shells = (await guard(() => api.invoke('local:shells', true))) || ui.shells; renderSection(); } }, '⟳ Shells'),
        h('button', { class: 'btn primary', onclick: () => openLocal() }, '+ Terminal local')),
      h('div', { class: 'group-title', text: 'Shells installés' }),
      ui.shells.length ? h('div', { class: 'grid' }, ui.shells.map(sh => h('div', { class: 'card', ondblclick: () => openLocal(sh.id) },
        h('div', { class: 'card-top' }, h('div', { class: 'avatar local-avatar big', text: sh.icon }),
          h('div', { style: { minWidth: 0, flex: 1 } }, h('div', { class: 'card-title', text: sh.name }), h('div', { class: 'card-sub', text: sh.id === defaultShellId() ? 'par défaut' : sh.id }))),
        h('div', { class: 'card-actions' },
          h('button', { class: 'btn primary sm', onclick: (e) => { e.stopPropagation(); openLocal(sh.id); } }, 'Ouvrir'),
          h('button', { class: 'btn sm', title: 'Ouvrir à droite du panneau actif', onclick: (e) => {
            e.stopPropagation();
            const cur = tabs.get(ui.lastTerm);
            if (cur && cur.kind === 'term') { activateTab(cur.id); splitPane(cur, cur.activePane, 'row', { type: 'local', shellId: sh.id }); } else openLocal(sh.id);
          } }, '⫿ À droite'),
          h('span', { class: 'spacer' }),
          sh.id !== defaultShellId() ? h('button', { class: 'icon-btn', title: 'Définir par défaut', onclick: async (e) => { e.stopPropagation(); const s = await guard(() => api.invoke('settings:save', { defaultShell: sh.id })); if (s) { S = s; renderSection(); } } }, '☆') : h('span', { class: 'badge ok', text: 'défaut' }))))) :
        h('div', { class: 'empty', text: 'Aucun shell détecté.' }),
      h('div', { class: 'group-title', text: `Sessions locales · ${sessions.length}` }),
      sessions.length ? h('div', { class: 'list' }, sessions.map(x => h('div', { class: 'row' },
        h('span', { class: 'dot ' + (x.attached ? 'on' : 'wait') }),
        h('div', { class: 'row-main' },
          h('div', { class: 'row-title' }, `${x.shell.icon} ${x.title}`, h('span', { class: 'badge ' + (x.attached ? 'ok' : 'R'), text: x.attached ? 'attachée' : 'détachée' })),
          h('div', { class: 'row-sub', text: `${x.shell.name} · pid ${x.pid} · démarrée ${fmtDate(x.createdAt)}` })),
        h('div', { class: 'row-actions' },
          h('button', { class: 'btn primary sm', onclick: () => attachSession(x) }, x.attached ? 'Afficher' : 'Rattacher'),
          h('button', { class: 'icon-btn', title: 'Terminer la session', onclick: async () => {
            if (!(await confirmBox('Terminer la session', `Arrêter « ${x.title} » (pid ${x.pid}) ?`, 'Terminer'))) return;
            for (const t of tabs.values()) if (t.kind === 'term' && t.panes.has(x.id)) closePane(t, x.id);
            await api.invoke('local:kill', x.id); await refreshLocalSessions(); renderSection();
          } }, '■'))))) :
        h('div', { class: 'empty small-empty', text: 'Détache un panneau local (⏏ ou préfixe puis d) : il continue de tourner ici, rattache-le quand tu veux.' }),
      h('div', { class: 'group-title', text: `Espaces de travail · ${(S.workspaces || []).length}` }),
      (S.workspaces || []).length ? h('div', { class: 'list' }, S.workspaces.map(ws => h('div', { class: 'row' },
        h('div', { class: 'avatar', style: { background: 'var(--bg-4)', color: 'var(--accent)' }, text: '◫' }),
        h('div', { class: 'row-main' },
          h('div', { class: 'row-title' }, ws.name, ws.broadcast ? h('span', { class: 'badge R', text: 'diffusion' }) : null),
          h('div', { class: 'row-sub', text: describeLayout(ws.layout).join(' · ') })),
        h('div', { class: 'row-actions' },
          h('button', { class: 'btn primary sm', onclick: () => openWorkspace(ws) }, 'Ouvrir'),
          h('button', { class: 'icon-btn', title: 'Supprimer', onclick: async () => {
            if (await confirmBox('Supprimer l\'espace', `Supprimer « ${ws.name} » ?`)) { const s = await guard(() => api.invoke('workspace:delete', ws.id)); if (s) setState(s); }
          } }, '🗑'))))) :
        h('div', { class: 'empty small-empty', text: 'Organise tes panneaux (locaux et SSH), puis 💾 dans la barre de l\'onglet (ou préfixe puis S) pour retrouver la même disposition en un clic.' }),
      h('div', { class: 'group-title', text: 'Préfixe façon tmux' }),
      tmuxHelpTable());
    if (!ui.localLoaded) { ui.localLoaded = true; refreshLocalSessions().then(() => { if (ui.section === 'local') renderSection(); ui.localLoaded = false; }); }
    return root;
  }

  const TMUX_KEYS = [
    ['%', 'Diviser à droite'], ['"', 'Diviser en bas'], ['← ↑ → ↓', 'Changer de panneau'], ['o', 'Panneau suivant'],
    ['z', 'Agrandir / restaurer'], ['x', 'Fermer le panneau'], ['d', 'Détacher (session locale en arrière-plan)'], ['s', 'Rattacher une session détachée'],
    ['c', 'Nouveau terminal local'], ['n / p', 'Onglet suivant / précédent'], ['0…9', 'Aller à l\'onglet'], ['w', 'Choisir un onglet'],
    [',', 'Renommer l\'onglet'], ['S', 'Sauvegarder l\'espace de travail'], ['b', 'Diffusion de la saisie'], ['[ / ]', 'Commande précédente / suivante'],
    ['y', 'Copier la sortie de la dernière commande'], ['/', 'Rechercher dans le terminal'], [':', 'Palette de commandes'], ['?', 'Cette aide'], ['préfixe ×2', 'Envoie le préfixe au shell']
  ];
  function tmuxHelpTable() {
    const pk = prefixKey() === 'off' ? 'désactivé' : prefixKey().replace('ctrl+', 'Ctrl+').replace(/\+(\w)$/, (_m, c) => '+' + c.toUpperCase());
    return h('div', { class: 'row', style: { alignItems: 'flex-start' } }, h('div', { class: 'row-main' },
      h('div', { class: 'muted small', text: `Appuie sur ${pk}, relâche, puis sur la touche :` }),
      h('div', { class: 'kbd-list cols2' }, TMUX_KEYS.map(([k, d]) => h('div', { class: 'kbd-row' }, h('kbd', { text: k }), h('span', { text: d }))))));
  }
  function showTmuxHelp() {
    modal({ title: 'Commandes après le préfixe', wide: true, body: tmuxHelpTable(), actions: [{ label: 'Fermer', class: 'primary', value: true, submit: true }] });
  }

  api.on('local:changed', async () => { if (ui.section === 'local' && ui.activeTab === 'home') { await refreshLocalSessions(); renderSection(); } });

  // ---------- Palette de commandes (Ctrl+Shift+P) ----------
  function paletteItems() {
    const t = tabs.get(ui.activeTab);
    const term = t && t.kind === 'term' ? t : null;
    const p = term && term.panes.get(term.activePane);
    const items = [];
    const add = (group, label, run, hint) => items.push({ group, label, run, hint });
    for (const sh of ui.shells) add('Local', `Nouveau terminal : ${sh.name}`, () => openLocal(sh.id), sh.icon);
    if (term) for (const sh of ui.shells) add('Local', `Diviser à droite avec ${sh.name}`, () => splitPane(term, term.activePane, 'row', { type: 'local', shellId: sh.id }));
    add('Local', 'Rattacher une session détachée…', () => pickLocalSession(), 'préfixe s');
    for (const x of S.hosts) {
      add('SSH', `Connexion : ${x.label}`, () => openTerminal(x.id), `${x.username}@${x.hostname}`);
      add('SFTP', `SFTP : ${x.label}`, () => openSftp(x.id));
      add('Éditer', `Ouvrir un fichier sur ${x.label}…`, () => promptOpenFile(x.id));
      if (term) add('SSH', `Diviser à droite avec ${x.label}`, () => splitPane(term, term.activePane, 'row', { type: 'ssh', hostId: x.id }));
    }
    for (const ws of S.workspaces || []) add('Espaces', `Ouvrir l'espace : ${ws.name}`, () => openWorkspace(ws), describeLayout(ws.layout).length + ' panneaux');
    for (const sn of S.snippets) add('Snippets', `Snippet : ${sn.name}`, () => runSnippet(sn), sn.command.slice(0, 50));
    if (term) {
      add('Panneau', 'Diviser à droite', () => splitPane(term, term.activePane, 'row'), 'Ctrl+Shift+D');
      add('Panneau', 'Diviser en bas', () => splitPane(term, term.activePane, 'col'), 'Ctrl+Shift+E');
      add('Panneau', 'Agrandir / restaurer le panneau', () => toggleZoom(term, term.activePane), 'Ctrl+Shift+Entrée');
      add('Panneau', term.broadcast ? 'Arrêter la diffusion' : 'Diffuser la saisie à tous les panneaux', () => toggleBroadcast(term), 'Ctrl+Shift+B');
      add('Panneau', 'Fermer le panneau', () => closePane(term, term.activePane), 'Ctrl+Shift+W');
      if (p && p.isLocal) add('Panneau', 'Détacher le panneau', () => detachPane(term, term.activePane), 'préfixe d');
      add('Panneau', 'Rechercher dans le terminal', () => openTermSearch(p), 'Ctrl+Shift+F');
      add('Blocs', 'Copier la sortie de la dernière commande', () => copyLastOutput(p), 'Ctrl+Shift+O');
      add('Blocs', 'Aller à la commande précédente', () => jumpCommand(p, -1), 'Ctrl+Shift+↑');
      add('Blocs', 'Aller à la commande suivante', () => jumpCommand(p, 1), 'Ctrl+Shift+↓');
      add('Onglet', 'Renommer l\'onglet', () => renameTab(term), 'préfixe ,');
      add('Onglet', 'Sauvegarder comme espace de travail', () => saveWorkspace(term), 'préfixe S');
      add('Onglet', 'Effacer l\'écran du panneau', () => p && p.term.clear());
    }
    const go = (sec) => () => { activateTab('home'); ui.section = sec; document.querySelectorAll('.nav-item').forEach(x => x.classList.toggle('active', x.dataset.section === sec)); renderSection(); };
    add('Aller à', 'Hosts', go('hosts')); add('Aller à', 'Local', go('local')); add('Aller à', 'Keychain', go('keychain'));
    add('Aller à', 'Snippets', go('snippets')); add('Aller à', 'Port forwarding', go('forwards')); add('Aller à', 'Historique des éditions', go('history'));
    add('Aller à', 'Paramètres', go('settings'));
    add('Fenêtre', 'Plein écran', () => api.invoke('window:control', 'fullscreen'), 'F11');
    add('Fenêtre', 'Aide du préfixe tmux', () => showTmuxHelp(), 'préfixe ?');
    add('Fenêtre', 'Verrouiller le coffre', () => $('#btn-lock').click());
    return items;
  }

  // Score : chaque mot tapé doit apparaître (sous-chaîne, bonus en début de mot), sinon en sous-séquence (plus faible).
  function fuzzyScore(q, text) {
    if (!q) return 1;
    text = text.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    q = q.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    let score = 0;
    for (const tok of q.split(/\s+/).filter(Boolean)) {
      const i = text.indexOf(tok);
      if (i >= 0) { score += 10 + tok.length * 2 + (i === 0 || ' :/-·('.includes(text[i - 1]) ? 6 : 0); continue; }
      let ti = 0, sub = 0;
      for (const ch of tok) { const j = text.indexOf(ch, ti); if (j < 0) return 0; sub += j === ti ? 2 : 1; ti = j + 1; }
      score += sub;
    }
    return score - text.length * 0.01;
  }

  function openPalette() {
    if (document.querySelector('.palette')) return;
    const all = paletteItems();
    const input = h('input', { class: 'palette-input', placeholder: 'Tape une commande, un host, un shell, un snippet…', spellcheck: 'false' });
    const list = h('div', { class: 'palette-list' });
    let shown = [], sel = 0;
    const close = () => { bd.remove(); const t = tabs.get(ui.activeTab); if (t && t.kind === 'term') { const p = t.panes.get(t.activePane); if (p) p.term.focus(); } };
    const run = (it) => { close(); setTimeout(() => it.run(), 10); };
    const render = () => {
      const q = input.value.trim().toLowerCase();
      shown = all.map(it => ({ it, s: fuzzyScore(q, `${it.group} ${it.label}`) })).filter(x => x.s > 0).sort((a, b) => b.s - a.s).slice(0, 60).map(x => x.it);
      sel = Math.min(sel, Math.max(0, shown.length - 1));
      list.replaceChildren(...(shown.length ? shown.map((it, i) => h('div', { class: 'palette-item' + (i === sel ? ' sel' : ''), onmousedown: (e) => { e.preventDefault(); run(it); } },
        h('span', { class: 'palette-group', text: it.group }), h('span', { class: 'palette-label', text: it.label }), it.hint ? h('span', { class: 'palette-hint', text: it.hint }) : null)) :
        [h('div', { class: 'menu-empty', text: 'Aucun résultat' })]));
      const el = list.children[sel]; if (el && el.scrollIntoView) el.scrollIntoView({ block: 'nearest' });
    };
    input.addEventListener('input', () => { sel = 0; render(); });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown') { e.preventDefault(); sel = Math.min(shown.length - 1, sel + 1); render(); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); sel = Math.max(0, sel - 1); render(); }
      else if (e.key === 'Enter') { e.preventDefault(); if (shown[sel]) run(shown[sel]); }
      else if (e.key === 'Escape') { e.preventDefault(); close(); }
    });
    const bd = h('div', { class: 'palette', onmousedown: (e) => { if (e.target === bd) close(); } }, h('div', { class: 'palette-box' }, input, list,
      h('div', { class: 'palette-foot' }, h('span', { text: '↑↓ naviguer · Entrée exécuter · Échap fermer' }), h('span', { text: `${all.length} commandes` }))));
    document.body.append(bd);
    input.focus();
    render();
  }

  // ---------- Éditeur distant ----------
  const MODE_BY_EXT = {
    js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'jsx', ts: 'text/typescript', tsx: 'text/typescript',
    json: 'application/json', html: 'htmlmixed', htm: 'htmlmixed', vue: 'vue', xml: 'xml', svg: 'xml', css: 'css', scss: 'text/x-scss', less: 'text/x-less',
    py: 'python', sh: 'shell', bash: 'shell', zsh: 'shell', yml: 'yaml', yaml: 'yaml', sql: 'sql', md: 'markdown',
    ini: 'properties', env: 'properties', properties: 'properties', cfg: 'properties', conf: 'properties', service: 'properties', timer: 'properties', socket: 'properties',
    php: 'application/x-httpd-php', java: 'text/x-java', c: 'text/x-csrc', h: 'text/x-csrc', cpp: 'text/x-c++src', hpp: 'text/x-c++src', cs: 'text/x-csharp', kt: 'text/x-kotlin',
    toml: 'toml', go: 'go', lua: 'lua', rb: 'ruby', pl: 'perl', rs: 'rust', ps1: 'powershell', psm1: 'powershell', diff: 'diff', patch: 'diff',
    j2: 'jinja2', jinja: 'jinja2', groovy: 'groovy', gradle: 'groovy', jenkinsfile: 'groovy'
  };
  const MODE_CHOICES = [['text/plain', 'Texte'], ['shell', 'Shell'], ['nginx', 'Nginx'], ['yaml', 'YAML'], ['properties', 'INI / .env / conf'], ['application/json', 'JSON'],
    ['javascript', 'JavaScript'], ['text/typescript', 'TypeScript'], ['python', 'Python'], ['application/x-httpd-php', 'PHP'], ['text/x-java', 'Java'], ['htmlmixed', 'HTML'],
    ['xml', 'XML'], ['css', 'CSS'], ['sql', 'SQL'], ['dockerfile', 'Dockerfile'], ['markdown', 'Markdown'], ['toml', 'TOML'], ['go', 'Go'], ['rust', 'Rust'],
    ['ruby', 'Ruby'], ['perl', 'Perl'], ['lua', 'Lua'], ['powershell', 'PowerShell'], ['groovy', 'Groovy'], ['jinja2', 'Jinja2'], ['diff', 'Diff']];

  function guessMode(p) {
    const base = p.split('/').pop().toLowerCase();
    if (/^dockerfile|\.dockerfile$/.test(base)) return 'dockerfile';
    if (p.includes('/nginx/') || /nginx.*\.conf$|\.nginx$/.test(base)) return 'nginx';
    if (/^\.(bashrc|bash_profile|profile|zshrc|bash_aliases)$/.test(base) || p.startsWith('/etc/profile')) return 'shell';
    if (base === 'jenkinsfile') return 'groovy';
    if (/^\.env(\..+)?$/.test(base) || /^(sshd_config|ssh_config|hosts|fstab|crontab|sudoers)$/.test(base)) return 'properties';
    if (base === 'makefile') return 'shell';
    const ext = base.includes('.') ? base.split('.').pop() : '';
    return MODE_BY_EXT[ext] || 'text/plain';
  }

  function resolveRemotePath(p, home) {
    p = p.trim();
    if (p === '~') return home;
    if (p.startsWith('~/')) return home.replace(/\/$/, '') + p.slice(1);
    if (!p.startsWith('/')) return home.replace(/\/$/, '') + '/' + p;
    return p;
  }

  async function askSudoPassword(host, reason) {
    const inp = h('input', { type: 'password', autocomplete: 'off' });
    const remember = h('input', { type: 'checkbox' });
    return modal({
      title: 'Mot de passe sudo',
      body: [h('p', { text: `${reason ? reason + ' — ' : ''}${host.username}@${host.hostname}` }),
        field('Mot de passe sudo', secretInput(inp, { copy: false })),
        h('label', { class: 'check' }, remember, 'Mémoriser dans le coffre pour ce host')],
      actions: [{ label: 'Annuler', value: false }, { label: 'Valider', class: 'primary', submit: true, onClick: () => inp.value ? { password: inp.value, remember: remember.checked } : false }]
    });
  }

  function promptOpenFile(hostId, defaultDir) {
    const host = hostById(hostId);
    const inp = h('input', { value: defaultDir ? defaultDir.replace(/\/?$/, '/') : '', placeholder: '/etc/nginx/nginx.conf ou ~/app/.env' });
    const sudo = h('input', { type: 'checkbox' });
    modal({
      title: `Ouvrir un fichier sur ${host ? host.label : ''}`,
      body: [field('Chemin', inp, 'Chemin absolu, ~/… ou relatif au dossier personnel. Un fichier inexistant peut être créé.'),
        h('label', { class: 'check' }, sudo, 'Ouvrir en sudo (fichiers système)')],
      actions: [{ label: 'Annuler', value: false }, { label: 'Ouvrir', class: 'primary', submit: true, onClick: () => {
        if (!inp.value.trim()) return false;
        openEditor(hostId, inp.value.trim(), { sudo: sudo.checked });
        return true;
      } }]
    });
  }

  function openEditor(hostId, rawPath, opts = {}) {
    const host = hostById(hostId);
    if (!host) return;
    // Même fichier déjà ouvert (même host, même chemin, même mode) → on l'active.
    for (const t of tabs.values()) {
      if (t.kind === 'edit' && t.hostId === hostId && t.rawPath === rawPath && t.sudo === !!opts.sudo) { activateTab(t.id); return; }
    }
    const id = uid();
    const cmHost = h('div', { class: 'cm-host' });
    const histPanel = h('aside', { class: 'history-panel', hidden: true });
    const status = h('div', { class: 'editor-status' });
    const pathEl = h('span', { class: 'sub editor-path' });
    const dirtyDot = h('span', { class: 'dirty-dot', title: 'Modifications non enregistrées', hidden: true }, '●');
    const sudoBadge = h('span', { class: 'badge R', text: 'sudo', hidden: !opts.sudo });
    const newBadge = h('span', { class: 'badge', text: 'nouveau', hidden: true });
    const modeSel = h('select', { class: 'mode-select' }, MODE_CHOICES.map(([v, l]) => h('option', { value: v, text: l })));
    const wrapBtn = h('button', { class: 'btn sm', title: 'Retour à la ligne automatique' }, '↵ Retour ligne');
    const saveBtn = h('button', { class: 'btn primary sm', title: 'Enregistrer (Ctrl+S)' }, '💾 Enregistrer');
    const bar = h('div', { class: 'session-bar' },
      h('span', { class: 'title', text: '📝' }), dirtyDot, h('span', { class: 'title editor-name' }), pathEl, sudoBadge, newBadge,
      h('span', { class: 'spacer' }), modeSel, wrapBtn,
      h('button', { class: 'btn sm', title: 'Rechercher / remplacer (Ctrl+F, Ctrl+H)', onclick: () => t.cm && t.cm.execCommand('find') }, '🔍'),
      h('button', { class: 'btn sm', title: 'Historique des versions', onclick: () => toggleHistory(t) }, '🕘 Historique'),
      h('button', { class: 'btn sm', title: 'Recharger depuis le serveur', onclick: () => reload() }, '⟳'),
      saveBtn);
    const body = h('div', { class: 'editor-body' }, cmHost, histPanel);
    const wrap = h('div', { class: 'term-wrap editor-wrap' }, body, status);
    const el = h('div', { class: 'session' }, bar, wrap);
    $('#sessions').append(el);

    const t = { id, kind: 'edit', hostId, rawPath, path: rawPath, sudo: !!opts.sudo, title: rawPath.split('/').pop() || rawPath, el, status: 'wait',
      cm: null, hash: null, eol: 'lf', exists: true, savedGen: 0, sudoPassword: null, histPanel, fit: () => t.cm && t.cm.refresh() };
    tabs.set(id, t);

    const cm = CodeMirror(cmHost, {
      value: '', lineNumbers: true, theme: 'kst', mode: 'text/plain', indentUnit: 2, tabSize: 4, indentWithTabs: false,
      matchBrackets: true, autoCloseBrackets: true, styleActiveLine: true, lineWrapping: false, readOnly: 'nocursor',
      extraKeys: {
        'Ctrl-S': () => save(), 'Cmd-S': () => save(),
        'Ctrl-/': 'toggleComment', 'Ctrl-H': 'replace', 'Ctrl-G': 'jumpToLine',
        Tab: (c) => c.somethingSelected() ? c.indentMore() : c.replaceSelection(c.getOption('indentWithTabs') ? '\t' : ' '.repeat(c.getOption('indentUnit')))
      }
    });
    t.cm = cm;
    cm.setSize('100%', '100%');
    const refreshDirty = () => {
      t.dirty = !cm.isClean(t.savedGen);
      dirtyDot.hidden = !t.dirty;
      renderTabs();
    };
    cm.on('change', refreshDirty);
    cm.on('cursorActivity', () => updateStatus());
    const updateStatus = () => {
      const c = cm.getCursor();
      status.replaceChildren(
        h('span', { text: `Ln ${c.line + 1}, Col ${c.ch + 1}` }),
        h('span', { text: `${cm.lineCount()} lignes` }),
        h('span', { text: 'UTF-8' }),
        h('span', { class: 'clickable', title: 'Changer les fins de ligne', text: t.eol.toUpperCase(), onclick: () => { t.eol = t.eol === 'lf' ? 'crlf' : 'lf'; dirtyDot.hidden = false; t.dirty = true; renderTabs(); updateStatus(); toast(`Fins de ligne : ${t.eol.toUpperCase()} (appliqué à l'enregistrement)`); } }),
        t.mode ? h('span', { text: (MODE_CHOICES.find(m => m[0] === t.mode) || [0, t.mode])[1] }) : null,
        t.sudo ? h('span', { class: 'warn-text', text: 'sudo' }) : null);
    };
    modeSel.addEventListener('change', () => { t.mode = modeSel.value; cm.setOption('mode', t.mode); updateStatus(); });
    wrapBtn.addEventListener('click', () => { const v = !cm.getOption('lineWrapping'); cm.setOption('lineWrapping', v); wrapBtn.classList.toggle('on', v); });

    const withSudo = async (fn) => {
      for (let attempt = 0; attempt < 3; attempt++) {
        try { return await fn(); } catch (e) {
          if (e.message.includes('SUDO_PASSWORD') || /sudo requis|sudo.*incorrect/i.test(e.message)) {
            const r = await askSudoPassword(host, attempt ? 'Mot de passe incorrect' : 'sudo demande un mot de passe');
            if (!r) throw new Error('Annulé');
            t.sudoPassword = r.password; t.rememberSudo = r.remember;
            continue;
          }
          throw e;
        }
      }
      throw new Error('Trop de tentatives sudo');
    };
    const sudoOpts = () => ({ sudo: t.sudo, sudoPassword: t.sudoPassword || undefined, rememberSudo: !!t.rememberSudo });

    function setPath(p) {
      t.path = p;
      t.title = p.replace(/\/+$/, '').split('/').pop() || p;
      el.querySelector('.editor-name').textContent = t.title;
      pathEl.textContent = `${host.label}:${p}`;
      pathEl.title = p;
      renderTabs();
    }

    // Sélecteur de fichier dans un dossier (SFTP, ou ls via sudo si le dossier est protégé).
    async function showDirPicker(dir) {
      setStatus(t, 'wait');
      overlay(wrap, [h('div', { class: 'spinner' }), h('div', { text: `Lecture du dossier ${dir}${t.sudo ? ' (sudo)' : ''}…` })]);
      let list;
      try {
        list = await withSudo(() => api.invoke('editor:listDir', id, hostId, dir, sudoOpts()));
      } catch (e) {
        const msg = e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
        if (/Permission refusée/.test(msg) && !t.sudo) { t.sudo = true; sudoBadge.hidden = false; return showDirPicker(dir); }
        setStatus(t, 'off');
        overlay(wrap, [h('div', { style: { fontWeight: 600 }, text: 'Impossible de lire le dossier' }), h('div', { class: 'muted', text: msg }),
          h('div', { class: 'actions' }, h('button', { class: 'btn', onclick: () => closeTab(id) }, 'Fermer'))]);
        return;
      }
      setStatus(t, 'off');
      setPath(dir.replace(/\/?$/, '/'));
      const join = (n) => (dir === '/' ? '' : dir.replace(/\/+$/, '')) + '/' + n;
      const open = (p) => { t.rawPath = p; setPath(p); load(false); };
      const filter = h('input', { class: 'picker-filter', placeholder: 'Filtrer…' });
      const newName = h('input', { placeholder: 'nouveau-fichier.conf' });
      const listEl = h('div', { class: 'picker-list' });
      const render = () => {
        const q = filter.value.toLowerCase();
        const items = list.filter(x => !q || x.name.toLowerCase().includes(q));
        listEl.replaceChildren(...[
          dir !== '/' ? h('button', { class: 'picker-item dir', onclick: () => showDirPicker(dir.replace(/\/[^/]+\/?$/, '') || '/') }, '📁 ..') : null,
          ...items.map(x => h('button', { class: 'picker-item' + (x.isDir ? ' dir' : ''), title: join(x.name),
            onclick: () => x.isDir ? showDirPicker(join(x.name)) : open(join(x.name)) }, (x.isDir ? '📁 ' : '📄 ') + x.name)),
          !items.length ? h('div', { class: 'muted small', style: { padding: '10px' }, text: 'Dossier vide' }) : null].flat().filter(Boolean));
      };
      filter.addEventListener('input', render);
      filter.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter') return;
        const q = filter.value.toLowerCase();
        const first = list.find(x => !q || x.name.toLowerCase().includes(q));
        if (first) first.isDir ? showDirPicker(join(first.name)) : open(join(first.name));
      });
      newName.addEventListener('keydown', (e) => { if (e.key === 'Enter' && newName.value.trim()) open(join(newName.value.trim())); });
      render();
      overlay(wrap, [
        h('div', { class: 'picker-head' }, h('strong', { text: `📁 ${dir}` }), t.sudo ? h('span', { class: 'badge R', text: 'sudo' }) : null),
        h('div', { class: 'muted small', text: 'C\'est un dossier : choisis le fichier à éditer, ou crée-en un.' }),
        filter, listEl,
        h('div', { class: 'picker-new' }, newName, h('button', { class: 'btn primary sm', onclick: () => newName.value.trim() && open(join(newName.value.trim())) }, '+ Créer')),
        h('div', { class: 'actions' }, h('button', { class: 'btn', onclick: () => closeTab(id) }, 'Fermer'))
      ]);
      const card = wrap.querySelector(':scope > .overlay .overlay-card');
      if (card) card.classList.add('picker');
      setTimeout(() => filter.focus(), 30);
    }

    async function load(isReload) {
      setStatus(t, 'wait');
      overlay(wrap, [h('div', { class: 'spinner' }), h('div', { text: `${isReload ? 'Rechargement' : 'Ouverture'} de ${t.path}${t.sudo ? ' (sudo)' : ''}…` })]);
      activateTab(id);
      try {
        if (!t.home) {
          const r = await api.invoke('editor:open', id, hostId);
          t.home = r.home;
          setPath(resolveRemotePath(t.rawPath, t.home));
        }
        // Chemin qui se termine par « / » : c'est un dossier → sélecteur de fichier.
        if (/\/$/.test(t.path)) { await showDirPicker(t.path.replace(/\/+$/, '') || '/'); return; }
        let r;
        try {
          r = await withSudo(() => api.invoke('editor:read', id, hostId, t.path, { ...sudoOpts(), create: true }));
        } catch (e) {
          if (/est un dossier/.test(e.message)) { await showDirPicker(t.path); return; }
          if (/Permission refusée/.test(e.message) && !t.sudo) {
            const ok = await confirmBox('Permission refusée', `Tu n'as pas le droit de lire ${t.path}. L'ouvrir en sudo ?`, 'Ouvrir en sudo');
            if (ok) { t.sudo = true; sudoBadge.hidden = false; return load(isReload); }
          }
          throw e;
        }
        t.hash = r.hash; t.eol = r.eol; t.exists = r.exists; t.fileMode = r.mode;
        newBadge.hidden = r.exists;
        if (!isReload) { t.mode = guessMode(t.path); modeSel.value = MODE_CHOICES.some(m => m[0] === t.mode) ? t.mode : 'text/plain'; cm.setOption('mode', t.mode); }
        const indentTabs = /^\t/m.test(r.content) && !/^ {2,}\S/m.test(r.content);
        cm.setOption('indentWithTabs', indentTabs);
        cm.setOption('readOnly', false);
        cm.setValue(r.content);
        cm.clearHistory();
        t.savedGen = cm.changeGeneration(true);
        refreshDirty();
        overlay(wrap, null);
        setStatus(t, 'on');
        updateStatus();
        setTimeout(() => { cm.refresh(); cm.focus(); }, 30);
        if (!r.exists) toast(`${t.path} n'existe pas encore : il sera créé à l'enregistrement`);
        if (!t.histPanel.hidden) loadHistory(t);
      } catch (e) {
        setStatus(t, 'off');
        overlay(wrap, [h('div', { style: { fontSize: '26px' }, text: '⚠' }), h('div', { style: { fontWeight: 600 }, text: 'Impossible d\'ouvrir le fichier' }),
          h('div', { class: 'muted', text: e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') }),
          h('div', { class: 'actions' }, h('button', { class: 'btn primary', onclick: () => load(isReload) }, 'Réessayer'),
            !t.sudo ? h('button', { class: 'btn', onclick: () => { t.sudo = true; sudoBadge.hidden = false; load(isReload); } }, 'Réessayer en sudo') : null,
            h('button', { class: 'btn', onclick: () => closeTab(id) }, 'Fermer'))]);
      }
    }

    async function reload() {
      if (t.dirty && !(await confirmBox('Recharger', 'Tes modifications non enregistrées seront perdues.', 'Recharger'))) return;
      load(true);
    }

    async function save(force) {
      if (t.saving || t.status !== 'on' || /\/$/.test(t.path)) return;
      t.saving = true;
      saveBtn.disabled = true; saveBtn.textContent = 'Enregistrement…';
      try {
        const r = await withSudo(() => api.invoke('editor:write', id, hostId, t.path, cm.getValue(),
          { ...sudoOpts(), eol: t.eol, expectedHash: t.exists ? t.hash : null, force: !!force }));
        t.hash = r.hash; t.exists = true; newBadge.hidden = true;
        t.savedGen = cm.changeGeneration(true);
        refreshDirty();
        toast(`Enregistré : ${t.path} (${fmtSize(r.size)})`);
        if (!t.histPanel.hidden) loadHistory(t);
      } catch (e) {
        const msg = e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
        if (/modifié sur le serveur/.test(msg)) {
          const choice = await modal({
            title: 'Conflit', body: [h('div', { class: 'callout warn', text: `${t.path} a été modifié sur le serveur depuis que tu l'as ouvert.` }),
              h('p', { class: 'muted small', text: 'Écraser remplace la version du serveur par la tienne (la version serveur reste récupérable dans l\'historique si tu la recharges d\'abord).' })],
            actions: [{ label: 'Annuler', value: 'cancel' }, { label: 'Voir les différences', value: 'diff' }, { label: 'Écraser', class: 'danger solid', value: 'force', submit: true }]
          });
          t.saving = false; saveBtn.disabled = false; saveBtn.textContent = '💾 Enregistrer';
          if (choice === 'force') return save(true);
          if (choice === 'diff') return showServerDiff(t);
          return;
        }
        if (/Permission refusée/.test(msg) && !t.sudo) {
          t.saving = false; saveBtn.disabled = false; saveBtn.textContent = '💾 Enregistrer';
          if (await confirmBox('Permission refusée', `Écriture refusée sur ${t.path}. Enregistrer en sudo ?`, 'Enregistrer en sudo')) {
            t.sudo = true; sudoBadge.hidden = false; updateStatus(); return save(force);
          }
          return;
        }
        toast(msg, true);
      } finally {
        t.saving = false; saveBtn.disabled = false; saveBtn.textContent = '💾 Enregistrer';
      }
    }
    saveBtn.addEventListener('click', () => save());
    t.save = save;
    load(false);
  }

  async function showServerDiff(t) {
    const r = await guard(() => api.invoke('editor:read', t.id, t.hostId, t.path, { sudo: t.sudo, sudoPassword: t.sudoPassword || undefined }));
    if (!r) return;
    t.histPanel.hidden = false;
    renderDiffPanel(t, { at: new Date().toISOString(), kind: 'version serveur actuelle', content: r.content, size: r.size }, true);
    loadHistory(t, true);
  }

  // ---------- Historique des éditions ----------
  function toggleHistory(t) {
    t.histPanel.hidden = !t.histPanel.hidden;
    if (!t.histPanel.hidden) loadHistory(t);
    setTimeout(() => t.cm.refresh(), 20);
  }

  async function loadHistory(t, keepDiff) {
    const list = await guard(() => api.invoke('history:list', t.hostId, t.path));
    if (!list) return;
    const listEl = h('div', { class: 'hist-list' }, list.length ? list.map(v => h('button', { class: 'hist-item', onclick: async () => {
      const full = await guard(() => api.invoke('history:get', t.hostId, t.path, v.id));
      if (full) renderDiffPanel(t, full);
    } }, h('div', { class: 'hist-top' }, h('span', { text: fmtDate(Date.parse(v.at)) }), h('span', { class: 'badge ' + (v.kind === 'enregistrement' ? 'ok' : ''), text: v.kind })),
    h('div', { class: 'muted small', text: `${fmtSize(v.size)}${v.sudo ? ' · sudo' : ''}` }))) : h('div', { class: 'muted small', style: { padding: '12px' }, text: 'Aucune version enregistrée pour ce fichier.' }));
    const head = h('div', { class: 'hist-head' }, h('strong', { text: 'Historique' }), h('span', { class: 'muted small', text: `${list.length} version(s) · chiffré` }),
      h('span', { class: 'spacer' }), h('button', { class: 'icon-btn', title: 'Fermer', onclick: () => toggleHistory(t) }, '✕'));
    const diffBox = keepDiff ? t.histPanel.querySelector('.diff-box') : null;
    t.histPanel.replaceChildren(head, listEl, diffBox || h('div', { class: 'diff-box muted small', text: 'Choisis une version pour voir les différences avec le contenu actuel de l\'éditeur.' }));
  }

  function renderDiffPanel(t, v, isServer) {
    const parts = Diff.diffLines(v.content, t.cm.getValue());
    let add = 0, del = 0;
    const lines = [];
    for (const p of parts) {
      const ls = p.value.replace(/\n$/, '').split('\n');
      if (p.added) add += ls.length; if (p.removed) del += ls.length;
      if (!p.added && !p.removed && ls.length > 6) {
        lines.push(...ls.slice(0, 2).map(l => ['ctx', l]), ['skip', `… ${ls.length - 4} lignes identiques …`], ...ls.slice(-2).map(l => ['ctx', l]));
      } else lines.push(...ls.map(l => [p.added ? 'add' : p.removed ? 'del' : 'ctx', l]));
    }
    const box = h('div', { class: 'diff-box' },
      h('div', { class: 'diff-head' },
        h('div', {}, h('strong', { text: isServer ? 'Version serveur' : fmtDate(Date.parse(v.at)) }), h('span', { class: 'muted small', text: ` · ${v.kind}` })),
        h('div', { class: 'small' }, h('span', { class: 'diff-del-n', text: `− ${del}` }), ' ', h('span', { class: 'diff-add-n', text: `+ ${add}` }), h('span', { class: 'muted', text: ' vs éditeur' }))),
      h('div', { class: 'diff-actions' },
        h('button', { class: 'btn primary sm', onclick: () => {
          t.cm.setValue(v.content);
          toast(isServer ? 'Version serveur chargée dans l\'éditeur' : 'Version restaurée dans l\'éditeur — enregistre (Ctrl+S) pour l\'appliquer sur le serveur');
          if (isServer) { t.hash = null; }
          renderDiffPanel(t, v, isServer);
        } }, isServer ? 'Prendre la version serveur' : '↺ Restaurer cette version'),
        !isServer ? h('button', { class: 'btn sm', onclick: async () => { const p = await guard(() => api.invoke('history:saveLocal', t.hostId, t.path, v.id)); if (p) toast('Enregistré : ' + p); } }, '⤓ Copie locale') : null),
      h('pre', { class: 'diff-lines' }, lines.length ? lines.map(([k, l]) => h('div', { class: 'dl ' + k }, h('span', { class: 'dl-sign', text: k === 'add' ? '+' : k === 'del' ? '−' : ' ' }), l)) : h('div', { class: 'muted', text: 'Identique au contenu actuel.' })));
    const old = t.histPanel.querySelector('.diff-box');
    if (old) old.replaceWith(box); else t.histPanel.append(box);
  }

  function viewHistory() {
    const items = S.editHistory || [];
    return h('div', {},
      h('div', { class: 'section-head' }, h('h1', { text: 'Historique des éditions' })),
      h('p', { class: 'muted', text: 'Chaque ouverture et chaque enregistrement d\'un fichier distant crée une version (40 max. par fichier), chiffrée avec la clé du coffre. Ouvre le fichier puis « Historique » pour comparer et restaurer.' }),
      items.length ? h('div', { class: 'list' }, items.map(it => {
        const host = hostById(it.hostId);
        return h('div', { class: 'row' },
          h('div', { class: 'avatar', style: { background: 'var(--bg-4)', color: 'var(--accent)' }, text: '📝' }),
          h('div', { class: 'row-main' },
            h('div', { class: 'row-title' }, it.path.split('/').pop(), h('span', { class: 'badge', text: `${it.count} version(s)` })),
            h('div', { class: 'row-sub', text: `${host ? host.label : it.hostLabel + ' (supprimé)'}:${it.path}  ·  ${fmtDate(Date.parse(it.updatedAt))}` })),
          h('div', { class: 'row-actions' },
            host ? h('button', { class: 'btn primary sm', onclick: () => { openEditor(it.hostId, it.path); setTimeout(() => { const t = [...tabs.values()].find(x => x.kind === 'edit' && x.hostId === it.hostId && x.rawPath === it.path); if (t && t.histPanel.hidden) toggleHistory(t); }, 400); } }, 'Ouvrir + historique') : null,
            host ? h('button', { class: 'btn sm', title: 'Ouvrir en sudo', onclick: () => openEditor(it.hostId, it.path, { sudo: true }) }, 'sudo') : null,
            h('button', { class: 'icon-btn', title: 'Supprimer l\'historique de ce fichier', onclick: async () => {
              if (await confirmBox('Supprimer l\'historique', `Supprimer les ${it.count} version(s) de ${it.path} ?`)) { const s = await guard(() => api.invoke('history:delete', it.key)); if (s) setState(s); }
            } }, '🗑')));
      })) : h('div', { class: 'empty', text: 'Aucun fichier édité pour l\'instant. Ouvre un fichier depuis SFTP (double-clic) ou depuis un terminal (📝 Éditer).' }));
  }

  // ---------- SFTP ----------
  // ---------- Liste de fichiers réutilisable (serveur ou PC) ----------
  // Sélection multiple (clic, Ctrl, Maj), tri par colonne, filtre, clavier, glisser-déposer.
  function fileList({ kind, onOpen, onKey, onContext, onDropInto, dragType }) {
    const st = { entries: [], sel: new Set(), anchor: null, sort: 'name', asc: true, filter: '', hidden: false };
    const tbody = h('tbody');
    const head = h('tr');
    const cols = kind === 'remote' ? [['name', 'Nom'], ['size', 'Taille'], ['mtime', 'Modifié'], ['perms', 'Droits']] : [['name', 'Nom'], ['size', 'Taille'], ['mtime', 'Modifié']];
    const table = h('table', { class: 'files' }, h('thead', {}, head), tbody);
    const wrap = h('div', { class: 'sftp-table-wrap', tabindex: '0' }, table);
    const renderHead = () => head.replaceChildren(...cols.map(([k, l]) => h('th', { class: 'sortable' + (st.sort === k ? ' on' : ''), onclick: () => { st.asc = st.sort === k ? !st.asc : true; st.sort = k; render(); } }, l + (st.sort === k ? (st.asc ? ' ▴' : ' ▾') : ''))));
    const visible = () => {
      const f = st.filter.toLowerCase();
      const list = st.entries.filter(e => e.name !== '.' && e.name !== '..' && (st.hidden || !e.name.startsWith('.')) && (!f || e.name.toLowerCase().includes(f)));
      const k = st.sort, dir = st.asc ? 1 : -1;
      return list.sort((a, b) => (b.isDir - a.isDir) || (k === 'name' ? a.name.localeCompare(b.name, 'fr', { numeric: true }) : ((a[k] > b[k]) - (a[k] < b[k]))) * dir);
    };
    function render() {
      renderHead();
      const list = visible();
      st.view = list;
      tbody.replaceChildren(...list.map((e, i) => {
        const tr = h('tr', { class: 'file-row' + (st.sel.has(e.name) ? ' selected' : '') + (e.isDir ? ' is-dir' : ''), draggable: 'true' },
          h('td', { class: 'name' }, h('span', { class: 'ficon', text: e.isDir ? '📁' : e.isLink ? '🔗' : fileIcon(e.name) }), e.name),
          h('td', { class: 'num', text: e.isDir ? '' : fmtSize(e.size) }),
          h('td', { class: 'num', text: e.mtime ? fmtDate(e.mtime) : '' }),
          kind === 'remote' ? h('td', { class: 'perm', text: e.perms || '' }) : null);
        tr.dataset.name = e.name;
        tr.addEventListener('mousedown', (ev) => {
          if (ev.button === 2 && st.sel.has(e.name)) return;
          // Clic simple sur un élément déjà sélectionné : on attend le relâchement
          // (sinon un glisser de plusieurs éléments perdrait la sélection).
          if (st.sel.has(e.name) && !ev.ctrlKey && !ev.metaKey && !ev.shiftKey) { st.pending = e.name; st.anchor = i; return; }
          select(e.name, i, ev);
        });
        tr.addEventListener('click', (ev) => { if (st.pending === e.name && !ev.ctrlKey && !ev.metaKey && !ev.shiftKey) { st.pending = null; st.sel = new Set([e.name]); updateSel(); } });
        tr.addEventListener('dblclick', () => onOpen(e));
        tr.addEventListener('contextmenu', (ev) => { ev.preventDefault(); onContext && onContext(ev, selected()); });
        tr.addEventListener('dragstart', (ev) => {
          st.pending = null;
          if (!st.sel.has(e.name)) { st.sel = new Set([e.name]); updateSel(); }
          ev.dataTransfer.setData(dragType, JSON.stringify(selected().map(x => x.name)));
          ev.dataTransfer.effectAllowed = 'copy';
        });
        if (e.isDir) {
          tr.addEventListener('dragover', (ev) => { if (acceptsDrop(ev)) { ev.preventDefault(); ev.stopPropagation(); tr.classList.add('drop-into'); } });
          tr.addEventListener('dragleave', () => tr.classList.remove('drop-into'));
          tr.addEventListener('drop', (ev) => { tr.classList.remove('drop-into'); if (acceptsDrop(ev)) { ev.preventDefault(); ev.stopPropagation(); onDropInto(ev, e); } });
        }
        return tr;
      }));
      if (!list.length) tbody.append(h('tr', {}, h('td', { colspan: cols.length, class: 'muted', text: st.entries.length ? 'Aucun élément (filtre / fichiers cachés)' : 'Dossier vide' })));
    }
    const acceptsDrop = (ev) => { const ty = [...ev.dataTransfer.types]; return ty.includes('Files') || ty.some(x => x.startsWith('application/x-kst-') && x !== dragType); };
    function select(name, i, ev) {
      if (ev.shiftKey && st.anchor !== null) {
        const [a, b] = [st.anchor, i].sort((x, y) => x - y);
        if (!ev.ctrlKey && !ev.metaKey) st.sel.clear();
        st.view.slice(a, b + 1).forEach(x => st.sel.add(x.name));
      } else if (ev.ctrlKey || ev.metaKey) { st.sel.has(name) ? st.sel.delete(name) : st.sel.add(name); st.anchor = i; }
      else { st.sel = new Set([name]); st.anchor = i; }
      updateSel();
    }
    // Met à jour la sélection sans reconstruire les lignes (le double-clic reste possible).
    function updateSel() { for (const tr of tbody.children) if (tr.dataset.name !== undefined) tr.classList.toggle('selected', st.sel.has(tr.dataset.name)); }
    const selected = () => st.entries.filter(e => st.sel.has(e.name));
    wrap.addEventListener('keydown', (ev) => {
      const k = ev.key;
      if ((ev.ctrlKey || ev.metaKey) && k.toLowerCase() === 'a') { ev.preventDefault(); st.view.forEach(x => st.sel.add(x.name)); updateSel(); return; }
      if (k === 'ArrowDown' || k === 'ArrowUp') {
        ev.preventDefault();
        const cur = st.anchor === null ? -1 : st.anchor;
        const n = Math.max(0, Math.min(st.view.length - 1, cur + (k === 'ArrowDown' ? 1 : -1)));
        if (st.view[n]) select(st.view[n].name, n, ev);
        const row = tbody.children[n]; if (row) row.scrollIntoView({ block: 'nearest' });
        return;
      }
      if (k === 'Enter' && selected().length === 1) { ev.preventDefault(); onOpen(selected()[0]); return; }
      if (onKey && onKey(ev, selected())) ev.preventDefault();
    });
    return {
      el: wrap, render, selected,
      set(entries) { const keep = new Set(entries.map(e => e.name)); st.entries = entries; st.sel = new Set([...st.sel].filter(n => keep.has(n))); st.anchor = null; render(); },
      clearSel() { st.sel.clear(); updateSel(); },
      setFilter(v) { st.filter = v; render(); },
      toggleHidden() { st.hidden = !st.hidden; render(); return st.hidden; },
      focus() { wrap.focus(); }
    };
  }
  function fileIcon(n) {
    const ext = (n.split('.').pop() || '').toLowerCase();
    if (['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'ico'].includes(ext)) return '🖼';
    if (['zip', 'gz', 'tgz', 'xz', 'bz2', 'rar', '7z', 'tar'].includes(ext)) return '🗜';
    if (['sh', 'bash', 'py', 'js', 'ts', 'php', 'java', 'go', 'rb', 'c', 'cpp', 'rs'].includes(ext)) return '📜';
    if (['conf', 'cfg', 'ini', 'yml', 'yaml', 'toml', 'env', 'json', 'xml'].includes(ext)) return '⚙';
    if (['log', 'txt', 'md'].includes(ext)) return '📃';
    if (['sql', 'db', 'sqlite'].includes(ext)) return '🗃';
    return '📄';
  }
  // Droits Unix : cases rwx ↔ octal.
  function chmodDialog(entries) {
    const first = entries[0];
    const cur = first && first.mode !== undefined ? (first.mode & 0o777) : 0o644;
    const boxes = {};
    const octal = h('input', { value: cur.toString(8).padStart(3, '0'), style: { width: '90px', fontFamily: 'var(--mono)' }, maxlength: 4 });
    const grid = h('div', { class: 'chmod-grid' }, h('span'), h('b', { text: 'Lecture' }), h('b', { text: 'Écriture' }), h('b', { text: 'Exécution' }),
      ...[['u', 'Propriétaire', 6], ['g', 'Groupe', 3], ['o', 'Autres', 0]].flatMap(([who, label, shift]) => [h('span', { text: label }),
        ...[4, 2, 1].map(bit => { const c = h('input', { type: 'checkbox' }); c.checked = !!(cur & (bit << shift)); boxes[who + bit] = [c, bit << shift]; c.addEventListener('change', fromBoxes); return c; })]));
    function fromBoxes() { let m = 0; for (const [c, v] of Object.values(boxes)) if (c.checked) m |= v; octal.value = m.toString(8).padStart(3, '0'); }
    octal.addEventListener('input', () => { const m = parseInt(octal.value, 8); if (!isNaN(m)) for (const [c, v] of Object.values(boxes)) c.checked = !!(m & v); });
    return modal({
      title: `Droits — ${entries.length > 1 ? entries.length + ' éléments' : first.name}`,
      body: [grid, h('div', { class: 'form-row', style: { alignItems: 'center', marginTop: '10px' } }, h('span', { class: 'muted small', text: 'Octal :' }), octal, h('span', { class: 'muted small', text: '644 fichier · 755 dossier/script · 600 secret' }))],
      actions: [{ label: 'Annuler', value: null }, { label: 'Appliquer', class: 'primary', submit: true, onClick: () => /^[0-7]{3,4}$/.test(octal.value) ? octal.value : false }]
    });
  }
  // Conflit à destination : remplacer, ignorer les existants ou garder les deux.
  async function askConflict(names) {
    if (!names.length) return 'overwrite';
    return modal({
      title: 'Déjà présent à destination',
      body: [h('p', { text: names.length === 1 ? `« ${names[0].name} » existe déjà.` : `${names.length} éléments existent déjà :` }),
        names.length > 1 ? h('div', { class: 'conflict-list mono small', text: names.slice(0, 12).map(n => (n.isDir ? '📁 ' : '📄 ') + n.name).join('\n') + (names.length > 12 ? `\n… +${names.length - 12}` : '') }) : null,
        h('p', { class: 'muted small', text: 'Dossiers : « Ignorer » fusionne en gardant les fichiers déjà présents.' })],
      actions: [{ label: 'Annuler', value: null }, { label: 'Garder les deux', value: 'rename' }, { label: 'Ignorer les existants', value: 'skip' }, { label: 'Remplacer', class: 'primary', value: 'overwrite' }]
    });
  }

  function openSftp(hostId, startDir) {
    const host = hostById(hostId);
    if (!host) return;
    const id = uid();
    const pathInput = h('input', { class: 'sftp-path', value: '' });
    const filterInput = h('input', { class: 'sftp-filter', placeholder: 'Filtrer…' });
    const t = { id, kind: 'sftp', hostId, title: host.label, status: 'wait', cwd: '/', home: '/', fit: () => {}, jobs: new Map(), localOpen: false, lcwd: null };

    // --- Panneau serveur ---
    const remote = fileList({
      kind: 'remote', dragType: 'application/x-kst-remote',
      onOpen: (e) => e.isDir ? go(posixJoin(t.cwd, e.name)) : openEditor(hostId, posixJoin(t.cwd, e.name)),
      onKey: (ev, sel) => {
        if (ev.key === 'Backspace') { go(posixParent(t.cwd)); return true; }
        if (ev.key === 'Delete' && sel.length) { removeItems(sel); return true; }
        if (ev.key === 'F2' && sel.length === 1) { rename(sel[0]); return true; }
        if (ev.key === 'F5') { go(t.cwd); return true; }
        return false;
      },
      onContext: (ev, sel) => remoteMenu(ev, sel),
      onDropInto: (ev, e) => dropOnRemote(ev, posixJoin(t.cwd, e.name))
    });
    const remotePane = h('div', { class: 'fpane remote-pane' },
      h('div', { class: 'fpane-head' }, h('span', { class: 'fpane-title', text: '🖧 ' + host.label }),
        h('button', { class: 'icon-btn', title: 'Dossier parent (Retour arrière)', onclick: () => go(posixParent(t.cwd)) }, '↑'),
        h('button', { class: 'icon-btn', title: 'Dossier personnel', onclick: () => go(t.home) }, '⌂'),
        pathInput, h('button', { class: 'icon-btn', title: 'Rafraîchir (F5)', onclick: () => go(t.cwd) }, '⟳')),
      remote.el,
      h('div', { class: 'drop-hint', text: 'Dépose ici pour envoyer dans ce dossier' }));
    // Dépôt sur le panneau serveur : fichiers de l'explorateur ou du panneau PC
    remotePane.addEventListener('dragover', (ev) => { const ty = [...ev.dataTransfer.types]; if (ty.includes('Files') || ty.includes('application/x-kst-local')) { ev.preventDefault(); remotePane.classList.add('dropping'); } });
    remotePane.addEventListener('dragleave', (ev) => { if (!remotePane.contains(ev.relatedTarget)) remotePane.classList.remove('dropping'); });
    remotePane.addEventListener('drop', (ev) => { remotePane.classList.remove('dropping'); ev.preventDefault(); dropOnRemote(ev, t.cwd); });

    // --- Panneau PC (optionnel) ---
    const lpath = h('input', { class: 'sftp-path' });
    const local = fileList({
      kind: 'local', dragType: 'application/x-kst-local',
      onOpen: (e) => e.isDir ? lgo(joinLocal(t.lcwd, e.name)) : api.invoke('lfs:open', joinLocal(t.lcwd, e.name)),
      onKey: (ev) => { if (ev.key === 'Backspace') { lgo(t.lparent || t.lcwd); return true; } if (ev.key === 'F5') { lgo(t.lcwd); return true; } return false; },
      onContext: (ev, sel) => popupMenu({ getBoundingClientRect: () => ({ left: ev.clientX, bottom: ev.clientY, top: ev.clientY }) }, [
        { label: `⤒ Envoyer vers ${t.cwd}`, onClick: () => upload(sel.map(x => joinLocal(t.lcwd, x.name)), t.cwd) },
        { label: '📂 Ouvrir', onClick: () => sel.forEach(x => api.invoke('lfs:open', joinLocal(t.lcwd, x.name))) }]),
      onDropInto: (ev, e) => dropOnLocal(ev, joinLocal(t.lcwd, e.name))
    });
    const roots = h('select', { class: 'roots', title: 'Emplacements' });
    roots.addEventListener('change', () => { if (roots.value) lgo(roots.value); roots.value = ''; });
    const localPane = h('div', { class: 'fpane local-pane', hidden: true },
      h('div', { class: 'fpane-head' }, h('span', { class: 'fpane-title', text: '💻 Ce PC' }),
        h('button', { class: 'icon-btn', title: 'Dossier parent', onclick: () => lgo(t.lparent || t.lcwd) }, '↑'), roots, lpath,
        h('button', { class: 'icon-btn', title: 'Rafraîchir', onclick: () => lgo(t.lcwd) }, '⟳')),
      local.el,
      h('div', { class: 'drop-hint', text: 'Dépose ici pour télécharger dans ce dossier' }));
    localPane.addEventListener('dragover', (ev) => { if ([...ev.dataTransfer.types].includes('application/x-kst-remote')) { ev.preventDefault(); localPane.classList.add('dropping'); } });
    localPane.addEventListener('dragleave', (ev) => { if (!localPane.contains(ev.relatedTarget)) localPane.classList.remove('dropping'); });
    localPane.addEventListener('drop', (ev) => { localPane.classList.remove('dropping'); ev.preventDefault(); dropOnLocal(ev, t.lcwd); });
    lpath.addEventListener('keydown', (e) => { if (e.key === 'Enter') lgo(lpath.value.trim()); });
    const joinLocal = (dir, name) => (dir.endsWith(t.lsep || '/') ? dir : dir + (t.lsep || '/')) + name;

    // --- File de transferts ---
    const qList = h('div', { class: 'q-list' });
    const qTitle = h('span', { class: 'q-title', text: 'Transferts' });
    const queue = h('div', { class: 'tqueue', hidden: true },
      h('div', { class: 'q-head' }, qTitle, h('span', { class: 'spacer' }),
        h('button', { class: 'btn sm', onclick: async () => { await api.invoke('sftp:clearDone'); for (const [k, j] of t.jobs) if (['done', 'error', 'cancelled'].includes(j.state)) { t.jobs.delete(k); } renderQueue(); } }, 'Effacer les terminés'),
        h('button', { class: 'icon-btn', title: 'Masquer', onclick: () => { queue.hidden = true; } }, '✕')),
      qList);

    const localBtn = h('button', { class: 'btn sm', title: 'Afficher le panneau de ce PC (glisser-déposer entre les deux)', onclick: toggleLocal }, '⇆ Panneau PC');
    const hiddenBtn = h('button', { class: 'icon-btn', title: 'Afficher les fichiers cachés', onclick: () => { const on = remote.toggleHidden(); local.toggleHidden(); hiddenBtn.classList.toggle('on', on); } }, '.*');
    const bar = h('div', { class: 'session-bar' },
      h('span', { class: 'title', text: '📁 ' + host.label }),
      localBtn, filterInput, hiddenBtn,
      h('span', { class: 'spacer' }),
      h('button', { class: 'btn sm', title: 'Créer un fichier vide', onclick: newFile }, '+ Fichier'),
      h('button', { class: 'btn sm', onclick: newFolder }, '+ Dossier'),
      h('button', { class: 'btn sm', title: 'Télécharger la sélection', onclick: () => download(remote.selected()) }, '⤓ Télécharger'),
      h('button', { class: 'btn primary sm', onclick: (e) => popupMenu(e.currentTarget, [
        { label: '📄 Envoyer des fichiers…', onClick: () => pickUpload('files') },
        { label: '📁 Envoyer des dossiers…', onClick: () => pickUpload('dir') }]) }, '⤒ Envoyer ▾'),
      h('button', { class: 'btn sm', onclick: () => openTerminal(hostId) }, '>_ SSH'));
    filterInput.addEventListener('input', () => { remote.setFilter(filterInput.value); local.setFilter(filterInput.value); });
    const panes = h('div', { class: 'fpanes' }, localPane, remotePane);
    const body = h('div', { class: 'sftp-body' }, panes, queue);
    const el = h('div', { class: 'session' }, bar, h('div', { class: 'term-wrap', style: { padding: 0, background: 'var(--bg)', display: 'flex', flexDirection: 'column' } }, body));
    const wrap = el.querySelector('.term-wrap');
    $('#sessions').append(el);
    t.el = el;
    tabs.set(id, t);
    pathInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(pathInput.value.trim() || '/'); });

    async function go(dir) {
      const list = await guard(() => api.invoke('sftp:list', id, dir));
      if (!list) { pathInput.value = t.cwd; return; }
      t.cwd = dir; pathInput.value = dir;
      remote.set(list);
      return true;
    }
    async function lgo(dir) {
      const r = await guard(() => api.invoke('lfs:list', dir));
      if (!r) { lpath.value = t.lcwd || ''; return; }
      t.lcwd = r.dir; t.lparent = r.parent; t.lsep = r.sep; lpath.value = r.dir;
      local.set(r.entries);
    }
    async function toggleLocal() {
      t.localOpen = !t.localOpen;
      localPane.hidden = !t.localOpen;
      localBtn.classList.toggle('on', t.localOpen);
      if (t.localOpen && !t.lcwd) {
        const rs = await guard(() => api.invoke('lfs:roots')) || [];
        roots.replaceChildren(h('option', { value: '', text: '📍' }), ...rs.map(r => h('option', { value: r.path, text: r.label })));
        lgo(t.lastLocal || null);
      }
    }

    // --- Transferts ---
    async function enqueue(dir, items, dest) {
      if (!items.length) return;
      const conflicts = await guard(() => api.invoke('sftp:conflicts', id, dir, items, dest)) || [];
      const policy = await askConflict(conflicts);
      if (!policy) return;
      const ids = await guard(() => api.invoke('sftp:enqueue', { sessionId: id, dir, items, dest, policy }));
      if (ids) { queue.hidden = false; }
    }
    const upload = (paths, dest) => enqueue('up', paths, dest);
    async function download(sel, destOverride) {
      if (!sel.length) { toast('Sélectionne d\'abord des fichiers ou dossiers', true); return; }
      let dest = destOverride || (t.localOpen && t.lcwd) || S.settings.downloadDir;
      if (!dest) dest = await api.invoke('sftp:downloadsDir');
      enqueue('down', sel.map(x => posixJoin(t.cwd, x.name)), dest);
    }
    async function downloadTo(sel) {
      const r = await guard(() => api.invoke('sftp:pick', 'dest'));
      if (!r || !r.length) return;
      const st2 = await guard(() => api.invoke('settings:save', { downloadDir: r[0] })); if (st2) S = st2;
      download(sel, r[0]);
    }
    async function pickUpload(kind) {
      const files = await guard(() => api.invoke('sftp:pick', kind));
      if (files && files.length) upload(files, t.cwd);
    }
    function dropOnRemote(ev, destDir) {
      const dt = ev.dataTransfer;
      const fromLocal = dt.getData('application/x-kst-local');
      if (fromLocal) { upload(JSON.parse(fromLocal).map(n => joinLocal(t.lcwd, n)), destDir); return; }
      const paths = [...dt.files].map(f => api.pathForFile(f)).filter(Boolean);
      if (paths.length) upload(paths, destDir);
      else if (dt.files.length) toast('Impossible de lire le chemin de ces fichiers', true);
    }
    function dropOnLocal(ev, destDir) {
      const fromRemote = ev.dataTransfer.getData('application/x-kst-remote');
      if (!fromRemote) return;
      enqueue('down', JSON.parse(fromRemote).map(n => posixJoin(t.cwd, n)), destDir);
    }
    function renderQueue() {
      const jobs = [...t.jobs.values()].sort((a, b) => (b.startedAt || 9e15) - (a.startedAt || 9e15));
      const active = jobs.filter(j => ['queued', 'running'].includes(j.state)).length;
      qTitle.textContent = active ? `Transferts — ${active} en cours` : 'Transferts';
      qList.replaceChildren(...jobs.map(j => {
        const pct = j.bytesTotal ? Math.floor(j.bytesDone / j.bytesTotal * 100) : (j.state === 'done' ? 100 : 0);
        const eta = j.speed && j.bytesTotal ? Math.max(0, Math.round((j.bytesTotal - j.bytesDone) / j.speed)) : null;
        const info = j.state === 'queued' ? 'en attente' : j.state === 'running'
          ? `${pct} % · ${fmtSize(j.bytesDone)} / ${fmtSize(j.bytesTotal)}${j.filesTotal > 1 ? ` · ${j.filesDone}/${j.filesTotal} fichiers` : ''}${j.speed ? ` · ${fmtSize(j.speed)}/s` : ''}${eta !== null ? ` · ${eta < 60 ? eta + ' s' : Math.ceil(eta / 60) + ' min'}` : ''}`
          : j.state === 'done' ? `✓ ${fmtSize(j.bytesTotal)}${j.filesTotal > 1 ? ` · ${j.filesTotal} fichiers` : ''}${j.skipped ? ` · ${j.skipped} ignoré(s)` : ''}`
            : j.state === 'cancelled' ? 'annulé' : 'échec : ' + j.error;
        return h('div', { class: 'transfer q-' + j.state, title: j.src + ' → ' + j.dest },
          h('span', { text: j.dir === 'up' ? '⤒' : '⤓' }), h('span', { class: 'name', text: j.name + (j.state === 'running' && j.current && j.current !== j.name ? ' › ' + j.current : '') }),
          h('div', { class: 'bar' }, h('i', { style: { width: pct + '%' } })), h('span', { class: 'qinfo', text: info }),
          ['queued', 'running'].includes(j.state) ? h('button', { class: 'icon-btn mini', title: 'Annuler', onclick: () => api.invoke('sftp:cancel', j.id) }, '✕')
            : j.state === 'done' && j.dir === 'down' ? h('button', { class: 'icon-btn mini', title: 'Ouvrir le dossier', onclick: () => api.invoke('lfs:open', j.dest) }, '📂') : h('span'));
      }));
    }
    t.onJob = (j) => {
      const prev = t.jobs.get(j.id);
      t.jobs.set(j.id, j);
      queue.hidden = false;
      renderQueue();
      if (prev && prev.state !== j.state && ['done', 'error'].includes(j.state)) {
        if (j.state === 'error') toast(`Transfert « ${j.name} » : ${j.error}`, true);
        if (j.dir === 'up' && j.dest === t.cwd) go(t.cwd);
        if (j.dir === 'down' && t.localOpen && j.dest === t.lcwd) lgo(t.lcwd);
      }
    };

    // --- Actions serveur ---
    function remoteMenu(ev, sel) {
      const one = sel.length === 1 ? sel[0] : null;
      const full = (e) => posixJoin(t.cwd, e.name);
      popupMenu({ getBoundingClientRect: () => ({ left: ev.clientX, bottom: ev.clientY, top: ev.clientY }) }, [
        ...(one && !one.isDir ? [{ label: '📝 Éditer', onClick: () => openEditor(hostId, full(one)) }, { label: '🛡 Éditer en sudo', onClick: () => openEditor(hostId, full(one), { sudo: true }) }] : []),
        ...(one && one.isDir ? [{ label: '📂 Ouvrir', onClick: () => go(full(one)) }, { label: '>_ Terminal ici', onClick: () => openTermHere(full(one)) }] : []),
        { label: `⤓ Télécharger${sel.length > 1 ? ` (${sel.length})` : ''}`, sub: t.localOpen ? 'vers ' + t.lcwd : 'vers ' + (S.settings.downloadDir || 'Téléchargements'), onClick: () => download(sel) },
        { label: '⤓ Télécharger dans…', onClick: () => downloadTo(sel) },
        ...(one ? [{ label: '✎ Renommer (F2)', onClick: () => rename(one) }] : []),
        { label: '🔐 Droits (chmod)…', onClick: () => chmodItems(sel) },
        { label: '⧉ Copier le chemin', onClick: () => copyText(sel.map(full).join('\n')) },
        { label: '🗑 Supprimer (Suppr)', onClick: () => removeItems(sel) }
      ]);
    }
    function openTermHere(dir) { const tt = openTerminal(hostId); toast('Terminal ouvert — cd ' + dir); setTimeout(() => { const p = tt && tt.panes && [...tt.panes.values()][0]; if (p) p.writeInput(`cd '${dir.replace(/'/g, "'\\''")}'\r`); }, 2500); }
    async function chmodItems(sel) {
      if (!sel.length) return;
      const mode = await chmodDialog(sel);
      if (!mode) return;
      for (const e of sel) await guard(async () => { await api.invoke('sftp:chmod', id, posixJoin(t.cwd, e.name), mode); return true; });
      go(t.cwd);
    }
    async function newFolder() {
      const inp = h('input', { placeholder: 'nouveau-dossier' });
      const name = await modal({ title: 'Nouveau dossier', body: field('Nom', inp), actions: [{ label: 'Annuler', value: false }, { label: 'Créer', class: 'primary', submit: true, onClick: () => inp.value.trim() || false }] });
      if (!name) return;
      if (await guard(async () => { await api.invoke('sftp:mkdir', id, posixJoin(t.cwd, name)); return true; })) go(t.cwd);
    }
    async function newFile() {
      const inp = h('input', { placeholder: 'fichier.conf' });
      const name = await modal({ title: 'Nouveau fichier', body: [field('Nom', inp), h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: true, id: 'nf-open' }), 'Ouvrir dans l\'éditeur')], actions: [{ label: 'Annuler', value: false }, { label: 'Créer', class: 'primary', submit: true, onClick: () => ({ name: inp.value.trim(), open: document.getElementById('nf-open').checked }) }] });
      if (!name || !name.name) return;
      const full = posixJoin(t.cwd, name.name);
      if (await guard(() => api.invoke('sftp:touch', id, full))) { go(t.cwd); if (name.open) openEditor(hostId, full); }
    }
    async function rename(e) {
      const inp = h('input', { value: e.name });
      const name = await modal({ title: 'Renommer', body: field('Nouveau nom', inp), actions: [{ label: 'Annuler', value: false }, { label: 'Renommer', class: 'primary', submit: true, onClick: () => inp.value.trim() || false }] });
      if (!name || name === e.name) return;
      if (await guard(async () => { await api.invoke('sftp:rename', id, posixJoin(t.cwd, e.name), posixJoin(t.cwd, name)); return true; })) go(t.cwd);
    }
    async function removeItems(sel) {
      if (!sel.length) return;
      const dirs = sel.filter(e => e.isDir).length;
      const msg = sel.length === 1 ? (sel[0].isDir ? `Supprimer le dossier « ${sel[0].name} » et TOUT son contenu ?` : `Supprimer « ${sel[0].name} » ?`)
        : `Supprimer ${sel.length} éléments${dirs ? ` (dont ${dirs} dossier(s) avec tout leur contenu)` : ''} ?`;
      if (!(await confirmBox('Supprimer', msg))) return;
      let n = 0;
      for (const e of sel) if (await guard(async () => { await api.invoke('sftp:delete', id, posixJoin(t.cwd, e.name), e.isDir); return true; })) n++;
      toast(`${n} élément(s) supprimé(s)`); go(t.cwd);
    }

    (async () => {
      overlay(wrap, [h('div', { class: 'spinner' }), h('div', { text: `Ouverture SFTP sur ${host.hostname}…` })]);
      activateTab(id);
      try {
        const r = await api.invoke('sftp:open', id, hostId);
        if (!tabs.has(id)) { api.invoke('sftp:close', id); return; }
        t.home = r.home; overlay(wrap, null); setStatus(t, 'on');
        if (!(startDir && await go(startDir))) await go(r.home);
        remote.focus();
      } catch (e) {
        setStatus(t, 'off');
        overlay(wrap, [h('div', { style: { fontWeight: 600 }, text: 'Échec SFTP' }), h('div', { class: 'muted', text: e.message }),
          h('div', { class: 'actions' }, h('button', { class: 'btn', onclick: () => closeTab(id) }, 'Fermer'))]);
      }
    })();
  }
  api.on('sftp:job', (j) => { const t = tabs.get(j.sessionId); if (t && t.onJob) t.onJob(j); });
  // Empêche le navigateur d'ouvrir un fichier lâché à côté d'une zone de dépôt.
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => e.preventDefault());

  api.on('sftp:progress', ({ sessionId, transferId, done, total }) => {
    const t = tabs.get(sessionId);
    const fn = t && t.transfers && t.transfers.get(transferId);
    if (fn) fn(done, total);
  });
  api.on('sftp:closed', ({ sessionId }) => { const t = tabs.get(sessionId); if (t) { setStatus(t, 'off'); toast(`SFTP ${t.title} : connexion fermée`, true); } });
  api.on('tunnel:status', ({ forwardId, active, reason, reconnecting, attempt, delay }) => {
    const f = S && S.forwards.find(x => x.id === forwardId);
    const name = f ? (f.label || forwardDesc(f)) : '';
    if (reconnecting && attempt === 1) toast(`Tunnel ${name} coupé (${reason}) — reconnexion automatique…`, true);
    else if (active && reason && /^Rétabli/.test(reason)) toast(`✓ Tunnel ${name} rétabli`);
    else if (!active && !reconnecting && reason && reason !== 'Arrêté') toast(`Tunnel ${name} coupé : ${reason}`, true);
    if (S) refresh();
  });

  // ---------- Questions du serveur (2FA / OTP / keyboard-interactive) ----------
  api.on('ssh:prompt', (info) => {
    const fields = info.prompts.map((pr, i) => {
      const inp = h('input', { type: pr.echo ? 'text' : 'password', autocomplete: 'one-time-code', inputmode: /code|otp|token|vérif|verif/i.test(pr.prompt) ? 'numeric' : null });
      let useStored = null;
      if (pr.prefill === 'stored') {
        useStored = h('input', { type: 'checkbox' }); useStored.checked = true;
        inp.placeholder = 'mot de passe enregistré';
        inp.disabled = true;
        useStored.addEventListener('change', () => { inp.disabled = useStored.checked; if (!useStored.checked) inp.focus(); });
      }
      const label = (pr.prompt || `Question ${i + 1}`).replace(/:\s*$/, '');
      return { inp, useStored, el: h('div', {}, field(label, pr.echo ? inp : secretInput(inp, { copy: false })),
        useStored ? h('label', { class: 'check small' }, useStored, 'Utiliser le mot de passe enregistré') : null) };
    });
    modal({
      title: '🔐 Vérification demandée par le serveur',
      body: [
        h('p', { text: `${info.label} (${info.host})` }),
        info.name ? h('div', { class: 'muted small', text: info.name }) : null,
        info.instructions ? h('div', { class: 'callout small', text: info.instructions }) : null,
        ...fields.map(f => f.el),
        h('div', { class: 'muted small', text: 'Code de ton application d\'authentification (Google Authenticator, Authy…) ou autre information demandée par le serveur.' })
      ],
      onOpen: (form) => {
        const bd = form.closest('.backdrop'); if (bd) bd.dataset.req = info.reqId;
        const first = fields.find(f => !f.inp.disabled);
        if (first) setTimeout(() => first.inp.focus(), 60);
      },
      actions: [{ label: 'Annuler', value: false }, { label: 'Valider', class: 'primary', submit: true, onClick: () => fields.map(f => f.useStored && f.useStored.checked ? '\u0000stored' : f.inp.value) }]
    }).then(ans => api.answerPrompt(info.reqId, ans || null));
  });
  api.on('ssh:promptCancel', ({ reqId }) => { const bd = document.querySelector(`.backdrop[data-req="${reqId}"]`); if (bd) bd.remove(); });

  // ---------- Vérification de clé d'hôte ----------
  api.on('hostkey:ask', (info) => {
    const changed = !!info.previous;
    const body = changed ? [
      h('div', { class: 'callout danger' }, h('strong', { text: '⚠ LA CLÉ D\'HÔTE A CHANGÉ' }),
        h('p', { class: 'small', text: `La clé présentée par ${info.host} ne correspond pas à celle enregistrée. Il peut s'agir d'une réinstallation du serveur… ou d'une interception (man-in-the-middle). Ne continue que si tu sais pourquoi.` })),
      field('Ancienne empreinte', h('div', { class: 'fp', text: `${info.previous.type}  ${info.previous.fingerprint}` })),
      field('Nouvelle empreinte', h('div', { class: 'fp', text: `${info.type}  ${info.fingerprint}` }))
    ] : [
      h('p', { text: `Première connexion à ${info.label} (${info.host}). Vérifie l'empreinte avant d'accepter :` }),
      h('div', { class: 'callout' }, h('div', { class: 'fp', text: `${info.type}\n${info.fingerprint}` })),
      h('p', { class: 'muted small', text: 'Sur le serveur : ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub' })
    ];
    modal({
      title: changed ? 'Alerte de sécurité' : 'Nouvel hôte',
      body,
      actions: changed
        ? [{ label: 'Refuser', class: 'primary', value: 'no', submit: true }, { label: 'Remplacer et continuer', class: 'danger', value: 'yes' }]
        : [{ label: 'Refuser', value: 'no' }, { label: 'Faire confiance', class: 'primary', value: 'yes', submit: true }]
    }).then(v => api.answerHostKey(info.reqId, v === 'yes'));
  });

  window.addEventListener('resize', () => { const t = tabs.get(ui.activeTab); if (t) fitTab(t); });

  // ---------- Fenêtre ----------
  (async () => {
    try {
      const info = await api.invoke('window:info');
      document.body.classList.add('os-' + info.platform);
      document.body.classList.toggle('maximized', info.maximized);
      $('#app-version').textContent = 'v' + info.version;
    } catch { /* ignore */ }
  })();
  api.on('window:state', (s) => {
    document.body.classList.toggle('maximized', s.maximized);
    document.body.classList.toggle('fullscreen', s.fullscreen);
    document.body.classList.toggle('blurred', !s.focused);
  });
  window.addEventListener('beforeunload', () => { for (const id of [...tabs.keys()]) disposeTab(id); });

  // Thème appliqué avant l'écran de verrouillage (mémorisé localement, sans secret).
  let savedTheme = 'auto';
  try { savedTheme = localStorage.getItem('kst-theme') || 'auto'; } catch { /* ignore */ }
  applyTheme(savedTheme);
  initLock();
})();

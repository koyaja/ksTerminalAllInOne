'use strict';
// Intégration shell (bash / zsh) pour les sessions SSH, sans rien installer sur le serveur.
//
// Dès que l'invite du shell apparaît, KSTermus tape une ligne invisible qui ajoute
// des « hooks » au shell en cours :
//   · OSC 133 ; C            début d'exécution d'une commande
//   · OSC 133 ; D ; <code>   fin de commande + code de retour
//   · OSC 133 ; A            nouvelle invite
//   · OSC 7 file://hôte/dir  dossier courant
// Rien n'est écrit sur le disque du serveur, ~/.bashrc n'est pas modifié ; la ligne est
// retirée de l'historique. L'écho de cette ligne est masqué : l'utilisateur voit son
// invite habituelle. Autres shells (fish, sh, tcsh, menus…) : on ne fait rien.

const READY = '\x1b]633;KST;ready\x07';

// Script exécuté par `eval '…'` : aucune apostrophe autorisée à l'intérieur.
const HOOKS = [
  'if [ -z "${__KST_SI:-}" ]; then __KST_SI=1',
  'if [ -n "${BASH_VERSION:-}" ]; then',
  'history -d $((HISTCMD-1)) 2>/dev/null',
  '__kst_p() { local e=$?; printf "\\033]133;D;%s\\007\\033]7;file://%s%s\\007\\033]133;A\\007" "$e" "${HOSTNAME:-}" "$PWD"; return $e; }',
  'PROMPT_COMMAND="__kst_p${PROMPT_COMMAND:+; $PROMPT_COMMAND}"',
  'PS0="\\e]133;C\\a${PS0:-}"',
  'elif [ -n "${ZSH_VERSION:-}" ]; then',
  '__kst_p() { local e=$?; printf "\\033]133;D;%s\\007\\033]7;file://%s%s\\007\\033]133;A\\007" "$e" "${HOST:-}" "$PWD"; return $e; }',
  '__kst_x() { printf "\\033]133;C\\007"; }',
  'precmd_functions=(__kst_p $precmd_functions); preexec_functions+=(__kst_x)',
  'fi; fi'
].join('; ').replace(/(then|else|do);/g, '$1');

// Ligne tapée (commence par une espace : ignorée par l'historique sur la plupart des systèmes).
function bootstrapLine() {
  return ` [ -n "$BASH_VERSION$ZSH_VERSION" ] && eval '${HOOKS}'; printf '\\033]633;KST;ready\\007'\r`;
}

const stripAnsi = (s) => String(s)
  .replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, '')
  .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
  .replace(/\x1b[()][\w]/g, '')
  .replace(/\x1b[=>78]/g, '');

// Dernière ligne visible = une invite de shell ?
function looksLikePrompt(tail) {
  const lines = stripAnsi(tail).replace(/\r(?!\n)/g, '\n').split('\n');
  const last = lines[lines.length - 1];
  return (/[$#%>❯»➜λ]\s?$/.test(last) || /^\s*[➜❯λ]\s/.test(last)) && last.trim().length <= 200 && !/(password|mot de passe|passphrase)[^$#%>]*[:>]\s?$/i.test(last);
}

// Filtre posé entre le flux SSH et le terminal pendant l'injection.
class Injector {
  constructor({ emit, send, onDone = () => {}, now = Date.now, idleMs = 350, waitMs = 6000, hideMs = 3000 }) {
    Object.assign(this, { emit, send, onDone, now, idleMs, waitMs, hideMs });
    this.state = 'wait';        // wait → hidden → on | off
    this.tail = '';
    this.buf = '';
    this.queue = [];
    this.started = now();
    this.lastData = 0;
    this.timer = setInterval(() => this.check(), 100);
  }
  data(d) {
    if (this.state === 'hidden') {
      this.buf += d;
      const i = this.buf.indexOf(READY);
      if (i >= 0) { const rest = this.buf.slice(i + READY.length); this.buf = ''; this.finish('on', '\r\x1b[2K' + rest.replace(/^\r?\n/, '')); }
      return;
    }
    if (this.state === 'wait') { this.lastData = this.now(); this.tail = (this.tail + d).slice(-400); }
    this.emit(d);
  }
  // Saisie de l'utilisateur : retenue tant que l'injection n'est pas terminée.
  write(d) {
    if (this.state === 'wait' || this.state === 'hidden') { this.queue.push(d); return true; }
    return false;
  }
  check() {
    const t = this.now();
    if (this.state === 'wait') {
      if (this.lastData && t - this.lastData >= this.idleMs && looksLikePrompt(this.tail)) {
        this.state = 'hidden'; this.hiddenAt = t;
        this.send(bootstrapLine());
      } else if (t - this.started > this.waitMs) this.finish('off', '');
    } else if (this.state === 'hidden' && t - this.hiddenAt > this.hideMs) {
      const b = this.buf; this.buf = ''; this.finish('off', b);
    }
  }
  finish(state, out) {
    clearInterval(this.timer);
    this.state = state;
    if (out) this.emit(out);
    for (const d of this.queue.splice(0)) this.send(d);
    this.onDone(state === 'on');
  }
  cancel() { if (this.state === 'wait' || this.state === 'hidden') this.finish('off', this.buf); }
}

module.exports = { Injector, bootstrapLine, looksLikePrompt, stripAnsi, READY, HOOKS };

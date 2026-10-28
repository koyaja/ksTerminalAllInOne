'use strict';
// Thèmes de KSTermus : interface, terminal (xterm) et éditeur partagent la même palette.
// Les thèmes « doux » visent un contraste texte/fond de 7 à 10:1 (lisible sans
// éblouir) au lieu de 15-21:1 (blanc pur sur noir pur, ou l'inverse).
(function () {
  const T = {
    kstermus: {
      name: 'KSTermus', desc: 'Sombre bleuté d\'origine, contraste élevé.', light: false,
      ui: { bg: '#0f1419', bg2: '#141b23', bg3: '#1b2430', bg4: '#232f3d', line: '#2a3644', text: '#e6edf3', muted: '#8b99a8', accent: '#2dd4a7', accentInk: '#062a20', danger: '#f2555a', warn: '#f5b84a', info: '#5ab0ff', purple: '#c39bff' },
      term: { background: '#0b0f14', foreground: '#e6edf3', cursor: '#2dd4a7', selectionBackground: '#2dd4a744',
        black: '#1b2430', red: '#f2555a', green: '#2dd4a7', yellow: '#f5b84a', blue: '#5ab0ff', magenta: '#c39bff', cyan: '#56d4e8', white: '#d0d7de',
        brightBlack: '#5c6b7c', brightRed: '#ff7a7f', brightGreen: '#5ef0c4', brightYellow: '#ffd27a', brightBlue: '#8cc8ff', brightMagenta: '#d8bcff', brightCyan: '#8ce8f5', brightWhite: '#ffffff' },
      syn: { comment: '#6b7b8c', string: '#9be15d' }
    },
    doux: {
      name: 'Sombre doux', desc: 'Gris chaud et couleurs atténuées (Gruvbox Material). Recommandé le soir et en pièce sombre.', light: false, recommended: 'nuit',
      ui: { bg: '#252423', bg2: '#2b2927', bg3: '#32302f', bg4: '#3c3836', line: '#4a4542', text: '#d4be98', muted: '#a89984', accent: '#89b482', accentInk: '#1d2021', danger: '#ea6962', warn: '#d8a657', info: '#7daea3', purple: '#d3869b' },
      term: { background: '#292828', foreground: '#d4be98', cursor: '#d4be98', selectionBackground: '#7daea340',
        black: '#32302f', red: '#ea6962', green: '#a9b665', yellow: '#d8a657', blue: '#7daea3', magenta: '#d3869b', cyan: '#89b482', white: '#d4be98',
        brightBlack: '#7c6f64', brightRed: '#ea6962', brightGreen: '#a9b665', brightYellow: '#d8a657', brightBlue: '#7daea3', brightMagenta: '#d3869b', brightCyan: '#89b482', brightWhite: '#ddc7a1' },
      syn: { comment: '#928374', string: '#a9b665' }
    },
    nord: {
      name: 'Nord', desc: 'Bleu-gris arctique, froid et calme.', light: false,
      ui: { bg: '#292e39', bg2: '#2e3440', bg3: '#3b4252', bg4: '#434c5e', line: '#4c566a', text: '#e5e9f0', muted: '#a7b1c2', accent: '#88c0d0', accentInk: '#1f2430', danger: '#bf616a', warn: '#ebcb8b', info: '#81a1c1', purple: '#b48ead' },
      term: { background: '#2e3440', foreground: '#d8dee9', cursor: '#d8dee9', selectionBackground: '#88c0d040',
        black: '#3b4252', red: '#bf616a', green: '#a3be8c', yellow: '#ebcb8b', blue: '#81a1c1', magenta: '#b48ead', cyan: '#88c0d0', white: '#e5e9f0',
        brightBlack: '#616e88', brightRed: '#bf616a', brightGreen: '#a3be8c', brightYellow: '#ebcb8b', brightBlue: '#81a1c1', brightMagenta: '#b48ead', brightCyan: '#8fbcbb', brightWhite: '#eceff4' },
      syn: { comment: '#7b88a1', string: '#a3be8c' }
    },
    solarized: {
      name: 'Solarized sombre', desc: 'Classique à faible contraste, très reposant mais un peu terne.', light: false,
      ui: { bg: '#00252e', bg2: '#002b36', bg3: '#073642', bg4: '#0d4150', line: '#164f5c', text: '#a3b2b2', muted: '#839496', accent: '#2aa198', accentInk: '#002b36', danger: '#dc322f', warn: '#b58900', info: '#268bd2', purple: '#6c71c4' },
      term: { background: '#002b36', foreground: '#93a1a1', cursor: '#93a1a1', selectionBackground: '#2aa19840',
        black: '#073642', red: '#dc322f', green: '#859900', yellow: '#b58900', blue: '#268bd2', magenta: '#d33682', cyan: '#2aa198', white: '#eee8d5',
        brightBlack: '#586e75', brightRed: '#cb4b16', brightGreen: '#93a1a1', brightYellow: '#839496', brightBlue: '#839496', brightMagenta: '#6c71c4', brightCyan: '#93a1a1', brightWhite: '#fdf6e3' },
      syn: { comment: '#586e75', string: '#859900' }
    },
    sepia: {
      name: 'Clair sépia', desc: 'Papier chaud, sans blanc éclatant. Recommandé en journée et en pièce lumineuse.', light: true, recommended: 'jour',
      ui: { bg: '#ebe2cf', bg2: '#f3ecdc', bg3: '#e6dcc6', bg4: '#ddd0b5', line: '#cdbd9c', text: '#3b3228', muted: '#6e5f4d', accent: '#2f7566', accentInk: '#fbf6ea', danger: '#a8403a', warn: '#8f5d00', info: '#2c6496', purple: '#7d4a86' },
      term: { background: '#f4ecda', foreground: '#3b3228', cursor: '#2f7566', selectionBackground: '#2f756633',
        black: '#3b3228', red: '#a8403a', green: '#4c7326', yellow: '#8f5d00', blue: '#2c6496', magenta: '#7d4a86', cyan: '#2f7566', white: '#6e5f4d',
        brightBlack: '#8a7a66', brightRed: '#c0524a', brightGreen: '#5d8a32', brightYellow: '#a66f00', brightBlue: '#3a77ad', brightMagenta: '#935aa0', brightCyan: '#3a8a79', brightWhite: '#3b3228' },
      syn: { comment: '#8a7a66', string: '#4c7326' }
    },
    clair: {
      name: 'Clair', desc: 'Blanc net façon GitHub, pour les écrans très lumineux.', light: true,
      ui: { bg: '#f3f5f8', bg2: '#ffffff', bg3: '#eef1f4', bg4: '#e4e8ed', line: '#d0d7de', text: '#1f2328', muted: '#57606a', accent: '#1a7f64', accentInk: '#ffffff', danger: '#cf222e', warn: '#9a6700', info: '#0969da', purple: '#8250df' },
      term: { background: '#ffffff', foreground: '#1f2328', cursor: '#1a7f64', selectionBackground: '#0969da30',
        black: '#24292f', red: '#cf222e', green: '#116329', yellow: '#7d4e00', blue: '#0969da', magenta: '#8250df', cyan: '#1b7c83', white: '#57606a',
        brightBlack: '#6e7781', brightRed: '#a40e26', brightGreen: '#1a7f37', brightYellow: '#9a6700', brightBlue: '#218bff', brightMagenta: '#a475f9', brightCyan: '#3192aa', brightWhite: '#1f2328' },
      syn: { comment: '#6e7781', string: '#116329' }
    },
    contraste: {
      name: 'Contraste élevé', desc: 'Noir et blanc purs, pour la basse vision ou un écran en plein soleil.', light: false,
      ui: { bg: '#000000', bg2: '#0a0a0a', bg3: '#151515', bg4: '#222222', line: '#6a6a6a', text: '#ffffff', muted: '#d0d0d0', accent: '#3ff2c4', accentInk: '#000000', danger: '#ff6b6b', warn: '#ffd24a', info: '#6cb6ff', purple: '#d6a8ff' },
      term: { background: '#000000', foreground: '#ffffff', cursor: '#3ff2c4', selectionBackground: '#3ff2c455',
        black: '#000000', red: '#ff6b6b', green: '#3ff2c4', yellow: '#ffd24a', blue: '#6cb6ff', magenta: '#d6a8ff', cyan: '#5ff0ff', white: '#ffffff',
        brightBlack: '#a0a0a0', brightRed: '#ff9a9a', brightGreen: '#8affdf', brightYellow: '#ffe58a', brightBlue: '#a6d4ff', brightMagenta: '#e8ccff', brightCyan: '#a0f8ff', brightWhite: '#ffffff' },
      syn: { comment: '#a0a0a0', string: '#8affdf' }
    }
  };
  const AUTO = { dark: 'doux', light: 'sepia' };

  function resolve(id) {
    if (!id || id === 'auto') return (window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches) ? AUTO.light : AUTO.dark;
    return T[id] ? id : 'kstermus';
  }

  function cssVars(t) {
    const u = t.ui, k = t.term;
    return {
      '--bg': u.bg, '--bg-2': u.bg2, '--bg-3': u.bg3, '--bg-4': u.bg4, '--line': u.line, '--text': u.text, '--muted': u.muted,
      '--accent': u.accent, '--accent-ink': u.accentInk, '--danger': u.danger, '--warn': u.warn, '--info': u.info, '--purple': u.purple,
      '--term-bg': k.background,
      '--syn-comment': t.syn.comment, '--syn-keyword': k.magenta, '--syn-string': t.syn.string, '--syn-number': k.yellow,
      '--syn-type': k.cyan, '--syn-def': k.blue, '--syn-tag': k.red
    };
  }

  // Luminance relative / contraste WCAG (utilisé par l'aperçu et les tests).
  function lum(hex) {
    const c = hex.replace('#', '').slice(0, 6).match(/../g).map(x => parseInt(x, 16) / 255).map(v => v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  }
  function contrast(a, b) { const [x, y] = [lum(a), lum(b)].sort((m, n) => n - m); return (x + 0.05) / (y + 0.05); }

  const api = { themes: T, auto: AUTO, resolve, cssVars, contrast };
  if (typeof module !== 'undefined') module.exports = api; else window.KST_THEMES = api;
})();

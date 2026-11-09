/* plan-review code blocks: syntax highlighting and line numbers for <pre><code>.
 * Used live by review.js (each line becomes commentable) and baked into exported copies.
 * Language: class "language-X" (or "lang-X") on <code> or <pre>. No class means TypeScript; a language this file
 * doesn't know (e.g. "language-plain", "language-http") stays plain text. data-start="N" numbers lines from N.
 * Everything it adds besides the code's own text has the class `prt-ui`, so text matching ignores it. */
(function () {
  'use strict';

  var DEFAULT_LANG = 'ts';
  var JS_KEYWORDS =
    'abstract as async await break case catch class const continue debugger declare default delete do else enum ' +
    'export extends finally for from function get if implements import in infer instanceof interface is keyof let ' +
    'namespace new of private protected public readonly return satisfies set static super switch this throw try ' +
    'type typeof var void while with yield';
  var LANGS = {
    ts: { name: 'TypeScript', keywords: JS_KEYWORDS, literals: 'true false null undefined NaN Infinity',
      lineComment: '//', blockComment: true, quotes: '\'"`', types: true },
    js: { name: 'JavaScript', keywords: JS_KEYWORDS, literals: 'true false null undefined NaN Infinity',
      lineComment: '//', blockComment: true, quotes: '\'"`', types: true },
    json: { name: 'JSON', keywords: '', literals: 'true false null', quotes: '"', keys: true },
    sh: { name: 'Shell', keywords: 'if then else elif fi for in do done while until case esac function return ' +
      'export local readonly set unset source', literals: '', lineComment: '#', quotes: '\'"' },
    py: { name: 'Python', keywords: 'and as assert async await break class continue def del elif else except ' +
      'finally for from global if import in is lambda nonlocal not or pass raise return try while with yield',
      literals: 'True False None', lineComment: '#', quotes: '\'"', types: true },
  };
  var ALIASES = { typescript: 'ts', tsx: 'ts', javascript: 'js', jsx: 'js', mjs: 'js', bash: 'sh', shell: 'sh',
    zsh: 'sh', console: 'sh', python: 'py' };

  function words(list) {
    var set = {};
    list.split(/\s+/).forEach(function (w) { if (w) set[w] = true; });
    return set;
  }

  function escapeRe(s) {
    return s.replace(/[.*+?^${}()|[\]\\\/]/g, '\\$&');
  }

  // One regex per language: comments, strings, numbers and words, in that order of priority.
  function compile(lang) {
    if (lang.re) return lang;
    var parts = [];
    if (lang.blockComment) parts.push('\\/\\*[\\s\\S]*?(?:\\*\\/|$)');
    if (lang.lineComment) parts.push(escapeRe(lang.lineComment) + '[^\\n]*');
    var comment = parts.length ? '(' + parts.join('|') + ')' : '($^)';
    var strings = lang.quotes.split('').map(function (q) {
      var e = escapeRe(q);
      // Template literals may span lines; other strings end at the line.
      return q === '`' ? '`(?:\\\\[\\s\\S]|[^\\\\`])*`?' : e + '(?:\\\\.|[^\\\\\\n' + e + '])*' + e + '?';
    });
    lang.re = new RegExp(
      comment +
      '|(' + strings.join('|') + ')' +
      '|(\\b(?:0[xX][\\da-fA-F_]+|\\d[\\d_]*(?:\\.\\d+)?(?:[eE][+-]?\\d+)?n?)\\b)' +
      '|([A-Za-z_$][\\w$]*)',
      'g'
    );
    lang.kw = words(lang.keywords);
    lang.lit = words(lang.literals);
    return lang;
  }

  function tokenize(text, lang) {
    lang = compile(lang);
    var tokens = [];
    var last = 0;
    var m;
    lang.re.lastIndex = 0;
    while ((m = lang.re.exec(text))) {
      if (m.index > last) tokens.push({ t: null, s: text.slice(last, m.index) });
      var s = m[0];
      var after = text.slice(m.index + s.length).match(/^\s*(.)/);
      var next = after ? after[1] : '';
      var t = null;
      if (m[1]) t = 'com';
      else if (m[2]) t = lang.keys && next === ':' ? 'key' : 'str';
      else if (m[3]) t = 'num';
      else if (lang.kw[s]) t = 'kw';
      else if (lang.lit[s]) t = 'lit';
      else if (next === '(') t = 'fn';
      else if (lang.types && /^[A-Z]/.test(s)) t = 'type';
      tokens.push({ t: t, s: s });
      last = m.index + s.length;
      if (!s.length) lang.re.lastIndex++; // never loop on an empty match
    }
    if (last < text.length) tokens.push({ t: null, s: text.slice(last) });
    return tokens;
  }

  // Split tokens at newlines, so a multi-line comment or string keeps its colour on every line.
  function toLines(tokens) {
    var lines = [[]];
    tokens.forEach(function (tok) {
      tok.s.split('\n').forEach(function (piece, i) {
        if (i > 0) lines.push([]);
        if (piece) lines[lines.length - 1].push({ t: tok.t, s: piece });
      });
    });
    if (lines.length > 1 && !lines[lines.length - 1].length) lines.pop(); // trailing newline
    return lines;
  }

  function languageOf(pre, code) {
    var classes = (code.className + ' ' + pre.className).split(/\s+/);
    for (var i = 0; i < classes.length; i++) {
      var m = classes[i].match(/^(?:language|lang)-(.+)$/);
      if (m) {
        var key = ALIASES[m[1].toLowerCase()] || m[1].toLowerCase();
        return LANGS[key] ? key : null;
      }
    }
    return DEFAULT_LANG;
  }

  function el(tag, cls, text) {
    var node = document.createElement(tag);
    node.className = cls;
    if (text != null) node.textContent = text;
    return node;
  }

  function enhance(pre, number) {
    var code = pre.querySelector(':scope > code') || pre;
    var key = languageOf(pre, code);
    var text = code.textContent;
    var lines = toLines(key ? tokenize(text, LANGS[key]) : [{ t: null, s: text }]);
    // data-start="33" numbers lines from 33, e.g. for a snippet taken from the middle of a file.
    var start = parseInt(pre.getAttribute('data-start') || code.getAttribute('data-start'), 10) || 1;

    code.textContent = '';
    lines.forEach(function (line, i) {
      var row = el('span', 'pr-code-line');
      row.setAttribute('data-line', String(start + i));
      row.appendChild(el('span', 'prt-ui pr-code-ln', String(start + i)));
      var src = el('span', 'pr-code-src');
      line.forEach(function (tok) {
        src.appendChild(tok.t ? el('span', 'pr-tok-' + tok.t, tok.s) : document.createTextNode(tok.s));
      });
      // Keep the newline, so the block's text, copy and paste, and text matching stay as they were.
      src.appendChild(document.createTextNode('\n'));
      row.appendChild(src);
      code.appendChild(row);
    });

    pre.classList.add('pr-code');
    pre.setAttribute('data-pr-code', String(number));
    pre.style.setProperty('--pr-ln-width', String(start + lines.length - 1).length + 'ch');
    var label = el('span', 'prt-ui pr-code-lang', key ? LANGS[key].name : 'Text');
    label.title = 'Code block ' + number;
    pre.appendChild(label);
  }

  window.PlanReviewCode = {
    LANGS: LANGS,
    tokenize: tokenize,
    init: function () {
      var number = 0;
      document.querySelectorAll('pre').forEach(function (pre) {
        if (pre.closest('#pr-root') || pre.hasAttribute('data-pr-code')) return;
        enhance(pre, ++number);
      });
    },
  };
})();

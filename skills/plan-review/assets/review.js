/* plan-review browser UI. Injected by plan_review.py; everything lives under #pr-root. */
(function () {
  'use strict';

  var BLOCK_SELECTOR =
    'h1,h2,h3,h4,h5,h6,p,li,tr,pre,.pr-code-line,blockquote,dt,dd,figure,.callout,[data-review-block]';
  var POLL_MS = 2500;
  var SAVE_DEBOUNCE_MS = 600;
  var SNIPPET_LEN = 300;

  var state = { feedback: null, docMtime: null, docPath: '' };
  var drafts = {}; // id -> {anchor, text}: local comments not yet accepted by the server
  var saveTimers = {};
  var replyDrafts = {}; // comment id -> the reviewer's follow-up text, while it's being saved
  var replyTimers = {};
  var inFlight = 0;
  var offline = false;
  var blocks = []; // {el, key, section, tag}
  var hoverBlock = null;
  var hoverHideTimer = null;
  var expandedResolved = readExpanded();
  var searchQuery = '';
  var queueKey = 'plan-review-queue:' + location.host;

  // ------------------------------------------------------------------ helpers

  function h(tag, attrs, children) {
    var el = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (k) {
      if (k === 'text') el.textContent = attrs[k];
      else if (k === 'class') el.className = attrs[k];
      else if (k.indexOf('on') === 0) el.addEventListener(k.slice(2), attrs[k]);
      else el.setAttribute(k, attrs[k]);
    });
    (children || []).forEach(function (c) {
      if (c) el.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    });
    return el;
  }

  function norm(text) {
    return (text || '').replace(/\s+/g, ' ').trim();
  }

  function readExpanded() {
    try {
      return JSON.parse(sessionStorage.getItem('plan-review-expanded') || '{}');
    } catch (e) {
      return {};
    }
  }

  function newId() {
    return 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  }

  function fmtTime(iso) {
    if (!iso) return '';
    var d = new Date(iso);
    return d.toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  }

  function inReviewUi(el) {
    return !!(el && el.closest && el.closest('#pr-root, .prt-popover'));
  }

  function blockText(el) {
    if (!el.querySelector('.prt-ui')) return norm(el.textContent);
    var clone = el.cloneNode(true);
    clone.querySelectorAll('.prt-ui').forEach(function (n) { n.remove(); });
    return norm(clone.textContent);
  }

  // ------------------------------------------------------------------ document blocks

  function indexBlocks() {
    var h2 = '';
    var h3 = '';
    blocks = [];
    document.querySelectorAll('h1,h2,h3,' + BLOCK_SELECTOR).forEach(function (el) {
      if (inReviewUi(el)) return;
      var text = blockText(el);
      if (el.tagName === 'H1' || el.tagName === 'H2') {
        h2 = text;
        h3 = '';
      } else if (el.tagName === 'H3') {
        h3 = text;
      }
      if (!el.matches(BLOCK_SELECTOR) || !text) return;
      var isHeading = /^H[1-3]$/.test(el.tagName);
      var code = codeInfo(el);
      blocks.push({
        el: el,
        key: text.slice(0, SNIPPET_LEN),
        tag: code ? (code.line ? 'LINE' : 'PRE') : el.tagName,
        code: code,
        section: isHeading
          ? el.tagName === 'H3' ? h2 : ''
          : [h2, h3].filter(Boolean).join(' › '),
      });
    });
  }

  // Code blocks (see code.js): {block} for a whole block, {block, line} for one line, null otherwise.
  function codeInfo(el) {
    if (el.classList.contains('pr-code-line')) {
      return { block: Number(el.closest('pre').getAttribute('data-pr-code')), line: Number(el.getAttribute('data-line')) };
    }
    if (el.hasAttribute('data-pr-code')) return { block: Number(el.getAttribute('data-pr-code')) };
    return null;
  }

  function codeLabel(code) {
    if (!code) return '';
    return 'Code block ' + code.block + (code.line ? ', line ' + code.line : '');
  }

  function blockFor(el) {
    for (var i = 0; i < blocks.length; i++) if (blocks[i].el === el) return blocks[i];
    return null;
  }

  function findBlock(anchor) {
    if (!anchor || anchor.type !== 'block') return null;
    // Same text first; then prefer the same section, and for code the same block and line (lines like "}" repeat).
    var best = null;
    var bestScore = -1;
    blocks.forEach(function (b) {
      if (b.key !== anchor.text) return;
      var score = b.section === anchor.section ? 1 : 0;
      if (anchor.code && b.code) {
        if (b.code.block === anchor.code.block) score += 2;
        if (b.code.line === anchor.code.line) score += 1;
      }
      if (score > bestScore) {
        best = b;
        bestScore = score;
      }
    });
    return best;
  }

  function anchorFor(block) {
    var anchor = { type: 'block', section: block.section, text: block.key, tag: block.tag };
    var taskId = tasksApi() && tasksApi().taskIdFor(block.el);
    if (taskId) anchor.taskId = taskId;
    if (block.code) anchor.code = Object.assign({}, block.code);
    return anchor;
  }

  function tasksApi() {
    return window.PlanReviewTasks && window.PlanReviewTasks.hasTasks() ? window.PlanReviewTasks : null;
  }

  // ------------------------------------------------------------------ server sync

  function readQueue() {
    try {
      return JSON.parse(localStorage.getItem(queueKey) || '[]');
    } catch (e) {
      return [];
    }
  }

  function writeQueue(q) {
    localStorage.setItem(queueKey, JSON.stringify(q));
  }

  function enqueue(op) {
    var q = readQueue();
    // Collapse repeated upserts of the same comment into the latest one.
    if (op.op === 'upsert' || op.op === 'reply-draft') {
      q = q.filter(function (o) { return !(o.op === op.op && o.id === op.id); });
    }
    q.push(op);
    writeQueue(q);
    flush();
  }

  function flush() {
    var q = readQueue();
    if (!q.length || inFlight) return;
    inFlight++;
    renderStatus();
    fetch('/__review/op', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(q[0]),
    })
      .then(function (res) {
        return res.json().then(function (body) { return { ok: res.ok, body: body }; });
      })
      .then(function (r) {
        offline = false;
        var rest = readQueue();
        var sent = rest.shift();
        writeQueue(rest);
        if (r.ok) {
          // Keep the local draft if the user kept typing while this save was in flight.
          if (sent && sent.op === 'upsert' && drafts[sent.id] && drafts[sent.id].text === sent.text) {
            delete drafts[sent.id];
            delete saveTimers[sent.id];
          }
          if (sent && sent.op === 'reply-draft' && replyDrafts[sent.id] === sent.text) {
            delete replyDrafts[sent.id];
            delete replyTimers[sent.id];
          }
          applyState(r.body);
        } else {
          console.warn('plan-review: op rejected', sent, r.body);
        }
      })
      .catch(function () {
        offline = true;
      })
      .then(function () {
        inFlight--;
        renderStatus();
        if (!offline && readQueue().length) flush();
      });
  }

  function poll() {
    fetch('/__review/state', { cache: 'no-store' })
      .then(function (res) { return res.json(); })
      .then(function (body) {
        offline = false;
        applyState(body);
        flush();
      })
      .catch(function () {
        offline = true;
        renderStatus();
      });
  }

  function applyState(body) {
    if (state.docMtime !== null && body.docMtime !== state.docMtime) return onDocChanged();
    var firstLoad = !state.feedback;
    var changed = firstLoad || body.feedback.revision !== state.feedback.revision;
    state.docMtime = body.docMtime;
    state.docPath = body.docPath;
    state.feedback = body.feedback;
    if (firstLoad) removeEmptyDrafts();
    if (changed && tasksApi()) tasksApi().update(body.feedback.tasks);
    if (changed) render();
    else renderStatus();
    if (changed && hoverBlock) positionHover(); // e.g. Implement → Requested while still hovering
  }

  function onDocChanged() {
    var busy = readQueue().length || document.activeElement && document.activeElement.tagName === 'TEXTAREA';
    if (!busy) return reloadKeepingPlace();
    ui.banner.hidden = false;
  }

  function reloadKeepingPlace() {
    sessionStorage.setItem('plan-review-scroll', String(window.scrollY));
    sessionStorage.setItem('plan-review-open', document.body.classList.contains('pr-open') ? '1' : '');
    location.reload();
  }

  // ------------------------------------------------------------------ comment model

  function allComments() {
    var server = (state.feedback && state.feedback.comments) || [];
    var ids = {};
    var list = server.map(function (c) {
      ids[c.id] = true;
      // Show the local text while an edit is still being saved.
      var local = {};
      if (drafts[c.id]) local.text = drafts[c.id].text;
      if (c.id in replyDrafts) local.pendingReply = replyDrafts[c.id];
      return Object.keys(local).length ? Object.assign({}, c, local) : c;
    });
    Object.keys(drafts).forEach(function (id) {
      if (!ids[id]) list.push({ id: id, anchor: drafts[id].anchor, text: drafts[id].text, status: 'new', replies: [] });
    });
    return list;
  }

  function editText(id, anchor, text) {
    drafts[id] = { anchor: anchor, text: text };
    clearTimeout(saveTimers[id]);
    saveTimers[id] = setTimeout(function () {
      enqueue({ op: 'upsert', id: id, anchor: anchor, text: text });
    }, SAVE_DEBOUNCE_MS);
    renderStatus();
  }

  function editReply(id, text) {
    replyDrafts[id] = text;
    clearTimeout(replyTimers[id]);
    replyTimers[id] = setTimeout(function () {
      enqueue({ op: 'reply-draft', id: id, text: text });
    }, SAVE_DEBOUNCE_MS);
    renderStatus();
  }

  function hasPendingReply(c) {
    return !!(c.pendingReply && c.pendingReply.trim());
  }

  function addComment(anchor) {
    var id = newId();
    drafts[id] = { anchor: anchor, text: '' };
    openPanel();
    render();
    var card = ui.list.querySelector('[data-id="' + id + '"] textarea');
    if (card) {
      card.scrollIntoView({ block: 'center', behavior: 'smooth' });
      card.focus();
    }
  }

  // A comment left empty is removed: an unsaved one locally, a saved one (with no replies yet) on the server too.
  // Otherwise it would linger as an empty draft that can never be sent.
  function discardIfEmpty(id) {
    var c = allComments().filter(function (x) { return x.id === id; })[0];
    if (!c || c.text.trim() || c.replies.length) return;
    // Re-rendering can blur a box and then focus it again; never discard the one being typed in.
    var active = document.activeElement;
    if (active && active.closest && active.closest('[data-id="' + id + '"]')) return;
    if (c.status === 'new') {
      clearTimeout(saveTimers[id]);
      delete drafts[id];
      render();
    } else {
      removeComment(c);
    }
  }

  // Clean up empty drafts left by older versions (or another tab), once, when the page loads.
  function removeEmptyDrafts() {
    state.feedback.comments.forEach(function (c) {
      if (c.status === 'draft' && !c.text.trim() && !c.replies.length && !drafts[c.id]) removeComment(c);
    });
  }

  // Sent immediately, as its own submission: an Implement click is an approval, not a draft.
  function requestImplement(taskId, note) {
    var el = document.querySelector('[data-task="' + CSS.escape(taskId) + '"]');
    var block = el && (blockFor(el) || blockFor(el.querySelector('h1,h2,h3,h4,h5,h6')));
    var anchor = block ? anchorFor(block) : { type: 'general' };
    anchor.taskId = taskId;
    enqueue({ op: 'implement', id: newId(), anchor: anchor, text: note });
  }

  function removeComment(c) {
    if (c.replies.length && !confirm('Delete this comment and its replies?')) return;
    clearTimeout(saveTimers[c.id]);
    delete drafts[c.id];
    enqueue({ op: 'delete', id: c.id });
    if (state.feedback) state.feedback.comments = state.feedback.comments.filter(function (x) { return x.id !== c.id; });
    render();
  }

  // ------------------------------------------------------------------ UI shell

  var ui = {};

  function buildUi() {
    ui.hoverBtn = h('button', { id: 'pr-hover', type: 'button', title: 'Comment on this', text: '💬' });
    ui.hoverBtn.addEventListener('mousedown', function (e) { e.preventDefault(); });
    ui.hoverBtn.addEventListener('click', function () {
      if (hoverBlock) addComment(anchorFor(hoverBlock));
    });
    // Shown next to 💬 when the hovered block is a task (or a step's heading) that can still be implemented.
    ui.implementBtn = h('button', { id: 'pr-hover-implement', type: 'button' });
    ui.implementBtn.addEventListener('mousedown', function (e) { e.preventDefault(); });
    ui.implementBtn.addEventListener('click', function (e) {
      e.stopPropagation(); // the task popover closes on any click that reaches the document
      var info = hoverBlock && tasksApi() && tasksApi().implementFor(hoverBlock.el);
      if (info && !info.requested) tasksApi().openImplement(info.taskId, ui.implementBtn);
    });

    ui.toggle = h('button', { id: 'pr-toggle', type: 'button', onclick: togglePanel }, [
      '💬 Review',
      (ui.toggleCount = h('span', { class: 'pr-badge' })),
    ]);

    ui.banner = h('div', { class: 'pr-banner' }, [
      'The document was updated. ',
      h('button', { type: 'button', text: 'Reload', onclick: reloadKeepingPlace }),
    ]);
    ui.banner.hidden = true;

    ui.status = h('div', { class: 'pr-status' });
    ui.search = h('input', { type: 'search', class: 'pr-search', placeholder: 'Search messages…', 'aria-label': 'Search messages' });
    ui.search.addEventListener('input', function () {
      searchQuery = ui.search.value;
      render();
    });
    ui.search.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') setSearch('');
    });
    ui.list = h('div', { class: 'pr-list' });
    ui.send = h('button', {
      type: 'button',
      class: 'pr-send',
      onclick: function () {
        flushAllEdits();
        enqueue({ op: 'submit' });
      },
    });
    ui.hint = h('div', { class: 'pr-hint' });

    ui.panel = h('aside', { id: 'pr-panel' }, [
      h('div', { class: 'pr-head' }, [
        h('strong', { text: 'Review' }),
        h('button', { type: 'button', class: 'pr-close', title: 'Close', text: '×', onclick: togglePanel }),
      ]),
      ui.status,
      ui.banner,
      ui.search,
      h('button', {
        type: 'button',
        class: 'pr-add-general',
        text: '+ New message',
        onclick: function () { addComment({ type: 'general' }); },
      }),
      ui.list,
      h('div', { class: 'pr-foot' }, [ui.send, ui.hint]),
    ]);

    var root = h('div', { id: 'pr-root' }, [ui.hoverBtn, ui.implementBtn, ui.toggle, ui.panel]);
    document.body.appendChild(root);

    document.addEventListener('mouseover', onHover);
    window.addEventListener('scroll', positionHover, { passive: true });
    window.addEventListener('resize', positionHover);
  }

  function flushAllEdits() {
    Object.keys(saveTimers).forEach(function (id) {
      if (!drafts[id]) return;
      clearTimeout(saveTimers[id]);
      enqueue({ op: 'upsert', id: id, anchor: drafts[id].anchor, text: drafts[id].text });
    });
    Object.keys(replyTimers).forEach(function (id) {
      if (!(id in replyDrafts)) return;
      clearTimeout(replyTimers[id]);
      enqueue({ op: 'reply-draft', id: id, text: replyDrafts[id] });
    });
  }

  function openPanel() {
    document.body.classList.add('pr-open');
  }

  function togglePanel() {
    document.body.classList.toggle('pr-open');
    positionHover();
  }

  function onHover(e) {
    if (inReviewUi(e.target)) {
      if (e.target === ui.hoverBtn || e.target === ui.implementBtn) clearTimeout(hoverHideTimer);
      return;
    }
    var el = e.target.closest && e.target.closest(BLOCK_SELECTOR);
    // A code block is targeted as a whole only from its language label. Elsewhere (its padding, say) it keeps the
    // hovered line, so moving toward a line's 💬 never switches the hover to the whole block.
    if (el && el.classList.contains('pr-code') && !e.target.closest('.pr-code-lang')) {
      clearTimeout(hoverHideTimer);
      if (hoverBlock && el.contains(hoverBlock.el)) return;
      el = null;
    }
    var block = el && blockFor(el);
    clearTimeout(hoverHideTimer);
    if (!block) {
      // Give the pointer time to travel from the block to the 💬 button.
      hoverHideTimer = setTimeout(function () { setHover(null); }, 400);
      return;
    }
    setHover(block);
  }

  function setHover(block) {
    if (block === hoverBlock) return;
    if (hoverBlock) hoverBlock.el.classList.remove('pr-hovered');
    hoverBlock = block;
    if (hoverBlock) hoverBlock.el.classList.add('pr-hovered');
    positionHover();
  }

  function positionHover() {
    if (!hoverBlock) {
      ui.hoverBtn.style.display = 'none';
      ui.implementBtn.style.display = 'none';
      return;
    }
    var info = tasksApi() && tasksApi().implementFor(hoverBlock.el);
    ui.implementBtn.style.display = info ? 'block' : 'none';
    if (info) {
      ui.implementBtn.textContent = info.requested ? '⏳ Requested' : info.label;
      ui.implementBtn.title = info.requested ? 'Sent to Claude' : 'Approve this and have Claude carry it out';
      ui.implementBtn.classList.toggle('pr-requested', info.requested);
    }
    var codeLine = !!(hoverBlock.code && hoverBlock.code.line);
    ui.hoverBtn.classList.toggle('pr-hover-line', codeLine);
    ui.hoverBtn.style.display = 'block'; // visible before measuring
    var r = hoverBlock.el.getBoundingClientRect();
    var top = window.scrollY + r.top + 'px';
    var width = ui.hoverBtn.offsetWidth + (info ? 4 + ui.implementBtn.offsetWidth : 0);
    var panelWidth = document.body.classList.contains('pr-open') ? ui.panel.offsetWidth : 0;
    var maxLeft = document.documentElement.clientWidth - panelWidth - width - 4;
    var left = window.scrollX + Math.min(r.right + 4, maxLeft);
    if (codeLine) {
      // A code line's 💬 sits over its line number, inside the block, so the pointer never has to leave the line.
      var pre = hoverBlock.el.closest('pre').getBoundingClientRect();
      top = window.scrollY + r.top + r.height / 2 - ui.hoverBtn.offsetHeight / 2 + 'px';
      left = window.scrollX + pre.left + 3;
    }
    ui.hoverBtn.style.top = top;
    ui.hoverBtn.style.left = left + 'px';
    ui.implementBtn.style.top = top;
    ui.implementBtn.style.left = left + ui.hoverBtn.offsetWidth + 4 + 'px';
  }

  // ------------------------------------------------------------------ rendering

  var STATUS_LABEL = {
    new: 'Not saved yet',
    draft: 'Draft · not sent',
    submitted: 'Sent · waiting on Claude',
    addressed: 'Claude replied',
    resolved: 'Resolved',
  };

  function render() {
    var comments = allComments();
    var open = comments.filter(function (c) { return c.status !== 'resolved'; });
    var resolved = comments.filter(function (c) { return c.status === 'resolved'; });
    var groups = { general: [], orphan: [] };
    var order = [];

    // Only open conversations highlight their text in the document.
    blocks.forEach(function (b) { b.el.classList.remove('pr-has-comment'); });
    open.forEach(function (c) {
      if (c.anchor.type === 'general') return groups.general.push(c);
      var block = findBlock(c.anchor);
      if (!block) return groups.orphan.push(c);
      block.el.classList.add('pr-has-comment');
      var idx = blocks.indexOf(block);
      if (!groups[idx]) {
        groups[idx] = [];
        order.push(idx);
      }
      groups[idx].push(c);
    });
    order.sort(function (a, b) { return a - b; });

    var focused = document.activeElement;
    var focusedId = focused && focused.closest && focused.closest('.pr-card') && focused.closest('.pr-card').dataset.id;
    var selection = focusedId ? [focused.selectionStart, focused.selectionEnd] : null;

    var scrollTop = ui.list.scrollTop;
    ui.list.textContent = '';
    if (searchQuery.trim()) {
      ui.list.appendChild(renderSearch());
      renderStatus();
      return;
    }
    if (groups.general.length) ui.list.appendChild(renderGroup('Messages', null, groups.general));
    order.forEach(function (idx) {
      var b = blocks[idx];
      var title = [b.section || 'Top of document', codeLabel(b.code)].filter(Boolean).join(' › ');
      ui.list.appendChild(renderGroup(title, b, groups[idx]));
    });
    if (groups.orphan.length) {
      ui.list.appendChild(renderGroup('On text that has since changed', null, groups.orphan, true));
    }
    if (resolved.length) ui.list.appendChild(renderResolved(resolved));
    if (!comments.length) {
      ui.list.appendChild(
        h('p', { class: 'pr-empty', text: 'Hover over any heading, paragraph, bullet or table row and click 💬 to comment on it.' })
      );
    }

    ui.list.scrollTop = scrollTop;
    if (focusedId) {
      var ta = ui.list.querySelector('[data-id="' + focusedId + '"] textarea');
      if (ta) {
        ta.focus();
        ta.setSelectionRange(selection[0], selection[1]);
      }
    }
    renderStatus();
  }

  function renderGroup(title, block, comments, orphan) {
    var head = h('div', { class: 'pr-group-head' }, [h('div', { class: 'pr-group-section', text: title })]);
    if (block) {
      head.appendChild(h('div', { class: 'pr-quote', text: block.key, title: 'Show in document' }));
      head.addEventListener('click', function () { flash(block.el); });
      head.classList.add('pr-clickable');
    }
    var group = h('div', { class: 'pr-group' + (orphan ? ' pr-orphan' : '') }, [head]);
    comments.forEach(function (c) { group.appendChild(renderCard(c, orphan)); });
    return group;
  }

  function lastActivity(c) {
    return c.replies.reduce(function (latest, r) { return r.at > latest ? r.at : latest; }, c.updatedAt || '');
  }

  function whereLabel(c) {
    if (c.anchor.type === 'general') return 'Message';
    if (c.anchor.code && c.anchor.code.line) return 'Line ' + c.anchor.code.line;
    var parts = (c.anchor.section || '').split(' › ');
    return parts[parts.length - 1] || 'Top of document';
  }

  function toggleResolved(c) {
    var expanding = !expandedResolved[c.id];
    if (expanding) expandedResolved[c.id] = true;
    else delete expandedResolved[c.id];
    sessionStorage.setItem('plan-review-expanded', JSON.stringify(expandedResolved));
    render();
    if (expanding) showInDocument(c);
  }

  // Scroll the document to the text a comment is attached to (if it still exists).
  function showInDocument(c) {
    var block = findBlock(c.anchor);
    if (block) flash(block.el);
  }

  // Resolved comments: one line each, click to expand the full card.
  function renderResolved(list) {
    var section = h('div', { class: 'pr-resolved' }, [
      h('div', { class: 'pr-resolved-head', text: 'Resolved · ' + list.length }),
    ]);
    list
      .slice()
      .sort(function (a, b) { return lastActivity(b) > lastActivity(a) ? 1 : -1; })
      .forEach(function (c) {
        var expanded = !!expandedResolved[c.id];
        var row = h(
          'button',
          {
            type: 'button',
            class: 'pr-resolved-row' + (expanded ? ' pr-expanded' : ''),
            title: expanded ? 'Collapse' : c.text,
            'aria-expanded': String(expanded),
            onclick: function () { toggleResolved(c); },
          },
          [
            h('span', { class: 'pr-chevron', text: expanded ? '▾' : '▸' }),
            h('span', { class: 'pr-resolved-where', text: whereLabel(c) }),
            h('span', { class: 'pr-resolved-text', text: c.text.split('\n')[0] }),
          ]
        );
        var item = h('div', { class: 'pr-resolved-item', 'data-id': c.id }, [row]);
        if (expanded) item.appendChild(renderCard(c, true));
        section.appendChild(item);
      });
    return section;
  }

  function renderCard(c, orphan) {
    // Before Claude replies, the comment itself stays editable. After that it's a thread: the comment and the
    // replies are read-only messages, and follow-ups go in the Reply box (sent with Send to Claude).
    var thread = c.replies.length > 0;
    var input;
    if (!thread) {
      input = h('textarea', { rows: '2', placeholder: 'Write a comment… (Return sends, Shift+Return for a new line)' });
      input.value = c.text;
      input.addEventListener('input', function () {
        autosize(input);
        editText(c.id, c.anchor, input.value);
      });
      input.addEventListener('blur', function () { setTimeout(function () { discardIfEmpty(c.id); }, 150); });
    } else if (c.status !== 'resolved') {
      input = h('textarea', { rows: '1', class: 'pr-reply-input', placeholder: 'Reply…' });
      input.value = c.pendingReply || '';
      input.addEventListener('input', function () {
        autosize(input);
        editReply(c.id, input.value);
      });
    }
    if (input) {
      sendOnEnter(input);
      setTimeout(function () { autosize(input); });
    }

    var status = STATUS_LABEL[c.status] || c.status;
    var chipClass = c.status;
    if (c.status === 'draft' && thread) status = 'Edited · not sent';
    if (c.status === 'addressed' && !thread) status = 'Seen by Claude';
    if (hasPendingReply(c)) {
      status = 'Reply · not sent';
      chipClass = 'draft';
    }
    var actions = h('div', { class: 'pr-actions' }, [
      h('span', { class: 'pr-chip pr-chip-' + chipClass, text: status }),
      h('span', { class: 'pr-spacer' }),
    ]);
    if (c.status === 'addressed') {
      actions.appendChild(
        h('button', { type: 'button', text: 'Resolve', onclick: function () { enqueue({ op: 'resolve', id: c.id }); } })
      );
    }
    if (c.status === 'resolved') {
      actions.appendChild(
        h('button', { type: 'button', text: 'Reopen', onclick: function () { enqueue({ op: 'reopen', id: c.id }); } })
      );
    }
    if (c.status !== 'new') {
      actions.appendChild(h('button', { type: 'button', text: 'Delete', onclick: function () { removeComment(c); } }));
    }

    var card = h('div', { class: 'pr-card pr-status-' + c.status, 'data-id': c.id }, []);
    if (findBlock(c.anchor)) {
      card.classList.add('pr-linked');
      card.title = 'Click to show in document';
      card.addEventListener('click', function (e) {
        if (e.target.closest('button, textarea')) return;
        showInDocument(c);
      });
    }
    if (orphan && c.anchor.text) card.appendChild(h('div', { class: 'pr-quote', text: c.anchor.text }));
    if (c.kind === 'implement') card.appendChild(h('div', { class: 'pr-kind', text: '▶ Implement · ' + c.anchor.taskId }));
    if (thread) {
      card.appendChild(message('reviewer', c.text, c.createdAt, 'c'));
      c.replies.forEach(function (r, i) { card.appendChild(message(r.author, r.text, r.at, String(i))); });
    }
    if (input) card.appendChild(input);
    card.appendChild(actions);
    return card;
  }

  // ------------------------------------------------------------------ search

  function setSearch(value) {
    searchQuery = value;
    ui.search.value = value;
    render();
  }

  // Every message (the comment itself and each reply) in open and resolved threads that contains the query.
  function searchHits(query) {
    var q = query.trim().toLowerCase();
    var hits = [];
    allComments().forEach(function (c) {
      var messages = [{ key: 'c', author: 'reviewer', text: c.text, at: c.createdAt }].concat(
        c.replies.map(function (r, i) { return { key: String(i), author: r.author, text: r.text, at: r.at }; })
      );
      messages.forEach(function (m) {
        var index = (m.text || '').toLowerCase().indexOf(q);
        if (index !== -1) hits.push({ c: c, m: m, index: index, length: q.length });
      });
    });
    return hits.sort(function (a, b) { return (b.m.at || '') > (a.m.at || '') ? 1 : -1; }); // newest first
  }

  function snippet(text, index, length) {
    var start = Math.max(0, index - 40);
    var end = Math.min(text.length, index + length + 90);
    var flat = function (t) { return t.replace(/\s+/g, ' '); };
    return h('span', { class: 'pr-hit-text' }, [
      (start > 0 ? '…' : '') + flat(text.slice(start, index)),
      h('mark', { text: text.slice(index, index + length) }),
      flat(text.slice(index + length, end)) + (end < text.length ? '…' : ''),
    ]);
  }

  function renderSearch() {
    var hits = searchHits(searchQuery);
    var head = hits.length ? hits.length + ' message' + (hits.length === 1 ? '' : 's') : 'No messages match';
    var section = h('div', { class: 'pr-search-results' }, [h('div', { class: 'pr-resolved-head', text: head })]);
    hits.forEach(function (hit) {
      var who = hit.m.author === 'claude' ? 'Claude' : 'You';
      var meta = [whereLabel(hit.c), who, hit.m.at ? fmtTime(hit.m.at) : '', hit.c.status === 'resolved' ? 'Resolved' : '']
        .filter(Boolean).join(' · ');
      section.appendChild(
        h('button', { type: 'button', class: 'pr-hit', onclick: function () { openHit(hit); } }, [
          h('div', { class: 'pr-hit-head', text: meta }),
          snippet(hit.m.text, hit.index, hit.length),
        ])
      );
    });
    return section;
  }

  // Leave search, expand the thread if it's resolved, then show the message in the panel and its text in the plan.
  function openHit(hit) {
    if (hit.c.status === 'resolved' && !expandedResolved[hit.c.id]) {
      expandedResolved[hit.c.id] = true;
      sessionStorage.setItem('plan-review-expanded', JSON.stringify(expandedResolved));
    }
    setSearch('');
    var card = ui.list.querySelector('.pr-card[data-id="' + hit.c.id + '"]');
    if (!card) return;
    var target = card.querySelector('[data-msg="' + hit.m.key + '"]') || card;
    target.scrollIntoView({ block: 'center' }); // not smooth: the document scrolls smoothly at the same time
    target.classList.remove('pr-flash');
    void target.offsetWidth;
    target.classList.add('pr-flash');
    showInDocument(hit.c);
  }

  function message(author, text, at, key) {
    var claude = author === 'claude';
    return h('div', { class: 'pr-reply' + (claude ? '' : ' pr-reply-you'), 'data-msg': key }, [
      h('div', { class: 'pr-reply-head', text: (claude ? 'Claude' : 'You') + (at ? ' · ' + fmtTime(at) : '') }),
      h('div', { class: 'pr-reply-text', text: text }),
    ]);
  }


  // Return sends (like Send to Claude); Shift+Return adds a line break. Not while an IME is composing.
  function sendOnEnter(ta) {
    ta.addEventListener('keydown', function (e) {
      if (e.key !== 'Enter' || e.shiftKey || e.isComposing) return;
      e.preventDefault();
      if (ta.value.trim() && !ui.send.disabled) ui.send.click();
    });
  }

  function autosize(ta) {
    ta.style.height = 'auto';
    ta.style.height = ta.scrollHeight + 2 + 'px';
  }

  function flash(el) {
    el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    el.classList.remove('pr-flash');
    void el.offsetWidth;
    el.classList.add('pr-flash');
  }

  function renderStatus() {
    var comments = allComments();
    var fb = state.feedback;
    var draftCount = comments.filter(function (c) {
      return ((c.status === 'draft' || c.status === 'new') && c.text.trim()) || hasPendingReply(c);
    }).length;
    var waiting = comments.filter(function (c) { return c.status === 'submitted'; }).length;
    var lastReply = '';
    comments.forEach(function (c) {
      c.replies.forEach(function (r) { if (r.author === 'claude' && r.at > lastReply) lastReply = r.at; });
    });

    var saving = Object.keys(saveTimers).some(function (id) { return drafts[id]; }) ||
      Object.keys(replyTimers).some(function (id) { return id in replyDrafts; });
    var parts = [];
    if (offline) parts.push('⚠ Server offline · changes kept in this browser');
    else if (inFlight || readQueue().length || saving)
      parts.push('Saving…');
    else parts.push('All changes saved');
    if (draftCount) parts.push(draftCount + ' not sent');
    if (waiting) parts.push(waiting + ' waiting on Claude');
    if (lastReply) parts.push('last reply ' + fmtTime(lastReply));
    ui.status.textContent = parts.join(' · ');
    ui.status.classList.toggle('pr-offline', offline);

    ui.send.textContent = draftCount ? 'Send to Claude (' + draftCount + ')' : 'Send to Claude';
    ui.send.disabled = !draftCount || offline;

    var active = comments.filter(function (c) { return c.status !== 'resolved' && c.status !== 'new'; }).length;
    ui.toggleCount.textContent = active ? String(active) : '';

    var pendingSubmission = fb && fb.submissions.some(function (s) { return !s.handled; });
    ui.hint.textContent = pendingSubmission
      ? 'Sent. If no Claude session is watching, run /plan-review ' + state.docPath
      : 'To have Claude pick up sent feedback, run /plan-review ' + state.docPath;
  }

  // ------------------------------------------------------------------ boot

  function boot() {
    if (window.PlanReviewCode) window.PlanReviewCode.init(); // before indexing: it turns code lines into blocks
    if (window.PlanReviewTasks) {
      window.PlanReviewTasks.init({
        editable: true,
        onSetStatus: function (id, status, note) {
          enqueue({ op: 'task', id: id, status: status, note: note });
        },
        onImplement: requestImplement,
        isRequested: function (taskId) {
          return allComments().some(function (c) {
            return c.kind === 'implement' && c.status === 'submitted' && c.anchor.taskId === taskId;
          });
        },
      });
    }
    indexBlocks();
    buildUi();
    if (sessionStorage.getItem('plan-review-open') !== '') openPanel();
    var scroll = sessionStorage.getItem('plan-review-scroll');
    if (scroll) {
      window.scrollTo(0, Number(scroll));
      sessionStorage.removeItem('plan-review-scroll');
    }
    render();
    poll();
    setInterval(poll, POLL_MS);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();

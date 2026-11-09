/* plan-review task tracking. Finds [data-task] elements, shows their status and progress.
 * Used live by review.js (editable) and baked into exported copies (read-only).
 * Everything it adds to the page has the class `prt-ui`, so other code can ignore it. */
(function () {
  'use strict';

  var STATUSES = [
    { id: 'todo', label: 'To do' },
    { id: 'in_progress', label: 'In progress' },
    { id: 'review', label: 'In review' },
    { id: 'blocked', label: 'Blocked' },
    { id: 'done', label: 'Done' },
    { id: 'skipped', label: 'Skipped' },
  ];
  var BY_ID = {};
  STATUSES.forEach(function (s) { BY_ID[s.id] = s; });

  var opts = { editable: false, onSetStatus: null, onImplement: null, isRequested: null };
  var tasks = []; // {id, el, parent, children, pill, bar}
  var byTaskId = {};
  var state = {};
  var summaryEl = null;
  var popover = null;

  function h(tag, cls, text) {
    var el = document.createElement(tag);
    el.className = 'prt-ui ' + (cls || '');
    if (text != null) el.textContent = text;
    return el;
  }

  // A small dot in the status's colour (themable via --task-* variables), instead of an emoji.
  function dot(statusId) {
    return h('span', 'prt-dot prt-dot-' + statusId);
  }

  function shorten(text, max) {
    return text.length > max ? text.slice(0, max - 1).trimEnd() + '…' : text;
  }

  function titleOf(task) {
    var el = task.el;
    if (el.dataset.taskTitle) return el.dataset.taskTitle;
    var heading = headingOf(el);
    return plainText(heading || el).slice(0, 120);
  }

  function plainText(el) {
    var clone = el.cloneNode(true);
    clone.querySelectorAll('.prt-ui, [data-task] [data-task], ul, ol').forEach(function (n) {
      if (n !== clone) n.remove();
    });
    return clone.textContent.replace(/\s+/g, ' ').trim();
  }

  function headingOf(el) {
    for (var i = 0; i < el.children.length; i++) {
      if (/^H[1-6]$/.test(el.children[i].tagName)) return el.children[i];
    }
    return null;
  }

  // ------------------------------------------------------------------ model

  function index() {
    tasks = [];
    byTaskId = {};
    document.querySelectorAll('[data-task]').forEach(function (el) {
      if (el.closest('#pr-root')) return;
      var task = { id: el.dataset.task, el: el, children: [], parent: null };
      var up = el.parentElement && el.parentElement.closest('[data-task]');
      if (up && byTaskId[up.dataset.task]) {
        task.parent = byTaskId[up.dataset.task];
        task.parent.children.push(task);
      }
      tasks.push(task);
      byTaskId[task.id] = task;
    });
  }

  function leavesOf(task) {
    if (!task.children.length) return [task];
    return task.children.reduce(function (acc, c) { return acc.concat(leavesOf(c)); }, []);
  }

  function leafStatus(task) {
    return (state[task.id] && state[task.id].status) || 'todo';
  }

  function summarize(leaves) {
    var counts = { todo: 0, in_progress: 0, review: 0, blocked: 0, done: 0, skipped: 0 };
    leaves.forEach(function (t) { counts[leafStatus(t)]++; });
    var total = leaves.length - counts.skipped;
    return { counts: counts, total: total, pct: total ? Math.round((counts.done / total) * 100) : 100 };
  }

  function derivedStatus(sum) {
    var c = sum.counts;
    if (!sum.total) return 'skipped';
    if (c.done === sum.total) return 'done';
    if (c.blocked) return 'blocked';
    if (c.done + c.review === sum.total) return 'review';
    if (c.in_progress || c.review || c.done) return 'in_progress';
    return 'todo';
  }

  // ------------------------------------------------------------------ rendering

  function historyTitle(entry) {
    if (!entry) return '';
    var lines = [];
    if (entry.note) lines.push(entry.note);
    (entry.history || []).slice(-5).reverse().forEach(function (e) {
      var when = new Date(e.at).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
      lines.push((e.by === 'claude' ? 'Claude' : 'You') + ' → ' + BY_ID[e.status].label + ' · ' + when + (e.note ? ' — ' + e.note : ''));
    });
    return lines.join('\n');
  }

  function renderBar(sum) {
    var bar = h('span', 'prt-bar');
    var c = sum.counts;
    ['done', 'review', 'in_progress', 'blocked'].forEach(function (k) {
      if (!c[k] || !sum.total) return;
      var seg = h('span', 'prt-seg prt-seg-' + k);
      seg.style.width = (c[k] / sum.total) * 100 + '%';
      bar.appendChild(seg);
    });
    return bar;
  }

  function breakdown(sum) {
    var c = sum.counts;
    var parts = [c.done + ' of ' + sum.total + ' done (' + sum.pct + '%)'];
    if (c.review) parts.push(c.review + ' in review');
    if (c.in_progress) parts.push(c.in_progress + ' in progress');
    if (c.blocked) parts.push(c.blocked + ' blocked');
    if (c.skipped) parts.push(c.skipped + ' skipped');
    return parts.join(' · ');
  }

  function renderPill(task) {
    var entry = state[task.id];
    var status = BY_ID[leafStatus(task)];
    var label = status.label;
    if (entry && entry.status === 'blocked' && entry.note) label += ': ' + shorten(entry.note, 60);
    var pill = h('span', 'prt-pill prt-' + status.id);
    pill.appendChild(dot(status.id));
    pill.appendChild(document.createTextNode(label));
    pill.title = historyTitle(entry) || status.label;
    if (opts.editable) {
      pill.classList.add('prt-editable');
      pill.setAttribute('role', 'button');
      pill.addEventListener('click', function (e) {
        e.stopPropagation();
        openPopover(task, pill);
      });
    }
    return pill;
  }

  function render() {
    // Only tasks without subtasks get a pill. Progress is shown once, in the summary.
    tasks.forEach(function (task) {
      if (task.ui) task.ui.remove();
      task.ui = task.children.length ? null : renderPill(task);
      if (!task.ui) return;
      var heading = headingOf(task.el);
      if (heading) heading.appendChild(task.ui);
      else if (task.el.tagName === 'TR') task.el.cells[0] && task.el.cells[0].prepend(task.ui);
      else task.el.prepend(task.ui);
    });
    renderSummary();
  }

  // ------------------------------------------------------------------ implement (editable mode)

  // A step approves all of its unfinished subtasks at once.
  function implementLabel(task) {
    return task.children.length ? '▶ Implement all' : '▶ Implement';
  }

  // The task a hovered block can approve: the block is the task itself or its heading. A task with no heading of
  // its own (e.g. a list of open questions) uses the heading right before it.
  function taskForBlock(el) {
    for (var i = 0; i < tasks.length; i++) {
      var t = tasks[i];
      if (el === t.el || el === headingOf(t.el)) return t;
      if (!headingOf(t.el) && /^H[1-6]$/.test(el.tagName) && el.nextElementSibling === t.el) return t;
    }
    return null;
  }

  // What the hover controls should offer for a block: null, or {taskId, label, requested}.
  function implementFor(el) {
    var task = opts.onImplement && taskForBlock(el);
    if (!task) return null;
    var status = task.children.length ? derivedStatus(summarize(leavesOf(task))) : leafStatus(task);
    if (['todo', 'in_progress', 'blocked'].indexOf(status) === -1) return null;
    return { taskId: task.id, label: implementLabel(task), requested: !!(opts.isRequested && opts.isRequested(task.id)) };
  }

  function renderSummary() {
    var roots = tasks.filter(function (t) { return !t.parent; });
    if (!roots.length) return;
    var leaves = roots.reduce(function (acc, t) { return acc.concat(leavesOf(t)); }, []);
    var sum = summarize(leaves);
    var host = document.querySelector('[data-task-summary]');
    // data-task-summary="compact": a small bar and count, e.g. for a nav bar. The full breakdown is the tooltip.
    var compact = !!host && host.getAttribute('data-task-summary') === 'compact';
    if (!summaryEl) {
      summaryEl = h('div', 'prt-summary' + (compact ? ' prt-summary-compact' : ''));
      if (host) host.appendChild(summaryEl);
      else document.body.prepend(summaryEl);
    }
    summaryEl.textContent = '';
    summaryEl.appendChild(h('strong', 'prt-summary-title', 'Progress'));
    summaryEl.appendChild(renderBar(sum));
    summaryEl.appendChild(h('span', 'prt-summary-text', compact ? sum.counts.done + '/' + sum.total + ' · ' + sum.pct + '%' : breakdown(sum)));
    summaryEl.title = compact ? breakdown(sum) : '';
  }

  // ------------------------------------------------------------------ status popover (editable mode)

  function closePopover() {
    if (popover) popover.remove();
    popover = null;
  }

  function openPopover(task, anchorEl) {
    closePopover();
    var current = leafStatus(task);
    popover = h('div', 'prt-popover');
    popover.appendChild(h('div', 'prt-pop-title', titleOf(task)));
    var note = h('input', 'prt-pop-note');
    note.placeholder = 'Note (optional; required for Blocked)';
    var error = h('div', 'prt-pop-error');

    STATUSES.forEach(function (s) {
      var btn = h('button', 'prt-pop-status' + (s.id === current ? ' prt-current' : ''));
      btn.appendChild(dot(s.id));
      btn.appendChild(document.createTextNode(s.label));
      btn.type = 'button';
      btn.addEventListener('click', function () {
        if (s.id === 'blocked' && !note.value.trim()) {
          error.textContent = 'Add a reason for Blocked.';
          note.focus();
          return;
        }
        opts.onSetStatus(task.id, s.id, note.value.trim());
        closePopover();
      });
      popover.appendChild(btn);
    });
    popover.appendChild(note);
    popover.appendChild(error);
    place(anchorEl);
  }

  function openImplement(task, anchorEl) {
    closePopover();
    popover = h('div', 'prt-popover');
    popover.appendChild(h('div', 'prt-pop-title', implementLabel(task).slice(2) + ': ' + titleOf(task)));
    if (task.children.length) {
      var open = leavesOf(task).filter(function (t) {
        return ['done', 'skipped'].indexOf(leafStatus(t)) === -1;
      }).length;
      popover.appendChild(h('div', 'prt-pop-hint', 'Covers the ' + open + ' unfinished task' + (open === 1 ? '' : 's') + ' in this step.'));
    }
    var note = h('textarea', 'prt-pop-note');
    note.rows = 3;
    note.placeholder = 'Notes for Claude (optional), e.g. "stop after the tests pass"';
    var go = h('button', 'prt-pop-go', implementLabel(task));
    go.type = 'button';
    go.addEventListener('click', function () {
      opts.onImplement(task.id, note.value.trim());
      closePopover();
    });
    // Return confirms; Shift+Return adds a line break.
    note.addEventListener('keydown', function (e) {
      if (e.key !== 'Enter' || e.shiftKey || e.isComposing) return;
      e.preventDefault();
      go.click();
    });
    popover.appendChild(note);
    popover.appendChild(go);
    place(anchorEl);
    note.focus();
  }

  function place(anchorEl) {
    document.body.appendChild(popover);
    var r = anchorEl.getBoundingClientRect();
    var roomBelow = window.innerHeight - r.bottom;
    var top = roomBelow < popover.offsetHeight + 8 ? r.top - popover.offsetHeight - 4 : r.bottom + 4;
    popover.style.top = window.scrollY + Math.max(4, top) + 'px';
    popover.style.left = window.scrollX + Math.max(8, Math.min(r.left, document.documentElement.clientWidth - popover.offsetWidth - 8)) + 'px';
  }

  document.addEventListener('click', function (e) {
    if (popover && !popover.contains(e.target)) closePopover();
  });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') closePopover();
  });

  // ------------------------------------------------------------------ public API

  var api = {
    STATUSES: STATUSES,
    init: function (options) {
      opts = Object.assign(opts, options || {});
      index();
      render();
    },
    update: function (taskState) {
      state = taskState || {};
      render();
    },
    hasTasks: function () {
      return tasks.length > 0;
    },
    implementFor: implementFor,
    openImplement: function (taskId, anchorEl) {
      if (byTaskId[taskId]) openImplement(byTaskId[taskId], anchorEl);
    },
    taskIdFor: function (el) {
      var t = el && el.closest && el.closest('[data-task]');
      return t ? t.dataset.task : null;
    },
    label: function (taskId) {
      var t = byTaskId[taskId];
      if (!t) return null;
      var status = t.children.length ? derivedStatus(summarize(leavesOf(t))) : leafStatus(t);
      return BY_ID[status].label;
    },
  };
  window.PlanReviewTasks = api;
})();

#!/usr/bin/env python3
"""plan-review: comment on an HTML document in the browser.

Feedback is stored next to the document as `<doc-stem>.feedback.json`.
Standard library only (Python 3.8+).

Commands
  serve   DOC [--port N]    Serve DOC with the review UI injected (next free port if N is taken).
  watch   FEEDBACK [...]    Block until there is an unhandled submission, then print it and exit.
  pending FEEDBACK          Print comments from unhandled submissions.
  reply   FEEDBACK ID TEXT  Add a Claude reply to a comment (TEXT "-" reads stdin).
  done    FEEDBACK          Mark all unhandled submissions as handled.
  tasks   DOC               List the document's tasks with status and progress.
  task    DOC ID STATUS     Set a task's status as Claude (--note; Blocked needs one; Done is the reviewer's).
  export  DOC [-o OUT]      Write a shareable copy of DOC with current task progress baked in.

FEEDBACK may be the feedback JSON itself or the document it belongs to.
"""

import argparse
import contextlib
import datetime
import fcntl
import html.parser
import http.server
import json
import os
import sys
import time
import urllib.request
import uuid
from pathlib import Path
from urllib.parse import urlparse

ASSETS = Path(__file__).resolve().parent / "assets"
SCHEMA_VERSION = 1
DEFAULT_PORT = 8316
MAX_BODY = 1_000_000

STATUSES = {
    "todo": "To do",
    "in_progress": "In progress",
    "review": "In review",
    "blocked": "Blocked",
    "done": "Done",
    "skipped": "Skipped",
}
STATUS_ICONS = {"todo": "⚪", "in_progress": "🔵", "review": "🟣", "blocked": "🟠", "done": "🟢", "skipped": "⚫"}


# --------------------------------------------------------------------------- store


class OpError(ValueError):
    pass



def now():
    return datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds")


def feedback_path_for(doc):
    return doc.with_name(doc.stem + ".feedback.json")


def resolve_feedback_path(arg):
    path = Path(arg).expanduser().resolve()
    if path.name.endswith(".feedback.json"):
        return path
    return feedback_path_for(path)


def empty_feedback(fb):
    return {
        "schemaVersion": SCHEMA_VERSION,
        "doc": fb.name[: -len(".feedback.json")],
        "revision": 0,
        "comments": [],
        "submissions": [],
        "tasks": {},
    }


@contextlib.contextmanager
def locked(fb):
    """Serialize read-modify-write between the server and the CLI."""
    lock_path = fb.with_name("." + fb.name + ".lock")
    with open(lock_path, "a") as handle:
        fcntl.flock(handle, fcntl.LOCK_EX)
        try:
            yield
        finally:
            fcntl.flock(handle, fcntl.LOCK_UN)


def load(fb):
    try:
        data = json.loads(fb.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return empty_feedback(fb)
    data.setdefault("tasks", {})
    return data


def save(fb, data):
    data["revision"] = data.get("revision", 0) + 1
    tmp = fb.with_name("." + fb.name + ".tmp")
    tmp.write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    os.replace(tmp, fb)


def update(fb, mutate):
    """Apply `mutate(data)` atomically. `mutate` returns a result; the file is saved unless it raises."""
    with locked(fb):
        data = load(fb)
        result = mutate(data)
        save(fb, data)
        return data, result


def set_task(data, task_id, status, note, by):
    if status not in STATUSES:
        raise OpError(f"unknown status {status!r} (use one of: {', '.join(STATUSES)})")
    note = (note or "").strip()
    if status == "blocked" and not note:
        raise OpError("Blocked needs a note saying why")
    entry = data["tasks"].setdefault(task_id, {"history": []})
    entry.update({"status": status, "note": note, "updatedAt": now(), "updatedBy": by})
    entry["history"].append({"status": status, "note": note, "by": by, "at": now()})


def find_comment(data, comment_id):
    for comment in data["comments"]:
        if comment["id"] == comment_id:
            return comment
    raise KeyError(f"no comment with id {comment_id!r}")


# --------------------------------------------------------------------------- operations


def apply_op(data, op):
    """Operations sent by the browser. Each one only touches the fields the browser owns."""
    kind = op.get("op")

    if kind == "upsert":
        comment_id = str(op.get("id") or "")
        text = str(op.get("text") or "")
        if not comment_id:
            raise OpError("upsert needs an id")
        try:
            comment = find_comment(data, comment_id)
        except KeyError:
            anchor = op.get("anchor")
            if not isinstance(anchor, dict) or anchor.get("type") not in ("general", "block"):
                raise OpError("new comments need an anchor")
            if not text.strip():
                return None
            data["comments"].append(
                {
                    "id": comment_id,
                    "anchor": anchor,
                    "text": text,
                    "status": "draft",
                    "createdAt": now(),
                    "updatedAt": now(),
                    "replies": [],
                }
            )
            return None
        if comment["text"] != text:
            comment["text"] = text
            comment["updatedAt"] = now()
            comment["status"] = "draft"
        return None

    if kind == "delete":
        data["comments"] = [c for c in data["comments"] if c["id"] != op.get("id")]
        return None

    if kind == "resolve":
        find_comment(data, op.get("id"))["status"] = "resolved"
        return None

    if kind == "reopen":
        comment = find_comment(data, op.get("id"))
        comment["status"] = "addressed" if comment["replies"] else "draft"
        return None

    if kind == "task":
        task_id = str(op.get("id") or "")
        if not task_id:
            raise OpError("task needs an id")
        set_task(data, task_id, str(op.get("status") or ""), op.get("note"), by="reviewer")
        return None

    if kind == "reply-draft":
        # The reviewer's unsent follow-up in a thread. It becomes a reply when they click Send to Claude.
        find_comment(data, op.get("id"))["pendingReply"] = str(op.get("text") or "")
        return None

    if kind == "submit":
        sending = []
        for comment in data["comments"]:
            pending_reply = (comment.pop("pendingReply", "") or "").strip()
            if pending_reply:
                comment["replies"].append({"author": "reviewer", "text": pending_reply, "at": now()})
            if pending_reply or (comment["status"] == "draft" and comment["text"].strip()):
                sending.append(comment)
        if not sending:
            raise OpError("nothing to send")
        submit(data, sending)
        return None

    if kind == "implement":
        # The reviewer approved a task: sent straight away as its own submission, apart from any drafts.
        comment_id = str(op.get("id") or "")
        anchor = op.get("anchor")
        if not comment_id or not isinstance(anchor, dict) or not anchor.get("taskId"):
            raise OpError("implement needs an id and an anchor with a taskId")
        comment = {
            "id": comment_id,
            "kind": "implement",
            "anchor": anchor,
            "text": str(op.get("text") or "").strip() or "Implement this.",
            "createdAt": now(),
            "updatedAt": now(),
            "replies": [],
        }
        data["comments"].append(comment)
        submit(data, [comment])
        return None

    raise OpError(f"unknown op {kind!r}")


def submit(data, comments):
    for comment in comments:
        comment["status"] = "submitted"
        comment["submittedAt"] = now()
    data["submissions"].append(
        {
            "id": uuid.uuid4().hex[:8],
            "at": now(),
            "commentIds": [c["id"] for c in comments],
            "handled": False,
        }
    )


def unhandled(data):
    return [s for s in data["submissions"] if not s["handled"]]


# --------------------------------------------------------------------------- document tasks

VOID_TAGS = {"area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track", "wbr"}
TITLE_BREAK_START = {"ul", "ol", "p", "div", "table", "pre", "blockquote"}
TITLE_BREAK_END = {"h1", "h2", "h3", "h4", "h5", "h6", "p", "li", "td", "th"}


class TaskParser(html.parser.HTMLParser):
    """Collects [data-task] elements, their nesting and a short title. Assumes tags are closed."""

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.stack = []  # (tag, task or None)
        self.tasks = []

    def open_task(self):
        for _, task in reversed(self.stack):
            if task is not None:
                return task
        return None

    def handle_starttag(self, tag, attrs):
        if tag in VOID_TAGS:
            return
        attrs = dict(attrs)
        current = self.open_task()
        if current and not current["titleDone"] and tag in TITLE_BREAK_START and current["text"].strip():
            current["titleDone"] = True
        task = None
        if attrs.get("data-task"):
            task = {
                "id": attrs["data-task"],
                "title": attrs.get("data-task-title") or "",
                "text": "",
                "titleDone": bool(attrs.get("data-task-title")),
                "parent": current["id"] if current else None,
                "children": [],
            }
            if current:
                current["children"].append(task["id"])
            self.tasks.append(task)
        self.stack.append((tag, task))

    def handle_endtag(self, tag):
        current = self.open_task()
        if current and not current["titleDone"] and tag in TITLE_BREAK_END and current["text"].strip():
            current["titleDone"] = True
        for i in range(len(self.stack) - 1, -1, -1):
            if self.stack[i][0] == tag:
                del self.stack[i:]
                return

    def handle_data(self, data):
        current = self.open_task()
        if current and not current["titleDone"]:
            current["text"] += data


def parse_tasks(doc):
    parser = TaskParser()
    parser.feed(doc.read_text(encoding="utf-8"))
    tasks = {}
    for task in parser.tasks:
        title = task["title"] or " ".join(task["text"].split())
        tasks[task["id"]] = {
            "id": task["id"],
            "title": title[:100] + ("…" if len(title) > 100 else ""),
            "parent": task["parent"],
            "children": task["children"],
        }
    return tasks


def task_status(data, task_id):
    return data["tasks"].get(task_id, {}).get("status", "todo")


def leaves(tasks, task_id):
    children = tasks[task_id]["children"]
    if not children:
        return [task_id]
    return [leaf for child in children for leaf in leaves(tasks, child)]


def summarize(data, leaf_ids):
    counts = {status: 0 for status in STATUSES}
    for leaf in leaf_ids:
        counts[task_status(data, leaf)] += 1
    total = len(leaf_ids) - counts["skipped"]
    pct = round(counts["done"] * 100 / total) if total else 100
    return counts, total, pct


def derived_status(counts, total):
    if not total:
        return "skipped"
    if counts["done"] == total:
        return "done"
    if counts["blocked"]:
        return "blocked"
    if counts["done"] + counts["review"] == total:
        return "review"
    if counts["in_progress"] or counts["review"] or counts["done"]:
        return "in_progress"
    return "todo"


def breakdown(counts, total, pct):
    parts = [f"{counts['done']} of {total} done ({pct}%)"]
    for status in ("review", "in_progress", "blocked", "skipped"):
        if counts[status]:
            parts.append(f"{counts[status]} {STATUSES[status].lower()}")
    return " · ".join(parts)


def resolve_doc(arg):
    path = Path(arg).expanduser().resolve()
    if path.name.endswith(".feedback.json"):
        path = path.with_name(path.name[: -len(".feedback.json")] + ".html")
    if not path.is_file():
        sys.exit(f"plan-review: no such document: {path}")
    return path


def cmd_tasks(args):
    doc = resolve_doc(args.doc)
    data = load(feedback_path_for(doc))
    tasks = parse_tasks(doc)
    if not tasks:
        print("No [data-task] elements in this document.")
        return
    roots = [t for t in tasks.values() if not t["parent"]]
    all_leaves = [leaf for root in roots for leaf in leaves(tasks, root["id"])]
    print("Progress: " + breakdown(*summarize(data, all_leaves)))

    def show(task_id, depth):
        task = tasks[task_id]
        indent = "  " * depth
        if task["children"]:
            counts, total, _ = summarize(data, leaves(tasks, task_id))
            status = derived_status(counts, total)
            print(f"{indent}{STATUS_ICONS[status]} {task_id}  {task['title']}  [{counts['done']}/{total} · {STATUSES[status]}]")
            for child in task["children"]:
                show(child, depth + 1)
        else:
            entry = data["tasks"].get(task_id, {})
            status = entry.get("status", "todo")
            note = f"  ({entry['note']})" if entry.get("note") else ""
            print(f"{indent}{STATUS_ICONS[status]} {task_id}  {task['title']}  [{STATUSES[status]}]{note}")

    print()
    for root in roots:
        show(root["id"], 0)


def cmd_task(args):
    doc = resolve_doc(args.doc)
    tasks = parse_tasks(doc)
    if args.id not in tasks:
        sys.exit(f"plan-review: no task {args.id!r} in {doc.name} (see `tasks`)")
    if tasks[args.id]["children"]:
        sys.exit(f"plan-review: {args.id!r} has subtasks; its status comes from them. Set the subtasks instead.")
    if args.status == "done":
        sys.exit("plan-review: only the reviewer marks tasks Done. Use `review` when your part is finished.")
    try:
        update(feedback_path_for(doc), lambda data: set_task(data, args.id, args.status, args.note, by="claude"))
    except OpError as err:
        sys.exit(f"plan-review: {err}")
    print(f"plan-review: {args.id} → {STATUSES[args.status]}")


def cmd_export(args):
    doc = resolve_doc(args.doc)
    out = Path(args.output).expanduser().resolve() if args.output else doc.with_name(doc.stem + ".export.html")
    data = load(feedback_path_for(doc))
    css = "\n".join((ASSETS / name).read_text(encoding="utf-8") for name in ("tasks.css", "code.css"))
    js = "\n".join((ASSETS / name).read_text(encoding="utf-8") for name in ("tasks.js", "code.js"))
    state = json.dumps(data["tasks"]).replace("</", "<\\/")
    exported = f"Progress as of {datetime.datetime.now().strftime('%b %d, %Y %I:%M %p')}"
    tags = (
        f"<style>{css}</style>\n<script>{js}</script>\n"
        "<script>PlanReviewCode.init(); PlanReviewTasks.init({editable: false}); "
        f"PlanReviewTasks.update({state}); "
        "var s = document.querySelector('.prt-summary'); "
        # A compact summary has no room for the date, so it goes in the tooltip.
        f"if (s && s.classList.contains('prt-summary-compact')) {{ s.title += '\\n' + {json.dumps(exported)}; }} "
        f"else if (s) {{ var n = document.createElement('span'); n.className = 'prt-ui prt-summary-text'; n.textContent = {json.dumps(exported)}; s.appendChild(n); }}"
        "</script>\n"
    )
    html_text = doc.read_text(encoding="utf-8")
    idx = html_text.lower().rfind("</body>")
    out.write_text(html_text + tags if idx == -1 else html_text[:idx] + tags + html_text[idx:], encoding="utf-8")
    print(f"plan-review: wrote {out}")


# --------------------------------------------------------------------------- server


def display_path(path):
    home = str(Path.home())
    text = str(path)
    return "~" + text[len(home):] if text.startswith(home + os.sep) else text


def inject_ui(html):
    tags = (
        '<link rel="stylesheet" href="/__review/tasks.css">\n'
        '<link rel="stylesheet" href="/__review/code.css">\n'
        '<link rel="stylesheet" href="/__review/review.css">\n'
        '<script src="/__review/tasks.js" defer></script>\n'
        '<script src="/__review/code.js" defer></script>\n'
        '<script src="/__review/review.js" defer></script>\n'
    )
    idx = html.lower().rfind("</body>")
    return html + tags if idx == -1 else html[:idx] + tags + html[idx:]


def make_handler(doc, fb, port):
    allowed_hosts = {f"127.0.0.1:{port}", f"localhost:{port}"}
    assets = {
        "/__review/review.js": ("review.js", "text/javascript; charset=utf-8"),
        "/__review/review.css": ("review.css", "text/css; charset=utf-8"),
        "/__review/tasks.js": ("tasks.js", "text/javascript; charset=utf-8"),
        "/__review/tasks.css": ("tasks.css", "text/css; charset=utf-8"),
        "/__review/code.js": ("code.js", "text/javascript; charset=utf-8"),
        "/__review/code.css": ("code.css", "text/css; charset=utf-8"),
    }

    class Handler(http.server.BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def send_body(self, status, body, content_type):
            payload = body.encode("utf-8") if isinstance(body, str) else body
            self.send_response(status)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(payload)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(payload)

        def send_json(self, status, obj):
            self.send_body(status, json.dumps(obj), "application/json")

        def host_ok(self):
            # Guards against DNS rebinding: only answer requests addressed to localhost.
            if self.headers.get("Host") not in allowed_hosts:
                self.send_json(403, {"error": "bad host"})
                return False
            return True

        def state(self):
            return {
                "docPath": display_path(doc),
                "feedbackPath": str(fb),
                "docMtime": doc.stat().st_mtime,
                "feedback": load(fb),
            }

        def do_GET(self):
            if not self.host_ok():
                return
            path = urlparse(self.path).path
            if path in ("/", "/index.html"):
                self.send_body(200, inject_ui(doc.read_text(encoding="utf-8")), "text/html; charset=utf-8")
            elif path == "/__review/state":
                self.send_json(200, self.state())
            elif path == "/favicon.ico":
                self.send_response(204)
                self.end_headers()
            elif path in assets:
                name, content_type = assets[path]
                self.send_body(200, (ASSETS / name).read_bytes(), content_type)
            else:
                self.send_json(404, {"error": "not found"})

        def do_POST(self):
            if not self.host_ok():
                return
            if urlparse(self.path).path != "/__review/op":
                return self.send_json(404, {"error": "not found"})
            # A JSON content type can't be sent cross-origin without a CORS preflight, which we never grant.
            if not self.headers.get("Content-Type", "").startswith("application/json"):
                return self.send_json(415, {"error": "expected application/json"})
            length = int(self.headers.get("Content-Length") or 0)
            if length > MAX_BODY:
                return self.send_json(413, {"error": "too large"})
            try:
                op = json.loads(self.rfile.read(length) or b"{}")
                update(fb, lambda data: apply_op(data, op))
            except (OpError, KeyError, TypeError, json.JSONDecodeError) as err:
                return self.send_json(400, {"error": str(err)})
            self.send_json(200, self.state())

    return Handler


def serving(port):
    """The feedback path a plan-review server on `port` is using, or None."""
    try:
        with urllib.request.urlopen(f"http://localhost:{port}/__review/state", timeout=1) as res:
            return json.load(res).get("feedbackPath")
    except (OSError, ValueError):
        return None


def cmd_serve(args):
    doc = Path(args.doc).expanduser().resolve()
    if not doc.is_file():
        sys.exit(f"plan-review: no such file: {doc}")
    fb = feedback_path_for(doc)
    # Several reviews can run at once: if a port is taken, reuse it when it already serves this document,
    # otherwise try the next one.
    for port in range(args.port, args.port + 20):
        if serving(port) == str(fb):
            print(f"plan-review: already serving {doc}")
            print(f"plan-review: open      http://localhost:{port}", flush=True)
            return
        try:
            server = http.server.ThreadingHTTPServer(("127.0.0.1", port), make_handler(doc, fb, port))
            break
        except OSError:
            continue
    else:
        sys.exit(f"plan-review: no free port in {args.port}-{args.port + 19}")
    print(f"plan-review: reviewing {doc}")
    print(f"plan-review: feedback  {fb}")
    print(f"plan-review: open      http://localhost:{port}  (Ctrl-C to stop)", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nplan-review: stopped")


# --------------------------------------------------------------------------- claude-side commands


def describe_anchor(anchor):
    if anchor.get("type") == "general":
        return "Message (not attached to any part of the plan)"
    section = anchor.get("section") or "(top of document)"
    text = anchor.get("text", "")
    code = anchor.get("code") or {}
    if code.get("line"):
        where = f"in code block {code.get('block')}, line {code['line']}"
    elif code:
        where = f"on code block {code.get('block')} (the whole block)"
    else:
        where = f"on {anchor.get('tag', 'block').lower()}"
    return f"{section}\n    {where}: \"{text[:160]}{'…' if len(text) > 160 else ''}\""


def format_pending(data):
    pending = unhandled(data)
    if not pending:
        return "No unhandled submissions."
    ids = [cid for s in pending for cid in s["commentIds"]]
    lines = [f"{len(ids)} comment(s) in {len(pending)} unhandled submission(s):", ""]
    for cid in ids:
        try:
            comment = find_comment(data, cid)
        except KeyError:
            continue  # deleted after it was sent
        implement = comment.get("kind") == "implement"
        lines.append(f"[{cid}] {'IMPLEMENT (approved by the reviewer) · ' if implement else ''}{describe_anchor(comment['anchor'])}")
        task_id = comment["anchor"].get("taskId")
        if task_id:
            lines.append(f"    task: {task_id} [{STATUSES[task_status(data, task_id)]}]")
        label = "    note:    " if implement else "    comment: "
        lines.append(label + comment["text"].replace("\n", "\n             "))
        # The thread, oldest first. Reviewer messages after Claude's last reply are what's new.
        last_claude = max((i for i, r in enumerate(comment["replies"]) if r["author"] == "claude"), default=-1)
        for i, reply in enumerate(comment["replies"]):
            who = "claude:  " if reply["author"] == "claude" else ("NEW reply: " if i > last_claude else "reviewer:")
            lines.append(f"    {who} " + reply["text"].replace("\n", "\n             "))
        lines.append("")
    return "\n".join(lines).rstrip()


def cmd_pending(args):
    print(format_pending(load(resolve_feedback_path(args.feedback))))


def cmd_watch(args):
    fb = resolve_feedback_path(args.feedback)
    print(f"plan-review: watching {fb}", flush=True)
    while True:
        if fb.exists():
            data = load(fb)
            if unhandled(data):
                print(format_pending(data))
                return
        time.sleep(args.interval)


def cmd_reply(args):
    fb = resolve_feedback_path(args.feedback)
    text = sys.stdin.read() if args.text == "-" else args.text
    if not text.strip():
        sys.exit("plan-review: empty reply")

    def mutate(data):
        comment = find_comment(data, args.id)
        comment["replies"].append({"author": "claude", "text": text.strip(), "at": now()})
        comment["status"] = "addressed"

    try:
        update(fb, mutate)
    except KeyError as err:
        sys.exit(f"plan-review: {err}")
    print(f"plan-review: replied to {args.id}")


def unreplied(data, submission):
    """Comments in a submission that have no Claude reply posted after it was sent."""
    missing = []
    for cid in submission["commentIds"]:
        try:
            comment = find_comment(data, cid)
        except KeyError:
            continue  # deleted after it was sent
        if not any(r["author"] == "claude" and r["at"] >= submission["at"] for r in comment["replies"]):
            missing.append(comment)
    return missing


def cmd_done(args):
    """Mark submissions handled, but only those whose comments all have a reply.

    Feedback can arrive while Claude is working, so a submission that nobody has replied to yet is left
    pending (and listed) instead of being silently marked handled."""
    fb = resolve_feedback_path(args.feedback)

    def mutate(data):
        handled, waiting = 0, []
        for submission in unhandled(data):
            missing = unreplied(data, submission)
            if missing:
                waiting.extend(missing)
                continue
            submission["handled"] = True
            submission["handledAt"] = now()
            handled += 1
            for cid in submission["commentIds"]:
                with contextlib.suppress(KeyError):
                    comment = find_comment(data, cid)
                    if comment["status"] == "submitted":
                        comment["status"] = "addressed"
        return handled, waiting

    _, (handled, waiting) = update(fb, mutate)
    print(f"plan-review: marked {handled} submission(s) handled")
    if waiting:
        print(f"plan-review: {len(waiting)} comment(s) still need a reply, left pending:")
        for comment in waiting:
            print(f"  [{comment['id']}] {comment['text'][:100]}")


def main(argv=None):
    parser = argparse.ArgumentParser(prog="plan_review.py", description=__doc__.split("\n")[0])
    sub = parser.add_subparsers(dest="command", required=True)

    p = sub.add_parser("serve", help="serve a document with the review UI")
    p.add_argument("doc")
    p.add_argument("--port", type=int, default=DEFAULT_PORT)
    p.set_defaults(func=cmd_serve)

    p = sub.add_parser("watch", help="block until feedback is sent, then print it")
    p.add_argument("feedback")
    p.add_argument("--interval", type=float, default=2.0)
    p.set_defaults(func=cmd_watch)

    p = sub.add_parser("pending", help="print unhandled feedback")
    p.add_argument("feedback")
    p.set_defaults(func=cmd_pending)

    p = sub.add_parser("reply", help="reply to a comment")
    p.add_argument("feedback")
    p.add_argument("id")
    p.add_argument("text", help='reply text, or "-" to read stdin')
    p.set_defaults(func=cmd_reply)

    p = sub.add_parser("done", help="mark unhandled submissions handled")
    p.add_argument("feedback")
    p.set_defaults(func=cmd_done)

    p = sub.add_parser("tasks", help="list tasks with status and progress")
    p.add_argument("doc")
    p.set_defaults(func=cmd_tasks)

    p = sub.add_parser("task", help="set a task's status (as Claude)")
    p.add_argument("doc")
    p.add_argument("id")
    p.add_argument("status", choices=list(STATUSES))
    p.add_argument("--note", default="")
    p.set_defaults(func=cmd_task)

    p = sub.add_parser("export", help="write a shareable copy with task progress baked in")
    p.add_argument("doc")
    p.add_argument("-o", "--output")
    p.set_defaults(func=cmd_export)

    args = parser.parse_args(argv)
    args.func(args)


if __name__ == "__main__":
    main()

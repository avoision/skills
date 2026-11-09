"""Tests for plan_review.py. Standard library only.

Run from anywhere:  python3 -m unittest discover -s ~/.claude/skills/plan-review/tests -v

Every test works on its own temp folder, never on real review files.
"""

import contextlib
import http.client
import io
import json
import shutil
import socket
import sys
import tempfile
import threading
import unittest
from pathlib import Path

SKILL_DIR = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(SKILL_DIR))

import plan_review as pr  # noqa: E402

DOC = """<!DOCTYPE html><html><head><title>t</title><style>body{}</style></head><body>
<nav><div data-task-summary="compact"></div></nav>
<h2>Steps</h2>
<div class="step" data-task="s1" data-task-title="First step">
  <h3>1 First step</h3>
  <ul>
    <li data-task="s1.a">Do A.</li>
    <li data-task="s1.b">Do B.</li>
  </ul>
</div>
<h2>Open Questions</h2>
<ol data-task="q" data-task-title="Open questions">
  <li data-task="q.one"><b>One.</b> Which way?</li>
</ol>
</body></html>
"""

BLOCK = {"type": "block", "section": "Steps", "text": "Do A.", "tag": "LI", "taskId": "s1.a"}


def run(*argv):
    """Run the CLI in-process and return what it printed."""
    out = io.StringIO()
    with contextlib.redirect_stdout(out):
        pr.main([str(a) for a in argv])
    return out.getvalue()


class ReviewTestCase(unittest.TestCase):
    def setUp(self):
        self.dir = Path(tempfile.mkdtemp(prefix="plan-review-test-")).resolve()  # /var is a symlink on macOS
        self.doc = self.dir / "plan.html"
        self.doc.write_text(DOC, encoding="utf-8")
        self.fb = pr.feedback_path_for(self.doc)

    def tearDown(self):
        shutil.rmtree(self.dir)

    def op(self, **op):
        return pr.update(self.fb, lambda data: pr.apply_op(data, op))

    def data(self):
        return pr.load(self.fb)

    def comment(self, cid="c1", text="Why A?", anchor=BLOCK):
        self.op(op="upsert", id=cid, anchor=anchor, text=text)


class CommentFlowTest(ReviewTestCase):
    def test_comment_send_reply_done(self):
        self.comment()
        self.op(op="submit")
        self.assertEqual(len(pr.unhandled(self.data())), 1)
        self.assertIn("Why A?", run("pending", self.doc))

        run("reply", self.doc, "c1", "Because B needs it.")
        run("done", self.doc)
        data = self.data()
        self.assertEqual(pr.unhandled(data), [])
        self.assertEqual(data["comments"][0]["status"], "addressed")

    def test_done_leaves_unreplied_submissions_pending(self):
        self.comment()
        self.op(op="submit")
        out = run("done", self.doc)
        self.assertIn("still need a reply", out)
        self.assertEqual(len(pr.unhandled(self.data())), 1)

    def test_submit_with_nothing_to_send_is_rejected(self):
        with self.assertRaises(pr.OpError):
            self.op(op="submit")

    def test_empty_new_comment_is_not_stored(self):
        self.comment(text="   ")
        self.assertEqual(self.data()["comments"], [])

    def test_message_not_attached_to_the_plan(self):
        self.comment(anchor={"type": "general"}, text="Overall thoughts")
        self.op(op="submit")
        self.assertIn("Message (not attached to any part of the plan)", run("pending", self.doc))


class CodeAnchorTest(ReviewTestCase):
    def test_pending_names_the_code_block_and_line(self):
        line = {"type": "block", "section": "Steps", "text": "const x = 1;", "tag": "LINE", "code": {"block": 3, "line": 45}}
        whole = {"type": "block", "section": "Steps", "text": "const x = 1; return x;", "tag": "PRE", "code": {"block": 3}}
        self.comment(cid="line", anchor=line, text="Why 1?")
        self.comment(cid="whole", anchor=whole, text="Simplify this block")
        self.op(op="submit")
        pending = run("pending", self.doc)
        self.assertIn('in code block 3, line 45: "const x = 1;"', pending)
        self.assertIn("on code block 3 (the whole block)", pending)


class ThreadTest(ReviewTestCase):
    def test_follow_up_reply_is_sent_and_marked_new(self):
        self.comment()
        self.op(op="submit")
        run("reply", self.doc, "c1", "Because B needs it.")
        run("done", self.doc)

        self.op(op="reply-draft", id="c1", text="Could B go first?")
        self.assertEqual(pr.unhandled(self.data()), [])  # a draft isn't sent until Send to Claude
        self.op(op="submit")

        data = self.data()
        comment = data["comments"][0]
        self.assertEqual([r["author"] for r in comment["replies"]], ["claude", "reviewer"])
        self.assertNotIn("pendingReply", comment)
        self.assertEqual(comment["status"], "submitted")
        pending = run("pending", self.doc)
        self.assertIn("claude:", pending)
        self.assertIn("NEW reply:  Could B go first?", pending)

    def test_blank_reply_draft_sends_nothing(self):
        self.comment()
        self.op(op="submit")
        run("reply", self.doc, "c1", "Answer.")
        run("done", self.doc)
        self.op(op="reply-draft", id="c1", text="  ")
        with self.assertRaises(pr.OpError):
            self.op(op="submit")


class ImplementTest(ReviewTestCase):
    def test_implement_is_its_own_submission(self):
        self.comment(cid="draft", text="Unsent draft")
        self.op(op="implement", id="i1", anchor=BLOCK, text="")

        data = self.data()
        pending = pr.unhandled(data)
        self.assertEqual(len(pending), 1)
        self.assertEqual(pending[0]["commentIds"], ["i1"])  # the draft isn't swept along
        implement = pr.find_comment(data, "i1")
        self.assertEqual(implement["kind"], "implement")
        self.assertEqual(implement["text"], "Implement this.")
        self.assertEqual(pr.find_comment(data, "draft")["status"], "draft")
        self.assertIn("IMPLEMENT (approved by the reviewer)", run("pending", self.doc))

    def test_implement_needs_a_task(self):
        with self.assertRaises(pr.OpError):
            self.op(op="implement", id="i1", anchor={"type": "general"})


class TaskTest(ReviewTestCase):
    def test_parse_nesting_and_titles(self):
        tasks = pr.parse_tasks(self.doc)
        self.assertEqual(tasks["s1"]["children"], ["s1.a", "s1.b"])
        self.assertEqual(tasks["s1"]["title"], "First step")
        self.assertEqual(tasks["s1.a"]["title"], "Do A.")
        self.assertEqual(tasks["q.one"]["parent"], "q")

    def test_claude_can_set_review_but_not_done(self):
        run("task", self.doc, "s1.a", "review", "--note", "tests pass")
        self.assertEqual(pr.task_status(self.data(), "s1.a"), "review")
        with self.assertRaises(SystemExit):
            run("task", self.doc, "s1.a", "done")

    def test_steps_and_blocked_rules(self):
        with self.assertRaises(SystemExit):
            run("task", self.doc, "s1", "in_progress")  # a step's status comes from its subtasks
        with self.assertRaises(SystemExit):
            run("task", self.doc, "s1.a", "blocked")  # blocked needs a note
        with self.assertRaises(SystemExit):
            run("task", self.doc, "nope", "review")

    def test_progress_counts_only_leaves_and_skips_skipped(self):
        self.op(op="task", id="s1.a", status="done")
        self.op(op="task", id="s1.b", status="skipped")
        out = run("tasks", self.doc)
        self.assertIn("Progress: 1 of 2 done (50%)", out)  # s1.a done; s1.b skipped; q.one to do

    def test_export_bakes_in_progress_read_only(self):
        self.op(op="task", id="s1.a", status="done")
        out = self.dir / "shared.html"
        run("export", self.doc, "-o", out)
        html = out.read_text(encoding="utf-8")
        self.assertIn("PlanReviewTasks.init({editable: false})", html)
        self.assertIn('"s1.a"', html)
        self.assertNotIn("/__review/review.js", html)  # no comment UI in exports
        self.assertIn("PlanReviewCode.init()", html)  # but code is highlighted and numbered


class TemplateTest(unittest.TestCase):
    TEMPLATE = SKILL_DIR / "assets" / "plan-template.html"

    def test_one_stylesheet(self):
        # A literal "<style>" anywhere else (e.g. in a comment) breaks tools that swap the stylesheet.
        html = self.TEMPLATE.read_text(encoding="utf-8")
        self.assertEqual(html.count("<style>"), 1)
        self.assertEqual(html.count("</style>"), 1)

    def test_parses_and_has_progress_slot(self):
        html = self.TEMPLATE.read_text(encoding="utf-8")
        self.assertIn('data-task-summary="compact"', html)
        tasks = pr.parse_tasks(self.TEMPLATE)
        self.assertIn("s1", tasks)
        self.assertIn("q", tasks)


class ServerTest(ReviewTestCase):
    def setUp(self):
        super().setUp()
        with socket.socket() as s:
            s.bind(("127.0.0.1", 0))
            self.port = s.getsockname()[1]
        handler = pr.make_handler(self.doc, self.fb, self.port)
        self.server = pr.http.server.ThreadingHTTPServer(("127.0.0.1", self.port), handler)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        super().tearDown()

    def request(self, method, path, body=None, host=None, content_type="application/json"):
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=5)
        headers = {"Host": host or f"localhost:{self.port}"}
        if body is not None:
            headers["Content-Type"] = content_type
        conn.request(method, path, body=json.dumps(body) if body is not None else None, headers=headers)
        res = conn.getresponse()
        data = res.read().decode("utf-8")
        conn.close()
        return res.status, data

    def test_page_has_review_ui_injected(self):
        status, html = self.request("GET", "/")
        self.assertEqual(status, 200)
        self.assertIn("/__review/review.js", html)
        self.assertIn("/__review/code.js", html)
        self.assertIn('data-task="s1.a"', html)
        status, js = self.request("GET", "/__review/code.js")
        self.assertEqual(status, 200)
        self.assertIn("PlanReviewCode", js)

    def test_ops_round_trip(self):
        status, _ = self.request("POST", "/__review/op", {"op": "upsert", "id": "c1", "anchor": BLOCK, "text": "Hi"})
        self.assertEqual(status, 200)
        status, body = self.request("GET", "/__review/state")
        self.assertEqual(json.loads(body)["feedback"]["comments"][0]["text"], "Hi")

    def test_rejects_other_hosts_and_non_json(self):
        status, _ = self.request("GET", "/", host="evil.example")
        self.assertEqual(status, 403)
        status, _ = self.request("POST", "/__review/op", {"op": "submit"}, content_type="text/plain")
        self.assertEqual(status, 415)

    def test_serve_reuses_a_server_for_the_same_document(self):
        self.assertEqual(pr.serving(self.port), str(self.fb))
        out = run("serve", self.doc, "--port", self.port)
        self.assertIn("already serving", out)


if __name__ == "__main__":
    unittest.main()

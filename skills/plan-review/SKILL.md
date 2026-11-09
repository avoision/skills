---
name: plan-review
description: Review, refine and carry out a plan with Claude through a local web page. Turns a plan (a Markdown file or one in the conversation) into an HTML page where you comment on any part, track task progress, and click "Implement" to approve a task. Use when the user runs /plan-review, or asks to review, refine, walk through or step through a plan, or to respond to review comments.
---

# plan-review

A way for the user to read, question, refine and then carry out a plan Claude wrote, one task at a time.
The plan becomes an HTML page with a comment panel and task statuses. The user comments on parts of the plan
and clicks **Send to Claude**, or clicks **▶ Implement** on a task to approve it. Claude replies under each
comment through the CLI.

Expect comments like:

- questions ("I don't understand this bullet, explain it more generally")
- decisions and changes of direction ("drop this step", "let's discuss the edge cases next")
- edits to the plan itself
- Implement requests: the user approves a task or a whole step and wants it done

Your replies are the main output. The plan gets edited when a comment asks for it, or when a decision changes
it, so it stays an accurate record of what's being done.

`SKILL_DIR` below means the directory containing this file. All commands are `python3 SKILL_DIR/plan_review.py …`
(standard library only).

## Entry points

- **`/plan-review` after Claude wrote a plan, or `/plan-review path/to/plan.md`**: start a review (below).
- **`/plan-review path/to/plan.html` or a folder, or "watch the review in …"**: resume one. Find the document
  (a folder's `REVIEW.md` names it, otherwise look for the single `*.feedback.json` or `.html`). Then start the
  server and the watcher (steps 4–6 below) and run `tasks` to see where things stand.

## Starting a review

Everything lives in the current working directory, next to the plan's `.md` and whatever supporting files are
already there. The user usually runs this from the folder for that piece of work.

1. **Find the plan.**
   - A path was given: use it.
   - The plan is in this conversation, or only in a file outside the working directory (e.g. a plan-mode plan
     under `~/.claude`): write it to `<cwd>/<slug>.md`. The slug is a short name for the plan, e.g.
     `checkout-plan` or `error-page-plan`.
   - Not clear which plan: ask.
2. **Write the HTML** next to the `.md`, with the same stem (`<slug>.md` → `<slug>.html`). Start from
   `SKILL_DIR/assets/plan-template.html` and follow "Writing the HTML plan" below.
   Leave the `.md` as it is: it's the original. From here on the HTML is the plan. Edit only the HTML, and don't
   keep the Markdown in sync.
3. **Write `REVIEW.md`** next to the HTML:
   ```markdown
   # Review: <title>

   - Plan: `<slug>.html` (the working copy; edit only this)
   - Original: `<path to the .md>` (not updated after the review started)
   - Feedback: `<slug>.feedback.json`

   Resume with `/plan-review <abs path to this folder>`.
   ```
4. **Start the server** with Bash `run_in_background: true`:
   ```bash
   python3 SKILL_DIR/plan_review.py serve /abs/path/plan.html
   ```
   It prints the URL. It's safe to run again: if this document is already being served, it prints the existing URL
   and exits. If port 8316 is busy, it uses the next free one. It stops when this Claude session ends.
5. **Start the watcher** (see "Watching for feedback").
6. **Tell the user** the URL, and that they can comment, click Send to Claude, or click ▶ Implement on a task.

## Rules

- **Never edit `*.feedback.json` by hand.** Always use the CLI. It locks the file and bumps the revision so the
  browser picks up changes safely.
- **Approval for work outside the plan.** Discussing and editing the plan needs no approval. Anything else (code
  changes, commands that change things, tickets, messages) needs the user's approval for that specific work:
  - an **Implement** request for the task, or
  - a comment that explicitly asks for it ("implement bullets 1–3 and the tests").
  If a comment only implies the work ("this should use X"), update the plan and say in your reply that they can
  click Implement. Approval covers what the task describes, nothing more. Don't commit, push, open PRs or publish
  unless the approved task or comment says to.
- **Stop where the request ends.** Do the approved task (or the step's unfinished subtasks), report back and stop.
  Don't start the next task. The user steps through the plan.
- **Ask instead of guessing.** If an approved task is ambiguous or turns out to be wrong, do what's clear, then ask
  in the reply. Where the plan was wrong, change the plan.

## Implement requests

`pending` shows them as `IMPLEMENT (approved by the reviewer)`, with the task id and an optional note. The note
can narrow or adjust the scope ("stop after the tests pass").

- **A leaf task:** do it.
- **A step (a task with subtasks):** do its subtasks that aren't `done` or `skipped`, in order.
- **An open question:** resolve it with the plan's recommendation (or what the note says). Update the plan to
  reflect the decision, and set the question to `review`. If resolving it means doing work, do that too.
- Follow the repo's own conventions (CLAUDE.md, tests, lint) and run the relevant checks.
- Set each task `in_progress` when you start it and `review` when it's finished, with a note saying how it was
  verified and whether anything is committed. If you can't finish one, set it `blocked` with the reason.
- Reply with: files changed, checks run and their results, anything you left out or changed from the plan, and
  whether anything is committed.

## Tasks and progress

Tasks are marked in the HTML with `data-task`. Statuses and history live in the feedback JSON.

```html
<div data-task-summary="compact"></div>             <!-- the one progress bar (the template puts it in the nav) -->
<div class="step" data-task="s1" data-task-title="Create the script">
  <h3>1 Create the script</h3>                      <!-- hovering a step's heading offers "Implement all" -->
  <li data-task="s1.create">Create hello.py …</li>   <!-- a subtask gets a status pill; hovering it offers "Implement" -->
```

Statuses: `todo` (default), `in_progress`, `review`, `blocked` (needs a note), `done`, `skipped` (left out of the
percentage). A step's status comes from its subtasks, so never set a step directly.

- **Done belongs to the reviewer.** Claude can move a task as far as `review`; the CLI refuses `done`.
- Progress = done ÷ (all subtasks − skipped), counting only tasks with no subtasks.
- If finishing one task also finished another, set that one to `review` too, with a note saying so.

```bash
python3 SKILL_DIR/plan_review.py tasks  /abs/path/plan.html                     # tree with statuses, notes, progress
python3 SKILL_DIR/plan_review.py task   /abs/path/plan.html s1.create in_progress
python3 SKILL_DIR/plan_review.py task   /abs/path/plan.html s1.create review --note "unit tests pass; uncommitted"
python3 SKILL_DIR/plan_review.py task   /abs/path/plan.html s2.shout blocked --note "waiting on the !!! decision"
python3 SKILL_DIR/plan_review.py export /abs/path/plan.html   # plan.export.html: shareable, read-only, progress baked in
```

## Writing the HTML plan

- One self-contained file: inline CSS, no scripts, no relative assets. Copy the template's stylesheet as is,
  including its theme: warm paper colours with Avenir headings, the user's chosen look.
- It should read like a working document: dense and plain, with the plan's content first. No decorative design.
- Use the template's sections where they fit (Goal, Context, Steps, Open Questions, Verification), and add or
  drop sections to suit the plan. Add Acceptance Criteria when the work comes with them (e.g. a ticket), and a
  Commit / PR Breakdown only when the plan changes code across more than one commit.
- **Steps** are `<div class="step" data-task="sN" data-task-title="…">` with a heading and a list of actions.
- Mark only actionable items with `data-task`. Each one should be something you could carry out and the user could
  review on its own, roughly one focused change. Context, constraints and notes stay plain text.
- **Open questions** are tasks too (`q.<slug>`), so resolving them counts toward progress. Give each one options
  and a recommendation.
- IDs are stable and unique (`s1.create`, `q.marks`). Status is keyed by ID, so rewording a task keeps its status;
  changing or removing an ID orphans it. When you add tasks later, use new IDs; don't renumber.
- Close your tags. The CLI parses the HTML to find tasks.
- **Code** goes in `<pre><code class="language-ts">…</code></pre>`. The page highlights it and numbers every line, and
  the reviewer can comment on single lines or the whole block. Plain `<pre><code>` counts as TypeScript. Other
  languages: `language-js`, `-json`, `-sh`, `-py`; anything else (e.g. `language-plain`, `-http`) stays plain text.
  For a snippet taken from a file, add `data-start="33"` on the `<pre>` so the line numbers match the file, and name
  the file and lines above it. A comment on code shows in `pending` as `in code block N, line M` (M is the file line
  when `data-start` is set) or `on code block N (the whole block)`; blocks are numbered in page order.
- Every colour and font, including those of the comment panel and task pills (`--review-*`, `--task-*`), comes
  from the theme block at the top of the stylesheet. To change the look, edit only that block.

## Watching for feedback

Start the watcher as a background command (Bash with `run_in_background: true`):

```bash
python3 SKILL_DIR/plan_review.py watch /abs/path/plan.html
```

It exits, and so notifies you, as soon as there is an unhandled submission (Send to Claude or Implement), printing
the comments. If feedback is already waiting, it exits immediately.

## Handling a submission

1. `python3 SKILL_DIR/plan_review.py pending /abs/path/plan.html` lists every unhandled comment with its id, the
   section, the quoted text, the task (if any), and the comment.
   Comments are threads. If the reviewer followed up on an earlier reply, `pending` shows the whole thread
   (`comment:`, then `claude:` / `reviewer:` lines) and marks their newest messages `NEW reply:`. Respond to those,
   using the rest of the thread for context.
2. Read the plan first, so you know which part each comment refers to. Then work through all of them:
   - **Questions:** answer in plain terms, grounded in the actual code where relevant. If the plan's wording caused
     the confusion, reword it too.
   - **Decisions and plan edits:** update the plan.
   - **Implement requests** and explicit requests for work: see "Implement requests".
3. Reply to **every** comment, *after* any plan edits and other work are done:
   ```bash
   python3 SKILL_DIR/plan_review.py reply /abs/path/plan.html <comment-id> - <<'EOF'
   Updated step 2: --shout stays upper case only. Removed the related open question.
   EOF
   ```
   Keep replies short and concrete. Plain text only.
4. `python3 SKILL_DIR/plan_review.py done /abs/path/plan.html` marks the submission handled. Do this last. It only
   marks submissions where every comment has a reply posted after it was sent. If it lists comments still needing
   a reply, new feedback arrived while you were working: run `pending` again and handle those too.
5. In the terminal, give a short summary of what you did.
6. Restart the watcher so the loop continues, unless the user said to stop.

The page notices the plan changed and reloads itself, keeping the reviewer's comments. Comments whose text you
rewrote move to an "On text that has since changed" group, with the original quote shown. That's expected.

The server reads the JS and CSS fresh on every page load, but changes to `plan_review.py` itself only take
effect after the server is restarted.

When changing the tool itself, run its tests: `python3 -m unittest discover -s SKILL_DIR/tests` (standard library
only, about 2 seconds, each test on its own temp folder). Never test against a real review's feedback file.

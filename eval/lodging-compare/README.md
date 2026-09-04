# lodging-compare — eval harness

The scripts used to verify and cost-measure `skills/lodging-compare`. They are
not part of the skill and are not installed with it.

| Script | What it does |
| --- | --- |
| `run.sh` | Fires the verification runs through `claude -p --output-format json`, one file per run into `out/`. Run all of them, or name them: `./run.sh 3 5`. |
| `check.py` | Reads `out/*.json`, extracts the JSON the skill emitted, validates it against `references/output-schema.md`, and tabulates cost, retrieval calls, output tokens, and turns. |
| `probe-airbnb.sh` | Checks whether Airbnb is actually reachable from this machine, and at what dwell time. Written after a night of runs fell back to estimates because a single server-side 403 was mistaken for a site-wide block. |

## Running them

The scripts drive whatever skill is visible from their own directory, so point
that at the skill first:

```bash
cd eval/lodging-compare
mkdir -p .claude/skills
ln -s ../../../../skills/lodging-compare .claude/skills/lodging-compare
./run.sh
python3 check.py
```

Re-make that link after editing the skill, or you will measure a stale build.

## What the numbers mean

`check.py` subtracts $0.34/run of fixed system-prompt caching overhead to get
the net figure. It counts retrieval calls from the session transcript rather
than from `usage.server_tool_use.web_search_requests` — that field does not
count Claude Code's client-side WebSearch/WebFetch and reads 0 for every run.

`total_cost_usd` is priced at API list rates for whichever model ran. `run.sh`
passes no `--model`, so it inherits the machine default; pin `--model` before
comparing runs to each other.

**Every run costs real money and takes minutes.** The full set is five runs.

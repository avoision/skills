#!/usr/bin/env python3
"""Validate lodging-compare verification runs + tabulate cost.

Reads out/*.json (the claude -p --output-format json wrappers), extracts any
JSON the skill emitted, and checks it against references/output-schema.md.
"""
import json, re, sys, glob, os, collections

BASELINE = 0.34  # fixed per-run overhead: caching the system prompt

TYPES  = {"short_let", "hotel", "aparthotel", "hostel"}
CONF   = {"high", "medium", "low"}
BASIS  = {"map_data", "listing_page", "guest_reviews",
          "neighbourhood_guide", "price_aggregator", "inference"}
CODES  = {"source_blocked", "no_results", "partial_results",
          "criterion_unresearched", "price_estimated", "budget_exclusion"}
TOP    = {"schema_version", "query", "assumptions", "candidates",
          "picks", "verdict", "warnings"}
CRIT_F = {"criterion", "score", "value", "confidence", "basis", "note"}


def tool_counts(session_id):
    """Real tool usage, from the session transcript.

    server_tool_use.web_search_requests does NOT count Claude Code's
    client-side WebSearch/WebFetch — it reads 0 for every run. The transcript
    is the only honest source.
    """
    for d in glob.glob(os.path.expanduser("~/.claude/projects/*")):
        f = os.path.join(d, f"{session_id}.jsonl")
        if not os.path.exists(f):
            continue
        c = collections.Counter()
        for line in open(f):
            try:
                e = json.loads(line)
            except Exception:
                continue
            for blk in ((e.get("message") or {}).get("content") or []):
                if isinstance(blk, dict) and blk.get("type") == "tool_use":
                    c[blk.get("name")] += 1
        return c
    return None


def extract(result_text):
    """Pull the skill's JSON out of the response text."""
    m = re.search(r"```json\s*(.+?)```", result_text, re.S)
    blob = m.group(1) if m else result_text
    try:
        return json.loads(blob.strip())
    except Exception:
        return None


def validate(d):
    errs = []
    missing = TOP - set(d)
    if missing:
        errs.append(f"missing top-level keys: {sorted(missing)}")

    ids = set()
    for i, c in enumerate(d.get("candidates", [])):
        w = f"candidates[{i}]"
        ids.add(c.get("id"))
        if c.get("type") not in TYPES:
            errs.append(f"{w}.type invalid: {c.get('type')!r}")
        crits = c.get("criteria", [])
        names = {x.get("criterion") for x in crits}
        if "cost" not in names:
            errs.append(f"{w} has no cost criterion")
        for j, cr in enumerate(crits):
            cw = f"{w}.criteria[{j}]"
            if set(cr) != CRIT_F:
                errs.append(f"{cw} fields {sorted(set(cr))} != the six required")
            s = cr.get("score")
            if s is not None and not (isinstance(s, int) and 1 <= s <= 5):
                errs.append(f"{cw}.score not 1-5 or null: {s!r}")
            if s is None and not cr.get("note"):
                errs.append(f"{cw} null score with no note")
            if cr.get("confidence") not in CONF:
                errs.append(f"{cw}.confidence invalid: {cr.get('confidence')!r}")
            if cr.get("basis") not in BASIS:
                errs.append(f"{cw}.basis invalid: {cr.get('basis')!r}")

    picks = d.get("picks") or {}
    for k in ("overall", "best_value"):
        if picks.get(k) is not None and picks[k] not in ids:
            errs.append(f"picks.{k}={picks[k]} is not a candidate id")

    for i, wn in enumerate(d.get("warnings", [])):
        if wn.get("code") not in CODES:
            errs.append(f"warnings[{i}].code invalid: {wn.get('code')!r}")

    return errs


def main():
    files = sorted(glob.glob(os.path.join(os.path.dirname(__file__), "out", "*.json")))
    if not files:
        sys.exit("no runs found in out/ — run ./run.sh first")

    print(f"{'run':<22}{'$':>8}{'net$':>8}{'srch':>6}{'out tok':>10}{'turns':>7}  status")
    print("─" * 78)
    total = 0.0
    for f in files:
        name = os.path.basename(f)[:-5]
        try:
            w = json.load(open(f))
        except Exception as e:
            print(f"{name:<22}{'':>8}{'':>8}{'':>6}{'':>10}{'':>7}  UNREADABLE ({e})")
            continue

        cost = w.get("total_cost_usd", 0) or 0
        total += cost
        u = w.get("usage", {}) or {}
        tc = tool_counts(w.get("session_id", ""))
        if tc is None:
            srch = "?"          # transcript gone
        else:
            srch = tc["WebSearch"] + tc["WebFetch"]
        otok = u.get("output_tokens", 0)
        turns = w.get("num_turns", 0)

        text = w.get("result", "") or ""
        if w.get("is_error"):
            status = "ERROR: " + text[:40]
        else:
            d = extract(text)
            if d is None:
                status = "no JSON (html run?)" if "html" in name else "NO JSON FOUND"
            else:
                errs = validate(d)
                bases = [c.get("price", {}).get("basis") for c in d.get("candidates", [])]
                live = sum(b == "live" for b in bases)
                px = f"{live}/{len(bases)} live px"
                status = f"valid · {px}" if not errs else f"{len(errs)} issue(s) · {px}"
                if errs:
                    for e in errs[:6]:
                        status += f"\n{'':<62}· {e}"

        print(f"{name:<22}{cost:>8.2f}{cost-BASELINE:>8.2f}{srch:>6}{otok:>10,}{turns:>7}  {status}")

    print("─" * 78)
    print(f"{'total':<22}{total:>8.2f}{total-BASELINE*len(files):>8.2f}")
    print(f"\nnet$ subtracts ${BASELINE:.2f}/run of system-prompt caching overhead.")
    print("srch = WebSearch + WebFetch, counted from the session transcript.")


if __name__ == "__main__":
    main()

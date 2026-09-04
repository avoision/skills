---
name: lodging-compare
description: Search and compare lodging options for a specific stay — hotels, short-let apartments, aparthotels, hostels — score each against liveability criteria, and return a ranked, opinionated comparison as JSON, a styled HTML report, or both. Use when a user or a calling agent needs to choose between places to stay for a given destination and dates. Accepts every parameter up front and asks only for what it cannot resolve. Read-only research: it never books, reserves, holds, or pays for anything. Research-heavy — a standard run makes 6-16 retrieval calls, takes 7-10 minutes and costs roughly $2.50 at Opus 5 API rates (about 40% of that on Sonnet 5, and usage-window share rather than dollars on a subscription); pass depth: quick for a cheaper run that skips the browser and returns estimated prices. Live pricing at standard depth and above needs a local browser (e.g. playwright-cli); without one the skill still runs but returns estimated prices and says so.
---

# Lodging Compare

Find candidate places to stay for a specific trip, score them against the criteria the caller actually cares about, and commit to a ranked opinion.

The value of this skill is not the search — it is the **assessment and the verdict**. Anyone can list hotels. This ranks them against stated criteria and says which one to book and why.

## Scope

**In scope:** discovering candidates across one or more accommodation types, researching neighbourhood and property quality, scoring against criteria, ranking, and reporting.

**Out of scope — do not attempt, and say so if asked:**
- Booking, reserving, holding, or paying for anything. This skill is read-only.
- Flights, trains, car hire, or any ground transport.
- Price monitoring over time. Every result is a snapshot at run time.
- Guaranteeing availability. Listings may sell out between research and booking.

## Parameters

Callers may pass any of these up front. Resolve each one in this order: **use what was passed → otherwise apply the default → otherwise ask.**

| Parameter | Type | Default | Notes |
| --- | --- | --- | --- |
| `destination` | string | — **required** | City and country, or a more specific area. Never guess this. |
| `checkin` / `checkout` | ISO date | — **required** | Never guess these. |
| `areas` | string[] | none | Neighbourhoods to focus on. Empty means search the whole destination. |
| `guests` | int | `2` | |
| `min_bedrooms` | int or `"any"` | `"any"` | `0` means studio acceptable. |
| `types` | string[] | `["short_let", "hotel"]` | Any of: `short_let`, `hotel`, `aparthotel`, `hostel`. See `references/sources.md` for what each covers. |
| `budget` | `{amount, currency, basis}` | none | `basis` is `"total"` or `"per_night"`. **Currency is required whenever an amount is given** — never assume USD. |
| `budget_flex` | float | `0.10` | Fraction over budget still worth showing. Over-budget results are included but flagged, never silently dropped. |
| `criteria` | string[] | the five below | See *Criteria*. |
| `depth` | string | `"standard"` | `quick`, `standard`, or `thorough`. See below. |
| `max_per_type` | int | set by `depth` | Candidates per accommodation type. Overrides the tier when passed. |
| `preferences` | string | none | Free text: must-have amenities, proximity to a specific address, accessibility needs. |
| `outputs` | string[] | context-sensitive — see below | `html`, `json`, or both. |
| `output_dir` | path | the user's Desktop | Only relevant when `html` is requested. |

### Asking for missing values

Only `destination`, `checkin`, and `checkout` are genuinely unresolvable — always ask for those if they are missing.

For everything else, **apply the default and state the assumption in the output** rather than blocking. When a human is clearly driving and the trip is high-stakes, it is fine to confirm budget and criteria in a single short message — but ask once, as one grouped question, never as a serial interrogation.

If a calling agent supplied the parameters, do not ask anything. Proceed on defaults and record them under `assumptions`.

### Choosing the output format

Resolve `outputs` by this rule, in order — do not improvise it per run:

1. **If the caller passed `outputs`, use it.** An explicit value always wins.
2. **Invoked by another agent → `["json"]`.** Agents cannot use a styled
   report, and writing one to disk they will not read is pure waste.
3. **Invoked by a human → `["html"]`.** The report is what a person came for.
4. **Genuinely ambiguous → `["json"]`.** It is the cheaper mistake, and a
   person can ask for the report in one follow-up.

State which format was chosen and why when it was not explicitly requested.

### Depth

`depth` is the single dial for how much work a run does. It changes **what the
skill does**, not just how many results it returns.

| | `quick` | `standard` | `thorough` |
| --- | --- | --- | --- |
| Candidates per type | 3 | 5 | 8 |
| Listing pages opened | none | contenders only | all candidates |
| Reviews read | none | only for property-level criteria | all candidates |
| Criteria searches per area | 1 | 1–2 | 2–3 |
| Pricing — short-let | estimates | **live quotes** | **live quotes** |
| Pricing — hotel | estimates | estimates | estimates |
| Browser used | no | yes | yes |

`quick` answers "roughly what are my options and what do they cost" — it works
entirely from search results and neighbourhood-level research, and does not
open a browser. Its prices are **estimates**, not quotes for the caller's
dates. Use it when the caller is orienting rather than deciding, or has said
cost matters.

`standard` and `thorough` fetch **live quotes for the actual dates** through a
local browser — for short-lets. This is the main reason they cost more, and
the main reason they are worth it: Airbnb totals swing hard with cleaning fees
and length-of-stay discounts, so an estimated nightly rate is close to useless
there.

**Hotel prices are always estimates, at every depth. This is by design, not a
gap.** Booking.com, Google Hotels, Kayak and Hotels.com all refuse dated
pricing to automated sessions — Google Hotels will even accept date parameters
and silently return rates for different dates, which is how a confident wrong
price gets shipped. Report hotel prices as `estimated`, say "around", and
raise `price_estimated`. A hotel's rack rate is one click away for the user;
what this skill uniquely provides is the assessment and the ranking.

`standard` is the default and the calibration the rest of this skill assumes.

`thorough` is for a decision being made now on a stay that matters — a long
trip, a large group, a tight constraint.

**Any explicitly passed parameter overrides the tier.** `depth: "quick"` with
`max_per_type: 6` returns six candidates and still skips listing pages and
reviews. Record the tier under `assumptions` whenever it was not passed.

## Criteria

The default five, used whenever the caller does not specify:

1. **Walkability**
2. **Safety**
3. **Distance to public transport**
4. **Proximity to restaurants**
5. **Noise level**

These are *liveability* criteria — they assume the guest will spend time in the neighbourhood. Callers may replace them entirely or add their own (proximity to a named venue, workspace quality, family-friendliness, quietness for shift sleepers).

**Cost is always assessed and always reported**, whether or not it appears in `criteria`.

### Let stay length inform the assessment

Derive nights from the dates and let it shape what you research. Do not treat every stay the same:

- **1–3 nights:** location relative to the trip's purpose dominates. Kitchen, laundry, and long-stay comfort barely matter.
- **4–13 nights:** the default five are well calibrated for this range.
- **14+ nights:** research kitchen quality, laundry, workspace, and monthly or weekly discounts, which materially change the real cost. Note them even if not asked.

## Research process

### Step 0 — Announce the run

Before doing any work, state in one line what the run will do: depth, types,
areas, output format, and the rough number of retrieval calls it implies.

> Standard depth across short-let and hotels in 2 areas, HTML report —
> roughly 10 retrieval calls, about 8 minutes, around $2.50 of Opus tokens.
> Say "quick" for a cheaper run with estimated prices instead of live quotes.

**If no local browser was found, say so in the same line** — "no browser
available, prices will be estimates rather than quotes for your dates." A
caller who can fix that deserves the chance; one who cannot deserves to know
the results are weaker.

**This is a notice, not a prompt. Do not wait for a reply.** Proceed straight
into Step 1. A human who wants a cheaper run can interrupt; an agent reads the
line and carries on.

### Step 1 — Gather candidates per type

Run one search per requested type and collect up to `max_per_type` candidates each. Use `references/sources.md` for per-type search strategies and their fallbacks.

Where a browser is available, use it for sites that need it. Where it is not, or where a site blocks automation, fall back to web search — a thinner result set is far better than a failed run.

For every candidate collect: name, neighbourhood, price (nightly and stay total), currency, rating and review count, capacity (guests / bedrooms / beds), notable amenities, and a URL.

### Step 2 — Filter and flag

Drop candidates that fail a hard constraint (capacity below `guests`, bedrooms below `min_bedrooms`).

Do **not** drop candidates for being over budget. Include anything within `budget_flex` and flag it clearly. Beyond that threshold, exclude — but if a standout option is excluded on price alone, mention it in a single line so the caller can decide.

### Step 3 — Assess against criteria

Most criteria are **neighbourhood-level, not per-property**. One good search per area usually covers every candidate in it. Do not open every listing URL.

Property-level criteria (noise from a specific street, a specific unit's workspace) come from reviews — read them when a criterion depends on the property rather than the area.

Score qualitative criteria out of 5. Report distances and times as actual values ("6 min walk to Metro"), not scores.

**Where reliable data cannot be found, say so explicitly. Never invent a score.**

### Step 4 — Rank by fit, not by price

Rank candidates by how well they satisfy the stated criteria. Price is one input among them, not the sort key. A cheaper place that fails on two criteria ranks below a pricier one that satisfies all five.

Where two options are genuinely close, say so and name the trade-off rather than manufacturing a distinction.

### Step 5 — Write the verdict

Per candidate, 3–5 sentences: what and where it is, how it fares on each criterion, and who it suits best.

Per type, a section pick with the reasoning.

Across all types, a **cross-type verdict** that names the single best overall option and why, states the central trade-off between the types (space and kitchen versus service and amenities, typically), and names the best value option.

Be direct and opinionated throughout. A hedged non-answer is a failed run.

## Degradation

**Never fail the whole run because one part failed.** If a source blocks, a search returns nothing, or a criterion cannot be researched:

- Return everything that did succeed.
- Record what failed and why under `warnings`, and surface it visibly in the HTML report.
- Never present a thin result set as if it were complete.

A run that returns hotels, says "short-let search was blocked by bot detection," and ranks what it has is a **success**. A run that quietly returns three hotels and implies that is the whole market is a failure.

## Cost

**This skill is not cheap to run.** Measured 2026-08-27, two types, two areas,
six nights, on **Claude Opus 5**.

Read the retrieval calls, output tokens, and minutes as the real figures —
they hold across models and price changes. The dollars are `total_cost_usd`
priced at API list rates for Opus 5, which is the top of the table: the same
run on Sonnet 5 prices at roughly 40% of it. And on a Pro or Max subscription
nobody is billed per token at all — what a run actually spends there is
**usage-window share**, and these are heavy enough runs to notice.

With a local browser (the normal path — live short-let quotes):

| Depth · output | Retrieval | Shell calls | Out tok | Time | Net cost |
| --- | --- | --- | --- | --- | --- |
| standard · JSON | 6 | 22 | 34k | 9 min | $2.31 |
| standard · HTML | 11 | 21 | 27k | 7 min | $2.36 |

Without one (no browser, or a source blocked — prices come back estimated):

| Depth · output | Retrieval | Shell calls | Out tok | Time | Net cost |
| --- | --- | --- | --- | --- | --- |
| standard · JSON | 15–16 | 2–4 | 23–26k | 5–6 min | $1.13–1.30 |
| quick · HTML | 4 | 16 | 35k | 9 min | $2.31 |

**Budget roughly $2.50 for a standard run on Opus, ~$1 on Sonnet**, and about
half that again if no browser is available. Net figures subtract $0.34/run of
fixed system-prompt caching overhead.

The spend is dominated by replaying context, not by the research: of the $2.70
gross on the HTML run, ~$0.91 was cache reads (1.8M tokens), ~$0.81 cache
writes, and ~$0.68 output. That is why bounding the browser hunt cut the cost
so sharply, and why the model chosen moves it more than anything this skill
does.

**The HTML report is close to free.** JSON $2.31 against HTML $2.36 on the
same depth and the same browser path. An earlier reading claimed HTML cost
around six times JSON; that was wrong — it compared against a run that burned
64 of its 70 shell calls hunting for browser tooling. Copying
`references/report-template.html` verbatim, rather than designing a page, is
what keeps the report cheap. Do not redesign it.

**The single largest cost is looking for browser tooling in the wrong
places.** That worst run cost $6.83 and took 25 minutes — nearly triple
everything above — while the binary sat on `PATH` the whole time.
`references/sources.md` reduces this to three checks; obey them and stop.

**Never fetch an Airbnb URL server-side** (`WebFetch` in Claude Code). It is
always HTTP 403, and treating that as site-wide bot detection sends the whole
run down the fallback path for no reason. A local browser returns listings
immediately.

`depth: quick` skips the browser and the live-quote step entirely, which is the
right first answer to any cost concern. Its measured $2.31 predates the browser
fix, so the saving against a current standard run is not yet quantified —
expect it to be smaller than the two thirds once claimed here.

`types` and the length of `areas` scale linearly on top of all of it.

*Two destinations, one machine, one night, Opus 5, 2026-08-27. Treat as an
order of magnitude, not a quote.*

## Output

Always report, in whatever format is requested:

- The resolved parameters, including every applied default under `assumptions`
- Ranked candidates grouped by type, each with prices, criteria scores, summary, and URL
- Section picks and the cross-type verdict
- Any `warnings`

For the JSON shape, field rules, and enums, see `references/output-schema.md`. JSON is emitted inline as the return value, not written to a file.
For the HTML report — visual design, card structure, and the saved-listings panel — see `references/html-report.md`.

When HTML is written, save it to `output_dir` as `lodging-[destination-slug]-YYYY-MM-DD-HHmm.html` and tell the caller the full path plus the single top pick in one line.

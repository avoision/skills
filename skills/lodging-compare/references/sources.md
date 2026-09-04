# Source strategies per accommodation type

One search per requested type. Every strategy has a fallback — if the primary
source blocks or returns nothing, use the fallback and record a warning.
Never let a blocked source end the run.

## short_let

**Never fetch an Airbnb URL with a server-side fetcher** — `WebFetch` in
Claude Code, or whatever the equivalent is called in your harness. It returns
HTTP 403 every time; Airbnb blocks fetches that originate from a datacentre.
No amount of dwelling, scrolling, or retrying changes this, and the 403 says
nothing about whether the site is reachable from the machine you are running
on. It is always a wasted call.

**A local browser works immediately.** Measured 2026-08-27 from a residential
connection: `playwright-cli` returned 24 listing cards with **zero** dwell,
no scrolling, and no block signals. Plain `curl` returned HTTP 200 on the same
URL in the same minute. Prefer the browser and expect it to work.

**At `depth: quick`, skip the browser entirely** and take prices from search
results, flagged `estimated`. The browser is what `standard` and `thorough`
are paying for.

### Finding a browser — three checks, then stop

1. `command -v playwright-cli`, or any other browser driver on `PATH`
2. a browser-driving skill available in this session (`playwright-cli`)
3. browser tools exposed by MCP (`claude-in-chrome`)

First hit wins; use it and move on. If all three miss, go straight to the
fallback below and record a `source_blocked` warning.

**Do not** install anything with `npm`/`npx`, search the filesystem for
browser caches, go reading a browser tool's documentation to decide *whether* to use it
(checking its syntax once you have chosen it is fine), or substitute `curl`
for a browser. One measured run spent
**64 shell calls** doing exactly that — including checking `~/.cache/
ms-playwright`, which is the wrong path on macOS — and found only what these
three checks would have found in three.

### Searching

    https://www.airbnb.com/s/CITY--COUNTRY/homes?checkin=YYYY-MM-DD&checkout=YYYY-MM-DD&adults=N&min_bedrooms=N

Apply a price filter through the Filters UI when a budget is given, and wait
for results to reload before scraping. Collect from each results card: title,
neighbourhood, nightly price, stay total, host badge, rating, review count,
bed/bedroom count, URL.

If bed counts are missing from the cards, open individual listings only for
candidates that are otherwise in contention — not for all of them.

**An empty results container is not a block.** Airbnb renders results
client-side, so a page read too early looks empty while being perfectly
healthy. Scroll once and re-read before concluding anything.

**A real block** shows itself in the page text — a captcha prompt, an
"unusual traffic" notice, an access-denied page. Check the title and text
first; take a screenshot only if the text is genuinely ambiguous, and at most
once per source per run. A screenshot is a diagnostic, not a data source.

Once a genuine block is confirmed, fall back and do not retry.

### Fallback

Web search across Vrbo, Booking.com apartments, and local short-let agencies
for the destination. Note in `warnings` that pricing is indicative rather than
live. Booking.com property pages also refuse direct fetches, so treat search
results as the source there too.

## hotel

Primary: web search. Let budget and criteria determine the tier — do not
prescribe a star rating or a "boutique" style unless the caller asked for one.

    "best hotels [destination] [area] [month year]"
    "[destination] hotels near [landmark or venue from preferences]"

Pull prices from Booking.com, KAYAK, or Google Hotels for the actual dates.
Collect: name, neighbourhood, star rating, review score and count, stay
total, amenities, website URL.

**Dated hotel pricing is not obtainable — do not try.** Probed 2026-08-27/28:
Booking.com strips date parameters and redirects automated sessions to an
undated city page; Google Hotels keeps the parameters in the URL and ignores
them, returning rates for entirely different dates; Kayak and Hotels.com never
render. Driving Booking's date picker sets the dates correctly but the search
will not submit.

So: take a typical rate from search, set `price.basis` to `"estimated"`, word
it as "around $X", and raise a `price_estimated` warning. **Never present a
scraped hotel figure as a quote for the caller's dates** — the Google Hotels
failure mode makes that a confident lie rather than an honest approximation.

## aparthotel

One type covering the whole middle ground between a hotel and a short-let: an
apartment with a kitchen, operated by a company rather than a host. It spans
what different markets call **aparthotels** (front desk, nightly booking,
housekeeping — Adina, Citadines, Staybridge, Adagio), **serviced apartments**
(residential building, services bundled in, usually a minimum stay —
Blueground, Frasers, SACO), and **extended stay** in the US.

They are treated as one type deliberately. The distinction between them is
blurry and varies by country, and a caller almost never wants one but
specifically not the other. Search all three terms.

Primary: web search combining the terms with the destination, plus operators
active in that region.

    "aparthotel [destination]"
    "serviced apartments [destination] [month year]"
    "extended stay [destination]"          # US and Canada

Worth surfacing unprompted for stays of 14+ nights, where they often beat both
hotels and short-lets on price and practicality. Note any minimum stay — it is
the usual reason one of these turns out not to be bookable.

## hostel

Primary: Hostelworld and web search. Collect private-room rates as well as
dorm rates — a private room in a good hostel often competes directly with a
budget hotel.

Only include when the caller asked for this type. Do not add it on your own
initiative.

## Criteria research

Neighbourhood-level criteria (walkability, safety, transit, restaurants,
general noise) come from one search per area, not per property:

    "[area] [destination] neighbourhood guide safety walkability"
    "[area] [destination] nearest metro station"

Property-level criteria (street noise for a specific unit, workspace quality,
bed comfort) come from that property's reviews. Read reviews only when a
stated criterion actually depends on the property rather than the area.

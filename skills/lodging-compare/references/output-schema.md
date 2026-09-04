# JSON output

Emit only when `json` is in `outputs`. Emit it **inline** as a single fenced
`json` block and put nothing after that block — it is the return value, not an
illustration. When `html` is also requested, write the file as usual and
include its path in `report_path`.

## Shape

```json
{
  "schema_version": "1.0",
  "query": {
    "destination": "Lisbon, Portugal",
    "areas": ["Príncipe Real", "Alfama"],
    "checkin": "2026-09-14",
    "checkout": "2026-09-20",
    "nights": 6,
    "guests": 2,
    "min_bedrooms": 1,
    "types": ["short_let", "hotel"],
    "budget": { "amount": 1200, "currency": "EUR", "basis": "total" },
    "budget_flex": 0.10,
    "criteria": ["walkability", "safety", "transit", "restaurants", "noise"],
    "max_per_type": 5,
    "preferences": "quiet street, workspace"
  },
  "assumptions": [
    { "field": "guests", "value": 2, "reason": "not supplied; default applied" }
  ],
  "candidates": [
    {
      "id": 1,
      "type": "hotel",
      "rank": 1,
      "name": "Casa do Bairro",
      "neighbourhood": "Príncipe Real",
      "url": "https://...",
      "capacity": { "guests": 2, "bedrooms": 1, "beds": 1, "baths": 1 },
      "price": {
        "nightly": { "amount": 180, "currency": "EUR" },
        "total":   { "amount": 1080, "currency": "EUR" },
        "nights": 6,
        "basis": "live",
        "in_budget": true,
        "over_budget_pct": null
      },
      "rating": { "score": 9.1, "scale": 10, "count": 412, "source": "Booking.com" },
      "amenities": ["breakfast", "workspace", "air conditioning"],
      "criteria": [
        {
          "criterion": "transit",
          "score": 5,
          "value": "6 min walk to Rato (Yellow line)",
          "confidence": "high",
          "basis": "map_data",
          "note": "Direct to centre, no change"
        },
        {
          "criterion": "noise",
          "score": 2,
          "value": null,
          "confidence": "low",
          "basis": "guest_reviews",
          "note": "3 of 40 recent reviews mention street noise at weekends"
        },
        {
          "criterion": "cost",
          "score": 4,
          "value": "€1080 total · €180/night",
          "confidence": "high",
          "basis": "price_aggregator",
          "note": "10% under budget"
        }
      ],
      "summary": "Three to five sentences: what and where it is, how it fares on each criterion, and who it suits best."
    }
  ],
  "picks": {
    "overall": 1,
    "best_value": 4,
    "by_type": { "hotel": 1, "short_let": 4 }
  },
  "verdict": {
    "summary": "Why the overall pick wins.",
    "tradeoff": "The central trade-off between the types.",
    "best_value_reason": "Why the value pick is the value pick."
  },
  "warnings": [
    {
      "code": "source_blocked",
      "message": "Airbnb returned a bot-detection page; short-let results came from Vrbo and Booking.com apartments instead.",
      "affects": "short_let"
    }
  ],
  "report_path": "/Users/.../Desktop/lodging-lisbon-2026-08-26-1430.html"
}
```

## Field rules

**Every criterion carries all six fields.** `score` is an integer 1–5 or
`null`. Provide a score even where the natural answer is a measurement —
convert it ("6 min walk" → 5) so callers can sort and threshold uniformly,
and keep the real measurement in `value`.

`value` is the human-readable actual where one exists (a duration, a
distance, a price), otherwise `null`.

**`score: null` means the data could not be found.** It always requires a
`note` saying so, `confidence: "low"`, and `basis: "inference"` at most.
Never invent a score to avoid a null.

**A `cost` criterion is always present** on every candidate, whether or not
the caller listed it.

**`price.basis`** is `"live"` for a real quote for the actual dates, or
`"estimated"` when the price is typical rather than quoted. Estimated prices
also raise a `price_estimated` warning.

**`in_budget`** is `null` when no budget was given. `over_budget_pct` is
`null` unless the candidate is over — then it is the fraction over, and the
candidate must be within `budget_flex` to appear at all.

**`picks` reference candidate ids.** `by_type` covers only the types that
returned results.

**`assumptions` records every applied default**, so a caller can see what was
inferred rather than supplied.

**`id` is run-local.** It is a global counter across all types starting at 1,
matching the HTML report's `data-id`. It carries no meaning between runs — the
`url` is a candidate's only durable identity.

## Enums

| Field | Values |
| --- | --- |
| `type` | `short_let`, `hotel`, `aparthotel`, `hostel` |
| `price.basis` | `live`, `estimated` |
| `confidence` | `high`, `medium`, `low` |
| `basis` | `map_data`, `listing_page`, `guest_reviews`, `neighbourhood_guide`, `price_aggregator`, `inference` |
| `warnings[].code` | `source_blocked`, `no_results`, `partial_results`, `criterion_unresearched`, `price_estimated`, `budget_exclusion` |

`basis` describes what the judgment rests on. Use `inference` only when
nothing better was available, and pair it with `confidence: "low"`.

# HTML report

Only relevant when `html` is in `outputs`.

## Use the template

`references/report-template.html` is the house style — CSS, JavaScript, fonts,
and worked markup for the masthead, section headers, listing cards, and the
saved-listings panel.

**Copy it verbatim.** Same CSS, same class names, same script. Do not invent a
per-destination palette, do not pick different fonts, do not restyle the cards.
Consistency is the point: a reader who has seen one of these reports should
recognise the next one. Copying is also far cheaper than designing — the
template exists so a run spends its tokens on research and prose, not CSS.

The palette is dark navy and gold on ivory (Cormorant Garamond for display,
DM Sans for body). It ships as CSS custom properties at the top of the style
block; leave them alone.

Assemble the page as: masthead → a section per accommodation type, each ending
in a Section Pick → cross-type verdict → warnings → footer. Then the panel
script, unchanged, at the end.

**The saved-listings panel is for shortlisting only** — save, remove, clear.
It has no email, copy, or share action, and none should be added. Exporting a
shortlist is the user's or the calling agent's business; this skill produces
the comparison and stops there.

## What goes in the content

The template settles how it looks. These rules settle what it says.

**Lead criteria with the concrete value, not the dot scale.** Where a criterion
has a `value`, print the value: `~5 min · Lines 5, 9, 3, 8, 1` beats `●●●●○`.
Use dots only for criteria that are pure judgement with nothing concrete behind
them — noise, safety, general vibe. Ten rows of identical dots tell a reader
nothing; a walking time and a line number tell them everything.

**Be specific in the key-details line.** Bed configuration ("4 double beds"),
bathroom count, and every badge the source gives — Superhost *and* Guest
Favorite, not just one.

**Prices.** Stay total and nightly rate, with a strikethrough original where a
discount applies. Short-let prices at `standard` depth and above are live
quotes. **Hotel prices are always estimates** — word them "around $X · est. ·
not a quote" so they can never be mistaken for a booking price.

**Summaries should compare, not just describe.** The strongest lines are
cross-referential: "the best bathroom-to-bedroom ratio in this report", "the
only 4-bedroom listing within budget". Say where a candidate sits relative to
the others, not only what it is.

**Warnings are visible**, not buried in the footer — a blocked source or an
unresearched criterion belongs where the reader will see it.

**Footer** carries the generation timestamp, sources used, and a line stating
that prices and availability are a snapshot and nothing has been booked.

## Card data attributes

Every card needs these for the saved-listings panel:

```html
<article class="listing"
  data-section="Hotels"
  data-id="1"
  data-price="$600"
  data-title="Property Name Here">
```

`data-id` is a global counter across all sections — 1, 2, 3 … N — never
restarted per section.

# skills

Agent Skills for [Claude](https://claude.com/claude-code), packaged as an installable marketplace.

## Install

In Claude Code:

```
/plugin marketplace add avoision/skills
/plugin install vorpmi@avoision-skills
```

The `@avoision-skills` suffix is the marketplace name (from
`.claude-plugin/marketplace.json`), not the repo name.

To pin a tag instead of tracking `main`:

```
/plugin marketplace add avoision/skills@v1.0
```

Same thing from the shell, for scripting:

```bash
claude plugin marketplace add avoision/skills
claude plugin install vorpmi@avoision-skills
```

## Update and remove

```
/plugin marketplace update avoision-skills
/plugin marketplace remove avoision-skills
```

## Skills

| Skill | What it does |
| --- | --- |
| `vorpmi` | A short-form contrarian chat. Whatever you propose, the answer is no — the product is the manner of the refusal. |

## Repository layout

```
.claude-plugin/
  marketplace.json      # the catalog; this file is what makes the repo installable
skills/
  vorpmi/
    SKILL.md            # must be named exactly SKILL.md
```

Each entry under `plugins` in `marketplace.json` is a **bundle** users install as
a unit. Adding a skill means creating `skills/<name>/SKILL.md` and listing its
path in the relevant bundle's `skills` array.

## Using a skill without installing

Copy any skill directory into `~/.claude/skills/` (available everywhere) or a
project's `.claude/skills/` (committed and shared with that repo). Installing via
the marketplace is preferred — those skills update in place.

## License

MIT — see [LICENSE](LICENSE).

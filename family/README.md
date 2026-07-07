# family/ — the shared design-system skeleton

This directory is the shared design system for the PurplePincher domain
family. It is the one part of the Round 1 plan (`../ROUND_1_glm.md`)
that is high-confidence and does not depend on the still-open identity
questions being resolved first.

The plan lives in `ROUND_1_glm.md` Section 2 (visual identity) and
Section 3 (technical architecture). This README is the operator's
manual; the plan is the rationale.

## What's in here

| file | what it is |
|---|---|
| `tokens.css` | The shared `:root` custom-property palette: the ground palette + type system extracted verbatim from `purplepincher-landing-reference/src/landing.html`, plus named per-site accent variables (`--antifoul`, `--depth`, `--reef`) from the Round 1 Section 2 table. |
| `base.css` | The shared reset, type scale, and the load-bearing component shapes: `.eyebrow`, `.chain`/`.chain-step`, `.ledger`/`.ledger-row`, `.demo-card`, `.bar-list`. Extracted and generalized from `landing.html`. |
| `provenance-panel.css` + `provenance-panel.html` | The "what's real here" honesty component (persistent status line + per-element provenance tag). Drop-in partial for sites that need honesty framing. |

## How a family site uses this

**Inline at build time. Never fetch at runtime.**

The build-time-inline pattern is the load-bearing architectural
decision (Round 1 Section 3). Concretely, each site's build step
concatenates the shared CSS into that site's own `<style>` block (and
the shared HTML partials into the body) before the Worker is deployed.
The deployed artifact is then identical in shape to
`purplepincher-landing-reference/`: HTML imported as a `Text` module,
WASM as a `CompiledWasm` module, **CSP unchanged** (no provision for a
shared CSS host, no runtime fetch, no new origin in the perimeter).

Why inline rather than `<link>`:

- The existing CSP (`purplepincher-landing-reference/src/index.ts`)
  has `style-src 'self' 'unsafe-inline' ...` and no provision for a
  shared stylesheet host.
- Adding a shared CSS host to the CSP would weaken the honesty
  perimeter (the strict CSP is part of the honesty architecture, not a
  nicety) for no real benefit.
- Inlining keeps each deployed Worker hermetic — exactly the property
  that makes purplepincher checkable ("the demo IS the real crate";
  "the page IS the real HTML, nothing fetched").

A minimal build step is ~30 lines of Node (`build.mjs` per site, or a
shared script invoked per-site). It reads `tokens.css` + `base.css`
(+ `provenance-panel.css` on sites that need it), reads the site's own
`src/landing.html` template, and concatenates the shared `<style>`
into the site's `<style>` block and the partial into the body. The
*deployed* Worker shape is unchanged.

## Per-site accent swap

Each family site changes exactly one accent variable and adds exactly
one signature interactive surface (Round 1 Section 2: "the single rule
that keeps this from drifting"). The accent swap is done in the site's
own `:root`, overriding `--claw`:

```css
/* deckboss.net — site-level :root, after family/tokens.css is inlined */
:root {
  --claw: var(--antifoul);   /* anti-fouling bottom-paint oxide */
}
```

All existing `var(--claw)` references in `base.css` then pick up the
site's chosen accent automatically. The named accents (Round 1
Section 2 table):

| site | accent | variable |
|---|---|---|
| purplepincher.org | aubergine (reference, unchanged) | `--claw` (default) |
| deckboss.net | anti-fouling oxide | `--antifoul` `#B0533A` |
| cocapn.com | the water under the hull | `--depth` `#1F4A5C` |
| cocapn.ai | lattice cyan promoted to primary | `--lattice` (no new token) |
| superinstance.ai | warm coral / sand-rose | `--reef` `#D97A5C` *(see caveat)* |
| capitaine (placeholder) | `--depth` family, or TBD when real | TBD |

**superinstance.ai caveat:** the Round 1 plan named `--reef` for
superinstance.ai, but superinstance.ai already has its own real, live
visual identity on Cloudflare Pages (a green-on-black terminal
aesthetic) that differs from this family skeleton. `--reef` is kept
defined here for consistency with the plan, but superinstance.ai will
likely keep its existing palette rather than adopt the skeleton. If
that decision is confirmed permanent, `--reef` can be removed in a
later round.

## Variable reference (`tokens.css`)

Ground palette + type (verbatim from `landing.html`):

- `--ink` `#0E1A1C`, `--ink-deep` `#081113` — tidepool-teal backgrounds
- `--shell` `#F0E9D8`, `--shell-dim` `#C9C0AB` — warm bone foregrounds
- `--claw` `#A8548C`, `--claw-deep` `#7A3B5E` — purplepincher's aubergine (overridden per site)
- `--lattice` `#5FB4C7`, `--lattice-dim` `#3F8FA3` — the precision/lattice half of the duality
- `--hardened` `#D98B54` — the "earned the shell" highlight
- `--line` `rgba(240, 233, 216, 0.14)` — hairline divider color
- `--display` Fraunces, `--body` IBM Plex Sans, `--mono` IBM Plex Mono

Per-site accents: `--antifoul`, `--depth`, `--reef` (see table above).

## Class reference (`base.css`)

| class | purpose |
|---|---|
| `.wrap` | 920px content container with 28px gutters |
| `.eyebrow` | mono uppercase section label (lattice-colored) |
| `.chain` + `.chain-step` (+ `.chain-num`) | numbered horizontal sequence; order carries meaning |
| `.demo-card` | interactive-surface shell (grid: primary area + 260px sidebar); each site fills it with its signature surface |
| `.ledger` + `.ledger-row` (+ `.flagship`, `.ledger-name`, `.ledger-desc`, `.ledger-tag`, `.ledger-tag.hardened`) | registry of named things with optional tag |
| `.bar-list` | numbered criteria list with auto-counter |

## Provenance panel reference

Two pieces (see `provenance-panel.html` for the drop-in template):

- `.provenance-status` (+ `__word`, `__text`) — sticky persistent status line; one per page, near top of `<body>`. States the site's overall reality in one line. The persistence is the mechanism.
- `.provenance` (+ `--block` modifier) — inline provenance tag, attached to any element whose realness a visitor needs to know. Repeatable.

**Use on:** cocapn.com, cocapn.ai (and any future site whose load-bearing claim is "real but not yet a product" or "honest about what it is").
**Do NOT use on:** deckboss.net (real shipped product — the framing implies doubt where there is none), purplepincher.org.

## What this directory is NOT

- Not an npm package. Not a component library. Overkill for static HTML
  sites (Round 1 Section 3, "What I am explicitly not recommending").
- Not fetched at runtime. There is no runtime fetch path; the shared
  CSS exists only as build-time input.
- Not a monorepo config. Each site is its own Worker, its own
  `wrangler.jsonc`, its own route, its own deploy command. There is
  deliberately no `deploy-all`.
- Not the place to invent new identities. The capitaine identity, the
  deckboss.ai-vs-.net canonical question, the cocapn.ai-vs-.com merge
  question, and the lucineer question are all still open
  (`ROUND_1_glm.md` Section 5) and out of scope here.

## Open question noted in the plan

Whether this directory should be a public repo or private is itself an
open brand-posture question (`ROUND_1_glm.md` §5.8). The org publishes
everything checkable; making the design system public is consistent
with that and is itself a checkable claim ("this is the actual CSS the
family uses"). Lean public, but it's an org-owner call.

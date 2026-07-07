# cocapn.com · phase 1 · helm command-and-confirm simulation

A live, in-browser visualizer for the deterministic helm state machine
described in `SPEC_fable_phase1.md` §1 (5 states, 13 transitions). This is
a working prototype, not pseudocode — and not the shipped site.

## Run it

Open `demo.html` directly from disk. No build step.

```
# option A — just open the file
open demo.html            # macOS
xdg-open demo.html        # Linux
start demo.html           # Windows

# option B — serve it (only if your browser is picky about file://)
python3 -m http.server 8000
#   then visit http://localhost:8000/demo.html
```

There is nothing to install and no server is required. The FSM is loaded
with a plain `<script src="./state-machine.js">`; it attaches its
constructor to `window.cocapn`.

## Files

| file | role |
|---|---|
| `state-machine.ts` | canonical, type-checked source of the FSM. Edit here. |
| `state-machine.js` | type-stripped, browser-loadable companion of the above. What `demo.html` loads. Kept in lockstep by hand. |
| `types.ts` | single source of truth for event/body shapes. |
| `demo.html` | this prototype's UI. Inlines the family CSS verbatim. |
| `family/` | shared design system (`tokens.css`, `base.css`, `provenance-panel.css/.html`). Do not edit from here. |

## What you can drive

- **Voice presets:** `port ten`, `starboard five`, `belay` (C1 path +
  cancel), plus `deck red` / `course 045` (C2, requires confirmation) and
  `confirm`, `query heading`.
- **`auto`:** wired to the **T10 physical helm override** (see judgment
  call #2), which is the only way to reach the `LOCKOUT` state from the
  UI.
- **Free-text input:** type any phrase. The closed grammar accepts digit
  forms (`port 10`, `starboard 5`, `course 045`) — word forms like
  `port ten` deliberately fall through to the `T13` unmatched branch.
  That rigidity is the intended, honest behavior (see judgment call #1).

The sidebar shows current **state**, **heading**, **relay** (open/closed),
and **input** (enabled / locked out). The countdown bar reflects whichever
timer is active — `ttl` (500 ms), `confirm` (10 s), or `lockout` (10 s).
The ActiveLog pane lists every emitted event newest-first (capped at 60).

## Judgment calls

The brief invited these ("make a reasonable, stated judgment call and keep
going"). In order of how much they shape what you see:

1. **Preset labels are words; the grammar is digits.** The briefed presets
   read `port ten` / `starboard five`, but `state-machine.js`'s parser is
   `/^port (\d+)$/` — digit-only. Submitting the literal text "port ten"
   would hit the `T13` unmatched branch. So the buttons *display* the
   spoken phrase (`port ten`) and *submit* the canonical grammar token
   (`port 10`). The assistant echoes back in words via `numberToWord`, so
   the transcript still reads "port ten … complete." Free-text typists see
   the same rigidity: `port ten` typed does not parse; `port 10` does.
   This is the closed grammar being honest about itself, not a bug.
2. **`auto` → T10 physical override.** The brief lists `auto` as a preset,
   but `auto` has no production in the closed command grammar, so
   submitting it literally would always hit the `T13` unmatched branch
   (which looks broken, not illustrative). The closest marine-semantic
   action is an autopilot handoff, which in this FSM's safety model is the
   physical-override + 10 s lockout (T10/T11). Mapping `auto` there also
   makes the `LOCKOUT` state — a headline safety feature — reachable from
   the UI. The button is styled (oxide, not depth) and tooled to signal
   that it is a *control*, not a voice word.
3. **`lightingProvisioned: true` and `initialHeading: 045`.** So the C2
   lighting path (`deck red`) is exercisable and trim pulses produce
   visible, nautical-looking heading changes. `course 045` is also offered
   as a C2 trigger that does *not* need provisioning.
4. **Inlined `provenance-panel.css` too.** The brief named `tokens.css` +
   `base.css`, but `family/README.md` explicitly lists cocapn.com as the
   named consumer of the honesty component, so inlining it makes this a
   faithful preview of the real cocapn.com framing rather than a stripped
   one. Used the `.provenance-status` sticky line and a `.provenance--block`
   note on the demo card.
5. **One added token: `--claw-deep: #143746`.** `tokens.css` defines
   `--depth` but no depth-*deep* companion; hovers on depth-colored
   controls need a darker shade to stay coherent. Added in this page's
   `:root`, not in `family/`.
6. **Google Fonts `<link>` as progressive enhancement only.** The family
   type stack (Fraunces / IBM Plex) is loaded from Google Fonts when
   online and degrades to the Georgia / system / monospace fallbacks
   already named in `tokens.css` when offline. It is not a build or
   runtime-correctness dependency.
7. **Countdown bar is generic, not TTL-only.** The brief says "a TTL
   countdown bar." Because the FSM runs three different timers (TTL,
   confirm window, lockout) and only one is active at a time, the single
   bar reflects whichever is active, color-coded by kind. This shows more
   of the machine without adding chrome.
8. **ActiveLog capped at 60 entries, newest first.** Keeps the DOM bounded
   during long sessions; newest-on-top matches "live tail" expectations.

## What this is not

Not the cocapn.com site. Not an LLM demo. Not build infrastructure. It is
one interactive surface exercising a deterministic FSM, styled with the
family skeleton, honest about what it is.

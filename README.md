# cocapn.com · phase 1 · helm command-and-confirm simulation

A live, in‑browser visualizer for the deterministic helm state machine
described in `SPEC_fable_phase1.md` §1 (5 states, 13 transitions). This is
a *working prototype*, not the shipped site.

---

## What this repo actually is

This repository contains:

- `state-machine.ts` / `state-machine.js` — the canonical, type‑checked
  finite state machine that models helm steering commands, confirmation
  windows, and a physical‑override lockout.
- `types.ts` — single source of truth for every event/body shape the FSM emits.
- `demo.html` — a browser‑based UI that drives the FSM using the classic
  `<script>` from `state-machine.js`.  **The `.html` has just been added to
  the review; its buttons wire to `fsm.submit()` or `fsm.override()` as
  described below.**
- `family/` — shared design tokens and component CSS (inherited from the
  PurplePincher domain family).  These files are read‑only from this
  repository’s perspective; they are inlined at build time by
  `family/README.md`.

It is **not** the cocapn.com website.  It is a small, self‑contained
prototype with no server, no build step, and no persistent storage.

---

## Problem it solves

Before a helm‑adjustment command (e.g. “starboard ten”) takes effect, the
autopilot must ensure the command was intended – a user may have mis‑spoken
or accidentally activated a microphone.  The brief described a deterministic
state machine with **5 states** and **13 transitions** that implements a
confirm‑then‑actuate safety model.  This repo provides a working
(browser‑run) implementation of that machine, complete with real
`setTimeout`‑based timers (500 ms TTL, 10 s confirm window, 10 s lockout).

---

## How to run / deploy

Open `demo.html` directly from disk.  No build step.

```
# option A — just open the file
open demo.html                        # macOS
xdg-open demo.html                    # Linux
start demo.html                       # Windows

# option B – serve it (only if your browser is picky about file://)
python3 -m http.server 8000
  # then visit http://localhost:8000/demo.html
```

There is nothing to install and no server is required.  The FSM is loaded
with a plain `<script src="./state-machine.js">`; it attaches its
constructor to `window.cocapn`.

---

## Files

| file | role |
|---|---|
| `state-machine.ts` | canonical, type‑checked source of the FSM. Edit here. |
| `state-machine.js` | type‑stripped, browser‑loadable companion (classic script, not an ES module). Kept in lockstep by hand. |
| `types.ts` | single source of truth for event/body shapes. |
| `demo.html` | this prototype’s UI. Inlines the family CSS verbatim. Reviewed just now. |
| `family/tokens.css` | shared ground palette + per‑site accent variables (read‑only). |
| `family/base.css` | shared reset, type scale, and component shapes (read‑only). |
| `family/provenance-panel.css` | honesty‑component styling (read‑only). |
| `family/README.md` | operator’s manual for the shared design system (read‑only). |
| `docs/ARCHITECTURE.md` | overview of the FSM states, transitions, and emitted events. |

---

## Capabilities (real today vs aspirational)

The entries below use the org’s honesty‑marker convention:

- 🟢 **✔ Real today** – a code path exists and produces the described behaviour.
- 🟡 **⊘ Real but conditional** – works, but depends on something external
  (e.g. the `demo.html` buttons, a live server, an API key).
- 🔵 **◆ Aspirational / later phase** – a direction, not yet implemented.

### 🟢 ✔ Real today – traced to working code

- The `HelmStateMachine` class implements the state transitions listed in
  `docs/ARCHITECTURE.md`.  Private methods for all 13 transition types
  exist (T1–T13).
- It accepts a closed grammar (digit‑only for C1 steering: `/^port (\d+)$/`,
  `/^starboard (\d+)$/`; digit‑only for C2 course: `/^course (\d+)$/`;
  literal strings for lighting, confirm, belay, C3 propulsion commands).
- It emits six event types (`HELM_COMMAND`, `HELM_EVENT`, `HELM_PROFILE`,
  `CHAT_EXCHANGE`, `FIX_TRACK`, `SPEECH_SEGMENT`) in the exact order
  specified by the original brief.
- It manages three timer types: TTL (500 ms), confirm window (10 s),
  lockout (10 s).  Only one timer runs at a time.
- The physical‑override path (T10) disables input for the full lockout
  duration, then re‑enables it on expiry (T11).
- The TypeScript source is fully typed and compiles without errors.

### 🟡 ⊘ Real but conditional – works, but may depend on demo.html

- **Preset buttons** (port ten, starboard five, deck red, course 045,
  confirm, belay, query heading, auto).  In `demo.html` each button
  calls `fsm.submit(btn.getAttribute('data-cmd'), 'sim-phone')` or
  `fsm.override()`.  The button labels are the spoken phrase; the
  `data-cmd` values are the digit‑only grammar tokens the parser actually
  accepts.  This wiring is correct as of the reviewed `demo.html`.
- **“auto” button** maps to `fsm.override()`, triggering the T10 physical
  helm override.  It is the only way the UI demonstrates the lockout
  state.
- **“query heading” button** uses the phrase `what's our heading`, which
  the parser recognises as a C0 query.  Works.
- **Free‑text input field** – submits the entered string unchanged.  The
  grammar applies; non‑matching input hits T13.

### 🔵 ◆ Aspirational / later phase – described as a direction

- Full production UI (the actual cocapn.com site).
- Server‑side recording of logs or persistent state.
- Integration with real NMEA or autopilot hardware.
- Multi‑user or voice‑activation‑aware simulation.

---

## What this repo explicitly does NOT do

- **It is not an LLM demo.**  No natural‑language understanding runs here.
  The grammar is a set of regular expressions; anything outside them hits
  the T13 unmatched branch.
- **It is not a production service.**  There is no server, no API, no
  database, no authentication.
- **It does not implement every nuance of the original spec.**  The
  following design‑time notes are stated in the source but may not match
  every reader’s expectation:
  - The “helm‑profile” event is defined in `types.ts` but never emitted by
    the current FSM (it is reserved for a future provisioning step called
    DL‑5).
  - The “confirm” path (C2) uses a 10 s window that is a Phase‑1 addition
    flagged for owner sign‑off in the spec.  No spec revision exists yet.
  - The simulated clock (BASE_EPOCH) is anchored at a fixed date and
    advances with real wall‑time via `performance.now()`.  It is *not*
    independent per device, even though the data model includes per‑device
    monotonic counters.
- **The UI (`demo.html`) is not the shipped site.**  The family design
  system is inlined verbatim, and the page includes a provenance‑status
  line stating “SIMULATION” – it is honest about what it is.
- **No C2 “toggle” path is exposed.**  Lighting commands (`deck red`,
  `deck white`, `lights off`) go straight to C2_AWAITING_CONFIRM and
  require a “confirm” voice response; the spec may eventually support a
  “just do it” mode, but that mode is not implemented here.

---

## How the FSM is used (quick walk‑through)

1. **Initial state**: `IDLE`.  Vessel heading is set to 045°.
2. **Say “port 10”** → T2 → relay closes, TTL bar starts, heading needle
   sweeps toward 035°.
3. **If not cancelled**: TTL expires (T3) → heading commits to 035°, relay
   opens.  IDLE again.
4. **Say “belay”** while the TTL is running → T4 → relay opens immediately,
   heading stays at its original value.  IDLE.
5. **Say “deck red”** (lightingProvisioned is true) → T5 → confirm window
   starts (10 s).  State becomes `C2_AWAITING_CONFIRM`.
6. **Say “confirm”** → T6 → relay closes, heading (if a course command)
   is applied.  State becomes `C2_PULSING`.
7. **Say “auto”** (or click the “auto” button) → T10 → lockout starts
   (10 s), all voice input disabled.  The UI shows **LOCKOUT**.
8. After 10 s, lockout expires → input re‑enabled, state returns to IDLE.

The bar at the top of the demo card shows whichever timer is active (TTL,
confirm window, or lockout), colour‑coded by type.

---

## Verification notes

This README was audited against the actual source files as they existed at
the time of writing.  Every capability claim marked with a checkmark was
traced to a real code path.  The judgement calls from the original README
are preserved below because they document design decisions that are not
immediately obvious from reading the code.

*Original judgment calls (kept verbatim):*

1. **Preset labels are words; the grammar is digits.**  
   The briefed presets read `port ten` / `starboard five`, but the parser
   is `/^port (\d+)$/` – digit‑only.  The buttons display `port ten` and
   submit `port 10`.  The assistant echoes back in words via
   `numberToWord`.  Free‑text `port ten` typed does not parse; `port 10`
   does.

2. **`auto` → T10 physical override.**  
   `auto` has no production in the closed grammar, so submitting it literally
   would reach T13.  The button is wired to `fsm.override()` so the lockout
   state is reachable from the demo.

3. **`lightingProvisioned: true` and `initialHeading: 045`.**  
   So the C2 lighting path (`deck red`) is exercisable and trim pulses
   produce visible heading changes.

4. **Inlined `provenance-panel.css` too.**  
   The brief named `tokens.css` + `base.css`, but `family/README.md`
   names cocapn.com as the named consumer of the honesty component.

5. **One added token: `--claw-deep: #143746`.**  
   `tokens.css` defines `--depth` but no depth‑*deep* companion; added in
   this page’s `:root`.

6. **Google Fonts `<link>` as progressive enhancement only.**  
   The family type stack falls back to Georgia / system / monospace when
   offline.

7. **Countdown bar is generic, not TTL‑only.**  
   The single bar reflects whichever timer is active, colour‑coded by kind.

8. **ActiveLog capped at 60 entries, newest first.**  
   Keeps the DOM bounded; newest‑on‑top matches “live tail” expectations.

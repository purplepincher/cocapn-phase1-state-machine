# FSM Architecture

## Purpose

The `HelmStateMachine` implements a deterministic finite‑state machine
that models the helm‑command‑and‑confirm protocol described in
`SPEC_fable_phase1.md` §1.  It is written in TypeScript and compiled to
plain JavaScript for browser execution.

## States (as exposed by the code)

The `State` type in `state-machine.ts` defines five formal states:

| State | Meaning |
|---|---|
| `IDLE` | No command in progress; awaiting utterance. |
| `C1_PULSING` | A C1 (steering) command is being executed; the TTL countdown is running and the relay is closed. |
| `C2_AWAITING_CONFIRM` | A C2 command has been parsed, but the user must say “confirm” or “belay” before it takes effect. |
| `C2_PULSING` | A C2 command has been confirmed and is now being executed (TTL countdown, relay closed). |
| `LOCKOUT` | The physical helm override (T10) is active; all voice input is disabled.  The machine automatically returns to `IDLE` after 10 s. |

## Transitions

The machine implements the following numbered transitions (private methods
in `state-machine.ts`).  Not all 13 transitions from the original spec have
a dedicated method; the missing ones are handled implicitly by the `submit()`
dispatch logic.

| # | Trigger | Method | From | To |
|---|---|---|---|---|
| T1 | C0 query | `t1_c0_query` | IDLE | IDLE (no state change) |
| T2 | Valid C1 command parsed | `t2_c1_parsed` | IDLE | C1_PULSING |
| T3 | TTL expires (C1) | `t3_ttl_expired("C1")` | C1_PULSING | IDLE |
| T4 | “belay” while in C1_PULSING | `t4_belay("C1")` | C1_PULSING | IDLE |
| T5 | Valid C2 command parsed | `t5_c2_parsed` | IDLE | C2_AWAITING_CONFIRM |
| T6 | “confirm” while in C2_AWAITING_CONFIRM | `t6_confirm` | C2_AWAITING_CONFIRM | C2_PULSING |
| T7 | “belay” or confirm‑window timeout in C2_AWAITING_CONFIRM | `t7_cancelled` | C2_AWAITING_CONFIRM | IDLE |
| T8 | “belay” while in C2_PULSING | `t8_belay_c2` (calls `t4_belay("C2")`) | C2_PULSING | IDLE |
| T9 | TTL expires (C2) | `t3_ttl_expired("C2")` | C2_PULSING | IDLE |
| T10 | Physical helm override (e.g. “auto” button) | `t10_override` | any (except LOCKOUT) | LOCKOUT |
| T11 | Lockout timer expires | `t11_lockout_expired` | LOCKOUT | IDLE |
| T12 | C3 propulsion‑style command (throttle up, drop anchor, engage windlass) | `t12_c3` | IDLE | IDLE (rejected, no state change) |
| T13 | Unmatched utterance | `t13_unmatched` | any (except LOCKOUT) | same state |

## Events emitted

Every transition emits one or more of these event types (defined in
`types.ts`):

| Event type | Emitted by | Body shape |
|---|---|---|
| `SPEECH_SEGMENT` | T2, T4, T6, T8, T13 | `{text, mode:"command", conf}` |
| `HELM_COMMAND` | T1, T2, T3, T4, T5, T6, T7, T12 | `{profile, action, class, result, cancel_reason?, confirmed_by?}` |
| `HELM_EVENT` | T10, T11 | `{event_type, detail}` |
| `CHAT_EXCHANGE` | T1, T2, T3, T4, T5, T6, T7, T12, T13 | `{role, text}` |
| `FIX_TRACK` | T3, T9 | `{}` (empty body; state in envelope `fix`) |

Additionally the machine calls listener hooks:

- `onStateChange` – fired after every actual state transition (not for T1, T12, T13).
- `onTimerStart` / `onTimerEnd` – fired when a countdown starts or clears
  (natural expiry or manual cancellation).
- `onRelay` – fired when the contact‑closure relay opens or closes.
- `onPending` – fired when a pending actuation (target heading) is set.
- `onVesselState` – fired with current heading, COG, SOG (on each transition
  that updates the vessel).
- `onInputEnabled` – fired when input should be enabled (true) or locked out (false).

## Timers

| Timer | Duration | Used by |
|---|---|---|
| TTL | 500 ms | C1_PULSING, C2_PULSING |
| Confirm window | 10 s | C2_AWAITING_CONFIRM |
| Lockout | 10 s | LOCKOUT |

## Grammar support

The parser (inside `parsePhrase`) recognises:

- **C0 / C3** – literal strings (`"what's our heading"`, `"throttle up"`, etc.).
- **C1 steering** – `/^(port|starboard) (\d+)$/` (digit‑only; accepted values: 5, 10, 15, 20).
- **C2 course** – `/^course (\d+)$/` (digit‑only; values 0–359).
- **C2 lighting** – `"deck red"`, `"deck white"`, `"lights off"`.
- **Signals** – `"confirm"`, `"belay"`, `"belay that"`, `"cancel"`.

Anything else falls through to T13 (unmatched).

## Dependencies

None beyond plain TypeScript (for the `.ts` source) and the browser’s
runtime (for the `.js` companion).  The compiled `.js` file is standalone.

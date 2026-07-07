/*
  state-machine.ts
  -------------------------------------------------------------------
  The 5-state, 13-transition command-and-confirm FSM from
  SPEC_fable_phase1.md §1, implemented against the real command classes
  (C0..C3), the real TTL/lockout values from SAFETY.md (500 ms / 10 s),
  and the proposed 10 s confirm-window (a Phase-1 addition the spec flags
  for owner sign-off).

  This module is deterministic. No LLM. No network. Every arrow in the
  transition table is a real function with the trigger + guard logic the
  spec describes, using real setTimeout-based timers — not stubs and not
  instant fake transitions.

  States (§1.1): IDLE, C1_PULSING, C2_AWAITING_CONFIRM, C2_PULSING, LOCKOUT
  Transitions (§1.4): T1..T13 — see each function's docstring for the
    spec row it implements.

  ----------------------------------------------------------------------
  JUDGMENT CALLS (stated, not silent — per task brief's instruction):
    [J1] Profile name for C1 trim commands. The spec uses `profile` as a
         body field but only pins its value for the lighting case
         ("lighting-relay-2ch" in §2.1). For C1 trim I use
         "helm-trim-default"; for C2 course-mode I use "helm-course-default".
         These names are constants at the bottom of this file — change in
         one place if the schema owner rules otherwise.
    [J2] Lighting gating in §1's demo. The spec ties lighting C2 commands
         (deck_red/white/off) to whether §2's provisioning tree has saved
         the profile. §2 isn't built here; I expose a public method
         `setLightingProvisioned(bool)` so the demo can flip the gate (and
         so a future §2 caller can flip it for real at DL-5).
    [J3] Device-id split for helm.command. Spec §3.2 recommends splitting
         emission between sim-phone (received/awaiting_confirm half) and
         sim-helm (executed/rejected half) and flags it as a proposal.
         I implement that split. Change in `emitHelmCommand()` if the
         schema owner rules all helm.command events go on sim-helm.
    [J4] Simulated clock. Spec §3.1 says ts is "simulated UTC epoch ms —
         advance a fake clock, don't use Date.now() directly." I use a
         fake clock anchored at a fixed epoch (BASE_EPOCH) that advances
         with real elapsed wall time via performance.now(). This keeps
         replays deterministic-ish (same input timing → same ts sequence)
         while letting the demo actually run on real setTimeouts. `mono`
         reuses the same elapsed-ms value (each device would have its own
         oscillator in real hardware; here one clock is enough for the
         demo's honesty purposes).
    [J5] speech.segment's device. Spec §3.2 doesn't explicitly assign it.
         I put it on sim-phone (it's the voice/text input device).
    [J6] Heading math. port = turn to port (left, subtract degrees);
         starboard = turn to starboard (right, add degrees). Result
         normalized to 0..359. SAFETY.md doesn't explicitly state the
         sign convention but this matches universal helm practice.
*/

import {
  EventType,
  type ActiveLogEvent,
  type CancelReason,
  type ChatExchangeBody,
  type CommandClass,
  type DeviceId,
  type Fix,
  type FixTrackBody,
  type HelmCommandBody,
  type HelmEventBody,
  type HelmEventType,
  type SpeechSegmentBody,
} from "./types";

// ===========================================================================
// Constants — real values, from SAFETY.md (cited inline).
// ===========================================================================

/** Command TTL. SAFETY.md §2: "every actuation carries a TTL (default 500 ms)". */
export const TTL_MS = 500;

/** Override lockout. SAFETY.md §2: "enters a 10-second lockout when the human touches the real controls". */
export const LOCKOUT_MS = 10_000;

/** Confirm-window (C2 only). NOT in SAFETY.md — Phase-1 addition, flagged in §1.2. */
export const CONFIRM_WINDOW_MS = 10_000;

/** Fake-clock anchor: 2025-01-01T00:00:00Z. Deterministic starting epoch. */
const BASE_EPOCH = 1_735_689_600_000;

/** Profile names. See judgment call [J1]. */
const PROFILE_TRIM = "helm-trim-default";
const PROFILE_COURSE = "helm-course-default";
const PROFILE_LIGHTING = "lighting-relay-2ch";

// ===========================================================================
// Public types
// ===========================================================================

export type State =
  | "IDLE"
  | "C1_PULSING"
  | "C2_AWAITING_CONFIRM"
  | "C2_PULSING"
  | "LOCKOUT";

/** A parsed phrase from the closed grammar (§1.3). */
export interface ParsedPhrase {
  /** The grammar match outcome. "unmatched" → T13. */
  kind:
    | { type: "c0"; action: string }
    | { type: "c1"; action: string; profile: string; targetHeading: number }
    | { type: "c2_lighting"; action: string }
    | { type: "c2_course"; action: string; targetHeading: number }
    | { type: "c3"; action: string }
    | { type: "signal_confirm" }
    | { type: "signal_belay" }
    | { type: "unmatched"; raw: string };
}

export interface VesselState {
  /** Current committed heading (deg true, 0..359). Updates on T3/T9 completion. */
  heading: number;
  cog: number;
  sog: number;
}

/**
 * The pending actuation while in C1_PULSING or C2_PULSING. The UI animates
 * the heading needle from `vesselState.heading` toward `pending.targetHeading`
 * across the TTL window. On T3/T9 the committed heading advances; on T4/T8
 * it reverts (spec T4: "heading needle stops and reverts to last committed").
 */
export interface PendingActuation {
  targetHeading: number;
  startedAt: number; // performance.now() at T2/T6
  ttlMs: number;
  class: "C1" | "C2";
  action: string;
}

/** Side-effect callbacks the FSM fires. The demo wires these to DOM updates. */
export interface FSMListener {
  /** Fired after every state transition (not on same-state transitions like T1/T12/T13). */
  onStateChange?(state: State, prev: State): void;
  /** Fired for every emitted ActiveLogEvent, in emission order. */
  onEvent?(event: ActiveLogEvent): void;
  /** Fired when a countdown starts. ms is the configured duration (TTL_MS / CONFIRM_WINDOW_MS / LOCKOUT_MS). */
  onTimerStart?(kind: "ttl" | "confirm" | "lockout", ms: number): void;
  /** Fired when a countdown ends, either by expiring naturally or by being cleared (cancel/override). */
  onTimerEnd?(kind: "ttl" | "confirm" | "lockout", reason: "expired" | "cleared"): void;
  /** Fired when the relay contact should close (true) or open (false). Includes the transition that caused it. */
  onRelay?(closed: boolean, cause: "T2" | "T6" | "T3" | "T9" | "T4" | "T8" | "T10" | "T11"): void;
  /** Fired when the committed vessel state changes (heading moves on T3/T9). */
  onVesselState?(v: VesselState): void;
  /** Fired whenever a pending actuation starts (T2/T6) or ends (T3/T4/T8/T9/T10). null = no pending. */
  onPending?(pending: PendingActuation | null): void;
  /** Fired when input is enabled or disabled (LOCKOUT disables per T10, T11 re-enables). */
  onInputEnabled?(enabled: boolean): void;
}

// ===========================================================================
// The closed grammar (§1.3). Exact-match lookup; no fuzzy, no LLM.
// Returns a ParsedPhrase; the caller (the FSM) decides what to do with it
// based on current state.
// ===========================================================================

const TRIM_DEGREES = [5, 10, 15, 20] as const;

/** Normalize input: trim, lowercase, collapse internal whitespace. */
function normalize(raw: string): string {
  return raw.trim().toLowerCase().replace(/\s+/g, " ");
}

/**
 * Parse a raw input string against the closed grammar (§1.3).
 *
 * NOTE: this function does NOT consult current state — it returns the raw
 * grammar match. The caller decides whether the match is actionable in the
 * current state (e.g. lighting C2 phrases are only valid if the profile
 * has been provisioned; "confirm" is only meaningful in C2_AWAITING_CONFIRM).
 *
 * NOTE: this function does NOT consult the lighting provisioning gate.
 * Whether a c2_lighting phrase is reachable depends on session state and
 * is enforced in the transition logic, not here.
 */
export function parsePhrase(raw: string, currentHeading: number): ParsedPhrase {
  const s = normalize(raw);

  // --- C0: query ---
  if (s === "what's our heading" || s === "what's our heading?" || s === "whats our heading") {
    return { kind: { type: "c0", action: "query_heading" } };
  }

  // --- signals ---
  if (s === "confirm") return { kind: { type: "signal_confirm" } };
  if (s === "belay" || s === "belay that" || s === "cancel") {
    return { kind: { type: "signal_belay" } };
  }

  // --- C1: port / starboard <N> ---
  // grammar: N ∈ {5,10,15,20}
  const portMatch = /^port (\d+)$/.exec(s);
  if (portMatch) {
    const n = parseInt(portMatch[1], 10);
    if ((TRIM_DEGREES as readonly number[]).includes(n)) {
      return {
        kind: {
          type: "c1",
          action: `port_${n}`,
          profile: PROFILE_TRIM,
          targetHeading: (currentHeading - n + 360) % 360,
        },
      };
    }
  }
  const stbdMatch = /^starboard (\d+)$/.exec(s);
  if (stbdMatch) {
    const n = parseInt(stbdMatch[1], 10);
    if ((TRIM_DEGREES as readonly number[]).includes(n)) {
      return {
        kind: {
          type: "c1",
          action: `starboard_${n}`,
          profile: PROFILE_TRIM,
          targetHeading: (currentHeading + n) % 360,
        },
      };
    }
  }

  // --- C2: lighting (gating happens in transition logic, not here) ---
  if (s === "deck red" || s === "red lights") {
    return { kind: { type: "c2_lighting", action: "deck_red" } };
  }
  if (s === "deck white" || s === "white lights") {
    return { kind: { type: "c2_lighting", action: "deck_white" } };
  }
  if (s === "lights off") {
    return { kind: { type: "c2_lighting", action: "lights_off" } };
  }

  // --- C2: course <N> ---
  // grammar: N ∈ {0..359}
  const courseMatch = /^course (\d+)$/.exec(s);
  if (courseMatch) {
    const n = parseInt(courseMatch[1], 10);
    if (n >= 0 && n <= 359) {
      return {
        kind: {
          type: "c2_course",
          action: `course_${n}`,
          targetHeading: n,
        },
      };
    }
  }

  // --- C3: illustrative refusal set ---
  if (s === "throttle up" || s === "drop anchor" || s === "engage windlass") {
    return { kind: { type: "c3", action: s.replace(/\s+/g, "_") } };
  }

  // --- unmatched ---
  return { kind: { type: "unmatched", raw } };
}

// ===========================================================================
// The state machine
// ===========================================================================

export class HelmStateMachine {
  // ----- current state -----
  private state: State = "IDLE";
  private vessel: VesselState = { heading: 0, cog: 0, sog: 0 };
  private lightingProvisioned = false; // [J2] — gate for c2_lighting

  // ----- active command context (set on T2/T5/T6, cleared on return to IDLE) -----
  private activeProfile = "";
  private activeAction = "";
  private activeClass: CommandClass | null = null;
  private pendingHeading: number | null = null; // target during a pulse, or null

  // ----- timers (real setTimeout handles; one of each kind at most) -----
  private ttlTimer: ReturnType<typeof setTimeout> | null = null;
  private confirmTimer: ReturnType<typeof setTimeout> | null = null;
  private lockoutTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingActuation: PendingActuation | null = null;

  // ----- per-device seq counters (§3.2). Start at 0; first emit increments to 1. -----
  private seq: Record<DeviceId, number> = {
    "sim-phone": 0,
    "sim-helm": 0,
    "sim-cam": 0,
  };

  // ----- listener (single; the demo attaches one. Trivially extensible to a list.) -----
  private listener: FSMListener | null = null;

  // ----- fake clock origin (performance.now() at FSM construction) -----
  private readonly clockOrigin: number;

  constructor(opts?: { initialHeading?: number; lightingProvisioned?: boolean }) {
    this.clockOrigin = typeof performance !== "undefined" ? performance.now() : Date.now();
    if (opts?.initialHeading !== undefined) {
      const h = ((Math.round(opts.initialHeading) % 360) + 360) % 360;
      this.vessel.heading = h;
      this.vessel.cog = h;
    }
    if (opts?.lightingProvisioned) this.lightingProvisioned = true;
  }

  // ----- public: listener wiring -----
  setListener(l: FSMListener): void {
    this.listener = l;
  }

  // ----- public: provisioning gate (called by §2's DL-5 in the full site) -----
  setLightingProvisioned(v: boolean): void {
    this.lightingProvisioned = v;
  }
  isLightingProvisioned(): boolean {
    return this.lightingProvisioned;
  }

  // ----- public: read current state (for renderers) -----
  getState(): State {
    return this.state;
  }
  getVesselState(): VesselState {
    return { ...this.vessel };
  }
  getPending(): PendingActuation | null {
    return this.pendingActuation ? { ...this.pendingActuation } : null;
  }

  // =========================================================================
  // Fake clock — see [J4]. Returns simulated UTC ms. NOT Date.now().
  // =========================================================================
  private now(): number {
    const elapsed = (typeof performance !== "undefined" ? performance.now() : Date.now()) - this.clockOrigin;
    return BASE_EPOCH + Math.round(elapsed);
  }

  // =========================================================================
  // Envelope emission — assigns device id + seq per §3.2, fires onEvent.
  // =========================================================================

  /**
   * Emit an event. Per §3.2's device-assignment rules:
   *   - sim-phone: chat.exchange, speech.segment, and helm.command where
   *                result ∈ {"received","awaiting_confirm"}.
   *   - sim-helm:  helm.event, helm.command where result ∈ {"executed","rejected"},
   *                fix.track, helm.profile (would-be).
   *   - sim-cam:   media.frame.
   *
   * This routing is centralized here so [J3] (the device split proposal) is
   * a one-place change if the schema owner rules otherwise.
   */
  private emit(
    type: EventType,
    body: Record<string, unknown>,
    opts?: { fix?: Fix; forceDevice?: DeviceId; helmCommandResult?: string }
  ): ActiveLogEvent {
    let dev: DeviceId;
    if (opts?.forceDevice) {
      dev = opts.forceDevice;
    } else if (type === EventType.CHAT_EXCHANGE) {
      dev = "sim-phone";
    } else if (type === EventType.SPEECH_SEGMENT) {
      dev = "sim-phone"; // [J5]
    } else if (type === EventType.MEDIA_FRAME) {
      dev = "sim-cam";
    } else if (type === EventType.HELM_COMMAND) {
      const r = opts?.helmCommandResult;
      dev = r === "received" || r === "awaiting_confirm" ? "sim-phone" : "sim-helm"; // [J3]
    } else {
      // helm.event, fix.track, helm.profile → sim-helm
      dev = "sim-helm";
    }

    const seq = ++this.seq[dev];
    const ts = this.now();
    const event: ActiveLogEvent = {
      alv: 1,
      dev,
      seq,
      ts,
      mono: ts - BASE_EPOCH,
      type,
      body,
    };
    if (opts?.fix) event.fix = opts.fix;
    this.listener?.onEvent?.(event);
    return event;
  }

  // ----- body-typed emission helpers (keep the body shapes checkable) -----

  private emitSpeech(text: string, conf: number): void {
    const body: SpeechSegmentBody = { text, mode: "command", conf };
    this.emit(EventType.SPEECH_SEGMENT, body as unknown as Record<string, unknown>);
  }

  private emitHelmCommand(b: HelmCommandBody): void {
    this.emit(EventType.HELM_COMMAND, b as unknown as Record<string, unknown>, {
      helmCommandResult: b.result,
    });
  }

  private emitHelmEvent(event_type: HelmEventType, detail: string): void {
    const body: HelmEventBody = { event_type, detail };
    this.emit(EventType.HELM_EVENT, body as unknown as Record<string, unknown>);
  }

  private emitChat(role: "human" | "assistant", text: string): void {
    const body: ChatExchangeBody = { role, text };
    this.emit(EventType.CHAT_EXCHANGE, body as unknown as Record<string, unknown>);
  }

  private emitFixTrack(): void {
    const body: FixTrackBody = {};
    const fix: Fix = { cog: this.vessel.cog, sog: this.vessel.sog };
    this.emit(EventType.FIX_TRACK, body as unknown as Record<string, unknown>, { fix });
  }

  // =========================================================================
  // Timer plumbing
  // =========================================================================

  private clearTTL(reason: "expired" | "cleared"): void {
    if (this.ttlTimer !== null) {
      clearTimeout(this.ttlTimer);
      this.ttlTimer = null;
      this.listener?.onTimerEnd?.("ttl", reason);
    }
  }
  private clearConfirm(reason: "expired" | "cleared"): void {
    if (this.confirmTimer !== null) {
      clearTimeout(this.confirmTimer);
      this.confirmTimer = null;
      this.listener?.onTimerEnd?.("confirm", reason);
    }
  }
  private clearLockout(reason: "expired" | "cleared"): void {
    if (this.lockoutTimer !== null) {
      clearTimeout(this.lockoutTimer);
      this.lockoutTimer = null;
      this.listener?.onTimerEnd?.("lockout", reason);
    }
  }

  private startTTL(onExpire: () => void): void {
    this.clearTTL("cleared");
    this.ttlTimer = setTimeout(() => {
      this.ttlTimer = null;
      this.listener?.onTimerEnd?.("ttl", "expired");
      onExpire();
    }, TTL_MS);
    this.listener?.onTimerStart?.("ttl", TTL_MS);
  }

  private startConfirm(onExpire: () => void): void {
    this.clearConfirm("cleared");
    this.confirmTimer = setTimeout(() => {
      this.confirmTimer = null;
      this.listener?.onTimerEnd?.("confirm", "expired");
      onExpire();
    }, CONFIRM_WINDOW_MS);
    this.listener?.onTimerStart?.("confirm", CONFIRM_WINDOW_MS);
  }

  private startLockout(onExpire: () => void): void {
    this.clearLockout("cleared");
    this.lockoutTimer = setTimeout(() => {
      this.lockoutTimer = null;
      this.listener?.onTimerEnd?.("lockout", "expired");
      onExpire();
    }, LOCKOUT_MS);
    this.listener?.onTimerStart?.("lockout", LOCKOUT_MS);
  }

  // =========================================================================
  // State transitions
  // =========================================================================

  private setState(next: State): void {
    const prev = this.state;
    if (prev === next) return;
    this.state = next;
    this.listener?.onStateChange?.(next, prev);
  }

  private setPending(p: PendingActuation | null): void {
    this.pendingActuation = p;
    this.listener?.onPending?.(p);
  }

  private setRelay(closed: boolean, cause: "T2" | "T6" | "T3" | "T9" | "T4" | "T8" | "T10" | "T11"): void {
    this.listener?.onRelay?.(closed, cause);
  }

  /** Format a heading as a 3-digit spoken string, e.g. 7 → "007", 45 → "045". */
  private fmtHeading(h: number): string {
    return String(((Math.round(h) % 360) + 360) % 360).padStart(3, "0");
  }

  // ----- public: the main entry point. Drive the FSM with a raw input string. -----

  /**
   * Submit a raw phrase. This is the only public command-entry method.
   * Routes to the correct transition based on current state + parsed match.
   *
   * `confirmedBy` defaults to "sim-phone" (the demo's only input device).
   * In a real system this would be the device id of whatever produced the
   * confirm signal.
   */
  submit(raw: string, confirmedBy: DeviceId = "sim-phone"): void {
    // LOCKOUT rejects all input (T10's effect; spec §1.4 T10: "all command
    // input disabled"). We do NOT emit an unmatched event here — the
    // spec's LOCKOUT just absorbs input silently. (If you want a "locked
    // out" clarifying message, that's a UI choice, not an FSM event.)
    if (this.state === "LOCKOUT") return;

    const parsed = parsePhrase(raw, this.vessel.heading);
    const k = parsed.kind;

    switch (this.state) {
      case "IDLE":
        this.fromIdle(k, raw);
        break;
      case "C1_PULSING":
        this.fromC1Pulsing(k, raw);
        break;
      case "C2_AWAITING_CONFIRM":
        this.fromC2Awaiting(k, raw, confirmedBy);
        break;
      case "C2_PULSING":
        this.fromC2Pulsing(k, raw);
        break;
      case "LOCKOUT":
        return; // unreachable (handled above) but exhausts the switch
    }
  }

  // ----- public: T10. The override transition. Callable from ANY state. -----
  override(): void {
    this.t10_override();
  }

  // ----- public: reset everything (for "reset demo" buttons). -----
  reset(opts?: { initialHeading?: number; lightingProvisioned?: boolean }): void {
    this.clearTTL("cleared");
    this.clearConfirm("cleared");
    this.clearLockout("cleared");
    this.setState("IDLE");
    this.setPending(null);
    this.setRelay(false, "T11"); // open relay as part of reset; T11 cause is fine (input re-enabled)
    if (opts?.initialHeading !== undefined) {
      const h = ((Math.round(opts.initialHeading) % 360) + 360) % 360;
      this.vessel.heading = h;
      this.vessel.cog = h;
    }
    if (opts?.lightingProvisioned !== undefined) this.lightingProvisioned = opts.lightingProvisioned;
    this.activeProfile = "";
    this.activeAction = "";
    this.activeClass = null;
    this.pendingHeading = null;
    this.listener?.onVesselState?.(this.getVesselState());
    this.listener?.onInputEnabled?.(true);
  }

  // -------------------------------------------------------------------------
  // IDLE
  // -------------------------------------------------------------------------

  private fromIdle(k: ParsedPhrase["kind"], raw: string): void {
    switch (k.type) {
      case "c0":
        this.t1_c0_query(k.action);
        break;
      case "c1":
        this.t2_c1_parsed(k.action, k.profile, k.targetHeading, raw);
        break;
      case "c2_lighting":
        if (!this.lightingProvisioned) {
          // §1.4 T5 guard: lighting actions only reachable after DL-5.
          // Spec says treat as unmatched (T13).
          this.t13_unmatched(raw);
        } else {
          this.t5_c2_parsed(k.action, PROFILE_LIGHTING, null);
        }
        break;
      case "c2_course":
        this.t5_c2_parsed(k.action, PROFILE_COURSE, k.targetHeading);
        break;
      case "c3":
        this.t12_c3(k.action);
        break;
      case "signal_confirm":
        // "confirm" outside C2_AWAITING_CONFIRM is meaningless → unmatched.
        this.t13_unmatched(raw);
        break;
      case "signal_belay":
        // "belay" outside an active pulse is meaningless → unmatched.
        this.t13_unmatched(raw);
        break;
      case "unmatched":
        this.t13_unmatched(raw);
        break;
    }
  }

  // -------------------------------------------------------------------------
  // C1_PULSING — only belay/cancel and override are meaningful mid-pulse.
  // -------------------------------------------------------------------------

  private fromC1Pulsing(k: ParsedPhrase["kind"], raw: string): void {
    if (k.type === "signal_belay") {
      this.t4_belay("C1");
    } else {
      // Per spec's discipline: an input that's NOT belay while a TTL is
      // running is treated as unmatched, NOT as a new command — the
      // current pulse must resolve first. We do not pre-empt an actuating
      // command with a different one. Emit T13's clarifying shape.
      this.t13_unmatched(raw);
    }
  }

  // -------------------------------------------------------------------------
  // C2_AWAITING_CONFIRM — "confirm" advances (T6); belay or window-expiry
  // cancels (T7); anything else is unmatched (T13).
  // -------------------------------------------------------------------------

  private fromC2Awaiting(k: ParsedPhrase["kind"], raw: string, confirmedBy: DeviceId): void {
    if (k.type === "signal_confirm") {
      this.t6_confirm(confirmedBy);
    } else if (k.type === "signal_belay") {
      this.t7_cancelled("belay");
    } else {
      this.t13_unmatched(raw);
    }
  }

  // -------------------------------------------------------------------------
  // C2_PULSING — same as C1_PULSING but for class C2.
  // -------------------------------------------------------------------------

  private fromC2Pulsing(k: ParsedPhrase["kind"], raw: string): void {
    if (k.type === "signal_belay") {
      this.t8_belay_c2();
    } else {
      this.t13_unmatched(raw);
    }
  }

  // =========================================================================
  // The 13 transitions
  // =========================================================================

  /** T1 — C0 query, from IDLE. Stays IDLE. */
  private t1_c0_query(action: string): void {
    // Spec emits exactly two events, in order:
    this.emitHelmCommand({
      profile: PROFILE_TRIM, // C0 queries use the trim profile by convention; not pinned in spec.
      action,
      class: "C0",
      result: "executed",
    });
    this.emitChat(
      "assistant",
      `Heading is ${this.fmtHeading(this.vessel.heading)} degrees true. (GPS fix; cocapn reports, doesn't guarantee.)`
    );
    // No state change. No relay/TTL UI touched.
  }

  /** T2 — C1 command parsed, from IDLE → C1_PULSING. */
  private t2_c1_parsed(action: string, profile: string, targetHeading: number, raw: string): void {
    // Three events, in order:
    this.emitSpeech(raw, 1.0); // exact match → conf 1.0
    this.emitHelmCommand({ profile, action, class: "C1", result: "received" });
    this.emitChat("assistant", this.echoAction(action));

    // Side effects: relay closes, TTL starts, heading animation begins.
    this.activeProfile = profile;
    this.activeAction = action;
    this.activeClass = "C1";
    this.pendingHeading = targetHeading;
    this.setPending({
      targetHeading,
      startedAt: typeof performance !== "undefined" ? performance.now() : Date.now(),
      ttlMs: TTL_MS,
      class: "C1",
      action,
    });
    this.setRelay(true, "T2");
    this.startTTL(() => this.t3_ttl_expired("C1"));
    this.setState("C1_PULSING");
  }

  /** T3 — C1 TTL expires naturally. C1_PULSING → IDLE. */
  private t3_ttl_expired(cls: "C1" | "C2"): void {
    // Commit the pending heading as the new vessel state.
    if (this.pendingHeading !== null) {
      this.vessel.heading = this.pendingHeading;
      this.vessel.cog = this.pendingHeading;
    }
    const completedHeading = this.vessel.heading;

    // Three events, in order:
    this.emitHelmCommand({
      profile: this.activeProfile,
      action: this.activeAction,
      class: cls,
      result: "executed",
    });
    this.emitFixTrack(); // body empty; updated fix in envelope header
    this.emitChat("assistant", `${this.fmtHeading(completedHeading)}, complete.`);

    // Side effects: relay opens naturally, pending clears, vessel state advances.
    this.setRelay(false, cls === "C1" ? "T3" : "T9");
    this.setPending(null);
    this.listener?.onVesselState?.(this.getVesselState());
    this.activeProfile = "";
    this.activeAction = "";
    this.activeClass = null;
    this.pendingHeading = null;
    this.setState("IDLE");
  }

  /** T4 — belay during C1_PULSING. → IDLE immediately. */
  private t4_belay(cls: "C1" | "C2"): void {
    // Three events, in order:
    this.emitSpeech("belay", 1.0);
    this.emitHelmCommand({
      profile: this.activeProfile,
      action: this.activeAction,
      class: cls,
      result: "rejected",
      cancel_reason: "belay" as CancelReason,
    });
    this.emitChat("assistant", "Belay. Releasing contact closure. Heading unchanged.");

    // Side effects: relay snaps open (no drain), TTL cleared, heading reverts.
    this.clearTTL("cleared");
    this.setRelay(false, cls === "C1" ? "T4" : "T8");
    this.setPending(null);
    // Heading was NOT committed (T3 didn't fire); vessel.heading is unchanged.
    this.activeProfile = "";
    this.activeAction = "";
    this.activeClass = null;
    this.pendingHeading = null;
    this.setState("IDLE");
  }

  /** T5 — C2 command parsed, from IDLE → C2_AWAITING_CONFIRM. */
  private t5_c2_parsed(action: string, profile: string, targetHeading: number | null): void {
    // Two events, in order:
    this.emitHelmCommand({ profile, action, class: "C2", result: "awaiting_confirm" });
    this.emitChat(
      "assistant",
      `${this.friendlyAction(action)} requested. This is a mode change requiring confirmation. Say "confirm" to engage.`
    );

    // Side effects: confirm-window bar appears, confirm button appears, no relay/TTL touched.
    this.activeProfile = profile;
    this.activeAction = action;
    this.activeClass = "C2";
    this.pendingHeading = targetHeading; // for course changes; null for lighting
    this.startConfirm(() => this.t7_cancelled("timeout"));
    this.setState("C2_AWAITING_CONFIRM");
  }

  /** T6 — "confirm" received, from C2_AWAITING_CONFIRM → C2_PULSING. */
  private t6_confirm(confirmedBy: DeviceId): void {
    // Two events, in order:
    this.emitHelmCommand({
      profile: this.activeProfile,
      action: this.activeAction,
      class: "C2",
      result: "executed",
      confirmed_by: confirmedBy,
    });
    this.emitChat(
      "assistant",
      `${this.friendlyAction(this.activeAction)} engaged. Current heading ${this.fmtHeading(this.vessel.heading)}.`
    );

    // Side effects: confirm bar disappears, TTL bar begins, heading animates.
    this.clearConfirm("cleared");
    this.setPending({
      targetHeading: this.pendingHeading ?? this.vessel.heading,
      startedAt: typeof performance !== "undefined" ? performance.now() : Date.now(),
      ttlMs: TTL_MS,
      class: "C2",
      action: this.activeAction,
    });
    this.setRelay(true, "T6");
    this.startTTL(() => this.t3_ttl_expired("C2")); // T9 reuses T3's body with class C2
    this.setState("C2_PULSING");
  }

  /** T7 — confirm-window expires OR belay/cancel, from C2_AWAITING_CONFIRM → IDLE. */
  private t7_cancelled(reason: "timeout" | "belay"): void {
    // Two events, in order:
    this.emitHelmCommand({
      profile: this.activeProfile,
      action: this.activeAction,
      class: "C2",
      result: "rejected",
      cancel_reason: reason as CancelReason,
    });
    this.emitChat("assistant", `${this.friendlyAction(this.activeAction)} not confirmed. Standing by.`);

    // Side effects: confirm bar clears, no relay/TTL ever appeared.
    this.clearConfirm(reason === "belay" ? "cleared" : "expired");
    this.activeProfile = "";
    this.activeAction = "";
    this.activeClass = null;
    this.pendingHeading = null;
    this.setState("IDLE");
  }

  /** T8 — belay during C2_PULSING. Same shape as T4, class C2. */
  private t8_belay_c2(): void {
    this.t4_belay("C2");
  }

  // T9 — same as T3 with class C2. Implemented via startTTL callback in t6_confirm.

  /** T10 — override ("grab the wheel"), from ANY → LOCKOUT. The one pre-empting transition. */
  private t10_override(): void {
    // Spec: "human always outranks radio." Pre-empts everything else.
    // Clear any running timers instantly; if a relay was closed, open it.
    const wasPulsing = this.state === "C1_PULSING" || this.state === "C2_PULSING";
    const wasAwaiting = this.state === "C2_AWAITING_CONFIRM";
    this.clearTTL("cleared");
    this.clearConfirm("cleared");
    if (wasPulsing) {
      this.setRelay(false, "T10");
      this.setPending(null);
    }

    // Emit the override event (shape verbatim from aider's schema).
    this.emitHelmEvent(
      "override",
      "Captain touched physical helm controls. Helm outputs released for 10-second lockout."
    );

    // Clear active-command context (it's been pre-empted).
    this.activeProfile = "";
    this.activeAction = "";
    this.activeClass = null;
    this.pendingHeading = null;

    // Disable input + start the 10 s lockout.
    this.listener?.onInputEnabled?.(false);
    this.setState("LOCKOUT");
    this.startLockout(() => this.t11_lockout_expired());

    // Note: we do NOT emit a helm.command rejection here. The override is a
    // helm.event, not a command; spec T10 emits exactly one event. (If
    // wasAwaiting, the in-flight C2 command is silently dropped, NOT
    // logged as rejected — matching spec T10's silence on the topic.)
    void wasAwaiting;
  }

  /** T11 — lockout expires, LOCKOUT → IDLE. */
  private t11_lockout_expired(): void {
    this.emitHelmEvent(
      "link_restored",
      "BLE connection re-established after override lockout expired."
    );
    this.listener?.onInputEnabled?.(true);
    this.setState("IDLE");
  }

  /** T12 — C3 phrase, from IDLE. Stays IDLE. No relay/TTL UI ever touched. */
  private t12_c3(action: string): void {
    this.emitHelmCommand({
      profile: "propulsion", // not pinned in spec; "propulsion" matches C3's role per SAFETY.md
      action,
      class: "C3",
      result: "rejected",
    });
    this.emitChat(
      "assistant",
      `That's a class-C3 command — propulsion and irreversible actions are disabled by default in this design. Enabling one requires dockside setup, a physical enable switch on the Helm unit, and a per-command confirmation. Not something this sketch will simulate actuating.`
    );
  }

  /** T13 — unmatched input. Stays in current state. No helm.command emitted. */
  private t13_unmatched(raw: string): void {
    this.emitSpeech(raw, 0.0); // conf 0.0 = did not match
    // State-appropriate clarifying prompt:
    const prompt =
      this.state === "C2_AWAITING_CONFIRM"
        ? `I didn't catch "confirm" or "belay" — say one of those, or wait out the confirm window. (Awaiting confirmation for ${this.friendlyAction(this.activeAction)}.)`
        : `I didn't catch a command in that — try "port ten", "course 45", or "belay".`;
    this.emitChat("assistant", prompt);
  }

  // =========================================================================
  // Friendly-action phrasing (echo + chat turns). Small, deliberate.
  // =========================================================================

  /** "<echoed action, e.g. 'port ten'>" per spec T2. */
  private echoAction(action: string): string {
    // port_10 → "port ten"; starboard_5 → "starboard five"; course_45 → "course zero-four-five"
    const m = /^(port|starboard)_(\d+)$/.exec(action);
    if (m) return `${m[1]} ${this.numberToWord(parseInt(m[2], 10))}`;
    const c = /^course_(\d+)$/.exec(action);
    if (c) {
      const n = parseInt(c[1], 10);
      return `course ${String(n).padStart(3, "0")}`;
    }
    // lighting actions
    if (action === "deck_red") return "deck red";
    if (action === "deck_white") return "deck white";
    if (action === "lights_off") return "lights off";
    return action.replace(/_/g, " ");
  }

  /** Slightly friendlier than echoAction: "<action> requested/engaged." */
  private friendlyAction(action: string): string {
    const m = /^(port|starboard)_(\d+)$/.exec(action);
    if (m) return `${m[1]} ${this.numberToWord(parseInt(m[2], 10))}`;
    const c = /^course_(\d+)$/.exec(action);
    if (c) return `course ${String(parseInt(c[1], 10)).padStart(3, "0")}`;
    if (action === "deck_red") return "deck red";
    if (action === "deck_white") return "deck white";
    if (action === "lights_off") return "lights off";
    return action.replace(/_/g, " ");
  }

  private numberToWord(n: number): string {
    const words = ["zero", "five", "ten", "fifteen", "twenty"];
    const idx = [0, 5, 10, 15, 20].indexOf(n);
    return idx >= 0 ? words[idx] : String(n);
  }
}

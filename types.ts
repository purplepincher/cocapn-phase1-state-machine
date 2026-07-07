/*
  types.ts
  -------------------------------------------------------------------
  Single source of truth for every event shape the FSM emits.

  PER THE TASK BRIEF: the exact event-type names are being reconciled in a
  parallel task against aider's SIMULATED_VESSEL_SCHEMA.md. When that
  reconciliation lands, the rename happens HERE — every other file imports
  from this module, so a single edit propagates everywhere. Do not scatter
  type strings through the FSM or the demo.

  This file follows the spec's RECOMMENDED resolution (SPEC_fable_phase1.md
  §0.1, §0.2):
    - Do NOT extend helm.event's enum to cover command completion/cancellation.
      Instead emit a second helm.command for the same action with result:
      "executed" (pulse-complete) or "rejected" + cancel_reason (cancelled).
    - Add helm.profile as a sixth first-class body type (used only at DL-5
      in §2; included here for completeness even though §1's FSM doesn't
      emit it).
    - Replace kimi's invented mark.note with an ordinary chat.exchange
      {role:"human"} turn.

  All five unchanged body types match SIMULATED_VESSEL_SCHEMA.md verbatim
  (HelmCommandBody with one new optional field, HelmEventBody, MediaFrameBody,
  ChatExchangeBody, FixTrackBody).
*/

// ---------------------------------------------------------------------------
// Envelope-level type strings. These are the literal values that appear in
// the `type` field of every emitted ActiveLogEvent. Centralizing them as a
// const object gives both a TypeScript type (`EventType`) and a runtime
// value (`EventType.HELM_COMMAND`) — useful in the .js companion too.
// ---------------------------------------------------------------------------

export const EventType = {
  HELM_COMMAND: "helm.command",
  HELM_EVENT: "helm.event",
  HELM_PROFILE: "helm.profile", // NEW sixth type (§0.2), pending schema sign-off
  CHAT_EXCHANGE: "chat.exchange",
  MEDIA_FRAME: "media.frame",
  FIX_TRACK: "fix.track",
  SPEECH_SEGMENT: "speech.segment",
} as const;

export type EventType = (typeof EventType)[keyof typeof EventType];

// ---------------------------------------------------------------------------
// Enums / unions used inside bodies
// ---------------------------------------------------------------------------

export type CommandClass = "C0" | "C1" | "C2" | "C3";

// HelmCommandBody.result — unchanged from aider's schema. Per §0.1's
// resolution, this single field carries both "received the command" and
// "the command finished/cancelled" (no separate pulse_complete event).
export type CommandResult =
  | "received"
  | "awaiting_confirm"
  | "executed"
  | "rejected";

// Optional cancel_reason added to HelmCommandBody per §0.1. "override" is
// included speculatively — the FSM as written never emits a helm.command
// during T10 (override emits helm.event instead, per spec), but a future
// revision might want it; keeping the union complete here costs nothing.
export type CancelReason = "belay" | "timeout" | "override";

// HelmEventBody.event_type — unchanged from aider's schema. Per §0.1 we do
// NOT add "pulse_complete" / "command_cancelled" here.
export type HelmEventType =
  | "link_lost"
  | "link_restored"
  | "override"
  | "watchdog_trip"
  | "token_transfer";

// Device ids (SIMULATED_VESSEL_SCHEMA.md, three fixed devices).
export type DeviceId = "sim-phone" | "sim-helm" | "sim-cam";

// ---------------------------------------------------------------------------
// Fix — envelope-level vessel state. fix.track events carry an empty body;
// the state change lives in the envelope's `fix` field (per spec §1.4 T3).
// ---------------------------------------------------------------------------

export interface Fix {
  cog?: number; // heading over ground, degrees true (0..359)
  sog?: number; // speed over ground, knots
  lat?: number;
  lon?: number;
}

// ---------------------------------------------------------------------------
// Body shapes — five unchanged from aider's schema, one new.
// ---------------------------------------------------------------------------

// (1) HelmCommandBody — unchanged except for two NEW optional fields per §0.1:
//     cancel_reason (cancellation) and confirmed_by (C2 confirmation path).
//     Both optional, both backwards-compatible with the existing schema.
export interface HelmCommandBody {
  profile: string; // e.g. "helm-trim-default", "lighting-relay-2ch"
  action: string; // e.g. "port_10", "course_45", "deck_red"
  class: CommandClass;
  result: CommandResult;
  cancel_reason?: CancelReason; // present only when result === "rejected" via cancel
  confirmed_by?: string; // present only on C2 confirm path (T6)
}

// (2) HelmEventBody — unchanged, enum exactly as in aider's schema.
export interface HelmEventBody {
  event_type: HelmEventType;
  detail: string;
}

// (3) HelmProfileBody — NEW (§0.2 / §3.4). Used only by helm.profile events,
//     only emitted at DL-5 in §2.1. Phase 1's FSM (§1) does not emit it,
//     but the shape is defined here so the demo's ActiveLog pane can render
//     one if a future caller produces it.
export interface HelmProfileBody {
  profile: string;
  channels: number;
  fail_state: string;
}

// (4) ChatExchangeBody — unchanged.
export interface ChatExchangeBody {
  role: "human" | "assistant";
  text: string;
}

// (5) MediaFrameBody — unchanged. Phase 1's §1 FSM doesn't emit one; included
//     for completeness so the ActiveLog pane's renderer can type-check it.
export interface MediaFrameBody {
  sha256: string;
  uri: string;
  source: string;
  w: number;
  h: number;
  description: string;
}

// (6) FixTrackBody — empty, per spec ("fix.track's body is empty; the state
//     change lives in the envelope's `fix` field").
export interface FixTrackBody {}

// (7) SpeechSegmentBody — used by T2/T4/T8/T13 to log what was heard.
//     Phase 1 simplification: conf is 1.0 for exact grammar match, 0.0 for
//     unmatched. No real ASR. (This body shape is from kimi's script; if the
//     schema owner rules it's not first-class, the field set stays here and
//     only the EventType string above needs renaming.)
export interface SpeechSegmentBody {
  text: string;
  mode: "command";
  conf: number;
}

// ---------------------------------------------------------------------------
// Envelope — unchanged from SIMULATED_VESSEL_SCHEMA.md (§3.1).
// `additionalProperties: false` at the envelope level; `body` allows
// arbitrary keys per the real schema.
// ---------------------------------------------------------------------------

export interface ActiveLogEvent {
  alv: 1;
  dev: DeviceId;
  seq: number; // per-device monotonic counter, starts at 1, never reused
  ts: number; // simulated UTC epoch ms — fake clock, not Date.now()
  mono: number; // per-device monotonic ms (independent counter per device)
  type: EventType;
  fix?: Fix;
  body: Record<string, unknown>;
}

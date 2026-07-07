/*
  state-machine.js
  -------------------------------------------------------------------
  Type-stripped, browser-loadable companion to state-machine.ts.

  WHY BOTH FILES EXIST:
    state-machine.ts is the canonical, type-checked source — edit there.
    state-machine.js is what demo.html loads via <script src> so the
    prototype opens in a browser with NO BUILD STEP (Chrome blocks
    ES-module loading from file://; classic scripts work everywhere).

  The two files are kept in lockstep by hand. If you edit the .ts, run:
        npx tsc state-machine.ts --module ES2020 --target ES2020 \
          --moduleResolution bundler --strict
    to type-check, then mirror the runtime change into this .js. (tsc does
    emit a .js, but its module shape uses `export`, which fails on file://.
    This file attaches to window.cocapn instead — the only deliberate
    divergence from a verbatim tsc output.)

  Every comment in state-machine.ts applies here verbatim; this file is
  intentionally terse to keep the diff between the two files small.
*/

// The single runtime copy of EventType (mirrors types.ts). If the
// schema-reconciliation task renames a type string, edit BOTH this object
// and the const object in types.ts. They are the only two places.
var EventType = {
  HELM_COMMAND: "helm.command",
  HELM_EVENT: "helm.event",
  HELM_PROFILE: "helm.profile",
  CHAT_EXCHANGE: "chat.exchange",
  MEDIA_FRAME: "media.frame",
  FIX_TRACK: "fix.track",
  SPEECH_SEGMENT: "speech.segment",
};

var TTL_MS = 500;
var LOCKOUT_MS = 10000;
var CONFIRM_WINDOW_MS = 10000;
var BASE_EPOCH = 1735689600000; // 2025-01-01T00:00:00Z

var PROFILE_TRIM = "helm-trim-default";
var PROFILE_COURSE = "helm-course-default";
var PROFILE_LIGHTING = "lighting-relay-2ch";

var TRIM_DEGREES = [5, 10, 15, 20];

function normalize(raw) {
  return raw.trim().toLowerCase().replace(/\s+/g, " ");
}

function parsePhrase(raw, currentHeading) {
  var s = normalize(raw);

  if (s === "what's our heading" || s === "what's our heading?" || s === "whats our heading") {
    return { kind: { type: "c0", action: "query_heading" } };
  }
  if (s === "confirm") return { kind: { type: "signal_confirm" } };
  if (s === "belay" || s === "belay that" || s === "cancel") {
    return { kind: { type: "signal_belay" } };
  }

  var portMatch = /^port (\d+)$/.exec(s);
  if (portMatch) {
    var n = parseInt(portMatch[1], 10);
    if (TRIM_DEGREES.indexOf(n) >= 0) {
      return {
        kind: {
          type: "c1",
          action: "port_" + n,
          profile: PROFILE_TRIM,
          targetHeading: (currentHeading - n + 360) % 360,
        },
      };
    }
  }
  var stbdMatch = /^starboard (\d+)$/.exec(s);
  if (stbdMatch) {
    var n2 = parseInt(stbdMatch[1], 10);
    if (TRIM_DEGREES.indexOf(n2) >= 0) {
      return {
        kind: {
          type: "c1",
          action: "starboard_" + n2,
          profile: PROFILE_TRIM,
          targetHeading: (currentHeading + n2) % 360,
        },
      };
    }
  }

  if (s === "deck red" || s === "red lights") {
    return { kind: { type: "c2_lighting", action: "deck_red" } };
  }
  if (s === "deck white" || s === "white lights") {
    return { kind: { type: "c2_lighting", action: "deck_white" } };
  }
  if (s === "lights off") {
    return { kind: { type: "c2_lighting", action: "lights_off" } };
  }

  var courseMatch = /^course (\d+)$/.exec(s);
  if (courseMatch) {
    var cn = parseInt(courseMatch[1], 10);
    if (cn >= 0 && cn <= 359) {
      return {
        kind: { type: "c2_course", action: "course_" + cn, targetHeading: cn },
      };
    }
  }

  if (s === "throttle up" || s === "drop anchor" || s === "engage windlass") {
    return { kind: { type: "c3", action: s.replace(/\s+/g, "_") } };
  }

  return { kind: { type: "unmatched", raw: raw } };
}

function HelmStateMachine(opts) {
  opts = opts || {};
  this.state = "IDLE";
  this.vessel = { heading: 0, cog: 0, sog: 0 };
  this.lightingProvisioned = false;

  this.activeProfile = "";
  this.activeAction = "";
  this.activeClass = null;
  this.pendingHeading = null;

  this.ttlTimer = null;
  this.confirmTimer = null;
  this.lockoutTimer = null;
  this.pendingActuation = null;

  this.seq = { "sim-phone": 0, "sim-helm": 0, "sim-cam": 0 };
  this.listener = null;

  this.clockOrigin = typeof performance !== "undefined" ? performance.now() : Date.now();

  if (opts.initialHeading !== undefined) {
    var h = ((Math.round(opts.initialHeading) % 360) + 360) % 360;
    this.vessel.heading = h;
    this.vessel.cog = h;
  }
  if (opts.lightingProvisioned) this.lightingProvisioned = true;
}

HelmStateMachine.prototype.setListener = function (l) {
  this.listener = l;
};
HelmStateMachine.prototype.setLightingProvisioned = function (v) {
  this.lightingProvisioned = v;
};
HelmStateMachine.prototype.isLightingProvisioned = function () {
  return this.lightingProvisioned;
};
HelmStateMachine.prototype.getState = function () {
  return this.state;
};
HelmStateMachine.prototype.getVesselState = function () {
  return { heading: this.vessel.heading, cog: this.vessel.cog, sog: this.vessel.sog };
};
HelmStateMachine.prototype.getPending = function () {
  return this.pendingActuation ? Object.assign({}, this.pendingActuation) : null;
};

HelmStateMachine.prototype.now = function () {
  var elapsed =
    (typeof performance !== "undefined" ? performance.now() : Date.now()) - this.clockOrigin;
  return BASE_EPOCH + Math.round(elapsed);
};

HelmStateMachine.prototype.emit = function (type, body, opts) {
  opts = opts || {};
  var dev;
  if (opts.forceDevice) {
    dev = opts.forceDevice;
  } else if (type === EventType.CHAT_EXCHANGE) {
    dev = "sim-phone";
  } else if (type === EventType.SPEECH_SEGMENT) {
    dev = "sim-phone";
  } else if (type === EventType.MEDIA_FRAME) {
    dev = "sim-cam";
  } else if (type === EventType.HELM_COMMAND) {
    var r = opts.helmCommandResult;
    dev = r === "received" || r === "awaiting_confirm" ? "sim-phone" : "sim-helm";
  } else {
    dev = "sim-helm";
  }

  var seq = ++this.seq[dev];
  var ts = this.now();
  var event = { alv: 1, dev: dev, seq: seq, ts: ts, mono: ts - BASE_EPOCH, type: type, body: body };
  if (opts.fix) event.fix = opts.fix;
  if (this.listener && this.listener.onEvent) this.listener.onEvent(event);
  return event;
};

HelmStateMachine.prototype.emitSpeech = function (text, conf) {
  this.emit(EventType.SPEECH_SEGMENT, { text: text, mode: "command", conf: conf });
};
HelmStateMachine.prototype.emitHelmCommand = function (b) {
  this.emit(EventType.HELM_COMMAND, b, { helmCommandResult: b.result });
};
HelmStateMachine.prototype.emitHelmEvent = function (event_type, detail) {
  this.emit(EventType.HELM_EVENT, { event_type: event_type, detail: detail });
};
HelmStateMachine.prototype.emitChat = function (role, text) {
  this.emit(EventType.CHAT_EXCHANGE, { role: role, text: text });
};
HelmStateMachine.prototype.emitFixTrack = function () {
  this.emit(EventType.FIX_TRACK, {}, { fix: { cog: this.vessel.cog, sog: this.vessel.sog } });
};

HelmStateMachine.prototype.clearTTL = function (reason) {
  if (this.ttlTimer !== null) {
    clearTimeout(this.ttlTimer);
    this.ttlTimer = null;
    if (this.listener && this.listener.onTimerEnd) this.listener.onTimerEnd("ttl", reason);
  }
};
HelmStateMachine.prototype.clearConfirm = function (reason) {
  if (this.confirmTimer !== null) {
    clearTimeout(this.confirmTimer);
    this.confirmTimer = null;
    if (this.listener && this.listener.onTimerEnd) this.listener.onTimerEnd("confirm", reason);
  }
};
HelmStateMachine.prototype.clearLockout = function (reason) {
  if (this.lockoutTimer !== null) {
    clearTimeout(this.lockoutTimer);
    this.lockoutTimer = null;
    if (this.listener && this.listener.onTimerEnd) this.listener.onTimerEnd("lockout", reason);
  }
};
HelmStateMachine.prototype.startTTL = function (onExpire) {
  var self = this;
  this.clearTTL("cleared");
  this.ttlTimer = setTimeout(function () {
    self.ttlTimer = null;
    if (self.listener && self.listener.onTimerEnd) self.listener.onTimerEnd("ttl", "expired");
    onExpire();
  }, TTL_MS);
  if (this.listener && this.listener.onTimerStart) this.listener.onTimerStart("ttl", TTL_MS);
};
HelmStateMachine.prototype.startConfirm = function (onExpire) {
  var self = this;
  this.clearConfirm("cleared");
  this.confirmTimer = setTimeout(function () {
    self.confirmTimer = null;
    if (self.listener && self.listener.onTimerEnd) self.listener.onTimerEnd("confirm", "expired");
    onExpire();
  }, CONFIRM_WINDOW_MS);
  if (this.listener && this.listener.onTimerStart) this.listener.onTimerStart("confirm", CONFIRM_WINDOW_MS);
};
HelmStateMachine.prototype.startLockout = function (onExpire) {
  var self = this;
  this.clearLockout("cleared");
  this.lockoutTimer = setTimeout(function () {
    self.lockoutTimer = null;
    if (self.listener && self.listener.onTimerEnd) self.listener.onTimerEnd("lockout", "expired");
    onExpire();
  }, LOCKOUT_MS);
  if (this.listener && this.listener.onTimerStart) this.listener.onTimerStart("lockout", LOCKOUT_MS);
};

HelmStateMachine.prototype.setState = function (next) {
  var prev = this.state;
  if (prev === next) return;
  this.state = next;
  if (this.listener && this.listener.onStateChange) this.listener.onStateChange(next, prev);
};
HelmStateMachine.prototype.setPending = function (p) {
  this.pendingActuation = p;
  if (this.listener && this.listener.onPending) this.listener.onPending(p);
};
HelmStateMachine.prototype.setRelay = function (closed, cause) {
  if (this.listener && this.listener.onRelay) this.listener.onRelay(closed, cause);
};

HelmStateMachine.prototype.fmtHeading = function (h) {
  return String(((Math.round(h) % 360) + 360) % 360).padStart(3, "0");
};

HelmStateMachine.prototype.submit = function (raw, confirmedBy) {
  confirmedBy = confirmedBy || "sim-phone";
  if (this.state === "LOCKOUT") return;

  var parsed = parsePhrase(raw, this.vessel.heading);
  var k = parsed.kind;

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
      return;
  }
};

HelmStateMachine.prototype.override = function () {
  this.t10_override();
};

HelmStateMachine.prototype.reset = function (opts) {
  opts = opts || {};
  this.clearTTL("cleared");
  this.clearConfirm("cleared");
  this.clearLockout("cleared");
  this.setState("IDLE");
  this.setPending(null);
  this.setRelay(false, "T11");
  if (opts.initialHeading !== undefined) {
    var h = ((Math.round(opts.initialHeading) % 360) + 360) % 360;
    this.vessel.heading = h;
    this.vessel.cog = h;
  }
  if (opts.lightingProvisioned !== undefined) this.lightingProvisioned = opts.lightingProvisioned;
  this.activeProfile = "";
  this.activeAction = "";
  this.activeClass = null;
  this.pendingHeading = null;
  if (this.listener && this.listener.onVesselState) this.listener.onVesselState(this.getVesselState());
  if (this.listener && this.listener.onInputEnabled) this.listener.onInputEnabled(true);
};

HelmStateMachine.prototype.fromIdle = function (k, raw) {
  switch (k.type) {
    case "c0":
      this.t1_c0_query(k.action);
      break;
    case "c1":
      this.t2_c1_parsed(k.action, k.profile, k.targetHeading, raw);
      break;
    case "c2_lighting":
      if (!this.lightingProvisioned) {
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
      this.t13_unmatched(raw);
      break;
    case "signal_belay":
      this.t13_unmatched(raw);
      break;
    case "unmatched":
      this.t13_unmatched(raw);
      break;
  }
};

HelmStateMachine.prototype.fromC1Pulsing = function (k, raw) {
  if (k.type === "signal_belay") {
    this.t4_belay("C1");
  } else {
    this.t13_unmatched(raw);
  }
};

HelmStateMachine.prototype.fromC2Awaiting = function (k, raw, confirmedBy) {
  if (k.type === "signal_confirm") {
    this.t6_confirm(confirmedBy);
  } else if (k.type === "signal_belay") {
    this.t7_cancelled("belay");
  } else {
    this.t13_unmatched(raw);
  }
};

HelmStateMachine.prototype.fromC2Pulsing = function (k, raw) {
  if (k.type === "signal_belay") {
    this.t8_belay_c2();
  } else {
    this.t13_unmatched(raw);
  }
};

// --- the 13 transitions ---

HelmStateMachine.prototype.t1_c0_query = function (action) {
  this.emitHelmCommand({ profile: PROFILE_TRIM, action: action, class: "C0", result: "executed" });
  this.emitChat(
    "assistant",
    "Heading is " + this.fmtHeading(this.vessel.heading) + " degrees true. (GPS fix; cocapn reports, doesn't guarantee.)"
  );
};

HelmStateMachine.prototype.t2_c1_parsed = function (action, profile, targetHeading, raw) {
  this.emitSpeech(raw, 1.0);
  this.emitHelmCommand({ profile: profile, action: action, class: "C1", result: "received" });
  this.emitChat("assistant", this.echoAction(action));
  this.activeProfile = profile;
  this.activeAction = action;
  this.activeClass = "C1";
  this.pendingHeading = targetHeading;
  this.setPending({
    targetHeading: targetHeading,
    startedAt: typeof performance !== "undefined" ? performance.now() : Date.now(),
    ttlMs: TTL_MS,
    class: "C1",
    action: action,
  });
  this.setRelay(true, "T2");
  var self = this;
  this.startTTL(function () {
    self.t3_ttl_expired("C1");
  });
  this.setState("C1_PULSING");
};

HelmStateMachine.prototype.t3_ttl_expired = function (cls) {
  if (this.pendingHeading !== null) {
    this.vessel.heading = this.pendingHeading;
    this.vessel.cog = this.pendingHeading;
  }
  var completedHeading = this.vessel.heading;
  this.emitHelmCommand({
    profile: this.activeProfile,
    action: this.activeAction,
    class: cls,
    result: "executed",
  });
  this.emitFixTrack();
  this.emitChat("assistant", this.fmtHeading(completedHeading) + ", complete.");
  this.setRelay(false, cls === "C1" ? "T3" : "T9");
  this.setPending(null);
  if (this.listener && this.listener.onVesselState) this.listener.onVesselState(this.getVesselState());
  this.activeProfile = "";
  this.activeAction = "";
  this.activeClass = null;
  this.pendingHeading = null;
  this.setState("IDLE");
};

HelmStateMachine.prototype.t4_belay = function (cls) {
  this.emitSpeech("belay", 1.0);
  this.emitHelmCommand({
    profile: this.activeProfile,
    action: this.activeAction,
    class: cls,
    result: "rejected",
    cancel_reason: "belay",
  });
  this.emitChat("assistant", "Belay. Releasing contact closure. Heading unchanged.");
  this.clearTTL("cleared");
  this.setRelay(false, cls === "C1" ? "T4" : "T8");
  this.setPending(null);
  this.activeProfile = "";
  this.activeAction = "";
  this.activeClass = null;
  this.pendingHeading = null;
  this.setState("IDLE");
};

HelmStateMachine.prototype.t5_c2_parsed = function (action, profile, targetHeading) {
  this.emitHelmCommand({ profile: profile, action: action, class: "C2", result: "awaiting_confirm" });
  this.emitChat(
    "assistant",
    this.friendlyAction(action) +
      ' requested. This is a mode change requiring confirmation. Say "confirm" to engage.'
  );
  this.activeProfile = profile;
  this.activeAction = action;
  this.activeClass = "C2";
  this.pendingHeading = targetHeading;
  var self = this;
  this.startConfirm(function () {
    self.t7_cancelled("timeout");
  });
  this.setState("C2_AWAITING_CONFIRM");
};

HelmStateMachine.prototype.t6_confirm = function (confirmedBy) {
  this.emitHelmCommand({
    profile: this.activeProfile,
    action: this.activeAction,
    class: "C2",
    result: "executed",
    confirmed_by: confirmedBy,
  });
  this.emitChat(
    "assistant",
    this.friendlyAction(this.activeAction) +
      " engaged. Current heading " +
      this.fmtHeading(this.vessel.heading) +
      "."
  );
  this.clearConfirm("cleared");
  this.setPending({
    targetHeading: this.pendingHeading !== null ? this.pendingHeading : this.vessel.heading,
    startedAt: typeof performance !== "undefined" ? performance.now() : Date.now(),
    ttlMs: TTL_MS,
    class: "C2",
    action: this.activeAction,
  });
  this.setRelay(true, "T6");
  var self = this;
  this.startTTL(function () {
    self.t3_ttl_expired("C2");
  });
  this.setState("C2_PULSING");
};

HelmStateMachine.prototype.t7_cancelled = function (reason) {
  this.emitHelmCommand({
    profile: this.activeProfile,
    action: this.activeAction,
    class: "C2",
    result: "rejected",
    cancel_reason: reason,
  });
  this.emitChat("assistant", this.friendlyAction(this.activeAction) + " not confirmed. Standing by.");
  this.clearConfirm(reason === "belay" ? "cleared" : "expired");
  this.activeProfile = "";
  this.activeAction = "";
  this.activeClass = null;
  this.pendingHeading = null;
  this.setState("IDLE");
};

HelmStateMachine.prototype.t8_belay_c2 = function () {
  this.t4_belay("C2");
};

HelmStateMachine.prototype.t10_override = function () {
  var wasPulsing = this.state === "C1_PULSING" || this.state === "C2_PULSING";
  this.clearTTL("cleared");
  this.clearConfirm("cleared");
  if (wasPulsing) {
    this.setRelay(false, "T10");
    this.setPending(null);
  }
  this.emitHelmEvent(
    "override",
    "Captain touched physical helm controls. Helm outputs released for 10-second lockout."
  );
  this.activeProfile = "";
  this.activeAction = "";
  this.activeClass = null;
  this.pendingHeading = null;
  if (this.listener && this.listener.onInputEnabled) this.listener.onInputEnabled(false);
  this.setState("LOCKOUT");
  var self = this;
  this.startLockout(function () {
    self.t11_lockout_expired();
  });
};

HelmStateMachine.prototype.t11_lockout_expired = function () {
  this.emitHelmEvent(
    "link_restored",
    "BLE connection re-established after override lockout expired."
  );
  if (this.listener && this.listener.onInputEnabled) this.listener.onInputEnabled(true);
  this.setState("IDLE");
};

HelmStateMachine.prototype.t12_c3 = function (action) {
  this.emitHelmCommand({ profile: "propulsion", action: action, class: "C3", result: "rejected" });
  this.emitChat(
    "assistant",
    "That's a class-C3 command — propulsion and irreversible actions are disabled by default in this design. Enabling one requires dockside setup, a physical enable switch on the Helm unit, and a per-command confirmation. Not something this sketch will simulate actuating."
  );
};

HelmStateMachine.prototype.t13_unmatched = function (raw) {
  this.emitSpeech(raw, 0.0);
  var prompt =
    this.state === "C2_AWAITING_CONFIRM"
      ? 'I didn\'t catch "confirm" or "belay" — say one of those, or wait out the confirm window. (Awaiting confirmation for ' +
        this.friendlyAction(this.activeAction) +
        ".)"
      : 'I didn\'t catch a command in that — try "port ten", "course 45", or "belay".';
  this.emitChat("assistant", prompt);
};

HelmStateMachine.prototype.echoAction = function (action) {
  var m = /^(port|starboard)_(\d+)$/.exec(action);
  if (m) return m[1] + " " + this.numberToWord(parseInt(m[2], 10));
  var c = /^course_(\d+)$/.exec(action);
  if (c) return "course " + String(parseInt(c[1], 10)).padStart(3, "0");
  if (action === "deck_red") return "deck red";
  if (action === "deck_white") return "deck white";
  if (action === "lights_off") return "lights off";
  return action.replace(/_/g, " ");
};

HelmStateMachine.prototype.friendlyAction = function (action) {
  var m = /^(port|starboard)_(\d+)$/.exec(action);
  if (m) return m[1] + " " + this.numberToWord(parseInt(m[2], 10));
  var c = /^course_(\d+)$/.exec(action);
  if (c) return "course " + String(parseInt(c[1], 10)).padStart(3, "0");
  if (action === "deck_red") return "deck red";
  if (action === "deck_white") return "deck white";
  if (action === "lights_off") return "lights off";
  return action.replace(/_/g, " ");
};

HelmStateMachine.prototype.numberToWord = function (n) {
  var words = ["zero", "five", "ten", "fifteen", "twenty"];
  var idx = [0, 5, 10, 15, 20].indexOf(n);
  return idx >= 0 ? words[idx] : String(n);
};

// --- expose on a single global namespace so demo.html can use it. ---
window.cocapn = window.cocapn || {};
window.cocapn.HelmStateMachine = HelmStateMachine;
window.cocapn.parsePhrase = parsePhrase;
window.cocapn.EventType = EventType;
window.cocapn.TTL_MS = TTL_MS;
window.cocapn.LOCKOUT_MS = LOCKOUT_MS;
window.cocapn.CONFIRM_WINDOW_MS = CONFIRM_WINDOW_MS;

import { createHash } from "node:crypto";
import { appendFileSync, chmodSync, mkdirSync, openSync, closeSync } from "node:fs";
import { dirname } from "node:path";

import { parseEvaluationEvent, type EvaluationEvent } from "./types.ts";

const MAX_STRING_BYTES = 8_192;
const SECRET_KEYS = new Set([
  "authorization",
  "proxyauthorization",
  "apikey",
  "token",
  "idtoken",
  "accesstoken",
  "refreshtoken",
  "clientsecret",
  "secret",
  "password",
  "cookie",
  "setcookie",
]);
const INLINE_SECRET_PATTERNS: readonly [RegExp, string][] = [
  [/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, "Bearer [REDACTED]"],
  [/\b(?:sk-(?:live-|test-)?[A-Za-z0-9_-]{12,}|github_pat_[A-Za-z0-9_]{12,}|gh[pousr]_[A-Za-z0-9]{12,}|AKIA[A-Z0-9]{16})\b/g, "[REDACTED]"],
  [/\b((?:api[-_ ]?key|access[-_ ]?token|refresh[-_ ]?token|client[-_ ]?secret|password|cookie)\s*[:=]\s*)[^\s,;]+/gi, "$1[REDACTED]"],
];

export class EvaluationRecorder {
  readonly events: EvaluationEvent[] = [];
  readonly tracePath: string;
  private readonly trialId: string;
  private readonly now: () => string;
  private sequence = 0;
  private closed = false;

  constructor(trialId: string, tracePath: string, now: () => string = () => new Date().toISOString()) {
    this.trialId = trialId;
    this.tracePath = tracePath;
    this.now = now;
    mkdirSync(dirname(tracePath), { recursive: true, mode: 0o700 });
    const descriptor = openSync(tracePath, "wx", 0o600);
    closeSync(descriptor);
    chmodSync(tracePath, 0o600);
  }

  recordPrompt(phase: "readiness" | "approval", text: string): EvaluationEvent {
    return this.record("harness_prompt", {
      phase,
      text,
      contentHash: `sha256:${createHash("sha256").update(text, "utf8").digest("hex")}`,
      source: "harness",
    });
  }

  recordSessionEvent(event: Readonly<Record<string, unknown>>): EvaluationEvent {
    const kind = typeof event.type === "string" ? event.type : "unknown_session_event";
    const { type: _type, ...payload } = event;
    return this.record(kind, payload);
  }

  record(kind: string, payload: Readonly<Record<string, unknown>>): EvaluationEvent {
    if (this.closed) throw new Error("evaluation recorder is closed");
    const event = parseEvaluationEvent({
      schemaVersion: 1,
      trialId: this.trialId,
      sequence: this.sequence++,
      timestamp: this.now(),
      kind,
      payload: sanitize(payload),
    });
    appendFileSync(this.tracePath, `${JSON.stringify(event)}\n`, { encoding: "utf8", mode: 0o600 });
    this.events.push(event);
    return event;
  }

  close(): void {
    this.closed = true;
  }
}

function sanitize(value: unknown, key = "", seen = new WeakSet<object>()): unknown {
  if (SECRET_KEYS.has(key.replace(/[-_\s]/g, "").toLowerCase())) return "[REDACTED]";
  if (value === null || typeof value === "boolean" || typeof value === "number") return value;
  if (typeof value === "string") {
    const bytes = Buffer.byteLength(value, "utf8");
    const bounded = bytes <= MAX_STRING_BYTES ? value : `${Buffer.from(value).subarray(0, MAX_STRING_BYTES).toString("utf8")}[TRUNCATED:${bytes}]`;
    return INLINE_SECRET_PATTERNS.reduce((text, [pattern, replacement]) => text.replace(pattern, replacement), bounded);
  }
  if (typeof value === "bigint") return value.toString();
  if (typeof value !== "object") return String(value);
  if (seen.has(value)) return "[CIRCULAR]";
  seen.add(value);
  if (Array.isArray(value)) return value.map((item) => sanitize(item, key, seen));
  const result: Record<string, unknown> = {};
  for (const [childKey, childValue] of Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b, "en"))) {
    result[childKey] = sanitize(childValue, childKey, seen);
  }
  return result;
}

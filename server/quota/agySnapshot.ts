import { readFile, stat } from 'node:fs/promises';
import { isRecord, containsControlCharacters } from '../../src/utils/helpers';
import { parseIsoToMs } from '../../src/utils/quota/resetInstants';
import type { AntigravityQuotaSummaryPayload } from '../../src/types';

/** Maximum snapshot file size read from disk before parsing. */
export const AGY_SNAPSHOT_MAX_BYTES = 256 * 1024;
/**
 * After this long without a fresh snapshot, the collector disables the ingested account and drops
 * its live source entry so Gemini reverts to dormant history and never blocks the combined "All"
 * forecast for Claude and Codex.
 */
export const AGY_ACTIVE_TTL_MS = 30 * 60_000;
/** Reject snapshots claiming to be recorded more than two minutes ahead of the host clock. */
export const AGY_MAX_FUTURE_SKEW_MS = 2 * 60_000;

export interface ParsedAgySnapshot {
  instanceId: string;
  sourceLabel: string;
  observedAtMs: number;
  plan: string | null;
  summaryPayload: AntigravityQuotaSummaryPayload;
}

export type AgySnapshotReadResult =
  | { kind: 'absent' }
  | { kind: 'invalid' }
  | { kind: 'ok'; mtimeMs: number; snapshot: ParsedAgySnapshot };

const INSTANCE_ID_PATTERN = /^[a-z][a-z0-9-]*$/;

function validText(value: unknown, maxLength: number): value is string {
  return (
    typeof value === 'string' &&
    value.trim().length > 0 &&
    value.length <= maxLength &&
    !containsControlCharacters(value)
  );
}

/**
 * Normalize an `agy --output-format json -p "/usage"` object into the shared
 * `AntigravityQuotaSummaryPayload` shape. Rejects anything that is not a zero-turn `SUCCESS`
 * `/usage` response or that lacks either `gemini-5h` or `gemini-weekly` under `Gemini Models`, so
 * CLI schema drift can never write `missing-window` nulls over a real balance.
 *
 * Unused buckets report Unix epoch `1970-01-01T00:00:00Z`; their `resetTime` is omitted so
 * downstream math sees `resetAtMs: null` rather than `0` (which looks already reset).
 */
export function normalizeAgyCliUsage(usage: unknown): AntigravityQuotaSummaryPayload | null {
  if (!isRecord(usage)) return null;
  if (usage.status !== 'SUCCESS' || usage.num_turns !== 0) return null;
  if (!isRecord(usage.command) || usage.command.name !== 'usage') return null;
  if (!isRecord(usage.command.data) || !Array.isArray(usage.command.data.groups)) return null;

  let sawGemini5h = false;
  let sawGeminiWeekly = false;
  const groups: NonNullable<AntigravityQuotaSummaryPayload['groups']> = [];

  for (const rawGroup of usage.command.data.groups) {
    if (!isRecord(rawGroup) || !validText(rawGroup.name, 128) || !Array.isArray(rawGroup.buckets)) {
      return null;
    }
    const groupName = rawGroup.name.trim();
    const isGeminiGroup = groupName.toLowerCase() === 'gemini models';
    const buckets: NonNullable<
      NonNullable<AntigravityQuotaSummaryPayload['groups']>[number]['buckets']
    > = [];

    for (const rawBucket of rawGroup.buckets) {
      if (!isRecord(rawBucket)) return null;
      if (
        !validText(rawBucket.id, 64) ||
        !validText(rawBucket.name, 128) ||
        !validText(rawBucket.window, 32)
      ) {
        return null;
      }
      const remaining = rawBucket.remaining_fraction;
      if (
        typeof remaining !== 'number' ||
        !Number.isFinite(remaining) ||
        remaining < 0 ||
        remaining > 1
      ) {
        return null;
      }
      if (typeof rawBucket.reset_time !== 'string') return null;
      const resetMs = parseIsoToMs(rawBucket.reset_time);
      if (resetMs === null) return null;

      const bucketId = rawBucket.id.trim();
      if (isGeminiGroup) {
        if (bucketId === 'gemini-5h') sawGemini5h = true;
        if (bucketId === 'gemini-weekly') sawGeminiWeekly = true;
      }

      buckets.push({
        bucketId,
        displayName: rawBucket.name.trim(),
        window: rawBucket.window.trim(),
        remainingFraction: remaining,
        // Epoch 0 (`1970-01-01T00:00:00Z`) denotes an unused window with no active reset clock.
        ...(resetMs > 0 ? { resetTime: rawBucket.reset_time.trim() } : {}),
        ...(typeof rawBucket.description === 'string' &&
        !containsControlCharacters(rawBucket.description)
          ? { description: rawBucket.description.trim() }
          : {}),
      });
    }

    groups.push({
      displayName: groupName,
      ...(typeof rawGroup.description === 'string' &&
      !containsControlCharacters(rawGroup.description)
        ? { description: rawGroup.description.trim() }
        : {}),
      buckets,
    });
  }

  if (!sawGemini5h || !sawGeminiWeekly) return null;
  return { groups };
}

/** Parse and validate one dropped `agy-usage.json` snapshot envelope. */
export function parseAgySnapshotEnvelope(raw: string, nowMs: number): ParsedAgySnapshot | null {
  if (Buffer.byteLength(raw, 'utf8') > AGY_SNAPSHOT_MAX_BYTES) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(parsed) || parsed.schemaVersion !== 1) return null;
  if (
    !validText(parsed.instanceId, 64) ||
    !INSTANCE_ID_PATTERN.test(parsed.instanceId) ||
    !validText(parsed.sourceLabel, 80)
  ) {
    return null;
  }
  const observedAtMs = parsed.observedAtMs;
  if (
    typeof observedAtMs !== 'number' ||
    !Number.isSafeInteger(observedAtMs) ||
    observedAtMs <= 0 ||
    observedAtMs > nowMs + AGY_MAX_FUTURE_SKEW_MS
  ) {
    return null;
  }
  let plan: string | null = null;
  if (parsed.plan !== undefined && parsed.plan !== null) {
    if (!validText(parsed.plan, 64)) return null;
    plan = parsed.plan.trim();
  }
  const summaryPayload = normalizeAgyCliUsage(parsed.usage);
  if (!summaryPayload) return null;
  return {
    instanceId: parsed.instanceId,
    sourceLabel: parsed.sourceLabel.trim(),
    observedAtMs,
    plan,
    summaryPayload,
  };
}

/** Read and validate the dropped snapshot file; never throws or leaks file contents. */
export async function readAgySnapshotFile(
  path: string,
  nowMs: number
): Promise<AgySnapshotReadResult> {
  let info;
  try {
    info = await stat(path);
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      return { kind: 'absent' };
    }
    return { kind: 'invalid' };
  }
  if (!info.isFile() || info.size <= 0 || info.size > AGY_SNAPSHOT_MAX_BYTES) {
    return { kind: 'invalid' };
  }
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch {
    return { kind: 'invalid' };
  }
  const snapshot = parseAgySnapshotEnvelope(raw, nowMs);
  if (!snapshot) return { kind: 'invalid' };
  return { kind: 'ok', mtimeMs: info.mtimeMs, snapshot };
}

export type AgyCircuitBreakerCategory = 'transient' | 'version_changed' | 'hard_stop';

export interface AgyCircuitBreakerState {
  open: boolean;
  trippedAtMs?: number;
  category?: AgyCircuitBreakerCategory;
  reason?: string;
  attempts?: number;
  agyVersion?: string;
}

export interface AgyEventEntry {
  at: string;
  atMs: number;
  event: string;
  category: string;
  reason: string;
  agyVersion?: string;
}

export interface AgyStatusSnapshot {
  snapshot: {
    instanceId: string;
    observedAtMs: number;
    ageMs: number;
    active: boolean;
  } | null;
  circuitBreaker: AgyCircuitBreakerState;
  recentEvents: AgyEventEntry[];
}

const STOP_FLAG_MAX_BYTES = 16 * 1024;
const EVENTS_FILE_MAX_BYTES = 128 * 1024;
const MAX_RECENT_EVENTS = 20;
const VALID_CATEGORIES = new Set<AgyCircuitBreakerCategory>([
  'transient',
  'version_changed',
  'hard_stop',
]);

/** Read optional circuit-breaker stop flag; legacy or malformed flags report `hard_stop`. */
export async function readAgyStopFlag(path: string): Promise<AgyCircuitBreakerState> {
  let info;
  try {
    info = await stat(path);
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      return { open: false };
    }
    return { open: true, category: 'hard_stop', reason: 'unreadable-stop-flag' };
  }
  if (!info.isFile() || info.size > STOP_FLAG_MAX_BYTES) {
    return {
      open: true,
      trippedAtMs: Math.floor(info.mtimeMs),
      category: 'hard_stop',
      reason: 'malformed-stop-flag',
    };
  }
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch {
    return { open: true, category: 'hard_stop', reason: 'unreadable-stop-flag' };
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (isRecord(parsed)) {
      const category =
        typeof parsed.category === 'string' &&
        VALID_CATEGORIES.has(parsed.category as AgyCircuitBreakerCategory)
          ? (parsed.category as AgyCircuitBreakerCategory)
          : 'hard_stop';
      const reason = validText(parsed.reason, 128) ? parsed.reason.trim() : 'unknown';
      const trippedAtMs =
        typeof parsed.trippedAtMs === 'number' && Number.isSafeInteger(parsed.trippedAtMs)
          ? parsed.trippedAtMs
          : Math.floor(info.mtimeMs);
      const attempts =
        typeof parsed.attempts === 'number' &&
        Number.isSafeInteger(parsed.attempts) &&
        parsed.attempts >= 0
          ? parsed.attempts
          : 0;
      const agyVersion = validText(parsed.agyVersion, 32) ? parsed.agyVersion.trim() : undefined;
      return {
        open: true,
        trippedAtMs,
        category,
        reason,
        attempts,
        ...(agyVersion ? { agyVersion } : {}),
      };
    }
  } catch {
    // Legacy plain-text stop flag
  }
  return {
    open: true,
    trippedAtMs: Math.floor(info.mtimeMs),
    category: 'hard_stop',
    reason: 'legacy-stop-flag',
  };
}

/** Read the newest sanitized events from `agy-events.jsonl`; never throws. */
export async function readAgyRecentEvents(path: string): Promise<AgyEventEntry[]> {
  let info;
  try {
    info = await stat(path);
  } catch {
    return [];
  }
  if (!info.isFile() || info.size <= 0 || info.size > EVENTS_FILE_MAX_BYTES) return [];
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch {
    return [];
  }
  const events: AgyEventEntry[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const parsed: unknown = JSON.parse(line);
      if (!isRecord(parsed)) continue;
      if (
        !validText(parsed.at, 64) ||
        typeof parsed.atMs !== 'number' ||
        !Number.isSafeInteger(parsed.atMs) ||
        !validText(parsed.event, 64) ||
        !validText(parsed.category, 64) ||
        !validText(parsed.reason, 128)
      ) {
        continue;
      }
      const agyVersion = validText(parsed.agyVersion, 32) ? parsed.agyVersion.trim() : undefined;
      events.push({
        at: parsed.at.trim(),
        atMs: parsed.atMs,
        event: parsed.event.trim(),
        category: parsed.category.trim(),
        reason: parsed.reason.trim(),
        ...(agyVersion ? { agyVersion } : {}),
      });
    } catch {
      continue;
    }
  }
  return events.slice(-MAX_RECENT_EVENTS);
}

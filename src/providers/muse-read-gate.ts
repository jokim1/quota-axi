import { chmodSync, renameSync, writeFileSync } from "node:fs";
import {
  ensurePrivateParent,
  museKeyReadLedgerPath,
  readUntracedJsonFile,
} from "../lib/fs.js";

/**
 * The shortest interval between two Muse key-endpoint requests for the same
 * credential.
 *
 * Muse's only quota read is the call its CLI makes at startup, and that call
 * returns the account's Model API key - verified (2026-09-24, Muse Code 1.3.0)
 * to be the identical standing key on consecutive calls, but issued on first
 * use with no documented rotation cadence. quota-axi therefore treats every
 * request as an action on a credential it does not own, and bounds it: one
 * request per credential per interval, whatever the outcome, across every
 * quota-axi process sharing the cache directory. Inside the interval the
 * adapter replays what the last request established - its own cached reading,
 * its rejection, or a deferred read - and sends nothing. The interval equals
 * the `--tui` default refresh, so a live report issues at most one request per
 * refresh and a burst of agent calls issues one request in total.
 */
export const MUSE_KEY_READ_INTERVAL_MS = 5 * 60_000;

export type MuseKeyReadOutcome = "pending" | "quota" | "rejected" | "transient";

export type MuseKeyRead = {
  attemptedAt: number;
  outcome: MuseKeyReadOutcome;
};

/**
 * Per-credential record of the last key-endpoint request. Keys are opaque
 * `museCacheContextId` digests and values are timestamps plus an outcome class,
 * so the ledger holds no credential material and names no account.
 */
export type MuseKeyReadLedger = {
  recent(contextId: string, now: number): MuseKeyRead | undefined;
  record(contextId: string, read: MuseKeyRead): void;
};

const LEDGER_SCHEMA_VERSION = 1;
const CONTEXT_ID = /^[a-f0-9]{64}$/;
const OUTCOMES: readonly MuseKeyReadOutcome[] = [
  "pending",
  "quota",
  "rejected",
  "transient",
];

export function createFileMuseKeyReadLedger(
  path: () => string = museKeyReadLedgerPath,
  now: () => number = Date.now,
): MuseKeyReadLedger {
  return {
    recent(contextId, at) {
      const read = readLedger(path()).get(contextId);
      return read && withinInterval(read, at) ? read : undefined;
    },
    record(contextId, read) {
      if (!CONTEXT_ID.test(contextId)) return;
      const file = path();
      const current = now();
      const reads = new Map(
        [...readLedger(file)].filter(([, entry]) =>
          withinInterval(entry, current),
        ),
      );
      reads.set(contextId, read);
      writeLedger(file, reads);
    },
  };
}

/**
 * A request inside the interval on either side of `now`. A timestamp ahead of
 * the clock (the clock moved back) still gates for at most one interval rather
 * than forever, and never opens the gate early.
 */
function withinInterval(read: MuseKeyRead, now: number): boolean {
  return Math.abs(now - read.attemptedAt) < MUSE_KEY_READ_INTERVAL_MS;
}

function readLedger(file: string): Map<string, MuseKeyRead> {
  const reads = new Map<string, MuseKeyRead>();
  const payload = objectValue(readUntracedJsonFile(file));
  if (!payload || payload.schemaVersion !== LEDGER_SCHEMA_VERSION) return reads;
  const entries = objectValue(payload.reads);
  if (!entries) return reads;
  for (const [contextId, raw] of Object.entries(entries)) {
    const entry = objectValue(raw);
    const attemptedAt =
      typeof entry?.attemptedAt === "string"
        ? Date.parse(entry.attemptedAt)
        : Number.NaN;
    const outcome = OUTCOMES.find((value) => value === entry?.outcome);
    if (CONTEXT_ID.test(contextId) && Number.isFinite(attemptedAt) && outcome)
      reads.set(contextId, { attemptedAt, outcome });
  }
  return reads;
}

function writeLedger(file: string, reads: Map<string, MuseKeyRead>): void {
  ensurePrivateParent(file);
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(
    temp,
    `${JSON.stringify(
      {
        schemaVersion: LEDGER_SCHEMA_VERSION,
        reads: Object.fromEntries(
          [...reads].map(([contextId, read]) => [
            contextId,
            {
              attemptedAt: new Date(read.attemptedAt).toISOString(),
              outcome: read.outcome,
            },
          ]),
        ),
      },
      null,
      2,
    )}\n`,
    { mode: 0o600 },
  );
  chmodSync(temp, 0o600);
  renameSync(temp, file);
  chmodSync(file, 0o600);
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

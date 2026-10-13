import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { findCommandPath, terminateChild } from "../lib/process.js";
import { VERSION } from "../version.js";

/**
 * One bounded Muse turn through the vendor's own MSP host (`muse serve`),
 * spent only under `--allow-muse-inference`. The host reads its own
 * credential, so no Keychain value is ever requested by quota-axi; the only
 * numbers retained are the `usage/read` window percentages and resets the
 * host observed from that turn. Frame contents are never persisted or
 * rendered, and an empty observation is a failed read, never a guess.
 */

const SERVE_TIMEOUT_MS = 60_000;
const MAX_FRAME_BYTES = 1024 * 1024;
const MAX_OUTPUT_BYTES = 16 * 1024 * 1024;
const SERVE_ARGS = ["serve", "--no-session-log"] as const;
const PROMPT = "Reply with exactly ok and nothing else. Do not use any tools.";

/** The `usage/read` result's `usage` member, verbatim from the host. */
export type MuseServeUsage = {
  window?: unknown;
  weekly?: unknown;
  tier?: unknown;
  observedAtMs?: unknown;
};

export type MuseServeQuotaResult =
  | { kind: "success"; usage: MuseServeUsage; refreshedAt: string }
  | { kind: "failure"; error: string };

/**
 * The line-oriented stdio peer quota-axi speaks JSON-RPC to. The real peer
 * wraps the spawned host; tests substitute a scripted fake, so no test ever
 * launches the Muse CLI.
 */
export type MuseServePeer = {
  write(line: string): void;
  onLine(handler: (line: string) => void): void;
  onClose(handler: () => void): void;
  terminate(): void;
};

export type MuseServeQuotaDependencies = {
  findMuse?: () => Promise<string | undefined>;
  makeScratch?: () => string;
  spawnPeer?: (
    command: string,
    args: readonly string[],
    cwd: string,
  ) => MuseServePeer;
  now?: () => number;
  timeoutMs?: number;
};

export async function fetchMuseServeQuota(
  dependencies: MuseServeQuotaDependencies = {},
): Promise<MuseServeQuotaResult> {
  if (process.platform === "win32") return failure("muse_serve_incompatible");
  const callerCwd = process.cwd();
  const discovered = await (
    dependencies.findMuse ?? (() => findCommandPath("muse"))
  )();
  if (!discovered) return failure("muse_serve_incompatible");
  const command = isAbsolute(discovered)
    ? discovered
    : resolve(callerCwd, discovered);

  let scratch: string | undefined;
  let peer: MuseServePeer | undefined;
  try {
    scratch = (dependencies.makeScratch ?? makeScratchDirectory)();
    peer = (dependencies.spawnPeer ?? spawnServePeer)(
      command,
      SERVE_ARGS,
      scratch,
    );
    return await runServeSession(peer, scratch, dependencies);
  } catch (error) {
    return error instanceof ServeFailure
      ? failure(error.code)
      : failure("muse_serve_process_failed");
  } finally {
    peer?.terminate();
    if (scratch !== undefined)
      rmSync(scratch, { recursive: true, force: true });
  }
}

/**
 * A UUIDv7 command id, as `session/start` and `turn/start` require: the
 * current Unix millisecond time in the first 48 bits, version and variant
 * bits set, the rest random.
 */
export function uuidV7(now = Date.now()): string {
  const bytes = randomBytes(16);
  bytes.writeUIntBE(Math.floor(now), 0, 6);
  bytes[6] = (bytes[6]! & 0x0f) | 0x70;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

async function runServeSession(
  peer: MuseServePeer,
  scratch: string,
  dependencies: MuseServeQuotaDependencies,
): Promise<MuseServeQuotaResult> {
  const client = new ServeClient(
    peer,
    dependencies.timeoutMs ?? SERVE_TIMEOUT_MS,
  );
  const now = dependencies.now ?? Date.now;
  try {
    return await serveSession(client, scratch, now);
  } finally {
    client.dispose();
  }
}

async function serveSession(
  client: ServeClient,
  scratch: string,
  now: () => number,
): Promise<MuseServeQuotaResult> {
  await client.request("initialize", {
    clientInfo: { name: "quota_axi", version: VERSION },
  });
  client.notify("initialized", {});
  const started = await client.request("session/start", {
    commandId: uuidV7(now()),
    workspaceRoot: scratch,
  });
  const sessionId = sessionIdOf(started);
  if (!sessionId) throw new ServeFailure("muse_serve_protocol_error");

  const turnObserved = client.awaitNotification(
    (method) => method === "usage/changed" || method === "turn/completed",
  );
  // The wait is consumed below; a rejection there is the read's verdict, so
  // keep the early promise from surfacing as an unhandled rejection first.
  turnObserved.catch(() => undefined);
  await client.request("turn/start", {
    commandId: uuidV7(now()),
    sessionId,
    input: [{ type: "text", text: PROMPT }],
    reasoningEffort: "none",
  });
  await turnObserved;

  const read = await client.request("usage/read", {});
  const usage = usageOf(read);
  if (!usage) return failure("muse_serve_quota_unavailable");
  return {
    kind: "success",
    usage,
    refreshedAt: new Date(now()).toISOString(),
  };
}

function sessionIdOf(result: unknown): string | undefined {
  const session = objectValue(objectValue(result)?.session);
  const id = session?.sessionId;
  return typeof id === "string" && id.length > 0 ? id : undefined;
}

function usageOf(result: unknown): MuseServeUsage | undefined {
  const usage = objectValue(objectValue(result)?.usage);
  if (!usage) return undefined;
  if (!objectValue(usage.window) && !objectValue(usage.weekly))
    return undefined;
  return {
    ...(usage.window !== undefined ? { window: usage.window } : {}),
    ...(usage.weekly !== undefined ? { weekly: usage.weekly } : {}),
    ...(usage.tier !== undefined ? { tier: usage.tier } : {}),
    ...(usage.observedAtMs !== undefined
      ? { observedAtMs: usage.observedAtMs }
      : {}),
  };
}

/**
 * Sequential newline-delimited JSON-RPC over the peer. One overall deadline
 * bounds every wait; a malformed frame, an error response, an oversized
 * stream, or the host exiting early fails the read instead of being
 * reinterpreted.
 */
class ServeClient {
  private nextId = 1;
  private settled = false;
  private readonly pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >();
  private readonly noteWaiters: {
    matches: (method: string) => boolean;
    resolve: () => void;
    reject: (error: Error) => void;
  }[] = [];
  private readonly seenNotes = new Set<string>();
  private readonly deadline: ReturnType<typeof setTimeout>;

  constructor(
    private readonly peer: MuseServePeer,
    timeoutMs: number,
  ) {
    this.deadline = setTimeout(
      () => this.fail(new ServeFailure("muse_serve_timeout")),
      timeoutMs,
    );
    this.deadline.unref();
    peer.onLine((line) => this.onFrame(line));
    peer.onClose(() =>
      this.fail(new ServeFailure("muse_serve_process_failed")),
    );
  }

  dispose(): void {
    clearTimeout(this.deadline);
  }

  request(method: string, params: Record<string, unknown>): Promise<unknown> {
    if (this.settled)
      return Promise.reject(new ServeFailure("muse_serve_process_failed"));
    const id = this.nextId++;
    const response = new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });
    this.peer.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
    return response;
  }

  notify(method: string, params: Record<string, unknown>): void {
    this.peer.write(JSON.stringify({ jsonrpc: "2.0", method, params }));
  }

  awaitNotification(matches: (method: string) => boolean): Promise<void> {
    if ([...this.seenNotes].some(matches)) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      this.noteWaiters.push({ matches, resolve, reject });
    });
  }

  private onFrame(line: string): void {
    if (this.settled) return;
    let frame: Record<string, unknown> | undefined;
    try {
      frame = objectValue(JSON.parse(line));
    } catch {
      frame = undefined;
    }
    if (!frame) {
      this.fail(new ServeFailure("muse_serve_protocol_error"));
      return;
    }
    const { id, method } = frame;
    if (typeof id === "number" && typeof method === "string") {
      // A server-initiated request (an approval or input prompt). This read
      // grants nothing: answer unsupported rather than presenting anything.
      this.peer.write(
        JSON.stringify({
          jsonrpc: "2.0",
          id,
          error: { code: -32601, message: "unsupported" },
        }),
      );
      return;
    }
    if (typeof id === "number") {
      const waiter = this.pending.get(id);
      if (!waiter) return;
      this.pending.delete(id);
      if (frame.error !== undefined) {
        waiter.reject(new ServeFailure("muse_serve_protocol_error"));
        this.fail(new ServeFailure("muse_serve_protocol_error"));
      } else {
        waiter.resolve(frame.result);
      }
      return;
    }
    if (typeof method === "string") {
      this.seenNotes.add(method);
      for (const waiter of this.noteWaiters) {
        if (waiter.matches(method)) waiter.resolve();
      }
    }
  }

  private fail(error: ServeFailure): void {
    if (this.settled) return;
    this.settled = true;
    clearTimeout(this.deadline);
    for (const waiter of this.pending.values()) waiter.reject(error);
    this.pending.clear();
    for (const waiter of this.noteWaiters) waiter.reject(error);
    this.noteWaiters.length = 0;
  }
}

function spawnServePeer(
  command: string,
  args: readonly string[],
  cwd: string,
): MuseServePeer {
  const child = spawn(command, [...args], {
    cwd,
    env: { ...process.env, NO_COLOR: "1", TERM: "dumb" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stdin.on("error", () => undefined);
  child.stderr.resume();
  let buffer = "";
  let bytes = 0;
  let lineHandler: ((line: string) => void) | undefined;
  let closeHandler: (() => void) | undefined;
  let overflowed = false;
  child.stdout.on("data", (chunk: Buffer) => {
    bytes += chunk.byteLength;
    if (bytes > MAX_OUTPUT_BYTES) {
      if (!overflowed) {
        overflowed = true;
        lineHandler?.(""); // an unparseable frame: the read fails closed
        terminateChild(child);
      }
      return;
    }
    buffer += chunk.toString("utf8");
    let newline = buffer.indexOf("\n");
    while (newline >= 0) {
      const line = buffer.slice(0, newline).replace(/\r$/, "");
      buffer = buffer.slice(newline + 1);
      if (line.length > 0) lineHandler?.(line);
      newline = buffer.indexOf("\n");
    }
    if (buffer.length > MAX_FRAME_BYTES) lineHandler?.("");
  });
  child.on("error", () => closeHandler?.());
  child.on("close", () => closeHandler?.());
  return {
    write: (line) => {
      child.stdin.write(`${line}\n`);
    },
    onLine: (handler) => {
      lineHandler = handler;
    },
    onClose: (handler) => {
      closeHandler = handler;
    },
    terminate: () => terminateChild(child),
  };
}

function makeScratchDirectory(): string {
  return mkdtempSync(join(tmpdir(), "quota-axi-muse-"));
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function failure(error: string): MuseServeQuotaResult {
  return { kind: "failure", error };
}

class ServeFailure extends Error {
  readonly code: string;
  constructor(code: string) {
    super(code);
    this.name = "ServeFailure";
    this.code = code;
  }
}

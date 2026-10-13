import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  fetchMuseServeQuota,
  uuidV7,
  type MuseServePeer,
} from "../../src/providers/muse-serve-quota.js";

// Synthetic usage only; no real Muse session, credential, or account data.
const USAGE = {
  window: {
    usedPercent: 66,
    windowDurationMins: 300,
    resetsAtMs: 1_800_000_000_000,
  },
  weekly: { usedPercent: 23, resetsAtMs: 1_800_500_000_000 },
  tier: "synthetic-tier-id",
  observedAtMs: 1_799_000_000_000,
};
const UUID_V7 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

type Frame = Record<string, unknown> & {
  id?: number;
  method?: string;
  params?: Record<string, unknown>;
};

/** A scripted `muse serve` stdio peer: no test launches the real CLI. */
class FakePeer implements MuseServePeer {
  readonly sent: Frame[] = [];
  terminated = false;
  private lineHandler: ((line: string) => void) | undefined;
  private closeHandler: (() => void) | undefined;

  constructor(
    private readonly script: (peer: FakePeer, frame: Frame) => void,
  ) {}

  write(line: string): void {
    const frame = JSON.parse(line) as Frame;
    this.sent.push(frame);
    this.script(this, frame);
  }

  onLine(handler: (line: string) => void): void {
    this.lineHandler = handler;
  }

  onClose(handler: () => void): void {
    this.closeHandler = handler;
  }

  terminate(): void {
    this.terminated = true;
  }

  emit(frame: Frame | string): void {
    const line = typeof frame === "string" ? frame : JSON.stringify(frame);
    queueMicrotask(() => this.lineHandler?.(line));
  }

  close(): void {
    queueMicrotask(() => this.closeHandler?.());
  }

  respond(frame: Frame, result: unknown): void {
    this.emit({ jsonrpc: "2.0", id: frame.id, result });
  }
}

function happyScript(usage: unknown) {
  return (peer: FakePeer, frame: Frame): void => {
    if (frame.method === "initialize") peer.respond(frame, {});
    else if (frame.method === "session/start")
      peer.respond(frame, { session: { sessionId: "session-1" } });
    else if (frame.method === "turn/start") {
      peer.respond(frame, { turnId: "turn-1" });
      peer.emit({ jsonrpc: "2.0", method: "usage/changed", params: {} });
    } else if (frame.method === "usage/read") peer.respond(frame, usage);
  };
}

function serveDeps(peer: FakePeer, scratch: string) {
  return {
    findMuse: () => Promise.resolve("/fake/muse"),
    makeScratch: () => scratch,
    spawnPeer: () => peer,
    now: () => 1_799_000_000_000,
    timeoutMs: 5_000,
  };
}

function scratchDir(): string {
  return mkdtempSync(join(tmpdir(), "quota-axi-muse-serve-test-"));
}

describe("Muse serve quota read", () => {
  it("runs one bounded turn and returns the observed usage", async () => {
    const scratch = scratchDir();
    const peer = new FakePeer(happyScript({ usage: USAGE }));
    const spawnPeer = vi.fn(() => peer);

    const result = await fetchMuseServeQuota({
      ...serveDeps(peer, scratch),
      spawnPeer,
    });

    expect(result).toEqual({
      kind: "success",
      usage: USAGE,
      refreshedAt: new Date(1_799_000_000_000).toISOString(),
    });
    expect(spawnPeer).toHaveBeenCalledWith(
      "/fake/muse",
      ["serve", "--no-session-log"],
      scratch,
    );
    expect(peer.sent.map((frame) => frame.method)).toEqual([
      "initialize",
      "initialized",
      "session/start",
      "turn/start",
      "usage/read",
    ]);
    const initialize = peer.sent[0]?.params as {
      clientInfo: { name: string };
    };
    expect(initialize.clientInfo.name).toMatch(/^[a-z0-9_]+$/);
    const sessionStart = peer.sent[2]?.params as {
      commandId: string;
      workspaceRoot: string;
    };
    expect(sessionStart.commandId).toMatch(UUID_V7);
    expect(sessionStart.workspaceRoot).toBe(scratch);
    const turnStart = peer.sent[3]?.params as {
      commandId: string;
      sessionId: string;
      reasoningEffort: string;
      input: { type: string; text: string }[];
    };
    expect(turnStart.commandId).toMatch(UUID_V7);
    expect(turnStart.sessionId).toBe("session-1");
    expect(turnStart.reasoningEffort).toBe("none");
    expect(turnStart.input).toHaveLength(1);
    expect(turnStart.input[0]?.type).toBe("text");
    expect(turnStart.input[0]?.text).toContain("exactly ok");
    expect(peer.terminated).toBe(true);
    expect(existsSync(scratch)).toBe(false);
  });

  it("treats an empty usage/read as a failed read and still cleans up", async () => {
    const scratch = scratchDir();
    const peer = new FakePeer(happyScript({}));

    const result = await fetchMuseServeQuota(serveDeps(peer, scratch));

    expect(result).toEqual({
      kind: "failure",
      error: "muse_serve_quota_unavailable",
    });
    expect(peer.terminated).toBe(true);
    expect(existsSync(scratch)).toBe(false);
  });

  it("fails closed on a notInitialized error response", async () => {
    const scratch = scratchDir();
    const peer = new FakePeer((p, frame) => {
      if (frame.method === "initialize") p.respond(frame, {});
      else if (frame.method === "session/start")
        p.emit({
          jsonrpc: "2.0",
          id: frame.id,
          error: { code: -32002, message: "notInitialized" },
        });
    });

    const result = await fetchMuseServeQuota(serveDeps(peer, scratch));

    expect(result).toEqual({
      kind: "failure",
      error: "muse_serve_protocol_error",
    });
    expect(peer.terminated).toBe(true);
    expect(existsSync(scratch)).toBe(false);
  });

  it("bounds every wait with the overall deadline", async () => {
    const scratch = scratchDir();
    const peer = new FakePeer(() => undefined);

    const result = await fetchMuseServeQuota({
      ...serveDeps(peer, scratch),
      timeoutMs: 30,
    });

    expect(result).toEqual({ kind: "failure", error: "muse_serve_timeout" });
    expect(peer.terminated).toBe(true);
    expect(existsSync(scratch)).toBe(false);
  });

  it("fails closed on a malformed frame instead of reinterpreting it", async () => {
    const scratch = scratchDir();
    const peer = new FakePeer((p, frame) => {
      if (frame.method === "initialize") p.emit("this is not json");
    });

    const result = await fetchMuseServeQuota(serveDeps(peer, scratch));

    expect(result).toEqual({
      kind: "failure",
      error: "muse_serve_protocol_error",
    });
    expect(peer.terminated).toBe(true);
    expect(existsSync(scratch)).toBe(false);
  });

  it("reports a host that exits before answering as a process failure", async () => {
    const scratch = scratchDir();
    const peer = new FakePeer((p, frame) => {
      if (frame.method === "initialize") p.close();
    });

    const result = await fetchMuseServeQuota(serveDeps(peer, scratch));

    expect(result).toEqual({
      kind: "failure",
      error: "muse_serve_process_failed",
    });
    expect(peer.terminated).toBe(true);
    expect(existsSync(scratch)).toBe(false);
  });

  it("never spawns when no muse binary is found", async () => {
    const spawnPeer = vi.fn(() => new FakePeer(() => undefined));

    const result = await fetchMuseServeQuota({
      findMuse: () => Promise.resolve(undefined),
      spawnPeer,
    });

    expect(result).toEqual({
      kind: "failure",
      error: "muse_serve_incompatible",
    });
    expect(spawnPeer).not.toHaveBeenCalled();
  });

  it("answers a server-initiated request as unsupported and keeps reading", async () => {
    const scratch = scratchDir();
    const base = happyScript({ usage: USAGE });
    const peer = new FakePeer((p, frame) => {
      if (frame.method === "turn/start") {
        p.emit({ jsonrpc: "2.0", id: 99, method: "approval/request" });
      }
      base(p, frame);
    });

    const result = await fetchMuseServeQuota(serveDeps(peer, scratch));

    expect(result.kind).toBe("success");
    const refusal = peer.sent.find((frame) => frame.id === 99);
    expect(refusal?.error).toEqual({ code: -32601, message: "unsupported" });
  });
});

describe("uuidV7", () => {
  it("carries the millisecond time and version/variant bits", () => {
    const now = 1_799_000_000_123;
    const id = uuidV7(now);
    expect(id).toMatch(UUID_V7);
    const timestamp = Number.parseInt(id.replace("-", "").slice(0, 12), 16);
    expect(timestamp).toBe(now);
    expect(uuidV7(now)).not.toBe(id);
  });
});

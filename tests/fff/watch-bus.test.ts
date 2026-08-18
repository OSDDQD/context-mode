/**
 * The shared filesystem event bus.
 *
 * Pure JS — no native library, no filesystem. These are the guarantees the
 * future consumers (FTS5 chunk invalidation, codegraph sync, the
 * ctx_execute_file cache) are allowed to rely on.
 */

import { describe, expect, it } from "vitest";

import type { FsChangeEvent } from "../../src/fff/watch.js";
import { FsWatchBus } from "../../src/fff/watch.js";

const ROOT = "/project/root";

function ev(rel: string, kind: FsChangeEvent["kind"] = "modified"): FsChangeEvent {
  return { path: `${ROOT}/${rel}`, relativePath: rel, kind };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("FsWatchBus", () => {
  it("coalesces repeated events for one path into a single delivery", async () => {
    const bus = new FsWatchBus({ root: ROOT, debounceMs: 20 });
    const batches: FsChangeEvent[][] = [];
    bus.subscribe((events) => batches.push(events));

    bus.publish([ev("src/a.ts")]);
    bus.publish([ev("src/a.ts")]);
    bus.publish([ev("src/a.ts")]);
    expect(batches).toHaveLength(0); // still debouncing

    await sleep(60);
    expect(batches).toHaveLength(1);
    expect(batches[0]).toHaveLength(1);
    expect(batches[0]![0]!.relativePath).toBe("src/a.ts");
    expect(bus.stats.received).toBe(3);
    expect(bus.stats.delivered).toBe(1);
    bus.close();
  });

  it("keeps 'created' over a later 'modified', and lets 'removed' win", () => {
    const bus = new FsWatchBus({ root: ROOT, debounceMs: 0 });
    const seen: FsChangeEvent[] = [];
    bus.subscribe((events) => seen.push(...events));

    // debounceMs: 0 flushes synchronously, so publish both in one call.
    bus.publish([ev("src/new.ts", "created"), ev("src/new.ts", "modified")]);
    bus.publish([ev("src/gone.ts", "modified"), ev("src/gone.ts", "removed")]);

    expect(seen.map((e) => [e.relativePath, e.kind])).toEqual([
      ["src/new.ts", "created"],
      ["src/gone.ts", "removed"],
    ]);
    bus.close();
  });

  it("drops events outside the project root", async () => {
    const bus = new FsWatchBus({ root: ROOT, debounceMs: 10 });
    const seen: FsChangeEvent[] = [];
    bus.subscribe((events) => seen.push(...events));

    bus.publish([
      { path: "/somewhere/else/x.ts", relativePath: "x.ts", kind: "modified" },
      ev("src/inside.ts"),
    ]);
    await sleep(40);

    expect(seen.map((e) => e.relativePath)).toEqual(["src/inside.ts"]);
    expect(bus.stats.dropped).toBe(1);
    bus.close();
  });

  it("collapses a batch containing a rescan into a single rescan event", async () => {
    const bus = new FsWatchBus({ root: ROOT, debounceMs: 10 });
    const seen: FsChangeEvent[] = [];
    bus.subscribe((events) => seen.push(...events));

    bus.publish([ev("src/a.ts"), { path: ROOT, relativePath: "", kind: "rescan" }, ev("src/b.ts")]);
    await sleep(40);

    expect(seen).toEqual([{ path: ROOT, relativePath: "", kind: "rescan" }]);
    bus.close();
  });

  it("turns a buffer overflow into a rescan instead of an unbounded batch", async () => {
    const bus = new FsWatchBus({ root: ROOT, debounceMs: 10, maxBuffered: 3 });
    const seen: FsChangeEvent[] = [];
    bus.subscribe((events) => seen.push(...events));

    bus.publish(Array.from({ length: 20 }, (_, i) => ev(`src/f${i}.ts`)));
    await sleep(40);

    expect(seen).toHaveLength(1);
    expect(seen[0]!.kind).toBe("rescan");
    expect(bus.stats.overflows).toBe(1);
    bus.close();
  });

  it("stops delivering after unsubscribe, and unsubscribing twice is safe", async () => {
    const bus = new FsWatchBus({ root: ROOT, debounceMs: 5 });
    const seen: FsChangeEvent[] = [];
    const off = bus.subscribe((events) => seen.push(...events));

    bus.publish([ev("src/a.ts")]);
    await sleep(30);
    expect(seen).toHaveLength(1);

    off();
    off(); // idempotent
    expect(bus.listenerCount).toBe(0);

    bus.publish([ev("src/b.ts")]);
    await sleep(30);
    expect(seen).toHaveLength(1);
    bus.close();
  });

  it("keeps delivering to peers when one listener throws", () => {
    const bus = new FsWatchBus({ root: ROOT, debounceMs: 0 });
    const seen: string[] = [];
    bus.subscribe(() => { throw new Error("consumer exploded"); });
    bus.subscribe((events) => seen.push(...events.map((e) => e.relativePath)));

    expect(() => bus.publish([ev("src/a.ts")])).not.toThrow();
    expect(seen).toEqual(["src/a.ts"]);
    bus.close();
  });

  it("flush() delivers the pending batch immediately", () => {
    const bus = new FsWatchBus({ root: ROOT, debounceMs: 10_000 });
    const seen: FsChangeEvent[] = [];
    bus.subscribe((events) => seen.push(...events));

    bus.publish([ev("src/a.ts")]);
    expect(seen).toHaveLength(0);
    expect(bus.pendingCount).toBe(1);

    bus.flush();
    expect(seen).toHaveLength(1);
    expect(bus.pendingCount).toBe(0);
  });

  it("does not starve consumers while events keep arriving", async () => {
    const bus = new FsWatchBus({ root: ROOT, debounceMs: 40, maxDelayMs: 60 });
    let batches = 0;
    bus.subscribe(() => { batches += 1; });

    const started = Date.now();
    let i = 0;
    while (Date.now() - started < 250) {
      bus.publish([ev(`src/f${i++}.ts`)]);
      await sleep(5);
    }
    // The ceiling must have forced at least one delivery mid-stream, even
    // though the debounce window never elapsed quietly.
    expect(batches).toBeGreaterThanOrEqual(1);
    bus.close();
  });

  it("goes inert after close()", async () => {
    const bus = new FsWatchBus({ root: ROOT, debounceMs: 5 });
    const seen: FsChangeEvent[] = [];
    bus.subscribe((events) => seen.push(...events));
    bus.close();

    expect(bus.isClosed).toBe(true);
    expect(bus.listenerCount).toBe(0);
    const off = bus.subscribe((events) => seen.push(...events));
    off();
    bus.publish([ev("src/a.ts")]);
    await sleep(30);
    expect(seen).toHaveLength(0);
  });
});

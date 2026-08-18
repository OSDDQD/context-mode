/**
 * One filesystem event bus for the whole plugin.
 *
 * fff's native watcher is the only thing in this process that should be
 * watching the project tree: it is already running to keep the file index
 * fresh, it honours .gitignore, and it delivers coalesced batches from Rust.
 * Every consumer that used to want its own `fs.watch` — FTS5 chunk
 * invalidation, the `codegraph sync` queue, the `ctx_execute_file` cache —
 * subscribes here instead.
 *
 * This file owns only the fan-out and the debounce. Wiring it to a native
 * watcher lives in `finder.ts`; consumers live elsewhere entirely. That split
 * is what lets the bus be tested with zero native dependencies.
 *
 * Lifetime note: `watch()` is process-scoped. Changes made while no server is
 * running are picked up by the rescan inside `FileFinder.create()`, not here.
 */

import { relative } from "node:path";

import { DEFAULT_WATCH_DEBOUNCE_MS, watchDebounceMs } from "./env.js";
import { isInsideRoot } from "./paths.js";

export type FsChangeKind = "created" | "modified" | "removed" | "rescan";

export interface FsChangeEvent {
  /** Absolute path. For `rescan`, the project root. */
  path: string;
  /** Path relative to the project root. Empty string for `rescan`. */
  relativePath: string;
  kind: FsChangeKind;
}

export type FsChangeListener = (events: FsChangeEvent[]) => void;

export interface FsWatchBusOptions {
  /** Canonical project root; events outside it are dropped. */
  root: string;
  /** Trailing debounce window. Defaults to `CONTEXT_MODE_FFF_WATCH_DEBOUNCE_MS` (150ms). */
  debounceMs?: number;
  /**
   * Hard ceiling on how long a buffered event may wait while new events keep
   * arriving. Without it, a long `npm install` would starve every consumer.
   * Defaults to 4× the debounce window.
   */
  maxDelayMs?: number;
  /**
   * Buffer cap. Past this, the batch collapses to a single `rescan` — the
   * same signal fff itself sends when its index overflows.
   */
  maxBuffered?: number;
}

export interface FsWatchBusStats {
  /** Batches delivered to listeners. */
  batches: number;
  /** Raw events accepted (before coalescing). */
  received: number;
  /** Events actually delivered (after coalescing). */
  delivered: number;
  /** Events dropped for being outside the project root. */
  dropped: number;
  /** Times the buffer cap forced a rescan. */
  overflows: number;
}

const DEFAULT_MAX_BUFFERED = 5_000;

/**
 * Debounced, coalescing fan-out of filesystem events.
 *
 * Coalescing rules (per path, within one window):
 *   - `created` then `modified` stays `created` — a consumer must not treat a
 *     brand-new file as an update to something it never indexed.
 *   - anything then `removed` becomes `removed`.
 *   - otherwise last write wins.
 *   - `rescan` is global: it clears the buffer and is delivered alone.
 */
export class FsWatchBus {
  readonly root: string;
  private readonly debounceMs: number;
  private readonly maxDelayMs: number;
  private readonly maxBuffered: number;

  private listeners = new Set<FsChangeListener>();
  private buffer = new Map<string, FsChangeEvent>();
  private pendingRescan = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private firstBufferedAt = 0;
  private closed = false;
  private readonly counters: FsWatchBusStats = {
    batches: 0,
    received: 0,
    delivered: 0,
    dropped: 0,
    overflows: 0,
  };

  constructor(opts: FsWatchBusOptions) {
    this.root = opts.root;
    this.debounceMs = opts.debounceMs ?? watchDebounceMs();
    this.maxDelayMs = opts.maxDelayMs ?? Math.max(this.debounceMs * 4, this.debounceMs);
    this.maxBuffered = opts.maxBuffered ?? DEFAULT_MAX_BUFFERED;
  }

  get isClosed(): boolean {
    return this.closed;
  }

  get listenerCount(): number {
    return this.listeners.size;
  }

  /** Events buffered but not yet delivered. */
  get pendingCount(): number {
    return this.buffer.size + (this.pendingRescan ? 1 : 0);
  }

  get stats(): Readonly<FsWatchBusStats> {
    return { ...this.counters };
  }

  /**
   * Register a consumer. The returned function is the ONLY way to detach and
   * is safe to call twice; nothing else may mutate the listener set.
   */
  subscribe(listener: FsChangeListener): () => void {
    if (this.closed) return () => { /* bus already closed */ };
    this.listeners.add(listener);
    let detached = false;
    return () => {
      if (detached) return;
      detached = true;
      this.listeners.delete(listener);
    };
  }

  /** Feed raw events in. Called by the native watch bridge, and by tests. */
  publish(events: readonly FsChangeEvent[]): void {
    if (this.closed || events.length === 0) return;

    for (const event of events) {
      this.counters.received += 1;

      if (event.kind === "rescan") {
        this.pendingRescan = true;
        this.buffer.clear();
        continue;
      }
      if (!isInsideRoot(event.path, this.root)) {
        this.counters.dropped += 1;
        continue;
      }
      if (this.pendingRescan) continue; // a rescan already supersedes everything

      this.buffer.set(event.path, {
        path: event.path,
        relativePath: event.relativePath || relative(this.root, event.path),
        kind: mergeKind(this.buffer.get(event.path)?.kind, event.kind),
      });

      if (this.buffer.size > this.maxBuffered) {
        this.counters.overflows += 1;
        this.pendingRescan = true;
        this.buffer.clear();
      }
    }

    if (this.pendingCount === 0) return;
    this.schedule();
  }

  /** Deliver whatever is buffered right now. No-op when the buffer is empty. */
  flush(): void {
    this.clearTimer();
    if (this.closed) return;

    const batch = this.pendingRescan
      ? [{ path: this.root, relativePath: "", kind: "rescan" as const }]
      : [...this.buffer.values()];

    this.buffer.clear();
    this.pendingRescan = false;
    this.firstBufferedAt = 0;
    if (batch.length === 0) return;

    this.counters.batches += 1;
    this.counters.delivered += batch.length;

    // Snapshot: a listener may unsubscribe (or subscribe) from inside its own
    // callback without corrupting this iteration.
    for (const listener of [...this.listeners]) {
      try {
        listener(batch);
      } catch {
        // A broken consumer must not take the watcher, or its peers, down.
      }
    }
  }

  /**
   * Detach everything and stop the timer. Idempotent. After this the bus is
   * inert: `publish` is ignored and `subscribe` hands back a no-op.
   */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.clearTimer();
    this.buffer.clear();
    this.pendingRescan = false;
    this.listeners.clear();
  }

  private schedule(): void {
    const now = Date.now();
    if (this.firstBufferedAt === 0) this.firstBufferedAt = now;

    if (this.debounceMs === 0) {
      this.flush();
      return;
    }

    const elapsed = now - this.firstBufferedAt;
    const wait = Math.max(0, Math.min(this.debounceMs, this.maxDelayMs - elapsed));

    this.clearTimer();
    const timer = setTimeout(() => {
      this.timer = undefined;
      this.flush();
    }, wait);
    // Never hold the process open for a pending flush.
    if (typeof (timer as { unref?: () => void }).unref === "function") {
      (timer as { unref: () => void }).unref();
    }
    this.timer = timer;
  }

  private clearTimer(): void {
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
  }
}

function mergeKind(previous: FsChangeKind | undefined, next: FsChangeKind): FsChangeKind {
  if (previous === undefined) return next;
  if (next === "removed") return "removed";
  if (previous === "created" && next === "modified") return "created";
  return next;
}

export { DEFAULT_WATCH_DEBOUNCE_MS };

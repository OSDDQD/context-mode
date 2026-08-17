/**
 * Cross-query deduplication for a single search response.
 *
 * Lives beside the search pipeline rather than inside server.ts so the tool
 * modules can import it directly: a handler that had to reach back into
 * server.ts for it would close an import cycle.
 */

import { chunkIdentity } from "./hybrid.js";

/** Cross-query dedup is on unless CONTEXT_MODE_SEARCH_DEDUP=0. */
export function searchDedupEnabled(): boolean {
  return process.env.CONTEXT_MODE_SEARCH_DEDUP !== "0";
}

export type DedupDecision =
  /** Not shown yet in this response — render in full. */
  | { kind: "render" }
  /** Byte-identical snippet already rendered above — replace with a pointer. */
  | { kind: "suppress"; firstQuery: string }
  /** Same chunk, a different snippet window — render in full, marked. */
  | { kind: "further" };

/**
 * Suppresses verbatim repeats *within a single response*.
 *
 * A multi-query search answers each query independently, so a chunk that is a
 * good answer to three of them is printed three times. Measured on three live
 * `batch:` sources: 45 renders of 30 distinct chunks — 37% of the bytes handed
 * to the model were text it had already read a few lines earlier.
 *
 * The safety property is deliberately narrow: only text that is **byte-identical
 * to something already shown above in this same response** is replaced, and only
 * by a pointer to where it was shown. A different snippet window over the same
 * chunk is new information and is rendered in full. Nothing is ever dropped —
 * headings always survive, so a query whose every hit is a repeat still shows
 * what it matched rather than claiming it found nothing.
 */
export class CrossQueryDeduper {
  readonly enabled: boolean;
  /** chunk identity → first query that showed it + every snippet already shown. */
  readonly #seen = new Map<string, { query: string; snippets: Set<string> }>();
  #suppressed = 0;
  #savedBytes = 0;

  constructor(enabled: boolean = searchDedupEnabled()) {
    this.enabled = enabled;
  }

  /** Record this render and say how it should be printed. */
  consider(
    result: { source: string; title: string; content: string },
    snippet: string,
    query: string,
  ): DedupDecision {
    if (!this.enabled) return { kind: "render" };
    const key = chunkIdentity(result);
    const prior = this.#seen.get(key);
    if (!prior) {
      this.#seen.set(key, { query, snippets: new Set([snippet]) });
      return { kind: "render" };
    }
    if (prior.snippets.has(snippet)) {
      this.#suppressed++;
      this.#savedBytes += snippet.length;
      return { kind: "suppress", firstQuery: prior.query };
    }
    prior.snippets.add(snippet);
    return { kind: "further" };
  }

  /** The line that stands in for a suppressed snippet. */
  static pointerLine(firstQuery: string): string {
    return `(identical to the section shown under "${firstQuery}" — not repeated)`;
  }

  get suppressedCount(): number { return this.#suppressed; }
  get savedBytes(): number { return this.#savedBytes; }

  /** Response footer, or null when nothing was suppressed. */
  footer(): string | null {
    if (this.#suppressed === 0) return null;
    const kb = this.#savedBytes / 1024;
    const size = kb >= 0.1 ? `~${kb.toFixed(1)} KB` : `${this.#savedBytes} B`;
    return `> Deduplicated ${this.#suppressed} repeated section(s) (${size} not repeated).`;
  }
}

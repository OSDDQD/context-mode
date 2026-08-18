/**
 * Telling the caller how much of the match set it is looking at.
 *
 * A search that returns three sections says nothing about whether three is all
 * there was or the first three of forty — and the difference decides whether
 * the reader should search again. The retrieval layer already knows: RRF builds
 * a score map over every candidate before slicing to the limit.
 *
 * The rule is one-directional. "Complete" is claimed only when the candidate
 * pool is *provably* not truncated; in every other case the total is reported
 * as `N+`. Erring towards "there may be more" costs a word; erring the other
 * way tells the reader to stop looking when there was more to find.
 *
 * Formatting lives here rather than in server.ts so it can be tested without
 * importing a 6,000-line module.
 */

/** What the retrieval layer knew before it applied the limit. */
export interface SearchCompleteness {
  /** Sections actually rendered for this query. */
  shown: number;
  /** Distinct chunks in the candidate pool. A lower bound when `saturated`. */
  poolSize: number;
  /** A layer hit its fetch limit (or a post-filter ran) — more may exist. */
  saturated: boolean;
}

/** The completeness line is on unless CONTEXT_MODE_SEARCH_COMPLETENESS=0. */
export function completenessEnabled(): boolean {
  return process.env.CONTEXT_MODE_SEARCH_COMPLETENESS !== "0";
}

/** The escalation block is on unless CONTEXT_MODE_SEARCH_ESCALATION=0. */
export function escalationEnabled(): boolean {
  return process.env.CONTEXT_MODE_SEARCH_ESCALATION !== "0";
}

/** True when this query has matches the caller has not been shown. */
export function hasMore(info: SearchCompleteness): boolean {
  return info.saturated || info.poolSize > info.shown;
}

/**
 * One line per query, or null when there is nothing worth saying.
 *
 * @param query The query text, echoed into the follow-up call so it can be
 *   copied rather than reconstructed.
 */
export function formatCompletenessLine(
  query: string,
  info: SearchCompleteness,
  opts: { suggestLimit?: number } = {},
): string | null {
  if (!completenessEnabled()) return null;
  if (info.shown === 0) return null;

  if (!hasMore(info)) {
    return `> Complete: all ${info.shown} matching section(s) shown.`;
  }

  const total = info.saturated ? `${Math.max(info.poolSize, info.shown)}+` : `${info.poolSize}`;
  const limit = opts.suggestLimit ?? Math.min(10, Math.max(info.shown * 2, 5));
  const escaped = query.replace(/"/g, '\\"');
  return `> Showing ${info.shown} of ${total} matching section(s). ` +
    `More: ctx_search(queries: ["${escaped}"], limit: ${limit})`;
}

// ─────────────────────────────────────────────────────────
// Per-signal coverage — `ctx_find` fuses five sources
// ─────────────────────────────────────────────────────────

/**
 * What ONE retrieval signal saw, in the units that signal actually counts in.
 *
 * `ctx_find` merges five signals whose totals mean different things, and the
 * temptation is to add them into one number. That number would be a lie in
 * both directions, so each signal reports its own coverage and the renderer
 * puts them side by side.
 */
export interface SignalCoverage {
  /** Signal name as the caller sees it: `filename`, `content`, … */
  signal: string;
  /** Candidates this signal contributed to the fusion. */
  shown: number;
  /**
   * Denominator, in this signal's own units, or `null` when the signal cannot
   * state one honestly (fff's grep totals only the current page).
   */
  total?: number | null;
  /** Free-text detail appended verbatim, e.g. the grep file-coverage phrase. */
  detail?: string;
  /** More is reachable — another page, or a raised limit. */
  more?: boolean;
  /** The signal did not run. `detail` says why. */
  skipped?: boolean;
}

/**
 * Grep coverage, stated in files rather than matches.
 *
 * fff pages grep BY FILE, and `totalMatched` counts only the page in hand
 * (measured on 0.10.5). "Showing 12 of 12 matches" is therefore true and
 * useless: the honest denominator is how many of the eligible FILES were
 * actually opened, plus whether a cursor remains.
 */
export interface GrepCoverage {
  /** Matches on this page. */
  matches: number;
  /** Distinct files those matches came from. */
  files: number;
  /** Files consumed to build this page. */
  filesSearched: number;
  /** Files eligible for the query after its constraints. */
  filesEligible: number;
  /** A `nextCursor` came back — more pages exist. */
  morePages: boolean;
}

/** Render {@link GrepCoverage} as the `detail` of a {@link SignalCoverage}. */
export function formatGrepCoverage(cov: GrepCoverage): string {
  const searched = Math.max(0, cov.filesSearched);
  const eligible = Math.max(searched, cov.filesEligible);
  const scanned = eligible > 0
    ? `scanned ${searched}/${eligible} file(s)`
    : `scanned ${searched} file(s)`;
  const more = cov.morePages ? ", more pages" : "";
  return `${cov.matches} match(es) in ${cov.files} file(s), ${scanned}${more}`;
}

/**
 * One line summarising every signal that ran.
 *
 * Deliberately one line for all five: the caller needs to know which signals
 * were blind, not to read a table per query.
 */
export function formatSignalCoverageLine(signals: SignalCoverage[]): string | null {
  if (!completenessEnabled() || signals.length === 0) return null;
  const parts = signals.map(s => {
    if (s.skipped) return `${s.signal} off${s.detail ? ` (${s.detail})` : ""}`;
    const head = s.total == null || s.total <= s.shown
      ? `${s.shown}${s.more ? "+" : ""}`
      : `${s.shown}/${s.total}`;
    return `${s.signal} ${head}${s.detail ? ` (${s.detail})` : ""}`;
  });
  return `> Signals: ${parts.join(" · ")}`;
}

/**
 * The "showing X of Y" line for a fused, multi-signal result set.
 *
 * Separate from {@link formatCompletenessLine} only in the follow-up call it
 * suggests — the pool arithmetic is the same, and `saturated` still means the
 * total is a lower bound.
 */
export function formatFindCompletenessLine(
  query: string,
  info: SearchCompleteness,
  opts: { suggestLimit?: number } = {},
): string | null {
  if (!completenessEnabled()) return null;
  if (info.shown === 0) return null;

  if (!hasMore(info)) {
    return `> Complete: all ${info.shown} candidate(s) shown.`;
  }
  const total = info.saturated ? `${Math.max(info.poolSize, info.shown)}+` : `${info.poolSize}`;
  const limit = opts.suggestLimit ?? Math.max(info.shown * 2, 10);
  const escaped = query.replace(/"/g, '\\"');
  return `> Showing ${info.shown} of ${total} candidate(s). ` +
    `More: ctx_find(query: "${escaped}", limit: ${limit})`;
}

/**
 * One block per response, when at least one query had more to give.
 *
 * Separate from the per-query line because the advice ("narrow it, or ask for
 * more") is the same however many queries ran, and repeating it per query is
 * exactly the kind of padding this plugin exists to remove.
 */
export function formatEscalationBlock(infos: SearchCompleteness[]): string | null {
  if (!escalationEnabled() || !completenessEnabled()) return null;
  const truncated = infos.filter(i => i.shown > 0 && hasMore(i)).length;
  if (truncated === 0) return null;
  return `> ${truncated} query(s) had more matches than shown. ` +
    `Raise \`limit\`, scope with \`source: "<label>"\`, or ask a narrower question.`;
}

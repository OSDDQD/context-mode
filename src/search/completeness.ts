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

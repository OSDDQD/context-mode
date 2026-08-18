// Stops a weaker measurement from silently replacing a stronger one.
//
// `scripts/measure-retrieval.mjs` reports two arms — lexical, which needs
// nothing, and hybrid, which needs a live embedding endpoint. A run made
// without that endpoint is a *complete* run of one arm and a *missing* run of
// the other, and it used to overwrite the report either way. That is how
// docs/research/retrieval-2026-08-18.md lost its hybrid column: someone ran the
// harness to check a number, had no endpoint, and the file was rewritten with
// eight rows of `—` where the measurements had been.
//
// The check reads the file it is about to replace rather than trusting the
// environment. Whoever overwrites may have a different environment than
// whoever wrote — that is exactly the case that went wrong, so the environment
// cannot be the authority on what the file currently holds.

/** The row the metric table always opens with, whatever else the report says. */
const METRIC_ROW = /^\|\s*precision@1\s*\|([^|]*)\|([^|]*)\|/m;

/**
 * Which arms a rendered report actually carries.
 *
 * A cell holding the em dash placeholder is an arm that did not run. Parsing
 * the rendered table rather than a sidecar keeps the answer true for any report
 * on disk, including ones written before this check existed.
 */
export function reportArms(markdown) {
  const row = METRIC_ROW.exec(markdown ?? "");
  if (!row) return { lexical: false, hybrid: false };
  const filled = (cell) => {
    const v = (cell ?? "").trim();
    return v.length > 0 && v !== "—" && v !== "-";
  };
  return { lexical: filled(row[1]), hybrid: filled(row[2]) };
}

/** Arm names present in `arms`, for a human-readable message. */
function armNames(arms) {
  return Object.entries(arms).filter(([, on]) => on).map(([name]) => name);
}

/**
 * May this run overwrite `existing`?
 *
 * Refuses only the strictly-worse case: an arm the file already has that this
 * run does not. A run with the same arms, or with more, overwrites freely —
 * re-measuring is the normal use, and requiring a flag for it would train
 * everyone to pass `--force` by reflex, which un-does the guard.
 *
 * @param existing Current file contents, or null/undefined when there is none.
 * @returns `{ ok: true }`, or `{ ok: false, reason }` with a message that names
 *          what would be lost and how to proceed anyway.
 */
export function checkReportOverwrite({ existing, arms, force = false }) {
  if (existing == null) return { ok: true };
  const had = reportArms(existing);
  const losing = Object.keys(had).filter((arm) => had[arm] && !arms[arm]);
  if (losing.length === 0) return { ok: true };
  if (force) return { ok: true, forced: losing };
  return {
    ok: false,
    losing,
    reason:
      `refusing to overwrite: the existing report measured ${armNames(had).join(" + ")}, ` +
      `this run measured ${armNames(arms).join(" + ") || "nothing"} — writing it would ` +
      `discard the ${losing.join(" and ")} arm. Re-run with the missing arm available ` +
      `(the hybrid arm needs CONTEXT_MODE_EMBEDDINGS_URL to answer), write elsewhere with ` +
      `--report <path>, or overwrite deliberately with --force.`,
  };
}

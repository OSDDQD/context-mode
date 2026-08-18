/**
 * Secret screening for content on its way into the knowledge base.
 *
 * The index is a durable, searchable copy of whatever passed through a tool.
 * A `.env` pasted into a batch command, an `aws configure` transcript, a PEM
 * cat'ed by mistake — all of it lands in SQLite and stays there, answering
 * searches, long after the terminal scrollback is gone. `isSensitivePath`
 * (session/code-index.ts) already keeps whole files out by name; this keeps
 * credentials out of the files nobody would think to exclude.
 *
 * ## What it does, and what it does not promise
 *
 * Two layers, deliberately unequal:
 *
 * - **Patterns** (on by default): known token shapes and assignments to
 *   obviously-named keys. Every rule is anchored on a literal marker a real
 *   credential must contain — `sk-`, `AKIA`, `ghp_`, `PRIVATE KEY`. That makes
 *   it cheap, and it makes a false positive something you can reason about.
 * - **Entropy** (off by default, `CONTEXT_MODE_INDEX_ENTROPY_REDACT=1`): a
 *   heuristic, and only that. On real code it fires on base64-inlined assets,
 *   minified bundles, UUIDs and git object ids — content that is not secret and
 *   that the index exists to make searchable. It would not deliver "no secret
 *   ever reaches the index" even if it were on, because a secret with no marker
 *   and ordinary-looking entropy passes both layers. Treat it as a second pair
 *   of eyes on a paste you already distrust, never as a guarantee.
 *
 * The honest summary: this reduces accidental capture. It is not a control you
 * should rely on to handle credentials safely.
 *
 * ## Shape
 *
 * `redactSecrets` is pure — no env reads, no I/O, no store dependency, no
 * module-level mutable state. Configuration is resolved once by
 * `redactOptionsFromEnv` and passed in, because this sits on the hot path of
 * every index() call and `process.env` lookups are not free at that rate.
 */

/** Kinds of redaction, and the label that appears in the replacement marker. */
export type RedactionType =
  | "openai-key"
  | "github-token"
  | "aws-access-key"
  | "slack-token"
  | "private-key"
  | "assigned-secret"
  | "high-entropy";

export interface RedactOptions {
  /** Literal-anchored token patterns. Default: true. */
  patterns?: boolean;
  /**
   * Shannon-entropy heuristic over long opaque tokens. Default: false.
   * See the module note — this is a heuristic with real false positives.
   */
  entropy?: boolean;
}

export interface RedactResult {
  /** The screened text. Identical (same reference) when nothing matched. */
  text: string;
  /** Hits per type. Types that did not fire are absent, not zero. */
  redactions: Partial<Record<RedactionType, number>>;
  /** Total hits, so callers do not have to sum the record. */
  count: number;
}

/** The marker a redacted value is replaced with. */
export function redactionMarker(type: RedactionType): string {
  return `[redacted:${type}]`;
}

/**
 * Key names that make a long value on the right-hand side worth hiding.
 *
 * Kept byte-identical to `SENSITIVE_NAME_HINT` in session/code-index.ts, which
 * uses it to keep whole files out of the index. The duplication is deliberate:
 * this module has no imports, so it stays cheap to load on the indexing path,
 * and `tests/session/redact.test.ts` asserts the two sources agree so the copy
 * cannot drift unnoticed.
 */
const SENSITIVE_NAME_HINT = /(secret|credential|password|passwd|apikey|api[-_]key|private[-_]?key|token)/i;

/**
 * Minimum length of an assigned value before it is treated as a credential.
 *
 * Under this, the false positives dominate: `token: abc`, `password = ""`,
 * `apiKey: "test-key"` are placeholders and test fixtures, and redacting them
 * damages the index for no gain.
 */
const MIN_ASSIGNED_VALUE = 17;

/**
 * Token rules.
 *
 * Every pattern is guarded on both sides against `[A-Za-z0-9_-]`. That guard is
 * what keeps `sk-` out of `task-manager` and keeps `AKIA…` from matching inside
 * a base64 blob, where the run is never delimited.
 */
const TOKEN_RULES: ReadonlyArray<{ type: RedactionType; hint: string[]; re: RegExp }> = [
  {
    // sk-…, sk-proj-…, sk-ant-… . 20 chars minimum: real keys are 48+, while
    // `sk-test` and `sk-xxx` in documentation are not credentials.
    type: "openai-key",
    hint: ["sk-"],
    re: /(?<![A-Za-z0-9_-])sk-[A-Za-z0-9_-]{20,}/g,
  },
  {
    // ghp_ (classic PAT), gho_ (OAuth), ghu_/ghs_/ghr_ (app tokens). 30+ of
    // base62 follows; GitHub's own format is 36.
    type: "github-token",
    hint: ["ghp_", "gho_", "ghu_", "ghs_", "ghr_"],
    re: /(?<![A-Za-z0-9_-])gh[pousr]_[A-Za-z0-9]{30,}/g,
  },
  {
    // AKIA/ASIA + exactly 16 uppercase base36. The trailing guard matters most
    // here: without it this fires inside every long uppercase blob.
    type: "aws-access-key",
    hint: ["AKIA", "ASIA"],
    re: /(?<![A-Za-z0-9])A[KS]IA[0-9A-Z]{16}(?![A-Za-z0-9])/g,
  },
  {
    type: "slack-token",
    hint: ["xox"],
    re: /(?<![A-Za-z0-9_-])xox[baprs]-[A-Za-z0-9-]{10,}/g,
  },
];

/**
 * A PEM header on a line of its own.
 *
 * Anchored to the whole (trimmed) line on purpose. `const PEM_HEADER =
 * "-----BEGIN RSA PRIVATE KEY-----"` is source code about PEM, not a key, and
 * an unanchored rule redacts it — along with the parser that mentions it.
 */
const PEM_BEGIN = /^-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----$/;
const PEM_END = /^-----END (?:[A-Z0-9 ]+ )?PRIVATE KEY-----$/;

/**
 * `key = value`, `key: value`, `"key": "value"`.
 *
 * The value is a single opaque run — letters, digits and the punctuation base64
 * and JWTs use. Anything with a bracket, a space or an operator in it is an
 * expression, not a credential, and the class ends the match there.
 */
const ASSIGNMENT = /([A-Za-z_][A-Za-z0-9_-]*)(["']?\s*[:=]\s*)(["'`]?)([A-Za-z0-9_\-+/=.~]+)\3/g;

/** Leading noise before an assignment that still counts as "line starts here". */
const ASSIGNMENT_LEAD = /^[\s>#-]*(?:export\s+|set\s+|ENV\s+)?/;

/**
 * Does this value look like a credential rather than like code or a path?
 *
 * The rules below were not guessed: screening this repository's own 136 source
 * files produced nine false positives, every one of them an ordinary expression
 * assigned to a name containing "token" — `const input_tokens = toNum(u.…)`,
 * `tokens: Math.round(…)`, `const tokens = tokenizeCommand(cmd)`. A credential
 * is a literal, so the value has to look like one.
 */
function looksLikeSecretValue(value: string): boolean {
  if (value.length < MIN_ASSIGNED_VALUE) return false;
  if (value.startsWith(MARKER_PREFIX)) return false;
  if (/^\d+$/.test(value)) return false;                       // counters, timestamps
  if (/^[.~/\\]|^[A-Za-z]:[\\/]|:\/\//.test(value)) return false; // paths and URLs
  if (value.includes("/") && /\.[A-Za-z0-9]{1,5}$/.test(value)) return false; // path/to/file.pem
  return true;
}

/**
 * The extra bar an UNQUOTED value has to clear.
 *
 * Without it, `apiKey: env.CONTEXT_MODE_EMBEDDINGS_API_KEY?.trim()` and
 * `cache_creation_tokens: cacheCreationTokens` — both real lines from this
 * repository — read as assignments of a long value to a sensitive-looking key.
 * What separates a credential from an identifier is charset: a secret carries
 * digits among its letters, and an identifier is words. Dotted values are
 * allowed only when every segment is long, which admits a JWT and rejects
 * member access like `config.oauth2Token`.
 */
function looksLikeBareSecret(value: string): boolean {
  if (!/\d/.test(value) || !/[A-Za-z]/.test(value)) return false;
  if (value.includes(".") && value.split(".").some((seg) => seg.length < 10)) return false;
  return true;
}

/** Already-redacted values must not be redacted again, or counts inflate. */
const MARKER_PREFIX = "[redacted:";

function bump(into: Partial<Record<RedactionType, number>>, type: RedactionType): void {
  into[type] = (into[type] ?? 0) + 1;
}

/**
 * Shannon entropy in bits per character.
 *
 * Exported for the tests and for anyone tuning the opt-in threshold; it is not
 * part of the screening contract.
 */
export function shannonEntropy(s: string): number {
  if (s.length === 0) return 0;
  const freq = new Map<string, number>();
  for (const ch of s) freq.set(ch, (freq.get(ch) ?? 0) + 1);
  let bits = 0;
  for (const n of freq.values()) {
    const p = n / s.length;
    bits -= p * Math.log2(p);
  }
  return bits;
}

/** Opaque runs long enough to be worth an entropy measurement. */
const ENTROPY_CANDIDATE = /(?<![A-Za-z0-9+/=_-])[A-Za-z0-9+/=_-]{32,}(?![A-Za-z0-9+/=_-])/g;
const ENTROPY_MIN_BITS = 4.6;

/**
 * True when a run looks like a credential rather than like an identifier.
 *
 * Even with the threshold, this is the layer that misfires: a base64 asset and
 * a 64-char API key are the same measurement. The extra shape checks below only
 * remove the cheapest false positives (all-hex git ids, UUIDs, single-case
 * runs); they do not make the layer safe to enable by default.
 */
function looksHighEntropy(run: string): boolean {
  if (/^[0-9a-f]+$/i.test(run)) return false;               // git object ids, md5/sha hex
  if (/^[0-9a-f-]+$/i.test(run) && run.includes("-")) return false; // UUIDs
  if (!/[a-z]/.test(run) || !/[A-Z0-9]/.test(run)) return false;    // single-case words
  return shannonEntropy(run) >= ENTROPY_MIN_BITS;
}

/**
 * Screen one line. Returns the line unchanged (same reference) when nothing
 * matched, so the common case allocates nothing.
 */
function screenLine(
  line: string,
  opts: { patterns: boolean; entropy: boolean },
  counts: Partial<Record<RedactionType, number>>,
): string {
  let out = line;

  if (opts.patterns) {
    for (const rule of TOKEN_RULES) {
      // Literal pre-check: an indexOf scan is far cheaper than a regex pass,
      // and on real content it rejects essentially every line.
      if (!rule.hint.some((h) => out.includes(h))) continue;
      out = out.replace(rule.re, () => {
        bump(counts, rule.type);
        return redactionMarker(rule.type);
      });
    }

    if ((out.includes("=") || out.includes(":")) && SENSITIVE_NAME_HINT.test(out)) {
      // Where the assignment has to start to count as unquoted: an env line
      // (`API_TOKEN=…`) or a YAML key, not `const api_token = someCall(x)`
      // buried mid-line.
      const anchor = (ASSIGNMENT_LEAD.exec(out)?.[0].length ?? 0);
      out = out.replace(ASSIGNMENT, (match, key: string, sep: string, quote: string, value: string, offset: number) => {
        if (!SENSITIVE_NAME_HINT.test(key)) return match;
        if (!looksLikeSecretValue(value)) return match;
        // A quoted literal is a credential wherever it sits; an unquoted one
        // only where the line is an assignment and nothing else, and only when
        // it does not read as an identifier.
        if (quote === "" && (offset !== anchor || !looksLikeBareSecret(value))) return match;
        bump(counts, "assigned-secret");
        return `${key}${sep}${quote}${redactionMarker("assigned-secret")}${quote}`;
      });
    }
  }

  if (opts.entropy) {
    out = out.replace(ENTROPY_CANDIDATE, (run) => {
      if (run.startsWith(MARKER_PREFIX) || !looksHighEntropy(run)) return run;
      bump(counts, "high-entropy");
      return redactionMarker("high-entropy");
    });
  }

  return out;
}

/**
 * Replace credentials in `text` with `[redacted:<type>]` markers.
 *
 * Line-oriented: each line is screened on its own, with one exception — a PEM
 * private key, whose body carries the secret and whose header alone would be a
 * pointless redaction. A `-----BEGIN … PRIVATE KEY-----` line on its own opens a
 * block that is replaced, header through footer, by a single marker.
 *
 * Pure: no env, no I/O. Returns the original string by reference when nothing
 * was found, which is the case for virtually all indexed content.
 */
export function redactSecrets(text: string, opts: RedactOptions = {}): RedactResult {
  const resolved = { patterns: opts.patterns !== false, entropy: opts.entropy === true };
  if (!resolved.patterns && !resolved.entropy) return { text, redactions: {}, count: 0 };
  if (text.length === 0) return { text, redactions: {}, count: 0 };

  const counts: Partial<Record<RedactionType, number>> = {};
  const lines = text.split("\n");
  const out: string[] = new Array(lines.length);
  let changed = false;
  let inPemBlock = false;
  let written = 0;

  for (const line of lines) {
    if (inPemBlock) {
      changed = true;
      // Everything up to and including the footer belongs to the key. An
      // unterminated block runs to the end of the text — a truncated PEM is
      // still a PEM.
      if (resolved.patterns && PEM_END.test(line.trim())) inPemBlock = false;
      continue;
    }

    if (resolved.patterns && PEM_BEGIN.test(line.trim())) {
      bump(counts, "private-key");
      out[written++] = redactionMarker("private-key");
      inPemBlock = true;
      changed = true;
      continue;
    }

    const screened = screenLine(line, resolved, counts);
    if (screened !== line) changed = true;
    out[written++] = screened;
  }

  if (!changed) return { text, redactions: {}, count: 0 };

  out.length = written;
  const count = Object.values(counts).reduce((n, v) => n + v, 0);
  return { text: out.join("\n"), redactions: counts, count };
}

/**
 * Resolve screening options from the environment, once.
 *
 * `CONTEXT_MODE_INDEX_REDACT=0` turns pattern screening off; anything else
 * leaves it on. `CONTEXT_MODE_INDEX_ENTROPY_REDACT=1` turns the entropy
 * heuristic on; anything else leaves it off. Call this where the store is
 * configured, not inside the indexing loop.
 */
export function redactOptionsFromEnv(env: NodeJS.ProcessEnv = process.env): RedactOptions {
  return {
    patterns: env.CONTEXT_MODE_INDEX_REDACT !== "0",
    entropy: env.CONTEXT_MODE_INDEX_ENTROPY_REDACT === "1",
  };
}

/**
 * session/tokenizer — honest token accounting for ctx_stats.
 *
 * Replaces the `bytes / 4` constant that every savings number in
 * `analytics.ts` and the statusline payload in `server.ts` used to rest on.
 * `bytes / 4` is the rule of thumb for English prose under cl100k_base; on
 * the payloads context-mode actually redirects (JSON, CSV, logs, `ls -laR`,
 * `npm ls`, base64 blobs) it understates the real cost by 20-60%, and on
 * Cyrillic prose under o200k_base it *overstates* it by ~60%.
 *
 * Two entry points, because the call sites come in two shapes:
 *
 *   - `countTokens(text)`      — text in hand. Single-pass calibrated
 *                                heuristic (or a real BPE encoder when one
 *                                happens to be installed, see `exact` mode).
 *   - `tokensFromBytes(bytes)` — only an aggregate byte count survives
 *                                (`SUM(LENGTH(data))` out of SQLite). Uses
 *                                the corpus-measured bytes-per-token for the
 *                                mix context-mode redirects, not the number 4.
 *
 * `bytesFromTokens()` is the exact inverse of `tokensFromBytes()` so the
 * places that convert back (the "all work" byte tally in the narrative
 * report) stay on the same basis — every ratio in ctx_stats has both of its
 * sides computed by the same function.
 *
 * ── Calibration ─────────────────────────────────────────────────────────
 * Coefficients below were fitted by non-negative least squares against a
 * reference BPE implementation of `o200k_base` / `cl100k_base` (OpenAI's
 * published rank tables), over ~4.1 MB drawn from:
 *   - this repository: 900 KB of TypeScript, 345 KB of JSON, 660 KB of
 *     markdown (English + Russian), shell, YAML
 *   - real tool output: `git log --stat`, `git show -p`, `ls -laR`,
 *     `find`, `npm ls --all`, `ps aux`, `env`/`df`/`free`
 *   - machine payloads: CSV, timestamped logs, base64, hex dumps, HTML
 *   - Wikipedia prose in 16 languages (ru, en, de, fr, es, zh, ja, ko, ar,
 *     he, pl, pt, it, nl, sv) plus emoji-heavy log lines
 *
 * Held-out accuracy (25% of chunks never seen by the fit), mean absolute
 * percentage error per 4 KB chunk:
 *   o200k_base   heuristic 4.6%   ·   bytes/4 18.7%
 *   cl100k_base  heuristic 4.8%   ·   bytes/4 15.3%
 *
 * `CONTEXT_MODE_TOKENIZER=bytes4` restores the old constant everywhere.
 */


// ─────────────────────────────────────────────────────────
// Public types
// ─────────────────────────────────────────────────────────

/** The two BPE vocabularies worth distinguishing for a byte-cost estimate. */
export type TokenizerEncoding = "o200k_base" | "cl100k_base";

/** Which coefficient set a payload is scored against. */
export type ContentProfile = "code" | "structured" | "prose";

/**
 * - `bytes4`    — legacy `bytes / 4`, byte-identical to pre-fork behaviour.
 * - `heuristic` — calibrated single-pass counter (default).
 * - `exact`     — use a real BPE encoder IF one is already installed;
 *                 silently degrades to `heuristic` when it is not.
 */
export type TokenizerMode = "bytes4" | "heuristic" | "exact";

/**
 * What we know about the model at the call site. Every field is optional —
 * with nothing supplied the estimate uses `o200k_base` (every model shipped
 * since 2024).
 *
 * There is deliberately no host field any more. Routing by platform id was
 * how this file decided between vocabularies, and it survived the removal of
 * fifteen hosts as three dead lookups: an empty `LEGACY_ENCODING_PLATFORMS`
 * set, a `GEMINI_PLATFORMS` set holding only ids no `detectPlatform()` can
 * return, and a `qwen-cli-mcp-client` client-name branch producing a
 * `PlatformId` nothing consumed. Both remaining hosts price against tiktoken
 * vocabularies, so what is left that genuinely changes the estimate is the
 * model id and an explicit override — and both are here.
 */
export interface TokenizerContext {
  /** Model identifier, when the host advertises one. */
  model?: string;
  /** Hard override — skips model-id detection. */
  encoding?: TokenizerEncoding;
}

// ─────────────────────────────────────────────────────────
// Character classes — one branch per code unit, no regex
// ─────────────────────────────────────────────────────────

const CLS_LATIN = 1;
const CLS_DIGIT = 2;
const CLS_CYRILLIC = 3;
const CLS_CJK = 4;
const CLS_SPACE = 5;
const CLS_PUNCT = 6;
const CLS_SCRIPT = 7;
const CLS_SYMBOL = 8;

function classOf(c: number): number {
  if (c < 128) {
    if ((c >= 97 && c <= 122) || (c >= 65 && c <= 90)) return CLS_LATIN;
    if (c >= 48 && c <= 57) return CLS_DIGIT;
    if (c === 32 || c === 9 || c === 10 || c === 13) return CLS_SPACE;
    if (c < 32) return CLS_SYMBOL;
    return CLS_PUNCT;
  }
  if (c >= 0x0400 && c <= 0x052f) return CLS_CYRILLIC;
  if (c >= 0x00c0 && c <= 0x024f) return CLS_LATIN;   // Latin-1 supplement + Extended-A/B
  if (c >= 0x0370 && c <= 0x03ff) return CLS_LATIN;   // Greek
  if (c >= 0x0530 && c <= 0x1fff) return CLS_SCRIPT;  // Armenian…Arabic, Indic, Thai, Georgian
  if (c >= 0x3040 && c <= 0x30ff) return CLS_CJK;     // kana
  if (c >= 0x3400 && c <= 0x9fff) return CLS_CJK;     // han
  if (c >= 0xac00 && c <= 0xd7af) return CLS_CJK;     // hangul
  return CLS_SYMBOL;
}

/**
 * Structural summary of a payload. Every field is a count the BPE merge
 * behaviour is actually sensitive to: how many word runs there are (a run
 * usually costs one token however long it is, up to a point), how many
 * case boundaries split identifiers, how many digit groups (both vocabs cap
 * a numeric token at three digits), and how much of the text is in a script
 * whose bytes the vocabulary spends more tokens on.
 */
export interface TokenFeatures {
  chars: number;
  bytes: number;
  latinRuns: number;
  latinChars: number;
  latinExtChars: number;
  caseBreaks: number;
  longWordExcess: number;
  hugeRunExcess: number;
  digitTokens: number;
  cyrRuns: number;
  cyrChars: number;
  hanChars: number;
  kanaChars: number;
  hangulChars: number;
  scriptChars: number;
  punctRuns: number;
  punctChars: number;
  newlines: number;
  spaceRuns: number;
  spaceExcess: number;
  symbolRuns: number;
  symbolBytes: number;
}

/**
 * One pass over the string, one branch per code unit. No regex, no
 * intermediate arrays, no allocation beyond the result record — this runs on
 * the ctx_stats render path and on every persisted statusline payload.
 */
export function extractFeatures(text: string): TokenFeatures {
  const f: TokenFeatures = {
    chars: text.length, bytes: 0,
    latinRuns: 0, latinChars: 0, latinExtChars: 0, caseBreaks: 0,
    longWordExcess: 0, hugeRunExcess: 0,
    digitTokens: 0,
    cyrRuns: 0, cyrChars: 0,
    hanChars: 0, kanaChars: 0, hangulChars: 0,
    scriptChars: 0,
    punctRuns: 0, punctChars: 0,
    newlines: 0, spaceRuns: 0, spaceExcess: 0,
    symbolRuns: 0, symbolBytes: 0,
  };
  let prevClass = 0;
  let runLen = 0;
  let prevLower = false;
  const n = text.length;

  for (let i = 0; i < n; i++) {
    const c = text.charCodeAt(i);

    // UTF-8 width. A surrogate pair is charged once, on the high half.
    let nb: number;
    if (c < 0x80) nb = 1;
    else if (c < 0x800) nb = 2;
    else if (c >= 0xd800 && c < 0xdc00) nb = 4;
    else if (c >= 0xdc00 && c < 0xe000) nb = 0;
    else nb = 3;
    f.bytes += nb;

    const k = classOf(c);
    if (k !== prevClass) {
      // Close the run that just ended.
      if (prevClass === CLS_LATIN) {
        f.latinRuns++;
        if (runLen > 6) f.longWordExcess += runLen - 6;
        if (runLen > 12) f.hugeRunExcess += runLen - 12;
      } else if (prevClass === CLS_DIGIT) {
        // Both vocabularies emit at most three digits per token.
        f.digitTokens += Math.ceil(runLen / 3);
      } else if (prevClass === CLS_CYRILLIC) {
        f.cyrRuns++;
      } else if (prevClass === CLS_PUNCT) {
        f.punctRuns++;
      } else if (prevClass === CLS_SYMBOL) {
        f.symbolRuns++;
      }
      prevClass = k;
      runLen = 1;
    } else {
      runLen++;
    }

    switch (k) {
      case CLS_LATIN:
        if (c < 128) {
          f.latinChars++;
          if (c >= 65 && c <= 90 && prevLower) f.caseBreaks++;  // camelCase split
          prevLower = c >= 97 && c <= 122;
        } else {
          f.latinExtChars++;
          prevLower = true;
        }
        break;
      case CLS_DIGIT:
        prevLower = false;
        break;
      case CLS_CYRILLIC:
        f.cyrChars++;
        prevLower = false;
        break;
      case CLS_CJK:
        if (c < 0x3100) f.kanaChars++;
        else if (c < 0xa000) f.hanChars++;
        else f.hangulChars++;
        prevLower = false;
        break;
      case CLS_SCRIPT:
        f.scriptChars++;
        prevLower = false;
        break;
      case CLS_PUNCT:
        f.punctChars++;
        prevLower = false;
        break;
      case CLS_SPACE:
        prevLower = false;
        if (c === 10) f.newlines++;
        else if (runLen === 1) f.spaceRuns++;
        else f.spaceExcess++;   // indentation compresses hard
        break;
      default:
        f.symbolBytes += nb;
        prevLower = false;
        break;
    }
  }

  // Close the trailing run.
  if (prevClass === CLS_LATIN) {
    f.latinRuns++;
    if (runLen > 6) f.longWordExcess += runLen - 6;
    if (runLen > 12) f.hugeRunExcess += runLen - 12;
  } else if (prevClass === CLS_DIGIT) {
    f.digitTokens += Math.ceil(runLen / 3);
  } else if (prevClass === CLS_CYRILLIC) {
    f.cyrRuns++;
  } else if (prevClass === CLS_PUNCT) {
    f.punctRuns++;
  } else if (prevClass === CLS_SYMBOL) {
    f.symbolRuns++;
  }

  return f;
}

// ─────────────────────────────────────────────────────────
// Fitted coefficients (see the calibration note at the top)
// ─────────────────────────────────────────────────────────

type Weights = { [K in keyof TokenFeatures]?: number };

const WEIGHTS: Record<TokenizerEncoding, Record<ContentProfile, Weights>> = {
  o200k_base: {
    code: {
      latinRuns: 0.35610, latinChars: 0.05401, latinExtChars: 0.50311,
      caseBreaks: 0.37993, longWordExcess: 0.10497, hugeRunExcess: 0.00000,
      digitTokens: 2.12938,
      cyrRuns: 0.68968, cyrChars: 0.09834,
      hanChars: 0.76542, kanaChars: 0.77283, hangulChars: 0.63276,
      scriptChars: 0.34025,
      punctRuns: 0.46079, punctChars: 0.31941,
      newlines: 0.74859, spaceRuns: 0.32234, spaceExcess: 0.09397,
      symbolRuns: 0.88849, symbolBytes: 0.04440,
    },
    structured: {
      latinRuns: 0.41408, latinChars: 0.06480, latinExtChars: 0.50311,
      caseBreaks: 1.24011, longWordExcess: 0.05570, hugeRunExcess: 0.39416,
      digitTokens: 1.43047,
      cyrRuns: 0.68968, cyrChars: 0.00000,
      hanChars: 0.84122, kanaChars: 0.74960, hangulChars: 0.63276,
      scriptChars: 0.34025,
      punctRuns: 0.35608, punctChars: 0.23650,
      newlines: 0.78159, spaceRuns: 0.84735, spaceExcess: 0.06598,
      symbolRuns: 1.02968, symbolBytes: 0.08285,
    },
    prose: {
      latinRuns: 0.30551, latinChars: 0.05669, latinExtChars: 0.50311,
      caseBreaks: 0.00000, longWordExcess: 0.17638, hugeRunExcess: 0.24888,
      digitTokens: 1.41855,
      cyrRuns: 0.68968, cyrChars: 0.11453,
      hanChars: 0.76542, kanaChars: 0.77283, hangulChars: 0.63276,
      scriptChars: 0.34025,
      punctRuns: 0.52610, punctChars: 0.35359,
      newlines: 0.64381, spaceRuns: 0.35432, spaceExcess: 0.11918,
      symbolRuns: 1.36446, symbolBytes: 0.00000,
    },
  },
  cl100k_base: {
    code: {
      latinRuns: 0.35478, latinChars: 0.05316, latinExtChars: 1.12308,
      caseBreaks: 0.35599, longWordExcess: 0.09858, hugeRunExcess: 0.00000,
      digitTokens: 2.18849,
      cyrRuns: 1.49010, cyrChars: 0.21523,
      hanChars: 1.35488, kanaChars: 1.05417, hangulChars: 1.19749,
      scriptChars: 0.99035,
      punctRuns: 0.45121, punctChars: 0.31460,
      newlines: 0.75656, spaceRuns: 0.32293, spaceExcess: 0.10189,
      symbolRuns: 1.16831, symbolBytes: 0.06358,
    },
    structured: {
      latinRuns: 0.42523, latinChars: 0.06580, latinExtChars: 1.12308,
      caseBreaks: 1.56359, longWordExcess: 0.02294, hugeRunExcess: 0.36225,
      digitTokens: 1.43139,
      cyrRuns: 1.49010, cyrChars: 0.11463,
      hanChars: 1.43316, kanaChars: 0.98795, hangulChars: 1.19749,
      scriptChars: 0.99035,
      punctRuns: 0.34797, punctChars: 0.23127,
      newlines: 0.85473, spaceRuns: 0.83847, spaceExcess: 0.06942,
      symbolRuns: 0.74473, symbolBytes: 0.06777,
    },
    prose: {
      latinRuns: 0.32261, latinChars: 0.06266, latinExtChars: 1.12308,
      caseBreaks: 0.00000, longWordExcess: 0.27941, hugeRunExcess: 0.53590,
      digitTokens: 1.60595,
      cyrRuns: 1.49010, cyrChars: 0.25269,
      hanChars: 1.35488, kanaChars: 1.05417, hangulChars: 1.19749,
      scriptChars: 0.99035,
      punctRuns: 0.35084, punctChars: 0.22975,
      newlines: 0.56794, spaceRuns: 0.39230, spaceExcess: 0.09916,
      symbolRuns: 0.75600, symbolBytes: 0.00000,
    },
  },
};

/**
 * Bytes per token for the payload mix context-mode actually diverts —
 * measured over the tool-output + JSON + code + markdown slice of the
 * calibration corpus (2.7 MB): 3.487 under o200k_base, 3.484 under
 * cl100k_base. This is what the byte-only call sites use in place of 4.
 */
const BYTES_PER_TOKEN: Record<TokenizerEncoding, number> = {
  o200k_base: 3.487,
  cl100k_base: 3.484,
};

/** The pre-fork constant, kept as a named thing so `bytes4` mode is explicit. */
export const LEGACY_BYTES_PER_TOKEN = 4;

// ─────────────────────────────────────────────────────────
// Content profile
// ─────────────────────────────────────────────────────────

/**
 * Pick the coefficient set from the features we already computed — no
 * second pass, no sniffing of file extensions (the call sites have bytes,
 * not filenames).
 *
 * - `prose`      — mostly letters, little punctuation: markdown, commit
 *                  messages, documentation, natural language of any script.
 * - `structured` — JSON/CSV/log/base64/`ls -laR`: punctuation- or
 *                  digit-dense, or built from tokens no vocabulary has.
 * - `code`       — everything in between, which is what source files are.
 */
export function classifyContent(features: TokenFeatures): ContentProfile {
  const chars = features.chars || 1;
  const alpha =
    features.latinChars + features.latinExtChars + features.cyrChars +
    features.hanChars + features.kanaChars + features.hangulChars +
    features.scriptChars;
  const alphaRatio = alpha / chars;
  const punctRatio = features.punctChars / chars;
  const digitRatio = (features.digitTokens * 2) / chars;
  const wordLen = features.latinChars / Math.max(features.latinRuns, 1);
  const lineLen = chars / Math.max(features.newlines, 1);
  const spaceRatio = features.spaceRuns / chars;

  // Almost no spaces over a meaningful length: base64, hex dumps, minified
  // payloads, opaque identifiers. Letter-dense enough to look like prose to
  // the ratios below, but priced like the machine data it is.
  if (chars > 64 && spaceRatio < 0.02) return "structured";

  if (alphaRatio >= 0.62 && punctRatio <= 0.10 && wordLen <= 12) return "prose";
  if (punctRatio >= 0.22 || digitRatio >= 0.16 || wordLen >= 14) return "structured";
  if (alphaRatio < 0.30 && lineLen < 400) return "structured";
  return "code";
}

/** Convenience wrapper for callers holding a string rather than features. */
export function profileOf(text: string): ContentProfile {
  return classifyContent(extractFeatures(text));
}

// ─────────────────────────────────────────────────────────
// Encoding resolution
// ─────────────────────────────────────────────────────────

/** Model families still on cl100k_base. */
const CL100K_MODEL = /^(?:gpt-4(?:-|$)|gpt-4-32k|gpt-3\.5|text-(?:davinci|curie|babbage|ada)|code-davinci|text-embedding-ada-002|claude-(?:2|instant))/i;

/**
 * Model or platform families whose tokenizer is not a tiktoken BPE at all.
 * Gemini/Gemma use SentencePiece, which on the same text runs roughly 10%
 * longer than o200k_base; we correct the estimate rather than pretend the
 * vocabularies match.
 */
const GEMINI_MODEL = /gemini|gemma|palm|bison/i;
const GEMINI_CORRECTION = 1.1;

/**
 * Which vocabulary to score against. Priority: explicit override → env →
 * model id → o200k_base (correct for every model shipped since mid-2024,
 * which is every model either live host runs).
 *
 * No platform probe: this runs on the ctx_stats render path and the
 * statusline persist throttle, and it used to call `detectPlatform()` —
 * env walk plus config-dir stats — purely to look the answer up in an empty
 * set.
 */
export function resolveEncoding(ctx?: TokenizerContext): TokenizerEncoding {
  if (ctx?.encoding) return ctx.encoding;

  const env = process.env.CONTEXT_MODE_TOKENIZER_ENCODING?.trim();
  if (env === "o200k_base" || env === "cl100k_base") return env;

  const model = ctx?.model?.trim() || process.env.PI_CONTEXT_MODE_MODEL_ID?.trim();
  if (model && CL100K_MODEL.test(model)) return "cl100k_base";

  return "o200k_base";
}

/**
 * Multiplier applied on top of the BPE estimate for models whose real
 * tokenizer is not tiktoken. 1 for everything except the Gemini family.
 *
 * Keyed on the model id alone. `PI_CONTEXT_MODE_MODEL_ID` stays in the
 * lookup even though Pi is gone: the same operator-set variable still names
 * the model in the ctx_stats price line (analytics.ts), so honouring it in
 * one place and ignoring it in the other would be the inconsistency, not the
 * cleanup.
 */
export function familyCorrection(ctx?: TokenizerContext): number {
  const model = ctx?.model?.trim() || process.env.PI_CONTEXT_MODE_MODEL_ID?.trim();
  if (model && GEMINI_MODEL.test(model)) return GEMINI_CORRECTION;
  return 1;
}

// ─────────────────────────────────────────────────────────
// Mode
// ─────────────────────────────────────────────────────────

/**
 * `CONTEXT_MODE_TOKENIZER` — `bytes4` restores the pre-fork constant,
 * `exact` opts into a real BPE encoder when one is installed, anything
 * else (including unset) is the calibrated heuristic.
 */
export function tokenizerMode(): TokenizerMode {
  const raw = process.env.CONTEXT_MODE_TOKENIZER?.trim().toLowerCase();
  if (raw === "bytes4") return "bytes4";
  if (raw === "exact") return "exact";
  return "heuristic";
}

// ─────────────────────────────────────────────────────────
// Optional exact encoder
// ─────────────────────────────────────────────────────────

type ExactEncoder = (text: string) => number;

const _exact: Partial<Record<TokenizerEncoding, ExactEncoder | null>> = {};
let _exactAttempted = false;

/**
 * Try to pick up a real BPE encoder that already exists in `node_modules`.
 * Deliberately NOT a declared dependency: the bundles this repo ships are
 * single-file esbuild output and a 2-4 MB rank table (or a native addon)
 * has no business in them. The specifiers are assembled at runtime so the
 * bundler cannot try to resolve — and thus inline — them.
 *
 * Returns true when at least one encoder became available.
 */
export async function preloadExactTokenizer(): Promise<boolean> {
  if (_exactAttempted) return _exact.o200k_base != null || _exact.cl100k_base != null;
  _exactAttempted = true;

  // js-tiktoken — pure JS, exposes getEncoding(name).encode(text).
  try {
    const spec = ["js", "tiktoken"].join("-");
    const mod = await import(/* @vite-ignore */ spec) as {
      getEncoding?: (n: string) => { encode: (t: string) => unknown[] };
    };
    if (typeof mod.getEncoding === "function") {
      for (const enc of ["o200k_base", "cl100k_base"] as TokenizerEncoding[]) {
        try {
          const e = mod.getEncoding(enc);
          _exact[enc] = (text: string) => e.encode(text).length;
        } catch { /* this vocabulary is not in the build — next */ }
      }
    }
  } catch { /* not installed */ }

  // gpt-tokenizer — per-encoding subpath exports, o200k only in v2+.
  if (!_exact.o200k_base) {
    try {
      const spec = ["gpt", "tokenizer"].join("-");
      const mod = await import(/* @vite-ignore */ spec) as {
        encode?: (t: string) => unknown[];
      };
      if (typeof mod.encode === "function") {
        const encode = mod.encode;
        _exact.o200k_base = (text: string) => encode(text).length;
      }
    } catch { /* not installed */ }
  }

  return _exact.o200k_base != null || _exact.cl100k_base != null;
}

// ─────────────────────────────────────────────────────────
// Cache
// ─────────────────────────────────────────────────────────

const CACHE_LIMIT = 512;
const cache = new Map<string, number>();
let _hits = 0;
let _misses = 0;

/**
 * Cheap content key: length plus an FNV-1a hash over up to four 32-char
 * windows. Hashing the whole string would cost as much as counting it, and
 * the value being keyed is an estimate — a collision costs an approximate
 * number, not correctness.
 */
function cacheKey(text: string, encoding: TokenizerEncoding, variant: string): string {
  const n = text.length;
  let h = 0x811c9dc5;
  const stride = n <= 128 ? 1 : Math.floor(n / 4);
  for (let base = 0; base < n; base += stride) {
    const end = Math.min(base + 32, n);
    for (let i = base; i < end; i++) {
      h ^= text.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    if (stride === 1) break;
  }
  return `${variant}:${encoding}:${n}:${h >>> 0}`;
}

function cacheGet(key: string): number | undefined {
  const v = cache.get(key);
  if (v === undefined) { _misses++; return undefined; }
  _hits++;
  return v;
}

function cacheSet(key: string, value: number): void {
  if (cache.size >= CACHE_LIMIT) {
    // FIFO eviction — insertion order is what Map iteration gives us.
    const oldest = cache.keys().next();
    if (!oldest.done) cache.delete(oldest.value);
  }
  cache.set(key, value);
}

/** Observability for the tests and for `ctx doctor`. */
export function tokenizerCacheStats(): { hits: number; misses: number; size: number } {
  return { hits: _hits, misses: _misses, size: cache.size };
}

/** Drop the cache and every memo. Tests flip env vars between cases. */
export function __resetTokenizerForTests(): void {
  cache.clear();
  _hits = 0;
  _misses = 0;
  _exactAttempted = false;
  delete _exact.o200k_base;
  delete _exact.cl100k_base;
}

// ─────────────────────────────────────────────────────────
// Counting
// ─────────────────────────────────────────────────────────

function score(features: TokenFeatures, encoding: TokenizerEncoding): number {
  const w = WEIGHTS[encoding][classifyContent(features)];
  let t = 0;
  t += (w.latinRuns ?? 0) * features.latinRuns;
  t += (w.latinChars ?? 0) * features.latinChars;
  t += (w.latinExtChars ?? 0) * features.latinExtChars;
  t += (w.caseBreaks ?? 0) * features.caseBreaks;
  t += (w.longWordExcess ?? 0) * features.longWordExcess;
  t += (w.hugeRunExcess ?? 0) * features.hugeRunExcess;
  t += (w.digitTokens ?? 0) * features.digitTokens;
  t += (w.cyrRuns ?? 0) * features.cyrRuns;
  t += (w.cyrChars ?? 0) * features.cyrChars;
  t += (w.hanChars ?? 0) * features.hanChars;
  t += (w.kanaChars ?? 0) * features.kanaChars;
  t += (w.hangulChars ?? 0) * features.hangulChars;
  t += (w.scriptChars ?? 0) * features.scriptChars;
  t += (w.punctRuns ?? 0) * features.punctRuns;
  t += (w.punctChars ?? 0) * features.punctChars;
  t += (w.newlines ?? 0) * features.newlines;
  t += (w.spaceRuns ?? 0) * features.spaceRuns;
  t += (w.spaceExcess ?? 0) * features.spaceExcess;
  t += (w.symbolRuns ?? 0) * features.symbolRuns;
  t += (w.symbolBytes ?? 0) * features.symbolBytes;
  return t;
}

/**
 * Tokens in `text`, as the host's model would count them.
 *
 * Never returns 0 for a non-empty string, and never returns a fraction —
 * every caller is reporting a token count to a human.
 */
export function countTokens(text: string, ctx?: TokenizerContext): number {
  if (!text) return 0;

  const mode = tokenizerMode();
  const encoding = resolveEncoding(ctx);

  if (mode === "bytes4") {
    return Math.max(1, Math.round(utf8Length(text) / LEGACY_BYTES_PER_TOKEN));
  }

  // The variant carries everything outside the text that moves the answer,
  // so flipping mode or host between calls cannot serve a stale count.
  const correction = familyCorrection(ctx);
  const key = cacheKey(text, encoding, `${mode}:${correction}`);
  const cached = cacheGet(key);
  if (cached !== undefined) return cached;

  let tokens: number;
  const exact = mode === "exact" ? _exact[encoding] : undefined;
  if (exact) {
    try {
      tokens = exact(text);
    } catch {
      tokens = score(extractFeatures(text), encoding);
    }
  } else {
    tokens = score(extractFeatures(text), encoding);
  }

  const result = Math.max(1, Math.round(tokens * correction));
  cacheSet(key, result);
  return result;
}

/** UTF-8 byte length without allocating a Buffer. */
export function utf8Length(text: string): number {
  let bytes = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c < 0x80) bytes += 1;
    else if (c < 0x800) bytes += 2;
    else if (c >= 0xd800 && c < 0xdc00) bytes += 4;
    else if (c >= 0xdc00 && c < 0xe000) bytes += 0;
    else bytes += 3;
  }
  return bytes;
}

// ─────────────────────────────────────────────────────────
// Byte-only call sites
// ─────────────────────────────────────────────────────────

/**
 * Bytes per token for this host. `CONTEXT_MODE_TOKENIZER_BYTES_PER_TOKEN`
 * overrides it for operators who have measured their own workload.
 */
export function bytesPerToken(ctx?: TokenizerContext): number {
  if (tokenizerMode() === "bytes4") return LEGACY_BYTES_PER_TOKEN;

  const raw = process.env.CONTEXT_MODE_TOKENIZER_BYTES_PER_TOKEN;
  if (raw) {
    const parsed = Number.parseFloat(raw);
    if (Number.isFinite(parsed) && parsed > 0.5 && parsed < 32) return parsed;
  }

  return BYTES_PER_TOKEN[resolveEncoding(ctx)] / familyCorrection(ctx);
}

/**
 * Tokens implied by an aggregate byte count — the SQLite `SUM(LENGTH(…))`
 * shape, where the text itself is long gone. Returns a real number; the
 * call sites round the way they always did.
 */
export function tokensFromBytes(bytes: number, ctx?: TokenizerContext): number {
  if (!Number.isFinite(bytes) || bytes <= 0) return 0;
  return bytes / bytesPerToken(ctx);
}

/**
 * Exact inverse of `tokensFromBytes`. Used where the report converts a
 * token total back into "how much work was that" bytes, so both directions
 * stay on one basis and no ratio in ctx_stats mixes two definitions.
 */
export function bytesFromTokens(tokens: number, ctx?: TokenizerContext): number {
  if (!Number.isFinite(tokens) || tokens <= 0) return 0;
  return tokens * bytesPerToken(ctx);
}

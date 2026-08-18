/**
 * session/tokenizer — the honest replacement for `bytes / 4`.
 *
 * What is pinned here:
 *  1. Accuracy against real BPE counts. The `TRUTH` table below was produced
 *     by a reference implementation of OpenAI's published `o200k_base` /
 *     `cl100k_base` rank tables (validated on known fixtures: "hello world"
 *     = 2, "tiktoken is great!" = 6 under cl100k_base). These are ground
 *     truth, not the heuristic's own output — the tests fail if the
 *     heuristic drifts away from what the model actually charges.
 *  2. That the heuristic beats `bytes / 4` on the payload shapes
 *     context-mode redirects — structured data, tool output, Cyrillic prose
 *     — which is the whole reason the constant was replaced.
 *  3. The `CONTEXT_MODE_TOKENIZER=bytes4` escape hatch reproduces the old
 *     numbers exactly.
 *  4. The cache returns the same answer and does not leak across modes.
 *  5. `tokensFromBytes` / `bytesFromTokens` are exact inverses, so every
 *     ratio in ctx_stats has both sides on one basis.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";

import {
  countTokens,
  tokensFromBytes,
  bytesFromTokens,
  bytesPerToken,
  resolveEncoding,
  familyCorrection,
  tokenizerMode,
  classifyContent,
  extractFeatures,
  profileOf,
  utf8Length,
  tokenizerCacheStats,
  __resetTokenizerForTests,
  LEGACY_BYTES_PER_TOKEN,
  type TokenizerEncoding,
} from "../../src/session/tokenizer.js";

// ─────────────────────────────────────────────────────────
// Fixtures — token counts from a reference BPE encoder
// ─────────────────────────────────────────────────────────

const SAMPLES = {
  typescript: `export function resolveEncoding(ctx?: TokenizerContext): TokenizerEncoding {
  if (ctx?.encoding) return ctx.encoding;
  const env = process.env.CONTEXT_MODE_TOKENIZER_ENCODING?.trim();
  if (env === "o200k_base" || env === "cl100k_base") return env;
  const model = ctx?.model?.trim();
  if (model && CL100K_MODEL.test(model)) return "cl100k_base";
  return "o200k_base";
}

class SessionStore {
  private readonly entries = new Map<string, SessionEntry>();
  constructor(private readonly db: DatabaseAdapter) {}
  insert(sessionId: string, payload: Buffer): void {
    this.db.prepare("INSERT INTO session_events (session_id, data) VALUES (?, ?)").run(sessionId, payload);
  }
}`,

  json: JSON.stringify({
    name: "context-mode", version: "2.14.3",
    dependencies: { "@clack/prompts": "^1.0.1", "better-sqlite3": "^12.6.2", zod: "^3.25.0", turndown: "^7.2.0" },
    scripts: { build: "node scripts/build.mjs", test: "vitest run", lint: "eslint src" },
    stats: [{ tool: "ctx_execute", calls: 412, bytes: 918273 }, { tool: "ctx_search", calls: 88, bytes: 40219 }],
  }, null, 2),

  englishProse: "The savings number context-mode reports has always rested on a single constant: four bytes to a token. That rule of thumb comes from English prose measured against an older vocabulary, and it travels badly. On the JSON and log output the plugin actually keeps out of the context window it understates the real cost by a fifth or more, and on Russian documentation it overstates it by half again.",

  russianProse: "Оценка экономии, которую показывает context-mode, всегда держалась на одной константе: четыре байта на токен. Это правило взято из английской прозы, измеренной по старому словарю, и оно плохо переносится на другие данные. На выводе команд и структурированных ответах оно занижает реальную стоимость, а на русской документации — заметно завышает.",

  toolOutput: `-rw-rw-r--  1 osddqd osddqd  35575 Aug 17 23:31 format-report.test.ts
-rw-rw-r--  1 osddqd osddqd   2855 Aug 17 23:31 lifetime-stats-config-dir.test.ts
-rw-rw-r--  1 osddqd osddqd  14906 Aug 17 23:31 purge.ts
drwxrwxr-x 19 osddqd osddqd   4096 Aug 17 23:31 adapters
2026-08-18T04:12:12.345Z INFO [worker-3] req=8f14e45f-ceea-467a-9f2a-000000000042 status=200 dur=126ms`,

  mixed: "const greeting = \"Привет, мир\"; // 日本語のコメント 🚀\nassert(greeting.length === 11);",
} as const;

type SampleName = keyof typeof SAMPLES;

/** Ground truth from the reference BPE encoder — NOT the heuristic's output. */
const TRUTH: Record<SampleName, Record<TokenizerEncoding, number>> = {
  typescript:   { o200k_base: 168, cl100k_base: 168 },
  json:         { o200k_base: 178, cl100k_base: 178 },
  englishProse: { o200k_base:  78, cl100k_base:  78 },
  russianProse: { o200k_base:  86, cl100k_base: 146 },
  toolOutput:   { o200k_base: 172, cl100k_base: 171 },
  mixed:        { o200k_base:  25, cl100k_base:  30 },
};

/** Fixed host so the suite does not depend on which agent runs it. */
const HOST = { platform: "claude-code" } as const;

function relErr(estimate: number, truth: number): number {
  return Math.abs(estimate / truth - 1);
}

// ─────────────────────────────────────────────────────────

const ENV_KEYS = [
  "CONTEXT_MODE_TOKENIZER",
  "CONTEXT_MODE_TOKENIZER_ENCODING",
  "CONTEXT_MODE_TOKENIZER_BYTES_PER_TOKEN",
] as const;

let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = {};
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  __resetTokenizerForTests();
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  __resetTokenizerForTests();
});

// ─────────────────────────────────────────────────────────
// Accuracy
// ─────────────────────────────────────────────────────────

describe("countTokens accuracy against reference BPE counts", () => {
  for (const encoding of ["o200k_base", "cl100k_base"] as const) {
    for (const name of Object.keys(SAMPLES) as SampleName[]) {
      it(`${encoding} · ${name} lands within 15% of the real count`, () => {
        const got = countTokens(SAMPLES[name], { ...HOST, encoding });
        expect(relErr(got, TRUTH[name][encoding])).toBeLessThan(0.15);
      });
    }
  }

  it("never reports 0 tokens for a non-empty payload", () => {
    for (const s of ["a", ".", " ", "\n", "я", "漢", "🚀"]) {
      expect(countTokens(s, HOST)).toBeGreaterThanOrEqual(1);
    }
  });

  it("returns 0 for the empty string", () => {
    expect(countTokens("", HOST)).toBe(0);
  });

  it("returns whole tokens, never fractions", () => {
    for (const s of Object.values(SAMPLES)) {
      expect(Number.isInteger(countTokens(s, HOST))).toBe(true);
    }
  });
});

describe("the heuristic beats bytes/4 where bytes/4 is worst", () => {
  // These are the shapes context-mode actually keeps out of the window:
  // structured data, command output, and non-Latin prose.
  const CASES: Array<[SampleName, TokenizerEncoding]> = [
    ["json", "o200k_base"],
    ["json", "cl100k_base"],
    ["toolOutput", "o200k_base"],
    ["toolOutput", "cl100k_base"],
    ["englishProse", "o200k_base"],
    ["russianProse", "o200k_base"],
  ];

  for (const [name, encoding] of CASES) {
    it(`${encoding} · ${name}: strictly closer than bytes/4`, () => {
      const truth = TRUTH[name][encoding];
      const heuristic = relErr(countTokens(SAMPLES[name], { ...HOST, encoding }), truth);
      const legacy = relErr(utf8Length(SAMPLES[name]) / LEGACY_BYTES_PER_TOKEN, truth);
      expect(heuristic).toBeLessThan(legacy);
    });
  }

  it("cuts the aggregate error across every sample by more than half", () => {
    for (const encoding of ["o200k_base", "cl100k_base"] as const) {
      let heuristic = 0;
      let legacy = 0;
      for (const name of Object.keys(SAMPLES) as SampleName[]) {
        const truth = TRUTH[name][encoding];
        heuristic += relErr(countTokens(SAMPLES[name], { ...HOST, encoding }), truth);
        legacy += relErr(utf8Length(SAMPLES[name]) / LEGACY_BYTES_PER_TOKEN, truth);
      }
      expect(heuristic).toBeLessThan(legacy / 2);
    }
  });

  it("bytes/4 overstates Cyrillic prose under o200k_base by more than half — the heuristic does not", () => {
    const truth = TRUTH.russianProse.o200k_base;
    const legacy = utf8Length(SAMPLES.russianProse) / LEGACY_BYTES_PER_TOKEN;
    expect(legacy / truth).toBeGreaterThan(1.5);
    expect(relErr(countTokens(SAMPLES.russianProse, { ...HOST, encoding: "o200k_base" }), truth)).toBeLessThan(0.15);
  });

  it("bytes/4 understates directory listings by a third or more — the heuristic does not", () => {
    const truth = TRUTH.toolOutput.o200k_base;
    const legacy = utf8Length(SAMPLES.toolOutput) / LEGACY_BYTES_PER_TOKEN;
    expect(legacy / truth).toBeLessThan(0.67);
    expect(relErr(countTokens(SAMPLES.toolOutput, { ...HOST, encoding: "o200k_base" }), truth)).toBeLessThan(0.15);
  });
});

// ─────────────────────────────────────────────────────────
// Content profiles
// ─────────────────────────────────────────────────────────

describe("classifyContent", () => {
  it("routes each fixture to the profile it was calibrated as", () => {
    expect(profileOf(SAMPLES.typescript)).toBe("code");
    expect(profileOf(SAMPLES.json)).toBe("structured");
    expect(profileOf(SAMPLES.toolOutput)).toBe("structured");
    expect(profileOf(SAMPLES.englishProse)).toBe("prose");
    expect(profileOf(SAMPLES.russianProse)).toBe("prose");
  });

  it("prices a base64 blob as structured, not as prose", () => {
    const blob = Buffer.from(SAMPLES.englishProse.repeat(4)).toString("base64");
    expect(profileOf(blob)).toBe("structured");
  });

  it("is a pure function of the features — no second pass over the text", () => {
    const features = extractFeatures(SAMPLES.json);
    expect(classifyContent(features)).toBe(profileOf(SAMPLES.json));
  });
});

describe("extractFeatures", () => {
  it("counts UTF-8 bytes the way Buffer.byteLength does", () => {
    for (const s of [...Object.values(SAMPLES), "🚀🚀", "ß", "漢字", ""]) {
      expect(extractFeatures(s).bytes).toBe(Buffer.byteLength(s, "utf8"));
      expect(utf8Length(s)).toBe(Buffer.byteLength(s, "utf8"));
    }
  });

  it("splits digit runs the way both vocabularies do — three digits per token", () => {
    expect(extractFeatures("1").digitTokens).toBe(1);
    expect(extractFeatures("123").digitTokens).toBe(1);
    expect(extractFeatures("1234").digitTokens).toBe(2);
    expect(extractFeatures("123456789").digitTokens).toBe(3);
    expect(extractFeatures("12 34").digitTokens).toBe(2);
  });

  it("counts camelCase boundaries, which is where identifiers split", () => {
    expect(extractFeatures("resolveEncodingForHost").caseBreaks).toBe(3);
    expect(extractFeatures("lowercase").caseBreaks).toBe(0);
    expect(extractFeatures("SCREAMING_CASE").caseBreaks).toBe(0);
  });

  it("separates scripts that cost different numbers of tokens per character", () => {
    const f = extractFeatures("abcПривет漢字ひらがな한글");
    expect(f.latinChars).toBe(3);
    expect(f.cyrChars).toBe(6);
    expect(f.hanChars).toBe(2);
    expect(f.kanaChars).toBe(4);
    expect(f.hangulChars).toBe(2);
  });
});

// ─────────────────────────────────────────────────────────
// bytes4 escape hatch
// ─────────────────────────────────────────────────────────

describe("CONTEXT_MODE_TOKENIZER=bytes4", () => {
  it("reproduces the pre-fork constant exactly", () => {
    process.env.CONTEXT_MODE_TOKENIZER = "bytes4";
    expect(tokenizerMode()).toBe("bytes4");
    expect(bytesPerToken()).toBe(4);
    expect(tokensFromBytes(4000)).toBe(1000);
    expect(bytesFromTokens(1000)).toBe(4000);
  });

  it("makes countTokens agree with round(bytes / 4)", () => {
    process.env.CONTEXT_MODE_TOKENIZER = "bytes4";
    for (const s of Object.values(SAMPLES)) {
      expect(countTokens(s, HOST)).toBe(Math.round(utf8Length(s) / 4));
    }
  });

  it("ignores the bytes-per-token override — bytes4 means bytes4", () => {
    process.env.CONTEXT_MODE_TOKENIZER = "bytes4";
    process.env.CONTEXT_MODE_TOKENIZER_BYTES_PER_TOKEN = "2.5";
    expect(bytesPerToken()).toBe(4);
  });

  it("is off by default — the calibrated path is what ships", () => {
    expect(tokenizerMode()).toBe("heuristic");
    expect(bytesPerToken(HOST)).toBeLessThan(4);
    expect(bytesPerToken(HOST)).toBeGreaterThan(3);
  });

  it("accepts `exact` without requiring the optional encoder to exist", () => {
    process.env.CONTEXT_MODE_TOKENIZER = "exact";
    expect(tokenizerMode()).toBe("exact");
    // No js-tiktoken / gpt-tokenizer in node_modules → falls back silently.
    expect(countTokens(SAMPLES.typescript, HOST)).toBeGreaterThan(0);
  });
});

// ─────────────────────────────────────────────────────────
// Encoding + family resolution
// ─────────────────────────────────────────────────────────

describe("resolveEncoding", () => {
  it("defaults to o200k_base — every host in client-map ships a modern model", () => {
    expect(resolveEncoding(HOST)).toBe("o200k_base");
  });

  it("honours an explicit override above everything else", () => {
    process.env.CONTEXT_MODE_TOKENIZER_ENCODING = "o200k_base";
    expect(resolveEncoding({ ...HOST, encoding: "cl100k_base" })).toBe("cl100k_base");
  });

  it("honours CONTEXT_MODE_TOKENIZER_ENCODING", () => {
    process.env.CONTEXT_MODE_TOKENIZER_ENCODING = "cl100k_base";
    expect(resolveEncoding(HOST)).toBe("cl100k_base");
  });

  it("ignores a junk encoding env value rather than throwing", () => {
    process.env.CONTEXT_MODE_TOKENIZER_ENCODING = "not-a-vocabulary";
    expect(resolveEncoding(HOST)).toBe("o200k_base");
  });

  it("routes pre-o200k model ids to cl100k_base", () => {
    for (const model of ["gpt-4", "gpt-4-32k", "gpt-3.5-turbo", "claude-2.1", "text-davinci-003"]) {
      expect(resolveEncoding({ ...HOST, model })).toBe("cl100k_base");
    }
  });

  it("keeps modern model ids on o200k_base", () => {
    for (const model of ["gpt-4o", "gpt-5", "o3-mini", "claude-opus-5", "claude-sonnet-4-5", "gemini-2.5-pro"]) {
      expect(resolveEncoding({ ...HOST, model })).toBe("o200k_base");
    }
  });

  it("resolves clientInfo.name through the adapter client map", () => {
    // Same map detect.ts uses — a Gemini client name must land on the Gemini
    // correction without the caller having to know the platform id.
    expect(familyCorrection({ client: "gemini-cli-mcp-client" })).toBeCloseTo(1.1, 5);
    expect(familyCorrection({ client: "claude-code" })).toBe(1);
  });
});

describe("familyCorrection", () => {
  it("applies 1.1× for the Gemini family, which is not a tiktoken BPE", () => {
    expect(familyCorrection({ platform: "gemini-cli" })).toBeCloseTo(1.1, 5);
    expect(familyCorrection({ platform: "antigravity" })).toBeCloseTo(1.1, 5);
    expect(familyCorrection({ model: "gemini-2.5-flash" })).toBeCloseTo(1.1, 5);
    expect(familyCorrection({ model: "gemma-3-27b" })).toBeCloseTo(1.1, 5);
  });

  it("leaves every other host at 1×", () => {
    expect(familyCorrection(HOST)).toBe(1);
    expect(familyCorrection({ platform: "codex" })).toBe(1);
  });

  it("raises the token count and lowers bytes-per-token for Gemini hosts", () => {
    const gemini = { platform: "gemini-cli" } as const;
    expect(countTokens(SAMPLES.englishProse, gemini))
      .toBeGreaterThan(countTokens(SAMPLES.englishProse, HOST));
    expect(bytesPerToken(gemini)).toBeLessThan(bytesPerToken(HOST));
  });
});

// ─────────────────────────────────────────────────────────
// Byte-only call sites
// ─────────────────────────────────────────────────────────

describe("tokensFromBytes / bytesFromTokens", () => {
  it("are exact inverses, so both sides of a ctx_stats ratio share one basis", () => {
    for (const bytes of [1, 1024, 918_273, 5_000_000]) {
      expect(bytesFromTokens(tokensFromBytes(bytes))).toBeCloseTo(bytes, 6);
    }
  });

  it("charges more tokens per byte than bytes/4 did — redirected payloads are dense", () => {
    expect(tokensFromBytes(1_000_000)).toBeGreaterThan(250_000);
    expect(tokensFromBytes(1_000_000)).toBeLessThan(330_000);
  });

  it("treats zero, negative, and non-finite input as zero", () => {
    expect(tokensFromBytes(0)).toBe(0);
    expect(tokensFromBytes(-5)).toBe(0);
    expect(tokensFromBytes(Number.NaN)).toBe(0);
    expect(bytesFromTokens(0)).toBe(0);
    expect(bytesFromTokens(-5)).toBe(0);
    expect(bytesFromTokens(Number.POSITIVE_INFINITY)).toBe(0);
  });

  it("is monotonic — more bytes never means fewer tokens", () => {
    let prev = -1;
    for (let b = 0; b < 100_000; b += 4321) {
      const t = tokensFromBytes(b);
      expect(t).toBeGreaterThanOrEqual(prev);
      prev = t;
    }
  });

  it("honours CONTEXT_MODE_TOKENIZER_BYTES_PER_TOKEN for operators who measured their own mix", () => {
    process.env.CONTEXT_MODE_TOKENIZER_BYTES_PER_TOKEN = "2.5";
    expect(bytesPerToken()).toBe(2.5);
    expect(tokensFromBytes(1000)).toBe(400);
  });

  it("rejects a nonsensical override instead of producing absurd savings", () => {
    for (const junk of ["0", "-3", "0.1", "1e9", "not-a-number", ""]) {
      process.env.CONTEXT_MODE_TOKENIZER_BYTES_PER_TOKEN = junk;
      expect(bytesPerToken(HOST)).toBeGreaterThan(3);
      expect(bytesPerToken(HOST)).toBeLessThan(4);
    }
  });

  it("keeps percentages stable: scaling both sides by one constant cannot move a ratio", () => {
    // The savings bar in ctx_stats is tokens(with) / tokens(without). Both
    // come from tokensFromBytes, so swapping the constant must not move it.
    const withBytes = 120_000;
    const withoutBytes = 4_800_000;
    const ratioNow = tokensFromBytes(withBytes) / tokensFromBytes(withoutBytes);
    process.env.CONTEXT_MODE_TOKENIZER = "bytes4";
    const ratioLegacy = tokensFromBytes(withBytes) / tokensFromBytes(withoutBytes);
    expect(ratioNow).toBeCloseTo(ratioLegacy, 10);
    expect(ratioNow).toBeCloseTo(withBytes / withoutBytes, 10);
  });
});

// ─────────────────────────────────────────────────────────
// Cache
// ─────────────────────────────────────────────────────────

describe("cache", () => {
  it("serves a repeat count from the cache instead of recounting", () => {
    __resetTokenizerForTests();
    const first = countTokens(SAMPLES.typescript, HOST);
    const afterMiss = tokenizerCacheStats();
    expect(afterMiss.misses).toBe(1);
    expect(afterMiss.hits).toBe(0);

    const second = countTokens(SAMPLES.typescript, HOST);
    const afterHit = tokenizerCacheStats();
    expect(second).toBe(first);
    expect(afterHit.hits).toBe(1);
    expect(afterHit.misses).toBe(1);
  });

  it("keys on content, not identity — an equal string built at runtime hits", () => {
    __resetTokenizerForTests();
    const a = SAMPLES.englishProse;
    const b = SAMPLES.englishProse.split("").join("");  // equal value, fresh string
    expect(b).toEqual(a);
    countTokens(a, HOST);
    countTokens(b, HOST);
    expect(tokenizerCacheStats()).toMatchObject({ hits: 1, misses: 1 });
  });

  it("does not serve a heuristic answer after the mode changes", () => {
    __resetTokenizerForTests();
    const heuristic = countTokens(SAMPLES.json, HOST);
    process.env.CONTEXT_MODE_TOKENIZER = "bytes4";
    const legacy = countTokens(SAMPLES.json, HOST);
    expect(legacy).toBe(Math.round(utf8Length(SAMPLES.json) / 4));
    expect(legacy).not.toBe(heuristic);
  });

  it("does not serve a Claude answer to a Gemini host", () => {
    __resetTokenizerForTests();
    const claude = countTokens(SAMPLES.englishProse, HOST);
    const gemini = countTokens(SAMPLES.englishProse, { platform: "gemini-cli" });
    expect(gemini).toBeGreaterThan(claude);
  });

  it("stays bounded — a flood of distinct payloads does not grow without limit", () => {
    __resetTokenizerForTests();
    for (let i = 0; i < 2000; i++) countTokens(`payload number ${i} — unique content ${i * 7919}`, HOST);
    expect(tokenizerCacheStats().size).toBeLessThanOrEqual(512);
  });

  it("__resetTokenizerForTests clears counters and entries", () => {
    countTokens(SAMPLES.json, HOST);
    __resetTokenizerForTests();
    expect(tokenizerCacheStats()).toEqual({ hits: 0, misses: 0, size: 0 });
  });
});

// ─────────────────────────────────────────────────────────
// Robustness
// ─────────────────────────────────────────────────────────

describe("robustness", () => {
  it("survives the payload shapes a tool wrapper can produce", () => {
    const shapes = [
      "",
      " ",
      "\n\n\n",
      "\t\t\t\t\t\t\t\t",
      " ",
      "🚀".repeat(500),
      "a".repeat(10_000),
      "\uD83D",                     // lone high surrogate
      "\uDE00",                     // lone low surrogate
      JSON.stringify({ nested: { deeply: { array: Array.from({ length: 200 }, (_, i) => i) } } }),
    ];
    for (const s of shapes) {
      const t = countTokens(s, HOST);
      expect(Number.isFinite(t)).toBe(true);
      expect(t).toBeGreaterThanOrEqual(0);
    }
  });

  it("scales roughly linearly — no quadratic blow-up on a large payload", () => {
    const unit = SAMPLES.typescript;
    const small = countTokens(unit, HOST);
    const large = countTokens(unit.repeat(50), HOST);
    expect(large / small).toBeGreaterThan(45);
    expect(large / small).toBeLessThan(55);
  });

  it("counts a megabyte of source in well under a second", () => {
    const blob = SAMPLES.typescript.repeat(1600); // ~1.1 MB
    __resetTokenizerForTests();
    const started = Date.now();
    countTokens(blob, HOST);
    expect(Date.now() - started).toBeLessThan(1000);
  });
});

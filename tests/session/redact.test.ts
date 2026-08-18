/**
 * Secret screening — src/session/redact.ts
 *
 * The bias of this suite is deliberate: a missed secret is a bad outcome, but a
 * false positive is a worse one, because it silently corrupts indexed source
 * code and nobody finds out until a search returns `[redacted:…]` where a
 * function used to be. So the negative cases outnumber the positives, and two
 * of them are not hand-written samples at all — they screen this repository's
 * own sources and the real captured fixtures and demand zero hits.
 */

import { describe, test, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

import {
  redactOptionsFromEnv,
  redactSecrets,
  redactionMarker,
  shannonEntropy,
} from "../../src/session/redact.js";

const ROOT = resolve(import.meta.dirname, "../..");

/** Convenience: what fired, as a plain object. */
const hits = (s: string, opts?: Parameters<typeof redactSecrets>[1]) => redactSecrets(s, opts).redactions;

describe("token patterns", () => {
  test("an OpenAI key is redacted in an env line and in a call", () => {
    expect(redactSecrets("OPENAI_API_KEY=sk-proj-abc123DEF456ghi789JKL012mno345PQR678stu").text)
      .toBe("OPENAI_API_KEY=[redacted:openai-key]");
    expect(redactSecrets(`new OpenAI({ apiKey: "sk-abcdefghij0123456789klmnopqrstuvwx" })`).text)
      .toBe(`new OpenAI({ apiKey: "[redacted:openai-key]" })`);
  });

  test("GitHub, AWS and Slack tokens each report their own type", () => {
    expect(hits("GITHUB_TOKEN=ghp_16C7e42F292c6912E7710c838347Ae178B4a")).toEqual({ "github-token": 1 });
    expect(hits("aws_access_key_id = AKIAIOSFODNN7EXAMPLE")).toEqual({ "aws-access-key": 1 });
    expect(hits("SLACK_BOT_TOKEN=xoxb-2334455667-1234567890-AbCdEfGhIjKlMnOpQrSt")).toEqual({ "slack-token": 1 });
  });

  test("every GitHub token prefix is covered, not just ghp_", () => {
    for (const prefix of ["ghp", "gho", "ghu", "ghs", "ghr"]) {
      expect(hits(`t=${prefix}_16C7e42F292c6912E7710c838347Ae178B4a`), prefix).toEqual({ "github-token": 1 });
    }
  });

  test("several secrets on one line are all replaced and all counted", () => {
    const out = redactSecrets("a=AKIAIOSFODNN7EXAMPLE b=AKIAJKLMNOPQRSTUVWXY");
    expect(out.redactions).toEqual({ "aws-access-key": 2 });
    expect(out.count).toBe(2);
    expect(out.text).toBe("a=[redacted:aws-access-key] b=[redacted:aws-access-key]");
  });
});

describe("PEM private keys", () => {
  const pem = [
    "before",
    "-----BEGIN RSA PRIVATE KEY-----",
    "MIIEowIBAAKCAQEAx7Wn9k2vQhLmNoPqRsTuVwXyZ0123456789abcdefghij==",
    "kLmNoPqRsTuVwXyZ0123456789abcdefghijKLMNOPQRSTUVWXYZabcdefgh",
    "-----END RSA PRIVATE KEY-----",
    "after",
  ].join("\n");

  test("the body is dropped, not just the header", () => {
    const out = redactSecrets(pem);
    expect(out.text).toBe("before\n[redacted:private-key]\nafter");
    expect(out.redactions).toEqual({ "private-key": 1 });
  });

  test("a truncated key still redacts to the end", () => {
    const truncated = "-----BEGIN PRIVATE KEY-----\nMIIEowIBAAKCAQEAx7Wn9k2v";
    expect(redactSecrets(truncated).text).toBe("[redacted:private-key]");
  });

  test("source code that merely mentions the header is left alone", () => {
    // The marker must be the whole line. A constant, a doc line or a parser
    // that names the header is code about PEM, not a key.
    for (const line of [
      `const PEM_HEADER = "-----BEGIN RSA PRIVATE KEY-----";`,
      "Files starting with -----BEGIN OPENSSH PRIVATE KEY----- are skipped.",
      "| header | -----BEGIN PRIVATE KEY----- |",
    ]) {
      expect(redactSecrets(line).count, line).toBe(0);
    }
  });
});

describe("assignments to sensitive keys", () => {
  test("a long quoted value under a sensitive key is redacted", () => {
    expect(redactSecrets(`  "apiKey": "0123456789abcdefghij",`).text)
      .toBe(`  "apiKey": "[redacted:assigned-secret]",`);
    expect(hits("DB_PASSWORD=s3cr3tP4ssw0rdV4lue99")).toEqual({ "assigned-secret": 1 });
  });

  test("a value at or below 16 characters is a placeholder, not a credential", () => {
    expect(redactSecrets(`password = "hunter2"`).count).toBe(0);
    expect(redactSecrets(`apiKey: "test-key-1234"`).count).toBe(0);
    // 16 is still short; 17 is the first length that counts.
    expect(redactSecrets(`token: "abcdefgh12345678"`).count).toBe(0);
    expect(redactSecrets(`token: "abcdefgh123456789"`).count).toBe(1);
  });

  test("a key with no sensitive word in it is never touched", () => {
    expect(redactSecrets(`"integrity": "sha512-Sxwg0aDzXFyfhP5r0gJgHhqJ2vKzD9v3RxHhqZ=="`).count).toBe(0);
    expect(redactSecrets("commitHash = a1b2c3d4e5f67890abcdef1234567890abcdef12").count).toBe(0);
  });

  test("an unquoted value that reads as an identifier is code, not a secret", () => {
    // Both lines are real, from this repository.
    expect(redactSecrets("const input_tokens = toNum(u.input_tokens);").count).toBe(0);
    expect(redactSecrets("      cache_creation_tokens: cacheCreationTokens,").count).toBe(0);
    expect(redactSecrets("  apiKey: env.CONTEXT_MODE_EMBEDDINGS_API_KEY?.trim() || undefined,").count).toBe(0);
  });

  test("an unquoted secret is caught where the line is the assignment", () => {
    expect(hits("API_TOKEN=s3cr3tV4lu3abcdefgh")).toEqual({ "assigned-secret": 1 });
    expect(hits("export API_TOKEN=s3cr3tV4lu3abcdefgh")).toEqual({ "assigned-secret": 1 });
    expect(hits("  api_token: s3cr3tV4lu3abcdefgh")).toEqual({ "assigned-secret": 1 });
  });

  test("a JWT passes as one value but member access does not", () => {
    expect(hits("api_key: eyJhbGciOiJIUzI1NiI9.eyJzdWIiOiIxMjM0NTY3ODkw.dozjgNryP4J3jVmNHl0w5N"))
      .toEqual({ "assigned-secret": 1 });
    expect(redactSecrets("  token: config.oauth2TokenValue,").count).toBe(0);
  });

  test("a path or URL under a sensitive key stays readable", () => {
    for (const line of [
      "private_key_path: /etc/ssl/private/server-key.pem",
      "private_key_path: ./secrets/id_rsa.pem",
      "token_endpoint: https://accounts.example.com/oauth2/token",
      "credentials_file: C:\\Users\\me\\.aws\\credentials",
    ]) {
      expect(redactSecrets(line).count, line).toBe(0);
    }
  });
});

describe("false positives on real-world content", () => {
  const samples: Array<[string, string]> = [
    ["sk- inside an ordinary word", "const taskManager = new TaskManager(); // task-manager, risk-assessment, disk-usage"],
    ["base64 inline asset", "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="],
    ["minified bundle", `!function(e,t){"object"==typeof exports&&"undefined"!=typeof module?t(exports):t(e.lib={})}(this,function(e){var t=e.token,n=e.a;e.b=t});`],
    ["UUID", "id: 550e8400-e29b-41d4-a716-446655440000"],
    ["git sha1", "commit a1b2c3d4e5f67890abcdef1234567890abcdef12"],
    ["sha256 digest", "sha256:9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08"],
    ["package-lock integrity", `"integrity": "sha512-Sxwg0aDzXFyfhP5r0gJgHhqJ2vKzD9v3RxHhqZzWnQwJVXhCFQ==",`],
    ["long path", "/home/user/projects/context-mode/node_modules/.pnpm/typescript@5.4.5/node_modules/typescript/lib/tsc.js"],
    ["Bearer in documentation", "Send the header Authorization: Bearer <your token> to authenticate."],
    ["docker image digest", "image: registry.example.com/api@sha256:9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15"],
    ["a Go module hash", "golang.org/x/text v0.14.0 h1:ScX5w1eTa3QqT8oi6+ziP7dTV1S2+ALU0bI+0zXKWiQ="],
  ];

  for (const [name, sample] of samples) {
    test(`${name} is left untouched`, () => {
      const out = redactSecrets(sample);
      expect(out.count, `redacted: ${out.text}`).toBe(0);
      expect(out.text).toBe(sample);
    });
  }

  test("this repository's own sources screen clean", () => {
    // The strongest guard in the file: any rule loose enough to damage real
    // code will fire somewhere in 100+ source files, and the failure message
    // names the file and the rule.
    const offenders: string[] = [];
    for (const file of walk(join(ROOT, "src"))) {
      let text: string;
      try { text = readFileSync(file, "utf-8"); } catch { continue; }
      const out = redactSecrets(text);
      if (out.count > 0) offenders.push(`${file.slice(ROOT.length + 1)} ${JSON.stringify(out.redactions)}`);
    }
    expect(offenders).toEqual([]);
  });

  test("the captured fixtures screen clean", () => {
    // Real tool output — logs, JSON payloads, diffs, transcripts, snapshots —
    // which is the majority of what actually gets indexed.
    const dir = join(ROOT, "tests/fixtures");
    const offenders: string[] = [];
    for (const name of readdirSync(dir)) {
      const file = join(dir, name);
      if (!statSync(file).isFile()) continue;
      let text: string;
      try { text = readFileSync(file, "utf-8"); } catch { continue; }
      const out = redactSecrets(text);
      if (out.count > 0) offenders.push(`${name} ${JSON.stringify(out.redactions)}`);
    }
    expect(offenders).toEqual([]);
  });
});

describe("the entropy layer is opt-in", () => {
  const blob = `blob = "Zm9vYmFyYmF6cXV4MTIzNDU2Nzg5MGFiY2RlZmdo"`;

  test("it does not run by default", () => {
    expect(redactSecrets(blob).count).toBe(0);
  });

  test("it runs when asked, and reports its own type", () => {
    expect(hits(blob, { entropy: true })).toEqual({ "high-entropy": 1 });
  });

  test("even switched on it skips hex digests and UUIDs", () => {
    // The cheapest false positives are excluded by shape. The expensive ones —
    // base64 assets, minified chunks — are not, which is why this layer is off.
    expect(redactSecrets("sha256:9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08", { entropy: true }).count).toBe(0);
    expect(redactSecrets("id: 550e8400-e29b-41d4-a716-446655440000", { entropy: true }).count).toBe(0);
  });

  test("patterns can be switched off independently of entropy", () => {
    expect(redactSecrets("k=AKIAIOSFODNN7EXAMPLE", { patterns: false }).count).toBe(0);
    expect(redactSecrets("k=AKIAIOSFODNN7EXAMPLE", { patterns: false, entropy: true }).redactions)
      .not.toHaveProperty("aws-access-key");
  });

  test("shannonEntropy separates a word from a random run", () => {
    expect(shannonEntropy("aaaaaaaaaaaaaaaa")).toBe(0);
    expect(shannonEntropy("Zm9vYmFyYmF6cXV4MTIzNDU2Nzg5MGFiY2RlZmdo")).toBeGreaterThan(4);
  });
});

describe("contract", () => {
  test("text with nothing to redact comes back byte for byte", () => {
    const text = "nothing to see here\njust some prose\n";
    const out = redactSecrets(text);
    expect(out.text).toBe(text);
    expect(out.redactions).toEqual({});
    expect(out.count).toBe(0);
  });

  test("empty input is handled", () => {
    expect(redactSecrets("")).toEqual({ text: "", redactions: {}, count: 0 });
  });

  test("screening is idempotent — a second pass finds nothing", () => {
    const once = redactSecrets("OPENAI_API_KEY=sk-proj-abc123DEF456ghi789JKL012mno345PQR678stu\napiKey: \"0123456789abcdefghij\"");
    expect(once.count).toBe(2);
    const twice = redactSecrets(once.text);
    expect(twice.count).toBe(0);
    expect(twice.text).toBe(once.text);
  });

  test("line structure is preserved", () => {
    const out = redactSecrets("one\nAPI_TOKEN=s3cr3tV4lu3abcdefgh\nthree");
    expect(out.text.split("\n")).toEqual(["one", "API_TOKEN=[redacted:assigned-secret]", "three"]);
  });

  test("CRLF files keep their line endings", () => {
    // Windows-authored .env and config files are a likely source of secrets;
    // splitting on \n must not strip the \r from every surviving line.
    const out = redactSecrets("one\r\nAPI_TOKEN=s3cr3tV4lu3abcdefgh\r\nthree\r\n");
    expect(out.text).toBe("one\r\nAPI_TOKEN=[redacted:assigned-secret]\r\nthree\r\n");
  });

  test("the marker names the type", () => {
    expect(redactionMarker("openai-key")).toBe("[redacted:openai-key]");
  });

  test("redactOptionsFromEnv reads the two documented switches", () => {
    expect(redactOptionsFromEnv({} as NodeJS.ProcessEnv)).toEqual({ patterns: true, entropy: false });
    expect(redactOptionsFromEnv({ CONTEXT_MODE_INDEX_REDACT: "0" } as NodeJS.ProcessEnv).patterns).toBe(false);
    expect(redactOptionsFromEnv({ CONTEXT_MODE_INDEX_ENTROPY_REDACT: "1" } as NodeJS.ProcessEnv).entropy).toBe(true);
    // Only the documented values flip a switch.
    expect(redactOptionsFromEnv({ CONTEXT_MODE_INDEX_REDACT: "false" } as NodeJS.ProcessEnv).patterns).toBe(true);
    expect(redactOptionsFromEnv({ CONTEXT_MODE_INDEX_ENTROPY_REDACT: "true" } as NodeJS.ProcessEnv).entropy).toBe(false);
  });

  test("the sensitive-key pattern has not drifted from code-index.ts", () => {
    // redact.ts keeps its own copy so it stays import-free on the indexing hot
    // path. This is what stops the copy from quietly diverging.
    const extract = (file: string) => {
      const src = readFileSync(join(ROOT, file), "utf-8");
      const m = /SENSITIVE_NAME_HINT\s*=\s*(\/.*\/i);/.exec(src);
      expect(m, `no SENSITIVE_NAME_HINT in ${file}`).toBeTruthy();
      return m![1];
    };
    expect(extract("src/session/redact.ts")).toBe(extract("src/session/code-index.ts"));
  });
});

/** Every .ts file under a directory. */
function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (entry.endsWith(".ts")) out.push(p);
  }
  return out;
}

/**
 * Reading one *family* of env flags — a JSON object on a head name, plus the
 * individual scalar names that came first.
 *
 * The problem this solves: a single concept (the reuse detector, the fs-bus
 * consumers) grew one variable per knob, and the surface reached ~135
 * `CONTEXT_MODE_*` names nobody can hold in their head. Collapsing a family to
 * one JSON-valued flag fixes the reference without removing a capability — but
 * only if the old names keep working, because they are already sitting in
 * people's shell profiles and CI configs. So both forms are read, and the rule
 * is fixed:
 *
 *   1. the JSON object on the head name is the BASE layer,
 *   2. an individual scalar OVERRIDES the JSON key it overlaps.
 *
 * Scalar-wins is the direction that makes a shell profile authoritative: the
 * JSON blob is the considered configuration, the scalar is the thing someone
 * exported five minutes ago to answer a question, and the recent, narrower,
 * more explicit setting should win.
 *
 * Nothing here throws. An operator who fat-fingers a brace must get the
 * documented defaults and a working server, not a start-up crash — an
 * unparseable env var taking the MCP server down is a far worse failure than
 * silently ignoring it. Malformed JSON therefore falls back to the scalars,
 * and every per-key coercion is fenced too, since a family may supply its own
 * parser.
 *
 * Head-name collision (`CONTEXT_MODE_FS_BUS`): some head names already have a
 * scalar meaning of their own — `CONTEXT_MODE_FS_BUS=0` has always meant "the
 * whole wiring off". The value's FIRST NON-SPACE CHARACTER decides which form
 * it is: `{` means JSON object, anything else is the legacy scalar and is
 * handed to the family's `headScalar` interpreter. JSON has exactly one
 * spelling for an object, so this is unambiguous rather than heuristic, and it
 * can never reclassify a value that works today: `0`, `off`, `false` and a
 * path all start with something other than `{`.
 */

/** Off-values shared by the fork's boolean switches (`isOff` convention). */
const OFF_VALUES = new Set(["0", "off", "false", "no", "disabled"]);

/**
 * The fork's off-switch reading: a flag is ON unless explicitly turned off.
 * Empty/whitespace counts as unset (ON) — an `export FOO=` in a profile is an
 * accident, never a deliberate disable.
 */
export function isOffValue(raw: string | undefined | null): boolean {
  if (raw == null) return false;
  return OFF_VALUES.has(raw.trim().toLowerCase());
}

/** One knob of a family: where it lives in the JSON, and its old scalar name. */
export interface FamilyKeySpec<T> {
  /** Key inside the JSON object on the head name. */
  json: string;
  /** The standalone variable that has always worked. `null` when the knob is
   *  only reachable through the head name itself (see `headScalar`). */
  scalar: string | null;
  /** Value when neither form supplies a usable one. */
  fallback: T;
  /** Raw env string → value, or `undefined` to fall through to the next layer. */
  fromScalar(raw: string): T | undefined;
  /** Parsed JSON value → value, or `undefined` to fall through. */
  fromJson(value: unknown): T | undefined;
}

/**
 * `any` and not `unknown`/`never` on purpose: `T` is covariant here (it is the
 * type of `fallback` and the return of the coercers), so no other constraint
 * accepts a heterogeneous schema literal. The per-key types are recovered
 * exactly by {@link FamilySettings}, so nothing downstream sees `any`.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type FamilySchema = Record<string, FamilyKeySpec<any>>;

/** The resolved settings object a schema produces. */
export type FamilySettings<S> = {
  [K in keyof S]: S[K] extends FamilyKeySpec<infer T> ? T : never;
};

export interface FamilyOptions<S> {
  /**
   * Interpretation of a NON-JSON value on the head name — the escape hatch for
   * a head that already had a scalar meaning. Returns the keys that value
   * implies (merged into the base layer, so individual scalars still win), or
   * `undefined` when the value implies nothing.
   */
  headScalar?(raw: string): Partial<FamilySettings<S>> | undefined;
}

/**
 * Parse the head name's JSON object. Returns `undefined` — never throws, never
 * a partial result — for malformed JSON, for `null`, for arrays, and for
 * scalars like `4` or `"x"`, all of which are configuration mistakes rather
 * than a family object. The caller then sees only the scalars, which is the
 * pre-collapse behaviour and therefore the safe fallback.
 */
export function parseFamilyObject(raw: string | undefined | null): Record<string, unknown> | undefined {
  if (raw == null) return undefined;
  const trimmed = raw.trim();
  if (!trimmed.startsWith("{")) return undefined;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (parsed == null || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
    return parsed as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

/**
 * Resolve a whole family: JSON base layer, scalars on top, defaults underneath.
 * Reads `env` on every call and memoizes nothing, so a test can flip a variable
 * between cases and the next read sees it.
 */
export function readEnvFamily<S extends FamilySchema>(
  head: string,
  schema: S,
  env: NodeJS.ProcessEnv = process.env,
  options: FamilyOptions<S> = {},
): FamilySettings<S> {
  const base: Record<string, unknown> = {};
  const headRaw = env[head];
  if (headRaw !== undefined && headRaw.trim() !== "") {
    const asObject = parseFamilyObject(headRaw);
    if (asObject) {
      Object.assign(base, asObject);
    } else if (headRaw.trim().startsWith("{")) {
      // Malformed JSON: deliberately nothing. The scalars below still apply.
    } else if (options.headScalar) {
      try {
        const implied = options.headScalar(headRaw.trim());
        if (implied) Object.assign(base, implied);
      } catch {
        /* a family's own interpreter must not be able to crash the server */
      }
    }
  }

  const out: Record<string, unknown> = {};
  for (const [key, spec] of Object.entries(schema) as [string, FamilyKeySpec<unknown>][]) {
    out[key] = resolveKey(spec, base, env);
  }
  return out as FamilySettings<S>;
}

/** Scalar → JSON → fallback, with every coercion fenced. */
function resolveKey(spec: FamilyKeySpec<unknown>, base: Record<string, unknown>, env: NodeJS.ProcessEnv): unknown {
  try {
    if (spec.scalar) {
      const raw = env[spec.scalar];
      // Empty/whitespace is treated as unset, matching every hand-written
      // reader this replaced (`if (!raw) return DEFAULT`).
      if (raw !== undefined && raw.trim() !== "") {
        const value = spec.fromScalar(raw);
        if (value !== undefined) return value;
      }
    }
    if (Object.prototype.hasOwnProperty.call(base, spec.json)) {
      const value = spec.fromJson(base[spec.json]);
      if (value !== undefined) return value;
    }
  } catch {
    /* fall through to the fallback — a bad value is not a fatal value */
  }
  return spec.fallback;
}

// ─────────────────────────────────────────────────────────
// Key constructors — the two shapes every family here uses
// ─────────────────────────────────────────────────────────

/**
 * An off-switch boolean: ON unless the scalar says otherwise, and in JSON
 * either a real `false` or any of the string off-values (`{"index":"0"}` is
 * what someone who has typed the scalar for a year will write).
 */
export function boolKey(json: string, scalar: string | null, fallback: boolean): FamilyKeySpec<boolean> {
  return {
    json,
    scalar,
    fallback,
    fromScalar: (raw) => !isOffValue(raw),
    fromJson: (value) => {
      if (typeof value === "boolean") return value;
      if (typeof value === "number") return value !== 0;
      if (typeof value === "string" && value.trim() !== "") return !isOffValue(value);
      return undefined;
    },
  };
}

/**
 * A numeric knob. `normalize` owns the family's range rules (clamping,
 * truncation, the percent-or-fraction reading) and returns `undefined` to
 * reject a value outright, which sends it to the next layer down.
 */
export function numberKey(
  json: string,
  scalar: string | null,
  fallback: number,
  normalize: (n: number) => number | undefined,
): FamilyKeySpec<number> {
  const coerce = (n: number): number | undefined => (Number.isFinite(n) ? normalize(n) : undefined);
  return {
    json,
    scalar,
    fallback,
    fromScalar: (raw) => coerce(Number.parseFloat(raw)),
    fromJson: (value) => {
      if (typeof value === "number") return coerce(value);
      if (typeof value === "string" && value.trim() !== "") return coerce(Number.parseFloat(value));
      return undefined;
    },
  };
}

/**
 * The usual `headScalar`: a legacy off-switch on the head name means "the whole
 * family off", expressed as one boolean key. Any other scalar implies nothing —
 * `CONTEXT_MODE_FS_BUS=1` has never meant more than "not disabled".
 */
export function disableKeyOnOff<S>(key: keyof S & string): (raw: string) => Partial<FamilySettings<S>> | undefined {
  return (raw) => (isOffValue(raw) ? ({ [key]: false } as Partial<FamilySettings<S>>) : undefined);
}

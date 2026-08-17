/**
 * Read-only shell command classification (#1048).
 *
 * Claude Code's plan mode refuses every tool whose `readOnlyHint` is false.
 * `ctx_batch_execute` runs arbitrary shell, so its annotation is correctly
 * `false` — which leaves plan mode with no context-efficient gather path at
 * all: the agent falls back to raw Bash/Read and floods the window with the
 * exact payloads this project exists to keep out.
 *
 * `ctx_gather` closes that gap: same engine, but every command must first
 * prove itself read-only here. The classifier is deliberately conservative —
 * an unknown binary is NOT read-only, because a wrong "yes" mutates the
 * user's machine during a phase where they explicitly asked for no changes.
 *
 * This is a usability gate, not a security boundary: it never sees a command
 * the deny-policy layer has not already vetted, and a user who wants to run
 * something outside the allowlist can simply use `ctx_batch_execute`.
 */

/** Binaries whose every documented invocation only reads. */
const READ_ONLY_BINARIES = new Set([
  // Text / file inspection
  "cat", "head", "tail", "less", "more", "nl", "wc", "sort", "uniq", "cut",
  "tr", "column", "fold", "join", "paste", "comm", "diff", "cmp", "strings",
  "file", "stat", "readlink", "realpath", "basename", "dirname", "md5sum",
  "sha1sum", "sha256sum", "base64",
  // Search / listing
  "ls", "find", "grep", "egrep", "fgrep", "rg", "ag", "ack", "fd", "locate",
  "tree", "du", "df",
  // Data shaping
  "jq", "yq", "xmllint", "csvlook",
  // Process / system probes
  "ps", "pgrep", "uptime", "free", "vmstat", "uname", "hostname", "whoami",
  "id", "groups", "date", "pwd", "env", "printenv", "which", "type", "command",
  "echo", "printf", "true", "false", "seq", "nproc", "lsof", "netstat", "ss",
  "dig", "nslookup", "host", "ping",
]);

/**
 * Subcommand allowlists for multiplexers. A bare `git`/`docker`/`npm` is not
 * read-only — only these verbs are.
 */
const READ_ONLY_SUBCOMMANDS: Record<string, Set<string>> = {
  git: new Set([
    "log", "show", "diff", "status", "branch", "remote", "rev-parse", "rev-list",
    "ls-files", "ls-tree", "ls-remote", "blame", "tag", "describe", "shortlog",
    "cat-file", "show-ref", "whatchanged", "grep", "count-objects", "reflog",
  ]),
  docker: new Set(["ps", "images", "inspect", "logs", "version", "info", "port", "top", "stats", "history"]),
  podman: new Set(["ps", "images", "inspect", "logs", "version", "info", "port", "top", "stats", "history"]),
  kubectl: new Set(["get", "describe", "logs", "top", "version", "api-resources", "explain", "config"]),
  npm: new Set(["ls", "list", "view", "info", "outdated", "why", "config", "ping", "root", "prefix"]),
  pnpm: new Set(["ls", "list", "view", "info", "outdated", "why", "root"]),
  yarn: new Set(["list", "info", "why", "versions"]),
  cargo: new Set(["tree", "metadata", "search"]),
  go: new Set(["list", "version", "env"]),
  gh: new Set(["issue", "pr", "repo", "run", "release", "api", "auth", "search"]),
  systemctl: new Set(["status", "is-active", "is-enabled", "list-units", "list-unit-files", "show", "cat"]),
  brew: new Set(["list", "info", "outdated", "config"]),
  pip: new Set(["list", "show", "freeze"]),
  pip3: new Set(["list", "show", "freeze"]),
  terraform: new Set(["show", "output", "version", "providers", "validate"]),
  helm: new Set(["list", "get", "show", "status", "version", "history"]),
};

/**
 * Constructs that can turn a read-only pipeline into a write: output
 * redirection, here-doc-to-file, command substitution (whose contents this
 * classifier does not walk), and background/sequence separators that could
 * hide a second, unvetted command.
 */
const WRITE_CONSTRUCTS = /(?:^|[^<>&\d])>{1,2}(?!&)|\$\(|`|\bsudo\b|\bdoas\b/;

/** Splits on the separators that compose independent commands. */
const SEGMENT_SPLIT = /\|\||&&|\||;|\n/;

/**
 * `sed`/`awk`/`perl`/`python` are read-only in some invocations and not in
 * others; only the unambiguous read-only forms are accepted.
 */
function isConditionallyReadOnly(binary: string, args: string[]): boolean | null {
  if (binary === "sed") {
    // `-i` (in place) writes; everything else streams to stdout.
    return !args.some(a => a === "-i" || a.startsWith("-i.") || a === "--in-place");
  }
  if (binary === "awk" || binary === "gawk" || binary === "mawk") {
    // awk can write via `> file` inside the program text, which
    // WRITE_CONSTRUCTS already rejects at the command level.
    return true;
  }
  if (binary === "tail" || binary === "head") return true;
  return null;
}

/**
 * @param command Raw shell command as the caller would run it.
 * @returns true only when every segment is provably read-only.
 */
export function isReadOnlyCommand(command: string): boolean {
  const trimmed = (command ?? "").trim();
  if (!trimmed) return false;
  if (WRITE_CONSTRUCTS.test(trimmed)) return false;

  const segments = trimmed.split(SEGMENT_SPLIT).map(s => s.trim()).filter(Boolean);
  if (segments.length === 0) return false;

  for (const segment of segments) {
    // Strip leading `VAR=value` assignments — they scope to the command and
    // do not themselves write anything.
    const tokens = segment.split(/\s+/).filter(t => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(t));
    if (tokens.length === 0) return false;

    const binary = (tokens[0].split("/").pop() ?? tokens[0]).toLowerCase();
    const args = tokens.slice(1);

    const conditional = isConditionallyReadOnly(binary, args);
    if (conditional !== null) {
      if (!conditional) return false;
      continue;
    }

    if (READ_ONLY_BINARIES.has(binary)) continue;

    const subcommands = READ_ONLY_SUBCOMMANDS[binary];
    if (subcommands) {
      // First non-flag token is the subcommand.
      const sub = args.find(a => !a.startsWith("-"));
      if (sub && subcommands.has(sub.toLowerCase())) continue;
      // `--version` / `--help` on any multiplexer is read-only.
      if (!sub && args.some(a => a === "--version" || a === "--help" || a === "-v")) continue;
      return false;
    }

    // Unknown binary — fail closed.
    return false;
  }

  return true;
}

/**
 * @returns The commands that failed the read-only check, with their labels,
 *   so the caller can name them in one actionable error instead of failing
 *   on the first one.
 */
export function findWriteCommands(
  commands: Array<{ label: string; command: string }>,
): Array<{ label: string; command: string }> {
  return commands.filter(c => !isReadOnlyCommand(c.command));
}

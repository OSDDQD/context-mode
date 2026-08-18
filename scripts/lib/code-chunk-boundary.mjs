/**
 * "Does this chunk start at a declaration boundary?" — one definition, shared
 * by the measurement script and the test that gates on it.
 *
 * The question the metric answers is narrow on purpose: given the text of one
 * stored chunk, would a reader recognise its first line as the *start* of
 * something, or did the chunker cut a function in half? It is deliberately
 * syntax-level and parser-free — the chunker it measures is too, and a metric
 * that knew more than the thing it measures would be measuring the wrong
 * thing.
 *
 * Three ways to count as aligned, and nothing else:
 *
 *   (a) Top-level declaration — first line at zero indent, opening with a
 *       declaration keyword. At zero indent `const`/`import` really are
 *       declarations, so they are in the list here.
 *   (b) Member declaration — first line indented, opening with a keyword that
 *       only ever introduces a member (`public`, `async`, `def`, `function`,
 *       …) or reading as a signature rather than a statement: an identifier
 *       followed by `(` or `<`, not ending in `;`, not a control keyword.
 *       `const`/`import` are NOT accepted here: an indented `const x = f();`
 *       is a statement inside a body, which is exactly the mid-function cut
 *       the metric exists to catch.
 *   (c) Doc-introduced declaration — first line opens a comment or decorator
 *       run, and the run is followed, with nothing but comment/blank/decorator
 *       lines in between, by a line that satisfies (a) or (b). A chunk that
 *       starts at a function's own docstring starts at that function.
 *
 * Both arms of the before/after comparison are scored by this same function,
 * so whatever it over- or under-counts, it does so symmetrically.
 */

/** Keywords that open a declaration when they sit at column zero. */
const TOP_DECL = new RegExp(
  "^(?:export|import|from|package|use|module|declare|const|let|var|local|" +
  "function|func|fn|def|defp|defmodule|defmacro|class|struct|enum|interface|" +
  "trait|impl|type|typedef|namespace|record|object|protocol|extension|actor|" +
  "public|private|protected|internal|abstract|final|static|override|open|" +
  "async|sub|proc|template|union|data|val|resource|variable|provider|" +
  "CREATE|create|BEGIN)\\b",
);

/** Keywords that open a member declaration at any indent. */
const MEMBER_DECL = new RegExp(
  "^(?:public|private|protected|internal|abstract|final|static|override|open|" +
  "async|function|func|fn|def|defp|class|struct|enum|interface|trait|impl|" +
  "constructor|get|set|readonly|new|operator|sub|proc)\\b",
);

/**
 * An identifier followed by `(` or `<` — a method signature, unless it is a
 * call statement (ends in `;`) or a control-flow head.
 */
const SIGNATURE = /^[#*]?[A-Za-z_$][\w$]*\s*[(<]/;
const CONTROL_KEYWORD = new RegExp(
  "^(?:if|for|while|switch|catch|return|else|elif|do|try|with|match|case|" +
  "when|until|unless|foreach|await|throw|yield)\\b",
);

/** Lines that carry no declaration of their own but may introduce one. */
const COMMENT_OR_DECORATOR = new RegExp(
  "^(?:/\\*|\\*/|\\*(?![\\w(])|//|#!|#\\[|#(?=[\\s#]|$)|--(?=[\\s-]|$)|" +
  "\"\"\"|'''|@[A-Za-z_]|%(?=[\\s%])|;;)",
);

/** How far past the comment run a declaration may sit and still count. */
const DOC_RUN_MAX_LINES = 24;

function indentOf(line) {
  const lead = /^[ \t]*/.exec(line)[0];
  return lead.replace(/\t/g, "    ").length;
}

/** @returns true when `line` opens a declaration, judged on its own. */
function isDeclarationLine(line) {
  const trimmed = line.trim();
  if (trimmed.length === 0) return false;
  if (indentOf(line) === 0 && TOP_DECL.test(trimmed)) return true;
  if (MEMBER_DECL.test(trimmed)) return true;
  if (CONTROL_KEYWORD.test(trimmed)) return false;
  // A signature, not a call: `foo(` / `#bar(a, b) {` but not `doThing(x);`.
  if (SIGNATURE.test(trimmed) && !trimmed.endsWith(";")) return true;
  return false;
}

function isCommentOrDecorator(line) {
  const trimmed = line.trim();
  return trimmed.length > 0 && COMMENT_OR_DECORATOR.test(trimmed);
}

/**
 * @param {string} content Stored chunk text.
 * @returns {boolean} true when the chunk starts at a declaration boundary.
 */
export function startsAtDeclaration(content) {
  const lines = String(content ?? "").split("\n");
  let i = 0;
  while (i < lines.length && lines[i].trim().length === 0) i++;
  if (i >= lines.length) return false;

  // (a) and (b): the first line speaks for itself.
  if (isDeclarationLine(lines[i])) return true;

  // (c): a comment/decorator run that introduces a declaration.
  if (!isCommentOrDecorator(lines[i])) return false;
  const limit = Math.min(lines.length, i + DOC_RUN_MAX_LINES);
  for (let j = i + 1; j < limit; j++) {
    const line = lines[j];
    if (line.trim().length === 0) continue;
    if (isCommentOrDecorator(line)) continue;
    return isDeclarationLine(line);
  }
  return false;
}

/**
 * The narrow reading of the same question: the chunk opens a *top-level*
 * declaration — column zero, keyword list only, no signature pattern and no
 * indented member. A chunk that starts on a class method scores as a miss
 * here even though it is a perfectly good boundary, which is the point: read
 * it as a conservative floor, not as the answer.
 *
 * The one concession is the comment run, kept because attaching a docstring
 * to the declaration below it is a design requirement rather than a liberty —
 * a metric that punished it would be measuring against the wrong target.
 *
 * @param {string} content Stored chunk text.
 * @returns {boolean}
 */
export function startsAtTopLevelDeclaration(content) {
  const lines = String(content ?? "").split("\n");
  let i = 0;
  while (i < lines.length && lines[i].trim().length === 0) i++;
  if (i >= lines.length) return false;

  const topLevelDecl = (line) => indentOf(line) === 0 && TOP_DECL.test(line.trim());
  if (topLevelDecl(lines[i])) return true;
  if (indentOf(lines[i]) !== 0 || !isCommentOrDecorator(lines[i])) return false;

  const limit = Math.min(lines.length, i + DOC_RUN_MAX_LINES);
  for (let j = i + 1; j < limit; j++) {
    if (lines[j].trim().length === 0) continue;
    if (isCommentOrDecorator(lines[j])) continue;
    return topLevelDecl(lines[j]);
  }
  return false;
}

/**
 * @param {Array<{content: string}>} chunks
 * @returns {{total: number, aligned: number, ratio: number, strict: number, strictRatio: number}}
 */
export function alignmentRatio(chunks) {
  let aligned = 0;
  let strict = 0;
  for (const chunk of chunks) {
    if (startsAtDeclaration(chunk.content)) aligned++;
    if (startsAtTopLevelDeclaration(chunk.content)) strict++;
  }
  return {
    total: chunks.length,
    aligned,
    ratio: chunks.length === 0 ? 0 : aligned / chunks.length,
    strict,
    strictRatio: chunks.length === 0 ? 0 : strict / chunks.length,
  };
}

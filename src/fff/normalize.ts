/**
 * Native → normalized mapping.
 *
 * Two invariants every function here upholds:
 *   1. Paths come out absolute AND inside the project root. A hit that falls
 *      outside is dropped, not clamped — that is the cross-project isolation
 *      guard (08ddb5e) applied to the search channel.
 *   2. Totals survive. `totalMatched` / `filesSearched` / `filteredFileCount`
 *      are carried through untouched so a caller can report "showing 20 of
 *      340" instead of quietly presenting a page as the whole answer.
 */

import type {
  DirItem,
  DirSearchResult,
  FileItem,
  GrepMatch,
  GrepResult,
  MixedSearchResult,
  Score,
  SearchResult,
} from "@ff-labs/fff-node";

import { absolutePathIn, isInsideRoot } from "./paths.js";
import type {
  FffDirItem,
  FffDirSearchResult,
  FffFileItem,
  FffGrepMatch,
  FffGrepResult,
  FffMixedItem,
  FffMixedSearchResult,
  FffScore,
  FffSearchResult,
} from "./types.js";

/** fff reports mtime in epoch seconds; the rest of the plugin speaks milliseconds. */
function toMillis(seconds: number): number {
  return Number.isFinite(seconds) ? Math.round(seconds * 1000) : 0;
}

function normalizeScore(score: Score | undefined): FffScore {
  return {
    total: score?.total ?? 0,
    baseScore: score?.baseScore ?? 0,
    filenameBonus: score?.filenameBonus ?? 0,
    specialFilenameBonus: score?.specialFilenameBonus ?? 0,
    frecencyBoost: score?.frecencyBoost ?? 0,
    distancePenalty: score?.distancePenalty ?? 0,
    currentFilePenalty: score?.currentFilePenalty ?? 0,
    comboMatchBoost: score?.comboMatchBoost ?? 0,
    exactMatch: score?.exactMatch ?? false,
    matchType: score?.matchType ?? "",
  };
}

export function normalizeFileItem(root: string, item: FileItem): FffFileItem | null {
  if (!isInsideRoot(item.relativePath, root)) return null;
  return {
    path: absolutePathIn(root, item.relativePath),
    relativePath: item.relativePath,
    fileName: item.fileName,
    size: item.size,
    modified: toMillis(item.modified),
    accessFrecencyScore: item.accessFrecencyScore,
    modificationFrecencyScore: item.modificationFrecencyScore,
    totalFrecencyScore: item.totalFrecencyScore,
    gitStatus: item.gitStatus,
  };
}

export function normalizeDirItem(root: string, item: DirItem): FffDirItem | null {
  if (!isInsideRoot(item.relativePath, root)) return null;
  return {
    path: absolutePathIn(root, item.relativePath),
    relativePath: item.relativePath,
    dirName: item.dirName,
    maxAccessFrecency: item.maxAccessFrecency,
  };
}

/**
 * Keeps `items` and `scores` positionally aligned even when a hit is dropped
 * for landing outside the root — a merger downstream indexes one by the other.
 */
export function normalizeSearchResult(root: string, result: SearchResult): FffSearchResult {
  const items: FffFileItem[] = [];
  const scores: FffScore[] = [];
  result.items.forEach((item, i) => {
    const normalized = normalizeFileItem(root, item);
    if (!normalized) return;
    items.push(normalized);
    scores.push(normalizeScore(result.scores[i]));
  });
  return {
    items,
    scores,
    totalMatched: result.totalMatched,
    totalFiles: result.totalFiles,
    truncated: items.length < result.totalMatched,
  };
}

export function normalizeDirSearchResult(root: string, result: DirSearchResult): FffDirSearchResult {
  const items: FffDirItem[] = [];
  const scores: FffScore[] = [];
  result.items.forEach((item, i) => {
    const normalized = normalizeDirItem(root, item);
    if (!normalized) return;
    items.push(normalized);
    scores.push(normalizeScore(result.scores[i]));
  });
  return {
    items,
    scores,
    totalMatched: result.totalMatched,
    totalDirs: result.totalDirs,
    truncated: items.length < result.totalMatched,
  };
}

export function normalizeMixedSearchResult(root: string, result: MixedSearchResult): FffMixedSearchResult {
  const items: FffMixedItem[] = [];
  const scores: FffScore[] = [];
  result.items.forEach((entry, i) => {
    if (entry.type === "file") {
      const normalized = normalizeFileItem(root, entry.item);
      if (!normalized) return;
      items.push({ type: "file", item: normalized });
    } else {
      const normalized = normalizeDirItem(root, entry.item);
      if (!normalized) return;
      items.push({ type: "directory", item: normalized });
    }
    scores.push(normalizeScore(result.scores[i]));
  });
  return {
    items,
    scores,
    totalMatched: result.totalMatched,
    totalFiles: result.totalFiles,
    totalDirs: result.totalDirs,
    truncated: items.length < result.totalMatched,
  };
}

export function normalizeGrepMatch(root: string, match: GrepMatch): FffGrepMatch | null {
  if (!isInsideRoot(match.relativePath, root)) return null;
  return {
    path: absolutePathIn(root, match.relativePath),
    relativePath: match.relativePath,
    fileName: match.fileName,
    gitStatus: match.gitStatus,
    size: match.size,
    modified: toMillis(match.modified),
    isBinary: match.isBinary,
    totalFrecencyScore: match.totalFrecencyScore,
    accessFrecencyScore: match.accessFrecencyScore,
    modificationFrecencyScore: match.modificationFrecencyScore,
    lineNumber: match.lineNumber,
    col: match.col,
    byteOffset: match.byteOffset,
    lineContent: match.lineContent,
    matchRanges: match.matchRanges ?? [],
    ...(match.fuzzyScore !== undefined ? { fuzzyScore: match.fuzzyScore } : {}),
    ...(match.contextBefore !== undefined ? { contextBefore: match.contextBefore } : {}),
    ...(match.contextAfter !== undefined ? { contextAfter: match.contextAfter } : {}),
    ...(match.isDefinition !== undefined ? { isDefinition: match.isDefinition } : {}),
  };
}

export function normalizeGrepResult(root: string, result: GrepResult): FffGrepResult {
  const items: FffGrepMatch[] = [];
  for (const match of result.items) {
    const normalized = normalizeGrepMatch(root, match);
    if (normalized) items.push(normalized);
  }
  const cursorOffset = readCursorOffset(result.nextCursor);
  return {
    items,
    totalMatched: result.totalMatched,
    filesSearched: result.totalFilesSearched,
    totalFiles: result.totalFiles,
    filteredFileCount: result.filteredFileCount,
    nextCursor: cursorOffset === null ? null : { offset: cursorOffset },
    // Grep pages by FILE, and `totalMatched` counts only what this page found
    // (verified against 0.10.5). A pending cursor is therefore the only honest
    // signal that more matches exist — `items.length < totalMatched` would
    // always be false here.
    truncated: cursorOffset !== null || items.length < result.items.length,
    ...(result.regexFallbackError !== undefined ? { regexFallbackError: result.regexFallbackError } : {}),
  };
}

/** The native cursor is branded but structurally `{ _offset: number }`. */
function readCursorOffset(cursor: unknown): number | null {
  if (!cursor || typeof cursor !== "object") return null;
  const offset = (cursor as { _offset?: unknown })._offset;
  return typeof offset === "number" && Number.isFinite(offset) ? offset : null;
}

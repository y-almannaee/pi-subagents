/**
 * Reads enabledModels from ~/.pi/agent/settings.json and resolves
 * string patterns to concrete model IDs for scope validation.
 *
 * Ref: pi-coding-agent resolves enabledModels at startup via:
 *   main.js:439  modelPatterns = parsed.models ?? settingsManager.getEnabledModels()
 *   main.js:440  scopedModels = resolveModelScope(modelPatterns, modelRegistry)
 *
 * We replicate the pattern resolution here (exact, fuzzy, glob) so the
 * extension can validate subagent model choices against the same list.
 *
 * Example: enabledModels = ["llama-swap/Qwen3.6-27B-...:precise", "anthropic/*"]
 *   → resolves to {"llama-swap/Qwen3.6-27B-...:precise", "anthropic/claude-haiku-4-5", ...}
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@mariozechner/pi-coding-agent";
import type { ModelEntry } from "./model-resolver.js";

/** Minimal registry shape — mirrors what model-resolver.ts already expects. */
export interface ModelRegistryRef {
  find(provider: string, modelId: string): unknown;
  getAll(): unknown[];
  getAvailable?(): unknown[];
}

/** Read enabledModels from global pi settings. Undefined when file missing or field absent. */
export function readEnabledModels(): string[] | undefined {
  const path = join(getAgentDir(), "settings.json");
  if (!existsSync(path)) return undefined;
  try {
    const raw = JSON.parse(readFileSync(path, "utf-8"));
    if (Array.isArray(raw?.enabledModels)) return raw.enabledModels as string[];
  } catch {
    /* corrupt file — silent */
  }
  return undefined;
}

/**
 * Resolve enabledModels patterns → Set<"provider/modelId"> (lowercase keys).
 *
 * Matching (mirrors pi-coding-agent resolveModelScope → tryMatchModel):
 *   1. Exact "provider/modelId"  (slash present, case-insensitive)
 *   2. Bare "modelId"            (no slash, exact id match)
 *   3. Glob wildcard             (* ? [  → minimatch, optional dep)
 *
 * No fuzzy matching — pi only writes exact provider/modelId to enabledModels.
 * Colons are part of the model ID (e.g. "llama-swap/model:precise").
 *
 * Cache: keyed on settings.json mtime+size. Re-reads only when file changes.
 * Invalidated via invalidateCache() or when patterns differ from cached.
 *
 * Example: "llama-swap/Qwen3.6-27B-Q4:precise"
 *   → provider="llama-swap", modelId="Qwen3.6-27B-Q4:precise"
 *
 * Returns undefined when no patterns or no matches (scope check becomes no-op).
 */

// Module-level cache — invalidated when settings.json changes or patterns differ.
let cachedAllowed: Set<string> | undefined;
let cachedHash = "";
let cachedPatternsKey = "";

export function invalidateCache(): void {
  cachedHash = "";
  cachedPatternsKey = "";
  cachedAllowed = undefined;
}

export function resolveEnabledModels(
  patterns: string[] | undefined,
  registry: ModelRegistryRef,
): Set<string> | undefined {
  // Fast path: check cache
  const patternsKey = JSON.stringify(patterns);
  const settingsPath = join(getAgentDir(), "settings.json");
  let fileHash: string;
  try {
    const stat = statSync(settingsPath);
    fileHash = `${stat.mtimeMs}-${stat.size}`;
  } catch {
    fileHash = "missing";
  }

  if (fileHash === cachedHash && patternsKey === cachedPatternsKey) {
    return cachedAllowed;
  }

  // Cache miss — resolve
  if (!patterns || patterns.length === 0) {
    cachedHash = fileHash;
    cachedPatternsKey = patternsKey;
    cachedAllowed = undefined;
    return undefined;
  }

  const available = (registry.getAvailable?.() ?? registry.getAll()) as ModelEntry[];
  const allowed = new Set<string>();

  for (const pattern of patterns) {
    const trimmed = pattern.trim();
    if (!trimmed) continue;  // skip empty/whitespace — would match all models via fuzzy
    if (isGlob(trimmed)) {
      resolveGlob(trimmed, available, allowed);
    } else {
      resolveExact(trimmed, available, allowed);
    }
  }

  const result = allowed.size > 0 ? allowed : undefined;
  cachedHash = fileHash;
  cachedPatternsKey = patternsKey;
  cachedAllowed = result;
  return result;
}



function isGlob(p: string): boolean {
  return p.includes("*") || p.includes("?") || p.includes("[");
}

/**
 * Resolve exact pattern: provider/modelId or bare modelId.
 *
 * Ref: pi-coding-agent writes only exact "provider/modelId" to enabledModels.
 * Bare modelId supported for manual edits. No fuzzy — pi never writes it.
 *
 * Example: "google/gemma-4-31b-it" → exact match
 *          "speed" → bare id match
 */
function resolveExact(
  pattern: string,
  available: ModelEntry[],
  allowed: Set<string>,
): void {
  // 1. "provider/modelId" — exact (colon is part of id, not split)
  const slashIdx = pattern.indexOf("/");
  if (slashIdx !== -1) {
    const provider = pattern.slice(0, slashIdx).toLowerCase();
    const modelId = pattern.slice(slashIdx + 1).toLowerCase();
    const exact = available.find(
      m => m.provider.toLowerCase() === provider && m.id.toLowerCase() === modelId,
    );
    if (exact) {
      allowed.add(`${exact.provider}/${exact.id}`.toLowerCase());
      return;
    }
  }

  // 2. Bare modelId — exact match (manual edit only, pi never writes this)
  const bare = available.find(m => m.id.toLowerCase() === pattern.toLowerCase());
  if (bare) {
    allowed.add(`${bare.provider}/${bare.id}`.toLowerCase());
  }
}

/**
 * Resolve glob pattern via minimatch (optional dep).
 *
 * Ref: model-resolver.js → resolveModelScope() glob branch
 *   minimatch(fullId, pattern, { nocase: true }) || minimatch(id, pattern, { nocase: true })
 *
 * Example: "anthropic/*" matches "anthropic/claude-haiku-4-5", "anthropic/claude-sonnet-4-6"
 *          "*sonnet*" matches "anthropic/claude-sonnet-4-6"
 */
function resolveGlob(
  pattern: string,
  available: ModelEntry[],
  allowed: Set<string>,
): void {
  let minimatchFn: ((target: string, pat: string, opts: object) => boolean) | undefined;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    minimatchFn = require("minimatch").minimatch;
  } catch {
    /* optional dep missing */
  }

  if (!minimatchFn) {
    console.warn(`[pi-subagents] Glob "${pattern}" needs minimatch (skip)`);
    return;
  }

  for (const m of available) {
    const full = `${m.provider}/${m.id}`;
    if (
      minimatchFn(full, pattern, { nocase: true }) ||
      minimatchFn(m.id, pattern, { nocase: true })
    ) {
      allowed.add(full.toLowerCase());
    }
  }
}

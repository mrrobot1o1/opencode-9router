// Per-model thinking level resolution, derived from the capability data
// `/v1/models` already publishes (`reasoning`, `thinkingFormat`,
// `thinkingCanDisable`, `thinkingEffortSupported`) — no hardcoded model lists.
//
// The one mapping that ships baked-in is thinkingFormat → level set, which is
// knowledge about *formats*, not models, and travels with the router's wire
// contract. Everything model-specific comes from (a) the capabilities block,
// (b) user-provided overrides via plugin options (`thinkingOverrides`), or
// (c) an explicit `capabilities.thinkingLevels` array when a future 9Router
// publishes its fully-resolved list.
//
// A capability-only resolver matches upstream's own picker on ~86% of the live
// inventory (548/640 models as of 2026-10); most residuals are gateway catalog
// quirks upstream hardcodes its side. When we over-advertise a level the wire
// rejects, OpenCode surfaces a clean "Variant unavailable" error.

import type { RouterCapabilities } from "./router.js"

// ── Level sets ──────────────────────────────────────────────

/** Discrete effort levels, low → high (9Router EFFORT_LEVELS). */
export const EFFORT_LEVELS = ["minimal", "low", "medium", "high", "xhigh", "max"] as const

/** Shared level sets from 9Router thinkingLevels.js. */
const L = {
  base: ["none", "low", "medium", "high"], // qwen, step, hunyuan, gemini-budget
  onOff: ["none", "thinking"], // zai (binary), minimax (adaptive)
  openai: ["none", "minimal", "low", "medium", "high", "xhigh"], // GPT-5.x / o-series
  levelMax: ["none", "low", "medium", "high", "max"], // kimi
  budgetX: ["none", "low", "medium", "high", "xhigh", "max"], // claude budget/adaptive
  gemini: ["minimal", "low", "medium", "high"], // gemini-3 thinkingLevel (no disable)
  hiMax: ["none", "high", "max"], // deepseek (low/med→high, xhigh→max)
} as const

/** thinkingFormat → valid selectable levels (9Router FORMAT_LEVELS). */
const FORMAT_LEVELS: Record<string, readonly string[]> = {
  openai: L.openai,
  "claude-adaptive": L.budgetX,
  "claude-budget": L.budgetX,
  "gemini-level": L.gemini,
  "gemini-budget": L.base,
  zai: L.onOff,
  qwen: L.base,
  kimi: L.levelMax,
  deepseek: L.hiMax,
  commandcode: ["none", "low", "medium", "high", "xhigh", "max"],
  minimax: L.onOff,
  hunyuan: L.base,
  step: L.base,
  nous: L.base,
}

// ── User overrides (opt-in via plugin options, not shipped presets) ──────

/**
 * User-supplied correction for models whose published capabilities diverge
 * from the wire. First match wins; `provider` (the 9Router alias) narrows the
 * entry. Example:
 *
 * `"thinkingOverrides": [
 *   { "pattern": "*gemini-4*", "levels": ["low", "medium", "high"] },
 *   { "provider": "cx", "pattern": "*gpt-5.6-sol*", "levels": ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"] }
 * ]`
 */
export interface ModelLevelOverride {
  provider?: string
  pattern: string
  levels: readonly string[]
}

/** Coerce plugin-option overrides into typed entries (unknown shapes dropped). */
export function overridesFrom(options: unknown): ModelLevelOverride[] {
  if (!Array.isArray(options)) return []
  const out: ModelLevelOverride[] = []
  for (const raw of options) {
    if (typeof raw !== "object" || raw === null) continue
    const entry = raw as Record<string, unknown>
    if (typeof entry.pattern !== "string" || !Array.isArray(entry.levels)) continue
    const levels = entry.levels.filter((l): l is string => typeof l === "string")
    if (levels.length === 0) continue
    out.push({
      pattern: entry.pattern,
      levels,
      ...(typeof entry.provider === "string" && entry.provider.length > 0
        ? { provider: entry.provider }
        : {}),
    })
  }
  return out
}

// ── Helpers ─────────────────────────────────────────────────

/** Glob match equivalent to 9Router matchPattern (`*` wildcards, case-insensitive). */
export function matchPattern(pattern: string, value: string): boolean {
  const regex = new RegExp(
    `^${pattern.split("*").map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`,
    "i",
  )
  return regex.test(value)
}

/** Split a routed model id `alias/modelId` into its parts. */
export function splitModelID(id: string): { alias: string; model: string } {
  const slash = id.indexOf("/")
  if (slash === -1) return { alias: "", model: id }
  return { alias: id.slice(0, slash), model: id.slice(slash + 1) }
}

/** Strip an existing thinking suffix `model(level)` from a model id. */
export function stripThinkingSuffix(model: string): string {
  return model.replace(/\([^()]+\)\s*$/, "").trim()
}

// ── Resolver ────────────────────────────────────────────────

/**
 * Resolve the valid thinking levels for a routed 9Router model id
 * (`alias/modelId`). Returns undefined when the model does not expose
 * reasoning (no thinking picker), mirroring getThinkingLevels' null.
 *
 * Resolution order: explicit `capabilities.thinkingLevels` (future 9Router
 * fields) → user overrides → zai effort contract → thinkingFormat table.
 *
 * `provider` is the 9Router provider id (e.g. "codex", "opencode") used to
 * scope user override entries; callers map the alias when known.
 */
export function thinkingLevels(
  fullID: string,
  capabilities: RouterCapabilities | undefined,
  provider?: string,
  overrides?: readonly ModelLevelOverride[],
): readonly string[] | undefined {
  const caps = capabilities
  if (!caps?.reasoning) return undefined

  const applyDisableFilter = (levels: readonly string[]): readonly string[] =>
    caps.thinkingCanDisable === false ? levels.filter((l) => l !== "none") : levels

  // Future-proofing: a fully-resolved list published by the router wins.
  if (Array.isArray(caps.thinkingLevels) && caps.thinkingLevels.length > 0) {
    return applyDisableFilter(caps.thinkingLevels)
  }

  // User-configured corrections scope knowledge we don't derive.
  const { model } = splitModelID(fullID)
  const baseID = stripThinkingSuffix(model)
  const hit = overrides?.find(
    (entry) => (!entry.provider || entry.provider === provider) && matchPattern(entry.pattern, baseID),
  )
  if (hit) return applyDisableFilter(hit.levels)

  // GLM-5.2/5.3 (zai format + effort-capable): the wire accepts exactly
  // low|high|max — GLM-5.3 errors on anything else, and 5.2 clamps
  // low/medium→high, xhigh→max server-side. Older GLM (5.1 and below) ignores
  // reasoning_effort entirely → plain on/off thinking.
  if (caps.thinkingFormat === "zai" && caps.thinkingEffortSupported) {
    return applyDisableFilter(["low", "high", "max"])
  }

  return applyDisableFilter(FORMAT_LEVELS[caps.thinkingFormat ?? ""] ?? L.base)
}

/** Human label for a thinking level. */
export function levelLabel(level: string): string {
  switch (level) {
    case "none":
      return "No thinking"
    case "thinking":
      return "Thinking (adaptive)"
    case "ultra":
      return "Ultra effort"
    case "default":
      return "Model default"
    default:
      return `Effort ${level}`
  }
}

/** Sort order for levels in pickers: none < minimal..max < thinking/ultra. */
const LEVEL_ORDER: Record<string, number> = {
  none: 0,
  minimal: 1,
  low: 2,
  medium: 3,
  high: 4,
  xhigh: 5,
  max: 6,
  ultra: 7,
  thinking: 8,
}

export function levelSort(a: string, b: string): number {
  return (LEVEL_ORDER[a] ?? 99) - (LEVEL_ORDER[b] ?? 99)
}

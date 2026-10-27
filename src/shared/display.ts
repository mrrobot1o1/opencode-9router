// Display helpers shared by the server and TUI parts: routed-id naming,
// provider display names, token/cost formatting.
//
// Provider names are NEVER hardcoded — the router knows them better than any
// plugin could. They resolve dynamically from (in order):
//   1. `GET /api/usage/providers` — the router's own id → display-name map
//      (custom gateways get the user-chosen node name, e.g. "Inferhub";
//      standard providers get their catalog names, e.g. "Kiro AI")
//   2. `/api/providers` connections — names for connected custom compatibles,
//      keyed by their prefix (model-id alias) and provider id
//   3. the raw key as-is (honest fallback when /api/* is unreachable)

import { splitModelID, stripThinkingSuffix } from "./levels.js"

/** Dynamically resolved provider names: stats provider id or model alias → name. */
export type ProviderNames = Readonly<Record<string, string>>

/**
 * Display name for a provider key: a usage-stats provider id
 * (`openai-compatible-chat-…`, `kiro`) or a model-id alias (`kr`, `inf`).
 * Unknown keys pass through unchanged.
 */
export function providerDisplayName(provider: string, names?: ProviderNames): string {
  if (!provider) return "unknown"
  if (names && names[provider]) return names[provider]
  return sanitizeText(provider)
}

/** Human display name for a routed model id, e.g. `kr/claude-4.5` → "claude-4.5 (Kiro AI)". */
export function formatModelName(modelID: string, names?: ProviderNames): string {
  const { alias, model } = splitModelID(stripThinkingSuffix(modelID))
  if (!alias) return sanitizeText(model)
  return `${sanitizeText(model)} (${providerDisplayName(alias, names)})`
}

/** Strip control characters (incl. ANSI escapes) from anything rendered to the terminal. */
// eslint-disable-next-line no-control-regex
export function sanitizeText(text: string): string {
  return text.replace(/[\u0000-\u001f\u007f-\u009f]/g, "")
}

// ── Number formatting ───────────────────────────────────────

/** Compact token count: 12500 → "12.5k", 3120000 → "3.12M", 950 → "950". */
export function formatTokens(tokens: number): string {
  if (!Number.isFinite(tokens)) return "0"
  const abs = Math.abs(tokens)
  if (abs >= 1_000_000) return `${trim(tokens / 1_000_000)}M`
  if (abs >= 1_000) return `${trim(tokens / 1000)}k`
  return String(Math.round(tokens))
}

function trim(value: number): string {
  const rounded = value >= 100 ? Math.round(value * 10) / 10 : Math.round(value * 100) / 100
  return String(rounded).replace(/\.0$/, "")
}

const money = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" })

/** USD cost: $0 under a fraction of a cent, otherwise $x.xx. */
export function formatCost(cost: number): string {
  if (!Number.isFinite(cost) || cost <= 0) return "$0"
  if (cost < 0.005) return "<$0.01"
  return money.format(cost)
}

/** Share bar using filled/empty blocks, e.g. "▰▰▰▱▱▱▱▱". */
export function shareBar(share: number, width = 8): string {
  const filled = Math.max(share > 0 ? 1 : 0, Math.min(width, Math.round(share * width)))
  return "▰".repeat(filled) + "▱".repeat(Math.max(0, width - filled))
}

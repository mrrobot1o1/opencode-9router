// Discovery pipeline for the server part: fetch `/v1/models`, map each entry
// onto a V2 `Model.Info` with capabilities, token limits, and per-model
// thinking variants resolved from 9Router's own capability data.

import { Model, Provider } from "@opencode/plugin"
import {
  fetchConnections,
  fetchModelInfo,
  fetchModels,
  type RouterCapabilities,
  type RouterConfig,
  type RouterConnection,
  type RouterModel,
} from "../shared/router.js"
import type { ModelLevelOverride } from "../shared/levels.js"
import { formatModelName } from "../shared/display.js"
import { levelSort, splitModelID, thinkingLevels } from "../shared/levels.js"
import { ALIAS_TO_PROVIDER } from "./alias.js"

/** A registered 9Router model ready for provider injection. */
export interface HubModel {
  id: string
  info: Model.Info
}

/** Everything the provider transform needs, captured before registration. */
export interface Inventory {
  models: HubModel[]
}

// ── Capability mapping ──────────────────────────────────────

function toPositiveInt(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined
}

function limitFrom(model: RouterModel, caps?: RouterCapabilities): Model.Info["limit"] {
  const context = toPositiveInt(caps?.contextWindow ?? model.context_length) ?? 200_000
  const output = toPositiveInt(caps?.maxOutput ?? model.max_completion_tokens) ?? 32_000
  return { context, output }
}

function capabilitiesFrom(caps: RouterCapabilities | undefined): Model.Info["capabilities"] {
  const input = new Set<string>(["text"])
  if (caps?.vision) input.add("image")
  if (caps?.pdf) input.add("pdf")
  if (caps?.audioInput) input.add("audio")
  if (caps?.videoInput) input.add("video")
  const output = new Set<string>(["text"])
  if (caps?.imageOutput) output.add("image")
  if (caps?.audioOutput) output.add("audio")
  return {
    tools: caps?.tools ?? true,
    input: Array.from(input),
    output: Array.from(output),
  }
}

// ── Variant mapping ─────────────────────────────────────────

/**
 * Build the variant list for one model. `none` is kept when the model can
 * disable thinking (9Router's picker exposes it as "off"). Order follows
 * 9Router's level sort (none, minimal..max, thinking, ultra).
 */
function variantsFrom(
  fullID: string,
  caps: RouterCapabilities | undefined,
  overrides?: readonly ModelLevelOverride[],
): Model.Info["variants"] {
  const { alias, model } = splitModelID(fullID)
  const levels = thinkingLevels(fullID, caps, ALIAS_TO_PROVIDER[alias], overrides)
  if (!levels || levels.length === 0) return []
  return [...levels]
    .sort(levelSort)
    .map((level) => ({
      id: Model.VariantID.make(level),
      settings: { reasoningEffort: level } as Model.Settings,
    }))
}

// ── Connected-providers filter ──────────────────────────────

/** Free/no-auth lanes 9Router always serves, with or without a connection. */
const FREE_ALIASES = new Set(["oc", "ollama", "ollama-local"])

/** Reverse of ALIAS_TO_PROVIDER: 9Router provider id → default alias. */
const PROVIDER_TO_ALIAS: Record<string, string> = Object.fromEntries(
  Object.entries(ALIAS_TO_PROVIDER).map(([alias, provider]) => [provider, alias]),
)

/**
 * Aliases that currently have an active connection, per the router's own
 * `/api/providers`. A custom compatible provider serves under its configured
 * `prefix`; standard providers under their default alias.
 */
export function connectedAliases(connections: readonly RouterConnection[]): Set<string> {
  const aliases = new Set<string>(FREE_ALIASES)
  for (const connection of connections) {
    if (connection.isActive === false) continue
    const provider = typeof connection.provider === "string" ? connection.provider : undefined
    if (!provider) continue
    const prefix =
      typeof connection.providerSpecificData?.prefix === "string"
        ? connection.providerSpecificData.prefix.trim()
        : ""
    const alias = prefix || PROVIDER_TO_ALIAS[provider] || provider
    if (alias) aliases.add(alias)
  }
  return aliases
}

/**
 * Keep only models whose provider has an active connection (plus free lanes
 * and combo entries, which carry no alias). Applied when the connections list
 * is reachable — an unreachable list never filters (fail-open).
 */
export function filterConnected(
  entries: RouterModel[],
  connections: readonly RouterConnection[] | undefined,
  connectedOnly: "auto" | boolean,
): RouterModel[] {
  if (connectedOnly === false || connections === undefined) return entries
  const aliases = connectedAliases(connections)
  const kept = entries.filter((entry) => {
    const slash = entry.id.indexOf("/")
    if (slash <= 0) return true // combos / custom top-level entries
    return aliases.has(entry.id.slice(0, slash))
  })
  return kept.length > 0 ? kept : entries
}

// ── Model mapping ───────────────────────────────────────────

/** Map one `/v1/models` entry onto a V2 Model.Info. */
export function toModelInfo(
  providerID: string,
  entry: RouterModel,
  overrides?: readonly ModelLevelOverride[],
): Model.Info {
  const base = Model.Info.default(Provider.ID.make(providerID), Model.ID.make(entry.id))
  return {
    ...base,
    name: entry.name ?? formatModelName(entry.id),
    capabilities: capabilitiesFrom(entry.capabilities),
    limit: limitFrom(entry, entry.capabilities),
    variants: variantsFrom(entry.id, entry.capabilities, overrides),
    enabled: true,
    status: "active",
  }
}

/** Map a full inventory onto registered models, preserving order. */
export function toModelInfos(
  providerID: string,
  entries: RouterModel[],
  overrides?: readonly ModelLevelOverride[],
): HubModel[] {
  return entries.map((entry) => ({ id: entry.id, info: toModelInfo(providerID, entry, overrides) }))
}

// ── Discovery ───────────────────────────────────────────────

export interface DiscoverLogger {
  (level: "info" | "warn" | "error", message: string): Promise<void> | void
}

/** Everything needed to register + repersist an inventory. */
export interface DiscoveryResult {
  models: HubModel[]
  /** Raw `/v1/models` entries, for durable caching. */
  raw: RouterModel[]
  /** The connections list when reachable — drives the connected-only filter. */
  connections?: RouterConnection[]
}

/**
 * Discover the routed model inventory. Retries once on failure; returns
 * undefined when the router is unreachable so callers can keep stale state.
 */
export async function discoverInventory(
  config: RouterConfig,
  log: DiscoverLogger,
): Promise<DiscoveryResult | undefined> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      log("info", `discovery:start attempt=${attempt}`)
      // Connections drive the connected-providers filter; fetch in parallel.
      // An unreachable list (e.g. hosted router without a dashboard token)
      // never filters — the inventory stays complete.
      const [entries, connections] = await Promise.all([
        fetchModels(config),
        fetchConnections(config).catch((error: unknown) => {
          log("info", `connections unavailable: ${error instanceof Error ? error.message : String(error)}`)
          return undefined
        }),
      ])
      log("info", `discovery:fetch ok (${entries.length} entries, ${connections?.length ?? "unavailable"} connections)`)
      if (entries.length === 0) throw new Error("empty model list")
      const filtered = filterConnected(entries, connections, config.connectedOnly)
      if (filtered.length !== entries.length) {
        log("info", `discovery:connected-only filter ${entries.length} → ${filtered.length}`)
      }
      const result: DiscoveryResult = {
        models: toModelInfos("9router", filtered, config.thinkingOverrides),
        raw: entries,
        ...(connections !== undefined ? { connections } : {}),
      }
      log("info", `discovery:mapped ${result.models.length} models`)
      return result
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (attempt === 1) {
        await log("warn", `discovery failed for ${config.baseURL}: ${message}`)
        return undefined
      }
      await new Promise((resolve) => setTimeout(resolve, 500))
    }
  }
  return undefined
}

/**
 * Enrich one model with `/v1/models/info` when the list entry lacks reasoning
 * info. Used lazily by the picker flow for models without registered variants.
 */
export async function enrichModel(
  config: RouterConfig,
  fullID: string,
): Promise<RouterModel | undefined> {
  try {
    return await fetchModelInfo(config, fullID)
  } catch {
    return undefined
  }
}

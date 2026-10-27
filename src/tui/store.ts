// Reactive usage store for the TUI part: period-scoped stats (fetched) +
// live stats (SSE push), status tracking, and persisted view preferences.

import { createSignal } from "solid-js"
import type { Plugin } from "@opencode/plugin/tui"
import {
  fetchConnections,
  fetchProviderNames,
  fetchStats,
  providerNamesFrom,
  resolveConfig,
  subscribeStats,
  USAGE_PERIODS,
  type RouterConfig,
  type RouterStats,
  type UsagePeriod,
} from "../shared/router.js"
import type { ProviderNames } from "../shared/display.js"
import { PROVIDER_TO_ALIAS } from "../shared/provider-aliases.js"
import { debug } from "./debug.js"
import { loadPluginOptionsFromDisk } from "./config-source.js"

/** Self-identification: the provider id and name this plugin registers as. */
const PROVIDER_ID = "9router"
const DISPLAY_NAME = "9Router"

export type ConnectionStatus = "connecting" | "live" | "offline"

export interface UsageStore {
  /** Period-scoped aggregate (byProvider/total*) as of the last fetch. */
  stats(): RouterStats | undefined
  /** Latest SSE push (activeRequests/recent/errors are always period-independent). */
  live(): RouterStats | undefined
  status(): ConnectionStatus
  period(): UsagePeriod
  setPeriod(period: UsagePeriod): void
  collapsed(): boolean
  toggleCollapsed(): void
  /** Number of models currently registered by the server part (0 = not ready). */
  modelCount(): number
  setModelCount(count: number): void
  /** Dynamically resolved provider display names (id or alias → name). */
  providerName(key: string): string
  /** Stops the SSE subscription and pending fetches. */
  stop(): void
  /** Re-runs the stats fetch and the SSE subscription (manual reconnect). */
  restart(): void
}

interface Preferences {
  period: UsagePeriod
  collapsed: boolean
}

/**
 * The TUI plugin context may not carry configured options (verified: local
 * directory TUI plugins arrive with `options = {}` in v2.0.32 — the
 * host→server→TUI relay drops them and /api/config omits plugins). Fall back
 * to reading the plugin entry from the OpenCode config files on disk.
 */
async function resolveTuiConfig(context: Plugin.Context): Promise<RouterConfig> {
  const direct = (context.options ?? {}) as Record<string, unknown>
  if (Object.keys(direct).length > 0) return resolveConfig(direct)

  const fromDisk = loadPluginOptionsFromDisk()
  if (fromDisk) return resolveConfig(fromDisk)

  try {
    const merged = (await context.client.config.get()) as { plugins?: unknown }
    const plugins = Array.isArray(merged?.plugins) ? merged.plugins : []
    for (const entry of plugins) {
      if (typeof entry !== "object" || entry === null) continue
      const record = entry as Record<string, unknown>
      const target = typeof record.package === "string" ? record.package : ""
      if (!target.endsWith("opencode-9hub")) continue
      const options = (record.options ?? {}) as Record<string, unknown>
      debug(`store:config-fallback matched target=${target} options=${Object.keys(options).join(",") || "none"}`)
      return resolveConfig(options)
    }
  } catch (error) {
    debug(`store:config-fallback failed ${error instanceof Error ? error.message : String(error)}`)
  }
  return resolveConfig({})
}

export async function createUsageStore(context: Plugin.Context): Promise<UsageStore> {
  const config: RouterConfig = await resolveTuiConfig(context)
  const configured = config.baseURL !== ""
  debug(`store:init options=${Object.keys(context.options ?? {}).join(",") || "none"} baseURL=${config.baseURL || "(unconfigured)"} apiKey=${config.apiKey ? "set" : "unset"} overrides=${config.thinkingOverrides.length}`)

  const [status, setStatus] = createSignal<ConnectionStatus>(configured ? "connecting" : "offline")
  const [stats, setStats] = createSignal<RouterStats | undefined>(undefined)
  const [live, setLive] = createSignal<RouterStats | undefined>(undefined)
  const [modelCount, setModelCount] = createSignal(0)
  const [names, setNames] = createSignal<ProviderNames>({})

  // Provider display names resolve dynamically from the router (usage
  // providers + connections); unknown keys pass through as-is. Our own
  // registered provider id is self-identification, not router vocabulary.
  const providerName = (key: string): string =>
    key === PROVIDER_ID ? DISPLAY_NAME : (names() as Record<string, string>)[key] ?? key
  if (configured) {
    void (async () => {
      try {
        const [usageNames, connections] = await Promise.all([
          fetchProviderNames(config).catch(() => ({})),
          fetchConnections(config).catch(() => []),
        ])
        const merged = providerNamesFrom(
          usageNames,
          connections,
          (id) => PROVIDER_TO_ALIAS[id] ?? id,
        )
        debug(`names:resolved ${Object.keys(merged).length} entries`)
        setNames(merged)
      } catch {
        // Names are cosmetic — raw keys are the honest fallback.
      }
    })()
  }

  const [preferences, updatePreferences] = context.storage.store<Preferences>("usage", {
    initial: { period: "7d", collapsed: false },
  })

  const refresh = async (period: UsagePeriod): Promise<void> => {
    if (!configured) return
    try {
      const next = await fetchStats(config, period)
      debug(`stats:fetch ok period=${period} providers=${Object.keys(next.byProvider ?? {}).length}`)
      setStats(next)
      if (status() !== "live") setStatus("live")
    } catch (error) {
      debug(`stats:fetch fail period=${period} ${error instanceof Error ? error.message : String(error)}`)
      // Offline: SSE manages the status signal; keep last good stats.
      if (!live()) setStatus("offline")
    }
  }

  const setPeriod = (period: UsagePeriod): void => {
    if (period === preferences.period) return
    void updatePreferences((draft) => {
      draft.period = period
    })
    void refresh(period)
  }

  const toggleCollapsed = (): void => {
    void updatePreferences((draft) => {
      draft.collapsed = !draft.collapsed
    })
  }

  const createSubscription = () =>
    subscribeStats(config, {
      onStats: (next) => {
        setLive(next)
        setStatus("live")
        // When viewing the lifetime period the stream IS the data source.
        if (preferences.period === "all") setStats(next)
      },
      onStatus: (next) => {
        debug(`sse:status ${next}`)
        setStatus(next)
        if (next === "live" && preferences.period !== "all") void refresh(preferences.period)
      },
    })

  // Initial fetch, then the live SSE stream with reconnect/backoff.
  // An unconfigured plugin never talks to any router.
  let subscription = configured ? createSubscription() : undefined
  void refresh(preferences.period)

  // Store teardown is owned by the plugin setup cleanup.
  return {
    stats,
    live,
    status,
    period: () => preferences.period,
    setPeriod,
    collapsed: () => preferences.collapsed,
    toggleCollapsed,
    modelCount,
    setModelCount,
    providerName,
    stop: () => subscription?.stop(),
    restart: () => {
      debug("store:restart manual reconnect")
      if (!configured) return
      subscription?.stop()
      subscription = createSubscription()
      void refresh(preferences.period)
    },
  }
}

export { USAGE_PERIODS }

// OpenCode V2 server part — registers the `9router` provider with discovered
// models and per-model thinking variants, then keeps the inventory fresh.
//
// The transforms are synchronous and replayable: discovery data is captured in
// a closure before registration, following the proven plugin pattern.

import { Plugin, Provider } from "@opencode/plugin"
import { appendFileSync } from "node:fs"
import { resolveConfig, type RouterConfig, type RouterConnection, type RouterModel } from "./shared/router.js"
import { discoverInventory, filterConnected, toModelInfos } from "./server/register.js"

/** Durable storage key for the last discovered inventory. */
const INVENTORY_KEY = "9hub:inventory"

interface CachedInventory {
  savedAt: number
  baseURL: string
  raw: RouterModel[]
  /** Last known connections list — re-applies the connected-only filter on boot. */
  connections?: RouterConnection[]
}

/** JSON-compatible view of CachedInventory for the storage domain. */
type CachedInventoryJson = CachedInventory & Record<string, unknown>

/** How often the inventory is refreshed (ms). */
export const REFRESH_INTERVAL = 60_000

/** Bounded retries for config providers registered after external plugin setup. */
const RETRY_DELAYS = [0, 100, 500, 1500, 5000] as const

const PROVIDER_ID = "9router"
const DISPLAY_NAME = "9Router"
const OPENAI_COMPATIBLE = "@opencode/ai/providers/openai-compatible"

/** Optional file sink for diagnostics: OPENCODE_9HUB_DEBUG=<path>. */
const debugFile = process.env.OPENCODE_9HUB_DEBUG
const debug = (line: string): void => {
  if (!debugFile) return
  try {
    appendFileSync(debugFile, `${new Date().toISOString()} ${line}\n`)
  } catch {
    // Diagnostics are best-effort.
  }
}

interface CapturedProvider {
  info: Provider.Info
  models: ReturnType<typeof toModelInfos>
}

/** Secret-free fingerprint deciding whether a provider reload is needed. */
function fingerprint(providers: readonly CapturedProvider[]): string {
  return providers
    .map((provider) => {
      const settings = provider.info.settings as Record<string, unknown> | undefined
      return [
        provider.info.id,
        provider.info.name,
        typeof settings?.baseURL === "string" ? settings.baseURL : "",
        provider.models.map((model) => `${model.id}#${model.info.variants.length}`).sort().join(","),
      ].join(":")
    })
    .sort()
    .join("|")
}

function buildProviderInfo(config: RouterConfig): Provider.Info {
  // Contract: the plugin REGISTERS the provider (baseURL + apiKey) and steps
  // out of the way. OpenCode's own openai-compatible package makes every chat
  // request directly — the plugin never proxies, intercepts, times out, or
  // closes anything on the AI path. Plugin timeouts apply only to its own
  // background catalog/usage fetches, which fail open.
  return {
    ...Provider.Info.empty(Provider.ID.make(PROVIDER_ID)),
    name: DISPLAY_NAME,
    activation: "enabled",
    package: OPENAI_COMPATIBLE,
    settings: {
      baseURL: `${config.baseURL}/v1`,
      ...(config.apiKey ? { apiKey: config.apiKey } : {}),
    },
  }
}

export default Plugin.define({
  id: "9hub",
  async setup(ctx) {
    const log = (level: "info" | "warn" | "error", message: string) => {
      const line = `[9hub] ${message}`
      debug(line)
      if (level === "error") console.error(line)
      else if (level === "warn") console.warn(line)
      else console.log(line)
    }

    const config = resolveConfig(ctx.options as Record<string, unknown>)

    // Respect exactly what was configured — no local-install assumptions.
    // Without a baseURL there is nothing to register or discover.
    if (config.baseURL === "") {
      log(
        "warn",
        "no baseURL configured — set options.baseURL (or OPENCODE_9ROUTER_URL); skipping 9router registration",
      )
      return
    }

    let captured: CapturedProvider | undefined = {
      info: buildProviderInfo(config),
      models: [],
    }

    // Durable cache: register the last known inventory immediately so models
    // are available on boot (the first-ever boot discovers in background).
    try {
      const cached = (await ctx.storage.get(INVENTORY_KEY)) as CachedInventory | undefined
      if (
        cached &&
        cached.baseURL === config.baseURL &&
        Array.isArray(cached.raw) &&
        cached.raw.length > 0
      ) {
        // Boot-time filter uses the cached connections list; the background
        // refresh re-fetches it and reloads when the filtered set changes.
        const boot = filterConnected(cached.raw, cached.connections, config.connectedOnly)
        captured = { info: buildProviderInfo(config), models: toModelInfos(PROVIDER_ID, boot, config.thinkingOverrides) }
        log("info", `loaded ${boot.length} models from cache (${cached.baseURL}${boot.length !== cached.raw.length ? `, filtered from ${cached.raw.length}` : ""})`)
      }
    } catch (error) {
      log("warn", `cache load failed: ${error instanceof Error ? error.message : String(error)}`)
    }

    const refresh = async (): Promise<void> => {
      if (disposed) return
      debug("refresh:start")
      const before = fingerprint([captured!])
      const inventory = await discoverInventory(config, log)
      if (!inventory || disposed) return // unreachable or shutting down: keep last good inventory
      const changed = fingerprint([{ info: buildProviderInfo(config), models: inventory.models }]) !== before
      captured = { info: buildProviderInfo(config), models: inventory.models }
      debug(`refresh:discovered changed=${changed}`)
      if (!changed) return
      // Only reload on real changes: provider.reload fires `provider.updated`,
      // which this plugin subscribes to — reloading unconditionally would loop.
      try {
        const payload: CachedInventory = {
          savedAt: Date.now(),
          baseURL: config.baseURL,
          raw: inventory.raw,
          ...(inventory.connections !== undefined ? { connections: inventory.connections } : {}),
        }
        await ctx.storage.set(INVENTORY_KEY, JSON.parse(JSON.stringify(payload)))
      } catch (error) {
        log("warn", `cache write failed: ${error instanceof Error ? error.message : String(error)}`)
      }
      await ctx.provider.reload()
      await ctx.model.reload()
      log("info", `registered ${inventory.models.length} models from ${config.baseURL}`)
    }
    log("info", `setup: baseURL=${config.baseURL} apiKey=${config.apiKey ? "set" : "unset"} timeout=${config.timeoutMs}ms`)

    // Register the transforms immediately — setup must not block on network
    // (plugin activation has a timeout). Discovery runs in the background via
    // the refresh loop; the replayed transforms pick up models on reload.
    // Transform errors must never break model loading — log and continue.
    await ctx.provider.transform((editor) => {
      try {
        const snapshot = captured
        if (!snapshot) return
        if (editor.get(PROVIDER_ID)) {
          editor.update(PROVIDER_ID, (info) => {
            info.package = OPENAI_COMPATIBLE
            info.activation = "enabled"
            info.settings = {
              ...(info.settings ?? {}),
              ...snapshot.info.settings,
            }
          })
          editor.models.set(PROVIDER_ID, snapshot.models.map((model) => model.info))
        } else {
          editor.add({
            info: snapshot.info,
            models: snapshot.models.map((model) => model.info),
          })
        }
        debug(`provider transform applied: ${snapshot.models.length} models`)
      } catch (error) {
        log("error", `provider transform failed: ${error instanceof Error ? error.message : String(error)}`)
      }
    })

    await ctx.model.transform((editor) => {
      try {
        const present = new Set(
          (editor.provider.list() as ReadonlyArray<{ id?: string }>)
            .map((provider) => provider.id)
            .filter((id): id is string => typeof id === "string"),
        )
        if (!captured || !present.has(PROVIDER_ID)) return
        for (const model of captured.models) {
          editor.update(PROVIDER_ID, model.id, (draft) => {
            Object.assign(draft, model.info)
          })
        }
      } catch (error) {
        log("error", `model transform failed: ${error instanceof Error ? error.message : String(error)}`)
      }
    })

    // Coalesced refresh: one discovery at a time, trailing requests queued.
    let disposed = false
    let running = false
    let pending = false

    const scheduleRefresh = (): void => {
      if (disposed) return
      pending = true
      if (running) return
      running = true
      void (async () => {
        try {
          while (pending && !disposed) {
            pending = false
            await refresh()
          }
        } catch (error) {
          log("error", `refresh failed: ${error instanceof Error ? error.message : String(error)}`)
        } finally {
          running = false
        }
        if (pending && !disposed) scheduleRefresh()
      })()
    }

    const eventAbort = new AbortController()
    const eventTask = (async () => {
      try {
        for await (const event of ctx.event.subscribe({ signal: eventAbort.signal })) {
          if (event.type === "provider.updated") scheduleRefresh()
        }
      } catch {
        // Subscription ended (shutdown or abort) — not an error.
      }
    })()

    const retryTimers = RETRY_DELAYS.map((delay) => setTimeout(scheduleRefresh, delay))
    const timer = setInterval(scheduleRefresh, REFRESH_INTERVAL)

    return async () => {
      disposed = true
      for (const retry of retryTimers) clearTimeout(retry)
      clearInterval(timer)
      eventAbort.abort()
      await eventTask
    }
  },
})

// 9Router HTTP client shared by the server and TUI parts.
//
// Auth model — public surface only, no credentials read from disk or config:
//   - LLM API (/v1/*): Bearer API key (the same key every OpenAI-style client uses).
//   - Dashboard API (/api/*): used only when the router itself serves it
//     unauthenticated (local installs with login disabled). Guarded routers
//     401 → every caller fails open (full model list, session-usage fallback).
//     No ~/.9router file reads, no pasted session JWTs — undocumented coupling
//     is not an integration path.

import { appendFileSync } from "node:fs"

import { overridesFrom, type ModelLevelOverride } from "./levels.js"

/** Optional file sink for diagnostics (both parts): OPENCODE_9HUB_DEBUG=<path>. */
const debugFile = process.env.OPENCODE_9HUB_DEBUG
const debug = (line: string): void => {
  if (!debugFile) return
  try {
    appendFileSync(debugFile, `${new Date().toISOString()} [shared] ${line}\n`)
  } catch {
    // Diagnostics are best-effort.
  }
}

// ── Types ───────────────────────────────────────────────────

/** 9Router connection settings resolved from plugin options + environment. */
export interface RouterConfig {
  /** Router base URL (no `/v1` suffix). Empty string = unconfigured: skip all calls. */
  baseURL: string
  apiKey?: string
  timeoutMs: number
  /** Opt-in per-model level corrections (plugin options `thinkingOverrides`). */
  thinkingOverrides: ModelLevelOverride[]
  /**
   * Filter the model inventory to providers with active connections.
   * "auto" (default): filter whenever the connections list is reachable
   * (local routers, where the CLI token derives from ~/.9router/); fail open
   * otherwise. true/false force intent on/off.
   */
  connectedOnly: "auto" | boolean
  /**
   * Optional dashboard password — the official remote flow (`9router connect`):
   * POST /api/auth/login → session cookie → read-only /api/providers + usage.
   * Enables the connected-providers filter and router-wide usage on hosted
   * routers. Absent: nothing changes (fail-open).
   */
  password?: string
}
/** Token usage aggregates, 9Router `/api/usage/stats` shape. */
export interface ProviderUsage {
  requests: number
  promptTokens: number
  completionTokens: number
  cachedTokens: number
  cost: number
}

export interface ActiveRequest {
  model: string
  provider: string
  account: string
  count: number
}

export interface RouterStats {
  totalRequests: number
  totalPromptTokens: number
  totalCompletionTokens: number
  totalCachedTokens: number
  totalCost: number
  byProvider: Record<string, ProviderUsage>
  byModel: Record<
    string,
    ProviderUsage & { rawModel?: string; provider?: string; lastUsed?: string }
  >
  byAccount: Record<string, ProviderUsage & { rawModel?: string; provider?: string; accountName?: string }>
  activeRequests: ActiveRequest[]
  errorProvider?: string
}

/** Entry of `GET /v1/models` (subset we consume). */
export interface RouterModel {
  id: string
  owned_by?: string
  name?: string
  kind?: string
  capabilities?: RouterCapabilities
  context_length?: number
  max_completion_tokens?: number
}

/** Capability block emitted by `/v1/models` and `/v1/models/info`. */
export interface RouterCapabilities {
  vision?: boolean
  pdf?: boolean
  audioInput?: boolean
  videoInput?: boolean
  imageOutput?: boolean
  audioOutput?: boolean
  search?: boolean
  tools?: boolean
  reasoning?: boolean
  thinkingFormat?: string | null
  thinkingCanDisable?: boolean
  thinkingRange?: { min?: number; max?: number } | null
  thinkingEffortSupported?: boolean
  /** Fully-resolved level list when a future 9Router publishes it. */
  thinkingLevels?: readonly string[]
  contextWindow?: number
  maxOutput?: number
}

export type UsagePeriod = "today" | "24h" | "7d" | "30d" | "60d" | "all"

export const USAGE_PERIODS: readonly UsagePeriod[] = ["today", "24h", "7d", "30d", "60d", "all"]

// ── Config resolution ───────────────────────────────────────

/** Strip trailing slashes and a trailing `/v1` — dashboard APIs live at the root. */
export function normalizeBaseURL(url: string): string {
  return url.replace(/\/+$/, "").replace(/\/v1$/, "")
}

/** Coerce an unknown option value into a usable string. */
function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined
}

/** Coerce an unknown option value into a positive number. */
function asPositiveNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined
}

/**
 * Resolve the 9Router connection from plugin options (falling back to env).
 * No local-install assumptions: when neither options nor env provide a
 * baseURL, the plugin runs unconfigured (nothing is guessed, no localhost
 * fallback) and every router call is skipped.
 */
export function resolveConfig(options: Record<string, unknown> = {}): RouterConfig {
  const raw = asString(options.baseURL) ?? asString(process.env.OPENCODE_9ROUTER_URL) ?? ""
  const baseURL = raw ? normalizeBaseURL(raw) : ""
  const apiKey = asString(options.apiKey) ?? asString(process.env.OPENCODE_9ROUTER_API_KEY)
  // `/v1/models` triggers live catalog fetches per provider upstream and can be
  // slow on remote instances — mirror 9Router's own 30s discovery timeout.
  const timeoutMs = asPositiveNumber(options.timeoutMs) ?? 30_000
  const connectedOnly =
    options.connectedOnly === true || options.connectedOnly === false
      ? options.connectedOnly
      : "auto"
  const password =
    asString(options.password) ??
    asString(process.env.OPENCODE_9ROUTER_PASSWORD) ??
    asString(process.env.NINE_ROUTER_PASSWORD)
  return {
    baseURL,
    apiKey,
    timeoutMs,
    thinkingOverrides: overridesFrom(options.thinkingOverrides),
    connectedOnly,
    ...(password ? { password } : {}),
  }
}

// ── Fetch helpers ───────────────────────────────────────────

function headers(config: RouterConfig, extra?: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = { accept: "application/json", ...extra }
  if (config.apiKey) out["authorization"] = `Bearer ${config.apiKey}`
  return out
}

// ── Dashboard session (optional, official `9router connect` flow) ─────────
//
// When the user configures a dashboard password, the plugin logs in exactly
// like the official CLI does remotely (cli/src/cli/commands/connect.js):
// POST /api/auth/login {password} → auth_token session cookie → read-only
// /api/* (providers + usage). The cookie lives in memory only, is bound to
// one baseURL, never logged, and is refreshed once on 401 before failing.

let sessionCookie: string | undefined
let sessionBaseURL: string | undefined

function currentCookie(config: RouterConfig): string | undefined {
  return sessionBaseURL === config.baseURL ? sessionCookie : undefined
}

async function login(config: RouterConfig): Promise<void> {
  const response = await fetch(`${config.baseURL}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ password: config.password }),
    signal: AbortSignal.timeout(config.timeoutMs),
  })
  if (!response.ok) {
    throw new RouterError(
      `dashboard login failed: ${response.status} (check the password option)`,
      response.status,
    )
  }
  const setCookie =
    typeof response.headers.getSetCookie === "function"
      ? response.headers.getSetCookie()
      : [response.headers.get("set-cookie") ?? ""]
  for (const entry of setCookie) {
    const match = /(?:^|,\s*)auth_token=([^;]+)/.exec(entry)
    if (match) {
      sessionCookie = `auth_token=${match[1]}`
      sessionBaseURL = config.baseURL
      return
    }
  }
  throw new RouterError("dashboard login succeeded but no session cookie was returned")
}

/** Attach the session cookie to dashboard-API requests (never to other hosts). */
function withSession(config: RouterConfig, h: Record<string, string>): Record<string, string> {
  const cookie = currentCookie(config)
  return cookie ? { ...h, cookie } : h
}

export class RouterError extends Error {
  readonly status?: number
  constructor(message: string, status?: number) {
    super(message)
    this.name = "RouterError"
    this.status = status
  }
}

/** GET a JSON endpoint of the 9Router host. Throws RouterError on failure. */
export async function getJSON<T>(
  config: RouterConfig,
  pathname: string,
  signal?: AbortSignal,
): Promise<T> {
  const fetchOnce = (): Promise<Response> =>
    fetch(`${config.baseURL}${pathname}`, {
      headers: withSession(config, headers(config)),
      signal: signal ?? AbortSignal.timeout(config.timeoutMs),
    })

  let response = await fetchOnce()
  // Session expired (or never established) on a dashboard endpoint: the
  // official flow is one re-login and a single retry. A login failure
  // surfaces as a normal error — callers fail open.
  if (response.status === 401 && config.password && pathname.startsWith("/api/")) {
    await login(config)
    response = await fetchOnce()
  }
  if (!response.ok) {
    throw new RouterError(`${pathname} failed: ${response.status} ${response.statusText}`, response.status)
  }
  return (await response.json()) as T
}

/** POST a JSON endpoint of the 9Router host. */
export async function postJSON<T>(
  config: RouterConfig,
  pathname: string,
  body: unknown,
  signal?: AbortSignal,
): Promise<T> {
  const response = await fetch(`${config.baseURL}${pathname}`, {
    method: "POST",
    headers: headers(config, { "content-type": "application/json" }),
    body: JSON.stringify(body),
    signal: signal ?? AbortSignal.timeout(config.timeoutMs),
  })
  if (!response.ok) {
    throw new RouterError(`${pathname} failed: ${response.status} ${response.statusText}`, response.status)
  }
  return (await response.json().catch(() => undefined)) as T
}

// ── API wrappers ────────────────────────────────────────────

/** `GET /api/usage/stats?period=…` — aggregate usage for a period. */
export async function fetchStats(
  config: RouterConfig,
  period: UsagePeriod,
  signal?: AbortSignal,
): Promise<RouterStats> {
  return getJSON<RouterStats>(config, `/api/usage/stats?period=${encodeURIComponent(period)}`, signal)
}

/** `GET /v1/models` — routed model inventory. */
export async function fetchModels(config: RouterConfig, signal?: AbortSignal): Promise<RouterModel[]> {
  const data = await getJSON<{ data?: RouterModel[] }>(config, "/v1/models", signal)
  return Array.isArray(data?.data) ? data.data : []
}

/** `GET /v1/models/info?id=…` — one model's detailed capabilities. */
export async function fetchModelInfo(
  config: RouterConfig,
  modelID: string,
  signal?: AbortSignal,
): Promise<RouterModel | undefined> {
  return getJSON<RouterModel>(config, `/v1/models/info?id=${encodeURIComponent(modelID)}`, signal)
}

/** One entry of `GET /api/providers` (credentials redacted upstream). */
export interface RouterConnection {
  id?: string
  provider?: string
  name?: string
  authType?: string
  isActive?: boolean
  priority?: number
  providerSpecificData?: { prefix?: string; enabledModels?: string[]; [key: string]: unknown }
  [key: string]: unknown
}

/** `GET /api/providers` — the router's configured provider connections. */
export async function fetchConnections(
  config: RouterConfig,
  signal?: AbortSignal,
): Promise<RouterConnection[]> {
  const data = await getJSON<{ connections?: RouterConnection[] }>(config, "/api/providers", signal)
  return Array.isArray(data?.connections) ? data.connections : []
}

/**
 * `POST /api/providers` — connect an API-key / free-tier / compatible provider.
 * OAuth-based providers must be connected through the 9Router dashboard.
 */
export async function addProvider(
  config: RouterConfig,
  input: { provider: string; apiKey?: string; name?: string; defaultModel?: string },
): Promise<void> {
  await postJSON(config, "/api/providers", input)
}

// ── SSE usage stream ────────────────────────────────────────

export interface StatsSubscription {
  stop(): void
}

/**
 * Subscribe to `GET /api/usage/stream` (SSE). Calls `onStats` with every pushed
 * stats payload and `onStatus` on lifecycle changes. Reconnects with capped
 * backoff until `stop()` is called.
 */
export function subscribeStats(
  config: RouterConfig,
  handlers: {
    onStats: (stats: RouterStats) => void
    onStatus?: (status: "connecting" | "live" | "offline") => void
  },
): StatsSubscription {
  let disposed = false
  let controller: AbortController | undefined
  let attempt = 0
  let retryTimer: ReturnType<typeof setTimeout> | undefined

  const backoff = () => Math.min(30000, 1000 * 2 ** attempt++)

  const connect = async (): Promise<void> => {
    if (disposed) return
    handlers.onStatus?.("connecting")
    controller = new AbortController()
    try {
      const response = await fetch(`${config.baseURL}/api/usage/stream`, {
        headers: withSession(config, headers(config, { accept: "text/event-stream" })),
        signal: controller.signal,
      })
      if (!response.ok || !response.body) {
        throw new RouterError(`stream failed: ${response.status}`, response.status)
      }
      attempt = 0
      handlers.onStatus?.("live")

      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ""

      // Read until the server closes, we are stopped, or the fetch aborts.
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        let boundary: number
        while ((boundary = buffer.indexOf("\n\n")) !== -1) {
          const chunk = buffer.slice(0, boundary)
          buffer = buffer.slice(boundary + 2)
          for (const line of chunk.split("\n")) {
            if (!line.startsWith("data:")) continue
            const payload = line.slice(5).trim()
            if (payload.length === 0) continue
            try {
              handlers.onStats(JSON.parse(payload) as RouterStats)
            } catch {
              // Malformed frame — skip it; the next full push will correct state.
            }
          }
        }
      }
    } catch (error) {
      if (disposed || (error instanceof Error && error.name === "AbortError")) return
      // Dashboard-guarded routers (hosted) always answer 401/403 — retrying
      // would pin the UI in "connecting" and hide the session fallback.
      // With a configured password, one re-login then a retry keeps the
      // stream alive across session expiry; a rejected login latches offline.
      if (error instanceof RouterError && (error.status === 401 || error.status === 403)) {
        if (config.password) {
          try {
            await login(config)
          } catch (loginError) {
            debug(`stream: login failed ${loginError instanceof Error ? loginError.message : String(loginError)}`)
            handlers.onStatus?.("offline")
            return
          }
        } else {
          handlers.onStatus?.("offline")
          return
        }
      }
    }

    if (!disposed) {
      handlers.onStatus?.("offline")
      retryTimer = setTimeout(() => void connect(), backoff())
    }
  }

  void connect()

  return {
    stop() {
      disposed = true
      if (retryTimer) clearTimeout(retryTimer)
      controller?.abort()
    },
  }
}

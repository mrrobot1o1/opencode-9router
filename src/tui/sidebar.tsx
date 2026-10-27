/** @jsxImportSource @opentui/solid */
// "9Router Usage" section for the session sidebar (the panel that already
// shows the Context bar). Renders per-provider usage rows with share bars,
// totals, active requests, and a period toggle — fed by the usage store.

import { ErrorBoundary, For, Show, createMemo } from "solid-js"
import type { Plugin } from "@opencode/plugin/tui"
import type { ProviderUsage, RouterStats } from "../shared/router.js"
import { formatCost, formatTokens, shareBar } from "../shared/display.js"
import { debug } from "./debug.js"
import type { UsageStore } from "./store"

const BAR_WIDTH = 8
const MAX_ROWS = 6
const NAME_WIDTH = 12

interface ProviderRow {
  id: string
  name: string
  usage: ProviderUsage
  bar: string
}

/** Build ordered, share-annotated provider rows from a stats payload. */
type NameOf = (key: string) => string

function providerRows(stats: RouterStats, nameOf: NameOf): ProviderRow[] {
  const entries = Object.entries(stats.byProvider ?? {})
    .map(([id, usage]) => ({ id, usage }))
    .filter((entry) => entry.usage && entry.usage.requests > 0)
    .sort((a, b) => b.usage.cost - a.usage.cost || b.usage.completionTokens - a.usage.completionTokens)
    .slice(0, MAX_ROWS)

  const maxCost = Math.max(...entries.map((entry) => entry.usage.cost), 0)
  if (maxCost > 0) {
    return entries.map((entry) => ({
      ...entry,
      name: nameOf(entry.id),
      bar: shareBar(entry.usage.cost / maxCost, BAR_WIDTH),
    }))
  }
  // Free-lane traffic: all costs $0 — share by completion tokens instead.
  const maxTokens = Math.max(...entries.map((entry) => entry.usage.completionTokens), 0)
  return entries.map((entry) => ({
    ...entry,
    name: nameOf(entry.id),
    bar: shareBar(maxTokens > 0 ? entry.usage.completionTokens / maxTokens : 0, BAR_WIDTH),
  }))
}

/**
 * Fallback source for remote/unauthenticated routers: aggregate the current
 * session's assistant messages — **9router models only**, keyed by their
 * router alias (kr, inf, oc…). The user's other/custom providers are never
 * counted or displayed here: the bar is 9Router usage, nothing else.
 */
function sessionRows(context: Plugin.Context, sessionID: string, nameOf: NameOf): ProviderRow[] {
  const messages = context.data.session.message.list(sessionID) ?? []
  const byProvider = new Map<string, ProviderUsage>()
  for (const message of messages) {
    if (message.type !== "assistant") continue
    if (message.model?.providerID !== "9router") continue
    const tokens = message.tokens
    const modelID = typeof message.model?.id === "string" ? message.model.id : ""
    const slash = modelID.indexOf("/")
    const provider = slash > 0 ? modelID.slice(0, slash) : "9router"
    const entry: ProviderUsage = byProvider.get(provider) ?? {
      requests: 0,
      promptTokens: 0,
      completionTokens: 0,
      cachedTokens: 0,
      cost: 0,
    }
    entry.requests += 1
    entry.promptTokens += tokens?.input ?? 0
    entry.completionTokens += (tokens?.output ?? 0) + (tokens?.reasoning ?? 0)
    entry.cachedTokens += (tokens?.cache?.read ?? 0) + (tokens?.cache?.write ?? 0)
    entry.cost += message.cost ?? 0
    byProvider.set(provider, entry)
  }
  const entries = Array.from(byProvider.entries())
    .sort((a, b) => b[1].cost - a[1].cost || b[1].completionTokens - a[1].completionTokens)
    .slice(0, MAX_ROWS)
  debug(`sidebar:sessionRows session=${sessionID.slice(-8)} messages=${messages.length} routerRows=${entries.length}`)
  const totalCost = entries.reduce((sum, [, usage]) => sum + usage.cost, 0)
  const maxCost = Math.max(totalCost, 0)
  const maxTokens = Math.max(...entries.map(([, usage]) => usage.completionTokens), 0)
  return entries.map(([id, usage]) => ({
    id,
    name: nameOf(id),
    usage,
    bar: shareBar(maxCost > 0 ? usage.cost / maxCost : maxTokens > 0 ? usage.completionTokens / maxTokens : 0, BAR_WIDTH),
  }))
}

function padName(name: string): string {
  return name.length >= NAME_WIDTH ? `${name.slice(0, NAME_WIDTH - 1)}…` : name.padEnd(NAME_WIDTH, " ")
}

export function SidebarUsage(props: { context: Plugin.Context; store: UsageStore; sessionID: string }) {
  const theme = props.context.theme
  const status = createMemo(() => props.store.status())
  const stats = createMemo(() => props.store.stats())
  const live = createMemo(() => props.store.live())
  debug(`sidebar:mount session=${props.sessionID.slice(-8)}`)

  // Router stats when available; otherwise always show the current session's
  // own usage — even while still connecting. A pending connection must never
  // blank the section.
  const nameOf = (key: string): string => props.store.providerName(key)
  const rows = createMemo<ProviderRow[]>(() => {
    const current = stats()
    if (current) return providerRows(current, nameOf)
    const fallbackRows = sessionRows(props.context, props.sessionID, nameOf)
    debug(`sidebar:rows fallback status=${status()} rows=${fallbackRows.length} session=${props.sessionID.slice(-8)}`)
    return fallbackRows
  })
  const totals = createMemo<string | undefined>(() => {
    const current = stats()
    if (current) return formatTotals(current)
    return formatSessionTotals(props.context, props.sessionID)
  })
  const fallback = createMemo(() => !stats())
  const hidden = createMemo(() => {
    const current = stats()
    if (!current) return 0
    const total = Object.values(current.byProvider ?? {}).filter((usage) => usage && usage.requests > 0).length
    return Math.max(0, total - MAX_ROWS)
  })
  const running = createMemo(() =>
    (live()?.activeRequests ?? []).reduce((sum, request) => sum + (request.count ?? 0), 0),
  )
  const errorProvider = createMemo(() => {
    const current = live()
    return current?.errorProvider ? props.store.providerName(current.errorProvider) : undefined
  })

  // Crash signal: a render error would otherwise collapse the section
  // silently (the host boundary only fires one toast). Surface it inline.
  const crash = (error: unknown, reset: () => void) => {
    debug(`sidebar:crash ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`)
    return (
      <box>
        <text fg={theme.text.feedback.error.base} wrapMode="none">
          9Router Usage crashed — {error instanceof Error ? error.message : String(error)} (click to reset)
        </text>
      </box>
    )
  }

  return (
    <Show when={rows().length > 0 || status() !== "offline" || !props.store.configured()}>
      <ErrorBoundary fallback={crash}>
      <box>
        <box onMouseUp={() => props.store.toggleCollapsed()} flexShrink={0}>
          <text fg={theme.text.base}>
            <b>9Router Usage</b>
            <span style={{ fg: theme.text.faint }}>
              {"  "}
              {status() === "live" ? "●" : "○"}
              {status() === "offline" ? " session" : ""}
            </span>
          </text>
        </box>
        <Show when={!props.store.configured()}>
          <text fg={theme.text.muted} wrapMode="none">
            not configured — edit ~/.config/opencode/opencode.jsonc:
          </text>
          <text fg={theme.text.muted} wrapMode="none">
            options.baseURL + apiKey (password optional)
          </text>
        </Show>
        <Show when={props.store.configured()}>
        <Show when={!props.store.collapsed()}>
          <text fg={theme.text.muted} wrapMode="none">
            {fallback() ? "this session" : periodLabel(props.store.period())} ·{" "}
            {totals() ?? (status() === "connecting" ? "connecting…" : "no data yet")}
          </text>
          <For each={rows()}>
            {(row) => (
              <text wrapMode="none">
                <span style={{ fg: theme.text.muted }}>{padName(row.name)}</span>
                <span style={{ fg: categorical(props.context, row.id) }}>{row.bar}</span>
                <span style={{ fg: theme.text.muted }}>
                  {" "}
                  {tokensOf(row.usage)} {costOf(row.usage)}
                </span>
              </text>
            )}
          </For>
          <Show when={hidden() > 0}>
            <text fg={theme.text.faint} wrapMode="none">
              +{hidden()} more in /9hub
            </text>
          </Show>
          <Show when={running() > 0}>
            <text fg={theme.text.feedback.success.base} wrapMode="none">
              ● {running()} running
            </text>
          </Show>
          <Show when={errorProvider()}>
            {(name) => <text fg={theme.text.feedback.error.base}>! {name()} erroring</text>}
          </Show>
        </Show>
        <Show when={props.store.collapsed()}>
          <text fg={theme.text.muted} wrapMode="none">
            {totals() ?? "no data yet"}
          </text>
        </Show>
        </Show>
      </box>
      </ErrorBoundary>
    </Show>
  )
}

// ── Formatting ──────────────────────────────────────────────

function periodLabel(period: string): string {
  switch (period) {
    case "today":
      return "today"
    case "24h":
      return "24h"
    case "7d":
      return "7d"
    case "30d":
      return "30d"
    case "60d":
      return "60d"
    case "all":
      return "all time"
    default:
      return period
  }
}

function formatTotals(stats: RouterStats | undefined): string {
  if (!stats) return "no data yet"
  const tokens = stats.totalPromptTokens + stats.totalCompletionTokens
  const parts = [formatCost(stats.totalCost), `${stats.totalRequests} req`]
  if (stats.totalCachedTokens > 0) parts.push(`${formatTokens(stats.totalCachedTokens)} cached`)
  return `${parts.join(" · ")} · ${formatTokens(tokens)} tok`
}

/** Session-fallback totals: 9router models only — same scope as the rows. */
function formatSessionTotals(context: Plugin.Context, sessionID: string): string {
  const messages = context.data.session.message.list(sessionID) ?? []
  let requests = 0
  let tokens = 0
  let cost = 0
  let cached = 0
  for (const message of messages) {
    if (message.type !== "assistant") continue
    if (message.model?.providerID !== "9router") continue
    requests += 1
    tokens += (message.tokens?.input ?? 0) + (message.tokens?.output ?? 0) + (message.tokens?.reasoning ?? 0)
    cached += (message.tokens?.cache?.read ?? 0) + (message.tokens?.cache?.write ?? 0)
    cost += message.cost ?? 0
  }
  if (requests === 0) return "no usage yet"
  const parts = [formatCost(cost), `${requests} req` as const]
  if (cached > 0) parts.push(`${formatTokens(cached)} cached` as const)
  return `${parts.join(" · ")} · ${formatTokens(tokens)} tok`
}

function tokensOf(usage: ProviderUsage): string {
  const tokens = usage.promptTokens + usage.completionTokens
  return `${formatTokens(tokens)} tok`
}

function costOf(usage: ProviderUsage): string {
  return formatCost(usage.cost)
}

/** Stable categorical color per provider id (hash → palette index). */
function categorical(context: Plugin.Context, id: string) {
  const palette = context.theme.categorical
  let hash = 0
  for (let index = 0; index < id.length; index++) hash = (hash * 31 + id.charCodeAt(index)) >>> 0
  const scale = palette[hash % palette.length]
  return scale?.base ?? context.theme.text.muted
}

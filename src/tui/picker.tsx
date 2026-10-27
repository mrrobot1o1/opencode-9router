/** @jsxImportSource @opentui/solid */
// Model picker for the TUI part: browse every registered 9Router model with
// usage annotations, then pick a thinking level from the levels THAT model
// actually serves (registered variants — guaranteed valid end-to-end), and
// switch the current session's model live via the server API.

import type { Plugin } from "@opencode/plugin/tui"
import { levelLabel, splitModelID, stripThinkingSuffix } from "../shared/levels.js"
import { formatCost, formatTokens } from "../shared/display.js"
import type { UsageStore } from "./store"

interface UsageEntry {
  tokens: string
  cost: string
  requests: number
}

/**
 * Usage lookup keyed by `provider:rawModel` (lowercased), where provider is
 * the display name 9Router itself reports in `stats.byModel`
 * (`"raw (provider)"` keys). The picker derives the same display name from the
 * model's alias, so both sides meet on a canonical key.
 */
function usageLookup(store: UsageStore): Map<string, UsageEntry> {
  const entries = new Map<string, UsageEntry>()
  const stats = store.stats()
  if (!stats) return entries

  for (const [key, usage] of Object.entries(stats.byModel ?? {})) {
    if (!usage) continue
    const match = key.match(/^(.*) \((.*)\)$/)
    const raw = usage.rawModel ?? (match ? match[1]! : key)
    const provider = usage.provider ?? (match ? match[2]! : "")
    const canonical = `${store.providerName(provider)}:${raw}`.toLowerCase()
    if (!entries.has(canonical)) {
      entries.set(canonical, {
        tokens: formatTokens(usage.promptTokens + usage.completionTokens),
        cost: formatCost(usage.cost),
        requests: usage.requests,
      })
    }
  }
  return entries
}

function annotate(
  model: { id: string; variants?: ReadonlyArray<{ id: string }> },
  lookup: Map<string, UsageEntry>,
  providerName: (key: string) => string,
): string | undefined {
  const { alias, model: raw } = splitModelID(stripThinkingSuffix(model.id))
  const usage = lookup.get(`${providerName(alias)}:${raw}`.toLowerCase())
  const parts: string[] = []
  if (usage) parts.push(`${usage.tokens} tok`, usage.cost, `${usage.requests} req`)
  const levels = (model.variants ?? []).map((variant) => String(variant.id))
  if (levels.length > 0) parts.push(`thinking: ${levels.join("/")}`)
  return parts.length > 0 ? parts.join(" · ") : undefined
}

function currentSessionID(context: Plugin.Context): string | undefined {
  const route = context.ui.router.current()
  return route.type === "session" ? route.sessionID : undefined
}

function currentKey(context: Plugin.Context): string | undefined {
  const current = context.ui.model.current()
  if (!current) return undefined
  return `${current.providerID}/${current.modelID}`
}

export async function openModelPicker(context: Plugin.Context, store: UsageStore): Promise<void> {
  const location = context.location ?? context.data.location.default()
  const models = (context.data.location.model.list(location) ?? []).filter(
    (model) => model.providerID === "9router",
  )

  if (models.length === 0) {
    context.ui.toast.show({
      title: "9Router",
      message: "No 9router models registered yet — is the router running?",
      variant: "warning",
      duration: 4000,
    })
    return
  }

  store.setModelCount(models.length)
  const lookup = usageLookup(store)
  const active = currentKey(context)

  const options = models.map((model) => ({
    model,
    value: `${model.providerID}/${model.id}`,
    title: model.name ?? model.id,
    description: annotate(model, lookup, (key) => store.providerName(key)),
    category: store.providerName(model.id.includes("/") ? model.id.slice(0, model.id.indexOf("/")) : ""),
    footer: `${model.providerID}/${model.id}` === active ? "current" : undefined,
  }))
  options.sort((a, b) => a.category.localeCompare(b.category) || a.title.localeCompare(b.title))

  const chosen = await context.ui.dialog.select({
    title: "9Router · Models",
    current: active,
    options,
    search: (query, candidates) =>
      query.trim().length === 0
        ? candidates
        : candidates.filter(
            (option) =>
              option.title.toLowerCase().includes(query.toLowerCase()) ||
              (option.category ?? "").toLowerCase().includes(query.toLowerCase()),
          ),
  })

  if (chosen === undefined) return
  const selected = models.find((model) => `${model.providerID}/${model.id}` === chosen)
  if (!selected) return

  // ── Thinking level step: only levels this model actually serves ──
  const variants = (selected.variants ?? []).map((variant) => String(variant.id))
  let variant: string | undefined
  if (variants.length > 0) {
    const level = await context.ui.dialog.select({
      title: `${selected.name ?? selected.id} · Thinking`,
      current: context.ui.model.current()?.variant ?? "default",
      options: [
        { title: "Model default", value: "default", description: "Use the model's own default" },
        ...[...variants].map((id) => ({ title: levelLabel(id), value: id })),
      ],
    })
    if (level === undefined) return
    variant = level === "default" ? undefined : level
  }

  const sessionID = currentSessionID(context)
  if (!sessionID) {
    context.ui.toast.show({
      title: "9Router",
      message: "Open a session first — model selection applies per session.",
      variant: "warning",
      duration: 4000,
    })
    return
  }

  try {
    await context.client.session.switchModel({
      sessionID,
      model: { providerID: "9router", id: selected.id, variant },
    })
    context.ui.toast.show({
      title: "9Router",
      message: `Model → ${selected.name ?? selected.id}${variant ? ` (${variant})` : ""}`,
      variant: "success",
      duration: 3000,
    })
  } catch (error) {
    context.ui.toast.show({
      title: "9Router",
      message: `Switch failed: ${error instanceof Error ? error.message : String(error)}`,
      variant: "error",
      duration: 5000,
    })
  }
}

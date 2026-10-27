// OpenCode V2 TUI part — usage sidebar, model picker, and commands.
//
// Configured like any plugin package (opencode.json(c) `plugins`); the CLI
// loads TUI-capable packages automatically from the connected server.

import { Plugin } from "@opencode/plugin/tui"
import { USAGE_PERIODS, type UsagePeriod } from "./shared/router.js"
import { createUsageStore, type UsageStore } from "./tui/store.js"
import { SidebarUsage } from "./tui/sidebar.js"
import { openModelPicker } from "./tui/picker.js"
import { debug } from "./tui/debug.js"

export default Plugin.define({
  id: "9hub.tui",
  async setup(context) {
    let store: UsageStore
    try {
      store = await createUsageStore(context)
    } catch (error) {
      // Crash signal: make setup failures visible even if console logging is
      // invisible, then rethrow so the host records the plugin as failed
      // (shown in the plugin manager and by the host boundary).
      const message = error instanceof Error ? error.message : String(error)
      debug(`setup:crash ${error instanceof Error ? (error.stack ?? message) : message}`)
      try {
        context.ui.toast.show({
          title: "9hub failed to start",
          message,
          variant: "error",
          duration: 8000,
        })
      } catch {
        // Toast unavailable — nothing more to do here.
      }
      throw error
    }

    // ── Sidebar: usage by provider ──
    context.ui.slot({
      append: "sidebar.content",
      render: (props) => <SidebarUsage context={context} store={store} sessionID={props.sessionID} />,
    })

    // ── Commands ──
    context.keymap.layer(() => ({
      mode: "global",
      priority: 10,
      commands: [
        {
          id: "9hub.models",
          title: "9Router: Models",
          group: "9Router",
          palette: true,
          suggested: true,
          slash: { name: "9hub", aliases: ["9models"] },
          run: () => void openModelPicker(context, store),
        },
        {
          id: "9hub.usage.period",
          title: "9Router: Usage period",
          group: "9Router",
          palette: true,
          slash: { name: "9usage", aliases: ["9period"] },
          run: async () => {
            if (store.status() === "offline" && !store.stats()) {
              // Maybe a local router just started — try once, then reopen the dialog if it worked.
              context.ui.toast.show({
                title: "9Router",
                message: "Reconnecting to the router…",
                duration: 2500,
              })
              store.restart()
              await new Promise((resolve) => setTimeout(resolve, 2500))
              if (store.status() === "offline" && !store.stats()) {
                context.ui.toast.show({
                  title: "9Router",
                  message: "Router unreachable — showing this session's usage. Periods need a reachable 9Router.",
                  variant: "warning",
                  duration: 4000,
                })
                return
              }
            }
            const period = await context.ui.dialog.select({
              title: "9Router · Usage period",
              current: store.period(),
              options: USAGE_PERIODS.map((value) => ({
                title: periodTitle(value),
                value,
              })),
            })
            if (period !== undefined) store.setPeriod(period as UsagePeriod)
          },
        },
      ],
    }))

    return () => {
      store.stop()
    }
  },
})

function periodTitle(period: UsagePeriod): string {
  switch (period) {
    case "today":
      return "Today"
    case "24h":
      return "Last 24 hours"
    case "7d":
      return "Last 7 days"
    case "30d":
      return "Last 30 days"
    case "60d":
      return "Last 60 days"
    case "all":
      return "All time"
  }
}

// Optional file sink for TUI-side diagnostics. Plugin console output is not
// visible in `--print-logs`, so when OPENCODE_9HUB_DEBUG points at a file the
// TUI part appends tagged lines there (shared with the server part's sink).

import { appendFileSync } from "node:fs"

const target = process.env.OPENCODE_9HUB_DEBUG

export function debug(message: string): void {
  if (!target) return
  try {
    appendFileSync(target, `${new Date().toISOString()} [tui] ${message}\n`)
  } catch {
    // Never let diagnostics break the plugin.
  }
}

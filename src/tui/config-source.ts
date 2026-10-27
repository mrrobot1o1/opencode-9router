// Locate this package's configured options by reading OpenCode config files
// from disk. The server→TUI plugin relay does not carry options (verified in
// v2.0.32: PluginInfo has no options field and /api/config omits plugins), so
// the TUI part self-serves: global config → project config, env already
// handled by resolveConfig. OpenCode also honors OPENCODE_CONFIG.

import { existsSync, readFileSync } from "node:fs"
import { basename, join } from "node:path"
import { homedir } from "node:os"
import { debug } from "./debug.js"

const PACKAGE_NAME = "opencode-9router"

/**
 * Minimal string-aware JSONC → object: strips line comments and block
 * comments plus trailing commas **outside strings only**. A regex-based
 * strip would corrupt values containing slash-slash or slash-star sequences
 * (passwords like "Pa//ss", URLs, names).
 */
function parseLooseJSONC(raw: string): Record<string, unknown> | undefined {
  let out = ""
  let index = 0
  const length = raw.length
  let inString = false

  while (index < length) {
    const char = raw[index]!

    if (inString) {
      // Inside a string: only an unescaped quote ends it. Everything else,
      // including `//` or `/*` sequences, is literal value data.
      out += char
      if (char === "\\") {
        // Keep the escape pair together so \" doesn't end the string.
        if (index + 1 < length) out += raw[index + 1]!
        index += 2
        continue
      }
      if (char === '"') inString = false
      index += 1
      continue
    }

    if (char === '"') {
      inString = true
      out += char
      index += 1
      continue
    }

    // Line comment (only outside strings).
    if (char === "/" && raw[index + 1] === "/") {
      while (index < length && raw[index] !== "\n") index += 1
      continue
    }
    // Block comment (only outside strings).
    if (char === "/" && raw[index + 1] === "*") {
      const end = raw.indexOf("*/", index + 2)
      index = end === -1 ? length : end + 2
      continue
    }

    out += char
    index += 1
  }

  // Trailing commas before } or ] — outside strings by construction, since
  // string content was copied verbatim above.
  const json = out.replace(/,(\s*[}\]])/g, "$1")
  try {
    const parsed = JSON.parse(json)
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : undefined
  } catch {
    return undefined
  }
}

function optionsFromConfigFile(file: string): Record<string, unknown> | undefined {
  if (!existsSync(file)) return undefined
  try {
    const config = parseLooseJSONC(readFileSync(file, "utf8"))
    if (!config) return undefined
    const plugins = Array.isArray(config.plugins) ? config.plugins : []
    for (const entry of plugins) {
      if (typeof entry === "string") continue
      if (typeof entry !== "object" || entry === null) continue
      const record = entry as Record<string, unknown>
      if (typeof record.package !== "string") continue
      const target = basename(record.package)
      if (target !== PACKAGE_NAME && !record.package.endsWith(`/${PACKAGE_NAME}`)) continue
      return (record.options ?? {}) as Record<string, unknown>
    }
  } catch {
    // Unreadable file — move on.
  }
  return undefined
}

/**
 * Resolve this package's configured options from disk: `OPENCODE_CONFIG`,
 * then the global user config, then project-local configs (nearest first).
 */
export function loadPluginOptionsFromDisk(): Record<string, unknown> | undefined {
  const candidates: string[] = []
  if (process.env.OPENCODE_CONFIG) candidates.push(process.env.OPENCODE_CONFIG)
  const configRoot = process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config")
  candidates.push(join(configRoot, "opencode", "opencode.jsonc"), join(configRoot, "opencode", "opencode.json"))
  // Project-level configs (TUI runs with cwd inside the project).
  candidates.push(join(process.cwd(), "opencode.jsonc"), join(process.cwd(), "opencode.json"))
  for (const file of candidates) {
    const options = optionsFromConfigFile(file)
    if (options) {
      debug(`config:disk matched ${file} options=${Object.keys(options).join(",") || "none"}`)
      return options
    }
  }
  debug("config:disk no match")
  return undefined
}

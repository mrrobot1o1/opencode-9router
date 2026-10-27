// Display helpers shared by the server and TUI parts: routed-id naming,
// alias display names, token/cost formatting.

import { splitModelID, stripThinkingSuffix } from "./levels.js"

/** Known 9Router aliases → display names (subset of the router registry). */
export const ALIAS_DISPLAY: Record<string, string> = {
  cc: "Claude Code",
  cx: "Codex",
  gh: "GitHub Copilot",
  kr: "Kiro AI",
  oc: "OpenCode Free",
  ocz: "OpenCode Zen",
  ag: "Antigravity",
  vertex: "Vertex AI",
  "vertex-partner": "Vertex Partner",
  glm: "GLM",
  "glm-cn": "GLM CN",
  minimax: "MiniMax",
  mm: "MiniMax Code",
  mmg: "MiniMax Global",
  kimi: "Kimi",
  cu: "Cursor",
  gc: "Gemini CLI",
  gemini: "Gemini",
  if: "iFlow",
  qd: "Qoder",
  openrouter: "OpenRouter",
  deepseek: "DeepSeek",
  groq: "Groq",
  xai: "xAI",
  openai: "OpenAI",
  anthropic: "Anthropic",
  bedrock: "Bedrock",
  br: "Bedrock",
  "brx": "Bedrock xAI",
  azure: "Azure",
  chutes: "Chutes",
  cerebras: "Cerebras",
  samba: "SambaNova",
  siliconflow: "SiliconFlow",
  together: "Together",
  fireworks: "Fireworks",
  hyperbolic: "Hyperbolic",
  nebius: "Nebius",
  featherless: "Featherless",
  mistral: "Mistral",
  nvidia: "NVIDIA",
  ollama: "Ollama",
  tr: "Trae",
  ws: "Windsurf",
  cl: "Cline",
  zd: "Zed",
  dv: "Devin CLI",
  gcli: "Grok CLI",
  cbcn: "CodeBuddy CN",
  cbai: "CodeBuddy Intl",
  kc: "Kilo Code",
  kgw: "Kilo Gateway",
  kimchi: "Kimchi",
  bai: "Baidu",
  baidu: "Baidu",
  qianfan: "Qianfan",
  volcengine: "Volcengine",
  "volcengine-ark": "Volcengine Ark",
  byteplus: "BytePlus",
  hunyuan: "Hunyuan",
  tencent: "Tencent",
  sensenova: "SenseNova",
  alims: "Alims",
  "alims-intl": "Alims Intl",
  alicode: "AliCode",
  "alicode-intl": "AliCode Intl",
  alitp: "AliTP",
  "alitp-intl": "AliTP Intl",
  mmf: "MiMo Free",
  "xiaomi-mimo": "Xiaomi MiMo",
  "opencode-go": "OpenCode Go",
  "chatgpt-web": "ChatGPT Web",
  "gemini-web": "Gemini Web",
  "grok-web": "Grok Web",
  "deepseek-web": "DeepSeek Web",
  perplexity: "Perplexity",
  af: "API Airforce",
  llm7: "LLM7",
  blackbox: "Blackbox",
  v1m: "V1M",
  dahl: "Dahl",
  trae: "Trae",
  uc: "UC Web",
  muse: "Muse",
  mux: "Muse",
  poolside: "Poolside",
  tokenrouter: "TokenRouter",
  tokenharbor: "TokenHarbor",
  xquik: "XQuik",
  bq: "Bazaarlink",
  bzl: "Bazaarlink",
  jina: "Jina",
}

/** 9Router stats provider ids are provider-node ids or aliases; display what we know. */
export function providerDisplayName(provider: string): string {
  if (!provider) return "unknown"
  const direct = ALIAS_DISPLAY[provider]
  if (direct) return direct
  // Some stats keys are provider ids (claude, codex, opencode, kiro…) — those
  // collide with aliases in most cases, so the table above covers them.
  return provider
}

/** Human display name for a routed model id, e.g. `kr/claude-4.5` → "claude-4.5 (Kiro AI)". */
export function formatModelName(modelID: string): string {
  const { alias, model } = splitModelID(stripThinkingSuffix(modelID))
  if (!alias) return model
  const label = ALIAS_DISPLAY[alias] ?? alias
  return `${model} (${label})`
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

// Mock 9Router for local development: serves the endpoints opencode-9hub
// consumes — /v1/models, /v1/models/info, /api/usage/stats, /api/usage/stream
// (SSE), /api/providers. Run: node scripts/mock-router.mjs [port]

import { createServer } from "node:http"

const PORT = Number(process.argv[2] ?? process.env.PORT ?? 20128)
const MOCK_PASSWORD = "mock-password"
const MOCK_SESSION = "mock-session-token"

const MODELS = [
  { id: "kr/claude-sonnet-4.5", owned_by: "kr" },
  { id: "kr/glm-5", owned_by: "kr" },
  { id: "cc/claude-opus-4-7", owned_by: "cc" },
  { id: "cc/claude-sonnet-4-6", owned_by: "cc" },
  { id: "cx/gpt-5.5", owned_by: "cx" },
  { id: "glm/glm-5.1", owned_by: "glm" },
  { id: "kimi/kimi-k2.5", owned_by: "kimi" },
  { id: "kimi/kimi-k2.5-thinking", owned_by: "kimi" },
  { id: "minimax/MiniMax-M2.7", owned_by: "minimax" },
  { id: "auto-best-combo", owned_by: "combo" },
]

const CAPS = {
  "kr/claude-sonnet-4.5": { vision: true, tools: true, reasoning: true, thinkingFormat: "claude-budget", thinkingCanDisable: true, contextWindow: 200000, maxOutput: 64000 },
  "kr/glm-5": { tools: true, reasoning: true, thinkingFormat: "zai", thinkingCanDisable: true, contextWindow: 128000, maxOutput: 32000 },
  "cc/claude-opus-4-7": { vision: true, tools: true, reasoning: true, thinkingFormat: "claude-budget", thinkingCanDisable: true, contextWindow: 200000, maxOutput: 32000 },
  "cc/claude-sonnet-4-6": { vision: true, tools: true, reasoning: true, thinkingFormat: "claude-budget", thinkingCanDisable: true, contextWindow: 200000, maxOutput: 32000 },
  "cx/gpt-5.5": { vision: true, tools: true, reasoning: true, thinkingFormat: "openai", thinkingCanDisable: true, contextWindow: 400000, maxOutput: 128000 },
  "glm/glm-5.1": { tools: true, reasoning: true, thinkingFormat: "zai", thinkingCanDisable: true, contextWindow: 128000, maxOutput: 32000 },
  "kimi/kimi-k2.5": { tools: true, reasoning: false, contextWindow: 256000, maxOutput: 64000 },
  "kimi/kimi-k2.5-thinking": { tools: true, reasoning: true, thinkingFormat: "kimi", thinkingCanDisable: false, contextWindow: 256000, maxOutput: 64000 },
  "minimax/MiniMax-M2.7": { tools: true, reasoning: true, thinkingFormat: "minimax", thinkingCanDisable: true, contextWindow: 200000, maxOutput: 64000 },
  "auto-best-combo": { vision: true, tools: true, reasoning: true, thinkingFormat: "openai", thinkingCanDisable: true, contextWindow: 262144, maxOutput: 131072 },
}

// Claude 4.6-style naming would test the no-xhigh override; add a pattern hit.
MODELS.push({ id: "cc/claude-4.6-opus-max", owned_by: "cc" })
CAPS["cc/claude-4.6-opus-max"] = { vision: true, tools: true, reasoning: true, thinkingFormat: "claude-budget", thinkingCanDisable: true, contextWindow: 200000, maxOutput: 32000 }

let requests = 0

function stats(period) {
  requests++
  const base = period === "all" ? 5 : period === "today" ? 0.6 : period === "24h" ? 1.2 : 3.5
  const scale = period === "all" ? 5 : period === "today" ? 0.6 : period === "24h" ? 1.2 : 3.5
  return {
    totalRequests: Math.round(128 * scale),
    totalPromptTokens: Math.round(1_240_000 * scale),
    totalCompletionTokens: Math.round(86_000 * scale),
    totalCachedTokens: Math.round(420_000 * scale),
    totalCost: base + 0.42,
    byProvider: {
      kr: { requests: Math.round(52 * scale), promptTokens: Math.round(520000 * scale), completionTokens: Math.round(31000 * scale), cachedTokens: Math.round(180000 * scale), cost: 0.001 * scale },
      cc: { requests: Math.round(31 * scale), promptTokens: Math.round(340000 * scale), completionTokens: Math.round(24000 * scale), cachedTokens: Math.round(120000 * scale), cost: (base * 0.6 + 0.2) },
      glm: { requests: Math.round(24 * scale), promptTokens: Math.round(210000 * scale), completionTokens: Math.round(14000 * scale), cachedTokens: Math.round(64000 * scale), cost: 0.09 * scale },
      cx: { requests: Math.round(12 * scale), promptTokens: Math.round(96000 * scale), completionTokens: Math.round(8800 * scale), cachedTokens: Math.round(30000 * scale), cost: 0.11 * scale },
      kimi: { requests: Math.round(5 * scale), promptTokens: Math.round(42000 * scale), completionTokens: Math.round(3600 * scale), cachedTokens: Math.round(9000 * scale), cost: 0.02 * scale },
      minimax: { requests: Math.round(4 * scale), promptTokens: Math.round(32000 * scale), completionTokens: Math.round(4600 * scale), cachedTokens: Math.round(7000 * scale), cost: 0.004 * scale },
    },
    byModel: {
      [`claude-sonnet-4.5 (${scale >= 3 ? "Claude Code" : "Kiro AI"})`]: { requests: Math.round(20 * scale), promptTokens: Math.round(220000 * scale), completionTokens: Math.round(12000 * scale), cachedTokens: Math.round(80000 * scale), cost: base * 0.4, rawModel: "claude-sonnet-4.5", provider: scale >= 3 ? "Claude Code" : "Kiro AI", lastUsed: "2026-10-27" },
      [`glm-5.1 (${scale >= 3 ? "GLM" : "GLM"})`]: { requests: Math.round(14 * scale), promptTokens: Math.round(130000 * scale), completionTokens: Math.round(9000 * scale), cachedTokens: Math.round(40000 * scale), cost: 0.07 * scale, rawModel: "glm-5.1", provider: "GLM", lastUsed: "2026-10-27" },
      [`gpt-5.5 (${scale >= 3 ? "Codex" : "Codex"})`]: { requests: Math.round(9 * scale), promptTokens: Math.round(80000 * scale), completionTokens: Math.round(7000 * scale), cachedTokens: Math.round(20000 * scale), cost: 0.1 * scale, rawModel: "gpt-5.5", provider: "Codex", lastUsed: "2026-10-27" },
    },
    byAccount: {},
    activeRequests: [{ model: "claude-sonnet-4.5", provider: "cc", account: "main", count: 1 }],
    recentRequests: [],
    errorProvider: requests % 7 === 0 ? "kimi" : "",
  }
}

createServer((req, res) => {
  const url = new URL(req.url ?? "/", `http://localhost:${PORT}`)
  const send = (status, body) => {
    res.writeHead(status, { "content-type": "application/json", "access-control-allow-origin": "*" })
    res.end(JSON.stringify(body))
  }

  if (url.pathname === "/v1/models") {
    return send(200, {
      object: "list",
      data: MODELS.map((m) => ({ id: m.id, object: "model", owned_by: m.owned_by, capabilities: CAPS[m.id] })),
    })
  }

  if (url.pathname === "/v1/models/info") {
    const id = url.searchParams.get("id")
    const model = MODELS.find((m) => m.id === id)
    if (!model) return send(404, { error: "unknown model" })
    return send(200, { id: model.id, name: model.id, owned_by: model.owned_by, capabilities: CAPS[model.id] })
  }

  if (url.pathname === "/v1/chat/completions") {
    // Minimal echo completion so `opencode run -m 9router/... "hi"` works offline.
    let body = ""
    req.on("data", (c) => (body += c))
    req.on("end", () => {
      let prompt = "hi"
      try {
        const parsed = JSON.parse(body)
        prompt = parsed?.messages?.at(-1)?.content ?? prompt
      } catch {}
      send(200, {
        id: "chatcmpl-mock",
        object: "chat.completion",
        created: Date.now(),
        model: "mock",
        choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: `OK (${prompt})` } }],
        usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
      })
    })
    return
  }

  if (url.pathname === "/api/usage/stats") {
    return send(200, stats(url.searchParams.get("period") ?? "7d"))
  }

  if (url.pathname === "/api/auth/login") {
    let body = ""
    req.on("data", (c) => (body += c))
    req.on("end", () => {
      let password = ""
      try {
        password = JSON.parse(body)?.password ?? ""
      } catch {}
      if (password !== MOCK_PASSWORD) return send(401, { error: "Invalid password" })
      res.writeHead(200, {
        "content-type": "application/json",
        "set-cookie": `auth_token=mock-session-token; Path=/; HttpOnly; SameSite=Lax`,
      })
      res.end(JSON.stringify({ success: true }))
    })
    return
  }

  if (url.pathname === "/api/providers") {
    // Guarded like a hosted router: needs the dashboard session cookie.
    const cookie = req.headers.cookie ?? ""
    if (!cookie.includes("auth_token=")) return send(401, { error: "Unauthorized" })
    if (!cookie.includes(MOCK_SESSION)) return send(401, { error: "Unauthorized" })
    return send(200, {
      connections: [
        { id: "c1", provider: "openai-compatible-chat-xyz", name: "AG gateway", isActive: true, providerSpecificData: { prefix: "ag" } },
        { id: "c2", provider: "kiro", name: "Kiro free", isActive: true },
        { id: "c3", provider: "opencode", name: "stale", isActive: false },
      ],
    })
  }

  if (url.pathname === "/api/usage/stream") {
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    })
    let n = 0
    const push = () => {
      n++
      const payload = stats("all")
      // Simulate activity changes between pushes.
      payload.activeRequests = n % 3 === 0 ? [] : [{ model: "claude-sonnet-4.5", provider: "cc", account: "main", count: (n % 3) + 1 }]
      res.write(`data: ${JSON.stringify(payload)}\n\n`)
    }
    push()
    const timer = setInterval(push, 3000)
    req.on("close", () => clearInterval(timer))
    return
  }

  send(404, { error: `no mock for ${url.pathname}` })
}).listen(PORT, () => {
  console.log(`mock 9router on http://localhost:${PORT} (stats mutate over time; errorProvider blinks)`)
})

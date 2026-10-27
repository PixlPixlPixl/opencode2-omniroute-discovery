// OmniRoute provider plugin for opencode v2.
//
// opencode v2 has no built-in flag to auto-load models from an OpenAI-compatible
// /v1/models endpoint, so this plugin does it:
//   1. sync() fetches GET {baseUrl}/models (a union of FETCH_ROUNDS requests,
//      since the gateway can rotate its catalog).
//   2. A provider transform replaces the "omniroute" provider's model inventory
//      with the fetched text models, using the full model id as the display name
//      so the backend prefix is visible (e.g. "opencode-go/deepseek-v4-flash" vs
//      "ds/deepseek-v4-flash"). Models the gateway no longer reports disappear
//      with the replacement, so the catalog never goes stale.
//
// Recovery: if a sync fails (gateway down, Tailscale not up yet, ...) the plugin
// keeps retrying with exponential backoff instead of leaving the provider
// permanently empty. Once a model list has been fetched it is re-synced every
// REFRESH_INTERVAL_MS so catalog rotation is picked up without restarting
// opencode.
//
// Gateway settings, by precedence:
//   - OMNIROUTE_BASE_URL / OMNIROUTE_API_KEY env vars (read by this plugin and
//     passed to opencode as the provider credential).
//   - The active OmniRoute credential, i.e. the key saved through /connect.
//   - opencode.jsonc: providers.omniroute.settings.{baseURL,apiKey}, with a
//     fallback to the older provider.omniroute.options.* / provider-level "api".
//
// Note: the opencode background service does not inherit env vars exported in an
// interactive shell. If OMNIROUTE_API_KEY is only set in your terminal, connect
// OmniRoute once with /connect (the key is stored as a credential and used
// here), or start the service from a shell that has the variable.

import { Model, Plugin, Provider } from "@opencode/plugin"
import { readFileSync } from "node:fs"

const FETCH_TIMEOUT_MS = 10_000
const FETCH_ROUNDS = 3
const RETRY_INITIAL_MS = 2_000 // first retry delay after a failed sync
const RETRY_MAX_MS = 60_000 // cap on exponential backoff between retries
const REFRESH_INTERVAL_MS = 5 * 60_000 // how often to re-sync once healthy
const CATALOG_CACHE_MS = 30_000 // share one fetch across the plugin's locations
const DEFAULT_OUTPUT_LIMIT = 32_000 // only used as a cap when max_output_tokens is absent

const PROVIDER_ID = "omniroute"

type GatewayModel = {
  id: string
  name?: string
  type?: string
  context_length?: number
  max_input_tokens?: number
  max_output_tokens?: number
  input_modalities?: string[]
  output_modalities?: string[]
  capabilities?: { tool_calling?: boolean; reasoning?: boolean }
}

type GatewaySettings = { baseUrl?: string; apiKey?: string }

// Strip // and /* */ comments from JSONC without touching string literals.
function stripJsonComments(src: string): string {
  let out = ""
  let inStr = false
  let esc = false
  for (let i = 0; i < src.length; i++) {
    const c = src[i]
    const n = src[i + 1]
    if (inStr) {
      out += c
      if (esc) esc = false
      else if (c === "\\") esc = true
      else if (c === '"') inStr = false
      continue
    }
    if (c === '"') {
      inStr = true
      out += c
      continue
    }
    if (c === "/" && n === "/") {
      while (i < src.length && src[i] !== "\n") i++
      continue
    }
    if (c === "/" && n === "*") {
      i += 2
      while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) i++
      i++
      continue
    }
    out += c
  }
  return out
}

// Remove trailing commas (outside string literals) so JSONC can be JSON.parse'd.
function stripTrailingCommas(src: string): string {
  let out = ""
  let inStr = false
  let esc = false
  for (let i = 0; i < src.length; i++) {
    const c = src[i]
    if (inStr) {
      out += c
      if (esc) esc = false
      else if (c === "\\") esc = true
      else if (c === '"') inStr = false
      continue
    }
    if (c === '"') {
      inStr = true
      out += c
      continue
    }
    if (c === ",") {
      // Drop the comma only when it is followed (past whitespace) by a closing
      // bracket, i.e. a trailing comma before } or ].
      let j = i + 1
      while (j < src.length && (src[j] === " " || src[j] === "\t" || src[j] === "\n" || src[j] === "\r")) j++
      if (j < src.length && (src[j] === "}" || src[j] === "]")) continue
    }
    out += c
  }
  return out
}

// Read the omniroute provider block from opencode.jsonc (v2 `providers`, with a
// fallback to the deprecated v1 `provider` shape).
function readConfigSettings(): GatewaySettings {
  try {
    const configPath = new URL("../opencode.jsonc", import.meta.url)
    const text = readFileSync(configPath, "utf8")
    const cfg = JSON.parse(stripTrailingCommas(stripJsonComments(text)))
    const p = cfg?.providers?.omniroute ?? cfg?.provider?.omniroute
    return {
      baseUrl: p?.settings?.baseURL ?? p?.options?.baseURL ?? p?.api,
      apiKey: p?.settings?.apiKey ?? p?.options?.apiKey,
    }
  } catch {
    return {}
  }
}

// Model ids may contain slashes (opencode splits references at the first "/")
// but must not contain "#" and should not contain control characters. Reject
// junk so a malformed or hostile gateway entry cannot register unresolvable
// model names or corrupt the dedup table/log output.
function isValidModelId(id: unknown): id is string {
  return (
    typeof id === "string" &&
    id.length > 0 &&
    id.length <= 1024 &&
    !/[#\u0000-\u001f\u007f]/.test(id)
  )
}

function positiveNumber(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : undefined
}

// Only chat-capable models belong in the model catalog; a video or embedding
// model in /models is not selectable as a session model.
const CHAT_TYPES = new Set(["text", "chat", "language", "completion"])

function isChatModel(m: GatewayModel): boolean {
  if (m.output_modalities && !m.output_modalities.includes("text")) return false
  if (m.type === undefined) return true
  return CHAT_TYPES.has(m.type)
}

function buildModelInfo(providerID: ReturnType<typeof Provider.ID.make>, m: GatewayModel) {
  const info = Model.Info.default(providerID, Model.ID.make(m.id))
  // Full id as the name so the backend prefix is visible ("aug/gpt5" vs
  // "ds/gpt5"), which keeps duplicate upstream ids distinguishable in /models.
  info.name = m.id

  const tools = m.capabilities?.tool_calling !== false
  const input = m.input_modalities?.filter((v) => typeof v === "string" && v.length > 0)
  info.capabilities = {
    tools,
    input: input?.length ? input : ["text"],
    output: ["text"],
    temperature: true,
  }

  // Only set a limit from gateway-reported numbers. Never advertise an output
  // budget larger than the reported context window.
  const context = positiveNumber(m.context_length) ?? positiveNumber(m.max_input_tokens)
  const maxOutput = positiveNumber(m.max_output_tokens)
  if (context) {
    info.limit = {
      context,
      output: Math.min(maxOutput ?? DEFAULT_OUTPUT_LIMIT, context),
    }
  }
  return info
}

type FetchResult = { models: GatewayModel[]; errors: string[]; skipped: number; endpoint: string }

async function fetchModelList(baseUrl: string, apiKey: string): Promise<FetchResult> {
  // Map (not a plain object) so odd model ids like "__proto__" or
  // "constructor" cannot corrupt the dedup table.
  const seen = new Map<string, GatewayModel>()
  const errors: string[] = []
  let skipped = 0
  // Run all rounds concurrently so the whole fetch is bounded by one timeout
  // instead of FETCH_ROUNDS * FETCH_TIMEOUT_MS.
  const rounds = await Promise.allSettled(
    Array.from({ length: FETCH_ROUNDS }, async () => {
      const res = await fetch(`${baseUrl.replace(/\/+$/, "")}/models`, {
        headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      return (await res.json()) as { data?: GatewayModel[] }
    }),
  )
  rounds.forEach((result, i) => {
    if (result.status === "rejected") {
      errors.push(`round ${i + 1}: ${String(result.reason)}`)
      return
    }
    for (const m of result.value?.data ?? []) {
      if (!m || !isValidModelId(m.id) || !isChatModel(m)) {
        skipped++
        continue
      }
      if (!seen.has(m.id)) seen.set(m.id, m)
    }
  })
  const models = [...seen.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  return { models, errors, skipped, endpoint: baseUrl }
}

// Share one fetch between every location this plugin is loaded for, so a
// multi-project session does not hammer the gateway.
let sharedCache: { at: number; baseUrl: string; apiKey: string; result: FetchResult } | undefined
let sharedInFlight: { baseUrl: string; apiKey: string; promise: Promise<FetchResult> } | undefined

async function getModelList(baseUrl: string, apiKey: string): Promise<FetchResult> {
  const now = Date.now()
  if (
    sharedCache &&
    sharedCache.baseUrl === baseUrl &&
    sharedCache.apiKey === apiKey &&
    now - sharedCache.at < CATALOG_CACHE_MS
  ) {
    return sharedCache.result
  }
  if (sharedInFlight && sharedInFlight.baseUrl === baseUrl && sharedInFlight.apiKey === apiKey) {
    return sharedInFlight.promise
  }
  const promise = fetchModelList(baseUrl, apiKey).finally(() => {
    if (sharedInFlight?.promise === promise) sharedInFlight = undefined
  })
  sharedInFlight = { baseUrl, apiKey, promise }
  const result = await promise
  if (result.models.length > 0) sharedCache = { at: Date.now(), baseUrl, apiKey, result }
  return result
}

export default Plugin.define({
  id: PROVIDER_ID,
  async setup(ctx) {
    const config = readConfigSettings()
    const baseUrl = (process.env.OMNIROUTE_BASE_URL ?? config.baseUrl ?? "").trim()
    if (!baseUrl) {
      console.error(
        `[omniroute] missing base URL. Set providers.omniroute.settings.baseURL in opencode.jsonc ` +
          `or OMNIROUTE_BASE_URL for the opencode server.`,
      )
      return
    }

    // The key can arrive after startup: the env var, the config, or a /connect
    // credential created later. Re-resolve it on every attempt so connecting
    // OmniRoute fills the catalog without restarting or reloading the plugin.
    let apiKey = (process.env.OMNIROUTE_API_KEY ?? config.apiKey ?? "").trim()
    let warnedMissingKey = false
    const resolveApiKey = async (): Promise<string | undefined> => {
      if (apiKey) return apiKey
      try {
        // The key entered through /connect lives in opencode's credential store.
        const connection = await ctx.integration.connection.active("omniroute")
        if (connection) {
          const value = await ctx.integration.connection.resolve(connection)
          if (value?.type === "key") apiKey = value.key
        }
      } catch (err) {
        console.error(`[omniroute] could not read stored credential: ${String(err)}`)
      }
      return apiKey || undefined
    }

    // Latest registered inventory. The transform reads `inventory` on every
    // replay, so a refresh swaps it and reloads the provider.
    let inventory: ReturnType<typeof buildModelInfo>[] = []
    let lastSignature = ""
    let registered = false
    let stopped = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const providerID = Provider.ID.make(PROVIDER_ID)

    const schedule = (delayMs: number) => {
      if (stopped) return
      clearTimeout(timer)
      timer = setTimeout(() => void run(), delayMs)
    }

    // Replace the provider's source inventory with the latest fetched list.
    // The transform reads `inventory` on every replay, so a refresh only has to
    // swap the array and reload; a captured local would go stale.
    const applyToCatalog = async () => {
      if (inventory.length === 0) return false
      if (!registered) {
        try {
          await ctx.provider.transform((editor) => {
            editor.models.set(PROVIDER_ID, inventory)
          })
          registered = true
          console.error(`[omniroute] registered ${inventory.length} model(s) from ${baseUrl}`)
          return true
        } catch (err) {
          console.error(`[omniroute] catalog registration failed: ${String(err)}`)
          return false
        }
      }
      try {
        await ctx.provider.reload()
        console.error(`[omniroute] catalog refreshed: ${inventory.length} model(s) from ${baseUrl}`)
        return true
      } catch (err) {
        console.error(`[omniroute] catalog reload failed: ${String(err)}`)
        return false
      }
    }

    const syncOnce = async () => {
      const key = await resolveApiKey()
      if (!key) {
        if (!warnedMissingKey) {
          warnedMissingKey = true
          console.error(
            `[omniroute] no API key yet; connect OmniRoute with /connect (or set OMNIROUTE_API_KEY ` +
              `for the opencode server). Retrying in the background.`,
          )
        }
        return false
      }
      let result: FetchResult
      try {
        result = await getModelList(baseUrl, key)
      } catch (err) {
        console.error(`[omniroute] fetch failed: ${String(err)}`)
        return false
      }
      if (result.skipped > 0) {
        console.error(`[omniroute] ignored ${result.skipped} non-chat or invalid model(s) from ${baseUrl}`)
      }
      if (result.models.length === 0) {
        console.error(
          `[omniroute] no models fetched from ${baseUrl}: ` +
            (result.errors.length > 0 ? result.errors.join("; ") : "gateway returned an empty catalog"),
        )
        return false
      }
      if (result.errors.length > 0) {
        console.error(
          `[omniroute] ${result.errors.length}/${FETCH_ROUNDS} fetch round(s) failed but ${result.models.length} model(s) recovered`,
        )
      }
      // Only touch the catalog when the fetched model set actually changed, so a
      // healthy periodic refresh does not rebuild/re-log every cycle.
      const signature = JSON.stringify(
        result.models.map((m) => [
          m.id,
          m.name ?? null,
          m.context_length ?? null,
          m.max_input_tokens ?? null,
          m.max_output_tokens ?? null,
          m.capabilities?.tool_calling ?? null,
          m.input_modalities ?? null,
        ]),
      )
      if (signature === lastSignature && registered) return true
      lastSignature = signature
      inventory = result.models.map((m) => buildModelInfo(providerID, m))
      return applyToCatalog()
    }

    // Retry with exponential backoff until the first successful sync, then
    // settle into a slower periodic refresh so the catalog stays current.
    let attempt = 0
    async function run() {
      const ok = await syncOnce()
      if (ok) {
        attempt = 0
        schedule(REFRESH_INTERVAL_MS)
      } else if (!stopped) {
        const delay = Math.min(RETRY_INITIAL_MS * 2 ** attempt, RETRY_MAX_MS)
        attempt++
        if (attempt === 1 || attempt % 10 === 0 || delay >= RETRY_MAX_MS) {
          console.error(
            `[omniroute] sync failed (attempt ${attempt}); next retry in ${Math.round(delay / 1000)}s`,
          )
        }
        schedule(delay)
      }
    }

    await run()

    // Teardown: stop the retry/refresh chain.
    return () => {
      stopped = true
      clearTimeout(timer)
    }
  },
})

// OmniRoute provider plugin for opencode v2 (beta).
//
// opencode has no built-in flag to auto-load models from an OpenAI-compatible
// /v1/models endpoint, so this plugin does it:
//   1. sync() fetches GET {baseUrl}/models (a union of FETCH_ROUNDS requests,
//      since the gateway can rotate its catalog).
//   2. A catalog transform upserts every fetched model onto the "omniroute"
//      provider, using the full model id as the display name so the backend
//      prefix is visible (e.g. "opencode-go/deepseek-v4-flash" vs
//      "ds/deepseek-v4-flash"). Models the gateway no longer reports are
//      removed from the provider so the catalog does not go stale.
//
// Recovery: if a sync fails (gateway down, Tailscale not up yet, ...) the
// plugin keeps retrying with exponential backoff instead of leaving the
// provider permanently empty. Once a model list has been fetched it is
// re-synced every REFRESH_INTERVAL_MS so catalog rotation is picked up
// without restarting opencode.
//
// Gateway settings, by precedence:
//   - OMNIROUTE_BASE_URL / OMNIROUTE_API_KEY env vars override everything.
//     Use these when you want the key machine-local (not stored in any file).
//   - Otherwise they are read from opencode.jsonc at
//     provider.omniroute.options.baseURL / .apiKey (with a fallback to the
//     provider-level "api" field for the URL).
//
// Hard-coding the apiKey in opencode.jsonc is a deliberate choice in this
// setup. Trade-off: the key then lives in the synced file, so the file itself must be protected.
// Set OMNIROUTE_API_KEY (and/or OMNIROUTE_BASE_URL) instead on any machine where
// you do not want the credential stored in the synced config.

import { readFileSync } from "node:fs"

const FETCH_TIMEOUT_MS = 10_000
const FETCH_ROUNDS = 3
const RETRY_INITIAL_MS = 2_000 // first retry delay after a failed sync
const RETRY_MAX_MS = 60_000 // cap on exponential backoff between retries
const REFRESH_INTERVAL_MS = 5 * 60_000 // how often to re-sync once healthy
const DEFAULT_OUTPUT_LIMIT = 32_000 // only used as a cap when max_output_tokens is absent

const PROVIDER_ID = "omniroute"

// Strip // and /* */ comments from JSONC without touching string literals.
function stripJsonComments(src) {
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
function stripTrailingCommas(src) {
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

// Read the omniroute provider block from opencode.jsonc. Returns the gateway
// base URL and API key (either may be undefined) or undefined if the config
// cannot be found/parsed. Env-var overrides are applied by the caller.
function readOmnirouteConfig() {
  try {
    // Use import.meta.url (Node 10+) so this works regardless of runtime version;
    // import.meta.dir requires Node >= 20.11.
    const configPath = new URL("../opencode.jsonc", import.meta.url)
    const text = readFileSync(configPath, "utf8")
    // JSONC -> JSON: strip comments and trailing commas (string-aware).
    const clean = stripTrailingCommas(stripJsonComments(text))
    const cfg = JSON.parse(clean)
    const p = cfg?.provider?.omniroute
    return {
      // options.baseURL is the canonical field; provider-level "api" is a
      // fallback for configs that only set the latter.
      baseUrl: p?.options?.baseURL ?? p?.api,
      apiKey: p?.options?.apiKey,
    }
  } catch {
    return undefined
  }
}

// Model ids may contain slashes (opencode splits references at the first "/")
// but must not contain "#" and should not contain control characters. Reject
// junk so a malformed or hostile gateway entry cannot register unresolvable
// model names or corrupt the dedup table/log output.
function isValidModelId(id) {
  return (
    typeof id === "string" &&
    id.length > 0 &&
    id.length <= 1024 &&
    !/[#\u0000-\u001f\u007f]/.test(id)
  )
}

function positiveNumber(v) {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : undefined
}

async function fetchModelList(baseUrl, apiKey) {
  // Map (not a plain object) so odd model ids like "__proto__" or
  // "constructor" cannot corrupt the dedup table.
  const seen = new Map<string, any>()
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
      return await res.json()
    })
  )
  rounds.forEach((result, i) => {
    if (result.status === "rejected") {
      errors.push(`round ${i + 1}: ${String(result.reason)}`)
      return
    }
    for (const m of result.value?.data ?? []) {
      if (!m || !isValidModelId(m.id)) {
        skipped++
        continue
      }
      if (!seen.has(m.id)) seen.set(m.id, m)
    }
  })
  return { models: [...seen.values()], errors, skipped }
}

export default {
  id: PROVIDER_ID,
  async setup(ctx) {
    const cfg = readOmnirouteConfig()
    const baseUrl = (process.env.OMNIROUTE_BASE_URL ?? cfg?.baseUrl ?? "").trim()
    const apiKey = process.env.OMNIROUTE_API_KEY ?? cfg?.apiKey
    if (!baseUrl || !apiKey) {
      console.error(
        `[omniroute] missing base URL or API key. Set OMNIROUTE_BASE_URL/OMNIROUTE_API_KEY ` +
          `env vars, or provider.omniroute.options.{baseURL, apiKey} in opencode.jsonc.`
      )
      return
    }

    // Latest successfully fetched model list. The transform reads this on every
    // invocation, so a refresh only has to update it and call ctx.catalog.reload().
    let models: any[] = []
    let lastSignature = "" // fingerprint of what was last applied to the catalog
    let transformRegistered = false
    let timer: ReturnType<typeof setTimeout> | undefined
    let stopped = false

    const schedule = (delayMs: number) => {
      if (stopped) return
      clearTimeout(timer)
      timer = setTimeout(run, delayMs)
    }

    // Register (once) a transform that reconciles the provider's models with
    // the latest fetched list: upsert present models, drop stale ones.
    const applyToCatalog = async () => {
      if (models.length === 0) return false
      try {
        if (!transformRegistered) {
          await ctx.catalog.transform((catalog) => {
            const wanted = new Set<string>(models.map((m) => m.id))
            let removed = 0
            const provider = catalog.provider
              .list()
              .find((p) => p.providerID === PROVIDER_ID || p.id === PROVIDER_ID)
            if (provider) {
              for (const model of provider.models.values()) {
                if (!wanted.has(model.id)) {
                  catalog.model.remove(PROVIDER_ID, model.id)
                  removed++
                }
              }
            }
            let added = 0
            for (const m of models) {
              catalog.model.update(PROVIDER_ID, m.id, (model) => {
                // Full id as the name so the backend prefix is visible.
                model.name = m.id
                // Only set a limit from gateway-reported numbers. Do not guess
                // a context length we were not told; and never advertise an
                // output budget larger than the reported context window.
                const contextLength = positiveNumber(m.context_length)
                const maxOutput = positiveNumber(m.max_output_tokens)
                if (contextLength) {
                  const output = Math.min(maxOutput ?? DEFAULT_OUTPUT_LIMIT, contextLength)
                  model.limit = { context: contextLength, output }
                }
                if (m.capabilities?.tool_calling === false) model.capabilities.tools = false
              })
              added++
            }
            console.error(
              `[omniroute] catalog updated: ${added} model(s) tracked, ${removed} stale removed`
            )
          })
          transformRegistered = true
        } else {
          // Re-run the transform above with the refreshed `models` list.
          await ctx.catalog.reload()
        }
        return true
      } catch (err) {
        console.error(`[omniroute] catalog update failed: ${String(err)}`)
        return false
      }
    }

    const syncOnce = async () => {
      let fetched, errors, skipped
      try {
        ;({ models: fetched, errors, skipped } = await fetchModelList(baseUrl, apiKey))
      } catch (err) {
        console.error(`[omniroute] fetch failed: ${String(err)}`)
        return false
      }
      if (skipped > 0) console.error(`[omniroute] ignored ${skipped} invalid model id(s) from ${baseUrl}`)
      if (fetched.length === 0) {
        console.error(
          `[omniroute] no models fetched from ${baseUrl}: ` +
            (errors.length > 0 ? errors.join("; ") : "gateway returned an empty catalog")
        )
        return false
      }
      if (errors.length > 0) {
        console.error(`[omniroute] ${errors.length}/${FETCH_ROUNDS} fetch round(s) failed but ${fetched.length} model(s) recovered`)
      }
      // Only touch the catalog when the fetched model set actually changed,
      // so a healthy periodic refresh does not rebuild/re-log every cycle.
      const signature = JSON.stringify([...fetched].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)))
      if (signature === lastSignature && transformRegistered) return true
      models = fetched
      lastSignature = signature
      return applyToCatalog()
    }

    // Retry with exponential backoff until the first successful sync, then
    // settle into a slower periodic refresh so the catalog stays current.
    let attempt = 0
    let everSucceeded = false
    async function run() {
      const ok = await syncOnce()
      if (ok) {
        if (!everSucceeded) {
          everSucceeded = true
          console.error(`[omniroute] registered ${models.length} models from ${baseUrl}`)
        }
        attempt = 0
        schedule(REFRESH_INTERVAL_MS)
      } else if (!stopped) {
        const delay = Math.min(RETRY_INITIAL_MS * 2 ** attempt, RETRY_MAX_MS)
        attempt++
        if (attempt === 1 || attempt % 10 === 0 || delay >= RETRY_MAX_MS) {
          console.error(
            `[omniroute] sync failed (attempt ${attempt}); next retry in ${Math.round(delay / 1000)}s`
          )
        }
        schedule(delay)
      }
    }

    await run()

    // Teardown: stop the retry/refresh chain (docs pattern for setup cleanup).
    return () => {
      stopped = true
      clearTimeout(timer)
    }
  },
}

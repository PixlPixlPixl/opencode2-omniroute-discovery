# OpenCode2 OmniRoute Model Discovery

Automatically discover the chat models exposed by an OmniRoute gateway and keep them available in OpenCode2—without maintaining a separate model list in `opencode.jsonc`.

The plugin uses the OpenCode v2 plugin API to fetch OmniRoute's OpenAI-compatible models endpoint and register the discovered models under the `omniroute` provider.

## What it does

- **Discovers models automatically.** Fetches the gateway's `/models` endpoint and builds the provider's model catalog.
- **Keeps the catalog current.** Retries failed initial syncs with exponential backoff and refreshes a working catalog every five minutes.
- **Handles rotating catalogs.** Makes three concurrent model-list requests and merges their results, deduplicating models by ID.
- **Registers chat models only.** Skips invalid entries and models identified as non-chat or as not producing text, such as image, video, embedding, or reranking models.
- **Preserves complete model IDs.** Uses each gateway model ID as its display name, so backend prefixes remain visible and similarly named models stay distinguishable.
- **Uses model metadata when available.** Carries through input modalities, tool-calling capability, and reported context/output limits.
- **Recovers without a restart.** If the gateway or credential is unavailable at startup, the plugin keeps retrying. When a saved OmniRoute credential becomes available, a later retry can populate the catalog.

## Requirements

- An OpenCode2/OpenCode v2 installation that supports the v2 plugin API used by this plugin.
- A running OmniRoute gateway reachable from the OpenCode2 process.
- An OmniRoute API key with permission to call the gateway's models endpoint.

## Installation

Place `omniroute.ts` in the local plugins directory alongside your OpenCode2 configuration. For a standard user configuration, run this from the repository directory:

```sh
mkdir -p ~/.config/opencode/plugins
cp omniroute.ts ~/.config/opencode/plugins/omniroute.ts
```

Keep the layout below: the plugin reads `../opencode.jsonc` relative to its own file.

```text
~/.config/opencode/
├── opencode.jsonc
└── plugins/
    └── omniroute.ts
```

If your OpenCode2 installation uses a different config directory, place the plugin in that directory's `plugins/` folder and keep `opencode.jsonc` in its parent directory.

## Configuration

Add the OmniRoute provider to `opencode.jsonc`. **Do not list individual models**; the plugin supplies the provider's model inventory at runtime.

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "providers": {
    // OmniRoute gateway (OpenAI-compatible). The model list is not configured
    // here: plugins/omniroute.ts fetches /v1/models and keeps this provider's
    // catalog in sync.
    //
    // "env" lets OpenCode pick up OMNIROUTE_API_KEY when the environment has it.
    // Otherwise connect OmniRoute once with /connect; the stored credential is
    // also used by the plugin for model discovery.
    "omniroute": {
      "name": "OmniRoute",
      "env": ["OMNIROUTE_API_KEY"],
      "package": "@opencode/ai/providers/openai-compatible",
      "settings": {
        "baseURL": "https://your-omniroute-endpoint.com/v1"
      }
    }
  }
}
```

Replace `https://your-omniroute-endpoint.com/v1` with your gateway's API base URL. Include `/v1` if that is the prefix used by your OmniRoute endpoint, but **do not append `/models`**: the plugin appends that path itself.

This is the OpenCode v2 provider structure: `providers` (plural), `package`, and `settings.baseURL`. The old `provider` / `npm` / `options` example is not the recommended configuration for this plugin.

### API key

The recommended configuration keeps the secret out of `opencode.jsonc`.

**Option A: Environment variable**

Make `OMNIROUTE_API_KEY` available to the OpenCode2 process:

```sh
export OMNIROUTE_API_KEY="your-omniroute-api-key"
```

The `env` array in the provider configuration tells OpenCode which environment variable to use. The plugin also reads this variable directly.

**Option B: OpenCode2's saved connection**

In OpenCode2, run `/connect` and connect the `omniroute` provider. The plugin can read the saved credential and use it for model discovery.

An OpenCode2 background service may not inherit environment variables exported only in an interactive terminal. If the plugin reports that no API key is available, connect through `/connect` or ensure the variable is present in the service's environment. The plugin retries automatically, so a newly available credential normally does not require a restart.

### Optional base URL override

If the OpenCode2 process has `OMNIROUTE_BASE_URL` set, the plugin uses it instead of `settings.baseURL`. Otherwise, it reads `providers.omniroute.settings.baseURL` from `opencode.jsonc`.

## How it works

1. **Read settings.** The plugin reads `providers.omniroute.settings.baseURL` from `opencode.jsonc`, unless `OMNIROUTE_BASE_URL` overrides it.
2. **Resolve credentials.** It checks `OMNIROUTE_API_KEY`, then a configured provider API key if present, then the credential saved through `/connect`.
3. **Fetch the catalog.** It sends authenticated requests to `{baseURL}/models` (for example, `https://gateway.example/v1/models`). Three requests run concurrently to improve coverage when the gateway's catalog rotates between requests.
4. **Filter and normalize.** The plugin deduplicates valid model IDs, excludes known non-chat models, and builds OpenCode model entries using any available metadata.
5. **Register or refresh.** It registers the inventory through the v2 provider API and reloads the provider when the catalog changes.
6. **Stay in sync.** After a successful sync, it checks again every five minutes. If a sync fails, it retries with exponential backoff starting at two seconds and capped at 60 seconds.

A failed or empty fetch does not replace a previously working catalog with an empty one. A successful sync only reloads the provider when the model inventory or relevant metadata has changed.

## Troubleshooting

### No OmniRoute models appear

- Confirm the plugin is installed in the loaded `plugins/` directory and that `opencode.jsonc` is in its parent directory.
- Check that `settings.baseURL` is the API base URL and includes the correct version prefix (commonly `/v1`). Do not include `/models` in the configured URL.
- Verify that the gateway is reachable and the API key is valid. You can test the endpoint directly:

  ```sh
  curl -sS \
    -H "Authorization: Bearer $OMNIROUTE_API_KEY" \
    "https://your-omniroute-endpoint.com/v1/models"
  ```

- Check the OpenCode2 logs for messages beginning with `[omniroute]`. The plugin logs missing credentials, fetch failures, skipped models, and registration or reload errors.
- If you just connected through `/connect`, allow the background retry to run; retries continue automatically and can be as far apart as 60 seconds.

### Some models are missing

Only models suitable for text/chat sessions are registered. Models whose metadata marks them as non-chat or says they do not output text are intentionally skipped. Check the gateway's `/v1/models` response to see which IDs and metadata it exposes.

### Changes at the gateway are not showing up

The plugin refreshes the catalog every five minutes after a successful sync. It reloads the provider only when the returned model list or relevant metadata changes. Confirm that the endpoint URL targets the expected OmniRoute instance and inspect the `[omniroute]` logs for failed requests.

---

The plugin manages model discovery only; OmniRoute remains responsible for routing each selected model to its configured upstream.

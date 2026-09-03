# OpenCode2 OmniRoute Discovery Plugin

Automatically discover and sync all available models served by a self-hosted OmniRoute endpoint with OpenCode2, eliminating the need to manually enter each model in your configuration file.

## Overview

This plugin enables OpenCode2 to dynamically fetch the complete list of models from your OmniRoute gateway and keep your provider configuration in sync. Instead of static model declarations, your OmniRoute provider will automatically reflect all models available on your endpoint.

## Features

- 🚀 **Automatic Model Discovery** - Fetches the complete `/v1/models` list from your OmniRoute endpoint
- 🔄 **Dynamic Sync** - Keeps your OpenCode2 configuration synchronized with your OmniRoute server
- 🔐 **Secure Credential Management** - Support for both hardcoded and environment variable-based configuration
- 🔌 **OpenAI-Compatible** - Works seamlessly with the `@ai-sdk/openai-compatible` SDK
- ✨ **Zero Manual Configuration** - No need to manually list each model

## Installation

1. Clone or install this plugin into your OpenCode2 plugins directory
2. Ensure your OpenCode2 setup includes the OmniRoute provider configuration

## Setup

### Option 1: Hardcoded Configuration (opencode.jsonc)

Add the OmniRoute provider directly to your `opencode.jsonc` file with your credentials:

```jsonc
{
  "provider": {
    // OmniRoute gateway (OpenAI-compatible). The base URL and API key live in
    // options below. No models are listed here - plugins/omniroute.ts
    // fetches the full /v1/models list and keeps this provider in sync.
    "omniroute": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "OmniRoute",
      "api": "https://your-omniroute-endpoint.com",
      "options": {
        "baseURL": "https://your-omniroute-endpoint.com",
        "apiKey": "your-api-key-here"
      }
    }
  }
}
```

### Option 2: Environment Variables (Recommended for Security)

To keep your credentials out of your configuration file, use environment variables to override the values per machine:

```bash
export OMNIROUTE_BASE_URL="https://your-omniroute-endpoint.com"
export OMNIROUTE_API_KEY="your-api-key-here"
```

Then in your `opencode.jsonc`, use placeholder values:

```jsonc
{
  "provider": {
    // OmniRoute gateway (OpenAI-compatible). The base URL and API key live in
    // options below (env vars OMNIROUTE_BASE_URL / OMNIROUTE_API_KEY override
    // them per machine). No models are listed here - plugins/omniroute.ts
    // fetches the full /v1/models list and keeps this provider in sync.
    "omniroute": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "OmniRoute",
      "api": "YOUR OMNIROUTE BASE URL",
      "options": {
        "baseURL": "YOUR OMNIROUTE BASE URL",
        "apiKey": "YOUR OMNIROUTE API KEY"
      }
    }
  }
}
```

**Note:** Environment variables will override the values in opencode.jsonc, so set them before running OpenCode2.

## How It Works

1. The plugin checks for environment variables (`OMNIROUTE_BASE_URL` and `OMNIROUTE_API_KEY`)
2. If not found, it falls back to values in `opencode.jsonc`
3. Queries your OmniRoute endpoint's `/v1/models` API endpoint
4. Retrieves the complete list of available models
5. Dynamically registers all discovered models with OpenCode2
6. Keeps the provider configuration in sync without manual updates

## Requirements

- OpenCode2 installation
- `@ai-sdk/openai-compatible` package
- A running OmniRoute endpoint
- Valid OmniRoute base URL and API key

## Usage

Once configured, OpenCode2 will automatically:
- Discover all models on startup
- Make all discovered models available for use
- Update the model list when the configuration is reloaded

No additional steps required—your models are ready to use immediately!

## Troubleshooting

### Models not appearing
- Verify your OmniRoute endpoint is accessible
- Check that `OMNIROUTE_BASE_URL` and `OMNIROUTE_API_KEY` are correctly set (either in environment or opencode.jsonc)
- Ensure your API key has permission to access the `/v1/models` endpoint
- Review OpenCode2 plugin logs for error details

### Connection issues
- Test connectivity to your OmniRoute endpoint: `curl https://your-endpoint/v1/models`
- Verify the base URL format (should include protocol: `https://...`)
- Check network/firewall rules if accessing a remote endpoint

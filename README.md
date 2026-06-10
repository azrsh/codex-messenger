# Codex Messenger

Local-first web messenger for talking to Codex with OpenAI Realtime voice input.

## Run

```bash
OPENAI_API_KEY=... npm run dev
```

The app binds to `127.0.0.1` on a random port by default and prints the local URL.
Codex work is sent through `codex app-server`, so created threads appear in Codex
Desktop.

## Environment

- `OPENAI_API_KEY`: required for Realtime session creation.
- `CODEX_MESSENGER_PORT`: optional fixed local port.
- `CODEX_MESSENGER_HOME`: optional local state directory. Defaults to
  `~/.codex-messenger`.
- `CODEX_MESSENGER_CODEX_BIN`: optional Codex binary path. Defaults to `codex`.
- `CODEX_MESSENGER_REALTIME_MODEL`: optional Realtime model. Defaults to
  `gpt-realtime`.
- `CODEX_MESSENGER_REALTIME_VOICE`: optional Realtime voice. Defaults to `marin`.

## Current MVP

- Local-only HTTP server with per-launch capability token.
- Realtime WebRTC session creation with the API key kept local.
- Typed or transcribed text submission to Codex.
- Codex app-server JSON-RPC bridge over stdio.
- Server-Sent Events for Codex progress.

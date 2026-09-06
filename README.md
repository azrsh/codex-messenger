# Codex Messenger

Local-first web messenger for talking to Codex with OpenAI Realtime voice input.

## Run

```bash
OPENAI_API_KEY=... npm run dev
```

`npm run dev` binds to `127.0.0.1:54387` and restarts the server when its imported
source files change. Override the port with `CODEX_MESSENGER_PORT=54388 npm run dev`.
Browser refresh and voice reconnection remain manual after a restart.
`npm start` runs without watching and uses a random port unless one is specified.
Codex work is sent through `codex app-server`, so created threads appear in Codex
Desktop.
When voice is connected, the displayed thread link can be opened in Codex Desktop.

Only one voice connection can be established at a time. Disconnect also cancels
an in-progress connection attempt.

## Tests

`npm test` runs tests without opening network ports and can run inside the Codex
sandbox. `npm run test:integration` separately runs the HTTP tests, which start
a loopback server and require permission to bind a local port. These tests use a
mock Codex executable; neither command calls the real Codex or Realtime service.
Run both commands in a port-enabled environment for the full suite.

## Environment

- `OPENAI_API_KEY`: required for Realtime session creation.
- `OPENAI_BASE_URL`: optional OpenAI API base URL. Defaults to
  `https://api.openai.com/v1`; host-only URLs are treated as API roots and get
  `/v1` appended.
- `OPENAI_API_BASE_URL`: optional fallback alias for `OPENAI_BASE_URL`.
- `CODEX_MESSENGER_PORT`: optional fixed local port.
- `CODEX_MESSENGER_HOME`: optional local state directory. Defaults to
  `~/.codex-messenger`.
- `CODEX_MESSENGER_CODEX_BIN`: optional Codex binary path. Defaults to `codex`.
- `CODEX_MESSENGER_REALTIME_MODEL`: optional Realtime model. Defaults to
  `gpt-realtime`.
- `CODEX_MESSENGER_REALTIME_VOICE`: optional Realtime voice. Defaults to `marin`.

## Current MVP

- Local-only server with the OpenAI API key kept on the server.
- Typed and spoken Codex requests, with corrections and follow-ups to running work.
- Progress updates on request and completion notifications that wait for a pause
  in the conversation.
- Recent conversation context carried into requests and across voice reconnections.
- Codex thread links that open in Codex Desktop.

Realtime is instructed to delegate substantive questions and implicit follow-ups
without requiring the user to mention Codex, while preserving questions as
questions rather than authorization to edit. Dispatch still depends on the
model calling a tool; transcripts are not automatically submitted.

Conversation context is limited to recent messages; interrupted or unconfirmed
audio replies are omitted. Failures to deliver follow-ups or delayed speech
transcriptions are reported without automatically starting replacement work.

Reloading the same tab can recover unfinished requests and pending completion
notifications without resubmitting work. Recovery requires the same server
process and browser origin, plus available browser storage. Restarting the server
or closing the tab prevents this recovery; Codex retains its own thread history.

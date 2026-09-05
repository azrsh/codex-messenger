# Codex Messenger

Local-first web messenger for talking to Codex with OpenAI Realtime voice input.

## Run

```bash
OPENAI_API_KEY=... npm run dev
```

The app binds to `127.0.0.1` on a random port by default and prints the local URL.
Codex work is sent through `codex app-server`, so created threads appear in Codex
Desktop.
When voice is connected, Messenger starts a Codex thread and completes a tiny
initial turn so the displayed `codex://threads/...` link can be opened in Codex
Desktop immediately.

Only one voice connection can be established at a time. Disconnect also cancels
an in-progress connection attempt and releases its microphone, peer connection,
and audio playback. Late completions from cancelled attempts are ignored.
Concurrent Codex connection requests for the same conversation share preparation.
The thread ID is saved before the bootstrap turn, so a model error does not
discard that ID on retry. The ready flag is saved only after bootstrap succeeds.

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

- Local-only HTTP server with per-launch capability token.
- Realtime WebRTC session creation with the API key kept local.
- Realtime `start_codex_request` and `poll_codex_request` tool calls for typed
  or spoken Codex requests.
- `steer_codex_request` for explicit corrections to a running request, using
  app-server `turn/steer` with an expected turn ID. Polling and completion keep
  the original request ID. Starting, completed, or rejected turns report that
  the instruction was not confirmed; they do not start replacement work.
- Codex app-server JSON-RPC bridge over stdio.
- Codex thread deeplinks that are prepared for Codex Desktop on voice connect.
- Server-Sent Events for Codex progress.

Codex completion notifications are temporary internal messages in the Realtime
conversation. After a matching poll returns a terminal result, the app sends a
deletion request for that notification only. User messages, tool calls and
results, and assistant replies remain in the conversation. Unprocessed
notifications remain until a matching terminal poll result is sent in the same
Realtime session.

Completion notifications wait while the user is speaking, a Realtime response
is pending, audio is playing, or a tool call is being handled. They are released
at the next idle point. If a poll supplies the terminal result first, the queued
notification is consumed without a second announcement. Unsent notifications
and unfinished requests survive page reload in the same tab using
`sessionStorage`. Voice reconnection seeds the new Realtime session with reference
history and the active request ID. Result delivery is tracked separately from
sending a notification so an unprocessed completion can be recovered.

Progress polling provides a short description of the current action and bounded
details from commentary, plans, commands, file changes, and tools. Reasoning
items are excluded. The voice agent summarizes these observations in the user's
language without equating an individual action finishing with the whole request
finishing, or inventing an ETA. Polling remains on demand.

Start and steer attach a reference snapshot of received user and assistant
transcripts (up to 24 messages and 24,000 text characters) to the current
instruction. Internal notifications and tool logs are excluded. Older entries
are omitted as whole messages and the omission count is included; the current
instruction is not truncated. Historical requests are context, not work to
repeat, and assistant statements do not grant user authorization.

Audio replies are included as text only after playback completion is reported.
Interrupted or unconfirmed audio is replaced by a marker; the app does not guess
which words were heard from a playback timestamp. This cannot prove that the
user actually heard the audio (for example, with muted speakers).

Dispatch waits up to 1.5 seconds for pending speech transcriptions. If they arrive
later, transcripts associated with that dispatch are sent once as clarification
to the same running turn. Completed turns are never restarted for late context.
Failures to deliver late context are displayed; ambiguous failures are not
automatically retried. The current tool request must still preserve the user's
intent and constraints.

Reload recovery reads the original request's server-side status without
resubmitting it. This requires the same local server process and browser origin;
request tracking is in server memory. If the server restarted or has no matching
request, recovery reports that it is unavailable. It does not restart work.
Closing the tab clears the browser snapshot, while Codex retains its own thread
history. Browser storage being disabled or full disables reload recovery but
does not prevent a live session.

import { createReadStream } from "node:fs";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { CodexBridge } from "./codexBridge.js";
import { getRealtimeModel, openAIEndpoint } from "./openaiConfig.js";
import { ConversationStore } from "./store.js";
import { log } from "./logger.js";
import {
  createCapabilityToken,
  validateApiRequest,
} from "./security.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const rootDir = resolve(__dirname, "..");
const publicDir = join(rootDir, "public");
const port = Number(process.env.CODEX_MESSENGER_PORT || 0);
const host = "127.0.0.1";
const token = createCapabilityToken();
const store = new ConversationStore();
const bridge = new CodexBridge({ cwd: rootDir });
const subscribers = new Map();
const idempotency = new Map();
const realtimeModel = getRealtimeModel();

await store.load();
log("info", "Conversation store loaded", {
  conversations: store.list().length,
});

const mimeTypes = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
};

const server = createServer(async (req, res) => {
  const requestId = randomUUID();
  const startedAt = Date.now();
  const originalWriteHead = res.writeHead.bind(res);
  res.writeHead = (statusCode, ...args) => {
    res.statusCode = statusCode;
    return originalWriteHead(statusCode, ...args);
  };
  res.on("finish", () => {
    log("info", "HTTP request completed", {
      requestId,
      method: req.method,
      url: req.url,
      statusCode: res.statusCode,
      durationMs: Date.now() - startedAt,
    });
  });

  try {
    log("debug", "HTTP request received", {
      requestId,
      method: req.method,
      url: req.url,
      host: req.headers.host,
      origin: req.headers.origin,
      fetchSite: req.headers["sec-fetch-site"],
    });
    await route(req, res, requestId);
  } catch (error) {
    log("error", "Unhandled request error", {
      requestId,
      error: error.message,
      stack: error.stack,
    });
    sendJson(res, 500, { error: error.message || "Internal Server Error" });
  }
});

server.listen(port, host, () => {
  const address = server.address();
  const url = `http://${host}:${address.port}/`;
  console.log(`Codex Messenger running at ${url}`);
  log("info", "Codex Messenger server listening", {
    url,
    pid: process.pid,
    node: process.version,
    cwd: rootDir,
  });
});

async function route(req, res, requestId) {
  const actualPort = server.address().port;
  const url = new URL(req.url, `http://${host}:${actualPort}`);

  if (req.method === "GET" && url.pathname === "/") {
    return serveIndex(res);
  }

  if (req.method === "GET" && url.pathname.startsWith("/assets/")) {
    return serveStatic(url.pathname, res);
  }

  if (url.pathname.startsWith("/api/")) {
    const auth = validateApiRequest(req, {
      token,
      port: actualPort,
      allowQueryToken: url.pathname.endsWith("/events"),
    });
    if (!auth.ok) {
      log("warn", "API auth rejected", {
        requestId,
        path: url.pathname,
        status: auth.status,
        reason: auth.message,
      });
      return sendJson(res, auth.status, { error: auth.message });
    }
  }

  if (req.method === "GET" && url.pathname === "/api/realtime/session") {
    return createRealtimeSession(res, requestId);
  }

  if (req.method === "GET" && url.pathname === "/api/conversations") {
    return sendJson(res, 200, { conversations: store.list() });
  }

  const eventsMatch = /^\/api\/conversations\/([^/]+)\/events$/.exec(url.pathname);
  if (req.method === "GET" && eventsMatch) {
    return subscribe(eventsMatch[1], req, res, requestId);
  }

  if (req.method === "POST" && url.pathname === "/api/codex/message") {
    return handleCodexMessage(req, res, requestId);
  }

  if (req.method === "POST" && url.pathname === "/api/codex/connect") {
    return handleCodexConnect(req, res, requestId);
  }

  if (req.method === "POST" && url.pathname === "/api/codex/interrupt") {
    return handleInterrupt(req, res, requestId);
  }

  sendJson(res, 404, { error: "Not found" });
}

async function serveIndex(res) {
  const html = await readFile(join(publicDir, "index.html"), "utf8");
  const clientConfig = {
    token,
    realtimeCallsUrl: openAIEndpoint("/realtime/calls"),
    realtimeModel,
  };
  const rendered = html.replace(
    "</head>",
    `<script>window.CODEX_MESSENGER_CONFIG=${JSON.stringify(clientConfig)};</script></head>`,
  );
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(rendered);
}

function serveStatic(pathname, res) {
  const relative = pathname.replace(/^\/assets\//, "");
  if (relative.includes("..")) return sendJson(res, 400, { error: "Bad path" });

  const filePath = join(publicDir, relative);
  const stream = createReadStream(filePath);
  stream.on("error", () => sendJson(res, 404, { error: "Not found" }));
  res.writeHead(200, { "Content-Type": mimeTypes[extname(filePath)] || "application/octet-stream" });
  stream.pipe(res);
}

async function createRealtimeSession(res, requestId) {
  if (!process.env.OPENAI_API_KEY) {
    log("warn", "Realtime session requested without OPENAI_API_KEY", { requestId });
    return sendJson(res, 500, { error: "OPENAI_API_KEY is not set" });
  }

  const startCodexRequestTool = {
    type: "function",
    name: "start_codex_request",
    description:
      "Start a substantive user request in Codex app-server. Returns quickly with a request id; use poll_codex_request to check progress.",
    parameters: {
      type: "object",
      properties: {
        message: {
          type: "string",
          description:
            "The user's request to Codex. Preserve concrete details, constraints, file names, and quoted text.",
        },
      },
      required: ["message"],
      additionalProperties: false,
    },
  };
  const pollCodexRequestTool = {
    type: "function",
    name: "poll_codex_request",
    description:
      "Check the current status of a Codex request that was started with start_codex_request.",
    parameters: {
      type: "object",
      properties: {
        requestId: {
          type: "string",
          description: "The request id returned by start_codex_request.",
        },
      },
      required: ["requestId"],
      additionalProperties: false,
    },
  };

  const session = {
    session: {
      type: "realtime",
      model: realtimeModel,
      audio: {
        input: {
          transcription: { model: "gpt-4o-mini-transcribe" },
        },
        output: {
          voice: process.env.CODEX_MESSENGER_REALTIME_VOICE || "marin",
        },
      },
      tools: [startCodexRequestTool, pollCodexRequestTool],
      tool_choice: "auto",
      instructions: `
You are the realtime junior agent for Codex Messenger. Codex app-server is your supervisor and owns all substantive coding work.

# Core behavior
- For greetings, thanks, short acknowledgements, or requests to repeat yourself, respond directly and briefly.
- For any coding request, repository question, file inspection, implementation request, debugging request, planning request, or anything that should be handled by Codex, you MUST call start_codex_request.
- Before calling start_codex_request, say a short neutral filler phrase such as "One moment." or "Let me check."
- Do not answer substantive Codex requests yourself.
- Do not summarize away details when calling start_codex_request. Preserve the user's concrete request, constraints, file paths, selected text, and quoted text.
- After start_codex_request returns, briefly tell the user Codex is working, then use poll_codex_request whenever the app prompts you to check status.
- While poll_codex_request returns "running", give concise spoken progress updates without inventing details.
- When poll_codex_request returns "completed", relay Codex's final response naturally and concisely.
- If Codex reports that it is already working, tell the user briefly and do not start another task.
      `.trim(),
    },
  };

  log("info", "Creating Realtime client secret", {
    requestId,
    model: session.session.model,
    voice: session.session.audio.output.voice,
  });
  const response = await fetch(openAIEndpoint("/realtime/client_secrets"), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(session),
  });

  const text = await response.text();
  log(response.ok ? "info" : "warn", "Realtime client secret response", {
    requestId,
    status: response.status,
    ok: response.ok,
    responseChars: text.length,
  });
  res.writeHead(response.status, {
    "Content-Type": response.headers.get("content-type") || "application/json",
  });
  res.end(text);
}

async function handleCodexMessage(req, res, requestId) {
  const body = await readJson(req);
  const conversationId = body.conversationId || randomUUID();
  const idempotencyKey = body.idempotencyKey;
  const message = String(body.message || "").trim();

  if (!idempotencyKey) {
    log("warn", "Codex message missing idempotency key", { requestId, conversationId });
    return sendJson(res, 400, { error: "idempotencyKey is required" });
  }
  if (!message) {
    log("warn", "Codex message missing body", { requestId, conversationId });
    return sendJson(res, 400, { error: "message is required" });
  }

  const dedupeKey = `${conversationId}:${idempotencyKey}`;
  if (idempotency.has(dedupeKey)) {
    log("info", "Codex message idempotency hit", {
      requestId,
      conversationId,
      idempotencyKey,
    });
    return sendJson(res, 202, await idempotency.get(dedupeKey));
  }

  log("info", "Codex message accepted", {
    requestId,
    conversationId,
    idempotencyKey,
    inputChars: message.length,
  });
  const promise = runCodexTurn(conversationId, message);
  idempotency.set(dedupeKey, promise);

  try {
    const result = await promise;
    idempotency.set(dedupeKey, Promise.resolve(result));
    sendJson(res, 200, result);
  } catch (error) {
    idempotency.delete(dedupeKey);
    log("error", "Codex message failed", {
      requestId,
      conversationId,
      error: error.message,
      stack: error.stack,
    });
    publish(conversationId, "error", { message: error.message });
    sendJson(res, 500, { error: error.message });
  }
}

async function handleCodexConnect(req, res, requestId) {
  const body = await readJson(req);
  const conversationId = body.conversationId || randomUUID();

  try {
    log("info", "Codex connect requested", {
      requestId,
      conversationId,
    });
    const conversation = await ensureCodexThread(conversationId);
    log("info", "Codex connect completed", {
      requestId,
      conversationId,
      threadId: conversation.codexThreadId,
    });
    sendJson(res, 200, { conversation });
  } catch (error) {
    log("error", "Codex connect failed", {
      requestId,
      conversationId,
      error: error.message,
      stack: error.stack,
    });
    publish(conversationId, "error", { message: error.message });
    sendJson(res, 500, { error: error.message });
  }
}

async function ensureCodexThread(conversationId) {
  const conversation = await store.ensure(conversationId);
  log("info", "Ensuring Codex thread", {
    conversationId,
    existingThreadId: conversation.codexThreadId,
    ready: Boolean(conversation.codexThreadReadyAt),
  });
  const prepared = await prepareCodexThread(conversation);
  const { thread } = prepared;
  const updated = await store.update(conversationId, {
    codexThreadId: thread.id,
    codexThreadReadyAt: prepared.bootstrapped
      ? Date.now()
      : conversation.codexThreadReadyAt || Date.now(),
    lastKnownTitle: conversation.lastKnownTitle,
  });

  log("info", "Codex thread ready", {
    conversationId,
    threadId: thread.id,
    bootstrapped: prepared.bootstrapped,
  });
  publish(conversationId, "codex_connected", {
    conversation: updated,
    thread,
    deeplink: `codex://threads/${thread.id}`,
  });

  return updated;
}

async function prepareCodexThread(conversation) {
  try {
    return await bridge.prepareThreadForDesktop(conversation, {
      onEvent: (event) => publish(conversation.conversationId, "codex_event", event),
    });
  } catch (error) {
    if (!conversation.codexThreadId || !isMissingRolloutError(error)) throw error;

    log("warn", "Saved Codex thread has no rollout; creating a replacement", {
      conversationId: conversation.conversationId,
      threadId: conversation.codexThreadId,
      error: error.message,
    });
    const reset = await store.update(conversation.conversationId, {
      codexThreadId: null,
      codexThreadReadyAt: null,
    });
    return bridge.prepareThreadForDesktop(reset, {
      onEvent: (event) => publish(conversation.conversationId, "codex_event", event),
    });
  }
}

function isMissingRolloutError(error) {
  return /no rollout found/i.test(error.message || "");
}

async function runCodexTurn(conversationId, message) {
  const conversation = await store.ensure(conversationId);
  log("info", "Running Codex turn", {
    conversationId,
    existingThreadId: conversation.codexThreadId,
    inputChars: message.length,
  });
  publish(conversationId, "user_message", { message });

  const result = await bridge.runTurn({
    conversation,
    message,
    onEvent: (event) => publish(conversationId, "codex_event", event),
  });

  const title = message.length > 80 ? `${message.slice(0, 77)}...` : message;
  const updated = await store.update(conversationId, {
    codexThreadId: result.threadId,
    codexThreadReadyAt: conversation.codexThreadReadyAt || Date.now(),
    lastKnownTitle: title,
  });

  log("info", "Codex turn stored", {
    conversationId,
    threadId: result.threadId,
    turnId: result.turnId,
    finalChars: result.finalText.length,
  });
  publish(conversationId, "final", {
    finalText: result.finalText,
    conversation: updated,
  });

  return {
    conversation: updated,
    finalText: result.finalText,
    turnId: result.turnId,
  };
}

async function handleInterrupt(req, res, requestId) {
  const body = await readJson(req);
  const conversation = store.get(body.conversationId);
  if (!conversation?.codexThreadId) {
    log("warn", "Interrupt requested without Codex thread", {
      requestId,
      conversationId: body.conversationId,
    });
    return sendJson(res, 404, { error: "Conversation has no Codex thread" });
  }

  log("info", "Interrupting Codex turn", {
    requestId,
    conversationId: conversation.conversationId,
    threadId: conversation.codexThreadId,
  });
  await bridge.interrupt(conversation.codexThreadId);
  publish(conversation.conversationId, "interrupt", {});
  sendJson(res, 200, { ok: true });
}

function subscribe(conversationId, req, res, requestId) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
  });
  res.write("retry: 1000\n\n");

  const set = subscribers.get(conversationId) || new Set();
  set.add(res);
  subscribers.set(conversationId, set);
  log("info", "SSE subscriber connected", {
    requestId,
    conversationId,
    subscribers: set.size,
  });

  req.on("close", () => {
    set.delete(res);
    if (set.size === 0) subscribers.delete(conversationId);
    log("info", "SSE subscriber disconnected", {
      requestId,
      conversationId,
      subscribers: set.size,
    });
  });
}

function publish(conversationId, event, data) {
  const set = subscribers.get(conversationId);
  log("debug", "Publishing SSE event", {
    conversationId,
    event,
    subscribers: set?.size || 0,
  });
  if (!set) return;
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of set) res.write(payload);
}

async function readJson(req) {
  if (!String(req.headers["content-type"] || "").includes("application/json")) {
    throw new Error("Expected application/json");
  }

  let body = "";
  for await (const chunk of req) {
    body += chunk;
    if (body.length > 1024 * 1024) throw new Error("Request body too large");
  }
  return JSON.parse(body || "{}");
}

function sendJson(res, status, payload) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(`${JSON.stringify(payload)}\n`);
}

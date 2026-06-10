import { createReadStream } from "node:fs";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { CodexBridge } from "./codexBridge.js";
import { getRealtimeModel, openAIEndpoint } from "./openaiConfig.js";
import { ConversationStore } from "./store.js";
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

const mimeTypes = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
};

const server = createServer(async (req, res) => {
  try {
    await route(req, res);
  } catch (error) {
    console.error(error);
    sendJson(res, 500, { error: error.message || "Internal Server Error" });
  }
});

server.listen(port, host, () => {
  const address = server.address();
  const url = `http://${host}:${address.port}/`;
  console.log(`Codex Messenger running at ${url}`);
});

async function route(req, res) {
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
    if (!auth.ok) return sendJson(res, auth.status, { error: auth.message });
  }

  if (req.method === "GET" && url.pathname === "/api/realtime/session") {
    return createRealtimeSession(res);
  }

  if (req.method === "GET" && url.pathname === "/api/conversations") {
    return sendJson(res, 200, { conversations: store.list() });
  }

  const eventsMatch = /^\/api\/conversations\/([^/]+)\/events$/.exec(url.pathname);
  if (req.method === "GET" && eventsMatch) {
    return subscribe(eventsMatch[1], req, res);
  }

  if (req.method === "POST" && url.pathname === "/api/codex/message") {
    return handleCodexMessage(req, res);
  }

  if (req.method === "POST" && url.pathname === "/api/codex/interrupt") {
    return handleInterrupt(req, res);
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

async function createRealtimeSession(res) {
  if (!process.env.OPENAI_API_KEY) {
    return sendJson(res, 500, { error: "OPENAI_API_KEY is not set" });
  }

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
      instructions:
        "You are a voice interface for Codex Messenger. Keep responses brief. The app will send finalized user requests to Codex.",
    },
  };

  const response = await fetch(openAIEndpoint("/realtime/client_secrets"), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(session),
  });

  const text = await response.text();
  res.writeHead(response.status, {
    "Content-Type": response.headers.get("content-type") || "application/json",
  });
  res.end(text);
}

async function handleCodexMessage(req, res) {
  const body = await readJson(req);
  const conversationId = body.conversationId || randomUUID();
  const idempotencyKey = body.idempotencyKey;
  const message = String(body.message || "").trim();

  if (!idempotencyKey) return sendJson(res, 400, { error: "idempotencyKey is required" });
  if (!message) return sendJson(res, 400, { error: "message is required" });

  const dedupeKey = `${conversationId}:${idempotencyKey}`;
  if (idempotency.has(dedupeKey)) {
    return sendJson(res, 202, await idempotency.get(dedupeKey));
  }

  const promise = runCodexTurn(conversationId, message);
  idempotency.set(dedupeKey, promise);

  try {
    const result = await promise;
    idempotency.set(dedupeKey, Promise.resolve(result));
    sendJson(res, 200, result);
  } catch (error) {
    idempotency.delete(dedupeKey);
    publish(conversationId, "error", { message: error.message });
    sendJson(res, 500, { error: error.message });
  }
}

async function runCodexTurn(conversationId, message) {
  const conversation = await store.ensure(conversationId);
  publish(conversationId, "user_message", { message });

  const result = await bridge.runTurn({
    conversation,
    message,
    onEvent: (event) => publish(conversationId, "codex_event", event),
  });

  const title = message.length > 80 ? `${message.slice(0, 77)}...` : message;
  const updated = await store.update(conversationId, {
    codexThreadId: result.threadId,
    lastKnownTitle: title,
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

async function handleInterrupt(req, res) {
  const body = await readJson(req);
  const conversation = store.get(body.conversationId);
  if (!conversation?.codexThreadId) {
    return sendJson(res, 404, { error: "Conversation has no Codex thread" });
  }

  await bridge.interrupt(conversation.codexThreadId);
  publish(conversation.conversationId, "interrupt", {});
  sendJson(res, 200, { ok: true });
}

function subscribe(conversationId, req, res) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
  });
  res.write("retry: 1000\n\n");

  const set = subscribers.get(conversationId) || new Set();
  set.add(res);
  subscribers.set(conversationId, set);

  req.on("close", () => {
    set.delete(res);
    if (set.size === 0) subscribers.delete(conversationId);
  });
}

function publish(conversationId, event, data) {
  const set = subscribers.get(conversationId);
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

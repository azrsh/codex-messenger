import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

test("HTTP recovery reads the existing turn and steering completes that same request", { timeout: 15000 }, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "messenger-recovery-"));
  const fake = join(dir, "codex.cjs");
  await writeFile(fake, `#!${process.execPath}
const readline = require('node:readline');
let starts = 0;
let status = 'inProgress';
const send = value => process.stdout.write(JSON.stringify(value) + '\\n');
readline.createInterface({ input: process.stdin }).on('line', line => {
  const m = JSON.parse(line);
  if (!m.id) return;
  let result = {};
  if (m.method === 'thread/start') result = { thread: { id: 'thread-1' } };
  if (m.method === 'turn/start') {
    starts++;
    result = { turn: { id: 'turn-1', status } };
  }
  if (m.method === 'thread/read') result = { thread: { id: 'thread-1', turns: [{ id: 'turn-1', status, items: [] }] } };
  if (m.method === 'turn/steer') {
    result = { turnId: 'turn-1' };
    setTimeout(() => {
      status = 'completed';
      send({ method: 'item/completed', params: { threadId: 'thread-1', turnId: 'turn-1', item: { type: 'agentMessage', text: 'starts=' + starts } } });
      send({ method: 'turn/completed', params: { threadId: 'thread-1', turn: { id: 'turn-1', status } } });
    }, 20);
  }
  send({ id: m.id, result });
});
`, { mode: 0o755 });
  const server = spawn(process.execPath, ["src/server.js"], {
    cwd: new URL("..", import.meta.url), detached: true,
    env: { ...process.env, CODEX_MESSENGER_HOME: dir, CODEX_MESSENGER_PORT: "0", CODEX_MESSENGER_CODEX_BIN: fake },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const exited = once(server, "exit");
  t.after(async () => {
    if (server.exitCode === null) process.kill(-server.pid, "SIGTERM");
    await exited;
    await rm(dir, { recursive: true, force: true });
  });
  const base = await new Promise((resolve, reject) => {
    let output = "";
    let errors = "";
    server.stderr.on("data", (chunk) => { errors += chunk; });
    server.stdout.on("data", (chunk) => {
      output += chunk;
      const match = output.match(/Codex Messenger running at (http:\/\/[^\s]+)/);
      if (match) resolve(match[1]);
    });
    server.once("exit", () => reject(new Error(`Server exited before listening: ${errors}`)));
    server.once("error", reject);
  });
  const html = await (await fetch(base)).text();
  const config = JSON.parse(html.match(/window.CODEX_MESSENGER_CONFIG=(.*?);<\/script>/)[1]);
  const post = async (path, body) => {
    const response = await fetch(new URL(path, base), {
      method: "POST", headers: { Authorization: `Bearer ${config.token}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  };
  const identity = { conversationId: "conversation-1", idempotencyKey: "realtime:request-1" };
  const pending = post("/api/codex/message", { ...identity, message: "Work" });
  let running;
  for (let attempt = 0; attempt < 100; attempt++) {
    running = await post("/api/codex/status", identity);
    if (running.body.turnId) break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(running.body.status, "running");
  assert.equal(running.body.turnId, "turn-1");
  const steer = await post("/api/codex/steer", { conversationId: identity.conversationId, turnId: "turn-1", idempotencyKey: "steer-1", message: "Finish" });
  // No prepared thread is stored until the turn finishes in this fixture.
  if (steer.status === 404) {
    throw new Error("Steering must resolve the active request before the first turn completes");
  }
  assert.equal(steer.status, 200);
  assert.equal((await pending).body.finalText, "starts=1");
  const recovered = await post("/api/codex/status", identity);
  assert.equal(recovered.body.status, "completed");
  assert.equal(recovered.body.finalText, "starts=1");
  assert.equal((await post("/api/codex/status", { ...identity, idempotencyKey: "unknown" })).status, 404);
});

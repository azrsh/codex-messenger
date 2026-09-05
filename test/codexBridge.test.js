import test from "node:test";
import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import { CodexBridge } from "../src/codexBridge.js";

function completed(threadId, turnId, status = "completed", error) {
  return { method: "turn/completed", params: { threadId, turn: { id: turnId, status, error } } };
}

function assistantMessage(threadId, turnId, text) {
  return {
    method: "item/completed",
    params: { threadId, turnId, item: { type: "agentMessage", text } },
  };
}

test("concurrent turns forward only their own events, once, and clean up listeners", async () => {
  const bridge = new CodexBridge();
  bridge.startOrResumeThread = async (conversation) => ({ id: conversation.codexThreadId });
  bridge.request = async (_method, { threadId }) => ({ turn: { id: `turn-${threadId}`, status: "inProgress" } });
  const seenA = [];
  const seenB = [];
  const run = (id, seen) => bridge.runTurn({
    conversation: { conversationId: id, codexThreadId: id },
    message: "hello",
    onEvent: (event) => seen.push(event),
  });
  const a = run("A", seenA);
  const b = run("B", seenB);
  await setImmediate();
  bridge.emit("event", assistantMessage("A", "old-turn", "stale"));
  bridge.emit("event", { method: "global/event", params: {} });
  bridge.emit("event", assistantMessage("B", "turn-B", "answer B"));
  bridge.emit("event", assistantMessage("A", "turn-A", "answer A"));
  bridge.emit("event", completed("B", "turn-B"));
  bridge.emit("event", completed("A", "turn-A"));
  assert.equal((await a).finalText, "answer A");
  assert.equal((await b).finalText, "answer B");
  for (const [id, seen] of [["A", seenA], ["B", seenB]]) {
    assert.deepEqual(seen.map((event) => event.method), ["turn/started", "item/completed", "turn/completed"]);
    assert.ok(seen.every((event) => event.params.threadId === id));
  }
  assert.equal(bridge.listenerCount("event"), 0);
});

for (const [status, error, expected] of [
  ["failed", { message: "Provider failure" }, /Provider failure/],
  ["failed", undefined, /Codex turn failed/],
  ["interrupted", undefined, /Codex turn interrupted/],
]) {
  test(`a ${status} turn rejects instead of returning partial output (${expected})`, async () => {
    const bridge = new CodexBridge();
    const pending = bridge.waitForTurn("A", "1");
    bridge.emit("event", assistantMessage("A", "1", "partial output"));
    bridge.emit("event", completed("A", "1", status, error));
    await assert.rejects(pending, expected);
    assert.equal(bridge.listenerCount("event"), 0);
  });
}

test("thread-scoped status events are forwarded only to the matching thread", async () => {
  const bridge = new CodexBridge();
  const seen = [];
  const pending = bridge.waitForTurn("A", "1", (event) => seen.push(event));
  const status = { method: "thread/status/changed", params: { threadId: "A", status: { type: "active" } } };
  bridge.emit("event", { ...status, params: { ...status.params, threadId: "B" } });
  bridge.emit("event", status);
  bridge.emit("event", completed("A", "1"));
  await pending;
  assert.deepEqual(seen, [status, completed("A", "1")]);
});

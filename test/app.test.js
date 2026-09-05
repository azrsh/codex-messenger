import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const source = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");

function createApp(fetch = async () => { throw new Error("Unexpected request"); }) {
  const elements = new Map();
  const makeElement = () => ({
    textContent: "",
    children: [],
    addEventListener() {},
    append(child) { this.children.push(child); },
    scrollIntoView() {},
  });
  const context = vm.createContext({
    window: {},
    crypto: { randomUUID: () => "conversation-1" },
    document: {
      querySelector(selector) {
        if (!elements.has(selector)) elements.set(selector, makeElement());
        return elements.get(selector);
      },
      createElement: makeElement,
    },
    EventSource: class {
      addEventListener() {}
      close() {}
    },
    fetch,
  });
  vm.runInContext(source, context);
  const state = vm.runInContext("state", context);
  const sent = [];
  state.dataChannel = {
    readyState: "open",
    send: (message) => sent.push(JSON.parse(message)),
  };
  return { context, state, sent, elements };
}

function jsonResponse(body, ok = true) {
  return {
    ok,
    headers: { get: () => "application/json" },
    json: async () => body,
  };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

test("renders completed GA audio transcripts and text", () => {
  const { context, elements } = createApp();
  context.handleRealtimeEvent({
    type: "response.output_audio_transcript.done",
    transcript: "  Spoken response  ",
  });
  context.handleRealtimeEvent({ type: "response.output_text.done", text: "  Text response  " });
  context.handleRealtimeEvent({ type: "response.output_text.done", text: "  " });
  assert.deepEqual(
    elements.get("#messages").children
      .filter((node) => node.className === "message assistant")
      .map((node) => node.textContent),
    ["Spoken response", "Text response"],
  );
});

test("duplicate function events execute and publish one result, during and after execution", async () => {
  let resolveFetch;
  let fetchCount = 0;
  const { context, state, sent } = createApp(() => {
    fetchCount += 1;
    return new Promise((resolve) => { resolveFetch = resolve; });
  });
  state.codexJobs.set("request-1", {
    requestId: "request-1",
    turnId: "turn-1",
    status: "running",
    startedAt: Date.now(),
  });
  const item = {
    type: "function_call",
    call_id: "call-1",
    name: "poll_codex_request",
    arguments: JSON.stringify({ requestId: "request-1" }),
  };
  const events = [
    { ...item, type: "response.function_call_arguments.done" },
    { type: "response.output_item.done", item },
    { type: "response.done", response: { output: [item] } },
  ];
  for (const event of events) context.handleRealtimeEvent(event);
  assert.equal(fetchCount, 1);
  assert.equal(sent.length, 0);

  resolveFetch(jsonResponse({ status: "completed", finalText: "Finished" }));
  await flush();
  for (const event of events) context.handleRealtimeEvent(event);
  await flush();

  assert.equal(fetchCount, 1);
  assert.equal(sent.length, 2);
  assert.equal(sent[0].item.type, "function_call_output");
  assert.equal(sent[0].item.call_id, "call-1");
  assert.equal(JSON.parse(sent[0].item.output).finalText, "Finished");
  assert.deepEqual(sent[1], {
    type: "response.create",
    response: { output_modalities: ["audio"] },
  });
});

for (const ok of [true, false]) {
  test(`completion notification reports ${ok ? "completed" : "failed"} and uses GA audio output`, async () => {
    const { context, state, sent } = createApp(async () => jsonResponse(
      ok ? { finalText: "Finished" } : { error: "Codex turn failed: provider error" },
      ok,
    ));
    context.startCodexJob("Do the work", "request-1");
    await flush();

    const expectedStatus = ok ? "completed" : "failed";
    assert.equal(state.codexJobs.get("request-1").status, expectedStatus);
    assert.equal(state.codexRunning, false);
    assert.equal(sent.length, 2);
    assert.match(sent[0].item.content[0].text, new RegExp(`request request-1 is ${expectedStatus}\\.`));
    assert.deepEqual(sent[1], {
      type: "response.create",
      response: { output_modalities: ["audio"] },
    });
  });
}

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const source = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");

function createApp(fetch = async () => { throw new Error("Unexpected request"); }, sessionStorage) {
  const elements = new Map();
  const makeElement = () => ({
    textContent: "",
    children: [],
    addEventListener() {},
    append(child) { this.children.push(child); },
    scrollIntoView() {},
  });
  const context = vm.createContext({
    window: { sessionStorage },
    setTimeout,
    clearTimeout,
    crypto: { randomUUID },
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

function jsonResponse(body, ok = true, status = ok ? 200 : 500) {
  return {
    ok,
    status,
    headers: { get: () => "application/json" },
    json: async () => body,
  };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

function createConnectionApp() {
  const calls = [];
  const peers = [];
  const streams = [];
  const app = createApp(async (url) => {
    calls.push(url);
    if (url === "/api/codex/connect") return jsonResponse({ conversation: { codexThreadId: "thread-1" } });
    if (url === "/api/realtime/session") return jsonResponse({ value: "mock" });
    return { ok: true, text: async () => "mock-sdp" };
  });
  app.state.dataChannel = null;
  app.context.URL = URL;
  app.context.requestMicrophone = async () => {
    const track = { stopped: false, stop() { this.stopped = true; } };
    const stream = { getTracks: () => [track] };
    streams.push(stream);
    return stream;
  };
  app.context.RTCPeerConnection = class {
    constructor() { this.closed = false; peers.push(this); }
    addTrack() {}
    createDataChannel() { return { readyState: "open", send() {}, close() {} }; }
    async createOffer() { return { sdp: "mock-offer" }; }
    async setLocalDescription() {}
    async setRemoteDescription() {}
    getSenders() { return []; }
    close() { this.closed = true; }
  };
  return { ...app, calls, peers, streams };
}

test("repeated connect creates one peer and disconnect closes every owned resource", async () => {
  const { context, state, peers, calls, streams, elements } = createConnectionApp();
  const first = context.connectRealtime();
  assert.equal(elements.get("#connectRealtime").disabled, true);
  await Promise.all([first, context.connectRealtime()]);
  await context.connectRealtime();
  assert.equal(peers.length, 1);
  assert.equal(calls.filter((path) => path === "/api/codex/connect").length, 1);
  const audio = state.audioElement;
  audio.srcObject = streams[0];
  context.disconnectRealtime();
  assert.equal(peers.filter((peer) => !peer.closed).length, 0);
  assert.ok(streams.every((stream) => stream.getTracks()[0].stopped));
  assert.equal(audio.srcObject, null);
});

test("cancelled microphone acquisition cannot revive or replace a later connection", async () => {
  const { context, state, peers } = createConnectionApp();
  const normalMicrophone = context.requestMicrophone;
  let resolveMicrophone;
  context.requestMicrophone = () => new Promise((resolve) => { resolveMicrophone = resolve; });
  const stale = context.connectRealtime();
  context.disconnectRealtime();
  context.requestMicrophone = normalMicrophone;
  await context.connectRealtime();
  const current = state.peerConnection;
  const lateTrack = { stopped: false, stop() { this.stopped = true; } };
  resolveMicrophone({ getTracks: () => [lateTrack] });
  await stale;
  assert.equal(state.peerConnection, current);
  assert.equal(peers.length, 1);
  assert.equal(lateTrack.stopped, true);
  context.disconnectRealtime();
});

test("failure from a cancelled SDP request does not disconnect the new peer", async () => {
  const { context, state, peers } = createConnectionApp();
  const normalFetch = context.fetch;
  let rejectSdp;
  context.fetch = (url) => String(url).startsWith("https:")
    ? new Promise((_resolve, reject) => { rejectSdp = reject; }) : normalFetch(url);
  const stale = context.connectRealtime();
  await flush();
  context.disconnectRealtime();
  context.fetch = normalFetch;
  await context.connectRealtime();
  const current = state.peerConnection;
  rejectSdp(new Error("old connection failed"));
  await stale;
  assert.equal(state.peerConnection, current);
  assert.equal(current.closed, false);
  assert.equal(peers[0].closed, true);
  context.disconnectRealtime();
});

test("definitively missing recovery releases the active request without replay", async () => {
  const { context, state } = createApp(async () => jsonResponse({ error: "Unknown request" }, false, 404));
  state.codexRunning = true;
  state.activeCodexRequestId = "request-1";
  const job = { requestId: "request-1", recovered: true, status: "running" };
  state.codexJobs.set(job.requestId, job);
  await context.recoverCodexJob();
  assert.equal(job.status, "unavailable");
  assert.equal(state.codexRunning, false);
  assert.equal(state.activeCodexRequestId, null);
});

test("poll from a previous voice connection cannot mark the result delivered", async () => {
  let resolveFetch;
  const { context, state, sent } = createApp(() => new Promise((resolve) => { resolveFetch = resolve; }));
  const job = { requestId: "request-1", turnId: "turn-1", status: "running", startedAt: Date.now() };
  state.codexJobs.set(job.requestId, job);
  const pending = context.handleRealtimeToolCall({ callId: "old-poll", name: "poll_codex_request", arguments: JSON.stringify({ requestId: job.requestId }) });
  state.dataChannel.close = () => {};
  const oldChannel = state.dataChannel;
  context.disconnectRealtime();
  state.dataChannel = { ...oldChannel };
  resolveFetch(jsonResponse({ status: "completed", finalText: "Finished" }));
  await pending;
  assert.notEqual(job.resultDelivered, true);
  assert.equal(sent.some((event) => event.item?.call_id === "old-poll"), false);
  assert.equal(sent[0].item.type, "message");
});

test("reconnect requeues an unprocessed completion notification", () => {
  const { context, state, sent } = createApp();
  const job = { requestId: "request-1", status: "completed" };
  state.codexJobs.set(job.requestId, job);
  context.notifyCodexStatusChanged(job.requestId, job.status);
  assert.equal(sent.length, 2);
  state.dataChannel.close = () => {};
  const oldChannel = state.dataChannel;
  context.disconnectRealtime();
  state.dataChannel = { ...oldChannel };
  context.flushCodexNotifications();
  assert.equal(sent.length, 4);
  assert.notEqual(sent[0].item.id, sent[2].item.id);
});

test("interrupted audio is omitted even if the transcript arrives after interruption", () => {
  const { context } = createApp();
  context.handleRealtimeEvent({ type: "response.created", response: { id: "response-1" } });
  context.handleRealtimeEvent({ type: "output_audio_buffer.started", response_id: "response-1" });
  context.handleRealtimeEvent({ type: "input_audio_buffer.speech_started" });
  context.handleRealtimeEvent({ type: "response.output_audio_transcript.done", response_id: "response-1", item_id: "audio-1", content_index: 0, transcript: "Unheard instruction" });
  context.handleRealtimeEvent({ type: "output_audio_buffer.stopped", response_id: "response-1" });
  const history = context.historyForContext();
  assert.equal(history[0].playback, "interrupted");
  assert.equal(JSON.stringify(history).includes("Unheard instruction"), false);
});

test("only playback completion makes audio text available to Codex", () => {
  const { context } = createApp();
  context.handleRealtimeEvent({ type: "response.output_audio_transcript.done", response_id: "response-1", item_id: "audio-1", transcript: "A useful explanation" });
  assert.equal(context.historyForContext()[0].playback, "pending");
  context.handleRealtimeEvent({ type: "output_audio_buffer.started", response_id: "response-1" });
  context.handleRealtimeEvent({ type: "output_audio_buffer.stopped", response_id: "response-1" });
  assert.equal(context.historyForContext()[0].text, "A useful explanation");
  context.handleRealtimeEvent({ type: "conversation.item.truncated", item_id: "audio-1", content_index: 0 });
  assert.equal(context.historyForContext()[0].playback, "interrupted");
});

test("dispatch waits for a delayed transcript and keeps speech order", async () => {
  const requests = [];
  const { context } = createApp(async (_url, options) => {
    requests.push(JSON.parse(options.body));
    return jsonResponse({ finalText: "Done" });
  });
  context.handleRealtimeEvent({ type: "input_audio_buffer.speech_started", item_id: "voice-1" });
  context.handleRealtimeEvent({ type: "response.output_text.done", item_id: "answer-1", text: "Checking." });
  const pending = context.executeRealtimeToolCall({ name: "start_codex_request", callId: "start-1", arguments: JSON.stringify({ message: "Apply it" }) });
  await flush();
  assert.equal(requests.length, 0);
  context.handleRealtimeEvent({ type: "conversation.item.input_audio_transcription.completed", item_id: "voice-1", transcript: "Apply option A" });
  await pending;
  const payload = JSON.parse(requests[0].message.split("\n\n").at(-1));
  assert.equal(payload.recentConversation[0].text, "Apply option A");
  assert.equal(payload.pendingTranscriptions, 0);
  await flush();
});

test("late context is delivered once to its existing turn, never a new request", async () => {
  const requests = [];
  const { context, state } = createApp(async (url, options) => {
    requests.push({ url, body: JSON.parse(options.body) });
    return jsonResponse({ ok: true, turnId: "turn-1" });
  });
  state.codexJobs.set("request-1", { requestId: "request-1", status: "running", turnId: "turn-1", pendingTranscriptIds: ["voice-1"] });
  const event = { type: "conversation.item.input_audio_transcription.completed", item_id: "voice-1", transcript: "Keep the API" };
  context.handleRealtimeEvent(event);
  context.handleRealtimeEvent(event);
  await flush();
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, "/api/codex/steer");
  assert.equal(requests[0].body.turnId, "turn-1");
  assert.match(requests[0].body.message, /Keep the API/);
});

test("reload restores a running request and reads status without resubmitting", async () => {
  const values = new Map();
  const storage = { getItem: (key) => values.get(key), setItem: (key, value) => values.set(key, value) };
  const first = createApp(undefined, storage);
  first.context.recordRealtimeMessage("user", "Keep my constraints");
  first.state.codexJobs.set("request-1", { requestId: "request-1", status: "running", startedAt: Date.now() });
  first.context.persistConversation();
  const requests = [];
  const second = createApp(async (url, options) => {
    requests.push({ url, body: JSON.parse(options.body) });
    return jsonResponse({ status: "completed", finalText: "Recovered result", turnId: "turn-1" });
  }, storage);
  assert.equal(second.state.conversationId, first.state.conversationId);
  assert.equal(second.state.codexRunning, true);
  await second.context.recoverCodexJob();
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, "/api/codex/status");
  assert.equal(requests[0].body.idempotencyKey, "realtime:request-1");
  assert.equal(second.state.codexRunning, false);
  assert.equal(second.state.codexJobs.get("request-1").finalText, "Recovered result");
  assert.equal(second.sent.length, 2);
});

test("unavailable recovery never replays the request", async () => {
  let requests = 0;
  const { context, state } = createApp(async () => { requests++; return jsonResponse({ error: "Unknown request" }, false); });
  state.activeCodexRequestId = "request-1";
  const job = { requestId: "request-1", status: "running", recovered: true };
  state.codexJobs.set(job.requestId, job);
  await context.recoverCodexJob();
  assert.equal(requests, 1);
  assert.match(job.progress, /Recovery unavailable/);
});

function pendingCompletion(app) {
  app.state.codexJobs.set("request-1", {
    requestId: "request-1", status: "completed", startedAt: Date.now(), finalText: "Finished",
  });
  app.context.notifyCodexStatusChanged("request-1", "completed");
}

test("start and steer include reference context but exclude internal notifications and logs", async () => {
  const requests = [];
  const { context, state } = createApp(async (url, options) => {
    requests.push({ url, body: JSON.parse(options.body) });
    return jsonResponse({ ok: true, turnId: "turn-1", finalText: "Done" });
  });
  context.sendTextToRealtime("Keep the public API unchanged.");
  context.handleRealtimeEvent({ type: "response.output_text.done", item_id: "answer-1", content_index: 0, text: "Option A changes only the implementation." });
  context.handleRealtimeEvent({ type: "conversation.item.input_audio_transcription.completed", item_id: "voice-1", transcript: "Use that option." });
  context.addMessage("system", "Internal log");
  const job = { requestId: "request-1", status: "running", turnId: "turn-1" };
  state.codexJobs.set(job.requestId, job);
  state.activeCodexRequestId = job.requestId;
  context.notifyCodexStatusChanged(job.requestId, "completed");
  await context.runCodexTool("Use that option.", "start-1");
  await context.executeRealtimeToolCall({ callId: "steer-1", name: "steer_codex_request",
    arguments: JSON.stringify({ requestId: job.requestId, message: "Keep the earlier constraint too." }) });
  assert.equal(requests.length, 2);
  for (const [index, request] of requests.entries()) {
    const payload = JSON.parse(request.body.message.split("\n\n").at(-1));
    assert.equal(payload.currentRequest, index ? "Keep the earlier constraint too." : "Use that option.");
    assert.deepEqual(payload.recentConversation, [
      { role: "user", text: "Keep the public API unchanged." },
      { role: "assistant", text: "Option A changes only the implementation." },
      { role: "user", text: "Use that option." },
    ]);
    assert.equal(payload.omittedMessages, 0);
    assert.doesNotMatch(request.body.message, /Internal log|Codex status update:/);
  }
});

test("transcript event identities deduplicate without discarding repeated user utterances", () => {
  const { context, state } = createApp();
  const event = { type: "conversation.item.input_audio_transcription.completed", item_id: "voice-1", transcript: "Yes" };
  context.handleRealtimeEvent(event);
  context.handleRealtimeEvent(event);
  context.handleRealtimeEvent({ ...event, item_id: "voice-2" });
  assert.equal(state.realtimeHistory.length, 2);
  context.handleRealtimeEvent({ type: "response.output_audio_transcript.done", item_id: "answer-1", content_index: 0, transcript: "Understood" });
  context.handleRealtimeEvent({ type: "response.output_text.done", item_id: "answer-1", content_index: 0, text: "Understood" });
  assert.equal(state.realtimeHistory.length, 3);
});

test("history is bounded and reports omissions without truncating the current request", () => {
  const { context, state } = createApp();
  for (let index = 0; index < 30; index++) context.recordRealtimeMessage("user", `message ${index}`);
  assert.equal(state.realtimeHistory.length, 24);
  assert.equal(state.omittedHistoryMessages, 6);
  context.recordRealtimeMessage("assistant", "x".repeat(25000));
  assert.equal(state.realtimeHistory.length, 0);
  const request = "Full current request ".repeat(2000);
  const payload = JSON.parse(context.codexMessageWithHistory(request).split("\n\n").at(-1));
  assert.equal(payload.currentRequest, request);
  assert.equal(payload.omittedMessages, 31);
});

test("duplicate steering events send one instruction and retain the original job", async () => {
  const requests = [];
  const { context, state, sent } = createApp(async (url, options) => {
    requests.push({ url, body: JSON.parse(options.body) });
    return jsonResponse({ ok: true, turnId: "turn-1" });
  });
  const job = { requestId: "request-1", status: "running", turnId: "turn-1" };
  state.codexJobs.set(job.requestId, job);
  state.activeCodexRequestId = job.requestId;
  state.codexRunning = true;
  const event = { type: "response.function_call_arguments.done", call_id: "steer-1",
    name: "steer_codex_request", arguments: JSON.stringify({ requestId: job.requestId, message: "Keep API v1." }) };
  context.handleRealtimeEvent(event);
  context.handleRealtimeEvent(event);
  await flush();
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, "/api/codex/steer");
  assert.deepEqual(requests[0].body, {
    conversationId: state.conversationId, turnId: "turn-1", message: "Keep API v1.", idempotencyKey: "realtime:steer-1",
  });
  assert.equal(JSON.parse(sent[0].item.output).status, "accepted");
  assert.equal(state.codexJobs.get(job.requestId), job);
  assert.equal(job.status, "running");
  assert.equal(state.codexJobs.size, 1);
});

for (const scenario of ["unknown", "completed", "starting", "rejected"]) {
  test(`steering ${scenario} requests reports failure without starting replacement work`, async () => {
    let requests = 0;
    const { context, state } = createApp(async () => {
      requests++;
      return jsonResponse({ error: "Active turn mismatch" }, false);
    });
    const job = { requestId: "request-1", status: scenario === "completed" ? "completed" : "running",
      turnId: scenario === "starting" ? null : "turn-1" };
    if (scenario !== "unknown") state.codexJobs.set(job.requestId, job);
    state.activeCodexRequestId = job.requestId;
    const result = await context.executeRealtimeToolCall({ callId: "steer-1", name: "steer_codex_request",
      arguments: JSON.stringify({ requestId: job.requestId, message: "Correction" }) });
    assert.equal(result.ok, false);
    assert.equal(requests, scenario === "rejected" ? 1 : 0);
    assert.equal(state.codexJobs.size, scenario === "unknown" ? 0 : 1);
    assert.equal(job.status, scenario === "completed" ? "completed" : "running");
  });
}

test("completion waits for user speech, the reply, and audio playback to finish", () => {
  const app = createApp();
  const { context, sent } = app;
  context.handleRealtimeEvent({ type: "input_audio_buffer.speech_started" });
  pendingCompletion(app);
  assert.equal(sent.length, 0);
  context.handleRealtimeEvent({ type: "input_audio_buffer.speech_stopped" });
  context.flushCodexNotifications();
  assert.equal(sent.length, 0);
  context.handleRealtimeEvent({ type: "response.created" });
  context.handleRealtimeEvent({ type: "output_audio_buffer.started" });
  context.handleRealtimeEvent({ type: "response.done" });
  assert.equal(sent.length, 0);
  context.handleRealtimeEvent({ type: "output_audio_buffer.stopped" });
  assert.equal(sent.length, 2);
  context.handleRealtimeEvent({ type: "output_audio_buffer.stopped" });
  context.handleRealtimeEvent({ type: "response.done" });
  assert.equal(sent.length, 2);
});

test("cleared playback does not release a completion while the user is interrupting", () => {
  const app = createApp();
  const { context, sent } = app;
  context.handleRealtimeEvent({ type: "response.created" });
  context.handleRealtimeEvent({ type: "output_audio_buffer.started" });
  pendingCompletion(app);
  context.handleRealtimeEvent({ type: "input_audio_buffer.speech_started" });
  context.handleRealtimeEvent({ type: "output_audio_buffer.cleared" });
  context.handleRealtimeEvent({ type: "response.done", response: { status: "cancelled" } });
  assert.equal(sent.length, 0);
  context.handleRealtimeEvent({ type: "input_audio_buffer.speech_stopped" });
  context.handleRealtimeEvent({ type: "response.created" });
  context.handleRealtimeEvent({ type: "response.done" });
  assert.equal(sent.length, 2);
});

test("a locally requested response reserves the gap before response.created", () => {
  const app = createApp();
  app.context.sendTextToRealtime("Hello");
  pendingCompletion(app);
  assert.equal(app.sent.length, 2);
  app.context.handleRealtimeEvent({ type: "response.created" });
  app.context.handleRealtimeEvent({ type: "response.done" });
  assert.equal(app.sent.length, 4);
});

test("a terminal poll consumes a queued notification instead of announcing it again", async () => {
  const app = createApp();
  const { context, state, sent } = app;
  context.handleRealtimeEvent({ type: "response.created" });
  pendingCompletion(app);
  context.handleRealtimeEvent({
    type: "response.done", response: { output: [{
      type: "function_call", call_id: "poll-1", name: "poll_codex_request",
      arguments: JSON.stringify({ requestId: "request-1" }),
    }] },
  });
  assert.equal(sent.length, 0);
  await flush();
  assert.equal(sent.length, 2);
  assert.equal(sent[0].item.type, "function_call_output");
  context.handleRealtimeEvent({ type: "response.done" });
  context.notifyCodexStatusChanged("request-1", "completed");
  assert.equal(sent.length, 2);
  assert.equal(state.codexJobs.get("request-1").pendingNotificationStatus, null);
});

test("disconnect resets activity but retains unsent completions", () => {
  const app = createApp();
  const { context, state, sent } = app;
  state.dataChannel.close = () => {};
  const channel = state.dataChannel;
  context.handleRealtimeEvent({ type: "input_audio_buffer.speech_started" });
  pendingCompletion(app);
  context.disconnectRealtime();
  assert.equal(sent.length, 0);
  state.dataChannel = channel;
  context.flushCodexNotifications();
  assert.equal(sent.length, 2);
});

for (const status of ["completed", "failed", "interrupted"]) {
  test(`a ${status} poll removes only its notification after publishing the result`, async () => {
    const { context, state, sent } = createApp();
    for (const requestId of ["request-1", "request-2"]) {
      state.codexJobs.set(requestId, { requestId, status, startedAt: Date.now(), finalText: "Finished" });
      context.notifyCodexStatusChanged(requestId, status);
      context.handleRealtimeEvent({ type: "response.done" });
    }
    const firstId = sent[0].item.id;
    const secondId = sent[2].item.id;
    assert.ok(firstId);
    assert.notEqual(firstId, secondId);
    context.sendTextToRealtime("Codex status update: this is an actual user message");
    sent.length = 0;
    const toolCall = {
      callId: "poll-1",
      name: "poll_codex_request",
      arguments: JSON.stringify({ requestId: "request-1" }),
    };
    await context.handleRealtimeToolCall(toolCall);
    assert.equal(sent[0].item.type, "function_call_output");
    assert.equal(JSON.parse(sent[0].item.output).status, status);
    assert.deepEqual(sent[1], { type: "conversation.item.delete", item_id: firstId });
    assert.equal(sent[2].type, "response.create");
    assert.equal(sent.length, 3);
    assert.equal(state.codexJobs.get("request-1").statusNotification, null);
    assert.equal(state.codexJobs.get("request-2").statusNotification.itemId, secondId);

    await context.handleRealtimeToolCall(toolCall);
    await context.handleRealtimeToolCall({ ...toolCall, callId: "poll-2" });
    assert.equal(sent.filter((event) => event.type === "conversation.item.delete").length, 1);
  });
}

for (const scenario of ["running", "unknown", "closed", "reconnected"]) {
  test(`notification is retained for a ${scenario} poll`, async () => {
    const { context, state, sent } = createApp();
    const job = { requestId: "request-1", status: "completed", startedAt: Date.now() };
    state.codexJobs.set(job.requestId, job);
    context.notifyCodexStatusChanged(job.requestId, job.status);
    const notification = job.statusNotification;
    if (scenario === "running") job.status = "running";
    if (scenario === "closed") state.dataChannel.readyState = "closed";
    if (scenario === "reconnected") state.dataChannel = { ...state.dataChannel };
    sent.length = 0;
    await context.handleRealtimeToolCall({
      callId: "poll-1",
      name: "poll_codex_request",
      arguments: JSON.stringify({ requestId: scenario === "unknown" ? "unknown" : job.requestId }),
    });
    assert.equal(sent.some((event) => event.type === "conversation.item.delete"), false);
    assert.equal(job.statusNotification, notification);
  });
}

for (const polledComplete of [false, true]) {
  test(`SSE final notifies before HTTP completes and only once (polled complete: ${polledComplete})`, async () => {
    let resolveFetch;
    const { context, state, sent } = createApp(() => new Promise((resolve) => {
      resolveFetch = resolve;
    }));
    context.startCodexJob("Do the work", "request-1");
    const job = state.codexJobs.get("request-1");
    if (polledComplete) job.status = "completed";

    context.updateCodexJobFromEvent("final", { finalText: "Finished" });
    assert.equal(job.finalText, "Finished");
    assert.equal(job.status, "completed");
    assert.equal(state.codexRunning, true);
    assert.equal(sent.length, 2);
    assert.match(sent[0].item.content[0].text, /request request-1 is completed\./);
    assert.equal(sent[1].type, "response.create");

    context.updateCodexJobFromEvent("final", { finalText: "Finished" });
    resolveFetch(jsonResponse({ finalText: "Finished" }));
    await flush();
    assert.equal(state.codexRunning, false);
    assert.equal(sent.length, 2);
  });
}

test("HTTP completion retries notification when the channel was closed at SSE final", async () => {
  let resolveFetch;
  const { context, state, sent } = createApp(() => new Promise((resolve) => {
    resolveFetch = resolve;
  }));
  context.startCodexJob("Do the work", "request-1");
  state.dataChannel.readyState = "closed";
  context.updateCodexJobFromEvent("final", { finalText: "Finished" });
  assert.equal(sent.length, 0);
  assert.equal(state.codexJobs.get("request-1").completionNotified, false);

  state.dataChannel.readyState = "open";
  resolveFetch(jsonResponse({ finalText: "Finished" }));
  await flush();
  assert.equal(sent.length, 2);
  assert.equal(state.codexJobs.get("request-1").completionNotified, true);
});

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

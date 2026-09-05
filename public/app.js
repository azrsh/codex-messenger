const config = window.CODEX_MESSENGER_CONFIG || {};
const token = config.token || window.CODEX_MESSENGER_TOKEN;
const state = {
  conversationId: crypto.randomUUID(),
  eventSource: null,
  peerConnection: null,
  dataChannel: null,
  audioElement: null,
  localStream: null,
  micEnabled: false,
  codexRunning: false,
  activeCodexRequestId: null,
  codexJobs: new Map(),
  codexToolCallPromises: new Map(),
  codexToolCallOutputs: new Map(),
  userSpeaking: false,
  responsePending: false,
  audioPlaying: false,
  realtimeHistory: [],
  omittedHistoryMessages: 0,
  pendingTranscripts: new Map(),
  audioResponses: new Map(),
  activeAudioResponseId: null,
  currentResponseId: null,
};

const els = {
  form: document.querySelector("#messageForm"),
  input: document.querySelector("#messageInput"),
  messages: document.querySelector("#messages"),
  eventLog: document.querySelector("#eventLog"),
  realtimeStatus: document.querySelector("#realtimeStatus"),
  codexStatus: document.querySelector("#codexStatus"),
  threadLinkPanel: document.querySelector("#threadLinkPanel"),
  threadLink: document.querySelector("#threadLink"),
  connectRealtime: document.querySelector("#connectRealtime"),
  disconnectRealtime: document.querySelector("#disconnectRealtime"),
};

restoreConversation();
startEvents();
addMessage("system", "Ready. Connect voice, then speak or send text through the realtime agent.");

els.form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const message = els.input.value.trim();
  if (!message) return;
  els.input.value = "";
  sendTextToRealtime(message);
});

els.connectRealtime.addEventListener("click", connectRealtime);
els.disconnectRealtime.addEventListener("click", disconnectRealtime);

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...(options.headers || {}),
    },
  });

  const contentType = response.headers.get("content-type") || "";
  const body = contentType.includes("application/json")
    ? await response.json()
    : await response.text();

  if (!response.ok) {
    throw Object.assign(new Error(body?.error || body || `Request failed: ${response.status}`), { status: response.status });
  }
  return body;
}

async function runCodexTool(message, callId) {
  els.codexStatus.textContent = "Running";

  try {
    const result = await api("/api/codex/message", {
      method: "POST",
      body: JSON.stringify({
        conversationId: state.conversationId,
        idempotencyKey: `realtime:${callId}`,
        message: codexMessageWithHistory(message),
      }),
    });
    showThreadLink(result.conversation?.codexThreadId);
    return {
      ok: true,
      finalText: result.finalText || "",
      conversation: result.conversation,
      threadId: result.conversation?.codexThreadId,
      turnId: result.turnId,
    };
  } catch (error) {
    return { ok: false, error: error.message };
  } finally {
    els.codexStatus.textContent = "Idle";
  }
}

function startEvents() {
  state.eventSource?.close();
  state.eventSource = new EventSource(
    `/api/conversations/${state.conversationId}/events?token=${encodeURIComponent(token)}`,
  );
  state.eventSource.addEventListener("open", () => recoverCodexJob());

  for (const name of [
    "user_message",
    "codex_connected",
    "codex_event",
    "final",
    "error",
    "interrupt",
  ]) {
    state.eventSource.addEventListener(name, (event) => {
      const payload = JSON.parse(event.data);
      updateThreadLinkFromEvent(name, payload);
      updateCodexJobFromEvent(name, payload);
      persistConversation();
      logEvent(name, payload);
    });
  }
}

async function connectRealtime() {
  els.realtimeStatus.textContent = "Connecting";
  try {
    const stream = await requestMicrophone();
    state.localStream = stream;
    state.micEnabled = true;

    els.codexStatus.textContent = "Connecting";
    const codexConnection = await api("/api/codex/connect", {
      method: "POST",
      body: JSON.stringify({
        conversationId: state.conversationId,
      }),
    });
    showThreadLink(codexConnection.conversation?.codexThreadId);
    els.codexStatus.textContent = "Idle";

    const session = await api("/api/realtime/session");
    const ephemeralKey =
      session?.value ||
      session?.client_secret?.value ||
      session?.clientSecret?.value;

    if (!ephemeralKey) {
      throw new Error("Realtime session did not include a client secret");
    }

    const pc = new RTCPeerConnection();
    state.peerConnection = pc;

    state.audioElement = document.createElement("audio");
    state.audioElement.autoplay = true;
    pc.ontrack = (event) => {
      state.audioElement.srcObject = event.streams[0];
    };

    for (const track of stream.getTracks()) pc.addTrack(track, stream);

    const dc = pc.createDataChannel("oai-events");
    state.dataChannel = dc;
    dc.onopen = () => {
      if (state.dataChannel !== dc) return;
      logEvent("realtime", { type: "data_channel_open" });
      seedRealtimeHistory();
      flushCodexNotifications();
    };
    dc.onmessage = (event) => {
      if (state.dataChannel === dc) handleRealtimeEvent(JSON.parse(event.data));
    };

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);

    const realtimeCallsUrl = new URL(config.realtimeCallsUrl || "https://api.openai.com/v1/realtime/calls");
    realtimeCallsUrl.searchParams.set("model", config.realtimeModel || "gpt-realtime");
    const sdpResponse = await fetch(realtimeCallsUrl.toString(), {
      method: "POST",
      body: offer.sdp,
      headers: {
        Authorization: `Bearer ${ephemeralKey}`,
        "Content-Type": "application/sdp",
      },
    });

    if (!sdpResponse.ok) {
      throw new Error(await sdpResponse.text());
    }

    await pc.setRemoteDescription({
      type: "answer",
      sdp: await sdpResponse.text(),
    });

    els.realtimeStatus.textContent = "Connected";
    els.connectRealtime.disabled = true;
    els.disconnectRealtime.disabled = false;
  } catch (error) {
    els.realtimeStatus.textContent = "Disconnected";
    els.codexStatus.textContent = "Idle";
    disconnectRealtime();
    addMessage("system", `Voice connection failed: ${error.message}`);
  }
}

function disconnectRealtime() {
  finishAudioPlayback("interrupted", state.activeAudioResponseId || state.currentResponseId);
  for (const pending of state.pendingTranscripts.values()) pending.resolve();
  state.pendingTranscripts.clear();
  state.currentResponseId = null;
  state.dataChannel?.close();
  state.localStream?.getTracks().forEach((track) => track.stop());
  state.peerConnection?.getSenders().forEach((sender) => sender.track?.stop());
  state.peerConnection?.close();
  state.dataChannel = null;
  for (const job of state.codexJobs.values()) {
    if (!job.resultDelivered && ["completed", "failed", "interrupted"].includes(job.status)) {
      job.completionNotified = false;
      job.statusNotification = null;
      job.pendingNotificationStatus = job.status;
    }
  }
  persistConversation();
  state.userSpeaking = false;
  state.responsePending = false;
  state.audioPlaying = false;
  state.peerConnection = null;
  state.localStream = null;
  state.micEnabled = false;
  els.realtimeStatus.textContent = "Disconnected";
  els.connectRealtime.disabled = false;
  els.disconnectRealtime.disabled = true;
}

async function requestMicrophone() {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error(
      "Microphone access is not available in this browser. Realtime voice requires microphone access.",
    );
  }

  try {
    return await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (error) {
    const permissionErrors = new Set([
      "NotAllowedError",
      "PermissionDeniedError",
      "SecurityError",
    ]);
    if (permissionErrors.has(error.name) || /permission/i.test(error.message)) {
      throw new Error(
        "Microphone permission was denied. Realtime voice requires microphone access; allow microphone access in the browser or OS settings, then try again.",
      );
    }

    throw new Error(`Microphone capture failed: ${error.message}`);
  }
}

function handleRealtimeEvent(event) {
  logEvent("realtime", event);

  switch (event.type) {
    case "input_audio_buffer.speech_started":
      state.userSpeaking = true;
      finishAudioPlayback("interrupted", state.activeAudioResponseId || state.currentResponseId);
      if (event.item_id && !state.pendingTranscripts.has(event.item_id)) {
        let resolve;
        const promise = new Promise((done) => { resolve = done; });
        state.pendingTranscripts.set(event.item_id, { promise, resolve });
        recordRealtimeMessage("user", "", event.item_id);
      }
      return;
    case "input_audio_buffer.speech_stopped":
      state.userSpeaking = false;
      state.responsePending = true;
      return;
    case "response.created":
      state.responsePending = true;
      state.currentResponseId = event.response?.id || null;
      return;
    case "output_audio_buffer.started":
      state.audioPlaying = true;
      state.activeAudioResponseId = event.response_id;
      if (!state.audioResponses.has(event.response_id)) state.audioResponses.set(event.response_id, "pending");
      return;
    case "output_audio_buffer.stopped":
      finishAudioPlayback("completed", event.response_id);
      state.audioPlaying = false;
      flushCodexNotifications();
      return;
    case "output_audio_buffer.cleared":
      finishAudioPlayback("interrupted", event.response_id);
      state.audioPlaying = false;
      flushCodexNotifications();
      return;
    case "response.done":
      state.responsePending = false;
      if (event.response?.status === "cancelled") finishAudioPlayback("interrupted", event.response.id);
      state.currentResponseId = null;
      break;
    case "conversation.item.truncated":
      for (const entry of state.realtimeHistory) {
        if (entry.key === `assistant:${event.item_id}:${event.content_index ?? 0}`) {
          entry.playback = "interrupted";
          if (entry.responseId) state.audioResponses.set(entry.responseId, "interrupted");
        }
      }
      persistConversation();
      return;
  }

  if (event.type === "conversation.item.input_audio_transcription.completed") {
    const text = event.transcript?.trim();
    if (text) {
      recordRealtimeMessage("user", text, event.item_id);
      els.input.value = text;
      addMessage("user", text);
      for (const job of state.codexJobs.values()) {
        if (job.pendingTranscriptIds?.includes(event.item_id)) {
          job.pendingTranscriptIds = job.pendingTranscriptIds.filter((id) => id !== event.item_id);
          (job.lateTranscripts ||= []).push({ itemId: event.item_id, text });
          flushLateTranscripts(job);
        }
      }
    }
    state.pendingTranscripts.get(event.item_id)?.resolve();
    state.pendingTranscripts.delete(event.item_id);
    return;
  }

  if (event.type === "conversation.item.input_audio_transcription.failed") {
    state.pendingTranscripts.get(event.item_id)?.resolve();
    state.pendingTranscripts.delete(event.item_id);
    return;
  }

  if (event.type === "response.output_audio_transcript.done" && event.transcript?.trim()) {
    recordRealtimeMessage("assistant", event.transcript.trim(), event.item_id, event.content_index);
    const entry = state.realtimeHistory.find((entry) => entry.key === `assistant:${event.item_id}:${event.content_index ?? 0}`);
    if (entry) {
      entry.responseId = event.response_id;
      entry.playback = state.audioResponses.get(event.response_id) || "pending";
      persistConversation();
    }
    addMessage("assistant", event.transcript.trim());
    return;
  }

  if (event.type === "response.output_text.done" && event.text?.trim()) {
    recordRealtimeMessage("assistant", event.text.trim(), event.item_id, event.content_index);
    addMessage("assistant", event.text.trim());
    return;
  }

  const toolCall = getRealtimeToolCall(event);
  if (toolCall) {
    handleRealtimeToolCall(toolCall);
  }
  if (event.type === "response.done") flushCodexNotifications();
}

function sendTextToRealtime(text) {
  if (state.dataChannel?.readyState !== "open") {
    addMessage("system", "Connect voice before sending. Text now routes through the realtime agent.");
    return;
  }

  addMessage("user", text);
  recordRealtimeMessage("user", text);
  state.dataChannel.send(
    JSON.stringify({
      type: "conversation.item.create",
      item: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text }],
      },
    }),
  );
  state.responsePending = true;
  state.dataChannel.send(JSON.stringify({ type: "response.create" }));
}

function getRealtimeToolCall(event) {
  if (
    event.type === "response.output_item.done" &&
    event.item?.type === "function_call" &&
    isCodexToolName(event.item.name)
  ) {
    return {
      callId: event.item.call_id,
      name: event.item.name,
      arguments: event.item.arguments || "{}",
    };
  }

  if (
    event.type === "response.function_call_arguments.done" &&
    isCodexToolName(event.name)
  ) {
    return {
      callId: event.call_id,
      name: event.name,
      arguments: event.arguments || "{}",
    };
  }

  const outputItems = event.response?.output || [];
  const item = outputItems.find(
    (candidate) =>
      candidate?.type === "function_call" &&
      isCodexToolName(candidate?.name),
  );
  if (item) {
    return {
      callId: item.call_id,
      name: item.name,
      arguments: item.arguments || "{}",
    };
  }

  return null;
}

function isCodexToolName(name) {
  return name === "start_codex_request" || name === "poll_codex_request" || name === "steer_codex_request";
}

async function handleRealtimeToolCall(toolCall) {
  const { callId } = toolCall;
  if (!callId) return;

  if (state.codexToolCallOutputs.has(callId)) {
    return;
  }

  if (state.codexToolCallPromises.has(callId)) return;

  const channel = state.dataChannel;
  const promise = executeRealtimeToolCall(toolCall);
  state.codexToolCallPromises.set(callId, promise);
  try {
    const output = await promise;
    state.codexToolCallOutputs.set(callId, output);
    if (channel === state.dataChannel && channel?.readyState === "open") {
      sendCodexToolOutput(callId, output, toolCall.name);
    } else if (toolCall.name === "poll_codex_request" && ["completed", "failed", "interrupted"].includes(output.status)) {
      notifyCodexStatusChanged(output.requestId, output.status);
    }
  } finally {
    state.codexToolCallPromises.delete(callId);
    flushCodexNotifications();
  }
}

async function executeRealtimeToolCall(toolCall) {
  let args;
  try {
    args = JSON.parse(toolCall.arguments || "{}");
  } catch {
    return { ok: false, error: "Codex request arguments were not valid JSON." };
  }

  if (toolCall.name === "poll_codex_request") {
    return await pollCodexJob(String(args.requestId || "").trim());
  }

  const message = String(args.message || "").trim();
  if (!message) {
    return { ok: false, error: "No Codex message was provided." };
  }
  await waitForTranscripts();

  if (toolCall.name === "steer_codex_request") {
    const requestId = String(args.requestId || "").trim();
    const job = state.codexJobs.get(requestId);
    if (!job || job.status !== "running" || state.activeCodexRequestId !== requestId) {
      return { ok: false, requestId, error: "The requested Codex job is not running. The additional instruction was not sent." };
    }
    if (!job.turnId) {
      return { ok: false, requestId, error: "Codex is still starting. The additional instruction was not sent." };
    }
    try {
      job.pendingTranscriptIds = [...new Set([...(job.pendingTranscriptIds || []), ...state.pendingTranscripts.keys()])];
      const result = await api("/api/codex/steer", {
        method: "POST",
        body: JSON.stringify({
          conversationId: state.conversationId,
          turnId: job.turnId,
          message: codexMessageWithHistory(message),
          idempotencyKey: `realtime:${toolCall.callId}`,
        }),
      });
      return { ok: true, requestId, turnId: result.turnId, status: "accepted", instruction: "Additional instruction accepted. Keep polling the original request id." };
    } catch (error) {
      return { ok: false, requestId, error: `Additional instruction was not confirmed: ${error.message}` };
    }
  }

  if (state.codexRunning) {
    return {
      ok: false,
      status: "busy",
      activeRequestId: state.activeCodexRequestId,
      error: "Codex is already working on a request. Please wait for it to finish before starting another.",
    };
  }

  return startCodexJob(message, toolCall.callId);
}

function sendCodexToolOutput(callId, output, toolName) {
  if (state.dataChannel?.readyState !== "open") return;

  state.dataChannel.send(
    JSON.stringify({
      type: "conversation.item.create",
      item: {
        type: "function_call_output",
        call_id: callId,
        output: JSON.stringify(output),
      },
    }),
  );
  if (toolName === "poll_codex_request" && ["completed", "failed", "interrupted"].includes(output.status)) {
    const job = state.codexJobs.get(output.requestId);
    const notification = job?.statusNotification;
    if (notification && notification.channel === state.dataChannel) {
      state.dataChannel.send(JSON.stringify({
        type: "conversation.item.delete",
        item_id: notification.itemId,
      }));
      job.statusNotification = null;
    }
    if (job) {
      job.pendingNotificationStatus = null;
      job.completionNotified = true;
      job.resultDelivered = true;
      persistConversation();
    }
  }
  state.responsePending = true;
  state.dataChannel.send(
    JSON.stringify({
      type: "response.create",
      response: {
        output_modalities: ["audio"],
      },
    }),
  );
}

function startCodexJob(message, requestId) {
  const job = {
    requestId,
    message,
    status: "running",
    progress: "Codex request started.",
    progressDetails: [],
    finalText: "",
    error: null,
    completionNotified: false,
    statusNotification: null,
    turnId: null,
    startedAt: Date.now(),
    updatedAt: Date.now(),
    pendingTranscriptIds: [...state.pendingTranscripts.keys()],
  };
  state.codexJobs.set(requestId, job);
  state.activeCodexRequestId = requestId;
  state.codexRunning = true;
  persistConversation();
  els.codexStatus.textContent = "Running";
  addMessage("system", `Sending to Codex: ${message}`);

  runCodexTool(message, requestId).then((result) => {
    if (result.ok) {
      Object.assign(job, {
        status: "completed",
        progress: "Codex completed the request.",
        finalText: result.finalText || "",
        threadId: result.threadId || result.conversation?.codexThreadId || null,
        turnId: result.turnId || null,
        conversation: result.conversation,
        updatedAt: Date.now(),
      });
    } else {
      Object.assign(job, {
        status: "failed",
        progress: "Codex failed the request.",
        error: result.error || "Codex request failed.",
        updatedAt: Date.now(),
      });
    }
  }).finally(() => {
    state.codexRunning = false;
    state.activeCodexRequestId = null;
    els.codexStatus.textContent = "Idle";
    notifyCodexStatusChanged(requestId, job.status);
    persistConversation();
  });

  return {
    ok: true,
    requestId,
    status: "running",
    progress: job.progress,
    instruction: "Poll this request until it is completed, failed, or interrupted.",
  };
}

async function pollCodexJob(requestId) {
  const job = state.codexJobs.get(requestId);
  if (!job) {
    return { ok: false, status: "not_found", error: "Unknown Codex request id." };
  }

  if (job.recovered && job.status === "running") await recoverCodexJob();
  await refreshCodexJobFromThread(job);

  const payload = {
    ok: job.status !== "failed",
    requestId: job.requestId,
    status: job.status,
    progress: job.progress,
    progressDetails: job.progressDetails || [],
    elapsedSeconds: Math.max(0, Math.round((Date.now() - job.startedAt) / 1000)),
  };

  if (job.status === "completed") {
    payload.finalText = job.finalText || "(No final text)";
    payload.turnId = job.turnId;
  } else if (job.status === "failed") {
    payload.error = job.error || "Codex request failed.";
  }

  return payload;
}

async function refreshCodexJobFromThread(job) {
  if (!job.turnId) return;
  try {
    const status = await api("/api/codex/status", {
      method: "POST",
      body: JSON.stringify({
        conversationId: state.conversationId,
        turnId: job.turnId,
      }),
    });

    if (status.threadId) job.threadId = status.threadId;
    if (status.turnId) job.turnId = status.turnId;
    if (status.progress) job.progress = status.progress;
    if (Array.isArray(status.progressDetails)) job.progressDetails = status.progressDetails;
    if (status.finalText) job.finalText = status.finalText;
    if (status.error) job.error = status.error;
    if (["completed", "failed", "interrupted", "running"].includes(status.status)) {
      job.status = status.status;
    }
    job.updatedAt = Date.now();
  } catch (error) {
    job.progress = `Codex status polling is temporarily unavailable: ${error.message}`;
    job.updatedAt = Date.now();
  }
}

function notifyCodexStatusChanged(requestId, status) {
  const job = state.codexJobs.get(requestId);
  if (!job || job.completionNotified) return;
  job.pendingNotificationStatus = status;
  persistConversation();
  if (state.dataChannel?.readyState !== "open") return;
  if (state.userSpeaking || state.responsePending || state.audioPlaying || state.codexToolCallPromises.size) return;
  const detail = "Codex finished. Call poll_codex_request now and relay the final result.";
  const itemId = crypto.randomUUID().replaceAll("-", "");

  state.dataChannel.send(
    JSON.stringify({
      type: "conversation.item.create",
      item: {
        id: itemId,
        type: "message",
        role: "user",
        content: [
          {
            type: "input_text",
            text: `Codex status update: request ${requestId} is ${status}. ${detail}`,
          },
        ],
      },
    }),
  );
  job.statusNotification = { itemId, channel: state.dataChannel };

  state.responsePending = true;
  state.dataChannel.send(
    JSON.stringify({
      type: "response.create",
      response: {
        output_modalities: ["audio"],
      },
    }),
  );
  job.completionNotified = true;
  job.pendingNotificationStatus = null;
  persistConversation();
}

function flushCodexNotifications() {
  for (const job of state.codexJobs.values()) {
    if (job.pendingNotificationStatus) {
      notifyCodexStatusChanged(job.requestId, job.pendingNotificationStatus);
    }
  }
}

function updateCodexJobFromEvent(name, payload) {
  const requestId = state.activeCodexRequestId;
  if (!requestId) return;
  const job = state.codexJobs.get(requestId);
  if (!job || (job.status !== "running" && !(name === "final" && job.status === "completed"))) return;

  if (name === "codex_event") {
    const method = payload.method || payload.type || "codex_event";
    const item = payload.params?.item;
    const threadId = payload.params?.threadId || payload.params?.thread?.id;
    const turnId = payload.params?.turnId || payload.params?.turn?.id;
    if (threadId) job.threadId = threadId;
    if (turnId) job.turnId = turnId;
    flushLateTranscripts(job);

    if (method === "item/completed" && item?.type === "agentMessage") {
      job.progress = "Codex produced assistant output and is checking whether more work remains.";
    } else if (method === "turn/started") {
      job.progress = "Codex turn has started.";
    } else if (method === "item/started" && item?.type) {
      job.progress = `Codex started ${item.type}.`;
    } else if (method === "turn/plan/updated" || method === "turn/diff/updated") {
      job.progress = "Codex updated its plan or working diff.";
    } else {
      job.progress = `Codex event: ${method}.`;
    }
    job.updatedAt = Date.now();
    return;
  }

  if (name === "final") {
    job.status = "completed";
    job.progress = "Codex completed the request.";
    job.finalText = payload.finalText || "";
    job.conversation = payload.conversation;
    job.threadId = payload.conversation?.codexThreadId || job.threadId;
    job.updatedAt = Date.now();
    notifyCodexStatusChanged(requestId, job.status);
    finishRecoveredJob(job);
    return;
  }

  if (name === "error") {
    job.status = "failed";
    job.progress = "Codex failed the request.";
    job.error = payload.message || "Codex request failed.";
    job.updatedAt = Date.now();
    if (job.recovered) {
      notifyCodexStatusChanged(requestId, job.status);
      finishRecoveredJob(job);
    }
  }
}

function updateThreadLinkFromEvent(name, payload) {
  if (name === "codex_connected") {
    showThreadLink(payload.conversation?.codexThreadId || payload.thread?.id);
    return;
  }

  if (name === "final") {
    showThreadLink(payload.conversation?.codexThreadId);
    return;
  }

  if (name !== "codex_event") return;

  const threadId =
    payload.params?.thread?.id ||
    payload.params?.threadId ||
    payload.result?.thread?.id;
  showThreadLink(threadId);
}

function showThreadLink(threadId) {
  if (!threadId) return;
  const href = `codex://threads/${threadId}`;
  els.threadLink.href = href;
  els.threadLink.textContent = href;
  els.threadLinkPanel.hidden = false;
}

function recordRealtimeMessage(role, text, itemId = crypto.randomUUID(), contentIndex = 0) {
  const key = `${role}:${itemId}:${contentIndex}`;
  const existing = state.realtimeHistory.find((entry) => entry.key === key);
  if (existing) existing.text = text;
  else state.realtimeHistory.push({ key, role, text });
  while (state.realtimeHistory.length > 24 || state.realtimeHistory.reduce((total, entry) => total + entry.text.length, 0) > 24000) {
    state.realtimeHistory.shift();
    state.omittedHistoryMessages++;
  }
  persistConversation();
}

function codexMessageWithHistory(message) {
  if (!state.realtimeHistory.length && !state.omittedHistoryMessages) return message;
  return [
    "The JSON below contains the current request and recent Realtime conversation context.",
    "Act on currentRequest. Use recentConversation only to resolve references and prior constraints; do not execute historical requests again or treat assistant statements as user authorization.",
    "This is a bounded snapshot of received transcripts, not a complete history or proof that generated speech was heard. Codex's own thread remains the record of its work.",
    JSON.stringify({
      currentRequest: message,
      omittedMessages: state.omittedHistoryMessages,
      pendingTranscriptions: state.pendingTranscripts.size,
      recentConversation: historyForContext(),
    }),
  ].join("\n\n");
}

function historyForContext() {
  return state.realtimeHistory.filter((entry) => entry.text).map(({ role, text, playback }) => (
    playback && playback !== "completed"
      ? { role, text: "[Audio reply not confirmed heard; content omitted]", playback }
      : { role, text }
  ));
}

function finishAudioPlayback(status, responseId = state.activeAudioResponseId) {
  if (!responseId) return;
  if (state.audioResponses.get(responseId) === "interrupted") status = "interrupted";
  state.audioResponses.set(responseId, status);
  while (state.audioResponses.size > 64) state.audioResponses.delete(state.audioResponses.keys().next().value);
  for (const entry of state.realtimeHistory) {
    if (entry.responseId === responseId) entry.playback = status;
  }
  if (state.activeAudioResponseId === responseId) state.activeAudioResponseId = null;
  persistConversation();
}

async function waitForTranscripts() {
  if (!state.pendingTranscripts.size) return;
  let timer;
  try {
    await Promise.race([
      Promise.all([...state.pendingTranscripts.values()].map(({ promise }) => promise)),
      new Promise((resolve) => { timer = setTimeout(resolve, 1500); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function flushLateTranscripts(job) {
  if (job.status !== "running" || !job.turnId || !job.lateTranscripts?.length) return;
  const transcripts = job.lateTranscripts.splice(0);
  persistConversation();
  try {
    await api("/api/codex/steer", {
      method: "POST",
      body: JSON.stringify({
        conversationId: state.conversationId, turnId: job.turnId,
        idempotencyKey: `transcript:${job.requestId}:${transcripts.map((item) => item.itemId).join(":")}`,
        message: "Delayed transcription of speech already associated with the current request. Use it to clarify that request; do not repeat the work as a new request.\n" + JSON.stringify(transcripts),
      }),
    });
  } catch (error) {
    addMessage("system", `Late transcript delivery was not confirmed: ${error.message}`);
  }
}

function persistConversation() {
  try {
    window.sessionStorage?.setItem("codex-messenger-conversation", JSON.stringify({
      conversationId: state.conversationId,
      history: state.realtimeHistory,
      omittedMessages: state.omittedHistoryMessages,
      jobs: [...state.codexJobs.values()].slice(-8).map(({ statusNotification, ...job }) => job),
    }));
  } catch {
    // Storage may be disabled or full; the live session remains usable.
  }
}

function restoreConversation() {
  try {
    const saved = JSON.parse(window.sessionStorage?.getItem("codex-messenger-conversation") || "null");
    if (!saved || typeof saved.conversationId !== "string") return;
    state.conversationId = saved.conversationId;
    state.realtimeHistory = (saved.history || []).filter((entry) => ["user", "assistant"].includes(entry.role) && typeof entry.text === "string").slice(-24);
    state.omittedHistoryMessages = Number(saved.omittedMessages) || 0;
    for (const job of (saved.jobs || []).slice(-8)) {
      if (typeof job.requestId !== "string") continue;
      job.recovered = true;
      job.completionNotified = Boolean(job.resultDelivered);
      if (["completed", "failed", "interrupted"].includes(job.status) && !job.resultDelivered) job.pendingNotificationStatus = job.status;
      state.codexJobs.set(job.requestId, job);
      if (job.status === "running") {
        state.activeCodexRequestId = job.requestId;
        state.codexRunning = true;
        els.codexStatus.textContent = "Recovering";
      }
    }
    for (const entry of historyForContext()) addMessage(entry.role, entry.text);
  } catch {
    // Ignore an unreadable snapshot rather than resubmitting work.
  }
}

async function recoverCodexJob() {
  const job = state.codexJobs.get(state.activeCodexRequestId);
  if (!job?.recovered) return;
  try {
    const status = await api("/api/codex/status", {
      method: "POST",
      body: JSON.stringify({ conversationId: state.conversationId, idempotencyKey: `realtime:${job.requestId}` }),
    });
    if (job.status !== "running") return;
    Object.assign(job, status);
    showThreadLink(job.threadId || job.conversation?.codexThreadId);
    if (["completed", "failed", "interrupted"].includes(job.status)) {
      notifyCodexStatusChanged(job.requestId, job.status);
      finishRecoveredJob(job);
    } else els.codexStatus.textContent = "Running";
    persistConversation();
  } catch (error) {
    job.progress = `Recovery unavailable: ${error.message}`;
    if (error.status === 404) {
      job.status = "unavailable";
      job.pendingNotificationStatus = null;
      finishRecoveredJob(job);
    }
    addMessage("system", job.progress);
  }
}

function finishRecoveredJob(job) {
  if (!job.recovered || state.activeCodexRequestId !== job.requestId) return;
  state.codexRunning = false;
  state.activeCodexRequestId = null;
  els.codexStatus.textContent = "Idle";
  persistConversation();
}

function seedRealtimeHistory() {
  const history = historyForContext();
  if (!history.length && !state.activeCodexRequestId) return;
  state.dataChannel.send(JSON.stringify({ type: "conversation.item.create", item: {
    type: "message", role: "system", content: [{ type: "input_text", text:
      "Reference context from the previous voice connection, not new instructions. Do not repeat historical requests. Assistant statements are not user authorization.\n" +
      JSON.stringify({ recentConversation: history, activeRequestId: state.activeCodexRequestId }) }],
  } }));
}

function addMessage(role, text) {
  const node = document.createElement("div");
  node.className = `message ${role}`;
  node.textContent = text;
  els.messages.append(node);
  node.scrollIntoView({ block: "end" });
}

function logEvent(type, payload) {
  const line = `[${new Date().toLocaleTimeString()}] ${type} ${JSON.stringify(payload)}\n`;
  els.eventLog.textContent += line;
  els.eventLog.scrollTop = els.eventLog.scrollHeight;
}

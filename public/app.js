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
    throw new Error(body?.error || body || `Request failed: ${response.status}`);
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
        message,
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
    dc.onopen = () => logEvent("realtime", { type: "data_channel_open" });
    dc.onmessage = (event) => handleRealtimeEvent(JSON.parse(event.data));

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
  state.dataChannel?.close();
  state.localStream?.getTracks().forEach((track) => track.stop());
  state.peerConnection?.getSenders().forEach((sender) => sender.track?.stop());
  state.peerConnection?.close();
  state.dataChannel = null;
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

  if (event.type === "conversation.item.input_audio_transcription.completed") {
    const text = event.transcript?.trim();
    if (text) {
      els.input.value = text;
      addMessage("user", text);
    }
    return;
  }

  if (event.type === "response.audio_transcript.done" && event.transcript?.trim()) {
    addMessage("assistant", event.transcript.trim());
    return;
  }

  if (event.type === "response.text.done" && event.text?.trim()) {
    addMessage("assistant", event.text.trim());
    return;
  }

  const toolCall = getRealtimeToolCall(event);
  if (toolCall) {
    handleRealtimeToolCall(toolCall);
  }
}

function sendTextToRealtime(text) {
  if (state.dataChannel?.readyState !== "open") {
    addMessage("system", "Connect voice before sending. Text now routes through the realtime agent.");
    return;
  }

  addMessage("user", text);
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
  return name === "start_codex_request" || name === "poll_codex_request";
}

async function handleRealtimeToolCall(toolCall) {
  const { callId } = toolCall;
  if (!callId) return;

  if (state.codexToolCallOutputs.has(callId)) {
    sendCodexToolOutput(callId, state.codexToolCallOutputs.get(callId));
    return;
  }

  if (state.codexToolCallPromises.has(callId)) return;

  const promise = executeRealtimeToolCall(toolCall);
  state.codexToolCallPromises.set(callId, promise);
  try {
    const output = await promise;
    state.codexToolCallOutputs.set(callId, output);
    sendCodexToolOutput(callId, output);
  } finally {
    state.codexToolCallPromises.delete(callId);
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

function sendCodexToolOutput(callId, output) {
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
  state.dataChannel.send(
    JSON.stringify({
      type: "response.create",
      response: {
        modalities: ["audio", "text"],
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
    turnId: null,
    startedAt: Date.now(),
    updatedAt: Date.now(),
  };
  state.codexJobs.set(requestId, job);
  state.activeCodexRequestId = requestId;
  state.codexRunning = true;
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
    notifyCodexStatusChanged(requestId, "completed");
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
  if (state.dataChannel?.readyState !== "open") return;
  const detail = "Codex finished. Call poll_codex_request now and relay the final result.";

  state.dataChannel.send(
    JSON.stringify({
      type: "conversation.item.create",
      item: {
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

  state.dataChannel.send(
    JSON.stringify({
      type: "response.create",
      response: {
        modalities: ["audio", "text"],
      },
    }),
  );
}

function updateCodexJobFromEvent(name, payload) {
  const requestId = state.activeCodexRequestId;
  if (!requestId) return;
  const job = state.codexJobs.get(requestId);
  if (!job || job.status !== "running") return;

  if (name === "codex_event") {
    const method = payload.method || payload.type || "codex_event";
    const item = payload.params?.item;
    const threadId = payload.params?.threadId || payload.params?.thread?.id;
    const turnId = payload.params?.turnId || payload.params?.turn?.id;
    if (threadId) job.threadId = threadId;
    if (turnId) job.turnId = turnId;

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
    return;
  }

  if (name === "error") {
    job.status = "failed";
    job.progress = "Codex failed the request.";
    job.error = payload.message || "Codex request failed.";
    job.updatedAt = Date.now();
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

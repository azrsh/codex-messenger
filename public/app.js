const token = window.CODEX_MESSENGER_TOKEN;
const state = {
  conversationId: crypto.randomUUID(),
  eventSource: null,
  peerConnection: null,
  dataChannel: null,
  audioElement: null,
  localStream: null,
  micEnabled: false,
};

const els = {
  form: document.querySelector("#messageForm"),
  input: document.querySelector("#messageInput"),
  messages: document.querySelector("#messages"),
  eventLog: document.querySelector("#eventLog"),
  realtimeStatus: document.querySelector("#realtimeStatus"),
  codexStatus: document.querySelector("#codexStatus"),
  connectRealtime: document.querySelector("#connectRealtime"),
  disconnectRealtime: document.querySelector("#disconnectRealtime"),
};

startEvents();
addMessage("system", "Ready. Send a text message, or connect voice to capture speech.");

els.form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const message = els.input.value.trim();
  if (!message) return;
  els.input.value = "";
  await sendToCodex(message);
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

async function sendToCodex(message) {
  addMessage("user", message);
  els.codexStatus.textContent = "Running";

  try {
    const result = await api("/api/codex/message", {
      method: "POST",
      body: JSON.stringify({
        conversationId: state.conversationId,
        idempotencyKey: crypto.randomUUID(),
        message,
      }),
    });
    addMessage("assistant", result.finalText || "(No final text)");
    speakWithRealtime(result.finalText);
  } catch (error) {
    addMessage("system", error.message);
  } finally {
    els.codexStatus.textContent = "Idle";
  }
}

function startEvents() {
  state.eventSource?.close();
  state.eventSource = new EventSource(
    `/api/conversations/${state.conversationId}/events?token=${encodeURIComponent(token)}`,
  );

  for (const name of ["user_message", "codex_event", "final", "error", "interrupt"]) {
    state.eventSource.addEventListener(name, (event) => {
      logEvent(name, JSON.parse(event.data));
    });
  }
}

async function connectRealtime() {
  els.realtimeStatus.textContent = "Connecting";
  try {
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

    const stream = await requestMicrophone();
    state.localStream = stream;
    state.micEnabled = true;
    for (const track of stream.getTracks()) pc.addTrack(track, stream);

    const dc = pc.createDataChannel("oai-events");
    state.dataChannel = dc;
    dc.onopen = () => logEvent("realtime", { type: "data_channel_open" });
    dc.onmessage = (event) => handleRealtimeEvent(JSON.parse(event.data));

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);

    const realtimeModel = "gpt-realtime";
    const sdpResponse = await fetch(`https://api.openai.com/v1/realtime/calls?model=${realtimeModel}`, {
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
    addMessage("system", `Realtime connection failed: ${error.message}`);
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
      addMessage("system", `Transcribed voice. Review and press Send: ${text}`);
    }
  }
}

function speakWithRealtime(text) {
  if (!text || state.dataChannel?.readyState !== "open") return;
  state.dataChannel.send(
    JSON.stringify({
      type: "response.create",
      response: {
        modalities: ["audio", "text"],
        instructions: `Read this Codex response aloud exactly and briefly: ${text}`,
      },
    }),
  );
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

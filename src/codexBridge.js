import { EventEmitter } from "node:events";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { access } from "node:fs/promises";
import { constants } from "node:fs";
import { log } from "./logger.js";

const CODEX_BINARY_CANDIDATES = [
  process.env.CODEX_MESSENGER_CODEX_BIN,
  "/Applications/Codex.app/Contents/Resources/codex",
  "codex",
].filter(Boolean);
const CONNECT_BOOTSTRAP_PROMPT =
  "Start a Codex Messenger voice session. Reply exactly: Connected.";

async function resolveCodexBin() {
  for (const candidate of CODEX_BINARY_CANDIDATES) {
    if (candidate.includes("/")) {
      try {
        await access(candidate, constants.X_OK);
        return candidate;
      } catch {
        continue;
      }
    }
    return candidate;
  }

  return "codex";
}

export class CodexBridge extends EventEmitter {
  constructor({ codexBin = null, cwd = process.cwd() } = {}) {
    super();
    this.codexBin = codexBin;
    this.cwd = cwd;
    this.proc = null;
    this.nextId = 1;
    this.pending = new Map();
    this.initialized = false;
  }

  async ensureStarted() {
    if (this.initialized) return;
    if (!this.proc) await this.startProcess();

    log("info", "Initializing codex app-server", {
      codexBin: this.codexBin,
      cwd: this.cwd,
    });
    await this.request("initialize", {
      clientInfo: {
        name: "codex_messenger",
        title: "Codex Messenger",
        version: "0.1.0",
      },
      capabilities: {
        experimentalApi: true,
      },
    });
    this.notify("initialized", {});
    this.initialized = true;
    log("info", "Codex app-server initialized");
  }

  async startProcess() {
    this.codexBin ||= await resolveCodexBin();
    log("info", "Starting codex app-server process", {
      codexBin: this.codexBin,
      cwd: this.cwd,
    });
    this.proc = spawn(this.codexBin, ["app-server"], {
      cwd: this.cwd,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const proc = this.proc;

    this.proc.stderr.on("data", (chunk) => {
      const text = chunk.toString();
      log("debug", "codex app-server stderr", { text });
      this.emit("log", { level: "stderr", text });
    });

    const handleProcessError = (error) => {
      const wrapped = new Error(
        `Failed to start codex app-server using ${JSON.stringify(this.codexBin)}: ${error.message}. Set CODEX_MESSENGER_CODEX_BIN to the Codex binary path.`,
      );
      for (const { reject } of this.pending.values()) reject(wrapped);
      this.pending.clear();
      this.proc = null;
      this.initialized = false;
      log("error", "codex app-server process error", {
        codexBin: this.codexBin,
        error: wrapped.message,
      });
      this.emit("appServerError", wrapped);
    };
    this.proc.on("error", handleProcessError);

    this.proc.on("exit", (code, signal) => {
      const error = new Error(`codex app-server exited (${code ?? signal})`);
      for (const { reject } of this.pending.values()) reject(error);
      this.pending.clear();
      this.proc = null;
      this.initialized = false;
      log(code === 0 ? "info" : "warn", "codex app-server exited", {
        code,
        signal,
      });
      this.emit("exit", { code, signal });
    });

    const rl = createInterface({ input: this.proc.stdout });
    rl.on("line", (line) => this.handleLine(line));

    await new Promise((resolve, reject) => {
      const onError = (error) => {
        proc.off("spawn", onSpawn);
        reject(
          new Error(
            `Failed to start codex app-server using ${JSON.stringify(this.codexBin)}: ${error.message}. Set CODEX_MESSENGER_CODEX_BIN to the Codex binary path.`,
          ),
        );
      };
      const onSpawn = () => {
        proc.off("error", onError);
        log("info", "codex app-server process spawned", {
          pid: proc.pid,
          codexBin: this.codexBin,
        });
        resolve();
      };
      proc.once("error", onError);
      proc.once("spawn", onSpawn);
    });
  }

  handleLine(line) {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      log("debug", "codex app-server non-json output", { line });
      this.emit("log", { level: "stdout", text: line });
      return;
    }

    if (message.id && this.pending.has(message.id)) {
      const { resolve, reject } = this.pending.get(message.id);
      this.pending.delete(message.id);
      if (message.error) {
        log("warn", "codex app-server response error", {
          id: message.id,
          error: message.error.message,
        });
        reject(new Error(message.error.message || "Codex app-server request failed"));
      } else {
        log("debug", "codex app-server response", { id: message.id });
        resolve(message.result);
      }
      return;
    }

    if (message.method) {
      log("debug", "codex app-server notification", {
        method: message.method,
        threadId: message.params?.threadId || message.params?.thread?.id,
      });
      this.emit("event", message);
    }
  }

  request(method, params = {}) {
    if (!this.proc?.stdin.writable) {
      return Promise.reject(new Error("Codex app-server is not running"));
    }

    const id = String(this.nextId++);
    const payload = { id, method, params };
    log("debug", "codex app-server request", {
      id,
      method,
      threadId: params.threadId,
    });
    this.proc.stdin.write(`${JSON.stringify(payload)}\n`);

    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });
  }

  notify(method, params = {}) {
    if (!this.proc?.stdin.writable) return;
    log("debug", "codex app-server notification sent", { method });
    this.proc.stdin.write(`${JSON.stringify({ method, params })}\n`);
  }

  async startOrResumeThread(conversation) {
    await this.ensureStarted();

    if (conversation.codexThreadId) {
      log("info", "Resuming Codex thread", {
        conversationId: conversation.conversationId,
        threadId: conversation.codexThreadId,
      });
      const result = await this.request("thread/resume", {
        threadId: conversation.codexThreadId,
      });
      return result.thread;
    }

    log("info", "Starting Codex thread", {
      conversationId: conversation.conversationId,
      cwd: this.cwd,
    });
    const result = await this.request("thread/start", {
      cwd: this.cwd,
    });
    log("info", "Started Codex thread", {
      conversationId: conversation.conversationId,
      threadId: result.thread?.id,
    });
    return result.thread;
  }

  async prepareThreadForDesktop(conversation, { onEvent } = {}) {
    const thread = await this.startOrResumeThread(conversation);

    if (conversation.codexThreadReadyAt) {
      return { thread, bootstrapped: false };
    }

    const turnResult = await this.startTurnAndWait({
      threadId: thread.id,
      input: CONNECT_BOOTSTRAP_PROMPT,
      conversationId: conversation.conversationId,
      purpose: "connect_bootstrap",
      onEvent,
    });

    return {
      thread,
      bootstrapped: true,
      turnId: turnResult.turnId,
      finalText: turnResult.finalText,
    };
  }

  async runTurn({ conversation, message, onEvent }) {
    const eventHandler = (event) => onEvent?.(event);
    this.on("event", eventHandler);

    try {
      const thread = await this.startOrResumeThread(conversation);
      return await this.startTurnAndWait({
        threadId: thread.id,
        input: message,
        conversationId: conversation.conversationId,
        purpose: "user_message",
      });
    } finally {
      this.off("event", eventHandler);
    }
  }

  async startTurnAndWait({ threadId, input, conversationId, purpose, onEvent }) {
    log("info", "Starting Codex turn", {
      conversationId,
      threadId,
      purpose,
      inputChars: input.length,
    });
    const turnResult = await this.request("turn/start", {
      threadId,
      input: [{ type: "text", text: input }],
    });
    const turnId = turnResult.turn.id;

    const finalText = await this.waitForTurn(threadId, turnId, onEvent);

    log("info", "Completed Codex turn", {
      conversationId,
      threadId,
      turnId,
      purpose,
      finalChars: finalText.length,
    });

    return { threadId, turnId, finalText };
  }

  waitForTurn(threadId, turnId, onEvent) {
    return new Promise((resolve, reject) => {
      let finalText = "";
      const timeout = setTimeout(() => {
        cleanup();
        reject(new Error("Timed out waiting for Codex turn"));
      }, 10 * 60 * 1000);

      const cleanup = () => {
        clearTimeout(timeout);
        this.off("event", handler);
      };

      const handler = (event) => {
        onEvent?.(event);
        if (
          event.method === "item/completed" &&
          event.params?.threadId === threadId &&
          event.params?.turnId === turnId &&
          event.params?.item?.type === "agentMessage" &&
          typeof event.params.item.text === "string"
        ) {
          finalText += event.params.item.text;
        }

        if (
          event.method === "turn/completed" &&
          event.params?.threadId === threadId &&
          event.params?.turn?.id === turnId
        ) {
          cleanup();
          resolve(finalText.trim());
        }
      };

      this.on("event", handler);
    });
  }

  async interrupt(threadId) {
    await this.ensureStarted();
    return this.request("turn/interrupt", { threadId });
  }
}

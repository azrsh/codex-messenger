import { EventEmitter } from "node:events";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

export class CodexBridge extends EventEmitter {
  constructor({ codexBin = process.env.CODEX_MESSENGER_CODEX_BIN || "codex", cwd = process.cwd() } = {}) {
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
    if (!this.proc) this.startProcess();

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
  }

  startProcess() {
    this.proc = spawn(this.codexBin, ["app-server"], {
      cwd: this.cwd,
      stdio: ["pipe", "pipe", "pipe"],
    });

    this.proc.stderr.on("data", (chunk) => {
      this.emit("log", { level: "stderr", text: chunk.toString() });
    });

    this.proc.on("exit", (code, signal) => {
      const error = new Error(`codex app-server exited (${code ?? signal})`);
      for (const { reject } of this.pending.values()) reject(error);
      this.pending.clear();
      this.proc = null;
      this.initialized = false;
      this.emit("exit", { code, signal });
    });

    const rl = createInterface({ input: this.proc.stdout });
    rl.on("line", (line) => this.handleLine(line));
  }

  handleLine(line) {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      this.emit("log", { level: "stdout", text: line });
      return;
    }

    if (message.id && this.pending.has(message.id)) {
      const { resolve, reject } = this.pending.get(message.id);
      this.pending.delete(message.id);
      if (message.error) {
        reject(new Error(message.error.message || "Codex app-server request failed"));
      } else {
        resolve(message.result);
      }
      return;
    }

    if (message.method) {
      this.emit("event", message);
    }
  }

  request(method, params = {}) {
    if (!this.proc?.stdin.writable) {
      return Promise.reject(new Error("Codex app-server is not running"));
    }

    const id = String(this.nextId++);
    const payload = { id, method, params };
    this.proc.stdin.write(`${JSON.stringify(payload)}\n`);

    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });
  }

  notify(method, params = {}) {
    if (!this.proc?.stdin.writable) return;
    this.proc.stdin.write(`${JSON.stringify({ method, params })}\n`);
  }

  async startOrResumeThread(conversation) {
    await this.ensureStarted();

    if (conversation.codexThreadId) {
      const result = await this.request("thread/resume", {
        threadId: conversation.codexThreadId,
      });
      return result.thread;
    }

    const result = await this.request("thread/start", {
      cwd: this.cwd,
    });
    return result.thread;
  }

  async runTurn({ conversation, message, onEvent }) {
    const eventHandler = (event) => onEvent?.(event);
    this.on("event", eventHandler);

    let finalText = "";
    try {
      const thread = await this.startOrResumeThread(conversation);
      const threadId = thread.id;

      const turnResult = await this.request("turn/start", {
        threadId,
        input: [{ type: "text", text: message }],
      });
      const turnId = turnResult.turn.id;

      finalText = await this.waitForTurn(threadId, turnId, (event) => {
        if (
          event.method === "item/completed" &&
          event.params?.item?.type === "agentMessage" &&
          typeof event.params.item.text === "string"
        ) {
          finalText += event.params.item.text;
        }
      });

      return { threadId, turnId, finalText };
    } finally {
      this.off("event", eventHandler);
    }
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

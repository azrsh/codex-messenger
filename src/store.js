import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";

export function defaultStateDir() {
  return process.env.CODEX_MESSENGER_HOME || join(homedir(), ".codex-messenger");
}

export class ConversationStore {
  constructor(filePath = join(defaultStateDir(), "conversations.json")) {
    this.filePath = filePath;
    this.data = { conversations: [] };
  }

  async load() {
    try {
      const content = await readFile(this.filePath, "utf8");
      const parsed = JSON.parse(content);
      this.data = {
        conversations: Array.isArray(parsed.conversations)
          ? parsed.conversations
          : [],
      };
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      this.data = { conversations: [] };
    }
  }

  async save() {
    await mkdir(dirname(this.filePath), { recursive: true });
    await writeFile(this.filePath, `${JSON.stringify(this.data, null, 2)}\n`);
  }

  list() {
    return [...this.data.conversations].sort((a, b) => b.updatedAt - a.updatedAt);
  }

  get(conversationId) {
    return this.data.conversations.find((item) => item.conversationId === conversationId);
  }

  async ensure(conversationId = randomUUID()) {
    const existing = this.get(conversationId);
    if (existing) return existing;

    const now = Date.now();
    const created = {
      conversationId,
      codexThreadId: null,
      createdAt: now,
      updatedAt: now,
      lastKnownTitle: "New conversation",
    };
    this.data.conversations.push(created);
    await this.save();
    return created;
  }

  async update(conversationId, patch) {
    const conversation = await this.ensure(conversationId);
    Object.assign(conversation, patch, { updatedAt: Date.now() });
    await this.save();
    return conversation;
  }
}

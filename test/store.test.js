import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ConversationStore } from "../src/store.js";

test("ConversationStore persists minimal conversation metadata", async () => {
  const dir = await mkdtemp(join(tmpdir(), "codex-messenger-store-"));
  const file = join(dir, "conversations.json");
  const store = new ConversationStore(file);
  await store.load();

  const created = await store.ensure("conv-1");
  assert.equal(created.conversationId, "conv-1");
  assert.equal(created.codexThreadId, null);

  await store.update("conv-1", {
    codexThreadId: "thread-1",
    codexThreadReadyAt: 123,
    lastKnownTitle: "Hello",
  });

  const reloaded = new ConversationStore(file);
  await reloaded.load();

  assert.deepEqual(reloaded.list().map((item) => ({
    conversationId: item.conversationId,
    codexThreadId: item.codexThreadId,
    codexThreadReadyAt: item.codexThreadReadyAt,
    lastKnownTitle: item.lastKnownTitle,
  })), [
    {
      conversationId: "conv-1",
      codexThreadId: "thread-1",
      codexThreadReadyAt: 123,
      lastKnownTitle: "Hello",
    },
  ]);
});

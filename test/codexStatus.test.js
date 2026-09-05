import assert from "node:assert/strict";
import test from "node:test";
import { summarizeThreadStatus } from "../src/codexStatus.js";

function summarize(items, status = "inProgress") {
  return summarizeThreadStatus({ turns: [{ id: "turn-1", status, items }] }, "turn-1");
}

test("prioritizes a running action over later commentary and omits reasoning", () => {
  const result = summarize([
    { type: "commandExecution", status: "inProgress", command: "npm test" },
    { type: "agentMessage", phase: "commentary", text: "Checking the tests." },
    { type: "reasoning", summary: ["private summary"], content: ["private content"] },
  ]);
  assert.equal(result.status, "running");
  assert.equal(result.progress, "Codex is running a command: npm test");
  assert.equal(result.progressDetails.length, 2);
  assert.equal(JSON.stringify(result).includes("private"), false);
  assert.equal(result.finalText, "");
});

test("uses commentary without treating it as a final answer", () => {
  const result = summarize([{ type: "agentMessage", phase: "commentary", text: "I found the affected file." }]);
  assert.equal(result.progress, "Codex update: I found the affected file.");
  assert.equal(result.finalText, "");
});

test("completed actions do not imply the request or tests succeeded", () => {
  for (const item of [
    { type: "commandExecution", status: "completed", command: "npm test", exitCode: 0 },
    { type: "fileChange", status: "completed", changes: [{ path: "app.js", kind: "update" }] },
    { type: "dynamicToolCall", status: "completed", tool: "inspect", success: true },
  ]) {
    const result = summarize([item]);
    assert.equal(result.status, "running");
    assert.match(result.progress, /the request is still running/);
    assert.doesNotMatch(result.progress, /tests passed|request is complete/);
  }
});

test("reports command and tool failures without declaring the whole request failed", () => {
  for (const item of [
    { type: "commandExecution", status: "completed", exitCode: 1 },
    { type: "dynamicToolCall", status: "completed", success: false },
  ]) {
    const result = summarize([item]);
    assert.equal(result.status, "running");
    assert.match(result.progress, /fail/);
  }
});

test("unknown action states do not claim completion", () => {
  for (const type of ["commandExecution", "fileChange", "dynamicToolCall"]) {
    assert.match(summarize([{ type }]).progress, /completion is not confirmed/);
  }
  assert.equal(summarize([{ type: "unknown" }]).progress, "Codex is still working.");
});

test("terminal turn status overrides item activity and preserves the final answer", () => {
  for (const status of ["completed", "failed", "interrupted"]) {
    const result = summarize([
      { type: "commandExecution", status: "inProgress", command: "npm test" },
      { type: "agentMessage", phase: "final_answer", text: "Final answer" },
    ], status);
    assert.equal(result.status, status);
    assert.equal(result.finalText, "Final answer");
    assert.doesNotMatch(result.progress, /running/);
  }
});

test("progress details stay bounded and belong to the requested turn", () => {
  const result = summarizeThreadStatus({ turns: [
    { id: "old", status: "completed", items: [{ type: "agentMessage", text: "Unrelated" }] },
    { id: "current", status: "inProgress", items: Array.from({ length: 20 }, () => ({
      type: "agentMessage", phase: "commentary", text: "x".repeat(500),
    })) },
  ] }, "current");
  assert.equal(result.progressDetails.length, 8);
  assert.ok(result.progressDetails.every((item) => item.text.length <= 240));
  assert.equal(JSON.stringify(result).includes("Unrelated"), false);
});

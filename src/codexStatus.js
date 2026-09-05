export function summarizeThreadStatus(thread, turnId) {
  const turns = Array.isArray(thread.turns) ? thread.turns : [];
  const turn = turnId
    ? turns.find((candidate) => candidate.id === turnId)
    : turns.at(-1);

  if (!turn) {
    return {
      status: statusFromThread(thread.status),
      progress: "Codex thread is available, but the requested turn is not loaded yet.",
    };
  }

  const finalText = extractFinalText(turn);
  const progress = summarizeTurnProgress(turn, finalText);
  const progressDetails = summarizeProgressDetails(turn);
  return {
    turnId: turn.id,
    status: statusFromTurn(turn.status),
    progress,
    progressDetails,
    finalText,
    error: turn.error?.message,
  };
}

function statusFromTurn(status) {
  switch (status) {
    case "completed":
      return "completed";
    case "failed":
      return "failed";
    case "interrupted":
      return "interrupted";
    default:
      return "running";
  }
}

function statusFromThread(status) {
  return status?.type === "active" ? "running" : "unknown";
}

function extractFinalText(turn) {
  return (turn.items || [])
    .filter((item) =>
      item.type === "agentMessage" &&
      typeof item.text === "string" &&
      (!item.phase || item.phase === "final_answer")
    )
    .map((item) => item.text)
    .join("")
    .trim();
}

function summarizeTurnProgress(turn, finalText) {
  if (turn.status === "completed") {
    return finalText
      ? "Codex completed the request and produced a final answer."
      : "Codex completed the request.";
  }
  if (turn.status === "failed") {
    return "Codex failed the request.";
  }
  if (turn.status === "interrupted") {
    return "Codex was interrupted.";
  }

  const items = (turn.items || []).map(summarizeThreadItem).filter(Boolean);
  const lastItem = [...items].reverse().find((item) => item.status === "inProgress") || items.at(-1);
  if (!lastItem) return "Codex is still working.";
  switch (lastItem.type) {
    case "agentMessage":
      return lastItem.phase === "commentary"
        ? `Codex update: ${lastItem.text}`
        : "Codex has produced assistant output; the request is still running.";
    case "plan":
      return "Codex has updated its plan; the request is still running.";
    case "commandExecution":
      if (lastItem.status === "inProgress") return `Codex is running a command: ${lastItem.command}`;
      if (lastItem.status === "failed" || (lastItem.exitCode !== null && lastItem.exitCode !== 0)) {
        return `A Codex command failed${lastItem.exitCode !== null ? ` (exit code ${lastItem.exitCode})` : ""}; the request is still running.`;
      }
      return lastItem.status === "completed"
        ? "Codex finished a command; the request is still running."
        : "Codex is processing a command; its completion is not confirmed.";
    case "fileChange":
      if (lastItem.status === "inProgress") return "Codex is editing files.";
      if (lastItem.status === "failed" || lastItem.status === "declined") return "Codex could not apply a file change; the request is still running.";
      return lastItem.status === "completed"
        ? "Codex applied file changes; the request is still running."
        : "Codex is processing file changes; their completion is not confirmed.";
    case "dynamicToolCall":
    case "collabAgentToolCall":
      if (lastItem.status === "inProgress") return `Codex is waiting for a tool: ${lastItem.tool}`;
      if (lastItem.status === "failed" || lastItem.success === false) return "A Codex tool reported a failure; the request is still running.";
      return lastItem.status === "completed"
        ? "A Codex tool finished; the request is still running."
        : "Codex is using a tool; its completion is not confirmed.";
    default:
      return "Codex is still working.";
  }
}

function summarizeProgressDetails(turn) {
  return (turn.items || [])
    .map(summarizeThreadItem)
    .filter(Boolean)
    .slice(-8);
}

function summarizeThreadItem(item) {
  switch (item.type) {
    case "agentMessage":
      return {
        type: "agentMessage",
        phase: item.phase || null,
        text: truncate(item.text, 240),
      };
    case "plan":
      return {
        type: "plan",
        text: truncate(item.text, 240),
      };
    case "reasoning":
      return null;
    case "commandExecution":
      return {
        type: "commandExecution",
        status: item.status,
        command: truncate(item.command, 180),
        exitCode: item.exitCode ?? null,
        output: truncate(item.aggregatedOutput || "", 240),
      };
    case "fileChange":
      return {
        type: "fileChange",
        status: item.status,
        changes: (item.changes || []).slice(0, 5).map((change) => ({
          kind: change.type || change.kind || "change",
          path: change.path || change.moveTo || change.sourcePath || null,
        })),
      };
    case "dynamicToolCall":
      return {
        type: "dynamicToolCall",
        status: item.status,
        tool: item.namespace ? `${item.namespace}.${item.tool}` : item.tool,
        success: item.success,
      };
    case "collabAgentToolCall":
      return {
        type: "collabAgentToolCall",
        status: item.status,
        tool: item.tool,
        receivers: item.receiverThreadIds || [],
      };
    default:
      return null;
  }
}

function truncate(value, maxLength) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength - 3)}...`;
}

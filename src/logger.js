const LEVELS = new Set(["debug", "info", "warn", "error"]);
const LOG_LEVEL = process.env.CODEX_MESSENGER_LOG_LEVEL || "debug";
const ORDER = ["debug", "info", "warn", "error"];

function shouldLog(level) {
  const normalized = LEVELS.has(level) ? level : "info";
  return ORDER.indexOf(normalized) >= ORDER.indexOf(LOG_LEVEL);
}

export function log(level, message, fields = {}) {
  if (!shouldLog(level)) return;
  const entry = {
    timestamp: new Date().toISOString(),
    level,
    message,
    ...fields,
  };
  console.error(JSON.stringify(entry));
}

export function redact(value) {
  if (typeof value !== "string") return value;
  if (value.length <= 8) return "[redacted]";
  return `${value.slice(0, 4)}...[redacted]...${value.slice(-4)}`;
}

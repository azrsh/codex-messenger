export const DEFAULT_OPENAI_BASE_URL = "https://api.openai.com/v1";
export const DEFAULT_REALTIME_MODEL = "gpt-realtime";

export function getRealtimeModel(env = process.env) {
  return env.CODEX_MESSENGER_REALTIME_MODEL || DEFAULT_REALTIME_MODEL;
}

export function getOpenAIBaseUrl(env = process.env) {
  return normalizeOpenAIBaseUrl(
    env.OPENAI_BASE_URL || env.OPENAI_API_BASE_URL || DEFAULT_OPENAI_BASE_URL,
  );
}

export function normalizeOpenAIBaseUrl(value) {
  const raw = String(value || "").trim();
  if (!raw) return DEFAULT_OPENAI_BASE_URL;

  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`Invalid OpenAI base URL: ${raw}`);
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`OpenAI base URL must use http or https: ${raw}`);
  }

  url.hash = "";
  url.search = "";
  url.pathname = url.pathname.replace(/\/+$/, "") || "/v1";
  return url.toString().replace(/\/$/, "");
}

export function openAIEndpoint(path, env = process.env) {
  const baseUrl = `${getOpenAIBaseUrl(env)}/`;
  const relativePath = String(path).replace(/^\/+/, "");
  return new URL(relativePath, baseUrl).toString();
}

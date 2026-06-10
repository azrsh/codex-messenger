import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_OPENAI_BASE_URL,
  getOpenAIBaseUrl,
  getRealtimeModel,
  normalizeOpenAIBaseUrl,
  openAIEndpoint,
} from "../src/openaiConfig.js";

test("getOpenAIBaseUrl defaults to the OpenAI v1 API", () => {
  assert.equal(getOpenAIBaseUrl({}), DEFAULT_OPENAI_BASE_URL);
});

test("getOpenAIBaseUrl accepts OPENAI_BASE_URL and removes trailing slashes", () => {
  assert.equal(
    getOpenAIBaseUrl({ OPENAI_BASE_URL: "https://proxy.example.test/openai/v1///" }),
    "https://proxy.example.test/openai/v1",
  );
});

test("getOpenAIBaseUrl falls back to OPENAI_API_BASE_URL", () => {
  assert.equal(
    getOpenAIBaseUrl({ OPENAI_API_BASE_URL: "http://127.0.0.1:8080/v1" }),
    "http://127.0.0.1:8080/v1",
  );
});

test("normalizeOpenAIBaseUrl treats host-only URLs as OpenAI API roots", () => {
  assert.equal(normalizeOpenAIBaseUrl("https://proxy.example.test"), "https://proxy.example.test/v1");
});

test("normalizeOpenAIBaseUrl rejects unsupported protocols", () => {
  assert.throws(
    () => normalizeOpenAIBaseUrl("file:///tmp/openai"),
    /must use http or https/,
  );
});

test("openAIEndpoint appends endpoint paths below the configured base path", () => {
  assert.equal(
    openAIEndpoint("/realtime/client_secrets", {
      OPENAI_BASE_URL: "https://proxy.example.test/openai/v1",
    }),
    "https://proxy.example.test/openai/v1/realtime/client_secrets",
  );
});

test("getRealtimeModel supports model override", () => {
  assert.equal(getRealtimeModel({ CODEX_MESSENGER_REALTIME_MODEL: "gpt-realtime-mini" }), "gpt-realtime-mini");
});

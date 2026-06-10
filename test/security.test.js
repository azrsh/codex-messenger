import test from "node:test";
import assert from "node:assert/strict";
import {
  constantTimeEqual,
  isAllowedFetchSite,
  isAllowedHost,
  isAllowedOrigin,
} from "../src/security.js";

test("constantTimeEqual accepts only exact string matches", () => {
  assert.equal(constantTimeEqual("abc", "abc"), true);
  assert.equal(constantTimeEqual("abc", "abd"), false);
  assert.equal(constantTimeEqual("abc", "abcd"), false);
  assert.equal(constantTimeEqual("abc", null), false);
});

test("host validation only allows loopback hosts on the active port", () => {
  assert.equal(isAllowedHost("127.0.0.1:3000", 3000), true);
  assert.equal(isAllowedHost("localhost:3000", 3000), true);
  assert.equal(isAllowedHost("[::1]:3000", 3000), true);
  assert.equal(isAllowedHost("evil.test:3000", 3000), false);
  assert.equal(isAllowedHost("127.0.0.1:4000", 3000), false);
});

test("origin validation allows same loopback origin and rejects remote origins", () => {
  assert.equal(isAllowedOrigin("http://127.0.0.1:3000", 3000), true);
  assert.equal(isAllowedOrigin("http://localhost:3000", 3000), true);
  assert.equal(isAllowedOrigin("https://127.0.0.1:3000", 3000), false);
  assert.equal(isAllowedOrigin("http://example.com:3000", 3000), false);
});

test("fetch site validation rejects cross-site requests", () => {
  assert.equal(isAllowedFetchSite("same-origin"), true);
  assert.equal(isAllowedFetchSite("none"), true);
  assert.equal(isAllowedFetchSite("cross-site"), false);
});

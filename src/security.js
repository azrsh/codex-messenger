import { randomBytes, timingSafeEqual } from "node:crypto";

export function createCapabilityToken() {
  return randomBytes(32).toString("base64url");
}

export function constantTimeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

export function isAllowedHost(hostHeader, port) {
  if (!hostHeader) return false;
  const host = hostHeader.toLowerCase();
  return (
    host === `127.0.0.1:${port}` ||
    host === `localhost:${port}` ||
    host === `[::1]:${port}`
  );
}

export function isAllowedOrigin(originHeader, port) {
  if (!originHeader) return true;
  try {
    const origin = new URL(originHeader);
    const host = origin.hostname.toLowerCase();
    return (
      origin.protocol === "http:" &&
      origin.port === String(port) &&
      (host === "127.0.0.1" || host === "localhost" || host === "::1")
    );
  } catch {
    return false;
  }
}

export function isAllowedFetchSite(value) {
  if (!value) return true;
  return value === "same-origin" || value === "none";
}

export function getBearerToken(req) {
  const header = req.headers.authorization || "";
  const match = /^Bearer\s+(.+)$/i.exec(header);
  return match?.[1] ?? "";
}

export function validateApiRequest(req, { token, port, allowQueryToken = false }) {
  if (!isAllowedHost(req.headers.host, port)) {
    return { ok: false, status: 403, message: "Invalid Host header" };
  }
  if (!isAllowedOrigin(req.headers.origin, port)) {
    return { ok: false, status: 403, message: "Invalid Origin header" };
  }
  if (!isAllowedFetchSite(req.headers["sec-fetch-site"])) {
    return { ok: false, status: 403, message: "Invalid fetch site" };
  }

  let presented = getBearerToken(req);
  if (!presented && allowQueryToken) {
    const url = new URL(req.url, `http://127.0.0.1:${port}`);
    presented = url.searchParams.get("token") ?? "";
  }

  if (!constantTimeEqual(presented, token)) {
    return { ok: false, status: 401, message: "Missing or invalid token" };
  }

  return { ok: true };
}

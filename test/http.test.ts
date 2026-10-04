import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { loadConfig, type Config } from "../src/config.js";
import { JsonHttpClient, retryAfterMs } from "../src/http.js";

function response(status: number, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(status === 200 ? [] : { error: "fictional" }), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

function fakeClient(
  replies: Array<Response | Error>,
  overrides: Partial<Config> = {},
): {
  http: JsonHttpClient;
  pauses: number[];
  calls: Array<{ url: URL; method: string | undefined; correctAuth: boolean }>;
} {
  const config = {
    ...loadConfig({
      FRESHDESK_DOMAIN: "fictional-merchant.freshdesk.com",
      FRESHDESK_API_KEY: randomBytes(24).toString("hex"),
    }),
    ...overrides,
  };
  let clock = Date.UTC(2026, 8, 1);
  const pauses: number[] = [];
  const calls: Array<{
    url: URL;
    method: string | undefined;
    correctAuth: boolean;
  }> = [];
  const http = new JsonHttpClient(config, {
    now: () => clock,
    random: () => 0,
    sleep: async (ms) => {
      pauses.push(ms);
      clock += ms;
    },
    fetch: async (input, init) => {
      calls.push({
        url: new URL(String(input)),
        method: init?.method,
        correctAuth:
          new Headers(init?.headers).get("authorization") ===
          `Basic ${Buffer.from(`${config.apiKey}:X`).toString("base64")}`,
      });
      assert.equal(init?.redirect, "manual");
      const next = replies.shift();
      if (next === undefined) throw new Error("Unexpected extra provider request.");
      if (next instanceof Error) throw next;
      return next;
    },
  });
  return { http, pauses, calls };
}

test("GET uses Basic API-key auth and safely URL-encodes parameters", async () => {
  const { http, calls } = fakeClient([response(200)]);
  const query = `"status:2 AND tag:'payment recovery'"`;
  const result = await http.get("search/tickets", { query });
  assert.deepEqual(result.value, []);
  assert.equal(calls[0]?.method, "GET");
  assert.equal(calls[0]?.correctAuth, true);
  assert.equal(calls[0]?.url.searchParams.get("query"), query);
  assert.equal(result.attempts, 1);
});

test("429 Retry-After seconds are respected before a successful retry", async () => {
  const { http, pauses, calls } = fakeClient([
    response(429, { "Retry-After": "2" }),
    response(200),
  ]);
  const result = await http.get("tickets");
  assert.equal(result.attempts, 2);
  assert.deepEqual(pauses, [2000]);
  assert.equal(calls.length, 2);
});

test("HTTP-date Retry-After is supported without rounding down", () => {
  const now = Date.UTC(2026, 8, 1, 0, 0, 0, 100);
  const header = new Date(now + 3000).toUTCString();
  assert.equal(retryAfterMs(header, now, 200), 2900);
  assert.equal(retryAfterMs("0.125", now, 200), 125);
  assert.equal(retryAfterMs(null, now, 200), 200);
  assert.equal(retryAfterMs(new Date(now - 1000).toUTCString(), now, 200), 0);
});

test("malformed Retry-After is an error, not an immediate unsafe retry", () => {
  for (const value of ["garbage", "-1", "", "Infinity", "1e3"]) {
    assert.throws(() => retryAfterMs(value, Date.now(), 200), {
      code: "UPSTREAM_INVALID_RESPONSE",
    });
  }
});

test("long 429 delay is reported and shared cooldown prevents another call", async () => {
  const { http, calls, pauses } = fakeClient([
    response(429, { "Retry-After": "60" }),
  ]);
  await assert.rejects(http.get("tickets"), {
    code: "RATE_LIMITED",
    retryAfterMs: 60000,
  });
  await assert.rejects(http.get("tickets/1001"), {
    code: "RATE_LIMITED",
    retryAfterMs: 60000,
  });
  assert.equal(calls.length, 1);
  assert.deepEqual(pauses, []);
});

test("repeated 429s stop after the exact configured number of attempts", async () => {
  const { http, calls, pauses } = fakeClient([
    response(429, { "Retry-After": "1" }),
    response(429, { "Retry-After": "1" }),
    response(429, { "Retry-After": "1" }),
  ]);
  await assert.rejects(http.get("tickets"), { code: "RATE_LIMITED" });
  assert.equal(calls.length, 3);
  assert.deepEqual(pauses, [1000, 1000]);
});

test("total retry sleep never exceeds the configured wait budget", async () => {
  const { http, pauses, calls } = fakeClient(
    [
      response(429, { "Retry-After": "1" }),
      response(429, { "Retry-After": "1" }),
    ],
    { maxWaitMs: 1500 },
  );
  await assert.rejects(http.get("tickets"), { code: "RATE_LIMITED" });
  assert.deepEqual(pauses, [1000]);
  assert.equal(calls.length, 2);
});

for (const [status, code] of [
  [401, "AUTHENTICATION_FAILED"],
  [403, "PERMISSION_DENIED"],
  [404, "NOT_FOUND"],
  [400, "UPSTREAM_REJECTED"],
  [500, "UPSTREAM_REJECTED"],
] as const) {
  test(`HTTP ${status} is explicit and not retried`, async () => {
    const { http, calls, pauses } = fakeClient([response(status)]);
    await assert.rejects(http.get("tickets"), { code });
    assert.equal(calls.length, 1);
    assert.deepEqual(pauses, []);
  });
}

test("transient 503s retry with bounded exponential backoff", async () => {
  const { http, pauses, calls } = fakeClient([
    response(503),
    response(503),
    response(200),
  ]);
  assert.equal((await http.get("tickets")).attempts, 3);
  assert.deepEqual(pauses, [200, 400]);
  assert.equal(calls.length, 3);
});

test("503 also respects a provider Retry-After interval", async () => {
  const { http, pauses } = fakeClient([
    response(503, { "Retry-After": "2" }),
    response(200),
  ]);
  await http.get("tickets");
  assert.deepEqual(pauses, [2000]);
});

test("network errors are sanitized and retried only within the configured limit", async () => {
  const { http, calls } = fakeClient([
    new TypeError("A fictional sensitive network detail"),
    new TypeError("Another fictional sensitive network detail"),
    new TypeError("A final fictional sensitive detail"),
  ]);
  await assert.rejects(http.get("tickets"), (error: unknown) => {
    assert(error instanceof Error);
    assert.equal(error.message, "Unable to reach Freshdesk.");
    return true;
  });
  assert.equal(calls.length, 3);
});

test("redirects are refused instead of forwarding credentials elsewhere", async () => {
  const { http, calls } = fakeClient([
    response(302, { Location: "https://untrusted.example/collect" }),
  ]);
  await assert.rejects(http.get("tickets"), { code: "UPSTREAM_REDIRECT" });
  assert.equal(calls.length, 1);
});

test("malformed JSON and non-JSON success fail explicitly", async () => {
  const malformed = fakeClient([
    new Response("{not json", {
      headers: { "Content-Type": "application/json" },
    }),
  ]);
  await assert.rejects(malformed.http.get("tickets"), {
    code: "UPSTREAM_INVALID_RESPONSE",
  });
  assert.equal(malformed.calls.length, 1);
  const html = fakeClient([
    new Response("<html>Login</html>", {
      headers: { "Content-Type": "text/html" },
    }),
  ]);
  await assert.rejects(html.http.get("tickets"), {
    code: "UPSTREAM_INVALID_RESPONSE",
  });
});

test("streaming response size is capped at 2 MiB", async () => {
  const { http } = fakeClient([
    new Response(JSON.stringify("x".repeat(2 * 1024 * 1024)), {
      headers: { "Content-Type": "application/json" },
    }),
  ]);
  await assert.rejects(http.get("tickets"), {
    code: "UPSTREAM_INVALID_RESPONSE",
  });
});

test("rate-limit headers are exposed without interpreting missing values as zero", async () => {
  const { http } = fakeClient([
    response(200, {
      "X-RateLimit-Total": "100",
      "X-RateLimit-Remaining": "42",
      "X-RateLimit-Used-CurrentRequest": "1",
    }),
    response(200),
  ]);
  assert.deepEqual((await http.get("tickets")).rateLimit, {
    total: 100,
    remaining: 42,
    used_by_request: 1,
  });
  assert.deepEqual((await http.get("tickets")).rateLimit, {
    total: null,
    remaining: null,
    used_by_request: null,
  });
});

test("malformed rate-limit headers do not become successful bogus metadata", async () => {
  const { http } = fakeClient([
    response(200, { "X-RateLimit-Remaining": "unknown" }),
  ]);
  await assert.rejects(http.get("tickets"), {
    code: "UPSTREAM_INVALID_RESPONSE",
  });
});

test("documented Freshdesk whole-number decimal quota headers are accepted", async () => {
  const { http } = fakeClient([
    response(200, {
      "X-RateLimit-Total": "700.0",
      "X-RateLimit-Remaining": "426.0",
      "X-RateLimit-Used-CurrentRequest": "1",
    }),
  ]);
  assert.deepEqual((await http.get("tickets")).rateLimit, {
    total: 700,
    remaining: 426,
    used_by_request: 1,
  });
  const fractional = fakeClient([
    response(200, { "X-RateLimit-Remaining": "42.5" }),
  ]);
  await assert.rejects(fractional.http.get("tickets"), {
    code: "UPSTREAM_INVALID_RESPONSE",
  });
});

test("request budget includes retry attempts", async () => {
  const { http, calls } = fakeClient(
    [response(503), response(503)],
    { requestBudget: 2 },
  );
  await assert.rejects(http.get("tickets"), {
    code: "REQUEST_BUDGET_EXHAUSTED",
  });
  assert.equal(calls.length, 2);
  assert.equal(http.requestsUsed, 2);
});

test("cancellation before execution sends no provider request", async () => {
  const { http, calls } = fakeClient([]);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(http.get("tickets", {}, controller.signal), {
    code: "CANCELLED",
  });
  assert.equal(calls.length, 0);
});

test("arbitrary URL and write-shaped endpoints are not allowlisted", async () => {
  const { http, calls } = fakeClient([]);
  for (const endpoint of ["https://example.com", "../contacts", "contacts", "tickets/0"]) {
    await assert.rejects(http.get(endpoint), { code: "INVALID_INPUT" });
  }
  assert.equal(calls.length, 0);
});

test("concurrent caller requests are serialized per connector process", async () => {
  const config = loadConfig({
    FRESHDESK_DOMAIN: "fictional-merchant.freshdesk.com",
    FRESHDESK_API_KEY: randomBytes(24).toString("hex"),
  });
  let active = 0;
  let peak = 0;
  const http = new JsonHttpClient(config, {
    fetch: async () => {
      active += 1;
      peak = Math.max(peak, active);
      await delay(10);
      active -= 1;
      return response(200);
    },
  });
  await Promise.all([http.get("tickets"), http.get("tickets/1001"), http.get("tickets")]);
  assert.equal(peak, 1);
});

test("queue is bounded and overflow is returned as a retryable error", async () => {
  const config = loadConfig({
    FRESHDESK_DOMAIN: "fictional-merchant.freshdesk.com",
    FRESHDESK_API_KEY: randomBytes(24).toString("hex"),
  });
  const http = new JsonHttpClient(config, {
    fetch: async () => response(200),
  });
  const results = await Promise.allSettled(
    Array.from({ length: 33 }, () => http.get("tickets")),
  );
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 32);
  const failed = results.find((result) => result.status === "rejected");
  assert(failed?.status === "rejected");
  assert.equal(failed.reason.code, "RATE_LIMITED");
});

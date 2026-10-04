import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";
import { loadConfig } from "../src/config.js";

const runtimeKey = (): string => randomBytes(24).toString("hex");
const liveEnv = (): NodeJS.ProcessEnv => ({
  FRESHDESK_DOMAIN: "fictional-merchant.freshdesk.com",
  FRESHDESK_API_KEY: runtimeKey(),
});

test("live configuration uses HTTPS and conservative explicit defaults", () => {
  const config = loadConfig(liveEnv());
  assert.equal(config.baseUrl, "https://fictional-merchant.freshdesk.com/api/v2/");
  assert.equal(config.mode, "live");
  assert.equal(config.maxRetries, 2);
  assert.equal(config.timeoutMs, 5000);
  assert.equal(config.maxWaitMs, 5000);
  assert.equal(config.requestBudget, 1000);
});

test("demo configuration requires an explicit numeric loopback address", () => {
  const config = loadConfig({
    FRESHDESK_DEMO_MODE: "true",
    FRESHDESK_BASE_URL: "http://127.0.0.1:12345/api/v2",
    FRESHDESK_API_KEY: runtimeKey(),
  });
  assert.equal(config.baseUrl, "http://127.0.0.1:12345/api/v2/");
  assert.equal(config.mode, "demo");
});

for (const domain of [
  "http://merchant.freshdesk.com",
  "merchant.freshdesk.com.attacker.example",
  "merchant.freshdesk.com/path",
  "merchant.freshdesk.com:8443",
  "127.0.0.1",
  "your-subdomain.freshdesk.com",
]) {
  test(`rejects unsafe or placeholder live domain: ${domain}`, () => {
    assert.throws(
      () => loadConfig({ ...liveEnv(), FRESHDESK_DOMAIN: domain }),
      { code: "CONFIGURATION_ERROR" },
    );
  });
}

for (const baseUrl of [
  "http://localhost:12345/api/v2",
  "http://0.0.0.0:12345/api/v2",
  "http://example.com/api/v2",
  "https://127.0.0.1:12345/api/v2",
  "http://127.0.0.1:12345/other",
  "http://username:password@127.0.0.1:12345/api/v2",
  "http://127.0.0.1:12345/api/v2?query=anything",
]) {
  test(`rejects unsafe demo URL: ${baseUrl}`, () => {
    assert.throws(
      () =>
        loadConfig({
          FRESHDESK_DEMO_MODE: "true",
          FRESHDESK_BASE_URL: baseUrl,
          FRESHDESK_API_KEY: runtimeKey(),
        }),
      { code: "CONFIGURATION_ERROR" },
    );
  });
}

test("live mode forbids a custom URL even when it is HTTPS", () => {
  assert.throws(
    () =>
      loadConfig({
        ...liveEnv(),
        FRESHDESK_BASE_URL: "https://other.example/api/v2/",
      }),
    { code: "CONFIGURATION_ERROR" },
  );
});

test("demo mode cannot silently use a live tenant", () => {
  assert.throws(
    () =>
      loadConfig({
        ...liveEnv(),
        FRESHDESK_DEMO_MODE: "true",
        FRESHDESK_BASE_URL: "http://127.0.0.1:12345/api/v2/",
      }),
    { code: "CONFIGURATION_ERROR" },
  );
});

test("missing and malformed credentials fail without echoing their value", () => {
  for (const apiKey of [undefined, "", "short", "has:colon", "has whitespace"]) {
    const env = liveEnv();
    if (apiKey === undefined) delete env.FRESHDESK_API_KEY;
    else env.FRESHDESK_API_KEY = apiKey;
    assert.throws(() => loadConfig(env), (error: unknown) => {
      assert(error instanceof Error);
      assert(error.message.includes("FRESHDESK_API_KEY"));
      if (apiKey !== undefined && apiKey !== "") {
        assert(!error.message.includes(apiKey));
      }
      return true;
    });
  }
});

test("numeric settings validate both bounds and integer syntax", () => {
  for (const value of ["-1", "2.5", "abc", "4", ""]) {
    assert.throws(
      () => loadConfig({ ...liveEnv(), FRESHDESK_MAX_RETRIES: value }),
      { code: "CONFIGURATION_ERROR" },
    );
  }
  assert.throws(
    () => loadConfig({ ...liveEnv(), FRESHDESK_TIMEOUT_MS: "99" }),
    { code: "CONFIGURATION_ERROR" },
  );
  assert.throws(
    () => loadConfig({ ...liveEnv(), FRESHDESK_REQUEST_BUDGET: "0" }),
    { code: "CONFIGURATION_ERROR" },
  );
  assert.equal(
    loadConfig({ ...liveEnv(), FRESHDESK_MAX_RETRIES: "0" }).maxRetries,
    0,
  );
});

test("misspelled demo setting is an explicit error", () => {
  assert.throws(
    () => loadConfig({ ...liveEnv(), FRESHDESK_DEMO_MODE: "TRUE" }),
    { code: "CONFIGURATION_ERROR" },
  );
});

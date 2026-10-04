import { ConnectorError } from "./errors.js";

export interface Config {
  baseUrl: string;
  apiKey: string;
  mode: "live" | "demo";
  timeoutMs: number;
  maxRetries: number;
  maxWaitMs: number;
  requestBudget: number;
}

function fail(message: string): never {
  throw new ConnectorError("CONFIGURATION_ERROR", message);
}

function integerSetting(
  env: NodeJS.ProcessEnv,
  name: string,
  defaultValue: number,
  min: number,
  max: number,
): number {
  const value = env[name];
  if (value === undefined) return defaultValue;
  if (!/^\d+$/.test(value)) fail(`${name} must be an integer.`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    fail(`${name} must be between ${min} and ${max}.`);
  }
  return parsed;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const apiKey = env.FRESHDESK_API_KEY;
  if (
    apiKey === undefined ||
    apiKey.length < 8 ||
    apiKey.length > 256 ||
    !/^[\x21-\x7e]+$/.test(apiKey) ||
    apiKey.includes(":")
  ) {
    fail("Set FRESHDESK_API_KEY to a valid key through the environment.");
  }

  const demoSetting = env.FRESHDESK_DEMO_MODE;
  if (
    demoSetting !== undefined &&
    demoSetting !== "true" &&
    demoSetting !== "false"
  ) {
    fail("FRESHDESK_DEMO_MODE must be true or false.");
  }
  const mode = demoSetting === "true" ? "demo" : "live";
  let baseUrl: string;
  if (mode === "demo") {
    if (env.FRESHDESK_DOMAIN !== undefined) {
      fail("Demo mode cannot also specify a live Freshdesk domain.");
    }
    let url: URL;
    try {
      url = new URL(env.FRESHDESK_BASE_URL ?? "");
    } catch {
      fail("Demo mode requires a valid loopback FRESHDESK_BASE_URL.");
    }
    if (
      url.protocol !== "http:" ||
      url.hostname !== "127.0.0.1" ||
      url.username !== "" ||
      url.password !== "" ||
      url.search !== "" ||
      url.hash !== "" ||
      !/^\/api\/v2\/?$/.test(url.pathname)
    ) {
      fail("Demo mode only allows http://127.0.0.1:<port>/api/v2/.");
    }
    url.pathname = "/api/v2/";
    baseUrl = url.href;
  } else {
    if (env.FRESHDESK_BASE_URL !== undefined) {
      fail("A custom base URL is forbidden in live mode.");
    }
    const domain = env.FRESHDESK_DOMAIN;
    if (
      domain === undefined ||
      !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.freshdesk\.com$/.test(
        domain,
      ) ||
      domain === "your-subdomain.freshdesk.com"
    ) {
      fail("Set FRESHDESK_DOMAIN to your tenant's <subdomain>.freshdesk.com.");
    }
    baseUrl = `https://${domain}/api/v2/`;
  }

  return {
    baseUrl,
    apiKey,
    mode,
    timeoutMs: integerSetting(env, "FRESHDESK_TIMEOUT_MS", 5000, 100, 30000),
    maxRetries: integerSetting(env, "FRESHDESK_MAX_RETRIES", 2, 0, 3),
    maxWaitMs: integerSetting(env, "FRESHDESK_MAX_WAIT_MS", 5000, 0, 60000),
    requestBudget: integerSetting(
      env,
      "FRESHDESK_REQUEST_BUDGET",
      1000,
      1,
      100000,
    ),
  };
}

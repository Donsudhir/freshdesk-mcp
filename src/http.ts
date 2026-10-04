import { setTimeout as sleep } from "node:timers/promises";
import type { Config } from "./config.js";
import { ConnectorError } from "./errors.js";

const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_QUEUED_CALLS = 32;

export interface RateLimit {
  total: number | null;
  remaining: number | null;
  used_by_request: number | null;
}

export interface HttpResult {
  value: unknown;
  headers: Headers;
  attempts: number;
  rateLimit: RateLimit;
}

export interface HttpDependencies {
  fetch: typeof globalThis.fetch;
  now: () => number;
  random: () => number;
  sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
}

function quotaHeader(headers: Headers, name: string): number | null {
  const value = headers.get(name);
  if (value === null) return null;
  const parsed = Number(value);
  if (!/^\d+(?:\.0+)?$/.test(value) || !Number.isSafeInteger(parsed)) {
    throw new ConnectorError(
      "UPSTREAM_INVALID_RESPONSE",
      "Freshdesk returned an invalid rate-limit header.",
    );
  }
  return parsed;
}

export function retryAfterMs(
  header: string | null,
  now: number,
  fallback: number,
): number {
  if (header === null) return fallback;
  if (/^\d+(?:\.\d+)?$/.test(header)) {
    const milliseconds = Number(header) * 1000;
    if (Number.isFinite(milliseconds) && milliseconds <= Number.MAX_SAFE_INTEGER) {
      return Math.ceil(milliseconds);
    }
  } else if (
    /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(
      header,
    )
  ) {
    const date = Date.parse(header);
    if (Number.isFinite(date)) return Math.max(0, date - now);
  }
  throw new ConnectorError(
    "UPSTREAM_INVALID_RESPONSE",
    "Freshdesk returned an invalid Retry-After header.",
  );
}

async function readJson(response: Response): Promise<unknown> {
  if (!response.headers.get("content-type")?.includes("json")) {
    await response.body?.cancel();
    throw new ConnectorError(
      "UPSTREAM_INVALID_RESPONSE",
      "Freshdesk returned a non-JSON success response.",
    );
  }
  if (response.body === null) {
    throw new ConnectorError(
      "UPSTREAM_INVALID_RESPONSE",
      "Freshdesk returned an empty success response.",
    );
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = "";
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new ConnectorError(
          "UPSTREAM_INVALID_RESPONSE",
          "Freshdesk response exceeded the 2 MiB safety limit.",
        );
      }
      text += decoder.decode(chunk.value, { stream: true });
    }
    text += decoder.decode();
  } finally {
    reader.releaseLock();
  }
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    throw new ConnectorError(
      "UPSTREAM_INVALID_RESPONSE",
      "Freshdesk returned malformed JSON.",
    );
  }
}

export class JsonHttpClient {
  private queue: Promise<void> = Promise.resolve();
  private queuedCalls = 0;
  private blockedUntil = 0;
  private requestCount = 0;
  private readonly dependencies: HttpDependencies;

  constructor(
    private readonly config: Config,
    dependencies: Partial<HttpDependencies> = {},
  ) {
    this.dependencies = {
      fetch: globalThis.fetch,
      now: Date.now,
      random: Math.random,
      sleep: async (ms, signal) => {
        await sleep(ms, undefined, signal === undefined ? {} : { signal });
      },
      ...dependencies,
    };
  }

  get requestsUsed(): number {
    return this.requestCount;
  }

  async get(
    path: string,
    parameters: Record<string, string> = {},
    signal?: AbortSignal,
  ): Promise<HttpResult> {
    if (!/^(tickets(?:\/[1-9]\d*)?|search\/tickets)$/.test(path)) {
      throw new ConnectorError("INVALID_INPUT", "Endpoint is not allowlisted.");
    }
    if (this.queuedCalls >= MAX_QUEUED_CALLS) {
      throw new ConnectorError(
        "RATE_LIMITED",
        "The connector queue is full. Retry later.",
        true,
        1000,
      );
    }
    this.queuedCalls += 1;
    const result = this.queue.then(() =>
      this.performGet(path, parameters, signal),
    );
    // Only the queue tail absorbs failure; the caller retains the rejected result.
    this.queue = result.then(
      () => undefined,
      () => undefined,
    );
    try {
      return await result;
    } finally {
      this.queuedCalls -= 1;
    }
  }

  private assertActive(signal?: AbortSignal): void {
    if (signal?.aborted) {
      throw new ConnectorError("CANCELLED", "The request was cancelled.");
    }
  }

  private async pause(ms: number, signal?: AbortSignal): Promise<void> {
    this.assertActive(signal);
    try {
      await this.dependencies.sleep(ms, signal);
    } catch (error) {
      if (!signal?.aborted) throw error;
      throw new ConnectorError("CANCELLED", "The request was cancelled.");
    }
    this.assertActive(signal);
  }

  private async performGet(
    path: string,
    parameters: Record<string, string>,
    signal?: AbortSignal,
  ): Promise<HttpResult> {
    const url = new URL(path, this.config.baseUrl);
    for (const [key, value] of Object.entries(parameters)) {
      url.searchParams.set(key, value);
    }
    let waitedMs = 0;

    for (let attempt = 0; attempt <= this.config.maxRetries; attempt += 1) {
      this.assertActive(signal);
      const cooldown = Math.max(
        0,
        this.blockedUntil - this.dependencies.now(),
      );
      if (cooldown > this.config.maxWaitMs - waitedMs) {
        throw new ConnectorError(
          "RATE_LIMITED",
          "Freshdesk is cooling down. Retry after the indicated interval.",
          true,
          cooldown,
        );
      }
      if (cooldown > 0) {
        await this.pause(cooldown, signal);
        waitedMs += cooldown;
      }
      if (this.requestCount >= this.config.requestBudget) {
        throw new ConnectorError(
          "REQUEST_BUDGET_EXHAUSTED",
          "This connector process exhausted its configured request budget.",
        );
      }
      this.requestCount += 1;
      const fallbackDelay =
        200 * 2 ** attempt + Math.floor(this.dependencies.random() * 100);

      try {
        const result = await this.fetchOnce(url, fallbackDelay, signal);
        return { ...result, attempts: attempt + 1 };
      } catch (error) {
        if (!(error instanceof ConnectorError)) throw error;
        if (!error.retryable || attempt === this.config.maxRetries) throw error;
        if (error.code === "RATE_LIMITED") continue;
        const delay = error.retryAfterMs ?? fallbackDelay;
        if (delay > this.config.maxWaitMs - waitedMs) {
          throw new ConnectorError(
            error.code,
            `${error.message} Retry delay exceeds the connector wait budget.`,
            true,
            delay,
          );
        }
        await this.pause(delay, signal);
        waitedMs += delay;
      }
    }
    throw new ConnectorError("INTERNAL_ERROR", "Retry loop ended unexpectedly.");
  }

  private async fetchOnce(
    url: URL,
    fallbackDelay: number,
    signal?: AbortSignal,
  ): Promise<Omit<HttpResult, "attempts">> {
    const timeout = AbortSignal.timeout(this.config.timeoutMs);
    const combined =
      signal === undefined ? timeout : AbortSignal.any([timeout, signal]);
    try {
      const response = await this.dependencies.fetch(url, {
        method: "GET",
        redirect: "manual",
        headers: {
          Authorization: `Basic ${Buffer.from(`${this.config.apiKey}:X`).toString("base64")}`,
          Accept: "application/json",
          "User-Agent": "freshdesk-readonly-mcp/1.0.0",
        },
        signal: combined,
      });
      if (response.ok) {
        const value = await readJson(response);
        return {
          value,
          headers: response.headers,
          rateLimit: {
            total: quotaHeader(response.headers, "X-RateLimit-Total"),
            remaining: quotaHeader(response.headers, "X-RateLimit-Remaining"),
            used_by_request: quotaHeader(
              response.headers,
              "X-RateLimit-Used-CurrentRequest",
            ),
          },
        };
      }
      await response.body?.cancel();
      if (response.status >= 300 && response.status < 400) {
        throw new ConnectorError(
          "UPSTREAM_REDIRECT",
          "Freshdesk redirected the request. Redirects are never followed.",
        );
      }
      if (response.status === 401) {
        throw new ConnectorError(
          "AUTHENTICATION_FAILED",
          "Freshdesk rejected the API key. Check or rotate it locally.",
        );
      }
      if (response.status === 403) {
        throw new ConnectorError(
          "PERMISSION_DENIED",
          "The Freshdesk account lacks permission for this operation.",
        );
      }
      if (response.status === 404) {
        throw new ConnectorError(
          "NOT_FOUND",
          "The requested ticket or Freshdesk endpoint was not found.",
        );
      }
      if (response.status === 429) {
        const delay = retryAfterMs(
          response.headers.get("retry-after"),
          this.dependencies.now(),
          fallbackDelay,
        );
        this.blockedUntil = Math.max(
          this.blockedUntil,
          this.dependencies.now() + delay,
        );
        throw new ConnectorError(
          "RATE_LIMITED",
          "Freshdesk rate limit reached.",
          true,
          delay,
        );
      }
      if ([502, 503, 504].includes(response.status)) {
        throw new ConnectorError(
          "UPSTREAM_UNAVAILABLE",
          "Freshdesk is temporarily unavailable.",
          true,
          retryAfterMs(
            response.headers.get("retry-after"),
            this.dependencies.now(),
            fallbackDelay,
          ),
        );
      }
      throw new ConnectorError(
        "UPSTREAM_REJECTED",
        `Freshdesk rejected the request (HTTP ${response.status}).`,
      );
    } catch (error) {
      if (error instanceof ConnectorError) throw error;
      if (signal?.aborted) {
        throw new ConnectorError("CANCELLED", "The request was cancelled.");
      }
      if (timeout.aborted) {
        throw new ConnectorError(
          "TIMEOUT",
          "Freshdesk did not respond within the request timeout.",
          true,
        );
      }
      if (error instanceof TypeError) {
        throw new ConnectorError(
          "NETWORK_ERROR",
          "Unable to reach Freshdesk.",
          true,
        );
      }
      throw error;
    }
  }
}

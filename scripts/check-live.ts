import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { callEnvelope, connectMcp } from "../demo/mcp-client.js";
import { loadConfig } from "../src/config.js";
import { ConnectorError } from "../src/errors.js";

async function main(): Promise<void> {
  if (existsSync(".env")) process.loadEnvFile(".env");
  const config = loadConfig();
  if (config.mode !== "live") {
    throw new ConnectorError(
      "CONFIGURATION_ERROR",
      "check:live requires a real Freshdesk tenant, not demo mode.",
    );
  }
  const args = process.argv.slice(2);
  if (
    args.length !== 0 &&
    (args.length !== 2 ||
      args[0] !== "--ticket-id" ||
      !/^[1-9]\d*$/.test(args[1] ?? "") ||
      !Number.isSafeInteger(Number(args[1])))
  ) {
    throw new ConnectorError(
      "INVALID_INPUT",
      "Usage: npm run check:live -- [--ticket-id <positive-integer>]",
    );
  }
  const session = await connectMcp({
    FRESHDESK_DOMAIN: new URL(config.baseUrl).hostname,
    FRESHDESK_API_KEY: config.apiKey,
    FRESHDESK_TIMEOUT_MS: String(config.timeoutMs),
    FRESHDESK_MAX_RETRIES: String(config.maxRetries),
    FRESHDESK_MAX_WAIT_MS: String(config.maxWaitMs),
    FRESHDESK_REQUEST_BUDGET: String(config.requestBudget),
  });
  try {
    const run = async (
      name: string,
      input: Record<string, unknown> = {},
    ): Promise<void> => {
      const result = await callEnvelope(session.client, name, input);
      if (!result.ok) {
        throw new Error(
          `${name}: ${result.error?.code}: ${result.error?.message}`,
        );
      }
      assert(result.data !== undefined);
      console.log(`PASS ${name} (ticket contents not printed or persisted)`);
    };
    await run("freshdesk_auth_check");
    await run("freshdesk_list_tickets", {
      updated_since: new Date(Date.now() - 30 * 86400000).toISOString(),
      per_page: 1,
    });
    await run("freshdesk_search_tickets", { status: 2 });
    if (args[1] !== undefined) {
      await run("freshdesk_get_ticket", { ticket_id: Number(args[1]) });
    } else {
      console.log("SKIP freshdesk_get_ticket: supply an authorized --ticket-id.");
    }
  } finally {
    await session.close();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Live verification failed.");
  process.exitCode = 1;
});

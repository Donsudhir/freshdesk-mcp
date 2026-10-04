import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { callEnvelope, connectMcp, demoEnvironment } from "../demo/mcp-client.js";
import { startMockFreshdesk, type MockOptions } from "../demo/mock-freshdesk.js";
import { ticketDetailSchema } from "../src/schemas.js";

async function mcpFixture(
  context: TestContext,
  options: MockOptions = {},
  extraEnv: Record<string, string> = {},
) {
  const provider = await startMockFreshdesk(options);
  try {
    const session = await connectMcp(demoEnvironment(provider, extraEnv));
    context.after(async () => {
      await session.close();
      await provider.close();
    });
    return { session, provider };
  } catch (error) {
    await provider.close();
    throw error;
  }
}

test("actual stdio handshake discovers exactly the intended read-only tool set", async (t) => {
  const { session, provider } = await mcpFixture(t);
  const result = await session.client.listTools();
  assert.deepEqual(result.tools.map((tool) => tool.name).sort(), [
    "freshdesk_auth_check",
    "freshdesk_connector_info",
    "freshdesk_get_ticket",
    "freshdesk_list_tickets",
    "freshdesk_search_tickets",
  ]);
  assert(result.tools.every((tool) => tool.inputSchema.type === "object"));
  assert(result.tools.every((tool) => tool.outputSchema !== undefined));
  assert(result.tools.every((tool) => tool.annotations?.readOnlyHint === true));
  assert(result.tools.every((tool) => tool.annotations?.destructiveHint === false));
  const instructions = session.client.getInstructions();
  assert(instructions?.includes("untrusted"));
  assert.equal(provider.requests.length, 0);
});

test("MCP auth_check executes real HTTP Basic authentication and returns no tickets", async (t) => {
  const { session, provider } = await mcpFixture(t);
  const output = await callEnvelope(session.client, "freshdesk_auth_check");
  assert.equal(output.ok, true);
  assert.equal(output.data?.authenticated, true);
  assert.equal(output.data?.tickets, undefined);
  assert.equal(provider.requests[0]?.authenticated, true);
});

test("wrong key produces an MCP error flag and structured sanitized error", async (t) => {
  const wrongKey = randomBytes(24).toString("hex");
  const { session, provider } = await mcpFixture(t, {}, {
    FRESHDESK_API_KEY: wrongKey,
  });
  const output = await callEnvelope(session.client, "freshdesk_auth_check");
  assert.equal(output.ok, false);
  assert.equal(output.error?.code, "AUTHENTICATION_FAILED");
  assert.equal(output.error?.retryable, false);
  assert.equal(provider.requests.length, 1);
  assert(!JSON.stringify(output).includes(wrongKey));
  assert(!session.diagnostics.join("").includes(wrongKey));
});

test("permission denied and missing tickets are distinguishable MCP failures", async (t) => {
  const { session } = await mcpFixture(t, {
    faults: { "/api/v2/tickets": [{ status: 403 }] },
  });
  const permission = await callEnvelope(session.client, "freshdesk_auth_check");
  assert.equal(permission.error?.code, "PERMISSION_DENIED");
  const absent = await callEnvelope(session.client, "freshdesk_get_ticket", {
    ticket_id: 9999,
  });
  assert.equal(absent.error?.code, "NOT_FOUND");
});

test("MCP rejects unknown keys, query injection and invalid IDs before HTTP", async (t) => {
  const { session, provider } = await mcpFixture(t);
  for (const [name, args] of [
    ["freshdesk_get_ticket", { ticket_id: 0 }],
    ["freshdesk_get_ticket", { ticket_id: 1001, url: "https://foreign.example" }],
    ["freshdesk_search_tickets", { tag: "payment' OR status:5" }],
    ["freshdesk_search_tickets", {}],
    ["freshdesk_list_tickets", { updated_since: "2026-09-01T00:00:00Z", page: 301 }],
  ] as const) {
    const output = await session.client.callTool({ name, arguments: args });
    assert.equal(output.isError, true);
  }
  assert.equal(provider.requests.length, 0);
});

test("MCP rate-limit recovery works through the actual separate process", async (t) => {
  const { session, provider } = await mcpFixture(t, {
    faults: {
      "/api/v2/tickets/1001": [
        { status: 429, headers: { "Retry-After": "0" } },
      ],
    },
  });
  const output = await callEnvelope(session.client, "freshdesk_get_ticket", {
    ticket_id: 1001,
  });
  assert.equal(output.ok, true);
  assert.equal(output.data?.attempts, 2);
  assert.equal(provider.requests.length, 2);
});

test("long Retry-After returns an explicit retry hint rather than blocking indefinitely", async (t) => {
  const { session, provider } = await mcpFixture(t, {
    faults: {
      "/api/v2/tickets": [
        { status: 429, headers: { "Retry-After": "60" } },
      ],
    },
  });
  const result = await callEnvelope(session.client, "freshdesk_auth_check");
  assert.equal(result.error?.code, "RATE_LIMITED");
  const delay = result.error?.retry_after_ms;
  assert(delay !== undefined && delay >= 59000 && delay <= 60000);
  const second = await callEnvelope(session.client, "freshdesk_get_ticket", {
    ticket_id: 1001,
  });
  assert.equal(second.error?.code, "RATE_LIMITED");
  assert.equal(provider.requests.length, 1);
});

test("MCP output data preserves the untrusted-content boundary without contact fields", async (t) => {
  const { session } = await mcpFixture(t);
  const output = await callEnvelope(session.client, "freshdesk_get_ticket", {
    ticket_id: 1010,
    include_description: true,
  });
  const ticket = ticketDetailSchema.parse(output.data?.ticket);
  assert(ticket.description_text?.includes("Ignore prior instructions"));
  assert.equal(output.data?.data_classification, "untrusted_customer_content");
  assert(!JSON.stringify(output).includes("cc_emails"));
});

test("unknown or write tool names are not callable", async (t) => {
  const { session, provider } = await mcpFixture(t);
  const result = await session.client.callTool({
    name: "freshdesk_issue_refund",
    arguments: { ticket_id: 1001 },
  });
  assert.equal(result.isError, true);
  assert.equal(provider.requests.length, 0);
});

test("startup fails explicitly when credentials are absent and keeps stdout protocol-only", () => {
  const result = spawnSync(
    process.execPath,
    [fileURLToPath(new URL("../src/server.js", import.meta.url))],
    { env: {}, encoding: "utf8", timeout: 5000 },
  );
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /CONFIGURATION_ERROR/);
  assert(!result.stderr.includes("Basic "));
});

test("metadata clearly identifies the mock and never exposes the API key", async (t) => {
  const { session, provider } = await mcpFixture(t);
  const output = await callEnvelope(session.client, "freshdesk_connector_info");
  const data = z
    .object({ mode: z.literal("demo"), read_only: z.literal(true) })
    .parse(output.data);
  assert.equal(data.read_only, true);
  assert(!JSON.stringify(output).includes(provider.apiKey));
  assert.equal(provider.requests.length, 0);
});

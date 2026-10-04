import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { ticketDetailSchema, ticketSummarySchema } from "../src/schemas.js";
import { callEnvelope, connectMcp, demoEnvironment } from "./mcp-client.js";
import { startMockFreshdesk } from "./mock-freshdesk.js";

async function main(): Promise<void> {
  const provider = await startMockFreshdesk({
    faults: {
      "/api/v2/tickets": [
        { status: 429, headers: { "Retry-After": "1" } },
      ],
    },
  });
  const sessions: Array<Awaited<ReturnType<typeof connectMcp>>> = [];
  const checks: Array<{ name: string; passed: true }> = [];
  const check = (name: string): void => {
    checks.push({ name, passed: true });
    console.log(`PASS ${name}`);
  };
  const started = performance.now();
  try {
    const session = await connectMcp(demoEnvironment(provider));
    sessions.push(session);
    const discovery = await session.client.listTools();
    assert.equal(discovery.tools.length, 5);
    assert(discovery.tools.every((tool) => tool.annotations?.readOnlyHint));
    assert(discovery.tools.every((tool) => tool.inputSchema.type === "object"));
    check("MCP handshake discovers five read-only tools with JSON schemas");

    const info = await callEnvelope(session.client, "freshdesk_connector_info");
    assert.equal(info.data?.mode, "demo");
    assert(!JSON.stringify(info).includes(provider.apiKey));
    check("Configuration reports demo mode without exposing the runtime key");

    const authStarted = performance.now();
    const auth = await callEnvelope(session.client, "freshdesk_auth_check");
    assert.equal(auth.ok, true);
    assert.equal(auth.data?.authenticated, true);
    assert.equal(auth.data?.attempts, 2);
    assert(performance.now() - authStarted >= 950);
    check("API-key authentication succeeds after respecting 429 Retry-After");

    const first = await callEnvelope(session.client, "freshdesk_list_tickets", {
      updated_since: "2026-09-01T00:00:00Z",
      per_page: 3,
      order: "asc",
    });
    const firstTickets = z.array(ticketSummarySchema).parse(first.data?.tickets);
    const pagination = z
      .object({ next_page: z.number().nullable(), has_more: z.boolean() })
      .parse(first.data?.pagination);
    assert.deepEqual(firstTickets.map((ticket) => ticket.id), [1001, 1002, 1003]);
    assert.equal(pagination.next_page, 2);
    assert.equal(pagination.has_more, true);
    const second = await callEnvelope(session.client, "freshdesk_list_tickets", {
      updated_since: "2026-09-01T00:00:00Z",
      per_page: 3,
      order: "asc",
      page: pagination.next_page,
    });
    const secondTickets = z
      .array(ticketSummarySchema)
      .parse(second.data?.tickets);
    assert.deepEqual(secondTickets.map((ticket) => ticket.id), [1004, 1005, 1006]);
    check("List pagination returns two distinct, correctly ordered pages");

    const search = await callEnvelope(session.client, "freshdesk_search_tickets", {
      status: 2,
      priority: 4,
      tag: "payment",
    });
    const urgentTickets = z
      .array(ticketSummarySchema)
      .parse(search.data?.tickets);
    assert.deepEqual(urgentTickets.map((ticket) => ticket.id), [1001, 1005]);
    check("Structured search identifies exactly two urgent open payment tickets");

    const detail = await callEnvelope(session.client, "freshdesk_get_ticket", {
      ticket_id: 1001,
    });
    const ticket = ticketDetailSchema.parse(detail.data?.ticket);
    assert.equal(ticket.description_included, false);
    assert.equal(ticket.description_text, undefined);
    const projected = JSON.stringify({ first, search, detail });
    assert(!projected.includes("cc_emails"));
    assert(!projected.includes("requester_id"));
    assert(!projected.includes("custom_fields"));
    assert(!projected.includes("@example.com"));
    check("Default projection omits descriptions and explicit contact/custom fields");

    const untrusted = await callEnvelope(session.client, "freshdesk_get_ticket", {
      ticket_id: 1010,
      include_description: true,
    });
    const untrustedTicket = ticketDetailSchema.parse(untrusted.data?.ticket);
    assert(untrustedTicket.description_text?.includes("Ignore prior instructions"));
    assert.equal(untrusted.data?.data_classification, "untrusted_customer_content");
    assert.equal(provider.requests.filter((request) => request.method !== "GET").length, 0);
    check("Opt-in ticket text is marked untrusted; no write action is available");

    const absent = await callEnvelope(session.client, "freshdesk_get_ticket", {
      ticket_id: 9999,
    });
    assert.equal(absent.ok, false);
    assert.equal(absent.error?.code, "NOT_FOUND");
    check("Missing ticket returns an explicit MCP error instead of empty success");

    const requestsBeforeInvalidInput = provider.requests.length;
    const injection = await session.client.callTool({
      name: "freshdesk_search_tickets",
      arguments: { tag: "payment' OR status:5" },
    });
    assert.equal(injection.isError, true);
    assert.equal(provider.requests.length, requestsBeforeInvalidInput);
    check("Query injection is rejected before any provider request");

    const wrongKey = await connectMcp(
      demoEnvironment(provider, {
        FRESHDESK_API_KEY: randomBytes(24).toString("hex"),
      }),
    );
    sessions.push(wrongKey);
    const rejected = await callEnvelope(wrongKey.client, "freshdesk_auth_check");
    assert.equal(rejected.ok, false);
    assert.equal(rejected.error?.code, "AUTHENTICATION_FAILED");
    assert.equal(provider.requests.filter((request) => request.status === 401).length, 1);
    check("Wrong API key is rejected once, without unsafe authentication retries");

    assert(provider.requests.every((request) => request.method === "GET"));
    assert(
      sessions.every(
        (connected) => !connected.diagnostics.join("").includes(provider.apiKey),
      ),
    );
    check("All provider operations are GET-only and diagnostics contain no key");

    const artifactDirectory = fileURLToPath(
      new URL("../../artifacts/", import.meta.url),
    );
    await mkdir(artifactDirectory, { recursive: true });
    const report = {
      assignment: "3 - Private Freshdesk connector",
      verified_at: new Date().toISOString(),
      transport: "MCP stdio using the official SDK client and a separate server process",
      data: "10 fictional tickets; no live Freshdesk account or model was used",
      live_freshdesk_verified: false,
      checks_passed: checks.length,
      checks,
      elapsed_ms: Math.round(performance.now() - started),
      provider_requests: provider.requests,
      merchant_triage: {
        urgent_open_payment_ticket_ids: urgentTickets.map((item) => item.id),
        next_step:
          "Human operator verifies failure reasons in an authorized payment system before any recovery action.",
        payments_retried: 0,
        refunds_issued: 0,
        customers_contacted: 0,
      },
    };
    const serialized = JSON.stringify(report, null, 2);
    assert(!serialized.includes(provider.apiKey));
    await writeFile(`${artifactDirectory}/demo-report.json`, `${serialized}\n`);
    console.log(`\n${checks.length}/${checks.length} checks passed.`);
    console.log("Evidence written to artifacts/demo-report.json.");
    console.log("Scope: local authenticated provider contract; not a live Freshdesk claim.");
  } finally {
    for (const session of sessions) await session.close();
    await provider.close();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Demo failed.");
  process.exitCode = 1;
});

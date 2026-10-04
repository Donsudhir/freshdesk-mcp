import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { z } from "zod";
import { makeFictionalTickets } from "../demo/fixtures.js";
import { startMockFreshdesk, type MockOptions } from "../demo/mock-freshdesk.js";
import { demoEnvironment } from "../demo/mcp-client.js";
import { loadConfig } from "../src/config.js";
import { FreshdeskConnector } from "../src/freshdesk.js";
import {
  getOutputSchema,
  listOutputSchema,
  searchOutputSchema,
  ticketDetailSchema,
  ticketSummarySchema,
} from "../src/schemas.js";

async function connectorFixture(
  context: TestContext,
  options: MockOptions = {},
  extraEnv: Record<string, string> = {},
): Promise<{
  provider: Awaited<ReturnType<typeof startMockFreshdesk>>;
  connector: FreshdeskConnector;
}> {
  const provider = await startMockFreshdesk(options);
  context.after(async () => provider.close());
  const connector = new FreshdeskConnector(
    loadConfig(demoEnvironment(provider, extraEnv)),
  );
  return { provider, connector };
}

test("authenticated list returns bounded summaries and follows page metadata", async (t) => {
  const { connector, provider } = await connectorFixture(t);
  const data = await connector.listTickets({
    updated_since: "2026-09-01T00:00:00Z",
    per_page: 3,
    order: "asc",
  });
  assert(listOutputSchema.safeParse({ ok: true, data }).success);
  const tickets = z.array(ticketSummarySchema).parse(data.tickets);
  assert.deepEqual(tickets.map((item) => item.id), [1001, 1002, 1003]);
  assert.deepEqual(data.pagination, {
    page: 1,
    per_page: 3,
    has_more: true,
    next_page: 2,
    limit_reached: false,
  });
  assert.equal(provider.requests[0]?.query.order_by, "updated_at");
  assert.equal(provider.requests[0]?.authenticated, true);
});

test("list final page and empty window are explicit successes without a next page", async (t) => {
  const { connector } = await connectorFixture(t);
  const final = await connector.listTickets({
    updated_since: "2026-09-01T00:00:00Z",
    per_page: 3,
    page: 4,
    order: "asc",
  });
  assert.equal(z.array(ticketSummarySchema).parse(final.tickets).length, 1);
  assert.deepEqual(final.pagination, {
    page: 4,
    per_page: 3,
    has_more: false,
    next_page: null,
    limit_reached: false,
  });
  const empty = await connector.listTickets({
    updated_since: "2027-01-01T00:00:00Z",
  });
  assert.deepEqual(empty.tickets, []);
});

test("full list page 300 reports unknown completeness instead of implying an exhaustive export", async (t) => {
  const { connector } = await connectorFixture(t, {
    tickets: makeFictionalTickets(350),
  });
  const data = await connector.listTickets({
    updated_since: "2026-09-01T00:00:00Z",
    per_page: 1,
    page: 300,
  });
  assert.deepEqual(data.pagination, {
    page: 300,
    per_page: 1,
    has_more: false,
    next_page: null,
    limit_reached: true,
  });
  assert(String(data.warning).includes("completeness"));
});

test("get excludes sensitive explicit fields and description unless opted in", async (t) => {
  const { connector } = await connectorFixture(t);
  const data = await connector.getTicket({ ticket_id: 1001 });
  assert(getOutputSchema.safeParse({ ok: true, data }).success);
  const ticket = ticketDetailSchema.parse(data.ticket);
  assert.equal(ticket.description_available, true);
  assert.equal(ticket.description_included, false);
  assert.equal(ticket.description_text, undefined);
  const serialized = JSON.stringify(data);
  for (const forbidden of ["cc_emails", "requester_id", "custom_fields", "@example.com", "<p>"]) {
    assert(!serialized.includes(forbidden));
  }
});

test("opt-in description is bounded plain text marked as untrusted", async (t) => {
  const tickets = makeFictionalTickets();
  const first = tickets[0];
  assert(first !== undefined);
  first.description_text = "x".repeat(2500);
  first.subject = "s".repeat(300);
  first.tags = Array.from({ length: 25 }, () => "t".repeat(100));
  const { connector } = await connectorFixture(t, { tickets });
  const result = await connector.getTicket({
    ticket_id: 1001,
    include_description: true,
  });
  const ticket = ticketDetailSchema.parse(result.ticket);
  assert.equal(ticket.description_text?.length, 2000);
  assert.equal(ticket.description_truncated, true);
  assert.equal(ticket.subject.length, 240);
  assert.equal(ticket.tags.length, 20);
  assert(ticket.tags.every((tag) => tag.length === 64));
  assert.equal(ticket.text_truncated, true);
  assert.equal(result.data_classification, "untrusted_customer_content");
});

test("missing upstream optional fields are marked unavailable, not guessed", async (t) => {
  const original = makeFictionalTickets()[0];
  assert(original !== undefined);
  const { tags: _tags, description_text: _description, ...withoutOptional } = original;
  const { connector } = await connectorFixture(t, {
    faults: {
      "/api/v2/tickets/1001": [{ status: 200, body: withoutOptional }],
    },
  });
  const data = await connector.getTicket({
    ticket_id: 1001,
    include_description: true,
  });
  const ticket = ticketDetailSchema.parse(data.ticket);
  assert.equal(ticket.tags_available, false);
  assert.equal(ticket.description_available, false);
  assert.equal(ticket.description_included, false);
});

test("custom status is preserved without pretending it is a built-in status", async (t) => {
  const tickets = makeFictionalTickets();
  assert(tickets[0] !== undefined);
  tickets[0].status = 17;
  const { connector } = await connectorFixture(t, { tickets });
  const data = await connector.getTicket({ ticket_id: 1001 });
  const ticket = ticketDetailSchema.parse(data.ticket);
  assert.equal(ticket.status, 17);
  assert.equal(ticket.status_label, "Custom status (17)");
});

test("search structured filters return exact urgent payment matches", async (t) => {
  const { connector, provider } = await connectorFixture(t);
  const data = await connector.searchTickets({ status: 2, priority: 4, tag: "payment" });
  assert(searchOutputSchema.safeParse({ ok: true, data }).success);
  assert.deepEqual(
    z.array(ticketSummarySchema).parse(data.tickets).map((ticket) => ticket.id),
    [1001, 1005],
  );
  assert.equal(
    provider.requests[0]?.query.query,
    `"status:2 AND priority:4 AND tag:'payment'"`,
  );
});

test("search date boundaries and agent/group fields use documented semantics", async (t) => {
  const { connector } = await connectorFixture(t);
  const data = await connector.searchTickets({
    created_since: "2026-09-05",
    created_until: "2026-09-05",
    updated_since: "2026-09-05",
    group_id: 71,
    agent_id: 81,
  });
  assert.deepEqual(
    z.array(ticketSummarySchema).parse(data.tickets).map((ticket) => ticket.id),
    [1005],
  );
});

test("search caps pagination at 300 matches and communicates truncation", async (t) => {
  const tickets = makeFictionalTickets(350).map((ticket) => ({
    ...ticket,
    status: 2,
  }));
  const { connector } = await connectorFixture(t, { tickets });
  const first = await connector.searchTickets({ status: 2 });
  assert.equal(z.array(ticketSummarySchema).parse(first.tickets).length, 30);
  assert.deepEqual(first.pagination, {
    page: 1,
    per_page: 30,
    total_matches: 350,
    max_accessible_results: 300,
    has_more: true,
    next_page: 2,
    limit_reached: true,
  });
  const last = await connector.searchTickets({ status: 2, page: 10 });
  const pagination = z.object({
    next_page: z.null(),
    has_more: z.literal(true),
    limit_reached: z.literal(true),
  });
  assert(pagination.safeParse(last.pagination).success);
});

test("search excludes archived fixtures and preserves true empty results", async (t) => {
  const tickets = makeFictionalTickets();
  assert(tickets[0] !== undefined);
  tickets[0].archived = true;
  const { connector } = await connectorFixture(t, { tickets });
  const archived = await connector.searchTickets({ status: 2, priority: 4 });
  assert.deepEqual(
    z.array(ticketSummarySchema).parse(archived.tickets).map((item) => item.id),
    [1005],
  );
  const empty = await connector.searchTickets({ tag: "no-such-fictional-tag" });
  assert.deepEqual(empty.tickets, []);
});

test("invalid input fails before any network request", async (t) => {
  const { connector, provider } = await connectorFixture(t);
  await assert.rejects(connector.searchTickets({ tag: "x' OR priority:1" }), {
    code: "INVALID_INPUT",
  });
  await assert.rejects(connector.listTickets({ page: 301 }), {
    code: "INVALID_INPUT",
  });
  await assert.rejects(connector.getTicket({ ticket_id: -1 }), {
    code: "INVALID_INPUT",
  });
  assert.equal(provider.requests.length, 0);
});

test("upstream wrong shapes, mismatched IDs, and impossible totals fail explicitly", async (t) => {
  const first = makeFictionalTickets()[0];
  assert(first !== undefined);
  const { connector } = await connectorFixture(t, {
    faults: {
      "/api/v2/tickets/1001": [
        { status: 200, body: { unexpected: true } },
        { status: 200, body: { ...first, id: 1002 } },
      ],
      "/api/v2/search/tickets": [
        { status: 200, body: { total: 0, results: [first] } },
      ],
    },
  });
  await assert.rejects(connector.getTicket({ ticket_id: 1001 }), {
    code: "UPSTREAM_INVALID_RESPONSE",
  });
  await assert.rejects(connector.getTicket({ ticket_id: 1001 }), {
    code: "UPSTREAM_INVALID_RESPONSE",
  });
  await assert.rejects(connector.searchTickets({ status: 2 }), {
    code: "UPSTREAM_INVALID_RESPONSE",
  });
});

test("foreign pagination links are never followed or silently accepted", async (t) => {
  const { connector, provider } = await connectorFixture(t, {
    faults: {
      "/api/v2/tickets": [
        {
          status: 200,
          body: [],
          headers: { Link: '<https://foreign.example/api/v2/tickets?page=2>; rel="next"' },
        },
      ],
    },
  });
  await assert.rejects(
    connector.listTickets({ updated_since: "2026-09-01T00:00:00Z" }),
    { code: "UPSTREAM_INVALID_RESPONSE" },
  );
  assert.equal(provider.requests.length, 1);
});

test("malformed pagination metadata is an explicit provider error", async (t) => {
  const { connector } = await connectorFixture(t, {
    faults: {
      "/api/v2/tickets": [
        {
          status: 200,
          body: [],
          headers: { Link: 'not-a-url; rel="next"' },
        },
      ],
    },
  });
  await assert.rejects(
    connector.listTickets({ updated_since: "2026-09-01T00:00:00Z" }),
    { code: "UPSTREAM_INVALID_RESPONSE" },
  );
});

test("real HTTP timeout produces a bounded explicit error", async (t) => {
  const { connector, provider } = await connectorFixture(
    t,
    {
      faults: {
        "/api/v2/tickets/1001": [
          { status: 200, delayMs: 1000, body: makeFictionalTickets()[0] },
        ],
      },
    },
    { FRESHDESK_TIMEOUT_MS: "100", FRESHDESK_MAX_RETRIES: "0" },
  );
  const started = performance.now();
  await assert.rejects(connector.getTicket({ ticket_id: 1001 }), {
    code: "TIMEOUT",
  });
  assert(performance.now() - started < 900);
  assert.equal(provider.requests.length, 1);
});

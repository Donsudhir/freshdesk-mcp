import assert from "node:assert/strict";
import test from "node:test";
import { buildSearchQuery } from "../src/freshdesk.js";
import {
  getInputSchema,
  listInputSchema,
  outputEnvelopeSchema,
  searchInputSchema,
} from "../src/schemas.js";

test("list requires a real UTC window and applies pagination defaults", () => {
  const result = listInputSchema.parse({
    updated_since: "2026-09-01T00:00:00Z",
  });
  assert.equal(result.page, 1);
  assert.equal(result.per_page, 30);
  assert.equal(result.order, "desc");
  assert(!listInputSchema.safeParse({}).success);
  assert(
    !listInputSchema.safeParse({
      updated_since: "2026-02-30T00:00:00Z",
    }).success,
  );
  assert(
    !listInputSchema.safeParse({
      updated_since: "2026-09-01T05:30:00+05:30",
    }).success,
  );
});

test("list validates exact page and page-size boundaries", () => {
  const input = { updated_since: "2026-09-01T00:00:00Z" };
  assert(listInputSchema.safeParse({ ...input, page: 300, per_page: 100 }).success);
  for (const invalid of [
    { page: 0 },
    { page: 301 },
    { page: 1.5 },
    { per_page: 0 },
    { per_page: 101 },
    { page: "1" },
  ]) {
    assert(!listInputSchema.safeParse({ ...input, ...invalid }).success);
  }
});

test("get rejects non-integer IDs, overflow, and unknown argument keys", () => {
  assert(getInputSchema.safeParse({ ticket_id: 1 }).success);
  for (const ticket_id of [0, -1, 1.1, "1001", Number.MAX_SAFE_INTEGER + 1]) {
    assert(!getInputSchema.safeParse({ ticket_id }).success);
  }
  assert(
    !getInputSchema.safeParse({ ticket_id: 1, arbitrary_url: "https://example.com" })
      .success,
  );
  assert.equal(
    getInputSchema.parse({ ticket_id: 1 }).include_description,
    false,
  );
});

test("structured query is quoted once and uses documented field names", () => {
  const input = searchInputSchema.parse({
    status: 2,
    priority: 4,
    group_id: 71,
    agent_id: 81,
    tag: "payment recovery",
    created_since: "2026-09-01",
    created_until: "2026-09-30",
    updated_since: "2026-09-05",
  });
  assert.equal(
    buildSearchQuery(input),
    `"status:2 AND priority:4 AND group_id:71 AND agent_id:81 AND tag:'payment recovery' AND created_at:>'2026-09-01' AND created_at:<'2026-09-30' AND updated_at:>'2026-09-05'"`,
  );
});

test("search requires a filter and forbids an arbitrary provider query", () => {
  assert(!searchInputSchema.safeParse({ page: 1 }).success);
  assert(!searchInputSchema.safeParse({ query: "status:2" }).success);
  assert(!searchInputSchema.safeParse({ subject: "payment" }).success);
  assert(searchInputSchema.safeParse({ status: 2 }).success);
});

test("search validates documented status, priority, and 10-page cap", () => {
  assert(searchInputSchema.safeParse({ status: 2, priority: 4, page: 10 }).success);
  assert(!searchInputSchema.safeParse({ status: 1 }).success);
  assert(!searchInputSchema.safeParse({ priority: 5 }).success);
  assert(!searchInputSchema.safeParse({ status: 2, page: 11 }).success);
  assert(!searchInputSchema.safeParse({ group_id: -1 }).success);
});

for (const tag of [
  "payment' OR status:5",
  'payment" OR priority:1',
  "payment:4",
  "payment\nOR status:2",
  "a".repeat(65),
  "",
]) {
  test(`search rejects injection or invalid tag: ${JSON.stringify(tag)}`, () => {
    assert(!searchInputSchema.safeParse({ tag }).success);
  });
}

test("search validates real dates and ordered inclusive date ranges", () => {
  assert(!searchInputSchema.safeParse({ created_since: "2026-02-30" }).success);
  assert(
    !searchInputSchema.safeParse({
      created_since: "2026-09-30",
      created_until: "2026-09-01",
    }).success,
  );
  assert(
    searchInputSchema.safeParse({
      created_since: "2026-09-01",
      created_until: "2026-09-01",
    }).success,
  );
});

test("output envelopes cannot disguise errors as successful empty results", () => {
  assert(!outputEnvelopeSchema.safeParse({ ok: true }).success);
  assert(!outputEnvelopeSchema.safeParse({ ok: false, data: {} }).success);
  assert(outputEnvelopeSchema.safeParse({ ok: true, data: {} }).success);
  assert(
    outputEnvelopeSchema.safeParse({
      ok: false,
      error: { code: "NOT_FOUND", message: "Missing", retryable: false },
    }).success,
  );
});

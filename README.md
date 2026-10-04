# Freshdesk private connector for Agent Studio

**Razorpay Forward-Deployed Engineer assignment 3.**

[Submission repository](https://github.com/Donsudhir/freshdesk-mcp)

A TypeScript, read-only connector exposing Freshdesk tickets as five validated
MCP tools. It includes API-key authentication, list/get/search primitives,
bounded rate-limit recovery, an official-SDK stdio server, a separate MCP client,
tests, and an authenticated local demonstration.

> Verification scope: the reproducible demo uses ten fictional tickets and a
> local Freshdesk-compatible fixture provider. It does **not** claim a live
> Freshdesk account, a deployed Agent Studio integration, or an LLM evaluation.
> The same connector has a live mode and a non-persisting live verification
> command for an authorized account.

## Merchant problem and solution

A merchant support team needs to identify urgent payment-related tickets without
giving an agent permission to issue refunds, retry charges, or contact customers.
The initial request, "let the agent access Freshdesk," is therefore narrowed to
safe evidence gathering and human-reviewed triage.

The agent can find open, urgent tickets tagged `payment`, read approved details,
cite ticket IDs, and propose next steps. A human must verify payment facts in an
authorized payment system before any financial or customer-facing action.
Freshdesk ticket text is not authoritative payment-state data.

```text
Trusted agent host / official MCP demo client
                  |
         MCP JSON-RPC over stdio
                  |
     Zod inputs + allowlisted read-only tools
                  |
        One tenant's Freshdesk connector
                  |
     Serialized GETs, timeout, retry budget
                  |
      HTTPS + HTTP Basic API-key authentication
                  |
              Freshdesk API v2

Offline demo: the last hop is an explicitly configured
authenticated http://127.0.0.1:<ephemeral-port> fixture provider.
```

## Quick start: no account or credentials needed

Requirements: Node.js 22+ and npm. No Docker, database, voice provider, or paid
LLM is required.

```bash
npm ci --ignore-scripts
npm run verify
```

`verify` type-checks the project, builds it, runs the tests, and runs the
demonstration through a real MCP stdio subprocess. The demo creates its own
loopback provider and random in-memory authentication key, then closes both.
No long-running server is left behind.

The demo checks:

- MCP handshake, actual tool discovery, and read-only annotations.
- API-key verification, including a one-second HTTP 429 `Retry-After`.
- Two distinct list pages with an explicit UTC time window.
- An exact search returning fictional ticket IDs `1001` and `1005`.
- Default exclusion of descriptions, contact fields, and custom fields.
- Explicit opt-in to bounded, untrusted description text.
- A missing ticket, a rejected injection attempt, and an invalid API key.
- GET-only provider traffic and credential-free diagnostics.

Evidence is generated in [`artifacts/demo-report.json`](artifacts/demo-report.json).
Test-run output is included in [`artifacts/test-results.txt`](artifacts/test-results.txt).
The evidence makes the offline/live distinction explicit.

## Live API-key authentication

Use a Freshdesk account you own or have permission to access, preferably a
dedicated agent with the minimum ticket-read role.

1. In Freshdesk, open **Profile settings** and obtain that agent's API key.
2. Copy the configuration template:

   ```bash
   cp .env.example .env
   ```

3. Edit `.env` locally. Set `FRESHDESK_DOMAIN` to the tenant's lowercase
   `<subdomain>.freshdesk.com` hostname and `FRESHDESK_API_KEY` to the key.
   Never commit, paste, or submit the populated file.
4. Build and verify live authentication, one list page, and one search:

   ```bash
   npm run check:live
   ```

5. To also verify get-ticket access, supply an ID you are authorized to read:

   ```bash
   npm run check:live -- --ticket-id 123
   ```

The live checker reads `.env`, calls the actual MCP server process, fails with
an explicit error when authentication or permissions are wrong, and prints
only check outcomes. It never prints or persists ticket contents. Without a
ticket ID it explicitly skips the get check.

Freshdesk authentication is implemented as
`Authorization: Basic base64(API_KEY + ":X")`. The key stays in the connector
process, not in tool arguments, outputs, fixture files, or submitted artifacts.
Live mode requires HTTPS and an exact Freshdesk tenant hostname. Arbitrary
URLs, custom domains, redirects, and non-Freshdesk destinations are not allowed.

To launch the MCP server directly:

```bash
npm run build
node --env-file=.env dist/src/server.js
```

The server communicates through stdin/stdout, so it is intended to be launched
by an MCP host, not opened as a web page. Diagnostics go to stderr. `npm start`
can be used when the required variables are already supplied by a trusted host.
Ensure `FRESHDESK_DEMO_MODE=true` is not inherited when using a live account.

## Tool contract

The generated, machine-readable specification is
[`docs/mcp-tools.json`](docs/mcp-tools.json), exported from an actual MCP
`tools/list` response:

```bash
npm run tools:export
```

| Tool | Primitive | Important input / behavior |
| --- | --- | --- |
| `freshdesk_connector_info` | Capabilities | No arguments; no network request or credential disclosure |
| `freshdesk_auth_check` | Authentication | No arguments; verifies key and ticket-read access with a one-item list request |
| `freshdesk_list_tickets` | List | Required UTC `updated_since`; page 1-300; page size 1-100; updated-time ordering |
| `freshdesk_get_ticket` | Get | Positive integer `ticket_id`; description excluded unless explicitly requested |
| `freshdesk_search_tickets` | Search | At least one structured filter; AND semantics; page 1-10; 30 results per page |

Examples:

```json
{
  "name": "freshdesk_list_tickets",
  "arguments": {
    "updated_since": "2026-09-01T00:00:00Z",
    "per_page": 3,
    "page": 1,
    "order": "asc"
  }
}
```

```json
{
  "name": "freshdesk_search_tickets",
  "arguments": {"status": 2, "priority": 4, "tag": "payment"}
}
```

```json
{
  "name": "freshdesk_get_ticket",
  "arguments": {"ticket_id": 1001, "include_description": false}
}
```

Successful results include both MCP `structuredContent` and equivalent text:

```json
{"ok": true, "data": {"authenticated": true}}
```

The abbreviated example above shows the envelope, not the complete auth schema.
Provider failures have MCP `isError: true` and a structured error:

```json
{
  "ok": false,
  "error": {
    "code": "RATE_LIMITED",
    "message": "Freshdesk is cooling down. Retry after the indicated interval.",
    "retryable": true,
    "retry_after_ms": 60000
  }
}
```

Invalid tool arguments and unknown tool names are rejected by the MCP SDK with
`isError: true`; they need not contain this provider-error envelope. Errors are
never represented as an empty successful list.

## Configuration and rate limits

| Environment variable | Default | Bound / meaning |
| --- | --- | --- |
| `FRESHDESK_DOMAIN` | Required in live mode | Exact `<subdomain>.freshdesk.com` hostname |
| `FRESHDESK_API_KEY` | Required | Supplied locally or by a secret manager |
| `FRESHDESK_TIMEOUT_MS` | `5000` | 100-30000 per HTTP attempt |
| `FRESHDESK_MAX_RETRIES` | `2` | 0-3 retries after the initial attempt |
| `FRESHDESK_MAX_WAIT_MS` | `5000` | 0-60000 total backoff/cooldown sleep per call |
| `FRESHDESK_REQUEST_BUDGET` | `1000` | 1-100000 HTTP attempts over one process lifetime |
| `FRESHDESK_DEMO_MODE` | `false` | Explicitly enable only for local fixtures |
| `FRESHDESK_BASE_URL` | Forbidden live | Demo-only numeric loopback URL under `/api/v2/` |

The connector serializes requests and bounds the queue at 32 calls. It honors
`Retry-After` seconds or HTTP dates, shares a provider cooldown across its tools,
and applies exponential backoff with jitter when no interval is supplied.
It retries only idempotent GETs on 429, 502/503/504, transport failures, and
timeouts. Authentication, permission, missing-resource, invalid-response, and
other rejected requests fail explicitly.

If Freshdesk asks for a wait beyond the remaining sleep budget, the connector
returns a retry hint instead of retrying too early or blocking indefinitely.
All attempts consume the process request budget. Freshdesk quota headers are
reported when supplied, including documented whole-number decimal formatting;
missing headers remain `null`, not an invented quota.

## Agent integration, guardrails, and limitations

See [`docs/agent-integration.md`](docs/agent-integration.md) for the host contract
and [`docs/capabilities.md`](docs/capabilities.md) for what an agent can and cannot
do.

Key boundaries:

- One configured tenant per process; the model cannot choose a tenant or URL.
- No ticket updates, conversations, contact searches, attachments, orders,
  inventory, payments, refunds, calls, or customer messages.
- Search supports only documented built-in structured fields, not arbitrary
  query syntax, subject full-text search, OR, or custom fields.
- Search excludes archived tickets, can lag changes by several minutes, and
  exposes at most 300 results. Lists expose at most 300 pages; a full final page
  flags unknown completeness.
- Known contact/custom fields are omitted, but subjects, tags, and opt-in text
  can still contain personal data. This is data minimization, not a guarantee
  of comprehensive PII detection or redaction.
- Marking text as untrusted is not proof of LLM prompt-injection resistance.
  There is no model or real Agent Studio tenant in the offline demonstration.
- Hosted Agent Studio registration and live Freshdesk behavior need an
  authorized environment. A remote-only agent host needs an authenticated
  gateway; this submission implements stdio, not a public remote endpoint.
- Queue, cooldown, and budget are process-local. Multi-worker production use
  requires a distributed account-wide limiter and deployment-specific
  identity, secret rotation, and retention controls.

## Evaluation and rollout

The suite exercises strict inputs, provider response shapes, authentication,
permissions, 404s, ordering/pagination, exact search matches, search/list caps,
timeouts, retries, quota headers, queue bounds, credential-safe outputs, and
real MCP subprocess calls.

For a real merchant rollout, first run the live checker and review role
permissions. Then evaluate representative authorized tickets, measure routing
precision/recall and correct ticket citations, and compare time-to-triage against
the existing manual workflow. Keep suggested actions in a human-reviewed queue.
No real-world recovery uplift, LLM accuracy, or time savings are claimed here.

## Submission package

The repository contains only connector code, documentation, and fictional
offline evidence. It excludes dependencies, build outputs, live configuration,
and personal application materials.

To create an uploadable source ZIP (requires the `zip` command):

```bash
npm run tools:export
npm run package:submission
```

The ZIP and SHA-256 checksum are created in the ignored `submission/` directory.
The packaging script uses an explicit source allowlist and rejects symbolic
links and secret-looking file names. The included GitHub Actions workflow uses
no secrets and runs offline verification on pushes and pull requests.

Development was AI-assisted. The included tests and subprocess demonstration
provide executable verification; the author should review the implementation
and trade-offs before discussing or deploying it.

## Sources

- [Freshdesk API v2 authentication](https://developers.freshdesk.com/api/#authentication)
- [Freshdesk rate limits](https://developers.freshdesk.com/api/#ratelimit)
- [Freshdesk pagination](https://developers.freshdesk.com/api/#pagination)
- [Freshdesk list tickets](https://developers.freshdesk.com/api/#list_all_tickets)
- [Freshdesk get ticket](https://developers.freshdesk.com/api/#view_a_ticket)
- [Freshdesk filter/search tickets](https://developers.freshdesk.com/api/#filter_tickets)
- [Official MCP TypeScript SDK server documentation](https://github.com/modelcontextprotocol/typescript-sdk/blob/v1.x/docs/server.md)
- [MCP transport specification](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports)

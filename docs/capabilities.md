# Agent capabilities and boundaries

## The agent can

1. Verify that the configured Freshdesk API key can read tickets.
2. List one bounded page of summaries within an explicit UTC update window.
3. Fetch a specific authorized ticket by its numeric ID.
4. Search by built-in status, priority, group, agent, exact tag, and inclusive
   UTC creation/update dates. Filters are combined with AND.
5. Read status/priority labels and cite the source ticket IDs.
6. Explicitly opt in to up to 2000 characters of plain-text description on a
   single-ticket read.
7. Observe pagination, truncation, quota information, and structured failures.

## The agent cannot

- Create, update, close, assign, or delete tickets.
- Retrieve conversations, requester profiles, emails, attachments, or custom
  fields as distinct connector fields.
- Change inventory or read orders; this implementation targets Freshdesk tickets.
- Retry a payment, initiate a refund, call a customer, or send any communication.
- Choose an arbitrary tenant, API endpoint, URL, credential, or write method.
- Pass arbitrary provider search expressions, OR, unsupported fields, or
  full-text subject queries.
- Guarantee complete searches beyond 300 results or lists beyond 300 pages.
- Treat a support ticket as definitive evidence of a payment's actual state.
- Guarantee freshness of the eventually consistent Freshdesk search index.
- Guarantee that projected free text contains no personal information.

## Data handling

Ticket summaries contain only ID, bounded subject/tags, status/priority, labels,
creation/update times, and availability/truncation flags. HTML, attachments,
contact arrays, requester IDs, and custom fields are not projected. If an
optional upstream field is absent, its availability flag is false; absence is
not guessed to be confirmed empty data.

Default description access is off. Explicit opt-in does not anonymize free
text. The merchant must approve the fields, agent-host/model provider, access
scope, and retention policy before live use.

All ticket text is labelled `untrusted_customer_content`. Tool annotations and
server instructions reinforce this boundary, but an LLM must also enforce it.
The demo checks the marker and unavailable write tools; it does not claim to
measure model resistance to malicious instructions.

## Authentication and tenant isolation

The trusted operator supplies one domain and API key before startup. The model
receives neither. Freshdesk enforces the key owner's role permissions; the
connector additionally exposes only GET operations. A personal API key is not
an OAuth read-only scope. Use a dedicated minimum-permission agent if the
merchant's account permits it.

The MCP transport is local stdio. The operator/host that can launch the process
is trusted. This is not a public HTTP service with inbound user authentication,
and it must not be wrapped in an unauthenticated remote endpoint.

## Errors and human review

Provider errors distinguish authentication failure, insufficient permission,
missing resources, rate limits, request-budget exhaustion, network failure,
timeouts, and invalid responses. They return MCP `isError: true`; no fabricated
ticket or empty-success fallback is returned.

The operator should resolve authentication and permission errors locally. A
rate-limit error includes a retry interval when known. Do not ask the model to
repair credentials or bypass access controls.

Triage findings must cite ticket IDs and state uncertainty. Financial actions
and customer communication remain outside the connector and require a
separately authorized, human-reviewed workflow.

## Appropriate long-term production work

- Verify against an authorized Freshdesk sandbox and the actual agent-host
  transport/import format.
- Introduce host identity and tenant routing outside model-controlled inputs.
- Store tenant keys in a managed secret vault and support rotation/revocation.
- Use an account-wide distributed limiter across workers, bounded job queues,
  and retries scheduled outside a long interactive request.
- Approve field projections and retention with the merchant; add domain-specific
  redaction if required, without implying regexes eliminate all PII.
- Add a read-only incremental sync or export workflow for large histories rather
  than relying on capped search for complete analytics.
- Run a model-specific evaluation for correct tool selection, citations,
  abstention, stale-data handling, and untrusted text before autonomous use.

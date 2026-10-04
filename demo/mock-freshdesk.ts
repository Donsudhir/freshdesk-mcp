import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type ServerResponse } from "node:http";
import { makeFictionalTickets, type FictionalTicket } from "./fixtures.js";

export interface Fault {
  status: number;
  headers?: Record<string, string>;
  body?: unknown;
  delayMs?: number;
  rawBody?: string;
}

export interface MockOptions {
  tickets?: FictionalTicket[];
  faults?: Record<string, Fault[]>;
}

export interface RequestRecord {
  method: string;
  path: string;
  query: Record<string, string>;
  authenticated: boolean;
  status: number;
}

function send(
  response: ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): void {
  response.writeHead(status, {
    "Content-Type": "application/json",
    "X-RateLimit-Total": "50",
    "X-RateLimit-Remaining": status === 429 ? "0" : "49",
    "X-RateLimit-Used-CurrentRequest": "1",
    ...headers,
  });
  response.end(JSON.stringify(body));
}

function matchesQuery(ticket: FictionalTicket, query: string): boolean {
  if (!query.startsWith('"') || !query.endsWith('"')) {
    throw new Error("Search query must have enclosing double quotes.");
  }
  let remaining = query.slice(1, -1);
  let matches = true;
  while (remaining !== "") {
    const numeric =
      /^(status|priority|group_id|agent_id):(\d+)(?: AND |$)/.exec(remaining);
    const tag = /^tag:'([A-Za-z0-9][A-Za-z0-9 _.-]{0,63})'(?: AND |$)/.exec(
      remaining,
    );
    const date =
      /^(created_at|updated_at):([><])'(\d{4}-\d{2}-\d{2})'(?: AND |$)/.exec(
        remaining,
      );
    if (numeric?.[1] !== undefined && numeric[2] !== undefined) {
      const field = numeric[1];
      const value =
        field === "agent_id"
          ? ticket.responder_id
          : field === "status"
            ? ticket.status
            : field === "priority"
              ? ticket.priority
              : ticket.group_id;
      matches = matches && value === Number(numeric[2]);
      remaining = remaining.slice(numeric[0].length);
    } else if (tag?.[1] !== undefined) {
      matches = matches && ticket.tags.includes(tag[1]);
      remaining = remaining.slice(tag[0].length);
    } else if (
      date?.[1] !== undefined &&
      date[2] !== undefined &&
      date[3] !== undefined
    ) {
      const value = (
        date[1] === "created_at" ? ticket.created_at : ticket.updated_at
      ).slice(0, 10);
      matches =
        matches && (date[2] === ">" ? value >= date[3] : value <= date[3]);
      remaining = remaining.slice(date[0].length);
    } else {
      throw new Error("Unsupported search query in the local fixture provider.");
    }
  }
  return matches;
}

export async function startMockFreshdesk(options: MockOptions = {}): Promise<{
  baseUrl: string;
  apiKey: string;
  requests: RequestRecord[];
  close: () => Promise<void>;
}> {
  const apiKey = randomBytes(24).toString("hex");
  const expectedAuth = Buffer.from(
    `Basic ${Buffer.from(`${apiKey}:X`).toString("base64")}`,
  );
  const tickets = options.tickets ?? makeFictionalTickets();
  const requests: RequestRecord[] = [];
  const faults = new Map(
    Object.entries(options.faults ?? {}).map(([path, plan]) => [path, [...plan]]),
  );
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const incomingAuth = Buffer.from(request.headers.authorization ?? "");
    const authenticated =
      incomingAuth.length === expectedAuth.length &&
      timingSafeEqual(incomingAuth, expectedAuth);
    const record: RequestRecord = {
      method: request.method ?? "UNKNOWN",
      path: url.pathname,
      query: Object.fromEntries(url.searchParams),
      authenticated,
      status: 0,
    };
    requests.push(record);
    if (request.method !== "GET") {
      record.status = 405;
      send(response, 405, { error: "Read-only fixture provider." });
      return;
    }
    if (!authenticated) {
      record.status = 401;
      send(response, 401, { error: "Authentication failed." });
      return;
    }
    const fault = faults.get(url.pathname)?.shift();
    if (fault !== undefined) {
      record.status = fault.status;
      const reply = (): void => {
        if (response.destroyed) return;
        if (fault.rawBody !== undefined) {
          response.writeHead(fault.status, {
            "Content-Type": "application/json",
            ...fault.headers,
          });
          response.end(fault.rawBody);
        } else {
          send(
            response,
            fault.status,
            fault.body ?? { error: "Injected fictional provider fault." },
            fault.headers,
          );
        }
      };
      if (fault.delayMs !== undefined) {
        const timer = setTimeout(reply, fault.delayMs);
        response.once("close", () => clearTimeout(timer));
      } else {
        reply();
      }
      return;
    }

    if (url.pathname === "/api/v2/tickets") {
      const page = Number(url.searchParams.get("page") ?? "1");
      const perPage = Number(url.searchParams.get("per_page") ?? "30");
      if (
        !Number.isInteger(page) ||
        page < 1 ||
        page > 300 ||
        !Number.isInteger(perPage) ||
        perPage < 1 ||
        perPage > 100
      ) {
        record.status = 400;
        send(response, 400, { error: "Invalid pagination." });
        return;
      }
      const since = url.searchParams.get("updated_since");
      const filtered = tickets
        .filter((ticket) => since === null || ticket.updated_at >= since)
        .sort((left, right) => {
          const order = left.updated_at.localeCompare(right.updated_at);
          return url.searchParams.get("order_type") === "asc" ? order : -order;
        });
      const slice = filtered.slice((page - 1) * perPage, page * perPage);
      const headers: Record<string, string> = {};
      if (page * perPage < filtered.length && page < 300) {
        const address = server.address();
        if (address === null || typeof address === "string") {
          throw new Error("Fixture server did not acquire a TCP address.");
        }
        const next = new URL(
          `/api/v2/tickets${url.search}`,
          `http://127.0.0.1:${address.port}`,
        );
        next.searchParams.set("page", String(page + 1));
        headers.Link = `<${next.href}>; rel="next"`;
      }
      record.status = 200;
      send(response, 200, slice, headers);
      return;
    }
    if (url.pathname === "/api/v2/search/tickets") {
      const page = Number(url.searchParams.get("page") ?? "1");
      const query = url.searchParams.get("query") ?? "";
      if (!Number.isInteger(page) || page < 1 || page > 10) {
        record.status = 400;
        send(response, 400, { error: "Invalid search pagination." });
        return;
      }
      let filtered: FictionalTicket[];
      try {
        filtered = tickets.filter(
          (ticket) => !ticket.archived && matchesQuery(ticket, query),
        );
      } catch (error) {
        if (!(error instanceof Error)) throw error;
        record.status = 400;
        send(response, 400, { error: error.message });
        return;
      }
      record.status = 200;
      send(response, 200, {
        total: filtered.length,
        results: filtered.slice((page - 1) * 30, page * 30),
      });
      return;
    }
    const getMatch = /^\/api\/v2\/tickets\/([1-9]\d*)$/.exec(url.pathname);
    const id = getMatch?.[1];
    const ticket =
      id === undefined ? undefined : tickets.find((item) => item.id === Number(id));
    record.status = ticket === undefined ? 404 : 200;
    send(response, record.status, ticket ?? { error: "Ticket not found." });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("Fixture server did not acquire a TCP address.");
  }
  return {
    baseUrl: `http://127.0.0.1:${address.port}/api/v2/`,
    apiKey,
    requests,
    close: async () => {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      });
    },
  };
}

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "./config.js";
import { ConnectorError } from "./errors.js";
import { FreshdeskConnector } from "./freshdesk.js";
import { createMcpServer } from "./mcp.js";

async function main(): Promise<void> {
  const server = createMcpServer(new FreshdeskConnector(loadConfig()));
  const shutdown = (): void => {
    void server.close().catch(() => {
      console.error("[freshdesk-mcp] Failed to close the transport.");
      process.exitCode = 1;
    });
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  await server.connect(new StdioServerTransport());
}

main().catch((error: unknown) => {
  console.error(
    error instanceof ConnectorError
      ? `[freshdesk-mcp] ${error.code}: ${error.message}`
      : "[freshdesk-mcp] Unexpected startup failure.",
  );
  process.exitCode = 1;
});

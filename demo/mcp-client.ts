import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  getDefaultEnvironment,
  StdioClientTransport,
} from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { outputEnvelopeSchema } from "../src/schemas.js";

export async function connectMcp(environment: Record<string, string>): Promise<{
  client: Client;
  diagnostics: string[];
  close: () => Promise<void>;
}> {
  const diagnostics: string[] = [];
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [fileURLToPath(new URL("../src/server.js", import.meta.url))],
    env: { ...getDefaultEnvironment(), ...environment },
    stderr: "pipe",
  });
  const client = new Client({
    name: "freshdesk-assignment-verification-client",
    version: "1.0.0",
  });
  transport.stderr?.on("data", (chunk: Buffer) => {
    diagnostics.push(chunk.toString("utf8"));
  });
  try {
    await client.connect(transport);
  } catch (error) {
    await transport.close();
    throw error;
  }
  return {
    client,
    diagnostics,
    close: async () => {
      await client.close();
    },
  };
}

export function demoEnvironment(
  provider: { baseUrl: string; apiKey: string },
  extra: Record<string, string> = {},
): Record<string, string> {
  return {
    FRESHDESK_DEMO_MODE: "true",
    FRESHDESK_BASE_URL: provider.baseUrl,
    FRESHDESK_API_KEY: provider.apiKey,
    ...extra,
  };
}

export async function callEnvelope(
  client: Client,
  name: string,
  args: Record<string, unknown> = {},
): Promise<z.infer<typeof outputEnvelopeSchema>> {
  const result = await client.callTool({ name, arguments: args });
  const parsed = outputEnvelopeSchema.parse(result.structuredContent);
  if (parsed.ok === Boolean(result.isError)) {
    throw new Error("MCP error flag and structured envelope disagree.");
  }
  return parsed;
}

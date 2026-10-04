import { randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { connectMcp, demoEnvironment } from "../demo/mcp-client.js";

const session = await connectMcp(
  demoEnvironment({
    baseUrl: "http://127.0.0.1:1/api/v2/",
    apiKey: randomBytes(24).toString("hex"),
  }),
);
try {
  const tools = await session.client.listTools();
  const directory = fileURLToPath(new URL("../../docs/", import.meta.url));
  await mkdir(directory, { recursive: true });
  await writeFile(
    `${directory}/mcp-tools.json`,
    `${JSON.stringify(
      {
        protocol: "Model Context Protocol",
        transport: "stdio",
        generated_from: "Actual MCP tools/list response",
        ...tools,
      },
      null,
      2,
    )}\n`,
  );
  console.log("Exported five actual MCP tool schemas to docs/mcp-tools.json.");
} finally {
  await session.close();
}

// A tiny MCP server for the tests: echo returns its argument and an env value, fail always errors.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const server = new McpServer({ name: "echo", version: "1.0.0" });
server.registerTool("echo", { description: "Echo", inputSchema: { text: z.string() } }, async ({ text }) => ({
  content: [{ type: "text", text: `${text} (${process.env.ECHO_SUFFIX ?? "no env"})` }],
}));
server.registerTool(
  "count",
  { description: "Count", inputSchema: { text: z.string() }, outputSchema: { words: z.number() } },
  async ({ text }) => {
    const words = text.split(/\s+/).filter(Boolean).length;
    return { content: [{ type: "text", text: `${words} words` }], structuredContent: { words } };
  },
);
server.registerTool("fail", { description: "Fail", inputSchema: {} }, async () => ({ isError: true, content: [{ type: "text", text: "it broke" }] }));
console.error("echo server ready");
await server.connect(new StdioServerTransport());

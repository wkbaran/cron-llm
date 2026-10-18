import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { z } from "zod";
import { tool, type LoopTool } from "./loop.js";

/**
 * An MCP server run as a child process over stdio, the way an agent host runs
 * it. A job calls the server's deterministic tools itself (begin, finish) and
 * can hand some of them to the model through `asLoopTool`.
 */

export interface McpServerOptions {
  command: string;
  args?: string[];
  /** Added to a minimal default environment (PATH, HOME…), not to the job's whole environment. */
  env?: Record<string, string | undefined>;
  cwd?: string;
  /** Per tool call. Digest begin tools fetch for minutes, so the default is 15 minutes. */
  timeoutMs?: number;
  /** The server's stderr lines; it's otherwise discarded. */
  onStderr?: (line: string) => void;
}

/** The server answered with `isError`; the message is the server's text. */
export class McpToolError extends Error {
  constructor(
    readonly tool: string,
    message: string,
  ) {
    super(message);
  }
}

export class McpServer {
  private constructor(
    private readonly client: Client,
    private readonly timeoutMs: number,
  ) {}

  static async start(opts: McpServerOptions): Promise<McpServer> {
    const env: Record<string, string> = { ...getDefaultEnvironment() };
    for (const [k, v] of Object.entries(opts.env ?? {})) if (v !== undefined) env[k] = v;
    const transport = new StdioClientTransport({ command: opts.command, args: opts.args, env, cwd: opts.cwd, stderr: opts.onStderr ? "pipe" : "ignore" });
    if (opts.onStderr) {
      let buf = "";
      transport.stderr?.on("data", (chunk: Buffer) => {
        buf += chunk.toString("utf8");
        const lines = buf.split("\n");
        buf = lines.pop()!;
        for (const l of lines) if (l.trim()) opts.onStderr!(l);
      });
    }
    const client = new Client({ name: "cron-llm", version: "0.1.0" });
    await client.connect(transport);
    return new McpServer(client, opts.timeoutMs ?? 900_000);
  }

  async toolNames(): Promise<string[]> {
    return (await this.client.listTools()).tools.map((t) => t.name);
  }

  /** Call a tool and return its text. Throws McpToolError when the server reports an error. */
  async call(name: string, args: Record<string, unknown> = {}): Promise<string> {
    const res = await this.client.callTool({ name, arguments: args }, undefined, { timeout: this.timeoutMs, resetTimeoutOnProgress: true });
    const content = (res.content ?? []) as { type: string; text?: string }[];
    const text = content
      .filter((c) => c.type === "text")
      .map((c) => c.text ?? "")
      .join("\n");
    if (res.isError) throw new McpToolError(name, text || `${name} failed`);
    return text;
  }

  /**
   * One of this server's tools as a loop tool, with arguments checked by
   * `args` before the server sees them. A server error comes back to the model
   * as text, so it can adjust; the loop counts it against the budget.
   */
  asLoopTool<S extends z.ZodObject>(name: string, t: { description: string; args: S; budget?: number }): LoopTool<S> {
    return tool({
      name,
      description: t.description,
      args: t.args,
      budget: t.budget,
      run: async (args) => {
        try {
          return await this.call(name, args as Record<string, unknown>);
        } catch (err) {
          if (err instanceof McpToolError) return `Error: ${err.message}`;
          throw err;
        }
      },
    });
  }

  async close(): Promise<void> {
    await this.client.close();
  }
}

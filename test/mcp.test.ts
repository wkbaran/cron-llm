import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { McpServer, McpToolError } from "../src/index.js";

const fixture = fileURLToPath(new URL("./fixtures/echo-server.mjs", import.meta.url));
let server: McpServer | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
});

describe("McpServer", () => {
  it("starts a stdio server with only the env it's given, and calls its tools", async () => {
    const stderr: string[] = [];
    server = await McpServer.start({ command: process.execPath, args: [fixture], env: { ECHO_SUFFIX: "from env", UNSET: undefined }, onStderr: (l) => stderr.push(l) });
    expect((await server.toolNames()).sort()).toEqual(["count", "echo", "fail"]);
    expect(await server.call("echo", { text: "hi" })).toBe("hi (from env)");
    const err = await server.call("fail").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(McpToolError);
    expect((err as Error).message).toBe("it broke");
    expect(stderr).toContain("echo server ready");
  });

  it("returns a tool's structuredContent, checked against a schema", async () => {
    server = await McpServer.start({ command: process.execPath, args: [fixture] });
    expect(await server.callStructured("count", { text: "one two three" }, z.object({ words: z.number() }))).toEqual({ value: { words: 3 }, text: "3 words" });
    await expect(server.callStructured("count", { text: "x" }, z.object({ lines: z.number() }))).rejects.toThrow(/unexpected structuredContent/);
    await expect(server.callStructured("echo", { text: "x" }, z.object({}))).rejects.toThrow("echo returned no structuredContent");
  });

  it("wraps a tool for the loop, returning server errors as text", async () => {
    server = await McpServer.start({ command: process.execPath, args: [fixture] });
    const fail = server.asLoopTool("fail", { description: "d", args: z.object({}) });
    expect(await fail.run({})).toBe("Error: it broke");
    const echo = server.asLoopTool("echo", { description: "d", args: z.object({ text: z.string() }), budget: 3 });
    expect(echo.budget).toBe(3);
    expect(await echo.run({ text: "x" })).toBe("x (no env)");
  });
});

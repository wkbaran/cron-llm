import { z } from "zod";
import { jsonSchema, type Llm, type Message, type ToolSpec } from "./llm.js";

/**
 * A bounded tool loop: the model calls tools until it answers in text, a
 * tool's budget runs out, or the turn limit is reached. Budgets are enforced
 * here, not in the prompt: once a tool's budget is spent it is taken out of the
 * tool list, so the model can't call it again whatever it decides.
 *
 * The loop ends with one structured call that turns what happened into the
 * caller's `final` schema. That call gets a plain-text log of the tool calls
 * rather than the raw conversation, so it works the same on every provider and
 * stays small.
 */

export interface LoopTool<S extends z.ZodType = z.ZodType> {
  name: string;
  description: string;
  args: S;
  /** At most this many calls; unlimited when unset. */
  budget?: number;
  run(args: z.infer<S>): Promise<string>;
}

/** Keeps the tool list typed per tool. */
export function tool<S extends z.ZodType>(t: LoopTool<S>): LoopTool<S> {
  return t;
}

export interface LoopOptions<F extends z.ZodType> {
  llm: Llm;
  system: string;
  user: string;
  tools: LoopTool<any>[];
  /** Shape of the loop's result. */
  final: F;
  /** What the final call is asked to do, e.g. "List the tracks you found." */
  finalPrompt?: string;
  maxTurns?: number;
  /** Tool results longer than this are cut before the model sees them. */
  maxResultChars?: number;
  /** Size cap of the tool log given to the final call. */
  maxLogChars?: number;
  log?: (line: string) => void;
}

export interface LoopCall {
  name: string;
  args: unknown;
  ok: boolean;
  result: string;
}

export interface LoopResult<T> {
  value: T;
  turns: number;
  calls: LoopCall[];
  /** Why the tool phase ended. */
  stopped: "answered" | "max_turns" | "budget";
  /** The model's last text reply, if it gave one. */
  text?: string;
}

export async function runLoop<F extends z.ZodType>(opts: LoopOptions<F>): Promise<LoopResult<z.infer<F>>> {
  const maxTurns = opts.maxTurns ?? 20;
  const maxResult = opts.maxResultChars ?? 20_000;
  const left = new Map(opts.tools.map((t) => [t.name, t.budget ?? Infinity]));
  const messages: Message[] = [
    { role: "system", content: opts.system },
    { role: "user", content: opts.user },
  ];
  const calls: LoopCall[] = [];
  let stopped: LoopResult<unknown>["stopped"] = "max_turns";
  let text: string | undefined;
  let turns = 0;

  while (turns < maxTurns) {
    const available = opts.tools.filter((t) => left.get(t.name)! > 0);
    if (!available.length) {
      stopped = "budget";
      break;
    }
    turns++;
    const { message } = await opts.llm.chat(messages, { tools: available.map(spec) });
    messages.push(message);
    if (!message.tool_calls?.length) {
      text = message.content ?? undefined;
      stopped = "answered";
      break;
    }
    for (const call of message.tool_calls) {
      const result = await runCall(opts.tools, left, call.function.name, call.function.arguments, maxResult);
      calls.push(result);
      opts.log?.(`tool ${result.name}${result.ok ? "" : " (error)"}: ${result.result.length} chars`);
      messages.push({ role: "tool", tool_call_id: call.id, content: result.result });
    }
  }

  const value = await opts.llm.structured(opts.final, {
    system: opts.system,
    user: [
      opts.user,
      "",
      `Your research is over (${stopped === "answered" ? "you finished" : stopped === "budget" ? "the tool budget is spent" : "the turn limit was reached"}). This is the log of your tool calls:`,
      "",
      toolLog(calls, opts.maxLogChars ?? 40_000),
      ...(text ? ["", "Your last message:", text] : []),
      "",
      opts.finalPrompt ?? "Give your final answer as JSON matching the schema.",
    ].join("\n"),
  });
  return { value, turns, calls, stopped, text };
}

async function runCall(tools: LoopTool[], left: Map<string, number>, name: string, rawArgs: string, maxResult: number): Promise<LoopCall> {
  const t = tools.find((x) => x.name === name);
  const fail = (args: unknown, result: string): LoopCall => ({ name, args, ok: false, result });
  if (!t) return fail(rawArgs, `Error: there is no tool named ${name}.`);
  if (left.get(name)! <= 0) return fail(rawArgs, `Error: ${name} has no calls left. Use what you have.`);
  let parsed: unknown;
  try {
    parsed = rawArgs ? JSON.parse(rawArgs) : {};
  } catch {
    return fail(rawArgs, `Error: the arguments aren't valid JSON.`);
  }
  const args = t.args.safeParse(parsed);
  if (!args.success) return fail(parsed, `Error: invalid arguments: ${args.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ")}`);
  const remaining = left.get(name)! - 1;
  left.set(name, remaining);
  let result: string;
  try {
    result = await t.run(args.data);
  } catch (err) {
    return fail(args.data, `Error: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (result.length > maxResult) result = result.slice(0, maxResult) + `\n… (cut at ${maxResult} characters)`;
  if (remaining === 0) result += `\n(That was your last ${name} call.)`;
  else if (Number.isFinite(remaining) && remaining <= 2) result += `\n(${remaining} ${name} call${remaining === 1 ? "" : "s"} left.)`;
  return { name, args: args.data, ok: true, result };
}

function spec(t: LoopTool): ToolSpec {
  return { type: "function", function: { name: t.name, description: t.description, parameters: jsonSchema(t.args) } };
}

/** The tool calls as text, newest kept when it's over the cap. */
function toolLog(calls: LoopCall[], max: number): string {
  if (!calls.length) return "(no tool calls)";
  const entries = calls.map((c, i) => `#${i + 1} ${c.name} ${JSON.stringify(c.args)}${c.ok ? "" : " (failed)"}\n${c.result}`);
  const out: string[] = [];
  let size = 0;
  for (const e of entries.reverse()) {
    if (size + e.length > max) {
      out.push(`(${entries.length - out.length} earlier calls left out)`);
      break;
    }
    out.push(e);
    size += e.length + 2;
  }
  return out.reverse().join("\n\n");
}

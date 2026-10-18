/** A fetch that answers from a script and records what it was sent. */
export function fakeFetch(answers: ((body: any, url: string) => Response | Promise<Response>)[]) {
  const sent: { url: string; body: any }[] = [];
  let i = 0;
  const f = (async (url: string, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    sent.push({ url, body });
    const answer = answers[Math.min(i++, answers.length - 1)]!;
    return answer(body, url);
  }) as unknown as typeof fetch;
  return { fetch: f, sent };
}

export function json(value: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json", ...headers } });
}

/** An OpenAI-style chat completion. */
export function completion(message: { content?: string | null; tool_calls?: unknown[] }, usage = { prompt_tokens: 10, completion_tokens: 5 }): Response {
  return json({ choices: [{ message: { role: "assistant", content: message.content ?? null, tool_calls: message.tool_calls }, finish_reason: message.tool_calls ? "tool_calls" : "stop" }], usage });
}

export function toolCall(id: string, name: string, args: unknown) {
  return { id, type: "function", function: { name, arguments: typeof args === "string" ? args : JSON.stringify(args) } };
}

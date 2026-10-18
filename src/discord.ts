/**
 * Post a message to a Discord channel webhook. Discord caps a message at 2000
 * characters, so longer text goes out in several messages, split at line
 * breaks. Mentions are never resolved, so a digest can't ping anyone.
 */

export const DISCORD_MAX = 2000;

export async function postDiscord(webhookUrl: string, text: string, opts: { username?: string; fetch?: typeof fetch } = {}): Promise<void> {
  const doFetch = opts.fetch ?? fetch;
  for (const content of splitMessage(text)) {
    for (let attempt = 0; ; attempt++) {
      const res = await doFetch(webhookUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content, allowed_mentions: { parse: [] }, ...(opts.username ? { username: opts.username } : {}) }),
        signal: AbortSignal.timeout(30_000),
      });
      if (res.ok) break;
      if (res.status === 429 && attempt < 3) {
        const body = (await res.json().catch(() => ({}))) as { retry_after?: number };
        await new Promise((r) => setTimeout(r, Math.min(30, body.retry_after ?? 2) * 1000));
        continue;
      }
      throw new Error(`Discord webhook returned ${res.status}: ${(await res.text().catch(() => "")).slice(0, 300)}`);
    }
  }
}

/** Chunks of at most `max` characters, broken at a newline where possible. */
export function splitMessage(text: string, max = DISCORD_MAX): string[] {
  const out: string[] = [];
  let rest = text.trim();
  while (rest.length > max) {
    let cut = rest.lastIndexOf("\n", max);
    if (cut < max / 2) cut = rest.lastIndexOf(" ", max);
    if (cut < max / 2) cut = max;
    out.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).trimStart();
  }
  if (rest) out.push(rest);
  return out;
}

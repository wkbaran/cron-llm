import { postDiscord } from "./discord.js";

/**
 * The wrapper a scheduled job's entry point runs in. The job returns the
 * message to deliver (or null for nothing), and the wrapper posts it to
 * `DISCORD_WEBHOOK_URL`. If the job throws, a short failure notice goes to
 * `DISCORD_FAILURE_WEBHOOK_URL` (or the same webhook) and the exit code is 1,
 * so supercronic's log shows the failure too.
 *
 * With `--dry-run` (or `JOB_DRY_RUN=1`) the message is printed instead of
 * posted, and the job is told so it can skip its own side effects.
 */

export interface JobContext {
  name: string;
  dryRun: boolean;
  env: NodeJS.ProcessEnv;
  /** A timestamped line on stdout, which `docker logs` keeps. */
  log(line: string): void;
}

export interface JobOptions {
  env?: NodeJS.ProcessEnv;
  argv?: string[];
  fetch?: typeof fetch;
  /** Where log lines go; stdout by default. */
  write?: (line: string) => void;
  /** The name the posts appear under, instead of the webhook's own. Discord groups back-to-back posts from one name. */
  username?: string;
}

export async function runJob(name: string, fn: (ctx: JobContext) => Promise<string | null | void>, opts: JobOptions = {}): Promise<number> {
  const env = opts.env ?? process.env;
  const argv = opts.argv ?? process.argv.slice(2);
  const write = opts.write ?? ((l: string) => process.stdout.write(l + "\n"));
  const dryRun = argv.includes("--dry-run") || env.JOB_DRY_RUN === "1";
  const log = (line: string) => write(`${new Date().toISOString().replace(/\.\d{3}Z$/, "Z")} ${name}: ${line}`);
  const webhook = env.DISCORD_WEBHOOK_URL;
  const failureWebhook = env.DISCORD_FAILURE_WEBHOOK_URL || webhook;
  const started = Date.now();
  const elapsed = () => `${Math.round((Date.now() - started) / 1000)} s`;
  log(dryRun ? "starting (dry run)" : "starting");

  let message: string | null | void;
  try {
    message = await fn({ name, dryRun, env, log });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    log(`failed after ${elapsed()}: ${err instanceof Error && err.stack ? err.stack : detail}`);
    if (failureWebhook && !dryRun) {
      await postDiscord(failureWebhook, `⚠ ${name} failed: ${detail.slice(0, 1500)}`, { fetch: opts.fetch, username: opts.username }).catch((e: unknown) =>
        log(`couldn't post the failure notice: ${e instanceof Error ? e.message : String(e)}`),
      );
    }
    return setExit(1);
  }

  if (!message) {
    log(`done in ${elapsed()}, nothing to send`);
    return setExit(0);
  }
  if (dryRun || !webhook) {
    log(`done in ${elapsed()}; ${dryRun ? "dry run" : "no DISCORD_WEBHOOK_URL"}, so the message follows instead of being posted`);
    write(message);
    return setExit(0);
  }
  try {
    await postDiscord(webhook, message, { fetch: opts.fetch, username: opts.username });
  } catch (err) {
    log(`the message couldn't be posted: ${err instanceof Error ? err.message : String(err)}`);
    write(message);
    return setExit(1);
  }
  log(`done in ${elapsed()}, posted ${message.length} characters`);
  return setExit(0);
}

function setExit(code: number): number {
  process.exitCode = code;
  return code;
}

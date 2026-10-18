# Agent notes

Common mistakes and confusion points in this project. Add to this list when something surprises you.

- **This is the runtime for job runners, not for MCP servers.** Its users are the job repos (`~/projects/substack-digest`, `medium-digest`, `spotify-discovery`). The MCP servers they drive (`*-reader-mcp`, `spotify-discovery-mcp`) depend only on [job-ledger](https://github.com/wkbaran/job-ledger) and must not depend on this, so they stay plain MCP servers.
- **Keep it free of any one service.** No Medium, Substack, Spotify or LiteLLM-only types; LiteLLM's `metadata.tags` is just an extra body field other servers ignore.
- **Tracing is LiteLLM's job** (its dashboard and S3 logs). Don't add prompt or response logging here beyond the optional one-line-per-call `log`.
- **`runLoop`'s final call gets a text log of the tool calls, not the conversation.** That's on purpose: some providers reject `tool` messages in a request with no `tools`, and the log is smaller. Keep it that way unless a job needs the model's reasoning carried over.
- **The MCP child gets a minimal environment** (`getDefaultEnvironment()` plus what's passed). A job's secrets aren't inherited, the same as under an agent host.
- TypeScript is 7.x, the native compiler. If vitest fails with `Cannot find native binding` (rolldown), delete `node_modules` and `package-lock.json` and run `npm install` again.
- Publishing needs the user's npm one-time code (`npm publish --access public --otp=…`); Claude Code's permission check blocks publishing from the agent.

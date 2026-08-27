# AiderDesk ACP Bridge

Standalone [ACP (Agent Client Protocol)](https://agentclientprotocol.com) bridge that exposes an
[AiderDesk](https://aiderdesk.com) server to ACP-compatible clients (Claude Code, Cursor,
Continue, etc.) over stdio. Powered by [Bun](https://bun.sh).

The bridge speaks ACP on stdin/stdout and translates conversations into HTTP + SSE calls against
the AiderDesk REST API (`/api/run-prompt`, `/api/agent-profiles`, `/api/project/custom-modes`,
`/api/project/settings`, `/api/project/interrupt`, `/api/health`).

## Features

- Full ACP agent lifecycle: `initialize`, `authenticate`, `session/new`,
  `session/set_config_option`, `session/prompt`, `session/cancel`
- Mode / agent-profile / autonomy configuration surfaced as ACP session config options
- SSE event translation: response chunks, reasoning, tool calls, usage updates,
  session info, cancellation — including `agent_thought_chunk`, `agent_message_chunk`,
  `tool_call`, `tool_call_update`, `usage_update` notifications
- Single-file compiled binary via `bun build --compile`

## Requirements

- [Bun](https://bun.sh) >= 1.1
- A running AiderDesk server (`aiderdesk` or `aiderdesk start`)

## Usage

```sh
# Install dependencies
bun install

# Run from source (pipe into an ACP client)
bun run dev -- --port 24337

# Or install the CLI
bun link
aiderdesk-acp-bridge --port 24337

# Build a single standalone executable
bun run build
./dist/aiderdesk-acp-bridge --port 24337
```

### Options

| Option             | Description                                          | Default            |
| ------------------ | ---------------------------------------------------- | ------------------ |
| `-p, --port <port>`| AiderDesk server port                                | `24337`            |
| `--host <host>`    | AiderDesk server host                                | `localhost`        |
| `-v, --version`    | Print version                                        |                    |
| `-h, --help`       | Show help                                            |                    |

The port can also be set via the `AIDER_DESK_PORT` environment variable.

### Typical client configuration

```jsonc
{
  "mcpServers": {
    "aiderdesk": {
      "command": "aiderdesk-acp-bridge",
      "args": []
    }
  }
}
```

## Protocol overview

| ACP method                      | AiderDesk REST call(s)                                             |
| ------------------------------- | ------------------------------------------------------------------ |
| `session/new`                   | `GET /api/agent-profiles`, `GET /api/project/custom-modes`, `GET /api/project/settings` |
| `session/prompt`                | `POST /api/run-prompt` (SSE)                                       |
| `session/cancel`                | aborts the SSE request + `POST /api/project/interrupt`             |

## Development

```sh
bun run typecheck   # bunx tsc --noEmit
bun test            # bun:test suite (SSE parser, tool mapping, agent flow)
bun run build       # compile a standalone binary to dist/
```

## License

MIT
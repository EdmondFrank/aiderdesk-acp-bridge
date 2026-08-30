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
- ACP session management: `session/list`, `session/load`, `session/resume`,
  `session/delete`. Sessions map 1:1 to AiderDesk tasks — a session is created
  eagerly as a server task at `session/new` (its task id is the ACP session id),
  so sessions survive bridge restarts: any ACP client can list tasks and restore
  a conversation (`session/load` replays the stored conversation, which agent-shell
  renders per its restore verbosity)
- Mode / agent-profile / autonomy configuration surfaced as ACP session config options
- Slash commands: custom commands (`~/.aider-desk/commands/` and
  `<project>/.aider-desk/commands/`) are advertised to ACP clients and executed
  with argument substitution and `!shell` support; built-in session-control
  commands (`/new`, `/compact`, `/smart-compact`, `/handoff`, `/tasks`, `/load`)
  are translated into the corresponding AiderDesk REST calls
- SSE event translation: response chunks, reasoning, tool calls, usage updates,
  session info, cancellation — including `agent_thought_chunk`, `agent_message_chunk`,
  `tool_call`, `tool_call_update`, `usage_update` and `available_commands_update` notifications;
  `session/prompt` responses carry session-cumulative token usage (ACP experimental `usage`)
- Single-file compiled binary via `bun build --compile`

## Requirements

- [Bun](https://bun.sh) >= 1.3 — Bun 1.2.x buffers piped stdin until EOF and
  lacks the web `WritableStream` API on stdout, which breaks ACP over stdio.
  Verify with `bun --version`.
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
| `session/new`                   | `POST /api/project/add-open`, `POST /api/project/tasks/new`, `GET /api/agent-profiles`, `GET /api/project/custom-modes`, `GET /api/project/settings`, `GET /api/project/commands` — creates the backing task eagerly so the session id is a stable task id |
| `session/list`                  | `POST /api/project/add-open`, `GET /api/project/tasks`             |
| `session/list_input_history`    | `GET /api/project/input-history` (custom extension method; used by agent-shell's input-history command) |
| `session/load`                  | `POST /api/project/tasks/load` (replays the stored conversation as session updates) |
| `session/resume`                | `POST /api/project/resume-task`                                    |
| `session/delete`                | `POST /api/project/tasks/delete`                                   |
| `session/prompt`                | `POST /api/run-prompt` (SSE)                                       |
| `session/cancel`                | aborts the SSE request + `POST /api/project/interrupt`             |

## Slash commands

The bridge discovers the project's custom and extension commands from
`GET /api/project/commands` when a session is created and advertises them to ACP
clients via an `available_commands_update` notification, so clients can offer
them, e.g. as `/command` completions.

Commands are invoked by sending `/name arg1 arg2` as the prompt:

- **Built-in session-control commands** are handled by the bridge itself and
  translated to AiderDesk REST calls (they never produce a model turn):

  | Command          | AiderDesk REST call                     | Notes                                              |
  | ---------------- | --------------------------------------- | -------------------------------------------------- |
  | `/new [name]`    | `POST /api/project/tasks/new`           | starts a new task and makes it the session's task  |
  | `/tasks`         | `POST /api/project/add-open`, `GET /api/project/tasks` | lists the project's tasks as a numbered thought chunk |
  | `/load <id\|#n>` | sets the session's task (via `GET /api/project/tasks`) | `#n` refers to the number shown by `/tasks`; a task id or unique id prefix also works |
  | `/compact [hint]`| `POST /api/project/compact-conversation`| requires an existing task                           |
  | `/smart-compact` | `POST /api/project/smart-compact-conversation` | requires an existing task                  |
  | `/handoff [focus]` / `/hand-off [focus]` | `POST /api/project/handoff-conversation` | requires an existing task; creates a new task and makes it the session's task |

- **Custom commands** (markdown files under `~/.aider-desk/commands/` or
  `<project>/.aider-desk/commands/`) are expanded by the bridge itself —
  `{{1}}`, `{{2}}`, `{{ARGUMENTS}}` placeholders, optional arguments, and
  `!shell` lines — and then streamed through the regular `POST /api/run-prompt`
  SSE flow. The command's `autonomyMode` override (when declared) and the
  current mode/profile/autonomy settings are applied. So no server changes are
  required.
- **Extension commands** (from AiderDesk extensions) have no expandable
  template; the bridge creates a task if needed (`POST /api/project/tasks/new`)
  and asks the server to run the command (`POST /api/project/custom-commands`),
  best-effort and without streaming.
- Unknown `/foo` text is passed through unchanged as a regular prompt.

### Known limitations

- Custom command `includeContext: false` and `skills` frontmatter are not
  surfaced over the REST API and are therefore ignored; the command runs with
  the task's normal conversation context.
- Extension commands never stream results back to the client (the AiderDesk
  REST API offers no event stream for `custom-commands`); custom commands
  stream fully.
- Command definitions are fetched once per session; file changes while a
  session is open require a new session to take effect.

## Development

```sh
bun run typecheck   # bunx tsc --noEmit
bun test            # bun:test suite (SSE parser, tool mapping, agent flow)
bun run build       # compile a standalone binary to dist/
```

## License

MIT
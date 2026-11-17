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
  renders per its restore verbosity, and `session/load`/`session/resume` adopt the
  task's own title, mode, profile and model); `session/resume` only asks the
  server to continue a task it left `IN_PROGRESS`/`INTERRUPTED`
- Mode / agent-profile / autonomy / model configuration surfaced as ACP session config options (model changes persist to the task via the REST API). The model picker mirrors AiderDesk's own selector — starred models first under `Preferred`, then one group per provider under its display name, with hidden models and the models of disabled providers left out — and its current value is the model the task actually runs (explicit selection, the agent profile's model, or the project's `mainModel`), not the first offered one
- Slash commands: custom commands (`~/.aider-desk/commands/` and
  `<project>/.aider-desk/commands/`) are advertised to ACP clients and executed
  with argument substitution and `!shell` support; built-in session-control
  commands (`/new`, `/compact`, `/smart-compact`, `/handoff`, `/tasks`, `/load`)
  are translated into the corresponding AiderDesk REST calls
- SSE event translation: response chunks, reasoning, tool calls, usage updates,
  session info, cancellation — including `agent_thought_chunk`, `agent_message_chunk`,
  `tool_call`, `tool_call_update`, `usage_update` and `available_commands_update` notifications;
  `session/prompt` responses carry session-cumulative token usage (ACP experimental `usage`)
- Context window reporting: `usage_update` carries the effective model's context
  window (`size`, resolved from the selected model, the agent profile's model or the
  project's `mainModel`) next to the last turn's prompt tokens (`used`), and is
  published when a session is created or reloaded and whenever the model changes —
  so an ACP client's header shows `used/size` just as it does for Pi. A compaction
  done by the bridge (`/compact`, `/smart-compact`, idle compaction) republishes the
  shrunk figure immediately, estimated from the compacted transcript.
- Standing prompts for clients that own the system prompt: `_meta.systemPromptOverride`
  becomes `<project>/.aider-desk/rules/raft-standing-prompt.md`, so AiderDesk renders it
  into the system prompt instead of the conversation history. Session-id → task-id
  mappings are persisted (`AIDER_DESK_ACP_STATE_DIR`) because `/new` and `/handoff`
  swap the task while the client keeps resuming by session id
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
bun run dev -- --port 23456

# Or link the CLI onto PATH (registers the package and symlinks its bin into ~/.bun/bin)
bun link
aiderdesk-acp-bridge --port 23456

# Build a single standalone executable
bun run build
./dist/aiderdesk-acp-bridge --port 23456
```

### Options

| Option             | Description                                          | Default            |
| ------------------ | ---------------------------------------------------- | ------------------ |
| `-p, --port <port>`| AiderDesk server port                                | `23456`            |
| `--host <host>`    | AiderDesk server host                                | `localhost`        |
| `-v, --version`    | Print version                                        |                    |
| `-h, --help`       | Show help                                            |                    |

### Environment variables

| Variable                       | Description                                                        | Default          |
| ------------------------------ | ------------------------------------------------------------------ | ---------------- |
| `AIDER_DESK_PORT`              | AiderDesk server port (overridden by `--port`)                      | `23456`          |
| `AIDER_DESK_JSON_TIMEOUT_MS`   | Timeout for plain JSON REST calls that never wait on the model      | `10000`          |
| `AIDER_DESK_SSE_TIMEOUT_MS`    | Timeout for streaming turns (`session/prompt`) and for model-waiting calls (`/compact`, `/smart-compact`, `/handoff`) | `1800000` (30 min) |
| `AIDER_DESK_ACP_AUTO_ANSWER`   | Answer AiderDesk questions on the client's behalf (`POST /api/project/answer-question`); enable for clients without an approval UI | `off` |
| `AIDER_DESK_ACP_AUTO_ANSWER_MODE` | `once` submits one answer per question; `always` may pick the question's `a` (all / always) option, which the server then remembers for the rest of the task | `once` |
| `AIDER_DESK_ACP_REPLAY`        | How much of a loaded task `session/load` replays: `full`, `tail` (last 20 messages) or `off` | `full` |
| `AIDER_DESK_ACP_RESUME_TASK`   | Whether `session/resume` asks the server to continue the task (`POST /api/project/resume-task`, which runs a model turn). Unset: only tasks the server left `IN_PROGRESS`/`INTERRUPTED`; `1`/`true` always; `0`/`false` never | unset |
| `AIDER_DESK_ACP_STATE_DIR`     | Directory holding the session-id → task-id map (survives bridge restarts) | `~/.local/state/aiderdesk-acp` |

Timeouts are read once at startup and are expressed in milliseconds.
`AIDER_DESK_SSE_TIMEOUT_MS` bounds the *whole* turn — it is not a connect-only
deadline — so a long agent turn that is still streaming when the deadline fires
is aborted. Values are capped at the AiderDesk server's own 30-minute provider
timeout, which is why that is the default here.

```sh
# Allow unusually long turns (60 minutes) before the bridge aborts the stream
AIDER_DESK_SSE_TIMEOUT_MS=3600000 aiderdesk-acp-bridge

# Client owns the conversation: answer questions, do not replay the transcript
AIDER_DESK_ACP_AUTO_ANSWER=1 AIDER_DESK_ACP_REPLAY=off aiderdesk-acp-bridge
```

`AIDER_DESK_ACP_AUTO_ANSWER` matters because AiderDesk blocks the turn on
`task.askQuestion()` — it has no timeout — so a question nobody answers only ends
when the SSE deadline fires. The bridge answers with the question's default
answer (or `y`) and reports the decision as an `agent_thought_chunk`.

`AIDER_DESK_ACP_AUTO_ANSWER_MODE=once` (the default) never submits `a`/all,
because the server stores that answer for the rest of the task — a single
approval would silently become a standing one. Set it to `always` for an agent
that should batch approvals. A question with no options needs free text, which
this API cannot carry, so the bridge declines it (`n`) rather than answering a
meaningless `y`; the turn ends either way.

### Typical client configuration

```jsonc
{
  "mcpServers": {
    "aiderdesk": {
      "command": "aiderdesk-acp-bridge",
      "args": [],
      // optional: raise the per-turn streaming budget
      "env": { "AIDER_DESK_SSE_TIMEOUT_MS": "3600000" }
    }
  }
}
```

## Protocol overview

| ACP method                      | AiderDesk REST call(s)                                             |
| ------------------------------- | ------------------------------------------------------------------ |
| `session/new`                   | `POST /api/project/add-open`, `POST /api/project/tasks/new`, `GET /api/agent-profiles`, `GET /api/project/custom-modes`, `GET /api/project/settings`, `GET /api/project/commands` — creates the backing task eagerly so the session id is a stable task id |
| `session/list`                  | `POST /api/project/add-open`, `GET /api/project/tasks` — sessions are returned newest-created first (archived tasks are hidden; undated tasks go last) |
| `session/list_input_history`    | `GET /api/project/input-history` (custom extension method; used by agent-shell's input-history command) |
| `session/load`                  | `POST /api/project/add-open`, `GET /api/project/tasks` (validates the task and adopts its title + settings), `POST /api/project/tasks/load` (replays the stored conversation as session updates, per `AIDER_DESK_ACP_REPLAY`; fails when the task no longer exists so the client can start fresh) |
| `session/resume`                | `POST /api/project/add-open`, `GET /api/project/tasks` (validates the task and adopts its title + settings), `POST /api/project/resume-task` only when the task is `IN_PROGRESS`/`INTERRUPTED` or `AIDER_DESK_ACP_RESUME_TASK` forces it; fails when the task no longer exists, like `session/load` |
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
  | `/tasks`         | `POST /api/project/add-open`, `GET /api/project/tasks` | lists the project's tasks as a numbered thought chunk, newest-created first |
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
- **Skills** are advertised alongside the commands, as `/skill:<name>`, from
  `GET /api/skills` — the same `/skill:<name> [prompt]` line AiderDesk parses
  itself, so a client's `/` completion offers them without knowing what a
  skill is. Skills marked `user-invocable: false` and the project's
  `disabledSkills` are left out. The bridge activates the skill itself
  (`POST /api/skills/activate`) before running whatever follows the trigger as
  a prompt, so a bare `/skill:<name>` still reports "activated" instead of the
  silent no-turn the server answers with; an activated skill is marked
  `(active)` in its description. A session without a skill list (the fetch
  failed) passes the line through untouched.
- Unknown `/foo` text is passed through unchanged as a regular prompt.

### Known limitations

- Custom command `includeContext: false` and `skills` frontmatter are not
  surfaced over the REST API and are therefore ignored; the command runs with
  the task's normal conversation context.
- Extension commands never stream results back to the client (the AiderDesk
  REST API offers no event stream for `custom-commands`); custom commands
  stream fully.
- Command definitions are fetched once per session; file changes while a
  session is open require a new session to take effect. Skills are re-read
  whenever the session changes task (`/new`, `/load`, `/handoff`).

## Development

```sh
bun run typecheck   # bunx tsc --noEmit
bun test            # bun:test suite (SSE parser, tool mapping, skills, agent flow)
bun run build       # compile a standalone binary to dist/
```

## License

MIT
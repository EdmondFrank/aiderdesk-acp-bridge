# AGENTS.md

Guidance for AI agents and contributors working in this repository.

## What this is

`aiderdesk-acp-bridge` is a standalone **ACP (Agent Client Protocol) bridge** for
AiderDesk, powered by **Bun**. It speaks ACP over stdio on stdin/stdout (consumed by
clients like Claude Code, Cursor, Continue) and translates conversations into HTTP + SSE
calls against the AiderDesk REST API (`/api/run-prompt`, `/api/agent-profiles`,
`/api/project/*`, `/api/health`).

Two directions of translation — keep both sides in mind when changing code:

1. **ACP in → AiderDesk out**: ACP requests (`initialize`, `session/new`,
   `session/set_config_option`, `session/prompt`, `session/cancel`) become REST calls.
   `session/prompt` responses include the ACP experimental `usage` field — a
   session-cumulative tally accumulated from per-turn `usageReport` SSE events
   (per `AcpSession.usage`); the `usage_update` notification remains per-turn.
2. **AiderDesk out → ACP out**: AiderDesk SSE events become ACP `session/update`
   notifications (`agent_thought_chunk`, `agent_message_chunk`, `tool_call`,
   `tool_call_update`, `usage_update`, `session_info_update`,
   `user_message_chunk`, `available_commands_update`).

The README's protocol overview and slash-command tables must stay accurate when behavior
changes.

## Commands

```sh
bun install         # install dependencies
bun run dev         # run from source (pipes into an ACP client)
bun test            # bun:test suite — 108 tests across 6 files
bun run typecheck   # bunx tsc --noEmit (strict)
bun run build       # compile a single standalone binary to dist/
```

Requires **Bun >= 1.3** — Bun 1.2.x buffers piped stdin until EOF and lacks the web
`WritableStream` API on stdout, which breaks ACP over stdio. Tests never need a running
AiderDesk server: they mock `globalThis.fetch` and the ACP context.

## Architecture

| File | Responsibility |
| --- | --- |
| `src/index.ts` | CLI entry: arg parsing (`-p/--port`, `--host`, `-v`, `-h`, `AIDER_DESK_PORT` env), health check against `/api/health`, wraps `process.stdout` in a web `WritableStream` (Bun's `stdout.stream()` lacks `getWriter`), wires ACP methods and notifications to an `AcpAgent` over NDJSON stdio. |
| `src/agent.ts` | `AcpAgent` class — the ACP lifecycle and session state (`Map<sessionId, AcpSession>`). `prompt()` is the dispatcher: built-in command → direct REST; file-based custom command → local template expansion + SSE prompt flow; extension command → server-side `custom-commands` (best effort); anything else → regular `POST /api/run-prompt` SSE flow. `relaySse()` translates SSE events into ACP notifications. |
| `src/commands.ts` | Slash-command support: `fetchCommands` (`GET /api/project/commands`), command normalization/lookup, `BUILT_IN_COMMANDS` (`/new`, `/compact`, `/smart-compact`, `/handoff` + alias `/hand-off`), `parseCommandText`, argument substitution (`{{1}}`, `{{2}}`, `{{ARGUMENTS}}`), `!shell` line execution, template expansion. |
| `src/http.ts` | REST + SSE plumbing: `fetchJSON` (with configurable `timeoutMs`), `requestSSEStream` (path-parameterized, reads `x-task-id` header), `callInterrupt`, `createTask`, `runCustomCommand`, `compactConversation`, `smartCompactConversation`, `handoffConversation`. All REST endpoints used by the bridge live here as named helpers. |
| `src/modes.ts` | Agent profiles and chat modes: fetch profiles/custom modes/project default profile, `getAllModes`, `buildModeState`, `buildConfigOptions` (ACP `chat_mode`, `agent_profile`, `autonomy_mode` selects). |
| `src/sse.ts` | `parseSSEEvents` — async generator parsing an SSE `ReadableStream` into `{type, data}` events (multi-line data, chunk boundaries, CRLF, trailing event without blank line). |
| `src/tools.ts` | SSE tool events ↔ ACP tool calls: `inferToolKind`, `parseToolArgs`, `formatToolInputAsText`, `formatToolTitle`, `parseToolResponse`, `isToolFailed`, `buildToolCallContentArray` (diffs, terminal, text content), plus `contentBlocksToPrompt` and `generateSessionId`. |
| `src/constants.ts` | Host/port defaults, env port resolution, built-in modes, `AIDER_MODES`, autonomy modes, default mode/autonomy. |
| `test/*.test.ts` | `bun:test` suites. `test/helpers.ts` exports `selectById` for asserting on config options. |

## Prompt dispatch order (in `AcpAgent.prompt`)

1. Flatten content blocks into `promptText` + `images`; empty input → `end_turn`.
2. `parseCommandText(promptText)` — if it is a slash command:
   - **Built-in** (`/new`, `/compact`, `/smart-compact`, `/handoff`, alias `/hand-off`)
     → `runBuiltInCommandPrompt`: direct REST call, never streamed, always `end_turn`;
     compact/smart-compact/handoff require an existing `session.taskId`.
   - **Custom command with a template** → `runCustomCommandPrompt`:
     `validateRequiredArguments` → `expandCommandTemplate` (substitution + `!shell`) →
     stream through the regular run-prompt SSE flow with the command's
     `autonomyMode` override (if declared).
   - **Extension command (no template)** → `runExtensionCommandPrompt`:
     create a task if needed, `POST /api/project/custom-commands`, best-effort,
     no streaming, always `end_turn`. Feedback goes to the client as an
     `agent_thought_chunk`.
3. Otherwise (regular prompt, or an unknown `/foo` passed through untouched) →
   `runPromptRequest` → `POST /api/run-prompt` SSE → `relaySse` translates events
   into ACP session updates until `stream-end`/`error`/abort.

Every dispatch path ends in a `stopReason`; the `finally` block clears
`abortController`/`sseStream`. Aborts return `{ stopReason: 'cancelled' }`.

## Conventions

- **TypeScript, strict mode, ESM.** `verbatimModuleSyntax` is on — use `import type`
  (or inline `type` in destructured imports) for type-only imports; the typecheck will
  fail otherwise.
- **Bun-native runtime.** Use `bun:test`, `Bun.stdin.stream()`, `fetch`,
  `AbortSignal.timeout`. `node:child_process` / `node:util` are fine (used by
  `commands.ts` for `!shell`). Do not add Node-only APIs without checking they work
  under Bun.
- **JSDoc on exported functions** describing contracts, not mechanics. Example:
  "Returns empty lists on any failure so callers degrade gracefully."
- **Graceful degradation.** Fetch helpers (`fetchCommands`, `fetchAgentProfiles`,
  `fetchCustomModes`, ...) swallow errors and return empty defaults.
  Best-effort operations (interrupt, notifications, extension commands) use
  `try/catch` with a `// best-effort` comment.
- **Error reporting to clients** goes through `notifyThought()` /
  `agent_thought_chunk`; internal diagnostics go to `process.stderr.write`.
- **Constants over magic numbers**, with numeric separators (`30_000`). Timeouts live
  in `http.ts` (`JSON_TIMEOUT_MS` = 10s, `SSE_CONNECT_TIMEOUT_MS` = 600s).
- **Timeout-aware requests.** Any endpoint that may wait on the model (compact,
  smart-compact, handoff) must pass `SSE_CONNECT_TIMEOUT_MS` to `fetchJSON`.
- **Optional fields are spread conditionally** (`...(name ? { name } : {})`),
  never serialized as `undefined`.
- Endpoints are referenced as path strings (e.g. `/api/project/compact-conversation`);
  keep them in sync with the README tables.

## Gotchas

- **Do not touch the stdout wrapping in `index.ts`.** Bun's `stdout.stream()` lacks
  the web `WritableStream` API (`getWriter`) the SDK's `ndJsonStream` relies on; the
  manual `WritableStream` wrapper over `process.stdout` is required. Requires
  Bun >= 1.3 (1.2.x buffers piped stdin until EOF).
- **Commands are fetched once per session.** `fetchCommands` runs in `newSession`;
  command file changes while a session is open require a new session. The
  `available_commands_update` notification is deferred with `setTimeout(0)` so the
  `session/new` response is written first — keep that ordering (a notification
  referencing an unknown session id is dropped by the client).
- **Built-in commands cannot be shadowed** — they resolve before project
  custom/extension commands.
- **Custom command limitations**: `includeContext: false` and `skills` frontmatter
  are not surfaced by the REST API and are ignored; the expanded prompt always runs
  with the task's normal conversation context.
- **Extension commands never stream** (`/api/project/custom-commands` has no SSE
  stream); they are best-effort — failures only produce an `agent_thought_chunk` +
  stderr log, never an exception.
- **`session.taskId` is sticky** — learned from the `x-task-id` header of the first
  `run-prompt` response, or set by `/new`; reuse it for interrupt/compact/handoff.
- **SSE relay must respect aborts** — `relaySse` checks `abortController.signal`
  on every event and returns `cancelled`; `cancel()` also aborts the SSE stream and
  fires `POST /api/project/interrupt`.
- When adding a new AiderDesk endpoint that may wait on the model, give it a named
  helper in `http.ts` and pass `SSE_CONNECT_TIMEOUT_MS` (600s) to `fetchJSON`, not
  the default 10s JSON timeout.

## Testing

- `bun test`. Suites live next to behavior: `agent.test.ts`, `commands.test.ts`,
  `http.test.ts`, `modes.test.ts`, `sse.test.ts`, `tools.test.ts`.
- The agent tests use a `createMockRouter()` fetch mock (`routes` + recorded `calls`,
  assert with `callsMatching(regexp)`) and `mockContext()` for `cx.notify` capture.
  `test/helpers.ts` provides `selectById`.
- Unit-test the pure functions in `commands.ts` (parsing, substitution, shell
  expansion) directly; test the dispatch/relay behavior through `AcpAgent` with the
  mocked router and context, mirroring the real SSE event payloads.
- Before completing a change: `bun test` and `bun run typecheck` must both pass.
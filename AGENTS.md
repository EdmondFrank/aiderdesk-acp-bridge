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
   `session/list`, `session/load`, `session/resume`, `session/delete`,
   `session/set_config_option`, `session/prompt`, `session/cancel`) become REST calls.
   `session/prompt` responses include the ACP experimental `usage` field — a
   session-cumulative tally accumulated from per-turn `usageReport` SSE events
   (per `AcpSession.usage`); the `usage_update` notification remains per-turn.
   `session/load` replays the task's stored conversation (`POST /api/project/tasks/load`)
   as session updates inside the load request.
2. **AiderDesk out → ACP out**: AiderDesk SSE events become ACP `session/update`
   notifications (`agent_thought_chunk`, `agent_message_chunk`, `tool_call`,
   `tool_call_update`, `usage_update`, `session_info_update`,
   `user_message_chunk`, `available_commands_update`). `usage_update` carries the
   effective model's context window (`size`) next to the turn's prompt tokens
   (`used`), so clients render `used/size (%)` as they do for Pi.

The README's protocol overview and slash-command tables must stay accurate when behavior
changes.

## Versioning

Bump `version` in `package.json` in the same commit as any behavior change — it is the
single source for both `--version`/`-v` and the ACP `initialize` response (read from
`../package.json`), and clients log it when they negotiate the connection. Semver by
intent: patch for fixes and docs, minor for new ACP methods, config options, env vars or
command behavior, major when an existing client-visible contract changes. Two independent
versions exist and must not be confused:

- `package.json` — the bridge.
- `raft-shim/raft-policy/index.ts` — the Raft extension; `raft-shim/install.sh` installs it
  into a version-named path, so **reinstalling the same version keeps running the old copy**.
  Bump it whenever the policy changes.

## Commands

```sh
bun install         # install dependencies
bun run dev         # run from source (pipes into an ACP client)
bun test            # bun:test suite — 243 tests across 13 files
bun run typecheck   # bunx tsc --noEmit (strict)
bun run build       # compile a single standalone binary to dist/
```

Requires **Bun >= 1.3** — Bun 1.2.x buffers piped stdin until EOF and lacks the web
`WritableStream` API on stdout, which breaks ACP over stdio. Tests never need a running
AiderDesk server: they mock `globalThis.fetch` and the ACP context.

## Architecture

| File | Responsibility |
| --- | --- |
| `src/index.ts` | CLI entry: arg parsing (`-p/--port`, `--host`, `-v`, `-h`, `AIDER_DESK_PORT` env), health check against `/api/health`, wraps `process.stdout` in a web `WritableStream` (Bun's `stdout.stream()` lacks `getWriter`), wires ACP methods and notifications to an `AcpAgent` over NDJSON stdio (including `session/list`, `session/load`, `session/resume`, `session/delete`). |
| `src/agent.ts` | `AcpAgent` class — the ACP lifecycle and session state (`Map<sessionId, AcpSession>`). Sessions map 1:1 to AiderDesk tasks: `newSession` eagerly creates the task (`add-open` + `tasks/new`) and uses the task id as the session id (falling back to a local id when creation fails). `listSessions`/`loadSession`/`resumeSession`/`deleteSession` implement ACP session management over the task API; `listSessions` returns tasks newest-created first (`sortTasksNewestFirst`, the same order `/tasks` renders and `/load #N` indexes into), and `loadSession`/`resumeSession` announce the task title (`session_info_update`) and adopt the task's own mode/profile/autonomy/model via `applyTaskSettings` instead of the project defaults, and `resumeSession` only calls `resume-task` when `shouldResumeTask` says the server left the task `IN_PROGRESS`/`INTERRUPTED` (`AIDER_DESK_ACP_RESUME_TASK` overrides) — an idle reconnect must not spend a model turn; `replayTaskMessages` streams a loaded conversation as session updates (tool calls go through the same `notifyToolCallStart`/`notifyToolCallEnd` helpers as the live relay, because a `tool_call_update` without its `tool_call` renders nameless). `prompt()` is the dispatcher: built-in command → direct REST; file-based custom command → local template expansion + SSE prompt flow; extension command → server-side `custom-commands` (best effort); anything else → regular `POST /api/run-prompt` SSE flow. `relaySse()` translates SSE events into ACP notifications. `setConfigOption` also handles the `model` config id (composed `provider/model` value) and persists it via `updateTaskModel` when a task exists, and persists `agent_profile`/`autonomy_mode` via `updateTaskFields` (the server ignores both on `run-prompt` once a task exists). `applyStandingPrompt` turns `_meta.systemPromptOverride` into a project rules file, `answerPendingQuestion` answers `ask-question` SSE events when `AIDER_DESK_ACP_AUTO_ANSWER` is set, and `replayMode` (`AIDER_DESK_ACP_REPLAY`) controls how much of a loaded task is replayed. |
| `src/commands.ts` | Slash-command support: `fetchCommands` (`GET /api/project/commands`), command normalization/lookup, `BUILT_IN_COMMANDS` (`/new`, `/compact`, `/smart-compact`, `/handoff` + alias `/hand-off`, `/tasks`, `/load`), `parseCommandText`, argument substitution (`{{1}}`, `{{2}}`, `{{ARGUMENTS}}`), `!shell` line execution, template expansion. |
| `src/http.ts` | REST + SSE plumbing: `fetchJSON` (with configurable `timeoutMs`), `requestSSEStream` (path-parameterized, reads `x-task-id` header), `callInterrupt`, `createTask`, `ensureProjectOpen`, `listTasks`, `loadTask`, `listTasksStrict`, `loadTaskStrict`, `resumeTask`, `deleteTask`, `runCustomCommand`, `updateTaskModel`, `updateTaskFields`, `answerQuestion`, `compactConversation`, `smartCompactConversation`, `handoffConversation`. All REST endpoints used by the bridge live here as named helpers; the `…Strict` variants distinguish "request failed" from "empty/missing", which is what `session/load` needs. |
| `src/session-policy.ts` | Per-project session state that must outlive the process: `writeStandingPrompt`/`clearStandingPrompt` (the ACP standing prompt as `<project>/.aider-desk/rules/raft-standing-prompt.md`, which AiderDesk renders into the system prompt) and the session-id → task-id map (`rememberSessionTask`, `resolveSessionTask`, `forgetSessionTask`) persisted under `$AIDER_DESK_ACP_STATE_DIR` (default `~/.local/state/aiderdesk-acp`). |
| `src/modes.ts` | Agent profiles and chat modes: fetch profiles/custom modes/project settings/provider models (`fetchAgentProfiles` keeps each profile's `provider`/`model`, `fetchProviderModels` keeps `maxInputTokens`, `fetchProjectSettings` returns the default profile + `mainModel`), `getAllModes`, `buildModeState`, `buildConfigOptions` (ACP `chat_mode`, `agent_profile`, `autonomy_mode` and `model` selects). |
| `src/context-usage.ts` | Context-window resolution for `usage_update`: `resolveContextModel` (session selection → agent profile's model → project `mainModel`, ignoring models the server no longer lists), `contextWindowFor`, `parseComposedModelId`, `lastContextTokensFrom` (seeds `used` when a loaded conversation is replayed), `estimateContextTokens` (the figure a compaction leaves behind, which no turn measures). |
| `src/sse.ts` | `parseSSEEvents` — async generator parsing an SSE `ReadableStream` into `{type, data}` events (multi-line data, chunk boundaries, CRLF, trailing event without blank line). |
| `src/tools.ts` | SSE tool events ↔ ACP tool calls: `inferToolKind`, `parseToolArgs`, `formatToolInputAsText`, `formatToolTitle` (with `summarizeToolArgs` giving every unnamed tool a parameter-bearing title), `parseToolResponse`, `isToolFailed`, `buildToolCallContentArray` (diffs, terminal, text content), plus `contentBlocksToPrompt` and `generateSessionId`. |
| `src/constants.ts` | Host/port defaults, env port resolution, built-in modes, `AIDER_MODES`, autonomy modes, default mode/autonomy. |
| `raft-shim/` | Raft adapter: `aiderdesk.ts` proxies Raft's Grok ACP driver onto the bridge, `raft-policy/` holds an AiderDesk extension that elides stale tool results for long-lived agent tasks (own `tsconfig.json`, excluded from the bridge typecheck). |
| `test/*.test.ts` | `bun:test` suites. `test/helpers.ts` exports `selectById` for asserting on config options. |

## Prompt dispatch order (in `AcpAgent.prompt`)

1. Flatten content blocks into `promptText` + `images`; empty input → `end_turn`.
2. `parseCommandText(promptText)` — if it is a slash command:
   - **Built-in** (`/new`, `/tasks`, `/load`, `/compact`, `/smart-compact`,
     `/handoff`, alias `/hand-off`) → `runBuiltInCommandPrompt`: direct REST
     call, never streamed, always `end_turn`; compact/smart-compact/handoff
     require an existing `session.taskId` (the eager task from `newSession`
     counts). `/tasks` lists via `listTasks` (add-open first); `/load` resolves
     a task id or `#n` listing index.
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
  in `http.ts` as env-overridable constants (`JSON_TIMEOUT_MS` = 10s,
  `SSE_CONNECT_TIMEOUT_MS` = 30 min, via `AIDER_DESK_JSON_TIMEOUT_MS` /
  `AIDER_DESK_SSE_TIMEOUT_MS` parsed by `getTimeoutFromEnv` in `constants.ts`).
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
- **Context usage is published proactively too.** Besides the per-turn relay,
  `publishContextUsage` fires after `session/new` (deferred like the command
  advert), after `session/load` (seeded from the last stored `usageReport`), after
  `session/resume` (only when this process already saw a turn) and on
  `model`/`agent_profile`/`chat_mode` changes. It stays silent when the window is
  unknown (`maxInputTokens` absent, or a model the server no longer lists) — a
  `size: 0` update would only hide a client's indicator. `setConfigOption` has no
  `AgentContext` parameter, so the agent keeps the last one in `clientContext`.
- **A compaction moves `used` without a turn.** No usage report is produced while
  AiderDesk replaces the transcript, so `/compact`, `/smart-compact` and idle
  compaction estimate the figure from what survived: `estimateContextTokens`
  scales the compacted characters by the tokens-per-character ratio the last turn
  was billed at, and falls back to `0` when there is no ratio yet.
  `contextCharsOf` counts tool `response`/`args` too — they are most of what a
  long context weighs, so a `content`-only size would be off by an order of
  magnitude. `/new` and `/handoff` publish `0` outright. A compaction performed
  in the AiderDesk UI is still invisible to the bridge — the run-prompt SSE
  stream carries no tokens/context event and the bridge is idle while it
  happens — so the header keeps the last turn's figure until the next prompt.
- **Built-in commands cannot be shadowed** — they resolve before project
  custom/extension commands.
- **Custom command limitations**: `includeContext: false` and `skills` frontmatter
  are not surfaced by the REST API and are ignored; the expanded prompt always runs
  with the task's normal conversation context.
- **Extension commands never stream** (`/api/project/custom-commands` has no SSE
  stream); they are best-effort — failures only produce an `agent_thought_chunk` +
  stderr log, never an exception.
- **`session.taskId` is sticky and set eagerly** — `newSession` creates the task
  up front (`add-open` + `tasks/new`) and uses its id as the ACP session id; the
  thread-local `Map` key is therefore the server task id, so `session/list` and
  `session/load` work across bridge restarts. When eager creation fails, the
  bridge falls back to a generated `acp-` session id and learns `taskId` from
  the `x-task-id` header of the first `run-prompt` response (or `/new`).
  Reuse `session.taskId` for interrupt/compact/handoff.
- **SSE relay must respect aborts** — `relaySse` checks `abortController.signal`
  on every event and returns `cancelled`; `cancel()` also aborts the SSE stream and
  fires `POST /api/project/interrupt`.
- When adding a new AiderDesk endpoint that may wait on the model, give it a named
  helper in `http.ts` and pass `SSE_CONNECT_TIMEOUT_MS` (30 min) to `fetchJSON`, not
  the default 10s JSON timeout.
- **The SSE timeout bounds the whole turn, not just the connection.**
  `AbortSignal.timeout` is handed to `fetch`, so in Bun it also aborts an in-flight
  response body: a turn still streaming when the deadline fires dies as
  `TimeoutError: The operation timed out.`, which the ACP SDK reports to clients as
  `-32603 Internal error` with that string in `data.details`. Raise
  `AIDER_DESK_SSE_TIMEOUT_MS` for long-running agents; the AiderDesk server itself
  allows 30 minutes per provider response (`src/main/network-manager.ts`).

## Standing prompts, questions and replay (ACP clients without a UI)

An ACP client that owns the conversation (Raft, agent-shell) delivers its own
instructions and has no approval surface, which drives three behaviors:

- **Standing prompt → project rules file.** `_meta.systemPromptOverride` is
  written to `<project>/.aider-desk/rules/raft-standing-prompt.md`. AiderDesk
  injects `.aider-desk/rules/*.md` into the system prompt (`<Knowledge><Rules>`),
  so the text survives compaction and never sits in the conversation history.
  The write is idempotent and atomic; if it fails, `pendingStandingPrompt`
  prepends the text to the next prompt once (the `user_message_chunk` echo still
  carries only what the user typed). The marker records the owning session as
  `<pid>:<session id>`, and `clearStandingPrompt` only deletes a file no live
  session owns — a second bridge process on the same directory keeps its rules.
- **Questions must be answered.** AiderDesk blocks the turn on
  `task.askQuestion()` — there is no timeout — so an unanswered `ask-question`
  SSE event only ends when `AIDER_DESK_SSE_TIMEOUT_MS` fires. With
  `AIDER_DESK_ACP_AUTO_ANSWER` enabled the bridge answers through
  `POST /api/project/answer-question` (the question's default answer, then `y`;
  `AIDER_DESK_ACP_AUTO_ANSWER_MODE=always` additionally allows `a`/all, which the
  server remembers for the whole task), and reports the decision as an
  `agent_thought_chunk`. A question with no options needs free text, so it is
  declined with `n` instead of a meaningless `y`.
- **Do not replay a transcript the client already has.** `AIDER_DESK_ACP_REPLAY`
  is `full` (default, UI clients restoring a conversation), `tail` (last 20
  messages) or `off`. Raft's shim sets `off` because Raft replays its own
  transcript into the resumed session.

`session/load` and `session/resume` **throw** when the task no longer exists
(`Session not found: <session> (no AiderDesk task ...)`). ACP clients that own
recovery (Raft's Grok driver) pattern-match that into "start a fresh session";
returning an empty conversation instead would leave every later turn bound to a
ghost task. Existence is checked with `listTasksStrict`, not `loadTask`:
`POST /api/project/tasks/load` answers `{ messages: [] }` with status 200 for an
unknown id, so it cannot distinguish "missing" from "empty". The strict variant
matters as much as the check itself: a failed list request must surface as an
error the client can retry, never as "missing" — that would abandon a live
conversation on a transient server hiccup.

The session id → task id mapping matters because `/new` and `/handoff` swap the
underlying task while the ACP client keeps resuming by session id.

## Testing

- `bun test`. Suites live next to behavior: `agent.test.ts`, `commands.test.ts`,
  `context-usage.test.ts`, `http.test.ts`, `modes.test.ts`, `sse.test.ts`,
  `tools.test.ts`, `session-policy.test.ts`, `raft-policy.test.ts`.
- `agent.test.ts` points `AIDER_DESK_ACP_STATE_DIR` at a temp directory at import
  time, so session mappings never touch the real user state file. Keep that line
  when reordering imports.
- The agent tests use a `createMockRouter()` fetch mock (`routes` + recorded `calls`,
  assert with `callsMatching(regexp)`) and `mockContext()` for `cx.notify` capture.
  The router falls back to default `add-open` / `tasks/new` responses (task id
  `task-1`) for the session bootstrap, matched after explicit routes — override
  them when the task id matters. `test/helpers.ts` provides `selectById`.
- Unit-test the pure functions in `commands.ts` (parsing, substitution, shell
  expansion) directly; test the dispatch/relay behavior through `AcpAgent` with the
  mocked router and context, mirroring the real SSE event payloads.
- Before completing a change: `bun test` and `bun run typecheck` must both pass.
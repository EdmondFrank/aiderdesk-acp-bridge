# raft-shim

Connect AiderDesk to [Raft](https://raft.build) as a coding agent.

Raft only accepts its six built-in runtimes (`claude`, `codex`, `cursor`, `grok`,
`opencode`, `pi`) and rejects anything else with `400 Bad Request` in
`runtimeAdmissionService`. But its **Grok Build** driver
(`packages/daemon/src/drivers/grok.ts`) is plain ACP over stdio:

* probe: `grok --version`, `grok agent stdio --help`
* session: spawn `grok agent --no-leader --always-approve stdio`
* protocol: `initialize` → `session/new|load` → `session/prompt`

`aiderdesk.ts` is a thin proxy between that driver and
[`aiderdesk-acp-bridge`](../src) (the ACP server that already exists here). It
only translates the four Grok-specific bits Raft relies on, so neither Raft nor
the bridge needs to change.

`~/.local/bin/grok` is a **symlink** to `~/.local/bin/aiderdesk`: the name
`grok` is unavoidable because the lookup string is hardcoded in the client. The
implementation lives in `aiderdesk.ts`.

## Install

```sh
./raft-shim/install.sh           # writes ~/.local/bin/aiderdesk + grok symlink

aiderdesk --version
aiderdesk agent stdio --help   # Raft's probe: must exit 0
```

`~/.local/bin` must be on the login-shell `PATH` — Raft Computer captures your
shell environment (`zsh -ilc __print-env`) when it starts, so restart it once
after installing:

```sh
raft-computer restart /<server-slug>   # slug = the part after /s/ in the URL
```

## Use in Raft

Set these before starting Raft Computer if the defaults do not fit:

| Variable | Default | Effect |
| --- | --- | --- |
| `AIDER_DESK_PORT` | `23456` | AiderDesk server port |
| `AIDER_DESK_SHIM_AUTONOMY` | `autonomous` | Session `autonomy_mode` applied after `session/new` |
| `AIDER_DESK_ACP_AUTO_ANSWER` | `1` (set by the shim) | Answer AiderDesk questions on Raft's behalf |
| `AIDER_DESK_ACP_AUTO_ANSWER_MODE` | `once` | `once` answers each question once; `always` may pick `a`/all, which the server remembers for the whole task |
| `AIDER_DESK_ACP_REPLAY` | `off` (set by the shim) | `session/load` replay: `full`, `tail`, `off` |
| `AIDER_DESK_ACP_STATE_DIR` | `~/.local/state/aiderdesk-acp` | Session-id → task-id map |

`autonomous` is deliberate: Raft has no approval surface, so a `guided` session
would wait on a plan approval nobody can see. The Grok launch Raft uses is
`--always-approve`, so this matches it.

`AIDER_DESK_ACP_AUTO_ANSWER=1` closes the remaining blocking path: AiderDesk
waits on `task.askQuestion()` without a timeout, so a question raised mid-turn
would otherwise hang until the bridge's SSE deadline (30 min). The bridge answers
with the question's default answer (or `y`) and posts the decision as an
`agent_thought_chunk`.

It does **not** submit `a`/all by default: the server remembers that answer for
the rest of the task, so one approval would silently become a standing one. Set
`AIDER_DESK_ACP_AUTO_ANSWER_MODE=always` if the agent should batch approvals. A
question that needs free text (no options) is declined with `n` — this API
cannot carry text, and a truthful decline ends the turn the same way a fake
`y` would.

`AIDER_DESK_ACP_REPLAY=off` avoids replaying AiderDesk's transcript into a
resumed session: Raft already renders its own conversation, and the two
transcripts are not the same thing.

1. Create an agent (`+` in the agents sidebar) and pick runtime **Grok Build**.
2. The model list is every entry from AiderDesk's `GET /api/models`, plus
   `AiderDesk default`, which leaves the task/profile model untouched. Picking a
   real entry persists `provider/model` onto the AiderDesk task.
3. The AiderDesk server must be running (`AIDER_DESK_PORT`, default `23456`);
   the bridge exits immediately when `/api/health` is not `ok`.

## Where the standing prompt goes

Raft's standing prompt (~29 KB) arrives in `_meta.systemPromptOverride` on
`session/new` and `session/load`. The shim appends a short ACP runtime note (no
approval UI, no `raft` CLI, replies are delivered automatically) and forwards it
unchanged.

The bridge then writes it to `<agent dir>/.aider-desk/rules/raft-standing-prompt.md`.
AiderDesk injects `.aider-desk/rules/*.md` into the system prompt as
`<Knowledge><Rules>`, so Raft's prompt:

* is part of the system prompt, not a ~29 KB user message in the history;
* survives compaction (compaction keeps the system prompt);
* keeps the prompt cache warm — the write is idempotent, so an unchanged prompt
  on a resume does not touch the file at all.

If the file cannot be written, the bridge falls back to prepending the prompt to
the next `session/prompt`, and the shim's runtime note still marks the transport.

No server capability is involved, so no rebuilt server is needed: this works
against a stock AiderDesk.

## What it translates

| Raft (Grok driver) | Shim | Bridge (ACP v1) |
| --- | --- | --- |
| expects models in `initialize` → `_meta.modelState` | injects `modelState` from `/api/models` | only returns `configOptions` on `session/new` |
| `session/set_model` (private draft method) | rewritten | `session/set_config_option { configId: "model" }` |
| `session/new._meta.systemPromptOverride` (standing prompt) | appends the ACP runtime note and forwards it | written to `<cwd>/.aider-desk/rules/raft-standing-prompt.md` → system prompt |
| `_x.ai/interject` / `session/steer` while a turn runs | acked immediately, queued, replayed as the next `session/prompt` with a "sent while you were working" prefix | no mid-turn injection |

Everything else (`initialize`, `session/load`, `session/prompt`, `session/cancel`,
`session/update` notifications, child→client requests) is passed through
unchanged. `session/request_permission` is never sent by the bridge: permissions
follow AiderDesk's own `autonomy_mode` config option.

`session/load` for a task that no longer exists fails with
`Session not found: <session> (no AiderDesk task ...)`, and Raft's Grok driver
matches that into `resume_or_fresh`, so the agent starts a new session instead of
talking to a task that is gone.

The shim contributes one piece of that: ACP reports a handler's thrown error as
`Internal error` and moves the text into `error.data.details`, which Raft's
`isMissingSessionError` does not read. On a failed `session/load` the shim lifts
the details back into `error.message` so the driver can recognise it by its
message (Raft matches on `code` *or* a `… not found` message, and the message is
the one the bridge controls). Only errors whose text actually says the session
is missing are rewritten, so a failed task-list request stays an error instead
of turning into "start a fresh session".

## Keeping the context small

A Raft agent keeps one AiderDesk task for its entire lifetime. Raft's wake
recycle (RFC 070) only reads a runtime transcript for the `claude` runtime, so an
AiderDesk-backed agent is never recycled — compaction is the only backstop in
the server, and it is expensive.

`raft-policy/` is a small AiderDesk extension that elides stale tool results
before each request. One measured agent had ~1 MB of `context.json` after two
days, with tool results the largest share; AiderDesk truncates a result when it
is produced but never shrinks it afterwards.

* The last `AIDERDESK_RAFT_KEEP_TOOL_RESULTS` results (default 8) are untouched.
* Older results longer than `AIDERDESK_RAFT_TOOL_RESULT_MAX_CHARS` (default 4000)
  are cut to that head plus a note saying the tool can be re-run.
* Once the retained characters exceed `AIDERDESK_RAFT_TOOL_RESULT_BUDGET_CHARS`
  (default 120000), older results are cut harder (400 characters).
* The outputs AiderDesk actually produces are the AI SDK `content` variant — a
  list of `text` and `file` parts — so only the `text` parts are cut and a
  `file` (image) part is kept untouched. Plain `text`/`error-text` outputs are
  handled too; `json` and `execution-denied` are never rewritten.
* Copies are copy-on-write, the pass is idempotent (a second run over the same
  context elides nothing), so the prompt-cache prefix stays valid, and a cut
  that would save less than 500 characters is skipped.

It applies only to projects under `~/.raft/agents/`, so an ordinary AiderDesk
project keeps its full history. `AIDERDESK_RAFT_POLICY=0` disables it,
`AIDERDESK_RAFT_POLICY=1` enables it everywhere.

`install.sh` copies it to `~/.aider-desk/extensions/raft-policy/`. AiderDesk
watches that directory, so a running server loads it without a restart — check
with `curl -s localhost:23456/api/extensions` for an entry with `id: raft-policy`
and `initialized: true`.

## Verify without Raft

```sh
bun raft-shim/selftest.ts             # initialize + session/new + set_model + prompt
bun raft-shim/selftest.ts --interject # also queue an _x.ai/interject mid-turn
bun raft-shim/raw-shim-test.ts        # dump every JSON-RPC line through the shim
bun raft-shim/raw-bridge-test.ts      # same, straight to the bridge (bisect)
```

## Debug

```sh
AIDER_DESK_SHIM_DEBUG=1 aiderdesk agent --no-leader --always-approve stdio
```

Logs every forwarded/rewritten message on stderr (Raft ignores agent stderr).

## Limits

* Coupled to `grok.ts`: if a Raft release changes the ACP method names above,
  the shim needs the same change. It is a workaround until Raft ships a custom
  ACP runtime slot.
* Installing the real Grok CLI later would clash with the `grok` symlink.
* Mid-turn messages are queued, not injected into the running turn — the bridge
  has no steering API.
* Each Raft model-detection run spawns one shim + bridge (it queries
  `/api/models` and exits).
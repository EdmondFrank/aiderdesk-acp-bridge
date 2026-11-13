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
| `AIDER_DESK_ACP_START_WAIT_MS` | `90000` | How long the bridge waits for AiderDesk's REST server before giving up |
| `AIDER_DESK_ACP_DEDUPE_STANDING_PROMPT` | `1` | Drop the duplicate copy of the standing prompt Raft sends as the first message |
| `AIDER_DESK_ACP_IDLE_COMPACT_TOKENS` | `120000` | Compact a session that goes quiet above this context size (`0` disables) |
| `AIDER_DESK_ACP_IDLE_COMPACT_DELAY_MS` | `180000` | How long the session must stay quiet first |
| `AIDERDESK_RAFT_ELIDE_AFTER_IDLE_MS` | `1800000` | A gap this long starts a new wake, where eliding is free |
| `AIDERDESK_RAFT_TOOL_RESULT_CEILING_CHARS` | `400000` | Tool results above this size force a mid-wake elision pass |
| `AIDERDESK_RAFT_ELIDE_PENDING_CHARS` | `160000` | Undecided stale tool results that justify one mid-wake pass |

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
| the first `session/prompt` repeats that whole standing prompt | — | replaced by a note plus the last ~3 KB of it, since the rules file already carries the text (~10k tokens saved, kept for every later wake) |
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

`raft-policy/` is a small AiderDesk extension that elides stale tool results.
One measured agent had ~1 MB of `context.json` after two days, with tool results
the largest share; AiderDesk truncates a result when it is produced but never
shrinks it afterwards.

### Why it elides on wake, not on every request

The provider caches a request prefix, so a turn costs what that prefix does
*not* cover. Rewriting an old message invalidates everything after it — which
makes "always send the best elision" one of the most expensive things this
extension can do. Measured on one 14-day agent (3778 turns, $46 lifetime):

| behaviour | re-billed tokens | share of spend |
| --- | --- | --- |
| recompute the elision every turn | 2633k over 140 turns | **30%** ($13.61, 330 turns) |
| decide once, never re-cut (ratchet only) | 1228k | — |
| decide once per wake, replay verbatim | **210k** (≈ the appended messages) | ~0 |

So the extension works in passes, each one reported at `info` as
`pass (<reason>, idle <n>m): decided N, tool results A -> B, pending C -> D`:

| reason | when |
| --- | --- |
| `first` | first dispatch of the process with more results than `keepRecent` |
| `wake` | `AIDERDESK_RAFT_ELIDE_AFTER_IDLE_MS` (default 30 min) since the last dispatch |
| `ceiling` | tool results already exceed `AIDERDESK_RAFT_TOOL_RESULT_CEILING_CHARS` |
| `growth` | stale undecided results exceed `AIDERDESK_RAFT_ELIDE_PENDING_CHARS` |

`first` exists because of a measured failure: a Raft agent that wakes every few
minutes never sees a 30-minute gap, and any small dispatch (a title request, a
summary) refreshes the idle clock — so a wake-only rule can go a whole process
lifetime without cutting once. Only results a pass could actually cut count to
`growth`, so a context full of short results does not keep triggering passes.

* A gap of `AIDERDESK_RAFT_ELIDE_AFTER_IDLE_MS` (default 30 min) starts a new
  wake. That is usually the cheapest moment for a cut, but not the only one:
  the provider keeps a cache far longer than that (a 42k prefix was still
  cached after an 88-minute gap), which is why the per-turn price is set by how
  much of the prefix is uncached, not by gap length alone.
* At wake start, results older than the last `AIDERDESK_RAFT_KEEP_TOOL_RESULTS`
  (default 8) are cut **once**, to a head (default 4000 chars) plus a note
  saying the tool can be re-run; a cut that would save less than 500 characters
  is skipped.
* Each decision is recorded against the `toolCallId`. A result that has a
  decision is never re-decided, so its text is byte-identical for the rest of
  the wake and the cached prefix stays valid. This is what the earlier
  "idempotent" claim was missing: the pass was idempotent per call, but the
  retained-character budget moved between turns and re-cut results near the
  start of the conversation.
* During the rest of the wake only the recorded decisions are replayed; new
  results stay whole until the next wake decides about them.
* `AIDERDESK_RAFT_TOOL_RESULT_CEILING_CHARS` (default 400k) is the safety valve:
  past that size the extension decides mid-wake rather than let the request grow,
  accepting one cache break.

Copies are copy-on-write and `json`/`execution-denied` outputs are never
rewritten; only the `text` parts of the `content` shape are cut, so an image
part inside a result survives. It applies only to projects under
`~/.raft/agents/`, so an ordinary AiderDesk project keeps its full history.
### The cut has to be written back in place

`onOptimizeMessages` may return a new `optimizedMessages` array, and the AiderDesk
source does read it — but the running server (`out/server/store-*.js`) drops that
array: the identical cut changed the billed prompt by nothing. Measured A/B on one
live session:

| return path | prompt tokens |
| --- | --- |
| return a fresh array | 133,720 -> 143,351 (unchanged, cache intact) |
| write the same cut onto the host's own message objects | 133,720 -> 95,924 (**-28%**, cache busted) |

The char reduction and the token reduction matched to within 0.3%, so the
extension does both: it copies each cut `content` back onto the message objects
the hook received, then returns the same array. Mutating is safe because the host
passes a deep clone of its context, never the stored messages — `context.json`
stays unelided and re-reading a file still returns the full output.

`AIDERDESK_RAFT_POLICY=0` disables it, `AIDERDESK_RAFT_POLICY=1` enables it
everywhere.

`install.sh` copies it to `~/.aider-desk/extensions/raft-policy-<version>/`. The
loader keeps one `jiti` instance per extension directory and never invalidates
it (`extension-loader.ts:27`), so editing files in place does nothing until a
restart. Replacing files in a directory that was already loaded is worse: the
entry file is re-read while the cached `./policy` module is kept, so the
extension falls back to an early policy that elides nothing and only logs
`loaded: policy module is stale after a hot reload`. That failure mode looked
exactly like "elision does not work" and cost a long hunt.

A **new directory** *is* picked up by the directory watcher without a restart,
so `install.sh` derives the directory from the extension version and removes the
older copy (two copies would elide twice). Bump `version` in
`raft-policy/index.ts` to land on a fresh path; the `onLoad` line says which
module graph is actually running. Check with
`curl -s localhost:23456/api/extensions` for an entry with `initialized: true`.

### Compacting while idle instead of during work

The bridge compacts a session that has gone quiet: when a turn ends above
`AIDER_DESK_ACP_IDLE_COMPACT_TOKENS` (default 120k, the size of the last prompt
including the cached prefix) it schedules a `smart-compact` in
`AIDER_DESK_ACP_IDLE_COMPACT_DELAY_MS` (default 3 min). A new prompt cancels the
pending compaction, so an active burst is never compacted mid-way — that would
throw away a cache that is still warm. The point is the next wake: the provider
cache expires between wakes, and every wake then pays for the whole context at
input price.

AiderDesk's `smart-compact` only rewrites results of its own `power` tools —
`compactBashOutputs`, `removeStaleFileReads`, … are all gated on
`isPowerTool(serverName)`. A Raft agent runs on MCP tools instead: one measured
session carried 325 KB of tool results and **0 bytes** from `power---`
(`lua---code_mode` 56%, `desktop---execute_command` 41%). The call answers 200 and
changes nothing, and the last message in such a context is then the previous
assistant reply, not a summary — so the bridge used to announce "the conversation
was replaced by this summary: <last reply>", which is false. It now reads the
context before and after and only reports a compaction that shrank by at least 2%
(`src/compaction-report.ts`); a measured no-op goes to stderr and disables idle
compaction for that task instead of retrying on every wake.

The summary call itself is billed like one more cold start, so this pays off
only if the agent wakes again — the second wake then reads the summary instead
of the whole transcript. Raise the threshold (or set it to `0`) for agents that
are woken once and then left alone. A prompt that arrives while the debounce
already fired waits for that one call rather than racing it; a deleted session
cancels it.

## Verify without Raft

```sh
bun raft-shim/selftest.ts             # initialize + session/new + set_model + prompt
bun raft-shim/selftest.ts --interject # also queue an _x.ai/interject mid-turn
bun raft-shim/raw-shim-test.ts        # dump every JSON-RPC line through the shim
bun raft-shim/raw-bridge-test.ts      # same, straight to the bridge (bisect)
bun raft-shim/measure-policy.ts <context.json>  # replay elision on a real task, no model call
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
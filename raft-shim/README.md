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

1. Create an agent (`+` in the agents sidebar) and pick runtime **Grok Build**.
2. The model list is AiderDesk's `GET /api/models`. `AiderDesk default` leaves
   the task/profile model untouched; picking a real entry persists
   `provider/model` onto the AiderDesk task.
3. The AiderDesk server must be running (`AIDER_DESK_PORT`, default `23456`);
   the bridge exits immediately when `/api/health` is not `ok`.

## What it translates

| Raft (Grok driver) | Shim | Bridge (ACP v1) |
| --- | --- | --- |
| expects models in `initialize` → `_meta.modelState` | injects `modelState` from `/api/models` | only returns `configOptions` on `session/new` |
| `session/set_model` (private draft method) | rewritten | `session/set_config_option { configId: "model" }` |
| `session/new._meta.systemPromptOverride` (standing prompt) | cached, prepended as a text block to the first prompt | ignores `_meta` |
| `_x.ai/interject` / `session/steer` while a turn runs | acked immediately, queued, replayed as the next `session/prompt` | no mid-turn injection |

Everything else (`initialize`, `session/load`, `session/prompt`, `session/cancel`,
`session/update` notifications, child→client requests) is passed through
unchanged. `session/request_permission` is never sent by the bridge: permissions
follow AiderDesk's own `autonomy_mode` config option.

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
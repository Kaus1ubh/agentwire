# agentwire

[![npm](https://img.shields.io/npm/v/agentwire-cli)](https://www.npmjs.com/package/agentwire-cli)
[![tests](https://github.com/Kaus1ubh/agentwire/actions/workflows/test.yml/badge.svg)](https://github.com/Kaus1ubh/agentwire/actions/workflows/test.yml)
[![node](https://img.shields.io/node/v/agentwire-cli)](https://nodejs.org)
[![license](https://img.shields.io/npm/l/agentwire-cli)](https://github.com/Kaus1ubh/agentwire/blob/main/LICENSE)

Send a message from one coding-agent session to another on the same machine: Claude Code,
Codex, Antigravity and Cursor, including chats already open in their desktop apps.

```bash
npx agentwire-cli list                                  # sessions from every agent, newest first
npx agentwire-cli send codex 01a16345-... "tests pass on main; the plan is in docs/plan.md"
npx agentwire-cli start claude "review docs/plan.md and list the risks" --cwd ~/code/app
```

<!-- github-only -->
A Claude Code session sent `"FYI: the nightly build on main passed"` to an Antigravity chat and a
Cursor chat. Each mentioned it at its user's next, unrelated prompt:

![An Antigravity chat names the sending Claude session and quotes its message, then answers](https://raw.githubusercontent.com/Kaus1ubh/agentwire/main/docs/antigravity-receives.png)

![A Cursor chat mentions the other session's message, then answers](https://raw.githubusercontent.com/Kaus1ubh/agentwire/main/docs/cursor-receives.png)
<!-- /github-only -->

One JavaScript file, no dependencies. Needs Node 22.13 or newer. `npm i -g agentwire-cli`
installs the command as `agentwire`.

## Setup

```bash
npx agentwire-cli install            # the agentwire skill, for every agent installed here
npx agentwire-cli install --hooks    # also the hooks that deliver to busy sessions and app chats
```

The skill alone also installs through [skills](https://skills.sh), for any agent it supports:
`npx skills add Kaus1ubh/agentwire`. The hooks still come from `install --hooks`.

Without hooks, `send` still reaches idle sessions and Codex. `install --hooks` writes into each
agent's user settings and keeps a backup beside every file it changes. `--project DIR` writes a
project's settings instead, and `npx agentwire-cli uninstall` removes only what agentwire added.

## Sending to an existing session

`send` delivers as soon as the receiver can take it:

- **An idle session** answers right away, and its reply prints in your terminal.
- **A busy session, or a chat in an editor or app,** reads the message at its next step: its next
  tool call, its next model call, or the user's next prompt in that chat. The message does not
  make it start any work. The receiver tells the user in one line that a message arrived.
- **`--wake`** also lets a busy session act on the message when its current turn ends, without
  the user. Use it only when that is what the user wants.

| Agent | Chat in the desktop app or editor | CLI session |
|---|---|---|
| Claude Code | delivered at its next step, or with the user's next prompt when idle | idle: runs a turn; busy: at its next step |
| Codex | idle or busy: delivered by `codex queue` | `codex exec resume`, as long as no terminal has it open |
| Antigravity | delivered at its next step, or with the user's next prompt when idle | idle: runs a turn; busy: at its next step |
| Cursor | delivered at its next step, or with the user's next prompt when idle | idle: runs a turn; busy: not reached, because the Cursor CLI runs no hooks headless |

No app here lets an outside program start a turn in an idle chat, except Codex. A message for an
idle Cursor or Antigravity chat waits for the user's next prompt there.

## Starting a new session

`start` opens a new session with your message as its first prompt and prints the session's ID,
so `send` can reach it later. It runs headless through the agent's CLI, with that CLI's usual
permission rules.

| Agent | Visible in the desktop app or editor | Visible in a terminal |
|---|---|---|
| Claude Code | no | `claude --resume <id>` |
| Codex | no | `codex resume <id>` |
| Antigravity | no | `agy --conversation <id>` |
| Cursor | with `--open`: Cursor shows the prompt for approval, then opens it in a new chat of its current project for you to send | `cursor-agent --resume <id>` |

## How each route was tested

Every cell above comes from a live run on Windows 11 in October 2026: a message carrying a
unique token, sent to a real session, with the reply and the session's own transcript checked.
The cases that fail quietly are refused by name:

- Resuming a Claude session in the middle of a turn creates a copy of it. `send` checks for a
  transcript written in the last 30 seconds and queues the message instead.
- Resuming a Cursor editor chat from the CLI starts an empty chat under the same ID, and the
  editor never shows it. `send` recognises editor chats and queues for the hook.
- The Antigravity CLI cannot open app conversations. `send` queues for the hook.
- A Codex thread started from a terminal never appears in the desktop app.

## Security

A queued message is text placed in another agent's context. Anything running as your user can
write to `~/.agentwire/inbox`, and that includes an agent that read a malicious web page and was
talked into calling `agentwire send`. agentwire narrows what such a message can do. It cannot
stop the message from arriving.

- Messages are labelled as coming from another agent session, not from the user, and as
  carrying no approval. Receivers are told to ask the user before anything that needs consent.
- A message only adds context. It cannot make an agent start work unless the sender passed
  `--wake`, and the `SKILL.md` that agents read forbids `--wake` for anything the user did not ask
  for.
- The receiver tells the user that a message arrived, and every delivery is logged in
  `~/.agentwire/deliveries.log` with its sender, session and size.
- Messages over 16 KB are refused, and a session with 20 messages waiting accepts no more.
- Antigravity gets messages as ephemeral steps, its weakest injection channel, rather than as
  system messages.
- The sender's name is whatever the sender claims. No local process can prove its identity to
  another one running as the same user.

## Commands

```
agentwire list [--agent claude|codex|agy|cursor] [--cwd DIR] [--limit N]
agentwire send AGENT SESSION_ID MESSAGE [--wake] [--from AGENT:ID]
agentwire start AGENT MESSAGE [--cwd DIR] [--open]
agentwire whoami
agentwire install [--hooks] [--project DIR] [--dry-run]
agentwire uninstall [--project DIR] [--dry-run]
```

## License

MIT

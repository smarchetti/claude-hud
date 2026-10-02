# hud

A heads-up display for your [Claude Code](https://claude.com/claude-code) session: a side
pane with everything about the run at a glance. Type `/hud` to open it, and `/hud` again to
close it.

```
DETAILS
 model    Opus 5.5 · 󰓅 high
 cost     $3.46
 account  ada · personal
 version  v2.1.287
 host     workstation

USAGE
󰍛 context  ▄▄▄▄▄▄▄▄▄▄  42% ▃▄▄  116k left
 session  ▄▄▄▄▄▄▄▄▄▄  92% ▆▇▇     1h 50m
󰅐 weekly   ▄▄▄▄▄▄▄▄▄▄  55% ▄▅▅      1d 2h

CONTEXT                        84k / 200k
System prompt                 3.1k    2%
Messages                       57k   29%
Free space                    116k   58%

MCP SERVERS                         2 / 5
●  linear                         2
○  neon                           –
○ not connected · /mcp to sign in

WORKSPACE                        acme/app
 folder   ~/work/app
 branch   feat +1 ~1 ?1 ↑2 · worktree

HOOKS                            2 events
󰛢 SessionStart              session-start.sh 
󰛢 Stop                          stop.sh  
```

## What it shows

| Section | What's in it | From |
| --- | --- | --- |
| Details | Model and effort, session cost, account, Claude Code version, host | The session; `~/.claude.json`; your settings; `hostname` |
| Usage | Context, 5-hour and weekly limits: one line each, with a bar, a short trend and time to reset | The session's usage |
| Context | Each `/context` category's tokens and share of the window | The session's context breakdown (a local estimate, no API calls) |
| MCP servers | Connected servers with their tool counts, then configured ones that aren't connected, each with an icon for where it's configured | The session's tool list; server names from `~/.claude.json` and `.mcp.json` |
| Workspace | Folder, branch, staged / modified / untracked / ahead / behind, worktree, repo | `git` |
| Hooks | Each hook event, what runs on it, and where it's configured | Your user, project and local `settings.json` |

It refreshes every 30 seconds, and from the pane's Refresh button. It reads only names
from the config files, never their contents: an MCP server's entry can hold a token in its
headers, and the pane never sees it. It doesn't read `~/.claude/.credentials.json` either,
so a personal account shows as `personal` rather than its plan.

The icons are [Nerd Font](https://www.nerdfonts.com) glyphs, so the terminal needs a Nerd
Font. The colors are Dracula's.

## Install

It's a Claude Code plugin whose hooks are a TypeScript module, so Claude Code loads it from
a folder:

```bash
git clone https://github.com/smarchetti/claude-hud ~/.claude/plugins-local/claude-hud
```

Then add the folder to `CLAUDE_CODE_PLUGIN_DIRS` in `~/.claude/settings.json`, so every
session loads it, the desktop app's included:

```json
{ "env": { "CLAUDE_CODE_PLUGIN_DIRS": "~/.claude/plugins-local/claude-hud" } }
```

Or load it for one session with `claude --plugin-dir ~/.claude/plugins-local/claude-hud`.
The repo is also laid out as a plugin marketplace (`/plugin marketplace add
smarchetti/claude-hud`, then `/plugin install hud@hud`),
but that route hasn't been tested with a hooks module like this one.

## Develop

```bash
claude plugin validate .   # what the module hooks and calls, and anything the engine would refuse
claude plugin test .       # tests/*.test.ts against the engine, on the terminal and desktop surfaces
tsc -p .                   # after one load has written .claude-plugin/types/
```

In a session that loads the folder, saving a file reloads the pane.

## License

MIT

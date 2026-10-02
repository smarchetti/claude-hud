// What the HUD draws from: read on /hud, on each prompt, every 30 seconds
// while the session runs, and from the pane's Refresh button, one section each.

export type McpServerRow = {
  /** The server's name as /mcp lists it. */
  name: string
  /** Where it's configured: user, local, project; account (claude.ai) or plugin when no config file has it. */
  scope: string
  /** Tools the model can call from it; 0 means configured but not connected. */
  tools: number
}

/** One /context category, as it fills the window. */
export type ContextRow = {
  name: string
  tokens: number
  /** `free`: the window left. */
  isFree: boolean
}

export type ContextSummary = {
  /** Tokens in the window now, and the window they count against. */
  used: number
  max: number
  /** used over max, 0 to 100. */
  percent: number
  rows: ContextRow[]
}

/** A rate-limit window: the 5-hour session or the weekly. */
export type LimitRow = {
  kind: string
  percent: number
  /** When it resets, in milliseconds since the epoch. */
  resetsAt?: number
}

export type ModelSummary = {
  /** As the status line shows it: `Opus 5.5`. */
  name: string
  /** The effort level from settings, if one is set. */
  effort?: string
  /** What the session has cost, in US dollars. */
  costUsd?: number
}

export type AccountSummary = {
  /** The part of the email before the @. */
  user?: string
  /** The organization, or `personal` for a personal account. */
  org?: string
  version?: string
}

export type WorkspaceSummary = {
  /** The working folder, with the home folder as ~. */
  folder: string
  host?: string
  branch?: string
  ahead: number
  behind: number
  staged: number
  modified: number
  untracked: number
  isWorktree: boolean
  /** owner/name from the remote, when there is one. */
  repo?: string
}

/** One hook event and what runs on it, from the settings files. */
export type HookRow = {
  event: string
  /** Where it's configured: user, project, local; several when more than one file adds to it. */
  scopes: string[]
  /** What runs, by a short name: `orca` for Orca's, a script's file name, `prompt` or `agent`. */
  handlers: string[]
}

export type Snapshot = {
  model?: ModelSummary
  account?: AccountSummary
  limits: LimitRow[]
  context?: ContextSummary
  servers: McpServerRow[]
  workspace?: WorkspaceSummary
  hooks: HookRow[]
  /** The last readings, oldest first, for the sparklines: `context` and each limit's kind. */
  history: Record<string, number[]>
  /** When it was read, in milliseconds since the epoch. */
  refreshedAt: number
  /** Why the last refresh failed, if it did. */
  error?: string
}

declare module 'claude-code' {
  interface PluginState {
    'hud': {
      snapshot: Snapshot
    }
  }
}

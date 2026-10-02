import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type {
  AccountSummary,
  ContextSummary,
  HookRow,
  LimitRow,
  McpServerRow,
  ModelSummary,
  Snapshot,
  WorkspaceSummary,
} from '../types'

const PANE = 'hud'
const REFRESH_MS = 30_000
const HISTORY = 24
const BAR_WIDTH = 10
const SPARK_WIDTH = 6
const SPARKS = '▁▂▃▄▅▆▇█'
const empty: Snapshot = { limits: [], servers: [], hooks: [], history: {}, refreshedAt: 0 }
const snapshot = atom({ plugin: 'hud', key: 'snapshot' } as const, empty)

// The Dracula palette, the same one a Dracula-themed status line draws in.
const color = {
  fg: '#F8F8F2',
  comment: '#6272A4',
  green: '#50FA7B',
  orange: '#FFB86C',
  cyan: '#8BE9FD',
  purple: '#BD93F9',
  pink: '#FF79C6',
  red: '#FF5555',
  barBG: '#44475A',
}

const limitLabel: Record<string, string> = { five_hour: 'session', seven_day: 'weekly' }

// Nerd Font icons (https://www.nerdfonts.com): the terminal needs a Nerd Font to draw them.
const icon = {
  model: '\uF2DB', // nf-fa-microchip
  effort: '\u{F04C5}', // nf-md-speedometer
  cost: '\uF155', // nf-fa-usd
  account: '\uF007', // nf-fa-user
  version: '\uF02B', // nf-fa-tag
  host: '\uF108', // nf-fa-desktop
  context: '\u{F035B}', // nf-md-memory
  session: '\uF252', // nf-fa-hourglass_half
  weekly: '\u{F0150}', // nf-md-clock_outline
  folder: '\uF115', // nf-fa-folder_open
  branch: '\uE725', // nf-dev-git_branch
  tools: '\uF0AD', // nf-fa-wrench
  hook: '\u{F06E2}', // nf-md-hook
}

// Where a server or hook is configured, as an icon.
const scopeIcon: Record<string, string> = {
  user: '\uF007', // nf-fa-user: ~/.claude.json, ~/.claude/settings.json
  project: '\uF115', // nf-fa-folder_open: the repo's .mcp.json, .claude/settings.json
  local: '\uF109', // nf-fa-laptop: yours, in this project only
  plugin: '\uF12E', // nf-fa-puzzle_piece
  account: '\uF0C2', // nf-fa-cloud: claude.ai connectors
}

// 84123 -> "84k", 3100 -> "3.1k", like /context.
function short(n: number) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 10_000) return `${Math.round(n / 1000)}k`
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`
  return String(n)
}

function fillColor(percent: number) {
  if (percent >= 85) return color.red
  if (percent >= 60) return color.orange
  return color.green
}

// "1h 50m", "1d 2h", "12m": the time left until `at`.
function until(at: number, now: number) {
  const minutes = Math.max(0, Math.round((at - now) / 60_000))
  if (minutes >= 24 * 60) return `${Math.floor(minutes / 1440)}d ${Math.floor((minutes % 1440) / 60)}h`
  if (minutes >= 60) return `${Math.floor(minutes / 60)}h ${minutes % 60}m`
  return `${minutes}m`
}

function sparkline(values: number[] = []) {
  return values.slice(-SPARK_WIDTH).map(v => SPARKS[Math.min(7, Math.max(0, Math.round((v / 100) * 7)))]).join('')
}

// claude-opus-5-5 -> "Opus 5.5"; anything else as given.
function modelName(id: string) {
  const m = /^claude-([a-z]+)-(\d+)(?:-(\d+))?/.exec(id)
  if (!m?.[1]) return id
  const family = m[1].charAt(0).toUpperCase() + m[1].slice(1)
  return m[3] ? `${family} ${m[2]}.${m[3]}` : `${family} ${m[2]}`
}

type Json = Record<string, unknown>

async function readJson($: EngineInterface, path: string): Promise<Json | null> {
  try {
    return JSON.parse(await $.fs.read(path)) as Json
  } catch {
    return null
  }
}

async function run($: EngineInterface, argv: string[], cwd?: string) {
  try {
    const result = await $.process.run(argv, { cwd, timeoutMs: 3000 })
    return result.exitCode === 0 ? result.stdout.trim() : ''
  } catch {
    return ''
  }
}

// MCP server names from the config files, by scope. Only the keys: never the
// entries, which can hold tokens in their headers or env.
function configuredServers(user: Json | null, project: Json | null, root: string) {
  const keys = (v: unknown) => Object.keys((v as Json | undefined) ?? {})
  const projects = (user?.projects ?? {}) as Record<string, Json | undefined>
  const scopes = new Map<string, string>()
  for (const name of keys(user?.mcpServers)) scopes.set(name, 'user')
  for (const name of keys(projects[root]?.mcpServers)) scopes.set(name, 'local')
  for (const name of keys(project?.mcpServers)) scopes.set(name, 'project')
  return scopes
}

// The account as the status line names it: the email's user part, and the
// organization, or "personal" for an auto-named personal one. The plan
// ("Max") lives beside the login tokens in .credentials.json, which this
// leaves unread.
function accountFrom(user: Json | null, version: string): AccountSummary {
  const oauth = (user?.oauthAccount ?? {}) as Json
  const email = typeof oauth.emailAddress === 'string' ? oauth.emailAddress : ''
  let org = typeof oauth.organizationName === 'string' ? oauth.organizationName : ''
  if (/'s organization$/i.test(org.replace('’', "'"))) org = 'personal'
  return { user: email.split('@')[0] || undefined, org: org || undefined, version }
}

// Hook events and what runs on them, from the three settings files. A
// handler is named by its owner: Orca's commands as `orca`, a script by its
// file name, prompt and agent hooks by their type.
function handlerName(hook: Json) {
  if (hook.type === 'prompt' || hook.type === 'agent') return hook.type
  const command = typeof hook.command === 'string' ? hook.command : ''
  if (command.includes('ORCA_')) return 'orca'
  const script = /([\w.-]+\.(?:sh|py|js|mjs|ts|rb))\b/.exec(command)
  if (script?.[1]) return script[1]
  return command.trim().split(/\s+/)[0]?.split('/').pop() ?? 'command'
}

function hooksFrom(files: [string, Json | null][]): HookRow[] {
  const rows = new Map<string, HookRow>()
  for (const [scope, settings] of files) {
    const events = (settings?.hooks ?? {}) as Record<string, { hooks?: Json[] }[] | undefined>
    for (const [event, groups] of Object.entries(events)) {
      const row = rows.get(event) ?? { event, scopes: [], handlers: [] }
      for (const group of groups ?? []) {
        for (const hook of group.hooks ?? []) {
          const name = handlerName(hook)
          if (!row.handlers.includes(name)) row.handlers.push(name)
          if (!row.scopes.includes(scope)) row.scopes.push(scope)
        }
      }
      if (row.handlers.length) rows.set(event, row)
    }
  }
  return [...rows.values()]
}

async function workspaceFrom($: EngineInterface, cwd: string, home: string): Promise<WorkspaceSummary> {
  const [host, status, dirs, remote] = await Promise.all([
    run($, ['hostname', '-s']),
    run($, ['git', 'status', '--porcelain=v2', '--branch'], cwd),
    run($, ['git', 'rev-parse', '--git-dir', '--git-common-dir'], cwd),
    run($, ['git', 'remote', 'get-url', 'origin'], cwd),
  ])
  const ws: WorkspaceSummary = {
    folder: home && cwd.startsWith(home) ? `~${cwd.slice(home.length)}` : cwd,
    host: host || undefined,
    ahead: 0,
    behind: 0,
    staged: 0,
    modified: 0,
    untracked: 0,
    isWorktree: false,
  }
  for (const line of status.split('\n')) {
    if (line.startsWith('# branch.head ')) ws.branch = line.slice(14)
    const ab = /^# branch\.ab \+(\d+) -(\d+)/.exec(line)
    if (ab) {
      ws.ahead = Number(ab[1])
      ws.behind = Number(ab[2])
    }
    if (line.startsWith('? ')) ws.untracked++
    if (/^[12u] /.test(line)) {
      const xy = line.slice(2, 4)
      if (xy[0] !== '.') ws.staged++
      if (xy[1] !== '.') ws.modified++
    }
  }
  const [gitDir, commonDir] = dirs.split('\n')
  ws.isWorktree = Boolean(gitDir && commonDir && gitDir !== commonDir)
  const repo = /[:/]([^/:]+\/[^/]+?)(?:\.git)?$/.exec(remote)
  if (repo?.[1]) ws.repo = repo[1]
  return ws
}

async function refresh($: EngineInterface) {
  try {
    const [usage, modelId, cwd, root, home, version] = await Promise.all([
      $.session.usage({ breakdown: 'summary' }),
      $.session.model(),
      $.session.cwd(),
      $.session.root(),
      $.env.get('HOME'),
      $.session.version(),
    ])
    const [user, project, settings, projectSettings, localSettings, workspace] = await Promise.all([
      home ? readJson($, `${home}/.claude.json`) : null,
      readJson($, `${root}/.mcp.json`),
      home ? readJson($, `${home}/.claude/settings.json`) : null,
      readJson($, `${root}/.claude/settings.json`),
      readJson($, `${root}/.claude/settings.local.json`),
      workspaceFrom($, cwd, home ?? ''),
    ])
    const hooks = hooksFrom([
      ['user', settings],
      ['project', projectSettings],
      ['local', localSettings],
    ])

    // MCP: the connected servers from the context's tool schemas (which carry
    // each tool's real server name), then configured ones with no tools.
    const scopes = configuredServers(user, project, root)
    const rows = new Map<string, McpServerRow>()
    const b = usage.context.breakdown
    for (const tool of b?.mcpTools ?? []) {
      const row = rows.get(tool.serverName) ?? {
        name: tool.serverName,
        scope:
          scopes.get(tool.serverName) ??
          (tool.serverName.startsWith('claude.ai ') ? 'account' : 'plugin'),
        tools: 0,
      }
      row.tools++
      rows.set(tool.serverName, row)
    }
    for (const [name, scope] of scopes) {
      if (!rows.has(name)) rows.set(name, { name, scope, tools: 0 })
    }
    const servers = [...rows.values()].sort((x, y) => x.name.localeCompare(y.name))

    const context: ContextSummary | undefined = b && {
      used: b.totalTokens,
      max: b.rawMaxTokens,
      percent: Math.round(b.percentage),
      // What occupies the window, then what's left; deferred tool schemas and
      // the compaction buffer don't fill it.
      rows: b.categories
        .filter(c => c.kind === 'used' || c.kind === 'free')
        .map(c => ({ name: c.name, tokens: c.tokens, isFree: c.kind === 'free' })),
    }
    const limits: LimitRow[] = usage.rateLimits
      .filter(l => l.kind in limitLabel)
      .map(l => ({
        kind: l.kind,
        percent: Math.round(l.percentUsed),
        resetsAt: l.resetsAt ? Date.parse(l.resetsAt) : undefined,
      }))
    const effort = typeof settings?.effortLevel === 'string' ? settings.effortLevel : undefined
    const model: ModelSummary = { name: modelName(modelId), effort, costUsd: usage.cost?.usd }
    const account = accountFrom(user, version.version)

    await update($, snapshot, prev => {
      const history = { ...prev.history }
      const push = (key: string, value: number) => {
        history[key] = [...(history[key] ?? []), value].slice(-HISTORY)
      }
      if (context) push('context', context.percent)
      for (const l of limits) push(l.kind, l.percent)
      return { model, account, limits, context, servers, workspace, hooks, history, refreshedAt: Date.now() }
    })
  } catch (error) {
    await update($, snapshot, s => ({ ...s, error: String(error) }))
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'hud',
      description: 'Show or hide the HUD: details, usage, context, MCP servers, workspace, hooks',
    })
    void refresh($)
    $.clock.every(REFRESH_MS, () => void refresh($))
    return next(e)
  })

  // /hud toggles the pane: closes it when it's open, opens it fresh when not.
  on('command.run', { command: 'hud' }, async $ => {
    const open = (await $.ui.panes()).some(pane => pane.id === PANE)
    if (open) {
      await $.ui.close({ id: PANE })
      return { text: 'HUD closed.' }
    }
    await refresh($)
    await $.ui.open({ id: PANE, title: 'HUD' })
    return { text: 'HUD opened. /hud again closes it.' }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const s = await read($, snapshot)
    const now = Date.now()
    const connected = s.servers.filter(x => x.tools > 0).length
    const servers = [...s.servers].sort((x, y) => Number(y.tools > 0) - Number(x.tools > 0))
    const time = s.refreshedAt ? new Date(s.refreshedAt).toTimeString().slice(0, 5) : '–'
    const ws = s.workspace

    // A section's header: its name on the left, its headline on the right.
    const header = (key: string, title: string, right?: string, rightColor = color.comment) => (
      <Box key={key} justifyContent="space-between" marginTop={key === 'details' ? 0 : 1}>
        <Text bold color={color.purple}>
          {title}
        </Text>
        {right !== undefined && <Text color={rightColor}>{right}</Text>}
      </Box>
    )
    // A details row: icon and label in a column, then the value.
    const detail = (key: string, glyph: string, label: string, value: string | undefined, valueColor = color.fg) =>
      value ? (
        <Box key={`detail:${key}`}>
          <Box width={11}>
            <Text color={color.comment}>
              {glyph} {label}
            </Text>
          </Box>
          <Box flexGrow={1} minWidth={0}>
            <Text color={valueColor} wrap="truncate-end">
              {value}
            </Text>
          </Box>
        </Box>
      ) : null
    // One usage window on one line: icon and label, bar, percent, trend, what's left.
    const gauge = (key: string, glyph: string, label: string, percent: number, trend: number[] | undefined, tail: string) => {
      const filled = Math.min(BAR_WIDTH, Math.round((percent / 100) * BAR_WIDTH))
      return (
        <Box key={key}>
          <Box width={11}>
            <Text color={color.comment}>
              {glyph} {label}
            </Text>
          </Box>
          <Text>
            <Text color={fillColor(percent)}>{'▄'.repeat(filled)}</Text>
            <Text color={color.barBG}>{'▄'.repeat(BAR_WIDTH - filled)}</Text>
          </Text>
          <Box width={6} justifyContent="flex-end">
            <Text color={fillColor(percent)}>{percent}%</Text>
          </Box>
          <Box width={SPARK_WIDTH + 1} justifyContent="flex-end">
            <Text color={color.comment}>{sparkline(trend)}</Text>
          </Box>
          <Box flexGrow={1} justifyContent="flex-end">
            <Text color={color.comment} wrap="truncate-start">
              {tail}
            </Text>
          </Box>
        </Box>
      )
    }
    const changes = ws
      ? [
          ws.staged && `+${ws.staged}`,
          ws.modified && `~${ws.modified}`,
          ws.untracked && `?${ws.untracked}`,
          ws.ahead && `↑${ws.ahead}`,
          ws.behind && `↓${ws.behind}`,
        ].filter(Boolean)
      : []
    const scopes = (list: string[]) => list.map(x => scopeIcon[x] ?? x).join(' ')

    return (
      <Box flexDirection="column">
        {header('details', 'DETAILS')}
        {detail(
          'model',
          icon.model,
          'model',
          s.model && [s.model.name, s.model.effort && `${icon.effort} ${s.model.effort}`].filter(Boolean).join(' · '),
          color.cyan,
        )}
        {detail('cost', icon.cost, 'cost', s.model?.costUsd ? `$${s.model.costUsd.toFixed(2)}` : undefined, color.green)}
        {detail('account', icon.account, 'account', [s.account?.user, s.account?.org].filter(Boolean).join(' · ') || undefined)}
        {detail('version', icon.version, 'version', s.account?.version && `v${s.account.version}`, color.comment)}
        {detail('host', icon.host, 'host', ws?.host)}

        {header('usage', 'USAGE')}
        {s.context &&
          gauge(
            'usage:context',
            icon.context,
            'context',
            s.context.percent,
            s.history.context,
            `${short(Math.max(0, s.context.max - s.context.used))} left`,
          )}
        {s.limits.map(l =>
          gauge(
            `usage:${l.kind}`,
            l.kind === 'seven_day' ? icon.weekly : icon.session,
            limitLabel[l.kind] ?? l.kind,
            l.percent,
            s.history[l.kind],
            l.resetsAt ? until(l.resetsAt, now) : '',
          ),
        )}

        {header('context', 'CONTEXT', s.context ? `${short(s.context.used)} / ${short(s.context.max)}` : '–')}
        {s.context?.rows.map(r => (
          <Box key={`context:${r.name}`}>
            <Box flexGrow={1} minWidth={0}>
              <Text color={r.isFree ? color.comment : color.fg} wrap="truncate-end">
                {r.name}
              </Text>
            </Box>
            <Box width={7} justifyContent="flex-end">
              <Text color={r.isFree ? color.comment : color.cyan}>{short(r.tokens)}</Text>
            </Box>
            <Box width={6} justifyContent="flex-end">
              <Text color={color.comment}>
                {s.context ? Math.round((r.tokens * 100) / s.context.max) : 0}%
              </Text>
            </Box>
          </Box>
        ))}

        {header(
          'summary',
          'MCP SERVERS',
          `${connected} / ${s.servers.length}`,
          connected === s.servers.length ? color.green : color.fg,
        )}
        {servers.map(x => (
          <Box key={`server:${x.name}`}>
            <Box width={2}>
              <Text color={x.tools > 0 ? color.green : color.orange}>{x.tools > 0 ? '●' : '○'}</Text>
            </Box>
            <Box width={2}>
              <Text color={color.comment}>{scopeIcon[x.scope] ?? '?'}</Text>
            </Box>
            <Box flexGrow={1} minWidth={0}>
              <Text color={x.tools > 0 ? color.fg : color.comment} wrap="truncate-end">
                {x.name}
              </Text>
            </Box>
            <Box width={6} justifyContent="flex-end">
              <Text color={x.tools > 0 ? color.cyan : color.comment}>
                {x.tools > 0 ? `${icon.tools} ${x.tools}` : '–'}
              </Text>
            </Box>
          </Box>
        ))}
        {s.servers.length === 0 && <Text color={color.comment}>No MCP servers configured.</Text>}
        {connected < s.servers.length && (
          <Box key="hint">
            <Text color={color.comment}>
              <Text color={color.orange}>○</Text> not connected · /mcp to sign in
            </Text>
          </Box>
        )}
        {s.servers.length > 0 && (
          <Box key="legend">
            <Text color={color.comment} wrap="truncate-end">
              {(['user', 'project', 'local', 'plugin', 'account'] as const)
                .filter(scope => s.servers.some(x => x.scope === scope))
                .map(scope => `${scopeIcon[scope]} ${scope}`)
                .join('  ')}
            </Text>
          </Box>
        )}

        {header('workspace', 'WORKSPACE', ws?.repo)}
        {detail('folder', icon.folder, 'folder', ws?.folder)}
        {ws?.branch && (
          <Box key="branch">
            <Box width={11}>
              <Text color={color.comment}>{icon.branch} branch</Text>
            </Box>
            <Box flexGrow={1} minWidth={0}>
              <Text wrap="truncate-end">
                <Text bold color={color.pink}>
                  {ws.branch}
                </Text>
                <Text color={changes.length ? color.orange : color.green}>
                  {' '}
                  {changes.length ? changes.join(' ') : 'clean'}
                </Text>
                {ws.isWorktree && <Text color={color.comment}> · worktree</Text>}
              </Text>
            </Box>
          </Box>
        )}

        {header('hooks', 'HOOKS', `${s.hooks.length} ${s.hooks.length === 1 ? 'event' : 'events'}`)}
        {s.hooks.map(hook => (
          <Box key={`hook:${hook.event}`}>
            <Box width={20}>
              <Text color={color.fg} wrap="truncate-end">
                {icon.hook} {hook.event}
              </Text>
            </Box>
            <Box flexGrow={1} minWidth={0} justifyContent="flex-end">
              <Text color={color.comment} wrap="truncate-start">
                {hook.handlers.join(', ')} {scopes(hook.scopes)}
              </Text>
            </Box>
          </Box>
        ))}
        {s.hooks.length === 0 && <Text color={color.comment}>No hooks in settings.</Text>}

        {s.error && (
          <Box key="error" marginTop={1}>
            <Text color={color.orange}>Refresh failed: {s.error}</Text>
          </Box>
        )}

        <Box marginTop={1} justifyContent="space-between">
          <Text color={color.comment}>{time}</Text>
          <Box>
            <Button key="refresh" onPress={() => void refresh($)}>
              Refresh
            </Button>
            <Text> </Text>
            <Button key="close" role="dismiss" onPress={() => void $.ui.close({ id: PANE })}>
              Close
            </Button>
          </Box>
        </Box>
      </Box>
    )
  })
}

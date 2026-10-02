import { expect, test } from 'claude-code/testing'
import type { ProcessRunResult, SessionUsage, UiPane } from 'claude-code'

// A session on Opus 5.5 at 42% context, 92% of the 5-hour limit and 55% of
// the weekly; two MCP servers connected (linear, claude.ai Gmail) and three
// configured with no tools; a worktree of acme/app with local changes.
const now = Date.now()
const usage = {
  startedAt: 0,
  cost: { usd: 3.456 },
  rateLimits: [
    { kind: 'five_hour', percentUsed: 92, resetsAt: new Date(now + 110 * 60_000 + 20_000).toISOString() },
    { kind: 'seven_day', percentUsed: 55, resetsAt: new Date(now + 26 * 3_600_000 + 20_000).toISOString() },
  ],
  context: {
    window: 200_000,
    breakdown: {
      model: 'claude-opus-5-5',
      totalTokens: 84_123,
      rawMaxTokens: 200_000,
      percentage: 42.06,
      categories: [
        { name: 'System prompt', tokens: 3100, kind: 'used', isDeferred: false, color: 'promptBorder' },
        { name: 'MCP tools (deferred)', tokens: 40_000, kind: 'deferred', isDeferred: true, color: 'inactive' },
        { name: 'Messages', tokens: 57_000, kind: 'used', isDeferred: false, color: 'permission' },
        { name: 'Autocompact buffer', tokens: 33_000, kind: 'buffer', isDeferred: false, color: 'inactive' },
        { name: 'Free space', tokens: 115_877, kind: 'free', isDeferred: false, color: 'inactive' },
      ],
      mcpTools: [
        { name: 'mcp__linear__list_issues', serverName: 'linear', tokens: 1200, isLoaded: true },
        { name: 'mcp__linear__save_issue', serverName: 'linear', tokens: 800, isLoaded: false },
        { name: 'mcp__claude_ai_Gmail__search', serverName: 'claude.ai Gmail', tokens: 300, isLoaded: false },
      ],
    },
  },
} as unknown as SessionUsage

const files: Record<string, string> = {
  '/home/t/.claude.json': JSON.stringify({
    oauthAccount: { emailAddress: 'ada@example.com', organizationName: "ada@example.com's Organization" },
    mcpServers: { linear: { type: 'http' }, neon: { headers: { Authorization: 'Bearer SECRET' } } },
    projects: { '/work/app': { mcpServers: { 'local-db': {} } } },
  }),
  '/home/t/.claude/settings.json': JSON.stringify({
    effortLevel: 'high',
    hooks: {
      SessionStart: [{ hooks: [{ type: 'command', command: 'if [ -z "$ORCA_PANE_KEY" ]; then exit 0; fi' }] }],
      Stop: [{ hooks: [{ type: 'command', command: 'if [ -n "$ORCA_PANE_KEY" ]; then :; fi' }] }],
    },
  }),
  '/work/app/.claude/settings.json': JSON.stringify({
    hooks: { Stop: [{ hooks: [{ type: 'command', command: '"$CLAUDE_PROJECT_DIR"/.claude/hooks/stop.sh', timeout: 300 }] }] },
  }),
  '/work/app/.mcp.json': JSON.stringify({ mcpServers: { 'project-tools': {} } }),
}

const commands: Record<string, string> = {
  'hostname -s': 'workstation',
  'git status --porcelain=v2 --branch': [
    '# branch.oid abc',
    '# branch.head feat',
    '# branch.upstream origin/feat',
    '# branch.ab +2 -0',
    '1 .M N... 100644 100644 100644 a b src/a.ts',
    '1 M. N... 100644 100644 100644 a b src/b.ts',
    '? notes.md',
  ].join('\n'),
  'git rev-parse --git-dir --git-common-dir': '/work/main/.git/worktrees/app\n/work/main/.git',
  'git remote get-url origin': 'git@github.com:acme/app.git',
}

for (const surface of ['terminal', 'desktop'] as const) {
  test(`shows details, usage, context, MCP servers, workspace and hooks on ${surface}`, async ($, on) => {
    // These hooks stand for the engine: each answers { value }.
    on('env.get', async () => ({ value: '/home/t' }))
    on('session.root', async () => ({ value: '/work/app' }))
    on('session.cwd', async () => ({ value: '/home/t/work/app' }))
    on('session.model', async () => ({ value: 'claude-opus-5-5' }))
    on('session.version', async () => ({ value: { version: '2.1.287' } as never }))
    on('session.usage', async () => ({ value: usage }))
    on('fs.read', async (_$, e) => {
      const text = files[e.path]
      if (text === undefined) throw new Error(`no such file: ${e.path}`)
      return { value: text }
    })
    on('process.run', async (_$, e) => {
      const stdout = commands[e.argv.join(' ')] ?? ''
      const result: ProcessRunResult = {
        exitCode: stdout ? 0 : 1,
        stdout,
        stderr: '',
        isStdoutTruncated: false,
        isStderrTruncated: false,
      }
      return { value: result }
    })
    let panes: UiPane[] = []
    on('ui.panes', async () => ({ value: panes }))
    on('ui.open', async (_$, e) => {
      panes = [{ id: e.id, title: e.title ?? e.id, isShown: true, isFocused: false, isPlaced: true }]
      return { value: {} as never }
    })
    on('ui.close', async (_$, e) => {
      panes = panes.filter(pane => pane.id !== e.id)
      return { value: undefined }
    })

    const opened = await $.command.run({ command: 'cc', args: '' } as never)
    expect(JSON.stringify(opened)).toContain('Session pane opened')
    const pane = await $.ui.mount({
      plugin: 'session-pane',
      surface,
      component: 'Pane',
      requestId: 'session',
      props: { title: 'Session', isFocused: false, bodyColumns: 48 } as never,
    })
    const text = async (key: string) => (await pane.find({ key }))?.text

    // The Nerd Font icons the pane draws, by name.
    const i = {
      model: '', effort: '\u{F04C5}', cost: '', account: '', version: '',
      host: '', context: '\u{F035B}', session: '', weekly: '\u{F0150}', folder: '',
      branch: '', tools: '', hook: '\u{F06E2}', user: '', project: '',
      local: '', account2: '',
    }

    // Details: model, cost, account, version and host, grouped.
    expect(await text('detail:model')).toBe(`${i.model} modelOpus 5.5 · ${i.effort} high`)
    expect(await text('detail:cost')).toBe(`${i.cost} cost$3.46`)
    expect(await text('detail:account')).toBe(`${i.account} accountada · personal`)
    expect(await text('detail:version')).toBe(`${i.version} versionv2.1.287`)
    expect(await text('detail:host')).toBe(`${i.host} hostworkstation`)

    // Usage: one line per window.
    expect(await text('usage:context')).toBe(`${i.context} context${'▄'.repeat(10)}42%▄116k left`)
    expect(await text('usage:five_hour')).toBe(`${i.session} session${'▄'.repeat(10)}92%▇1h 50m`)
    expect(await text('usage:seven_day')).toBe(`${i.weekly} weekly${'▄'.repeat(10)}55%▅1d 2h`)

    // Context: each category's tokens and its share of the window.
    expect(await text('context')).toBe('CONTEXT84k / 200k')
    expect(await text('context:System prompt')).toBe('System prompt3.1k2%')
    expect(await text('context:Messages')).toBe('Messages57k29%')
    expect(await text('context:Free space')).toBe('Free space116k58%')
    // Deferred tool schemas and the compaction buffer don't fill the window.
    expect(await pane.find({ key: 'context:MCP tools (deferred)' })).toBeUndefined()
    expect(await pane.find({ key: 'context:Autocompact buffer' })).toBeUndefined()

    // MCP servers: a scope icon, and the tool count behind a wrench.
    expect(await text('summary')).toBe('MCP SERVERS2 / 5')
    expect(await text('server:linear')).toBe(`●${i.user}linear${i.tools} 2`)
    expect(await text('server:claude.ai Gmail')).toBe(`●${i.account2}claude.ai Gmail${i.tools} 1`)
    expect(await text('server:neon')).toBe(`○${i.user}neon–`)
    expect(await text('server:local-db')).toBe(`○${i.local}local-db–`)
    expect(await text('server:project-tools')).toBe(`○${i.project}project-tools–`)
    expect(await text('hint')).toBe('○ not connected · /mcp to sign in')
    expect(await text('legend')).toBe(`${i.user} user  ${i.project} project  ${i.local} local  ${i.account2} account`)

    // Workspace: folder and branch; the repo in the header.
    expect(await text('workspace')).toBe('WORKSPACEacme/app')
    expect(await text('detail:folder')).toBe(`${i.folder} folder~/work/app`)
    expect(await text('branch')).toBe(`${i.branch} branchfeat +1 ~1 ?1 ↑2 · worktree`)

    // Hooks: each event once, with what runs on it and where it's set.
    expect(await text('hooks')).toBe('HOOKS2 events')
    expect(await text('hook:SessionStart')).toBe(`${i.hook} SessionStartorca ${i.user}`)
    expect(await text('hook:Stop')).toBe(`${i.hook} Stoporca, stop.sh ${i.user} ${i.project}`)

    const drawn = JSON.stringify(await pane.drawn())
    // Connected servers are listed before the ones that aren't.
    expect(drawn.indexOf('server:linear')).toBeLessThan(drawn.indexOf('server:neon'))
    // Only server names are read from the config, never their headers.
    expect(drawn).not.toContain('SECRET')

    // /cc again closes it.
    const closed = await $.command.run({ command: 'cc', args: '' } as never)
    expect(JSON.stringify(closed)).toContain('Session pane closed')
    expect(panes).toEqual([])
  })
}

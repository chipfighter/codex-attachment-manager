// Purpose: v0.4 — the Claude plugin's mod (docs/v0.4/plan.md). Two jobs; the rest is the plugin service's
// (plugin/src/plugin-server.ts, CAM_HOST=claude) and the engine's:
// 1. Routing. Claude Desktop starts Code sessions with ANTHROPIC_BASE_URL set and ignores settings files for it, so
//    the mod points this Claude Code process at the engine with $.env.set once the engine answers and forwards Claude's
//    requests (its health lists api.anthropic.com), before the first request where it can, and puts the original back
//    when the process ends. It leaves a session alone that already uses another endpoint or a third-party provider.
//    The subscription login is untouched: the engine forwards the same headers to api.anthropic.com.
// 2. The way to the panel. The panel is the Codex panel itself (plugin/src/panel.html), served by the engine as a page
//    for this session (proxy.ts, /__cam/panel) and opened in a browser: a mod draws only its own simple elements (no
//    web page), and Claude Code opens no MCP app for the user. /cam opens a small pane with where this session's
//    requests go, the session's images in short, a link to the panel and a button that copies it.
// Also: the model's cam_view_image call gets this session's id (the service may outlive a /clear or /resume).
// Input: mod events. Output: env changes for this process, a pane, requests to the engine on 127.0.0.1.

const PLUGIN = 'codex-attachment-manager'
// The engine's port (engine.ts, DEFAULT_PORT); the plugin's MCP server starts the engine on it.
const ENGINE_PORT = 17891
const PANE = 'cam'
const ROUTING = { plugin: 'codex-attachment-manager', key: 'routing' }

const WORDS = {
  zh: {
    title: '上下文素材',
    open: '打开素材面板', copy: '复制链接', copied: '已复制链接',
    hint: '面板是本机引擎提供的网页，和 Codex 里的面板相同：勾选、预览、筛选、自动选图都在那里。点上面的链接打开；没有打开时，复制链接粘贴到浏览器（Claude 桌面自带的浏览器面板也可以）。',
    summary: (images, off) => `本会话 ${images} 张图片${off ? `，${off} 张不发送` : ''}`,
    routing: {
      on: (port) => `本会话的请求经过本机引擎（端口 ${port}）`,
      waiting: '正在等待本机引擎启动…',
      'other-endpoint': '本会话使用别的服务地址，没有接管：勾选不会生效',
      provider: '本会话使用第三方模型服务，没有接管：勾选不会生效',
      'engine-old': '运行中的引擎版本较旧，不能转发 Claude 的请求：关掉 Codex 后运行 cam install，再开新会话',
      'no-engine': '本机引擎没有启动，本会话直连：勾选不会生效',
      failed: '切换请求地址没有成功，本会话直连：勾选不会生效',
    },
  },
  en: {
    title: 'Context Assets',
    open: 'Open the assets panel', copy: 'Copy link', copied: 'Link copied',
    hint: 'The panel is a page the local engine serves, the same as in Codex: checks, previews, filters and automatic selection are there. Open it with the link above; if nothing opens, copy the link into a browser (Claude Desktop\'s own browser pane works too).',
    summary: (images, off) => `${images} images in this session${off ? `, ${off} not sent` : ''}`,
    routing: {
      on: (port) => `This session's requests go through the local engine (port ${port})`,
      waiting: 'Waiting for the local engine…',
      'other-endpoint': 'This session uses another endpoint and is left alone: checks have no effect',
      provider: 'This session uses a third-party provider and is left alone: checks have no effect',
      'engine-old': 'The running engine is too old to forward Claude requests: close Codex, run cam install, then start a new session',
      'no-engine': 'The local engine is not running; this session connects directly: checks have no effect',
      failed: 'Switching the endpoint failed; this session connects directly: checks have no effect',
    },
  },
}

// What the pane shows, kept between redraws: the routing state, and the engine's short answer about the session (read
// when the pane opens, then again after each turn and each /clear or /resume once it has been opened).
let routingState = null
let overview = null
let paneOpened = false
let copied = false

// The engine's panel API answers in JSON; the header marks a request as the panel's (a browser page cannot send it).
async function api($, path) {
  const response = await $.http.fetch(`http://127.0.0.1:${ENGINE_PORT}${path}`, { headers: { 'x-cam-panel': '1' } })
  let body = null
  try { body = response.text ? JSON.parse(response.text) : null } catch { body = null }
  if (!response.ok) throw new Error(body?.error ?? `HTTP ${response.status}`)
  return body
}

// ---- Routing ----

async function readRouting($) {
  return (await $.state.get(ROUTING)).value ?? null
}

async function writeRouting($, value) {
  routingState = value
  await $.state.set(ROUTING, value)
  await $.ui.invalidate('ui.render')
}

function loopbackAdded(original) {
  const entries = (original || '').split(',').map((value) => value.trim()).filter(Boolean)
  return [...new Set([...entries, '127.0.0.1', 'localhost', '::1'])].join(',')
}

const idle = (reason) => ({ active: false, port: null, originalBaseUrl: null, originalNoProxy: null, originalNoProxyLower: null, reason })

// `attempts` × 0.5 s at most for the engine to answer; false when it did not (yet).
async function startRouting($, attempts = 60) {
  const saved = await readRouting($)
  // Already switched in this process (the module was reloaded): keep what it saved.
  if (saved?.active) { routingState = saved; return true }
  const current = await $.env.get('ANTHROPIC_BASE_URL')
  if (current && !/^https:\/\/api\.anthropic\.com\/?$/.test(current)) { await writeRouting($, idle('other-endpoint')); return true }
  const providers = [await $.env.get('CLAUDE_CODE_USE_BEDROCK'), await $.env.get('CLAUDE_CODE_USE_VERTEX'), await $.env.get('CLAUDE_CODE_USE_FOUNDRY')]
  if (providers.some((value) => value && value !== '0')) { await writeRouting($, idle('provider')); return true }
  await writeRouting($, idle('waiting'))
  // The plugin's MCP server starts the engine with the session; wait for it to answer. An engine started by an older
  // copy of the plugin (Codex's, not updated yet) does not forward Claude's requests: leave the session alone then.
  let port = null
  let reason = 'no-engine'
  for (let attempt = 0; attempt < attempts && port === null && reason !== 'engine-old'; attempt++) {
    try {
      const health = await $.http.fetch(`http://127.0.0.1:${ENGINE_PORT}/__cam/health`)
      const body = health.ok ? JSON.parse(health.text) : null
      if (body?.service === PLUGIN && Array.isArray(body.upstreams) && body.upstreams.includes('api.anthropic.com')) port = ENGINE_PORT
      else if (body?.service === PLUGIN) reason = 'engine-old'
    } catch { /* the engine is still starting */ }
    if (port === null && reason !== 'engine-old') await $.clock.sleep(500)
  }
  if (port === null) {
    if (reason === 'no-engine' && attempts < 60) return false
    await writeRouting($, idle(reason))
    return true
  }
  const originalNoProxy = await $.env.get('NO_PROXY')
  const originalNoProxyLower = await $.env.get('no_proxy')
  const saving = { active: true, port, originalBaseUrl: current ?? null, originalNoProxy: originalNoProxy ?? null, originalNoProxyLower: originalNoProxyLower ?? null, reason: null }
  await writeRouting($, saving)
  try {
    // Requests to the engine must not go through a system proxy.
    await $.env.set('NO_PROXY', loopbackAdded(originalNoProxy))
    await $.env.set('no_proxy', loopbackAdded(originalNoProxyLower))
    await $.env.set('ANTHROPIC_BASE_URL', `http://127.0.0.1:${port}`)
  } catch {
    await restoreRouting($)
    await writeRouting($, { ...saving, active: false, reason: 'failed' })
  }
  return true
}

async function restoreRouting($) {
  const saved = await readRouting($)
  if (!saved?.active) return
  await $.env.set('ANTHROPIC_BASE_URL', saved.originalBaseUrl ?? undefined)
  await $.env.set('NO_PROXY', saved.originalNoProxy ?? undefined)
  await $.env.set('no_proxy', saved.originalNoProxyLower ?? undefined)
  routingState = { ...saved, active: false, reason: null }
  await $.state.set(ROUTING, routingState)
}

// ---- The pane ----

const panelUrl = (sessionId) => `http://localhost:${ENGINE_PORT}/__cam/panel?session=${encodeURIComponent(sessionId)}`

async function loadOverview($) {
  try {
    const state = await api($, `/__cam/claude/panel?session=${encodeURIComponent(await $.session.id())}`)
    overview = { lang: state.lang, images: state.totals.images, off: state.totals.unchecked }
  } catch {
    overview = null
  }
  await $.ui.invalidate('ui.render')
}

// New images come with a turn, and /clear or /resume brings another session: the count follows, without holding up
// the event.
function reloadOverview($) {
  if (paneOpened) $.clock.after(0, () => { loadOverview($).catch(() => {}) })
}

async function openPane($) {
  routingState = (await readRouting($)) ?? routingState
  copied = false
  paneOpened = true
  await $.ui.open({ id: PANE, title: WORDS.zh.title, focus: true, closeOnEscape: true })
  await loadOverview($)
}

async function drawPane($, e) {
  const { Box, Text, Button, Link } = $.ui.resolve(e)
  const w = WORDS[overview?.lang === 'en' ? 'en' : 'zh']
  const url = panelUrl(await $.session.id())
  const routing = routingState
  const status = routing?.active ? w.routing.on(routing.port) : w.routing[routing?.reason ?? 'waiting'] ?? w.routing.waiting
  return Box({
    flexDirection: 'column', rowGap: 1,
    children: [
      Text({ bold: true, children: [w.title] }),
      Text(routing?.active ? { dimColor: true, children: [status] } : { color: 'yellow', children: [status] }),
      ...(overview ? [Text({ children: [w.summary(overview.images, overview.off)] })] : []),
      Box({
        flexDirection: 'row', columnGap: 2,
        children: [
          Link({ href: url, label: w.open }),
          Button({ key: 'copy', label: copied ? w.copied : w.copy, onPress: async (press) => {
            await $.ui.copy({ text: url, surface: press.surface })
            copied = true
            await $.ui.invalidate('ui.render')
          } }),
        ],
      }),
      Text({ dimColor: true, children: [w.hint] }),
    ],
  })
}

export function register(on) {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'cam', description: 'Context assets: open the panel to choose which images go to the model (Codex Attachment Manager)', immediate: true })
    // Before the first request where possible: a resumed session's unchecked images must not go out with it. The
    // engine usually answers at once; one the plugin's MCP server is still starting gets a few seconds here, then the
    // rest of the wait goes on in the background.
    const done = await startRouting($, 12).catch(() => true)
    if (!done) $.clock.after(0, () => { startRouting($).catch(() => {}) })
    return next(e)
  })

  // /clear, /resume and /branch end a session but not this process: its requests keep going through the engine, and
  // the session state the pane reads is written again for the new session.
  on('classic.SessionStart', { source: ['clear', 'resume', 'fork'] }, async ($, e, next) => {
    if (routingState) await $.state.set(ROUTING, routingState).catch(() => {})
    reloadOverview($)
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    reloadOverview($)
    return result
  })

  on('session.end', async ($, e, next) => {
    if (e.reason !== 'clear' && e.reason !== 'resume') await restoreRouting($).catch(() => {})
    return next(e)
  })

  on('command.run', { command: 'cam' }, async ($) => {
    await openPane($)
    return {}
  })

  // The model's fetch call is about this session, whichever the plugin service was started for. A failure here must
  // not stop the call: it then goes on unchanged (the service falls back to the session it was started for).
  on('tool.call', async ($, e, next) => {
    if (typeof e.tool === 'string' && e.tool.endsWith('__cam_view_image')) return next({ ...e, sessionId: await $.session.id() })
    return next(e)
  }).catch(($, e, next) => (next.called ? undefined : next(e)))

  on('ui.render', { component: 'Pane' }, async ($, e, next) => {
    if (e.requestId === PANE) return drawPane($, e)
    return next(e)
  })
}

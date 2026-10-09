// Purpose: v0.4 — the Claude plugin's mod (docs/v0.4/plan.md). Two jobs, the rest is the plugin service's
// (plugin/src/plugin-server.ts, CAM_HOST=claude) and the engine's:
// 1. Routing. Claude Desktop starts Code sessions with ANTHROPIC_BASE_URL set and ignores settings files for it, so
//    the mod points this Claude Code process at the engine with $.env.set once the engine answers and forwards Claude's
//    requests (its health lists api.anthropic.com), and puts the original back when the session ends. It leaves a
//    session alone that already uses another endpoint or a third-party provider. The subscription login is untouched:
//    the engine forwards the same headers to api.anthropic.com.
// 2. The panel. /cam opens a pane listing the session's images by turn, with thumbnails, a check box each, a check box
//    per turn, automatic selection and a preview, like the Codex panel (plugin/src/panel.html). It reads and changes
//    everything through the engine's local panel API (proxy.ts, claudePanelApi), never through the model: a mod
//    reaches the plugin's MCP server only through Claude Code's tool permissions, a prompt for every call.
// Also: the model's cam_view_image call gets this session's id (the service may outlive a /clear or /resume).
// Input: mod events. Output: env changes for this process, a pane, requests to the engine on 127.0.0.1.

const PLUGIN = 'codex-attachment-manager'
// The engine's port (engine.ts, DEFAULT_PORT); the plugin's MCP server starts the engine on it.
const ENGINE_PORT = 17891
const PANE = 'cam'
const PREVIEW = 'cam-preview'
const ROUTING = { plugin: 'codex-attachment-manager', key: 'routing' }
// The Svg element draws at most 131,072 characters, and one drawing at most 100,000 characters of text, which an
// Svg's markup counts towards; thumbnails beyond the budget are shown as text.
const SVG_MAX = 120000
const TREE_BUDGET = 90000
const THUMB_SIDE = 72
const PREVIEW_SIDE = 420

const WORDS = {
  zh: {
    title: '上下文素材', images: (n) => `${n} 张图片`, refresh: '刷新',
    autoOn: '自动选图：开', autoOff: '自动选图：关',
    footerManual: '勾选的图片会随下一条消息发给模型', footerAuto: '勾选的图每轮都发，其余由模型按需取回',
    turn: (n) => `第 ${n} 轮`, send: '发送', notSend: '不发送', pinned: '固定发送', notPinned: '不固定',
    kind: { upload: '用户上传', view: '查看的图片', tool: '工具返回', generated: '生成的图片', pdf: 'PDF 页面', browser: '网页截图' },
    sameAs: (ids) => `与 ${ids} 内容相同`, requested: '模型需要', fetched: '模型取回', locked: '无法取消',
    needs: (n) => `模型需要 ${n} 张没发送的图：`, fetchedBar: (n) => `最近一轮模型取回 ${n} 张：`,
    preview: '预览', close: '关闭', previewNone: '这张图没法在面板里预览（格式或大小超出限制）。',
    nextManual: (sent, omitted, dup) => `下一条消息：照常发送 ${sent} 张，占位 ${omitted} 张${dup ? `（其中重复 ${dup} 张）` : ''}`,
    nextAuto: (pinned, omitted) => `下一条消息：固定发送 ${pinned} 张，其余 ${omitted} 张占位，由模型按需取回`,
    routing: {
      on: (port) => `本会话的请求经过本机引擎（端口 ${port}）`,
      waiting: '正在等待本机引擎启动…',
      'other-endpoint': '本会话使用别的服务地址，没有接管：勾选不会生效',
      provider: '本会话使用第三方模型服务，没有接管：勾选不会生效',
      'engine-old': '运行中的引擎版本较旧，不能转发 Claude 的请求：关掉 Codex 后运行 cam install，再开新会话',
      'no-engine': '本机引擎没有启动，本会话直连：勾选不会生效',
      failed: '切换请求地址没有成功，本会话直连：勾选不会生效',
    },
    notice: {
      skipped: '上一次请求没能按勾选改写，原样发送了。',
      fallback: '上一次请求里改动的历史被 Anthropic 拒绝（思考记录校验），已原样重发：那一次勾选没有生效。',
      websocket: '',
    },
    empty: '这个会话里还没有图片。', error: (message) => `读取失败：${message}`, thumbText: (mime, w, h) => `${mime}${w && h ? ` ${w}×${h}` : ''}`,
  },
  en: {
    title: 'Context Assets', images: (n) => `${n} images`, refresh: 'Refresh',
    autoOn: 'Auto select: on', autoOff: 'Auto select: off',
    footerManual: 'Checked images go to the model with your next message', footerAuto: 'Checked images are sent every turn; the model fetches the rest when it needs them',
    turn: (n) => `Turn ${n}`, send: 'Send', notSend: 'Not sent', pinned: 'Pinned', notPinned: 'Not pinned',
    kind: { upload: 'Uploaded', view: 'Viewed image', tool: 'Tool result', generated: 'Generated', pdf: 'PDF page', browser: 'Web page' },
    sameAs: (ids) => `Same as ${ids}`, requested: 'Model needs it', fetched: 'Fetched by the model', locked: 'Cannot be left out',
    needs: (n) => `The model needs ${n} image(s) not sent:`, fetchedBar: (n) => `Fetched by the model in the latest turn (${n}):`,
    preview: 'Preview', close: 'Close', previewNone: 'This image cannot be previewed in the panel (format or size).',
    nextManual: (sent, omitted, dup) => `Next message: ${sent} sent, ${omitted} placeholders${dup ? ` (${dup} duplicates)` : ''}`,
    nextAuto: (pinned, omitted) => `Next message: ${pinned} pinned; ${omitted} placeholders the model can fetch`,
    routing: {
      on: (port) => `This session's requests go through the local engine (port ${port})`,
      waiting: 'Waiting for the local engine…',
      'other-endpoint': 'This session uses another endpoint and is left alone: checks have no effect',
      provider: 'This session uses a third-party provider and is left alone: checks have no effect',
      'engine-old': 'The running engine is too old to forward Claude requests: close Codex, run cam install, then start a new session',
      'no-engine': 'The local engine is not running; this session connects directly: checks have no effect',
      failed: 'Switching the endpoint failed; this session connects directly: checks have no effect',
    },
    notice: {
      skipped: 'The last request could not be rewritten and went out unchanged.',
      fallback: 'Anthropic refused the edited history of the last request (thinking check), so it was sent again unchanged: your checks did not apply that time.',
      websocket: '',
    },
    empty: 'No images in this session yet.', error: (message) => `Could not read: ${message}`, thumbText: (mime, w, h) => `${mime}${w && h ? ` ${w}×${h}` : ''}`,
  },
}

// What the panel shows, kept between redraws: the engine's latest answer for the session, thumbnails by session and
// id, the open preview, and whether the pane is open.
let panel = null
let panelSession = null
let lastError = null
let loading = false
let paneOpen = false
let previewId = null
let refreshTimer = null
let routingState = null
const thumbs = new Map()
const previews = new Map()

// The engine's panel API answers in JSON; the header marks a request as the panel's (a browser page cannot send it).
async function api($, path, init = {}) {
  const response = await $.http.fetch(`http://127.0.0.1:${ENGINE_PORT}${path}`, { ...init, headers: { 'x-cam-panel': '1', ...(init.headers ?? {}) } })
  let body = null
  try { body = response.text ? JSON.parse(response.text) : null } catch { body = null }
  if (!response.ok) throw new Error(body?.error ?? `HTTP ${response.status}`)
  return body
}
const query = (params) => Object.entries(params).map(([key, value]) => `${key}=${encodeURIComponent(String(value))}`).join('&')

const words = () => WORDS[panel?.lang === 'en' ? 'en' : 'zh']

// ---- Routing ----

async function readRouting($) {
  return (await $.state.get(ROUTING)).value ?? null
}

async function writeRouting($, value) {
  routingState = value
  await $.state.set(ROUTING, value)
  if (paneOpen) await $.ui.invalidate('ui.render')
}

function loopbackAdded(original) {
  const entries = (original || '').split(',').map((value) => value.trim()).filter(Boolean)
  return [...new Set([...entries, '127.0.0.1', 'localhost', '::1'])].join(',')
}

// `attempts` × 0.5 s at most for the engine to answer; false when it did not (yet).
async function startRouting($, attempts = 60) {
  const saved = await readRouting($)
  // Already switched in this process (the module was reloaded): keep what it saved.
  if (saved?.active) { routingState = saved; return true }
  const current = await $.env.get('ANTHROPIC_BASE_URL')
  if (current && !/^https:\/\/api\.anthropic\.com\/?$/.test(current)) { await writeRouting($, { active: false, port: null, originalBaseUrl: null, originalNoProxy: null, originalNoProxyLower: null, reason: 'other-endpoint' }); return true }
  const providers = [await $.env.get('CLAUDE_CODE_USE_BEDROCK'), await $.env.get('CLAUDE_CODE_USE_VERTEX'), await $.env.get('CLAUDE_CODE_USE_FOUNDRY')]
  if (providers.some((value) => value && value !== '0')) { await writeRouting($, { active: false, port: null, originalBaseUrl: null, originalNoProxy: null, originalNoProxyLower: null, reason: 'provider' }); return true }
  await writeRouting($, { active: false, port: null, originalBaseUrl: null, originalNoProxy: null, originalNoProxyLower: null, reason: 'waiting' })
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
    await writeRouting($, { active: false, port: null, originalBaseUrl: null, originalNoProxy: null, originalNoProxyLower: null, reason })
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

// ---- Panel data ----

async function refresh($) {
  if (loading) return
  loading = true
  try {
    const sessionId = await $.session.id()
    if (sessionId !== panelSession) { thumbs.clear(); previews.clear(); panelSession = sessionId }
    panel = await api($, `/__cam/claude/panel?${query({ session: sessionId })}`)
    lastError = null
    for (const image of panel.images) {
      const key = `${sessionId}:${image.id}`
      if (thumbs.has(key)) continue
      try { thumbs.set(key, (await api($, `/__cam/claude/image?${query({ session: sessionId, id: image.id, max: THUMB_SIDE })}`)).dataUrl) } catch { thumbs.set(key, null) }
    }
  } catch (error) {
    lastError = String(error?.message ?? error)
  } finally {
    loading = false
  }
  await $.ui.invalidate('ui.render')
}

async function change($, args) {
  try {
    panel = await api($, `/__cam/claude/select?${query({ session: await $.session.id() })}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(args) })
    lastError = null
  } catch (error) {
    lastError = String(error?.message ?? error)
  }
  await $.ui.invalidate('ui.render')
}

async function openPanel($) {
  paneOpen = true
  routingState = (await readRouting($)) ?? routingState
  await $.ui.open({ id: PANE, title: WORDS.zh.title, focus: true, closeOnEscape: true })
  if (!refreshTimer) refreshTimer = $.clock.every(3000, () => { if (paneOpen) refresh($) })
  await refresh($)
}

async function openPreview($, id) {
  previewId = id
  const sessionId = await $.session.id()
  const key = `${sessionId}:${id}`
  if (!previews.has(key)) {
    try { previews.set(key, (await api($, `/__cam/claude/image?${query({ session: sessionId, id, max: PREVIEW_SIDE })}`)).dataUrl) } catch { previews.set(key, null) }
  }
  await $.ui.open({ id: PREVIEW, title: id, focus: true, closeOnEscape: true })
  await $.ui.invalidate('ui.render')
}

// ---- Drawing ----

const humanBytes = (bytes) => (bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`)
const escapeXml = (value) => String(value).replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[c])

function svgImage(Svg, dataUrl, width, height, alt) {
  const source = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><image href="${dataUrl}" xlink:href="${dataUrl}" x="0" y="0" width="${width}" height="${height}" preserveAspectRatio="xMidYMid meet"/></svg>`
  return { source, element: Svg({ source, alt: escapeXml(alt), width, height }) }
}

function fitted(image, side) {
  const w = image.width || side
  const h = image.height || side
  const scale = Math.min(1, side / Math.max(w, h))
  return [Math.max(8, Math.round(w * scale)), Math.max(8, Math.round(h * scale))]
}

function drawPanel($, e) {
  const el = $.ui.resolve(e)
  const { Box, Text, Button, Svg } = el
  const w = words()
  const redraw = () => $.ui.invalidate('ui.render')
  const children = []
  const routing = routingState
  const header = [Text({ bold: true, children: [`${w.title}${panel ? ` · ${w.images(panel.images.length)}` : ''}`] })]
  if (panel?.title) header.push(Text({ dimColor: true, wrap: 'truncate', children: [panel.title] }))
  children.push(Box({ flexDirection: 'column', children: header }))
  // Where this session's requests go: the mod's own routing state.
  const status = routing?.active ? w.routing.on(routing.port) : w.routing[routing?.reason ?? 'waiting'] ?? w.routing.waiting
  children.push(Text({ color: routing?.active ? undefined : 'yellow', dimColor: !!routing?.active, children: [status] }))
  const auto = !!panel?.auto
  children.push(Box({
    flexDirection: 'row', columnGap: 2,
    children: [
      Button({ key: 'refresh', label: w.refresh, hotkey: 'r', onPress: () => refresh($) }),
      Button({ key: 'auto', label: auto ? w.autoOn : w.autoOff, hotkey: 'a', onPress: () => change($, { auto: !auto }) }),
    ],
  }))
  if (lastError) children.push(Text({ color: 'red', children: [w.error(lastError)] }))
  if (!panel) return Box({ flexDirection: 'column', rowGap: 1, children })
  const images = panel.images
  // The next message: what goes out as it is, and what becomes a placeholder (as the Codex panel says it).
  const next = images.filter((image) => image.inNextRequest)
  const omitted = next.filter((image) => !image.checked && image.replaceable)
  const kept = next.filter((image) => image.checked || !image.replaceable)
  const dup = omitted.filter((image) => image.sameAs.some((id) => kept.some((other) => other.id === id))).length
  children.push(Text({ children: [auto ? w.nextAuto(kept.length, omitted.length) : w.nextManual(kept.length, omitted.length, dup)] }))
  const notice = panel.send?.notice
  if (notice && w.notice[notice.kind]) children.push(Text({ color: 'yellow', children: [w.notice[notice.kind]] }))
  // The ids the model asked for that are not sent (manual), or fetched in the latest turn (automatic): pressing one
  // puts the keyboard on that image's check box.
  const asked = auto ? panel.fetched : panel.requested.filter((id) => images.some((image) => image.id === id && !image.checked))
  if (asked.length) {
    children.push(Box({
      flexDirection: 'row', columnGap: 1, flexWrap: 'wrap',
      children: [Text({ color: 'yellow', children: [auto ? w.fetchedBar(asked.length) : w.needs(asked.length)] }), ...asked.map((id) => Button({ key: `goto-${id}`, label: id, plain: true, onPress: () => $.ui.focus({ requestId: PANE, key: `check-${id}` }).catch(() => {}) }))],
    }))
  }
  if (!images.length) {
    children.push(Text({ dimColor: true, children: [w.empty] }))
  } else {
    let budget = TREE_BUDGET
    const turns = [...new Set(images.map((image) => image.turn ?? 0))]
    for (const turn of turns) {
      const rows = images.filter((image) => (image.turn ?? 0) === turn)
      const changeable = rows.filter((image) => image.replaceable)
      const on = changeable.filter((image) => image.checked).length
      const turnChildren = [Text({ bold: true, children: [turn ? w.turn(turn) : '—'] })]
      // A turn's own check box: all on → all off; otherwise all on. Shown from two images that can change.
      if (changeable.length >= 2) {
        const all = on === changeable.length
        const ids = changeable.map((image) => image.id)
        turnChildren.push(Button({ key: `turn-${turn}`, label: all ? '☑' : on ? '◩' : '☐', plain: true, onPress: () => change($, auto ? { [all ? 'uncheck' : 'check']: ids, mode: 'auto' } : { [all ? 'uncheck' : 'check']: ids }) }))
      }
      children.push(Box({ flexDirection: 'row', columnGap: 2, children: turnChildren }))
      for (const image of rows) {
        const thumb = thumbs.get(`${panelSession}:${image.id}`)
        let picture
        if (thumb && thumb.length < SVG_MAX && budget - thumb.length > 0) {
          const [tw, th] = fitted(image, THUMB_SIDE)
          const drawn = svgImage(Svg, thumb, tw, th, image.id)
          budget -= drawn.source.length
          picture = drawn.element
        } else {
          picture = Box({ width: 12, children: [Text({ dimColor: true, children: [w.thumbText((image.mime ?? 'image').replace('image/', '').toUpperCase(), image.width, image.height)] })] })
        }
        const facts = [w.kind[image.source] ?? w.kind[image.kind] ?? image.kind, image.width && image.height ? `${image.width}×${image.height}` : null, humanBytes(image.bytes)].filter(Boolean).join(' · ')
        const marks = []
        if (image.sameAs.length) marks.push(w.sameAs(image.sameAs.join('、')))
        if (!auto && image.requested && !image.checked) marks.push(w.requested)
        if (image.fetched) marks.push(w.fetched)
        if (!image.replaceable) marks.push(w.locked)
        const checkLabel = auto ? (image.checked ? `☑ ${w.pinned}` : `☐ ${w.notPinned}`) : image.checked ? `☑ ${w.send}` : `☐ ${w.notSend}`
        children.push(Box({
          key: `row-${image.id}`, flexDirection: 'row', columnGap: 2,
          children: [
            picture,
            Box({ flexDirection: 'column', flexGrow: 1, children: [
              Text({ bold: true, wrap: 'truncate', children: [`${image.id}${image.name ? `  ${image.name}` : ''}`] }),
              Text({ dimColor: true, children: [facts] }),
              ...(marks.length ? [Text({ color: 'yellow', children: [marks.join(' · ')] })] : []),
            ] }),
            Box({ flexDirection: 'column', children: [
              Button({ key: `check-${image.id}`, label: checkLabel, plain: true, onPress: () => (image.replaceable ? change($, auto ? { [image.checked ? 'uncheck' : 'check']: [image.id], mode: 'auto' } : { [image.checked ? 'uncheck' : 'check']: [image.id] }) : undefined) }),
              Button({ key: `preview-${image.id}`, label: w.preview, plain: true, onPress: () => openPreview($, image.id) }),
            ] }),
          ],
        }))
      }
    }
  }
  children.push(Text({ dimColor: true, children: [auto ? w.footerAuto : w.footerManual] }))
  void redraw
  return Box({ flexDirection: 'column', rowGap: 1, children })
}

function drawPreview($, e) {
  const { Box, Text, Button, Svg } = $.ui.resolve(e)
  const w = words()
  const image = panel?.images.find((candidate) => candidate.id === previewId)
  const data = previews.get(`${panelSession}:${previewId}`)
  const children = [Box({ flexDirection: 'row', columnGap: 2, children: [
    Text({ bold: true, children: [`${previewId ?? ''}${image?.name ? `  ${image.name}` : ''}`] }),
    Button({ key: 'preview-close', label: w.close, plain: true, onPress: () => $.ui.close({ id: PREVIEW }) }),
  ] })]
  if (image && data && data.length < SVG_MAX) {
    const [pw, ph] = fitted(image, PREVIEW_SIDE)
    children.push(svgImage(Svg, data, pw, ph, image.id).element)
  } else {
    children.push(Text({ dimColor: true, children: [w.previewNone] }))
  }
  return Box({ flexDirection: 'column', rowGap: 1, children })
}

export function register(on) {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'cam', description: 'Context assets: choose which images go to the model (Codex Attachment Manager)', immediate: true })
    // Before the first request where possible: a resumed session's unchecked images must not go out with it. The
    // engine usually answers at once; one the plugin's MCP server is still starting gets a few seconds here, then the
    // rest of the wait goes on in the background.
    const done = await startRouting($, 12).catch(() => true)
    if (!done) $.clock.after(0, () => { startRouting($).catch(() => {}) })
    return next(e)
  })

  // /clear, /resume and /branch end a session but not this process: its requests keep going through the engine, and
  // the session state the panel reads is written again for the new session.
  on('classic.SessionStart', { source: ['clear', 'resume', 'fork'] }, async ($, e, next) => {
    if (routingState) await $.state.set(ROUTING, routingState).catch(() => {})
    return next(e)
  })

  on('session.end', async ($, e, next) => {
    if (e.reason !== 'clear' && e.reason !== 'resume') await restoreRouting($).catch(() => {})
    return next(e)
  })

  on('command.run', { command: 'cam' }, async ($) => {
    await openPanel($)
    return {}
  })

  // The model's fetch call is about this session, whichever the plugin service was started for. A failure here must
  // not stop the call: it then goes on unchanged (the service falls back to the session it was started for).
  on('tool.call', async ($, e, next) => {
    if (typeof e.tool === 'string' && e.tool.endsWith('__cam_view_image')) return next({ ...e, sessionId: await $.session.id() })
    return next(e)
  }).catch(($, e, next) => (next.called ? undefined : next(e)))

  on('ui.render', { component: 'Pane' }, async ($, e, next) => {
    if (e.requestId === PANE) return drawPanel($, e)
    if (e.requestId === PREVIEW) return drawPreview($, e)
    return next(e)
  })

  on('ui.close', async ($, e, next) => {
    if (e.id === PANE) paneOpen = false
    if (e.id === PREVIEW) previewId = null
    return next(e)
  }).catch(($, e, next) => (next.called ? undefined : next(e)))
}

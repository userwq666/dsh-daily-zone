/**
 * 日常区（Daily Zone）—— Host 半侧。
 *
 * 职责只有三件事，全部围绕「缓存」：
 *  1. 对外提供缓存状态与清理动作（同源 HTTP 路由，浏览器半侧调用）；
 *  2. 定时自动清理（`timer.interval`，随插件 effect 一起销毁）；
 *  3. 给模型一个 `daily_zone_cache` 工具，让「完成任务后清一下」可以被主动执行。
 *
 * 清理契约（安全第一，比「清得干净」重要）：
 *  - 只删缓存根目录内的**普通文件**，不跟随符号链接、不删目录；
 *  - 只删 mtime 超过宽限期的文件，绝不碰正在写的临时文件；
 *  - 正在使用的会话工作目录（如日常直连对话）整体跳过。
 */
import { appendFileSync, existsSync, mkdirSync, readdirSync, realpathSync, rmSync, statSync, unlinkSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

/** 与浏览器半侧约定的路由；改这里也要改 client.js。 */
export const STATUS_PATH = '/daily-zone/status'
export const CLEAN_PATH = '/daily-zone/clean'
/** 人工触发的清理先扫过的一层子目录（临时文件都落在这些目录里）。 */
export const SCAN_SUBDIRS = ['tool-output', 'spill', 'tmp']


/**
 * 校验 schema 按 dsh 插件的常规做法从安装侧解析。不同环境下
 * `@deepseek-ai/schemastery` 的解析结果形状并不一致（可能拿到的是命名空间对象
 * 而不是可调用的 Schema），所以逐个候选验证形状；全都不可用时导出 `Config:
 * undefined`，插件照常工作，只是配置不做校验。
 */
async function loadSchemas() {
  for (const specifier of ['@deepseek-ai/schemastery', '@deepseek-ai/cordis/node_modules/@deepseek-ai/schemastery']) {
    try {
      const loaded = await import(specifier)
      for (const candidate of [loaded?.default, loaded, loaded?.default?.default]) {
        if (typeof candidate === 'function' && typeof candidate.string === 'function' && typeof candidate.object === 'function') return candidate
      }
    } catch {
      /* 试下一个 specifier */
    }
  }
  return undefined
}

/** 只有确认形状可用时才给 z 赋值，避免模块加载期抛错。 */
const z = await loadSchemas().catch(() => undefined)

/** 可调参数；全部有默认值，用户也能在 profile patch 里覆盖。 */
export const Config = z === undefined ? undefined : z.object({
  cachePath: z.string().default(''),
  retentionHours: z.number().min(0).max(24 * 365).default(24),
  turnGraceMinutes: z.number().min(0).max(24 * 60).default(30),
  autoCleanEnabled: z.boolean().default(true),
  autoCleanIntervalMinutes: z.number().min(1).max(24 * 60).default(60),
  maxReportedFiles: z.number().min(1).max(200).default(20),
})

const HOME = process.env.DSH_HOME ?? join(homedir(), '.dsh')

/**
 * 默认缓存根目录：优先跟随 DSH 安装目录（桌面端即
 * `D:\DeepSeek Harness\cache`），其次 DSH_HOME，最后回退家目录。
 *
 * 插件是用 `link:` 装进 profile 的，源码在桌面上，所以不能从
 * `import.meta.url` 推安装目录；这里依次看 Electron 的 `resourcesPath`、
 * 启动参数里的 `app.asar` 路径，再看模块自身的路径。
 */
export function defaultCachePath() {
  const fromResources = typeof process.resourcesPath === 'string' && process.resourcesPath.trim() !== ''
    ? resolve(process.resourcesPath, '..', 'cache')
    : ''
  if (fromResources !== '') return fromResources
  const fromAsar = (value) => {
    if (typeof value !== 'string') return ''
    const at = value.indexOf('app.asar')
    return at > 0 ? join(value.slice(0, at), 'cache') : ''
  }
  for (const candidate of [fromAsar(process.argv[1]), fromAsar(process.argv[0])]) {
    if (candidate !== '') return resolve(candidate)
  }
  try {
    const here = fromAsar(fileURLToPath(import.meta.url))
    if (here !== '') return resolve(here)
  } catch {
    /* import.meta.url 不可用时走下面的回退 */
  }
  return join(HOME, 'cache')
}

/** 用安装目录里的 node_modules 之外的一切都不可信，路径必须是绝对路径。 */
export function resolveCachePath(configured) {
  const raw = typeof configured === 'string' && configured.trim() !== '' ? configured.trim() : defaultCachePath()
  return resolve(raw)
}

/** 目录是否存在且是目录；同时保证它存在（新建时）以便后续扫描。 */
function ensureDir(path) {
  try {
    if (!existsSync(path)) mkdirSync(path, { recursive: true })
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

/** JSON 响应；这里直接用 node:http 的 res，route handler 拿到的就是它。 */
function sendJson(res, status, body) {
  const text = JSON.stringify(body)
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(text)
}

function sendMethodNotAllowed(res, allow) {
  res.statusCode = 405
  res.setHeader('allow', allow)
  res.end()
}

/** 路由同样接受 Connection 的 Host/Origin 检查；没有该服务时按本机直连处理。 */
function makeGate(ctx) {
  return (req, res) => {
    const connection = ctx.get('connection')
    if (connection === undefined || typeof connection.requestRejection !== 'function') return false
    let rejection
    try {
      rejection = connection.requestRejection(req)
    } catch {
      return false
    }
    if (rejection === undefined) return false
    res.statusCode = rejection
    res.end()
    return true
  }
}

/** 递归收集缓存根目录下的普通文件（不跟随目录符号链接）。 */
function collectFiles(root, ancestors = []) {
  const files = []
  let entries
  try {
    entries = readdirSync(root, { withFileTypes: true })
  } catch {
    return files
  }
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue
    const full = join(root, entry.name)
    if (entry.isDirectory()) {
      files.push(...collectFiles(full, [...ancestors, entry.name]))
      continue
    }
    if (!entry.isFile()) continue
    let info
    try {
      info = statSync(full)
    } catch {
      continue
    }
    files.push({
      path: full,
      bytes: info.size,
      mtimeMs: info.mtimeMs,
      top: ancestors[0] ?? '',
      temp: /\.(tmp|part|partial|crdownload)$/i.test(entry.name) || entry.name.startsWith('~'),
    })
  }
  return files
}

/** 正在使用的会话工作目录：不清理它们的顶层目录。 */
function activeRoots(ctx, cachePath) {
  const roots = new Set()
  const agents = ctx.get('agents')
  if (agents === undefined || typeof agents.list !== 'function') return roots
  let list
  try {
    list = agents.list()
  } catch {
    return roots
  }
  for (const agent of list ?? []) {
    const cwd = agent?.session?.header?.cwd
    if (typeof cwd !== 'string' || cwd === '') continue
    const full = resolve(cwd)
    const inside = relative(cachePath, full)
    if (inside === '' || (!inside.startsWith('..') && !isAbsolute(inside))) roots.add(full)
  }
  return roots
}

function filterSkipped(files, skipRoots) {
  return files.filter((file) => {
    for (const skip of skipRoots) {
      const rel = relative(skip, file.path)
      if (rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))) return false
    }
    return true
  })
}

/** 只用于展示的目录大小统计；对上万文件也只是一次遍历。 */
export function inspectCache(cachePath, options = {}) {
  const now = Date.now()
  const retentionMs = (Number(options.retentionHours) || 0) * 3600 * 1000
  const graceMs = (Number(options.turnGraceMinutes) || 0) * 60 * 1000
  const all = collectFiles(cachePath)
  const relevant = filterSkipped(all, options.skipRoots ?? [])
  const totalBytes = relevant.reduce((sum, file) => sum + file.bytes, 0)
  const expired = relevant.filter((file) => now - file.mtimeMs >= retentionMs)
  const turnPrunable = relevant.filter((file) => file.temp && now - file.mtimeMs >= graceMs && !expired.includes(file))
  const newest = relevant.reduce((max, file) => Math.max(max, file.mtimeMs), 0)
  return { totalBytes, fileCount: relevant.length, expiredCount: expired.length, turnPrunableCount: turnPrunable.length, newestMtimeMs: newest }
}

function deleteFiles(list, limit) {
  let deleted = 0
  let freedBytes = 0
  const failures = []
  for (const file of list) {
    if (deleted >= limit) break
    try {
      unlinkSync(file.path)
      deleted += 1
      freedBytes += file.bytes
    } catch (error) {
      if (failures.length < 5) failures.push(`${file.path}: ${String(error?.message ?? error)}`)
    }
  }
  return { deleted, freedBytes, failures }
}

function emptyDir(path) {
  let removed = 0
  let entries
  try {
    entries = readdirSync(path, { withFileTypes: true })
  } catch {
    return 0
  }
  for (const entry of entries) {
    const full = join(path, entry.name)
    try {
      rmSync(full, { recursive: true, force: true })
      removed += 1
    } catch {
      /* 单个条目失败不影响其他条目 */
    }
  }
  return removed
}

/** 手动清理：过期文件 + 过期临时文件；`nukeTemp` 时连临时目录一起倒空。 */
export function runCleanup(ctx, config, options = {}) {
  const cachePath = resolveCachePath(config.cachePath)
  const exists = ensureDir(cachePath)
  const mode = options.mode === 'temp' ? 'temp' : options.mode === 'all' ? 'all' : 'expired'
  const skipRoots = activeRoots(ctx, cachePath)
  const now = Date.now()
  const retentionMs = config.retentionHours * 3600 * 1000
  const graceMs = config.turnGraceMinutes * 60 * 1000
  const files = filterSkipped(collectFiles(cachePath), skipRoots)
  const expired = files.filter((file) => now - file.mtimeMs >= retentionMs)
  const temp = files.filter((file) => file.temp && now - file.mtimeMs >= graceMs)

  const removedDirs = []
  if (mode !== 'expired') {
    for (const sub of SCAN_SUBDIRS) {
      const target = join(cachePath, sub)
      let inUse = false
      for (const skip of skipRoots) {
        const rel = relative(skip, target)
        if (rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))) inUse = true
      }
      if (inUse) continue
      if (existsSync(target)) removedDirs.push({ dir: target, entries: emptyDir(target) })
    }
  }

  const targets = mode === 'expired' ? expired : [...new Set([...expired, ...temp])]
  const outcome = deleteFiles(targets, 5000)
  return {
    at: now,
    mode,
    cachePath,
    exists,
    scanned: files.length,
    candidates: targets.length,
    deleted: outcome.deleted,
    freedBytes: outcome.freedBytes,
    emptiedDirs: removedDirs,
    skippedRoots: [...skipRoots],
    failures: outcome.failures,
  }
}

/** 每轮对话结束后的静默清理：只清过期临时文件，且带宽限期。 */
function runTurnCleanup(ctx, config) {
  const cachePath = resolveCachePath(config.cachePath)
  if (!existsSync(cachePath)) return null
  const skipRoots = activeRoots(ctx, cachePath)
  const now = Date.now()
  const graceMs = config.turnGraceMinutes * 60 * 1000
  const files = filterSkipped(collectFiles(cachePath), skipRoots)
  const targets = files.filter((file) => file.temp && now - file.mtimeMs >= graceMs)
  if (targets.length === 0) return null
  return deleteFiles(targets, 500)
}

const TOOL_NAME = 'daily_zone_cache'
const TOOL_PARAMETERS = {
  type: 'object',
  properties: {
    action: {
      type: 'string',
      enum: ['status', 'clean', 'purge-temp'],
      description: 'status reads the cache; clean removes expired files; purge-temp also empties the temporary directories.',
    },
  },
  required: ['action'],
  additionalProperties: false,
}

/** 渲染成给模型看的一行摘要。 */
function summaryOf(status) {
  const mb = (status.totalBytes / (1024 * 1024)).toFixed(1)
  const when = status.newestMtimeMs > 0 ? new Date(status.newestMtimeMs).toISOString() : '空'
  return [
    `缓存目录：${status.cachePath}`,
    `共 ${status.fileCount} 个文件 / ${mb} MB；最近写入：${when}`,
    `已过期：${status.expiredCount}；可清临时文件：${status.turnPrunableCount}`,
    `自动清理：${status.autoClean.enabled ? `每 ${status.autoClean.intervalMinutes} 分钟` : '关闭'}；保留 ${status.retentionHours} 小时；宽限 ${status.turnGraceMinutes} 分钟`,
    status.lastCleanAt > 0 ? `上次清理：${new Date(status.lastCleanAt).toISOString()}（删除 ${status.lastCleanDeleted} 个 / ${(status.lastCleanFreedBytes / (1024 * 1024)).toFixed(1)} MB）` : '上次清理：本次运行内还没有',
    `宿主诊断：webServer=${status.hostDiag?.webServer ?? '?'}；路由=${JSON.stringify(status.hostDiag?.routes ?? [])}；注册错误=${JSON.stringify(status.hostDiag?.registrationErrors ?? [])}`,
  ].join('\n')
}

/**
 * 注册日常区的 Host 半侧。
 * @param ctx - Host 上下文；需要 webServer，timer 可选。
 * @param config - Loader 传入的插件配置（已过 Config 校验）。
 */
export function apply(ctx, config = {}) {
  const settings = {
    cachePath: typeof config.cachePath === 'string' ? config.cachePath : '',
    retentionHours: Number.isFinite(config.retentionHours) ? config.retentionHours : 24,
    turnGraceMinutes: Number.isFinite(config.turnGraceMinutes) ? config.turnGraceMinutes : 30,
    autoCleanEnabled: config.autoCleanEnabled !== false,
    autoCleanIntervalMinutes: Number.isFinite(config.autoCleanIntervalMinutes) ? config.autoCleanIntervalMinutes : 60,
    maxReportedFiles: Number.isFinite(config.maxReportedFiles) ? config.maxReportedFiles : 20,
  }
  const cachePath = resolveCachePath(settings.cachePath)
  /** 日常直连对话的会话工作目录；单独一层，便于人工分辨，也便于清理逻辑跳过。 */
  const chatDir = join(cachePath, 'daily-chat')
  const state = { lastCleanAt: 0, lastCleanDeleted: 0, lastCleanFreedBytes: 0, cleanReason: '' }

  const status = () => {
    // 状态是浏览器半侧创建日常会话前的第一个请求，所以顺手保证两个目录存在。
    ensureDir(cachePath)
    ensureDir(chatDir)
    const inspected = inspectCache(cachePath, { retentionHours: settings.retentionHours, turnGraceMinutes: settings.turnGraceMinutes, skipRoots: activeRoots(ctx, cachePath) })
    return {
      ok: true,
      build: 'dz-3',
      cachePath,
      chatDir,
      cacheExists: existsSync(cachePath),
      retentionHours: settings.retentionHours,
      turnGraceMinutes: settings.turnGraceMinutes,
      autoClean: { enabled: settings.autoCleanEnabled, intervalMinutes: settings.autoCleanIntervalMinutes },
      lastCleanAt: state.lastCleanAt,
      lastCleanDeleted: state.lastCleanDeleted,
      lastCleanFreedBytes: state.lastCleanFreedBytes,
      lastCleanReason: state.cleanReason,
      hostDiag,
      ...inspected,
    }
  }

  const clean = (options) => {
    const result = runCleanup(ctx, settings, options)
    state.lastCleanAt = result.at
    state.lastCleanDeleted = result.deleted
    state.lastCleanFreedBytes = result.freedBytes
    state.cleanReason = options?.reason ?? 'manual'
    if (options?.reason === 'manual' && result.deleted === 0) {
      // 手动清理顺手把过期口径之外的空目录也收掉，避免「点了没反应」的观感。
      for (const sub of SCAN_SUBDIRS) {
        const target = join(cachePath, sub)
        if (existsSync(target)) result.emptiedDirs.push({ dir: target, entries: emptyDir(target) })
      }
    }
    return { ok: true, ...result, status: status() }
  }

  /** 诊断日志：客户端上报的每一步都追加到这里，方便离线排查。 */
  const DIAG_PATH = '/daily-zone/diag'
  const diagFile = join(cachePath, 'diag.jsonl')
  const appendDiag = (entry) => {
    try {
      ensureDir(cachePath)
      appendFileSync(diagFile, `${JSON.stringify(entry)}\n`, 'utf8')
      return true
    } catch {
      return false
    }
  }

  /** 诊断台账：记录服务探测与路由注册结果，供 status 回报。 */
  const hostDiag = { webServer: 'unknown', routes: [], registrationErrors: [] }

  /**
   * 服务获取：优先 ctx.get，拿不到就退回 ctx.inject（延迟到服务出现）。
   * @returns 'direct' | 'injected' | 'missing'
   */
  const withService = (name, use) => {
    let direct
    try {
      direct = ctx.get(name)
    } catch (error) {
      hostDiag.registrationErrors.push(`${name}: get 抛错 ${String(error?.message ?? error)}`)
    }
    if (direct !== undefined && direct !== null) {
      try {
        use(direct)
        return 'direct'
      } catch (error) {
        hostDiag.registrationErrors.push(`${name}: 直接使用失败 ${String(error?.message ?? error)}`)
      }
    }
    if (typeof ctx.inject !== 'function') {
      hostDiag.registrationErrors.push(`${name}: ctx.inject 不可用`)
      return 'missing'
    }
    try {
      ctx.inject([name], (scoped) => {
        const service = scoped?.[name] ?? scoped?.get?.(name)
        if (service === undefined || service === null) {
          hostDiag.registrationErrors.push(`${name}: inject 回调里仍为空`)
          return
        }
        try {
          use(service)
          hostDiag.webServer = `${hostDiag.webServer} | injected`
        } catch (error) {
          hostDiag.registrationErrors.push(`${name}: inject 使用失败 ${String(error?.message ?? error)}`)
        }
      })
      return 'injected'
    } catch (error) {
      hostDiag.registrationErrors.push(`${name}: inject 抛错 ${String(error?.message ?? error)}`)
      return 'missing'
    }
  }

  /** 先探一次，把「直接获取能不能成」记进台账（真正的注册走 withService）。 */
  try {
    const probe = ctx.get('webServer')
    hostDiag.webServer = probe === undefined ? 'undefined' : `ok: ${typeof probe.register}`
  } catch (error) {
    hostDiag.webServer = `get 抛错: ${String(error?.message ?? error)}`
  }

  const rejected = makeGate(ctx)
  const diagMode = withService('webServer', (webServer) => {
    if (typeof webServer.register !== 'function') {
      hostDiag.registrationErrors.push('webServer: 没有 register 方法')
      return
    }
    const tryRegister = (label, register) => {
      try {
        ctx.effect(register, label)
        hostDiag.routes.push(`${label}: 已注册`)
      } catch (error) {
        hostDiag.registrationErrors.push(`${label}: ${String(error?.message ?? error)}`)
      }
    }
    tryRegister(`daily-zone: GET ${STATUS_PATH}`, () => webServer.register({
      kind: 'exact',
      path: STATUS_PATH,
      handler: (req, res) => {
        if (rejected(req, res)) return
        if ((req.method ?? 'GET').toUpperCase() !== 'GET') {
          sendMethodNotAllowed(res, 'GET')
          return
        }
        sendJson(res, 200, status())
      },
    }))
    tryRegister(`daily-zone: POST ${CLEAN_PATH}`, () => webServer.register({
      kind: 'exact',
      path: CLEAN_PATH,
      handler: (req, res) => {
        if (rejected(req, res)) return
        const method = (req.method ?? 'GET').toUpperCase()
        if (method !== 'POST' && method !== 'GET') {
          sendMethodNotAllowed(res, 'GET, POST')
          return
        }
        const url = new URL(String(req.url ?? '/'), 'http://127.0.0.1')
        const mode = url.searchParams.get('mode')
        try {
          sendJson(res, 200, clean({ mode: mode === 'temp' ? 'temp' : 'expired', reason: 'manual' }))
        } catch (error) {
          sendJson(res, 500, { ok: false, message: String(error?.message ?? error) })
        }
      },
    }))
    tryRegister(`daily-zone: POST ${DIAG_PATH}`, () => webServer.register({
      kind: 'exact',
      path: DIAG_PATH,
      handler: async (req, res) => {
        if (rejected(req, res)) {
          appendDiag({ at: Date.now(), rejected: true, method: req.method ?? '', url: String(req.url ?? '') })
          return
        }
        const method = (req.method ?? 'GET').toUpperCase()
        let parsed
        if (method === 'GET') {
          // 页面的 GET 一定能过（status 路由就是 GET），所以诊断主通道走查询串。
          const query = new URL(String(req.url ?? '/'), 'http://127.0.0.1').searchParams
          parsed = { step: query.get('step') ?? '(no step)', data: query.get('data') ?? null }
        } else if (method === 'POST') {
          let body = ''
          try {
            for await (const chunk of req) {
              body += chunk
              if (body.length > 64 * 1024) break
            }
          } catch {
            /* 读不到就当空体 */
          }
          try {
            parsed = JSON.parse(body)
          } catch {
            parsed = { raw: body.slice(0, 500) }
          }
        } else {
          appendDiag({ at: Date.now(), wrongMethod: method, url: String(req.url ?? '') })
          sendMethodNotAllowed(res, 'GET, POST')
          return
        }
        const ok = appendDiag({
          at: Date.now(),
          origin: req.headers.origin ?? '',
          referer: String(req.headers.referer ?? '').slice(0, 120),
          step: typeof parsed?.step === 'string' ? parsed.step : '(no step)',
          data: parsed?.data ?? null,
        })
        sendJson(res, 200, { ok, file: diagFile })
      },
    }))
  })
  hostDiag.webServer = `${hostDiag.webServer} | routes=${diagMode}`

  if (settings.autoCleanEnabled) {
    const intervalMs = Math.max(60_000, settings.autoCleanIntervalMinutes * 60_000)
    withService('timer', (timer) => {
      const start = () => ctx.effect(() => timer.interval(() => {
        try {
          const result = clean({ mode: 'temp', reason: 'auto' })
          if (result.deleted > 0) ctx.logger?.info?.(`daily-zone: 定时清理删除 ${result.deleted} 个文件`)
        } catch (error) {
          ctx.logger?.warn?.(`daily-zone: 定时清理失败 ${String(error?.message ?? error)}`)
        }
      }, intervalMs), 'daily-zone: auto cleanup interval')
      if (typeof timer.interval === 'function') start()
      else hostDiag.registrationErrors.push('timer: 没有 interval 方法')
    })
  }

  ctx.on('agent/turn-stopping', () => {
    const config = settings
    if (!config.autoCleanEnabled || config.turnGraceMinutes <= 0) return
    try {
      const outcome = runTurnCleanup(ctx, config)
      if (outcome !== null && outcome.deleted > 0) {
        state.lastCleanAt = Date.now()
        state.lastCleanDeleted = outcome.deleted
        state.lastCleanFreedBytes = outcome.freedBytes
        state.cleanReason = 'turn'
      }
    } catch {
      /* 清理失败不能影响这一轮的收尾 */
    }
  })

  const tools = ctx.get('tools')
  if (tools !== undefined && typeof tools.register === 'function') {
    ctx.effect(() => tools.register({
      name: TOOL_NAME,
      description: '查看或清理日常区缓存目录（默认 D:\\DeepSeek Harness\\cache）。完成任务后可用 action=clean 清掉过期文件，action=purge-temp 额外倒空临时目录。',
      parameters: TOOL_PARAMETERS,
      output: {
        schema: {
          type: 'object',
          properties: {
            action: { type: 'string' },
            cachePath: { type: 'string' },
            deleted: { type: 'number' },
            freedBytes: { type: 'number' },
            text: { type: 'string' },
          },
          required: ['action', 'text'],
          additionalProperties: true,
        },
        render: (_args, value) => [{ type: 'text', text: String(value?.text ?? '') }],
      },
      async execute(args) {
        const action = args !== null && typeof args === 'object' && typeof args.action === 'string' ? args.action : 'status'
        if (action === 'status') {
          const current = status()
          return { action, cachePath: current.cachePath, chatDir: current.chatDir, deleted: 0, freedBytes: 0, text: summaryOf(current) }
        }
        const result = clean({ mode: action === 'purge-temp' ? 'temp' : 'expired', reason: 'tool' })
        const head = `已清理 ${result.deleted} 个文件，释放 ${(result.freedBytes / (1024 * 1024)).toFixed(1)} MB`
        const dirs = result.emptiedDirs.length > 0 ? `\n已倒空临时目录：${result.emptiedDirs.map((item) => item.dir).join('、')}` : ''
        const failures = result.failures.length > 0 ? `\n部分文件未能删除：\n${result.failures.join('\n')}` : ''
        return {
          action,
          cachePath: result.cachePath,
          chatDir,
          deleted: result.deleted,
          freedBytes: result.freedBytes,
          text: `${head}${dirs}${failures}\n\n${summaryOf(result.status)}`,
        }
      },
    }), 'daily-zone: cache tool')
  }

  ctx.logger?.info?.(`daily-zone: 缓存目录 ${cachePath}，自动清理${settings.autoCleanEnabled ? `每 ${settings.autoCleanIntervalMinutes} 分钟` : '已关闭'}`)
}

export const name = 'daily-zone'

/** 组件行声明 `inject` 会硬性拦截激活，所以这里不声明：路由与定时器都按需探测。 */
export const inject = []

export default { name, apply, Config, inject }

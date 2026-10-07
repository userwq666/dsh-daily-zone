/**
 * 日常区客户端插件的离线冒烟测试。
 *
 * 覆盖四件事：
 *  1. factory / apply / label thunk 不抛错（外壳渲染路径上的异常会让 DSH 启动失败）；
 *  2. 网页面板加载完成后不再常驻提示行（用户明确要求关掉的行为回归）；
 *  3. **真跑一次「直接对话」的 effect**：桩 fetch 返回 chatDir、桩 workspaces 记录调用，
 *     断言它确实「在 chatDir 建/找日常对话工作区 → 改名 → openWorkspace」；
 *  4. 复用路径：工作区已存在时不得重复创建。
 *
 * 用法：node tests/smoke-client.mjs
 */
import { readFileSync } from 'node:fs'

const captured = {}
const calls = { openWorkspace: [], created: [], renamed: [], openSession: [] }
const statusBody = { chatDir: 'D:\\DeepSeek Harness\\cache\\daily-chat', cachePath: 'D:\\DeepSeek Harness\\cache' }
let workspaceList = []

globalThis.window = {
  __ModuleLoader__: { load: (spec) => { captured.factory = spec.factory } },
  open: () => {},
  setTimeout: (fn) => { try { fn() } catch { /* 忽略重试路径 */ } return 0 },
  clearTimeout: () => {},
  clearInterval: () => {},
  setInterval: () => 0,
  localStorage: { getItem: () => null, setItem: () => {} },
}
globalThis.document = { title: '' }
globalThis.fetch = async (url) => {
  if (String(url).includes('/daily-zone/status')) return { ok: true, status: 200, json: async () => statusBody }
  return { ok: false, status: 404, json: async () => ({}) }
}

const states = []
const cursor = { index: 0 }
const pendingEffects = []
let effectsRun = 0

/** 让出若干轮微任务，等 effect 启动的 promise 链跑完。 */
async function settle(rounds = 12) {
  for (let i = 0; i < rounds; i += 1) await Promise.resolve()
  await Promise.allSettled(pendingEffects)
}
class StubComponent {
  constructor(props) { this.props = props ?? {} }
}
const React = {
  Component: StubComponent,
  Fragment: 'Fragment',
  createElement: (type, props, ...children) => ({
    type,
    props: props ?? {},
    children: children.flat().filter((child) => child !== null && child !== undefined && child !== false),
  }),
  useState: (initial) => {
    const index = cursor.index++
    if (states[index] === undefined) states[index] = typeof initial === 'function' ? initial() : initial
    return [states[index], (next) => { states[index] = typeof next === 'function' ? next(states[index]) : next }]
  },
  useRef: (initial) => { const index = cursor.index++; states[index] ??= { current: initial }; return states[index] },
  useCallback: (fn) => { cursor.index++; return fn },
  useEffect: (fn) => {
    cursor.index++
    // 真的跑一次 effect——这是「点一次直接对话」的真正入口。
    // 注意 effect 常常只「启动」异步而不返回它，所以测试用「让出若干微任务」
    // 等这条链走完，而不是等 effect 的返回值。
    effectsRun += 1
    const result = fn()
    if (result !== undefined) pendingEffects.push(Promise.resolve(result))
  },
}

const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
new Function('require', 'window', 'console', 'document', 'fetch', source)(
  (name) => { if (name === 'react') return React; throw new Error(`unexpected require: ${name}`) },
  globalThis.window,
  { error: (...args) => console.log('  [plugin error]', ...args), log: () => {}, info: () => {}, warn: () => {} },
  globalThis.document,
  globalThis.fetch,
)

if (captured.factory === undefined) throw new Error('factory was not registered')
console.log('1) factory 注册 ok, id =', captured.id)

const plugin = captured.factory((name) => { if (name === 'react') return React; throw new Error(name) })
console.log('2) factory 执行 ok, name =', plugin.name, ', inject =', JSON.stringify(plugin.inject))

// —— 桩外壳 ——
const registrations = []
const slots = {
  inject: (_key, callback) => callback(),
  register: (options, render) => { registrations.push({ options, render }); return () => {} },
  entriesOfSlot: () => [],
  entries: () => [],
  subscribe: () => () => {},
}
const workspaces = {
  list: { getSnapshot: () => ({ items: workspaceList, archivedSessionIds: [], pinnedSessionIds: [], phase: 'ready' }) },
  create: async ({ path }) => {
    const view = { workspaceId: 'ws-daily-1', path, title: 'cache', sessionIds: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }
    calls.created.push(path)
    workspaceList = [view]
    return view
  },
  rename: async (workspaceId, title) => {
    calls.renamed.push([workspaceId, title])
    const view = { ...workspaceList[0], title }
    workspaceList = [view]
    return view
  },
}
const services = {
  slots,
  layout: { selectPanel: () => {}, toggleSidebar: () => {}, beginNavigation: () => new AbortController().signal },
  locale: { getSnapshot: () => ({ active: 'zh' }), subscribe: () => () => {} },
  workspaces,
  sessions: { create: async () => 'session-should-not-be-used', list: { getSnapshot: () => ({ ids: [], byId: {} }) } },
  uiWorkspace: {
    openWorkspace: async (workspaceId) => { calls.openWorkspace.push(workspaceId) },
    openSession: (id) => { calls.openSession.push(id) },
    archiveSession: async () => {},
  },
}
const ctx = {
  get: (name) => services[name],
  effect: (callback) => { callback(); return () => {} },
  on: () => () => {},
  provide: () => () => {},
}

cursor.index = 0
states.length = 0
plugin.apply(ctx)
console.log('3) apply ok, 注册数 =', registrations.length)

function renderDeep(node) {
  if (node === null || node === undefined || typeof node !== 'object') return node
  if (Array.isArray(node)) return node.map(renderDeep)
  if (typeof node.type === 'function' && node.type.prototype instanceof StubComponent) {
    const props = { ...node.props, children: node.children?.length === 1 ? node.children[0] : node.children }
    const instance = new node.type(props)
    instance.props = props
    instance.setState = (next) => { instance.state = { ...(instance.state ?? {}), ...next } }
    return renderDeep(instance.render())
  }
  if (typeof node.type === 'function') return renderDeep(node.type(node.props))
  return { ...node, children: (node.children ?? []).map(renderDeep) }
}

function classNames(node, out = []) {
  if (node === null || node === undefined || typeof node !== 'object') return out
  if (Array.isArray(node)) { for (const item of node) classNames(item, out); return out }
  if (typeof node.props?.className === 'string') out.push(node.props.className)
  classNames(node.children, out)
  return out
}

function findByClass(node, className) {
  if (node === null || node === undefined || typeof node !== 'object') return undefined
  if (Array.isArray(node)) {
    for (const item of node) { const hit = findByClass(item, className); if (hit !== undefined) return hit }
    return undefined
  }
  if (node.props?.className === className) return node
  return findByClass(node.children, className)
}

let labels = 0
for (const entry of registrations) {
  if (typeof entry.options.label !== 'function') continue
  const text = entry.options.label()
  if (typeof text !== 'string' || text.length === 0) throw new Error(`label 非字符串: ${JSON.stringify(text)}`)
  labels += 1
}
console.log(`4) ${labels} 个 label thunk ok`)

// 面板渲染（网页面板额外验证「加载后无提示行」）
for (const entry of registrations.filter((item) => item.options.name === 'main')) {
  const key = entry.options.key
  const isWeb = key.startsWith('daily-zone-web-')
  cursor.index = 0
  states.length = 0
  pendingEffects.length = 0
  const first = renderDeep(entry.render())
  const classes = classNames(first)
  if (!classes.includes(isWeb ? 'dz-root' : 'dz-wrap')) throw new Error(`面板 ${key} 根容器不对`)
  if (!isWeb) {
    console.log(`5) 面板 ${key} 渲染 ok`)
    continue
  }
  const frame = findByClass(first, 'dz-frame')
  if (frame === undefined) {
    if (classes.includes('dz-splash')) {
      console.log(`5) 面板 ${key}：被拒站点显示说明卡片 ✓`)
      continue
    }
    throw new Error(`面板 ${key} 既没有 iframe 也没有说明卡片`)
  }
  frame.props.onLoad()
  cursor.index = 0
  const loaded = classNames(renderDeep(entry.render()))
  if (loaded.includes('dz-hint')) throw new Error(`面板 ${key} 加载后仍有提示行`)
  console.log(`5) 面板 ${key}：加载后无提示行 ✓`)
}

// 上面遍历面板时可能已经触发过「直接对话」的 effect，先结算干净再进显式用例，
// 否则残留的异步会让计数翻倍、还会把工作区提前建好（这坑真踩过）。
await settle()

// —— 关键回归：真跑一次「直接对话」（工作区尚不存在的创建路径） ——
calls.created.length = 0
calls.renamed.length = 0
calls.openWorkspace.length = 0
calls.openSession.length = 0
workspaceList = []
const chatEntry = registrations.find((item) => item.options.name === 'main' && item.options.key === 'daily-zone-chat')
cursor.index = 0
states.length = 0
pendingEffects.length = 0
effectsRun = 0
renderDeep(chatEntry.render())
if (effectsRun === 0) throw new Error('直接对话面板挂载后没有执行任何 effect（点了不会有反应）')
console.log('6) 面板挂载执行 effect 数 =', effectsRun)
await settle()
console.log('   调用记录:', JSON.stringify({ created: calls.created, renamed: calls.renamed, openWorkspace: calls.openWorkspace }))

if (calls.created.length !== 1 || calls.created[0] !== statusBody.chatDir) {
  throw new Error(`没有在 chatDir 上建工作区，created=${JSON.stringify(calls.created)}`)
}
if (calls.renamed.length !== 1 || calls.renamed[0][1] !== '日常对话') {
  throw new Error(`没有把工作区改名为「日常对话」，renamed=${JSON.stringify(calls.renamed)}`)
}
if (calls.openWorkspace.length !== 1 || calls.openWorkspace[0] !== 'ws-daily-1') {
  throw new Error(`没有 openWorkspace，openWorkspace=${JSON.stringify(calls.openWorkspace)}`)
}
if (calls.openSession.length !== 0) throw new Error('不应再走 openSession（那会被启动恢复抢走）')
if (document.title.startsWith('[dz]') === false) throw new Error('台账没有写入标题')
console.log('7) 断言通过：建工作区 → 改名「日常对话」→ openWorkspace；标题 =', JSON.stringify(document.title.slice(0, 48)))

// —— 复用路径 ——
calls.created.length = 0
calls.renamed.length = 0
calls.openWorkspace.length = 0
workspaceList = [{
  workspaceId: 'ws-daily-1',
  path: statusBody.chatDir,
  title: '日常对话',
  sessionIds: [],
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
}]
cursor.index = 0
states.length = 0
pendingEffects.length = 0
effectsRun = 0
renderDeep(chatEntry.render())
await settle()
if (calls.created.length !== 0) throw new Error(`工作区已存在却又创建：${JSON.stringify(calls.created)}`)
if (calls.openWorkspace[0] !== 'ws-daily-1') throw new Error('复用时没有打开已存在的日常工作区')
console.log('8) 复用路径 ok：已存在时不再创建，直接打开')

console.log('\n全部通过：注册 / 面板 / 工作区创建与复用 / 台账 都符合预期')

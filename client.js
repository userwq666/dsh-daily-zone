/**
 * 日常区（Daily Zone）—— 浏览器半侧。
 *
 * 侧边栏「日常区」两个入口：
 *  1. 豆包：主面板内嵌 `https://www.doubao.com/chat/`；
 *  2. 直接对话：在缓存目录里复用/新建空白会话，直接切到对话界面，不选工作区。
 *
 * 只 require React，不 import 任何 Harness Client 包；样式全部走主题 token。
 *
 * 硬化约定（违反任意一条都会拖垮整个 web 启动，实测过）：
 *  - 任何会被**外壳渲染路径**调用的函数（label thunk、图标、面板 body）都过 `safe()`；
 *  - 面板 body 再套 `PanelBoundary`，渲染期异常同样被兜住；
 *  - `apply()` 全流程 try/catch，注册失败只是少几个入口，不影响 DSH 启动。
 */
window.__ModuleLoader__.load({
  id: 'dsh-daily-zone',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    /** 启动心跳：确认「客户端半侧此刻活着」，与任何点击无关。 */
    const beat = (step) => {
      try {
        void Promise.race([
          fetch('/daily-zone/diag?step=' + encodeURIComponent(step), { method: 'GET' }).catch(() => {}),
          new Promise((resolve) => { try { window.setTimeout(resolve, 1500) } catch { resolve() } }),
        ])
      } catch {
        /* 心跳失败不影响任何功能 */
      }
    }
    beat('client factory loaded')

    const NS = 'daily-zone'
    const CACHE_BASE = '/daily-zone'
    /**
     * 默认缓存目录：与 profile patch 里的 `cachePath` 保持一致。
     * 客户端拿它当首选路径——HTTP 路由是「覆盖来源」，不是「必需前提」，
     * 否则宿主路由一旦注册失败，整个「直接对话」就跟着废掉（踩过这个坑）。
     */
    const DEFAULT_CACHE_ROOT = 'D:\\DeepSeek Harness\\cache'
    const DEFAULT_CHAT_DIR = `${DEFAULT_CACHE_ROOT}\\daily-chat`

    const DICTS = {
      zh: {
        'group.title': '日常区',
        'row.doubao': '豆包',
        'row.chat': '直接对话',
        'web.hint': '内嵌页面由第三方站点决定是否允许被嵌入；被拒绝时请用「右侧栏打开」。',
        'web.open': '系统浏览器打开',
        'web.sidebar': '右侧栏打开',
        'web.reload': '刷新',
        'web.force': '仍然尝试内嵌',
        'web.blockedTitle': '{site} 不允许被内嵌',
        'web.blockedBody': '该站点的安全策略（frame-ancestors / X-Frame-Options）禁止在其它页面里显示它，所以这里无法内嵌。点「右侧栏打开」会在 DSH 右侧栏里用内置浏览器打开。',
        'web.failed': '内嵌加载失败',
        'web.loading': '加载中…',
        'chat.opening': '正在准备日常会话…',
        'chat.reused': '已切到日常会话（原先那张空白会话，等于新对话）。',
        'chat.created': '已新建日常会话。',
        'chat.done': '会话已就绪，正在切换到对话界面。',
        'chat.failed': '无法创建会话：{message}',
        'chat.retry': '重试',
        'chat.workspace': '日常对话',
        'chat.selfTest': '自检',
        'chat.selfTestRunning': '正在自检…',
        'chat.selfTestDone': '自检完成，结果见下方。',
        'panel.status': '缓存状态',
        'panel.files': '文件数',
        'panel.size': '占用',
        'panel.expired': '已过期',
        'panel.temp': '可清临时文件',
        'panel.lastClean': '上次清理',
        'panel.never': '本次运行内还没有',
        'panel.retention': '保留 {hours} 小时 · 宽限 {grace} 分钟',
        'panel.autoOn': '自动清理：每 {minutes} 分钟',
        'panel.autoOff': '自动清理：已关闭',
        'panel.clean': '清理过期文件',
        'panel.purge': '清空临时文件',
        'panel.refresh': '刷新状态',
        'panel.cleaning': '清理中…',
        'panel.cleaned': '已删除 {count} 个文件，释放 {size}',
        'panel.nothing': '没有需要清理的文件',
        'panel.error': '读取缓存失败：{message}',
        'panel.crashed': '日常区面板渲染出错，其它功能不受影响。',
      },
      en: {
        'group.title': 'Daily',
        'row.doubao': 'Doubao',
        'row.chat': 'Direct chat',
        'web.hint': 'Embedding is decided by the site itself. If it refuses, use "Open in sidebar".',
        'web.open': 'Open in browser',
        'web.sidebar': 'Open in sidebar',
        'web.reload': 'Reload',
        'web.force': 'Try embedding anyway',
        'web.blockedTitle': '{site} refuses to be embedded',
        'web.blockedBody': 'This site forbids being displayed inside another page (frame-ancestors / X-Frame-Options), so it cannot be embedded here. "Open in sidebar" shows it in the DSH right sidebar with the built-in browser.',
        'web.failed': 'Embedded page failed to load',
        'web.loading': 'Loading…',
        'chat.opening': 'Preparing the daily session…',
        'chat.reused': 'Switched to the daily session (the previously empty one, so it is a new conversation).',
        'chat.created': 'Created a new daily session.',
        'chat.done': 'Session ready, switching to the conversation.',
        'chat.failed': 'Could not create a session: {message}',
        'chat.retry': 'Retry',
        'chat.workspace': 'Daily chat',
        'chat.selfTest': 'Self-test',
        'chat.selfTestRunning': 'Running self-test…',
        'chat.selfTestDone': 'Self-test finished; results below.',
        'panel.status': 'Cache status',
        'panel.files': 'Files',
        'panel.size': 'Size',
        'panel.expired': 'Expired',
        'panel.temp': 'Purgeable temp files',
        'panel.lastClean': 'Last cleanup',
        'panel.never': 'Not yet in this run',
        'panel.retention': 'Retain {hours}h · grace {grace}m',
        'panel.autoOn': 'Auto cleanup: every {minutes} min',
        'panel.autoOff': 'Auto cleanup: off',
        'panel.clean': 'Clean expired files',
        'panel.purge': 'Empty temp files',
        'panel.refresh': 'Refresh',
        'panel.cleaning': 'Cleaning…',
        'panel.cleaned': 'Deleted {count} files, freed {size}',
        'panel.nothing': 'Nothing to clean',
        'panel.error': 'Cache read failed: {message}',
        'panel.crashed': 'The Daily Zone panel failed to render; nothing else is affected.',
      },
    }

    /**
     * 把函数包成「绝不抛错」的版本：出错时记录并返回兜底值。
     * 外壳会调用插件提供的 label thunk 与面板组件，一个异常就能让整个侧栏条目
     * 激活失败（实测会让 web 启动失败），所以这是硬约束。
     */
    function safe(fn, fallback, label) {
      return (...args) => {
        try {
          return fn(...args)
        } catch (error) {
          try {
            console.error(`[daily-zone] ${label} failed:`, error)
          } catch {
            /* 日志本身失败也要吞掉 */
          }
          return fallback
        }
      }
    }

    /** 点「直接对话」时的进度台账；写进标题，用户一眼能读。 */
    /** 把这一步同时上报给宿主，写进 cache/diag.jsonl（fire-and-forget）。 */
    const report = (step, data) => {
      try {
        // 纯 GET + 查询串：POST 会被这个服务的信任层挡掉，而 GET 一定通。
        const url = `${CACHE_BASE}/diag?step=${encodeURIComponent(String(step).slice(0, 300))}`
          + (data === undefined ? '' : `&data=${encodeURIComponent(JSON.stringify(data).slice(0, 800))}`)
        void Promise.race([
          fetch(url, { method: 'GET', headers: { accept: 'application/json' } }).catch(() => {}),
          new Promise((resolve) => { try { window.setTimeout(resolve, 1500) } catch { resolve() } }),
        ])
      } catch {
        /* 上报失败不影响主流程 */
      }
    }

    const trace = (step) => {
      const line = `${new Date().toLocaleTimeString()} ${step}`
      try {
        window.localStorage.setItem('dsh.daily-zone.last-run', line)
      } catch {
        /* 无所谓 */
      }
      try {
        const base = String(document.title ?? '').replace(/^\[dz\]\s*/, '')
        document.title = `[dz] ${step} | ${base}`
      } catch {
        /* 无所谓 */
      }
      try {
        console.info('[daily-zone]', step)
      } catch {
        /* 无所谓 */
      }
      report(step)
    }

    /** 当前 apply 拿到的 ctx；translate 只从这里读 locale。 */
    const ctx0 = { current: undefined }

    /** 词典查找；locale 服务缺失或抛错都退回中文。 */
    const translate = safe((key, params) => {
      let active = 'zh'
      try {
        const snapshot = ctx0.current?.get?.('locale')?.getSnapshot?.()
        if (snapshot !== null && snapshot !== undefined && typeof snapshot.active === 'string') active = snapshot.active
      } catch {
        /* 读取失败按中文处理 */
      }
      const dict = DICTS[active] ?? DICTS.en
      let text = dict[key] ?? DICTS.en[key] ?? key
      for (const [name, value] of Object.entries(params ?? {})) text = text.replaceAll(`{${name}}`, String(value))
      return text
    }, '', 'translate')

    /** 主题 token 只在本组件内部生效，组件卸载随之消失。 */
    function StyleTag() {
      return h('style', {
        'data-plugin': 'dsh-daily-zone',
        dangerouslySetInnerHTML: {
          __html: [
            '.dz-root{display:flex;flex-direction:column;height:100%;min-height:0;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary)}',
            '.dz-bar{display:flex;align-items:center;gap:8px;padding:10px 14px;border-bottom:.5px solid var(--dsw-alias-border-l1);flex:none}',
            '.dz-title{font-size:13px;color:var(--dsw-alias-label-primary);font-weight:500;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
            '.dz-spacer{flex:1;min-width:0}',
            '.dz-hint{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);padding:6px 14px;flex:none}',
            '.dz-btn{appearance:none;border:none;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;padding:4px 8px;border-radius:6px;cursor:pointer;text-decoration:none}',
            '.dz-btn:hover{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}',
            '.dz-btn:disabled{opacity:.5;cursor:default}',
            '.dz-btn[data-primary="true"]{background:var(--dsw-alias-brand-primary);color:#fff}',
            '.dz-frame{flex:1;min-height:0;position:relative;border:none;width:100%}',
            '.dz-splash{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;font-size:13px;color:var(--dsw-alias-label-secondary);text-align:center;padding:24px}',
            '.dz-card{max-width:520px;width:100%;border:.5px solid var(--dsw-alias-border-l1);border-radius:12px;padding:18px 20px;background:var(--dsw-alias-bg-layer-1);display:flex;flex-direction:column;gap:12px}',
            '.dz-cardTitle{font-size:15px;font-weight:500;color:var(--dsw-alias-label-primary)}',
            '.dz-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}',
            '.dz-cell{border:.5px solid var(--dsw-alias-border-l1);border-radius:10px;padding:10px 12px;background:var(--dsw-alias-bg-layer-2)}',
            '.dz-cellLabel{font-size:12px;color:var(--dsw-alias-label-secondary)}',
            '.dz-cellValue{font-size:16px;color:var(--dsw-alias-label-primary);margin-top:2px}',
            '.dz-meta{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}',
            '.dz-actions{display:flex;gap:8px;flex-wrap:wrap}',
            '.dz-note{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}',
            '.dz-error{color:var(--dsw-alias-state-error-primary)}',
            '.dz-wrap{height:100%;display:flex;align-items:center;justify-content:center;padding:24px;background:var(--dsw-alias-bg-base)}',
          ].join('\n'),
        },
      })
    }

    function formatBytes(bytes) {
      const value = Number(bytes) || 0
      if (value < 1024) return `${value} B`
      if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`
      if (value < 1024 * 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(1)} MB`
      return `${(value / (1024 * 1024 * 1024)).toFixed(2)} GB`
    }

    function formatTime(ms) {
      if (!ms) return ''
      try {
        return new Date(ms).toLocaleString()
      } catch {
        return String(ms)
      }
    }

    /**
     * 打开站点的内嵌浏览器标签（DSH 桌面端右侧栏的 Browser tab）。
     * @returns true 表示已交给右侧栏；false 时调用方应退回新窗口。
     */
    function openBrowserTab(ctx, url) {
      try {
        const registry = ctx.get('sidebarRightTabs')
        if (registry === undefined || typeof registry.get !== 'function' || registry.get('browser') === undefined) return false
        const sidebarRight = ctx.get('sidebarRight')
        if (sidebarRight === undefined || typeof sidebarRight.openTab !== 'function') return false
        sidebarRight.openTab('browser', { params: { url } })
        return true
      } catch {
        return false
      }
    }

    /** 新窗口打开；桌面端由主进程决定是否交给系统浏览器。 */
    function openExternal(url) {
      try {
        window.open(url, '_blank', 'noopener,noreferrer')
      } catch {
        /* 被拦截时页面上还有普通链接可用 */
      }
    }

    /**
     * 内嵌网页主面板。站点可以拒绝被嵌入（例如 DeepSeek 的 CSP 是
     * `frame-ancestors 'none'`），此时浏览器不给可用失败信号，所以已知会拒绝
     * 的站点直接呈现说明卡片。
     */
    function WebPanel(props) {
      const t = props.t
      const [phase, setPhase] = React.useState('loading')
      const [forced, setForced] = React.useState(false)
      const [nonce, setNonce] = React.useState(0)
      const showFrame = forced || !props.knownBlocked
      const blocked = props.knownBlocked && !forced
      React.useEffect(() => {
        if (!blocked) return
        // 已知被拒：直接把页面交给右侧栏的内置浏览器。
        if (!openBrowserTab(props.ctx, props.url)) openExternal(props.url)
      }, [])
      const openInBrowser = () => {
        if (!openBrowserTab(props.ctx, props.url)) openExternal(props.url)
      }
      const bar = h('div', { className: 'dz-bar' },
        h('span', { className: 'dz-title' }, `${t('group.title')} · ${props.site}`),
        h('span', { className: 'dz-spacer' }),
        showFrame ? h('button', { type: 'button', className: 'dz-btn', onClick: () => { setPhase('loading'); setNonce((n) => n + 1) } }, t('web.reload')) : null,
        h('button', { type: 'button', className: 'dz-btn', onClick: openInBrowser }, t('web.sidebar')),
        h('a', { className: 'dz-btn', href: props.url, target: '_blank', rel: 'noreferrer noopener' }, t('web.open')),
      )
      if (!showFrame) {
        return h(React.Fragment, null,
          h(StyleTag),
          h('div', { className: 'dz-root' },
            bar,
            h('div', { className: 'dz-splash' },
              h('div', { className: 'dz-card' },
                h('div', { className: 'dz-cardTitle' }, t('web.blockedTitle', { site: props.site })),
                h('div', { className: 'dz-note' }, t('web.blockedBody')),
                h('div', { className: 'dz-actions' },
                  h('button', { type: 'button', className: 'dz-btn', 'data-primary': 'true', onClick: openInBrowser }, t('web.sidebar')),
                  h('button', { type: 'button', className: 'dz-btn', onClick: () => setForced(true) }, t('web.force')),
                  h('a', { className: 'dz-btn', href: props.url, target: '_blank', rel: 'noreferrer noopener' }, t('web.open')),
                ),
              ),
            ),
          ),
        )
      }
      const frameUrl = `${props.url}${props.url.includes('?') ? '&' : '?'}dz=${nonce}`
      return h(React.Fragment, null,
        h(StyleTag),
        h('div', { className: 'dz-root' },
          bar,
          // 加载完成后不再常驻任何提示：只留工具栏，页面占满整块面板。
          phase === 'loaded'
            ? null
            : h('div', { className: 'dz-hint' }, phase === 'error' ? t('web.failed') : t('web.loading')),
          h('iframe', {
            key: nonce,
            className: 'dz-frame',
            src: frameUrl,
            title: `${props.site} web`,
            referrerPolicy: 'no-referrer',
            // 不加 sandbox：内嵌站点本来就跨域、读不到 DSH 的 DOM 与存储，去掉沙箱后
            // 下载、弹窗与站点自身的存储行为更接近正常浏览器（DSH 内置浏览器在兼容
            // 模式下也是这个取舍）。代价是该 frame 内页面可按浏览器规则导航顶层应用，
            // 所以工具栏始终保留「系统浏览器打开」。
            allow: 'clipboard-read; clipboard-write; microphone; camera',
            onLoad: () => setPhase((current) => (current === 'loading' ? 'loaded' : current)),
            onError: () => setPhase('error'),
          }),
        ),
      )
    }

    /** 直连对话面板：挂载时准备缓存目录里的会话，然后切回对话界面。 */
    function ChatPanel(props) {
      const t = props.t
      const [state, setState] = React.useState({ phase: 'working' })
      const started = React.useRef(false)
      const [probe, setProbe] = React.useState(undefined)
      const rememberProbe = (lines) => {
        try {
          window.localStorage.setItem('dsh.daily-zone.last-self-test', JSON.stringify({ at: new Date().toISOString(), lines }))
        } catch {
          /* 存储被禁用时无所谓 */
        }
        try {
          console.info('[daily-zone] self-test', lines)
        } catch {
          /* 无所谓 */
        }
      }
      const runSelfTest = React.useCallback(() => {
        setProbe({ phase: 'running' })
        Promise.resolve()
          .then(() => selfTest(props.ctx))
          .then((lines) => { rememberProbe(lines); setProbe({ phase: 'done', lines }) })
          .catch((error) => {
            const lines = [String(error?.message ?? error)]
            rememberProbe(lines)
            setProbe({ phase: 'done', lines })
          })
      }, [])
      const run = React.useCallback(() => {
        setState({ phase: 'working' })
        Promise.resolve()
          .then(() => props.startDailyChat())
          .then((result) => {
            if (result?.ok) {
              setState({ phase: 'done', reused: result.createdLabel === 'reused' })
              // 会话已经打开，这一页通常已被 Replace 掉；万一 Host 半侧没返回
              // sessionId，也要自己收起面板，别把用户卡在这一页。
              // 打开成功才收起；失败时留在原地，把原因显示给用户。
              props.dismiss?.()
              return
            }
            setState({ phase: 'failed', message: result?.message ?? String(result) })
          })
          .catch((error) => setState({ phase: 'failed', message: String(error?.message ?? error) }))
      }, [])
      React.useEffect(() => {
        if (started.current) return
        started.current = true
        run()
      }, [run])
      return h(React.Fragment, null,
        h(StyleTag),
        h('div', { className: 'dz-wrap' },
          h('div', { className: 'dz-card' },
            h('div', { className: 'dz-cardTitle' }, t('row.chat')),
            h('div', { className: state.phase === 'failed' ? 'dz-note dz-error' : 'dz-note' },
              state.phase === 'working'
                ? t('chat.opening')
                : state.phase === 'done'
                  ? (state.reused === false ? t('chat.created') : t('chat.reused'))
                  : t('chat.failed', { message: state.message ?? '' }),
            ),
            state.phase === 'failed' ? h('div', { className: 'dz-actions' }, h('button', { type: 'button', className: 'dz-btn', 'data-primary': 'true', onClick: run }, t('chat.retry'))) : null,
            probe === undefined
              ? h('div', { className: 'dz-actions' }, h('button', { type: 'button', className: 'dz-btn', onClick: runSelfTest }, t('chat.selfTest')))
              : h('div', { className: 'dz-note' },
                h('div', null, probe.phase === 'running' ? t('chat.selfTestRunning') : t('chat.selfTestDone')),
                ...(probe.lines ?? []).map((line, index) => h('div', {
                  key: index,
                  style: { fontFamily: 'ui-monospace, monospace', wordBreak: 'break-all', marginTop: 2 },
                }, line)),
              ),
          ),
        ),
      )
    }

    /** 缓存状态与手动清理。 */
    function CachePanel(props) {
      const t = props.t
      const [status, setStatus] = React.useState({ phase: 'loading' })
      const [busy, setBusy] = React.useState('')
      const [notice, setNotice] = React.useState('')
      const refresh = React.useCallback(async () => {
        try {
          const response = await fetch(`${CACHE_BASE}/status`, { headers: { accept: 'application/json' } })
          if (!response.ok) throw new Error(`HTTP ${response.status}`)
          setStatus({ phase: 'ready', value: await response.json() })
        } catch (error) {
          setStatus({ phase: 'failed', message: String(error?.message ?? error) })
        }
      }, [])
      React.useEffect(() => {
        let alive = true
        void refresh()
        const timer = window.setInterval(() => { if (alive) void refresh() }, 15000)
        return () => { alive = false; window.clearInterval(timer) }
      }, [refresh])
      const clean = async (mode) => {
        setBusy(mode)
        setNotice('')
        try {
          const response = await fetch(`${CACHE_BASE}/clean?mode=${mode}`, { method: 'POST', headers: { accept: 'application/json' } })
          if (!response.ok) throw new Error(`HTTP ${response.status}`)
          const result = await response.json()
          setNotice(result.deleted > 0 ? t('panel.cleaned', { count: result.deleted, size: formatBytes(result.freedBytes) }) : t('panel.nothing'))
          if (result.status !== undefined) setStatus({ phase: 'ready', value: result.status })
          else await refresh()
        } catch (error) {
          setNotice(t('panel.error', { message: String(error?.message ?? error) }))
        } finally {
          setBusy('')
        }
      }
      const value = status.phase === 'ready' ? status.value : undefined
      return h(React.Fragment, null,
        h(StyleTag),
        h('div', { className: 'dz-root' },
          h('div', { className: 'dz-bar' },
            h('span', { className: 'dz-title' }, `${t('group.title')} · ${t('panel.status')}`),
            h('span', { className: 'dz-spacer' }),
            h('button', { type: 'button', className: 'dz-btn', onClick: () => void refresh() }, t('panel.refresh')),
          ),
          h('div', { className: 'dz-hint' }, value?.cachePath ?? CACHE_BASE),
          h('div', { style: { padding: '0 14px 14px', overflow: 'auto' } },
            status.phase === 'failed'
              ? h('div', { className: 'dz-note dz-error' }, t('panel.error', { message: status.message }))
              : h('div', { className: 'dz-card' },
                h('div', { className: 'dz-grid' },
                  h('div', { className: 'dz-cell' }, h('div', { className: 'dz-cellLabel' }, t('panel.files')), h('div', { className: 'dz-cellValue' }, value ? String(value.fileCount) : '—')),
                  h('div', { className: 'dz-cell' }, h('div', { className: 'dz-cellLabel' }, t('panel.size')), h('div', { className: 'dz-cellValue' }, value ? formatBytes(value.totalBytes) : '—')),
                  h('div', { className: 'dz-cell' }, h('div', { className: 'dz-cellLabel' }, t('panel.expired')), h('div', { className: 'dz-cellValue' }, value ? String(value.expiredCount) : '—')),
                  h('div', { className: 'dz-cell' }, h('div', { className: 'dz-cellLabel' }, t('panel.temp')), h('div', { className: 'dz-cellValue' }, value ? String(value.turnPrunableCount) : '—')),
                ),
                h('div', { className: 'dz-meta' },
                  value ? t('panel.retention', { hours: value.retentionHours, grace: value.turnGraceMinutes }) : '',
                  h('br'),
                  value ? (value.autoClean?.enabled ? t('panel.autoOn', { minutes: value.autoClean.intervalMinutes }) : t('panel.autoOff')) : '',
                ),
                h('div', { className: 'dz-meta' },
                  `${t('panel.lastClean')}：`,
                  value && value.lastCleanAt > 0 ? `${formatTime(value.lastCleanAt)}（${value.lastCleanDeleted} / ${formatBytes(value.lastCleanFreedBytes)}）` : t('panel.never'),
                ),
                h('div', { className: 'dz-actions' },
                  h('button', { type: 'button', className: 'dz-btn', 'data-primary': 'true', disabled: busy !== '', onClick: () => void clean('expired') }, busy === 'expired' ? t('panel.cleaning') : t('panel.clean')),
                  h('button', { type: 'button', className: 'dz-btn', disabled: busy !== '', onClick: () => void clean('temp') }, busy === 'temp' ? t('panel.cleaning') : t('panel.purge')),
                ),
                notice !== '' ? h('div', { className: 'dz-note' }, notice) : null,
                h('div', { className: 'dz-note' }, t('web.hint')),
              ),
          ),
        ),
      )
    }

    // —— 侧栏图标：单色，currentColor 跟随主题 ——

    function IconDoubao(props) {
      const size = props.size ?? 16
      return h('svg', { width: size, height: size, viewBox: '0 0 16 16', 'aria-hidden': true, fill: 'none' },
        h('path', { d: 'M8 1.8c-3.6 0-6.2 2.4-6.2 5.6 0 1.2.4 2.3 1.1 3.2-.2.9-.6 1.7-1.2 2.4 1.2.1 2.2-.2 3.1-.7.9.5 2 .7 3.2.7 3.6 0 6.2-2.4 6.2-5.6S11.6 1.8 8 1.8Z', stroke: 'currentColor', strokeWidth: 1.2, strokeLinejoin: 'round' }),
        h('circle', { cx: 6.1, cy: 7.2, r: 0.9, fill: 'currentColor' }),
        h('circle', { cx: 9.9, cy: 7.2, r: 0.9, fill: 'currentColor' }),
      )
    }

    function IconChat(props) {
      const size = props.size ?? 16
      return h('svg', { width: size, height: size, viewBox: '0 0 16 16', 'aria-hidden': true, fill: 'none' },
        h('rect', { x: 1.8, y: 2.6, width: 12.4, height: 8.6, rx: 2.2, stroke: 'currentColor', strokeWidth: 1.2 }),
        h('path', { d: 'M5.6 13.6l2-2.4h2.4', stroke: 'currentColor', strokeWidth: 1.2, strokeLinecap: 'round', strokeLinejoin: 'round' }),
        h('path', { d: 'M5.2 6.9h5.6', stroke: 'currentColor', strokeWidth: 1.2, strokeLinecap: 'round' }),
      )
    }

    /** 面板 id：这是唯一来源（宿主不引用面板 id，只按缓存目录工作）。 */
    const PANEL = {
      doubao: 'daily-zone-web-doubao',
      chat: 'daily-zone-chat',
    }

    /** 唯一的嵌入站点：豆包。内嵌不会被拒，所以 knownBlocked=false。 */
    const SITE_DOUBAO = { labelKey: 'row.doubao', url: 'https://www.doubao.com/chat/', knownBlocked: false }

    /**

    /**
     * 渲染期异常兜底：外壳渲染插件面板时抛错会连累整条渲染路径，
     * 所以每个面板 body 外面都套一层。
     */
    class PanelBoundary extends React.Component {
      constructor(props) {
        super(props)
        this.state = { crashed: false }
      }

      static getDerivedStateFromError() {
        return { crashed: true }
      }

      componentDidCatch(error) {
        try {
          console.error('[daily-zone] panel crashed:', error)
        } catch {
          /* 日志失败无所谓 */
        }
      }

      render() {
        if (this.state.crashed) {
          return h('div', { className: 'dz-wrap' }, h('div', { className: 'dz-card' },
            h('div', { className: 'dz-cardTitle' }, translate('group.title')),
            h('div', { className: 'dz-note' }, translate('panel.crashed')),
          ))
        }
        return this.props.children
      }
    }

    /**
     * 缓存目录里还没有内容的日常会话（可直接接着聊）。
     * 任何一步失败（Remote 列表不可用等）一律当作「没有」，不影响后面新建。
     */
    const findBlankDailySession = safe(async (ctx, chatDir) => {
      const listSessionId = (value) => (typeof value === 'string' && value !== '' ? value : value?.sessionId)
      const remoteList = await Promise.resolve()
        .then(() => ctx.get('remote')?.session?.list?.({}))
        .catch(() => undefined)
      const candidates = Array.isArray(remoteList?.items) ? remoteList.items : []
      for (const item of candidates) {
        if (item?.blank === true && item?.cwd === chatDir) {
          const id = listSessionId(item.sessionId)
          if (id !== undefined) return id
        }
      }
      const sessions = await Promise.resolve()
        .then(() => ctx.get('sessions'))
        .catch(() => undefined)
      const snapshot = sessions?.list?.getSnapshot?.()
      for (const id of snapshot?.ids ?? []) {
        const row = snapshot?.byId?.[id]
        if (row?.blank === true && row?.cwd === chatDir) return id
      }
      return undefined
    }, undefined, 'findBlankDailySession')

    /**
     * 自检：把「直接对话」依赖的每一步单独探一遍，把原始结果交给面板显示。
     * 只在用户点「自检」时运行，正常路径不产生额外请求。
     */
    const selfTest = safe(async (ctx) => {
      const lines = []
      const show = (value) => {
        if (value === undefined) return 'undefined'
        if (value === null) return 'null'
        if (typeof value === 'string') return `"${value}"`
        try {
          return JSON.stringify(value).slice(0, 240)
        } catch {
          return String(value)
        }
      }
      const step = async (label, run) => {
        try {
          const value = await run()
          lines.push(`${label}: ${show(value)}`)
          return value
        } catch (error) {
          lines.push(`${label}: 抛错 -> ${String(error?.message ?? error)}`)
          return undefined
        }
      }

      const ready = await step('GET /daily-zone/status', async () => {
        const response = await fetch(`${CACHE_BASE}/status`, { headers: { accept: 'application/json' } })
        if (!response.ok) return `HTTP ${response.status}`
        return response.json()
      })
      const chatDir = ready?.chatDir ?? ready?.cachePath
      lines.push(`chatDir: ${show(chatDir)}`)

      await step('ctx.get(sessions)', async () => {
        const sessions = ctx.get('sessions')
        if (sessions === undefined) return 'undefined'
        const keys = Object.keys(sessions)
        return { keys, create: typeof sessions.create, list: typeof sessions?.list?.getSnapshot }
      })

      await step('ctx.get(remote).session', async () => {
        const remote = ctx.get('remote')
        if (remote === undefined) return 'remote undefined'
        if (remote.session === undefined) return { 'remote keys': Object.keys(remote).slice(0, 25) }
        return { keys: Object.keys(remote.session).slice(0, 30), create: typeof remote.session.create }
      })

      await step('uiWorkspace', async () => {
        const navigation = getUiWorkspace(ctx)
        if (navigation === undefined) return 'no service with openSession'
        return { keys: Object.keys(navigation).slice(0, 20) }
      })

      if (typeof chatDir === 'string' && chatDir !== '') {
        await step('findBlankDailySession', () => findBlankDailySession(ctx, chatDir))
        await step('remote.session.list({})', async () => {
          const list = await ctx.get('remote')?.session?.list?.({})
          const items = Array.isArray(list?.items) ? list.items : []
          return {
            count: items.length,
            blank: items.filter((item) => item?.blank === true).length,
            cwds: [...new Set(items.map((item) => item?.cwd).filter(Boolean))].slice(0, 6),
          }
        })
      }

      return lines
    }, ['self-test failed'], 'selfTest')

    /** Remote 兜底：`session/create` 的载荷就是 `{ cwd }`，成功返回 `{ sessionId }`。 */
    const createViaRemote = safe(async (ctx, chatDir) => {
      const remote = ctx.get('remote')
      if (remote === undefined || remote.session === undefined) return { ok: false, message: 'session remote unavailable' }
      const created = await remote.session.create({ cwd: chatDir })
      const sessionId = created?.sessionId ?? created?.value?.sessionId
      if (typeof sessionId !== 'string' || sessionId === '') {
        return { ok: false, message: created?.error?.message ?? created?.message ?? 'session id missing' }
      }
      return { ok: true, sessionId }
    }, { ok: false, message: 'createViaRemote failed' }, 'createViaRemote')

    /**
     * 建一张日常会话，返回它的 id（失败返回原因字符串）。
     *
     * 优先走客户端的 `sessions` 服务：它会把新会话立刻并进 client store，与
     * ui-workspace 自己的 `sessions.create({ workspaceId })` 是同一条路——只有
     * 这样 `uiWorkspace.openSession(id)` 才认领得到这张会话；否则 ui-workspace
     * 启动时的 `restoreSelection()` 会用「上次会话」把它盖掉（这就是点了
     * 「直接对话」却进了别的会话的原因）。
     */
    const createDailySession = safe(async (ctx, chatDir) => {
      const clientSessions = (() => {
        try {
          return ctx.get('sessions')
        } catch {
          return undefined
        }
      })()
      if (clientSessions !== undefined && typeof clientSessions.create === 'function') {
        try {
          const created = await clientSessions.create({ cwd: chatDir })
          const sessionId = typeof created === 'string' ? created : created?.sessionId
          if (typeof sessionId === 'string' && sessionId !== '') return sessionId
        } catch (error) {
          const fallback = await createViaRemote(ctx, chatDir)
          if (fallback.ok === true) return fallback.sessionId
          return `sessions.create failed: ${String(error?.message ?? error)}; ${fallback.message}`
        }
      }
      const viaRemote = await createViaRemote(ctx, chatDir)
      return viaRemote.ok === true ? viaRemote.sessionId : viaRemote.message
    }, 'createDailySession failed', 'createDailySession')

    /** 两个路径是否指向同一个目录（大小写与结尾分隔符都不敏感）。 */
    function samePath(left, right) {
      if (typeof left !== 'string' || typeof right !== 'string') return false
      const normalize = (value) => value.replace(/[\\/]+$/, '').replace(/\\/g, '/').toLowerCase()
      return normalize(left) === normalize(right)
    }

    /**
     * 缓存目录上的「日常对话」工作区：有就复用，没有就新建并把标题改好。
     * 安全闸：只有路径确实等于缓存目录时才认领，绝不碰用户自己的工作区。
     */
    const ensureDailyWorkspace = safe(async (ctx, chatDir) => {
      const workspaces = (() => {
        try {
          return ctx.get('workspaces')
        } catch {
          return undefined
        }
      })()
      if (workspaces === undefined || typeof workspaces.create !== 'function') return undefined
      const existing = (workspaces.list?.getSnapshot?.().items ?? []).find((item) => samePath(item.path, chatDir))
      if (existing !== undefined) return existing
      const created = await workspaces.create({ path: chatDir })
      const title = translate('chat.workspace')
      if (created !== undefined && typeof workspaces.rename === 'function' && created.title !== title) {
        try {
          const renamed = await workspaces.rename(created.workspaceId, title)
          return renamed ?? { ...created, title }
        } catch {
          return created
        }
      }
      return created
    }, undefined, 'ensureDailyWorkspace')

    /**
     * 归档「落在缓存目录、却不在日常工作区里」的会话（早期版本的孤儿）。
     * 那是早期版本用 sessions.create({ cwd }) 留下的孤儿，会一直挂在「未分组」。
     */
    const archiveStrayDailySessions = safe(async (ctx, roots, workspaceId) => {
      const navigation = getUiWorkspace(ctx)
      if (navigation === undefined || typeof navigation.archiveSession !== 'function') return
      const sessions = (() => {
        try {
          return ctx.get('sessions')
        } catch {
          return undefined
        }
      })()
      const snapshot = sessions?.list?.getSnapshot?.()
      for (const id of snapshot?.ids ?? []) {
        const row = snapshot?.byId?.[id]
        if (row === undefined || row.cwd === undefined) continue
        if (!roots.some((root) => samePath(row.cwd, root))) continue
        const owner = (() => {
          try {
            return ctx.get('workspaces')?.list?.getSnapshot?.().items?.find((item) => (item.sessionIds ?? []).includes(id))
          } catch {
            return undefined
          }
        })()
        if (owner !== undefined && owner.workspaceId === workspaceId) continue
        if (owner !== undefined) continue
        try {
          await navigation.archiveSession(id)
          trace(`8 已归档孤儿会话 ${id}`)
        } catch {
          /* 归档失败不影响主流程 */
        }
      }
    }, undefined, 'archiveStrayDailySessions')

    /**
     * 点一次「直接对话」：    /**
     * 点一次「直接对话」：复用缓存目录里那张空白会话，没有就新建一张，然后打开它。
     * 复用是有意的——每次点击都新建会攒下一串空会话；只要会话还没说过话，
     * 复用就等于「新对话」。
     */
    const startDailyChat = safe(async (ctx) => {
      trace('1 开始')
      const layout = ctx.get('layout')
      if (layout !== undefined && typeof layout.selectPanel === 'function') layout.selectPanel(null)
      // 内置默认值先顶上；HTTP 只是覆盖来源，失败不影响主流程。
      let chatDir = DEFAULT_CHAT_DIR
      const ready = await Promise.race([
        fetch(`${CACHE_BASE}/status`, { headers: { accept: 'application/json' } })
          .then((response) => {
            trace(`2 status HTTP ${response.status}`)
            return response.ok ? response.json() : undefined
          })
          .catch((error) => {
            trace(`2 status 抛错 ${String(error?.message ?? error)}`)
            return undefined
          }),
        new Promise((resolve) => { try { window.setTimeout(() => resolve(undefined), 2500) } catch { resolve(undefined) } }),
      ])
      if (typeof ready?.chatDir === 'string' && ready.chatDir !== '') chatDir = ready.chatDir
      else if (typeof ready?.cachePath === 'string' && ready.cachePath !== '') chatDir = `${ready.cachePath}\\daily-chat`
      trace(`3 chatDir=${chatDir}${ready === undefined ? '（内置默认值；HTTP 未通过）' : ''}`)
      if (typeof chatDir !== 'string' || chatDir === '') return { ok: false, message: '缓存目录未确定' }

      const navigation = getUiWorkspace(ctx)
      trace(`4 uiWorkspace=${navigation === undefined ? '未找到' : '有'}`)
      if (navigation === undefined || typeof navigation.openWorkspace !== 'function') {
        return { ok: false, message: 'workspace navigation unavailable' }
      }

      const workspace = await ensureDailyWorkspace(ctx, chatDir)
      trace(`5 工作区 -> ${workspace === undefined ? '未取得' : String(workspace.workspaceId)}`)
      if (workspace === undefined) return { ok: false, message: `无法在 ${chatDir} 建立日常工作区` }

      try {
        await navigation.openWorkspace(workspace.workspaceId)
        trace('6 openWorkspace 完成')
      } catch (error) {
        trace(`6 openWorkspace 抛错 ${String(error?.message ?? error)}`)
        return { ok: false, message: String(error?.message ?? error) }
      }

      // 早期试错留下的「不属于任何工作区」的日常会话：归档掉，别堆在未分组里。
      void archiveStrayDailySessions(ctx, [chatDir, ready?.cachePath].filter((item) => typeof item === 'string'), workspace.workspaceId)
      return { ok: true, createdLabel: 'reused' }
    }, { ok: false, message: 'startDailyChat failed' }, 'startDailyChat')

    function getUiWorkspace(ctx) {
      for (const name of ['uiWorkspace', 'workspaceNavigation']) {
        const candidate = (() => {
          try {
            return ctx.get(name)
          } catch {
            return undefined
          }
        })()
        if (candidate !== undefined && typeof candidate.openSession === 'function') return candidate
      }
      return undefined
    }

    /** 注册侧栏入口、主面板与一个设置页。 */
    function install(slots, ctx, t) {
      const bound = (Body) => () => h(PanelBoundary, null, h(Body, null))
      const label = (key) => safe(() => t(key), key, `label:${key}`)
      const layout = ctx.get('layout')

      slots.inject('sidebar.panellist', () => {
        const disposers = []
        const entries = [
          { id: PANEL.doubao, order: 30, Icon: IconDoubao, labelKey: SITE_DOUBAO.labelKey },
          { id: PANEL.chat, order: 31, Icon: IconChat, labelKey: 'row.chat' },
        ]
        for (const entry of entries) {
          disposers.push(slots.register({
            name: 'sidebar.panellist',
            id: entry.id,
            order: entry.order,
            label: label(entry.labelKey),
            locale: NS,
          }, safe(() => {
            const Icon = entry.Icon
            return h(Icon, { size: 16 })
          }, null, `icon:${entry.id}`)))
        }
        return () => { for (const dispose of disposers) dispose?.() }
      })

      const mainEntries = [
        { key: PANEL.doubao, Body: bound(() => h(WebPanel, { ctx, site: t('row.doubao'), url: SITE_DOUBAO.url, knownBlocked: false, t })) },
        {
          key: PANEL.chat,
          Body: bound(() => h(ChatPanel, {
            t,
            ctx,
            startDailyChat: () => startDailyChat(ctx),
            dismiss: () => { if (typeof layout?.selectPanel === 'function') layout.selectPanel(null) },
          })),
        },
      ]
      slots.inject('main', () => {
        const disposers = []
        for (const entry of mainEntries) {
          disposers.push(slots.register({ name: 'main', key: entry.key, locale: NS }, entry.Body))
        }
        return () => { for (const dispose of disposers) dispose?.() }
      })

      // 缓存控制页：设置 → 插件 里的一个页签。
      slots.inject('settings.plugins.tab', () => slots.register({
        name: 'settings.plugins.tab',
        id: 'daily-zone-cache',
        order: 70,
        label: safe(() => `${t('group.title')} · ${t('panel.status')}`, 'daily-zone', 'label:cache-tab'),
        locale: NS,
      }, bound(() => h(CachePanel, { t }))))
    }

    /**
     * 浏览器半侧入口。
     * @param ctx - 受限的客户端 Context（ctx.get / ctx.effect / ctx.on / ctx.provide）。
     */
    function apply(ctx) {
      ctx0.current = ctx
      const get = (name) => {
        try {
          return ctx.get(name)
        } catch {
          return undefined
        }
      }
      const t = (key, params) => translate(key, params)

      // 观测面板切换：即便点击没进到本插件，也能看到外壳是否切过面板。
      try {
        const layoutService = get('layout')
        if (layoutService !== undefined && typeof ctx.provide === 'function') {
          const wrapped = new Proxy(layoutService, {
            get(target, property, receiver) {
              if (property === 'selectPanel') {
                return (panelId) => {
                  report(`layout.selectPanel(${String(panelId)})`)
                  return target.selectPanel(panelId)
                }
              }
              const value = Reflect.get(target, property, receiver)
              return typeof value === 'function' ? value.bind(target) : value
            },
          })
          ctx.provide('layout', wrapped)
          report('layout 服务已包装（可观测面板切换）')
        }
      } catch (error) {
        report(`layout 包装失败：${String(error?.message ?? error)}`)
      }

      // 首注册推到下一个宏任务：外壳在 apply 返回前可能仍在同一次同步装配里，
      // 晚一拍注册既不影响启动，也避免与外壳自身的初始化抢顺序。
      const starter = window.setTimeout ?? ((fn) => { fn(); return 0 })
      ctx.effect(() => {
        let attempts = 0
        let stopped = false
        let timer = 0
        const ready = () => {
          if (stopped) return
          const slots = get('slots')
          if (slots === undefined || typeof slots.register !== 'function') {
            if (attempts < 40) {
              attempts += 1
              timer = starter(ready, 250)
            }
            return
          }
          try {
            // (slots, ctx, t) 三个都要传：label thunk 与面板 body 都依赖 ctx / t。
            install(slots, ctx, t)
          } catch (error) {
            try {
              console.error('[daily-zone] slot registration failed:', error)
            } catch {
              /* 日志失败无所谓 */
            }
          }
        }
        timer = starter(ready, 0)
        return () => {
          stopped = true
          try {
            window.clearTimeout?.(timer)
          } catch {
            /* 无所谓 */
          }
        }
      }, 'daily-zone: slot registrations')
    }

    return {
      name: 'daily-zone-client',
      // locale 只用于语言选择（缺失时退回中文），所以不放进强制依赖。
      inject: ['slots', 'layout'],
      apply,
    }
  },
})

# 日常区（dsh-daily-zone）

给 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）桌面端的左侧边栏加一个「日常区」：
两个入口 + 一套缓存自动清理。**纯 JavaScript 插件，无构建步骤、无运行时依赖。**

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

| 侧栏入口 | 行为 |
| --- | --- |
| 豆包 | 主面板内嵌 `https://www.doubao.com/chat/`；工具栏：刷新 / 右侧栏打开 / 系统浏览器打开 |
| 直接对话 | 打开缓存目录上的专用工作区「日常对话」，由 `uiWorkspace.openWorkspace` 复用或新建一张空白会话，直接进对话界面（不需要选工作区） |

另有一个设置页：**设置 → 插件 → 日常区 · 缓存状态**，可看缓存占用并手动清理。

## 安装

**方式一：按包名安装（推荐，已发布到 npm）**

在 DSH 的插件管理器里安装 `dsh-daily-zone`（`plugin_manager` → `install_bundle`，target = `dsh-daily-zone`）。

**方式二：从本地目录安装（改代码时用这个）**

把仓库 clone 到本地，然后 `install_bundle` 的 target 指向该目录的绝对路径（如
`C:\path\to\dsh-daily-zone`）。它会做三件事：把包 `link:` 进 profile、把 bundle 加进
`dsh.profile.bundles`、立即激活 —— 之后改代码即可直接生效。

> 不要去插件管理器的「Git 仓库」入口填仓库地址：那个入口底层是 `pnpm add <地址>`，
> 会重解整个 profile 的依赖图，撞上 profile 里已有的非注册表包（例如 `dshmarket`）就会 404。

两种方式共同的注意事项：

- **Host 半侧**（`index.js`）改动需要**重启 DSH** 才生效
- **Client 半侧**（`client.js`）改动由客户端 HMR 重载；重建过 bundle 后需要**刷新页面**
- 卸载：`plugin_manager` → `remove_bundle` `dsh-daily-zone`

## 两个入口的实现要点

**豆包**：`WebPanel` 在主面板里用 `<iframe>` 内嵌。刻意不加 `sandbox` —— 内嵌站点本来就跨域、
读不到 DSH 的 DOM 与存储，去掉沙箱后弹窗/下载/站点自身存储行为更接近正常浏览器
（DSH 内置浏览器在兼容模式下也是这个取舍）。代价是该 frame 内页面可按浏览器规则导航顶层应用，
所以工具栏始终保留「系统浏览器打开」。

**直接对话**：见下一节。它**不依赖 HTTP 路由**：内置 `DEFAULT_CACHE_ROOT` 作为默认缓存目录，
HTTP（`/daily-zone/status`）只作覆盖来源并带 2500ms 超时，所以路由没注册上也能正常工作。

## 为什么用「工作区」而不是无工作区会话

早期版本用 `sessions.create({ cwd })` 建了一张**不属于任何工作区**的会话，有两个后果：

1. 它不出现在侧栏会话列表里；
2. `ui-workspace` 启动时的 `restoreSelection()` 不认它（它按 `selection` 里的会话找所属工作区，
   找不到就回落到**最近工作区**），于是界面被抢回默认工作区。

现在改成：在缓存目录 path 上建/找一个工作区，用 `openWorkspace(id)` 打开 —— 这与界面上点工作区
**完全相同**那条路（内部 `connectWorkspace` → 复用或新建空白会话），恢复逻辑因此认得它。
安全闸：只有路径确实等于缓存目录时才会被认领，不会碰用户自己的工作区。

顺带，早期试错留下的孤儿会话（`cwd` 等于缓存目录或缓存根目录、且不属于任何工作区）会被**归档**。

> **关于「隐藏工作区」**：DSH 的工作区数据模型（`~/.dsh/storages/workspace.json`）只有
> `path / title / sessionIds / createdAt / updatedAt`，没有 hidden 字段；`ui-workspace` 的契约是
> 「每个工作区分组都会显示」。侧栏的工作区列表来自 shell 层、不是插件 slot，所以**插件无法隐藏它**，
> 除非替换整个 `sidebar.workspaces` 席位。因此这个工作区是可见的。

## Host 半侧拿服务必须用 `ctx.inject`

这是本插件踩过最大的坑：**在插件作用域里 `ctx.get('webServer')` 返回 `undefined`**
（因为它是后装载的独立 fiber），后果是路由注册块被整块跳过 → `/daily-zone/status` 一直 404 →
客户端取不到缓存目录 → 「直接对话」连工作区都没建就早退（现象就是「点了没反应」）。

正确写法封装在 `withService` 里：

```js
withService('webServer', (webServer) => { /* webServer.register(...) */ })
// 内部：先 ctx.get，拿不到就 ctx.inject([name], (scoped) => …)，并逐条记账到 hostDiag
```

`timer` 同理。**新增任何需要宿主服务的功能，一律走 `withService`。**

## 缓存与清理

- 缓存目录默认 `D:\DeepSeek Harness\cache`（按安装目录推导，可用 `cachePath` 覆盖）
- 三种触发：
  1. **每轮对话结束**（Host `agent/turn-stopping`）：只删超过宽限期的临时文件（`*.tmp/.part/.partial/.crdownload/~*`），静默、失败不影响这一轮
  2. **定时**：默认每 60 分钟（`autoCleanIntervalMinutes`），走 `withService('timer')`
  3. **手动**：设置页按钮，或 `daily_zone_cache` 工具（`status` / `clean` / `purge-temp`）——工具通道不依赖 HTTP
- 安全契约：只删缓存根目录内的**普通文件**；不跟随符号链接、不删目录
  （`purge-temp` 只倒空 `tool-output/`、`spill/`、`tmp/` 的内容）；正在使用的会话工作目录整体跳过；先看 mtime

## 配置

在 profile 的 `cordis.patch.yml` 里覆盖：

```yaml
- id: daily-zone
  name: 'dsh-daily-zone'
  config:
    cachePath: 'D:\DeepSeek Harness\cache'
    retentionHours: 24          # 超过多久算过期
    turnGraceMinutes: 30        # 临时文件宽限期，也是每轮清理的门槛
    autoCleanEnabled: true
    autoCleanIntervalMinutes: 60
```

## 开发

```powershell
npm test                    # 离线冒烟测试（桩 React/桩外壳）
npm run check:encoding      # 中文文件编码体检（本机 shell 会把中文写坏，靠它兜底）
npm run check               # 上面两项一起跑
npm pack --dry-run          # 看发布出去会包含哪些文件（应为 9 个：入口/patch/图标/locale/README/LICENSE）
```

发布 npm 包时 `prepublishOnly` 会自动跑 `npm run check` 与 `scripts/verify-package.mjs`
（查必备文件、声明指向、编码、包名与 patch 是否一致），任一项不过就拒绝发布。

冒烟测试覆盖：factory/apply/label thunk 不抛错、网页面板加载后无提示行、
**真跑一次「直接对话」并断言「建工作区 → 改名 → openWorkspace」**、以及复用路径不重复创建。

红线（曾经踩爆过）：客户端插件跑在外壳渲染路径里，**一个未捕获异常会让整个侧栏条目激活失败，
实测直接导致 web 启动失败**（`web boot: 1 entry did not activate`）。所以插件里任何会被外壳调用的
函数（`label` thunk、图标、面板 body）都必须经过 `safe()` 或 `PanelBoundary`。

## 许可

MIT

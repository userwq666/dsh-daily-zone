/**
 * 发布前校验（由 package.json 的 prepublishOnly 调用）。
 *
 * 只查「发布出去会坏」的事情：
 *   1. 必备文件都在（入口、patch、图标、locale、许可证、README）
 *   2. package.json 关键声明可解析（dsh.bundle.patch / dsh.client / exports 指向真实文件）
 *   3. 没有误留 private:true（否则 npm 直接拒绝发布）
 *   4. 源码是干净 UTF-8（本机 shell 会把中文写坏，这里兜底）
 *   5. 版本号不是「还没改过」的占位（提示性警告，不阻断）
 *
 * 失败即非零退出，阻止发布。
 */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const problems = []
const warnings = []

const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))

// 1) 必备文件
const required = [
  'index.js',
  'client.js',
  'cordis.patch.yml',
  'icon.svg',
  'LICENSE',
  'README.md',
  'locale/zh.json',
  'locale/en.json',
  'package.json',
]
for (const relative of required) {
  if (!existsSync(join(root, relative))) problems.push(`缺少必备文件: ${relative}`)
}

// 2) 声明指向真实文件
const declared = [
  manifest.main,
  manifest.icon,
  manifest.exports?.['.'],
  manifest.exports?.['./client'],
  manifest.exports?.['./cordis.patch.yml'],
  manifest.dsh?.bundle?.patch,
].filter((value) => typeof value === 'string')
for (const relative of declared) {
  const target = relative.replace(/^\.\//, '')
  if (!existsSync(join(root, target))) problems.push(`声明指向不存在的文件: ${relative}`)
}

// 3) 发布开关
if (manifest.private !== undefined && manifest.private !== false) {
  problems.push('package.json 里 private 为真，npm 会拒绝发布')
}
if (manifest.publishConfig?.access !== 'public') {
  warnings.push('publishConfig.access 不是 public（npm 默认就是 public，除非你想发私有包）')
}

// 4) 编码
const decoder = new TextDecoder('utf-8', { fatal: false })
for (const relative of ['index.js', 'client.js', 'README.md', 'package.json', 'locale/zh.json', 'locale/en.json', 'cordis.patch.yml']) {
  const file = join(root, relative)
  if (!existsSync(file)) continue
  const text = decoder.decode(readFileSync(file))
  if (text.includes('\uFFFD') || /\u00C3[\u0080-\u00BF]/.test(text)) {
    problems.push(`${relative} 不是干净的 UTF-8（中文可能被写坏）`)
  }
}

// 5) 版本号提示
if (manifest.version === '0.1.0') {
  warnings.push('版本号是 0.1.0（首次发布正常；以后每次发布都要改）')
}

// 6) patch 里引用的包名要和 package.json 一致，否则装完行名对不上
const patch = existsSync(join(root, 'cordis.patch.yml')) ? readFileSync(join(root, 'cordis.patch.yml'), 'utf8') : ''
if (patch && !patch.includes(manifest.name)) {
  problems.push(`cordis.patch.yml 里没有出现包名 ${manifest.name}（安装后组件行会对不上）`)
}

console.log(`包名: ${manifest.name}@${manifest.version}`)
console.log(`将发布文件（files 白名单）: ${(manifest.files ?? []).join(', ') || '(未设置，等于全部)'}`)
for (const warning of warnings) console.log(`⚠️  ${warning}`)
if (problems.length > 0) {
  for (const problem of problems) console.error(`❌ ${problem}`)
  process.exit(1)
}
console.log('✅ 发布前校验通过')

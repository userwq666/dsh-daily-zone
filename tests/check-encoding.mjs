/**
 * 编码体检：按 UTF-8 严格解码每个源文件，报告替换字符与二次解码乱码。
 * 用途：插件源码在桌面文件夹里，用户要直接打开看，中文必须是干净的 UTF-8。
 *
 * 判定规则用「UTF-8 被当 Latin-1 二次解码」的特征（`Ã`/`Â` 后跟高位字节、
 * `â€` 序列），而不是乱码样本字面量——否则本文件会把自己判成乱码（踩过这个坑）。
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

const root = process.argv[2] ?? '.'
const MOJIBAKE = /\u00C3[\u0080-\u00BF]|\u00C2[\u0080-\u00BF]|\u00E2\u20AC|\uFFFD/
const decoder = new TextDecoder('utf-8', { fatal: false })

const files = []
function walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.git') continue
    // tests/ 是开发脚本，源码里就写着乱码判定用的正则，扫它只会自我误报。
    if (entry.name === 'tests') continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) walk(full)
    else if (statSync(full).isFile()) files.push(full)
  }
}
walk(root)

let bad = 0
for (const file of files) {
  const bytes = readFileSync(file)
  const text = decoder.decode(bytes)
  const replacements = (text.match(/\uFFFD/g) ?? []).length
  const mojibake = (text.match(new RegExp(MOJIBAKE.source, 'g')) ?? []).length
  const cjk = (text.match(/[\u4e00-\u9fff]/g) ?? []).length
  const flag = replacements > 0 || mojibake > 0 ? 'BAD ' : 'ok  '
  if (flag === 'BAD ') bad += 1
  console.log(`${flag} ${relative(root, file).padEnd(36)} bytes=${String(bytes.length).padStart(6)} 中文=${String(cjk).padStart(4)} 替换符=${replacements} 乱码=${mojibake}`)
}
console.log(bad === 0 ? '\n结论：所有文件都是干净的 UTF-8' : `\n结论：${bad} 个文件有问题`)
process.exit(bad === 0 ? 0 : 1)

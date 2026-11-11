/**
 * dsh-notebook-v2 · 把仓库里的 skill 同步到 DSH 的全局 skill 目录
 *
 * 为什么要有这一步：DSH 只读 `~/.dsh/skills/<name>/SKILL.md`，不读仓库里的 `skills/`。
 * 仓库是唯一源（可版本管理），DSH 目录是同步副本 —— 改完源要重跑本脚本。
 *
 * 用法：
 *   node scripts/install-skill.mjs [--dry-run]
 */

import { readFile, mkdir, copyFile } from "node:fs/promises"
import { readdirSync, existsSync } from "node:fs"
import { homedir } from "node:os"
import { join, dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const HERE = dirname(fileURLToPath(import.meta.url))
const PKG_DIR = resolve(HERE, "..")
const SRC = join(PKG_DIR, "skills")
const DEST = join(homedir(), ".dsh", "skills")
const dryRun = process.argv.includes("--dry-run")

async function main() {
  if (!existsSync(SRC)) {
    console.log("skills/ 不存在，没有可安装的 skill")
    return
  }
  const names = readdirSync(SRC, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
  if (!names.length) {
    console.log("skills/ 下没有目录")
    return
  }
  for (const name of names) {
    const from = join(SRC, name, "SKILL.md")
    if (!existsSync(from)) {
      console.log(`跳过 ${name}：缺 SKILL.md`)
      continue
    }
    /**
     * DSH 按**目录名**索引 skill，frontmatter 的 `name` 必须与之一致：
     * 不一致时目录里会出现一个「名字对不上」的条目，触发词永远匹配不到。
     */
    const text = await readFile(from, "utf8")
    const m = /^---[\s\S]*?^name:\s*([^\s]+)/m.exec(text)
    if (!m || m[1] !== name) {
      console.log(`跳过 ${name}：frontmatter name=${m ? m[1] : "缺失"}，与目录名不一致`)
      continue
    }
    const toDir = join(DEST, name)
    const to = join(toDir, "SKILL.md")
    if (dryRun) {
      console.log(`[dry-run] ${from}\n       -> ${to}`)
      continue
    }
    await mkdir(toDir, { recursive: true })
    await copyFile(from, to)
    console.log(`已安装 skill：${name}\n  ${from}\n  -> ${to}`)
  }
  console.log("提示：新开的会话才会加载新 skill（当前会话的 skill 索引在启动时读入）。")
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})

/**
 * 下线旧插件 @beihaizb/dsh-notebook（迁移闭环）。
 *
 * 只做三件事，且**只动 profile 的 package.json**：
 *   1. 备份 package.json
 *   2. 从 dsh.profile.bundles 里移除 @beihaizb/dsh-notebook（→ 重启后不再加载）
 *   3. 从 dependencies 里移除同名条目（node_modules 里的文件**保留**，方便一键回滚）
 *
 * 不碰：任何 .ipynb / notebooks/ 目录 / 用户数据。回滚只需把两处加回去再重启。
 *
 * 用法：
 *   node dsh-notebook-v2/scripts/retire-old-plugin.mjs [--dry-run] [--rollback]
 *   --rollback  反向操作：把旧插件加回 bundles 与 dependencies
 */

import { readFile, writeFile, copyFile } from "node:fs/promises"
import { existsSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

const OLD = "@beihaizb/dsh-notebook"

const argv = process.argv.slice(2)
const dryRun = argv.includes("--dry-run")
const rollback = argv.includes("--rollback")
const profileArg = argv.indexOf("--profile") >= 0 ? argv[argv.indexOf("--profile") + 1] : null
const PROFILE = profileArg || process.env.DSH_PROFILE_DIR || join(homedir(), ".dsh", "profiles", "desktop")

function stamp() {
  const d = new Date()
  const p = (n) => String(n).padStart(2, "0")
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

const pkgPath = join(PROFILE, "package.json")
if (!existsSync(pkgPath)) {
  console.error(`找不到 profile：${pkgPath}`)
  process.exit(1)
}

const pkg = JSON.parse(await readFile(pkgPath, "utf8"))
const bundles = (pkg.dsh && pkg.dsh.profile && pkg.dsh.profile.bundles) || []
const deps = pkg.dependencies || {}

const changes = []
if (rollback) {
  if (!bundles.includes(OLD)) {
    changes.push(`bundles += ${OLD}`)
    bundles.push(OLD)
  }
  if (!deps[OLD]) {
    const version = deps[OLD] || "0.3.1"
    changes.push(`dependencies[${OLD}] = "0.3.1"`)
    deps[OLD] = "0.3.1"
    void version
  }
} else {
  const i = bundles.indexOf(OLD)
  if (i >= 0) {
    changes.push(`bundles -= ${OLD}（第 ${i + 1} 项）`)
    bundles.splice(i, 1)
  }
  if (deps[OLD]) {
    changes.push(`dependencies -= ${OLD}（保留 node_modules 文件以便回滚）`)
    delete deps[OLD]
  }
}

if (!changes.length) {
  console.log(rollback ? "旧插件已经在 bundles 里了，无需改动。" : "旧插件本来就不在 bundles 里，无需改动。")
  process.exit(0)
}

console.log(`profile: ${PROFILE}`)
for (const c of changes) console.log(`  · ${c}`)
if (dryRun) {
  console.log("\n--dry-run：未写入。")
  process.exit(0)
}

const backup = `${pkgPath}.bak-retire-${stamp()}`
await copyFile(pkgPath, backup)
console.log(`\n已备份 package.json → ${backup}`)

if (pkg.dsh && pkg.dsh.profile) pkg.dsh.profile.bundles = bundles
pkg.dependencies = deps
await writeFile(pkgPath, JSON.stringify(pkg, null, 2) + "\n", "utf8")

// 校验
const after = JSON.parse(await readFile(pkgPath, "utf8"))
const stillThere = (after.dsh?.profile?.bundles || []).includes(OLD)
if (rollback ? !stillThere : stillThere) {
  console.error("校验失败：package.json 状态与预期不符")
  process.exit(1)
}

console.log("已写入并校验 ✅")
if (rollback) {
  console.log("回滚完成：重启 DeepSeek Harness 后旧插件会重新加载（新旧工具同名，请勿同时启用）。")
} else {
  console.log("旧插件已从加载列表移除；node_modules 里的文件与所有 .ipynb 数据都没动。")
  console.log("重启 DeepSeek Harness 生效。回滚：node dsh-notebook-v2/scripts/retire-old-plugin.mjs --rollback")
}

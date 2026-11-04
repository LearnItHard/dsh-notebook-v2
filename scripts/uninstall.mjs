/**
 * dsh-notebook-v2 · 从 profile 卸载（M0.6 回滚闭环的后一半）
 *
 * 只做三件事，且**只删本插件自己的痕迹**：
 *   1. 备份 profile package.json
 *   2. dependencies / dsh.profile.bundles 里移除包名
 *   3. 删掉 node_modules 里的目录联接（绝不递归删除真实目录 —— 源在仓库里）
 *
 * 不碰：旧插件 @beihaizb/dsh-notebook、notebooks/ 目录、任何 .ipynb 数据。
 *
 * 用法：
 *   node dsh-notebook-v2/scripts/uninstall.mjs [--profile <dir>] [--dry-run]
 */

import { readFile, writeFile, copyFile, lstat, unlink, rmdir } from "node:fs/promises"
import { existsSync } from "node:fs"
import { homedir, platform } from "node:os"
import { join } from "node:path"
import { spawnSync } from "node:child_process"

const PKG_NAME = "dsh-notebook-v2"

const argv = process.argv.slice(2)
const dryRun = argv.includes("--dry-run")
const profileArg = argv.indexOf("--profile") >= 0 ? argv[argv.indexOf("--profile") + 1] : null
const PROFILE = profileArg || join(homedir(), ".dsh", "profiles", "desktop")

function stamp() {
  const d = new Date()
  const p = (n) => String(n).padStart(2, "0")
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

const pkgJsonPath = join(PROFILE, "package.json")
if (!existsSync(pkgJsonPath)) {
  console.error(`找不到 profile：${pkgJsonPath}`)
  process.exit(1)
}

const profilePkg = JSON.parse(await readFile(pkgJsonPath, "utf8"))
const changes = []

if (profilePkg.dependencies && PKG_NAME in profilePkg.dependencies) {
  changes.push(`dependencies 移除 ${PKG_NAME}`)
  delete profilePkg.dependencies[PKG_NAME]
}
const bundles = profilePkg.dsh?.profile?.bundles
if (Array.isArray(bundles)) {
  const i = bundles.indexOf(PKG_NAME)
  if (i >= 0) {
    changes.push(`dsh.profile.bundles 移除 ${PKG_NAME}`)
    bundles.splice(i, 1)
  }
}

const linkPath = join(PROFILE, "node_modules", PKG_NAME)
const linkExists = existsSync(linkPath) || (await lstat(linkPath).catch(() => null)) !== null
if (linkExists) changes.push(`删除联接 ${linkPath}`)

if (!changes.length) {
  console.log("没有发现本插件的痕迹，无需改动。")
  process.exit(0)
}

console.log(`profile: ${PROFILE}`)
for (const c of changes) console.log(`  · ${c}`)
if (dryRun) {
  console.log("\n--dry-run：未写入。")
  process.exit(0)
}

const backup = `${pkgJsonPath}.bak-nb2rm-${stamp()}`
await copyFile(pkgJsonPath, backup)
console.log(`\n已备份 package.json → ${backup}`)
await writeFile(pkgJsonPath, JSON.stringify(profilePkg, null, 2) + "\n", "utf8")
console.log("已写入 package.json")

if (linkExists) {
  const st = await lstat(linkPath)
  if (st.isSymbolicLink()) {
    await unlink(linkPath)
    console.log("已删除符号链接")
  } else if (st.isDirectory()) {
    // Windows junction 在 lstat 里表现为目录。只删「空壳」：先确认它是一个联接而非真实目录。
    const isJunction = platform() === "win32" ? isWindowsJunction(linkPath) : false
    if (!isJunction) {
      console.error(
        `拒绝删除：${linkPath} 不是符号链接/junction，而是一个真实目录。\n` +
          `如果确认要删，请手动处理（源目录仍在仓库里）。`,
      )
      process.exit(1)
    }
    await rmdir(linkPath)
    console.log("已删除目录联接")
  } else {
    await unlink(linkPath)
    console.log("已删除文件")
  }
}

console.log("\n已卸载 ✅ 旧插件与 .ipynb 数据未受影响。")
console.log("重启 DeepSeek Harness 后「Notebook (v2)」标签消失。")

/** Windows junction 的判定：`dir /AL` 会列出 reparse point。 */
function isWindowsJunction(p) {
  const r = spawnSync("cmd", ["/c", "dir", "/AL", p], { encoding: "utf8" })
  return r.status === 0 && /JUNCTION|SYMLINK/i.test(r.stdout || "")
}

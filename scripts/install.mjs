/**
 * dsh-notebook-v2 · 装进 profile（M0.6 回滚闭环的前一半）
 *
 * 做四件事，任何一步失败都停下来并打印怎么回滚：
 *   1. 备份 profile package.json
 *   2. dependencies 里加 `link:<本包绝对路径>`（pnpm 语义，重装后可复现）
 *   3. dsh.profile.bundles 里加包名（Loader 才有 entry → 客户端 bundle 才进 boot graph）
 *   4. node_modules 里建目录联接（junction），让 loader 能 require 到
 *
 * 不碰：旧插件 @beihaizb/dsh-notebook、notebooks/ 目录、任何 .ipynb。
 *
 * 用法：
 *   node dsh-notebook-v2/scripts/install.mjs [--profile <dir>] [--dry-run]
 * 默认 profile = %USERPROFILE%/.dsh/profiles/desktop
 */

import { readFile, writeFile, copyFile, access } from "node:fs/promises"
import { existsSync } from "node:fs"
import { homedir, platform } from "node:os"
import { join, dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { spawnSync } from "node:child_process"

const PKG_NAME = "dsh-notebook-v2"
const HERE = dirname(fileURLToPath(import.meta.url))
const PKG_DIR = resolve(HERE, "..")

const argv = process.argv.slice(2)
const dryRun = argv.includes("--dry-run")
const profileArg = argv.indexOf("--profile") >= 0 ? argv[argv.indexOf("--profile") + 1] : null
const PROFILE = profileArg || join(homedir(), ".dsh", "profiles", "desktop")

function log(msg) {
  console.log(msg)
}

async function exists(p) {
  try {
    await access(p)
    return true
  } catch {
    return false
  }
}

function stamp() {
  const d = new Date()
  const p = (n) => String(n).padStart(2, "0")
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

/** 建目录联接：Windows 用 mklink /J（无需管理员），其它平台用 symlink。 */
function linkDir(linkPath, targetPath) {
  if (platform() === "win32") {
    const r = spawnSync("cmd", ["/c", "mklink", "/J", linkPath, targetPath], {
      encoding: "utf8",
    })
    if (r.status !== 0) throw new Error(`mklink 失败：${r.stdout || ""}${r.stderr || ""}`)
    return
  }
  const r = spawnSync("ln", ["-sfn", targetPath, linkPath], { encoding: "utf8" })
  if (r.status !== 0) throw new Error(`ln 失败：${r.stderr || ""}`)
}

const pkgJsonPath = join(PROFILE, "package.json")

if (!existsSync(pkgJsonPath)) {
  console.error(`找不到 profile：${pkgJsonPath}`)
  process.exit(1)
}

const original = await readFile(pkgJsonPath, "utf8")
const profilePkg = JSON.parse(original)
const linkSpec = `link:${PKG_DIR.replace(/\\/g, "/")}`

const changes = []
if (!profilePkg.dependencies) profilePkg.dependencies = {}
if (profilePkg.dependencies[PKG_NAME] !== linkSpec) {
  changes.push(`dependencies["${PKG_NAME}"] = "${linkSpec}"`)
  profilePkg.dependencies[PKG_NAME] = linkSpec
}

if (!profilePkg.dsh) profilePkg.dsh = {}
if (!profilePkg.dsh.profile) profilePkg.dsh.profile = {}
if (!Array.isArray(profilePkg.dsh.profile.bundles)) profilePkg.dsh.profile.bundles = []
if (!profilePkg.dsh.profile.bundles.includes(PKG_NAME)) {
  changes.push(`dsh.profile.bundles += "${PKG_NAME}"`)
  profilePkg.dsh.profile.bundles.push(PKG_NAME)
}

const linkPath = join(PROFILE, "node_modules", PKG_NAME)
const needLink = !existsSync(linkPath)
if (needLink) changes.push(`node_modules/${PKG_NAME} → ${PKG_DIR}（目录联接）`)

if (!changes.length) {
  log("已经是装好的状态，无需改动。")
} else {
  log(`profile: ${PROFILE}`)
  for (const c of changes) log(`  · ${c}`)
  if (dryRun) {
    log("\n--dry-run：未写入。")
    process.exit(0)
  }

  const backup = `${pkgJsonPath}.bak-nb2-${stamp()}`
  await copyFile(pkgJsonPath, backup)
  log(`\n已备份 package.json → ${backup}`)

  await writeFile(pkgJsonPath, JSON.stringify(profilePkg, null, 2) + "\n", "utf8")
  log("已写入 package.json")

  if (needLink) {
    await access(join(PROFILE, "node_modules")).catch(async () => {
      throw new Error(`node_modules 不存在：${join(PROFILE, "node_modules")}`)
    })
    linkDir(linkPath, PKG_DIR)
    log(`已建联接：${linkPath}`)
  }
}

// ── 校验 ──
const problems = []
const verify = JSON.parse(await readFile(pkgJsonPath, "utf8"))
if (verify.dependencies?.[PKG_NAME] !== linkSpec) problems.push("dependencies 未生效")
if (!verify.dsh?.profile?.bundles?.includes(PKG_NAME)) problems.push("bundles 未生效")
if (!existsSync(join(linkPath, "package.json"))) problems.push("联接不可读")
if (!existsSync(join(linkPath, "lib", "client.js"))) problems.push("client.js 不可读")
if (!existsSync(join(linkPath, "cordis.patch.yml"))) problems.push("cordis.patch.yml 不可读")

if (problems.length) {
  console.error(`\n校验失败：${problems.join("；")}`)
  console.error(`回滚：node ${join(HERE, "uninstall.mjs")}`)
  process.exit(1)
}

log("\n校验通过 ✅")
log("下一步：重启 DeepSeek Harness（或重载窗口）→ 右栏「+」/引导页里会出现「Notebook (v2)」。")
log(`回滚：node ${join(HERE, "uninstall.mjs")}`)

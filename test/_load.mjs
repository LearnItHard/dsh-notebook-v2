/**
 * 测试公用：把插件包复制到临时目录、打掉 `@deepseek-ai/dsh-tools` 的裸 import、再动态加载。
 *
 * 为什么要复制整包：宿主半是 ESM 多文件（events/notebook/ipynb/sidecar），
 * 只复制 index.js 会让 `./events.js` 解析失败；sidecar.js 还会按自身位置找
 * `../python/kernel_driver.py`，所以 python/ 也得一起带过去。
 *
 * 仓库里没有 @deepseek-ai/dsh-tools（它由 DSH 宿主在运行时解析），
 * 所以测试里把它换成本地 stub —— stub 语义与真实 defineTool 一致：原样返回工具描述。
 */

import { mkdtemp, mkdir, readdir, readFile, writeFile, copyFile, cp } from "node:fs/promises"
import { existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, dirname } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

export const PKG_DIR = join(dirname(fileURLToPath(import.meta.url)), "..")

/** @returns {Promise<{mod:object, dir:string}>} */
export async function loadPlugin() {
  const dir = await mkdtemp(join(tmpdir(), "nb2-pkg-"))
  const libOut = join(dir, "lib")
  const pyOut = join(dir, "python")
  await mkdir(libOut, { recursive: true })
  await mkdir(pyOut, { recursive: true })

  for (const name of await readdir(join(PKG_DIR, "lib"))) {
    if (!name.endsWith(".js")) continue
    const src = join(PKG_DIR, "lib", name)
    if (name === "index.js") continue
    await copyFile(src, join(libOut, name))
  }

  // katex 的 CSS / 字体是构建产物（非 .js）。`/nb2/katex.css`、`/nb2/fonts/*` 这些路由
  // 相对**包自身** lib 目录找文件，测试壳不搬就会「CSS 永远 404」。
  if (existsSync(join(PKG_DIR, "lib", "katex"))) {
    await cp(join(PKG_DIR, "lib", "katex"), join(libOut, "katex"), { recursive: true })
  }

  /**
   * package.json 也要带过去：`/nb2/health` 的 version 是从它读的。
   * 不搬的话临时目录里没有这个文件，health 会走兜底返回 0.0.0 —— 测试壳就和真实安装
   * （`link:` 到仓库，package.json 在）不等价了，版本断言变成假红。
   */
  await copyFile(join(PKG_DIR, "package.json"), join(dir, "package.json"))

  const indexSrc = await readFile(join(PKG_DIR, "lib", "index.js"), "utf8")
  const patched = indexSrc.replace(
    /import\s*\{\s*defineTool\s*\}\s*from\s*["']@deepseek-ai\/dsh-tools["'];?/,
    "const defineTool = (tool) => tool",
  )
  if (patched === indexSrc) throw new Error("lib/index.js 里找不到 dsh-tools 的 import —— 源码结构变了，更新测试")
  await writeFile(join(libOut, "index.js"), patched, "utf8")

  for (const name of await readdir(join(PKG_DIR, "python"))) {
    if (!name.endsWith(".py")) continue
    await copyFile(join(PKG_DIR, "python", name), join(pyOut, name))
  }

  const mod = await import(pathToFileURL(join(libOut, "index.js")).href)
  return { mod, dir }
}

/** 最小 ctx 模拟：只提供插件真正用到的东西。
 *
 * agents / workingDirectory 用来测 defaultCwdFor 的四级回退（不传就等价于「服务不存在」，
 * 插件必须不抛错地继续往下一级退）。
 */
/**
 * @param {{workspaceRoot?:string, agents?:object, workingDirectory?:object, llm?:object, services?:Record<string,object>}} [opts]
 */
export function makeCtx({ workspaceRoot, agents, workingDirectory, llm, services } = {}) {
  const routes = []
  const tools = []
  const disposers = []
  const extra = services || {}
  const ctx = {
    effect(fn) {
      const dispose = fn()
      if (typeof dispose === "function") disposers.push(dispose)
      return dispose
    },
    get(name) {
      if (name === "sandboxPolicy" && workspaceRoot) return { workspaceRoot }
      if (name === "agents" && agents) return agents
      if (name === "workingDirectory" && workingDirectory) return workingDirectory
      // AI 设置栏的两条路由都通过 ctx.get("llm") 拿服务；测试里注入假 llm 就能真跑 HTTP
      if (name === "llm" && llm) return llm
      if (name in extra) return extra[name]
      return undefined
    },
    on() {
      return () => {}
    },
    webServer: {
      register(entry) {
        routes.push(entry)
        return () => {
          const i = routes.indexOf(entry)
          if (i >= 0) routes.splice(i, 1)
        }
      },
    },
    tools: {
      register(tool) {
        tools.push(tool)
        return () => {
          const i = tools.indexOf(tool)
          if (i >= 0) tools.splice(i, 1)
        }
      },
    },
  }
  return {
    ctx,
    routes,
    tools,
    teardown() {
      for (const dispose of disposers.reverse()) {
        try {
          dispose()
        } catch {
          /* ignore */
        }
      }
    },
  }
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

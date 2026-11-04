/**
 * 解释器 / 内核发现。
 *
 * 为什么需要这一层（这是 v2 第一次真机启动就挂掉的原因）：
 *   - **`DSH_ENV_PYTHON` / `DSH_PYTHON` 只存在于 shell 调用的环境里**：harness 在执行 shell 时
 *     才解析这些事实，**永远不会写进插件所在进程的 env**。所以插件里读 process.env 看不到
 *     用户在 python-env 插件里选的那个解释器 —— 于是回落到 PATH 上的 `python`（可能是系统 3.13，
 *     没有 ipykernel），内核一启动就 `No module named 'ipykernel'`。
 *   - 权威来源是 envsel 的机器本地存储 `~/.dsh/envsel-state.json`
 *     （`{version:1, selections:{sessionId:{python:{pythonCommand|python}}}}`），
 *     并要沿「会话被派生的父会话」向上找（子代理通常自己没有选择，得继承父会话的）。
 *   - 没选过的话，就扫 conda 前缀，挑第一个**真的装了 ipykernel** 的。
 *
 * 本文件是纯函数 + 文件系统探测，不碰 ctx，所以能被 headless 测试直接驱动。
 */

import { existsSync, readFileSync, readdirSync } from "node:fs"
import { spawnSync } from "node:child_process"
import { homedir } from "node:os"
import { dirname, join } from "node:path"

const ENVSEL_STATE_VERSION = 1
const ENVSEL_STATE_TTL_MS = 2000
const ENVSEL_MAX_HOPS = 8

let envselCache = null

function dshHome() {
  return process.env.DSH_HOME || join(homedir(), ".dsh")
}

export function envselStatePath() {
  return join(dshHome(), "envsel-state.json")
}

/**
 * 读 envsel 的选择表（2s 缓存，避免每次状态轮询都打盘）。
 * 文件缺失 / 版本不符 / 不可读 → null（**绝不猜别人的 schema**）。
 */
export function envselSelections(now = Date.now()) {
  if (envselCache && now - envselCache.at < ENVSEL_STATE_TTL_MS) return envselCache.selections
  let selections = null
  try {
    const doc = JSON.parse(readFileSync(envselStatePath(), "utf8"))
    if (doc && doc.version === ENVSEL_STATE_VERSION && doc.selections && typeof doc.selections === "object") {
      selections = doc.selections
    }
  } catch {
    /* 可选文件 */
  }
  envselCache = { at: now, selections }
  return selections
}

/** 一条选择里的 python 路径，存在才认。 */
export function envselPythonOf(selection) {
  const py = selection && selection.python
  const cmd = py && (py.pythonCommand || py.python)
  return cmd && existsSync(cmd) ? cmd : null
}

/**
 * 该会话应该用的 python：自己的选择 → 沿父会话向上找（最多 8 跳，防环）。
 * @param {string} sessionId
 * @param {Map<string,string>} parents 子会话 → 父会话
 */
export function envselPython(sessionId, parents) {
  const selections = envselSelections()
  if (selections === null) return null
  const seen = new Set()
  let cursor = sessionId
  for (let hops = 0; cursor && hops <= ENVSEL_MAX_HOPS; hops += 1) {
    const key = String(cursor)
    if (seen.has(key)) break
    seen.add(key)
    const found = envselPythonOf(selections[key])
    if (found) return found
    cursor = parents ? parents.get(key) || null : null
  }
  return null
}

export function pythonFromPrefix(prefix) {
  const cands = [
    join(prefix, "python.exe"),
    join(prefix, "Scripts", "python.exe"),
    join(prefix, "bin", "python.exe"),
    join(prefix, "bin", "python"),
    join(prefix, "bin", "python3"),
  ]
  for (const c of cands) if (existsSync(c)) return c
  return null
}

/**
 * 看 site-packages 里 ipykernel 的**包**在不在（要有 `__init__.py`，不能只看目录）。
 *
 * 为什么加 `__init__.py`：pip 装一半中断会留下空目录，只看目录存在会**假阳性**，
 * 结果是「我们以为这环境能用，真起内核又报 No module named 'ipykernel'」。
 * 反过来也有假阴性（包装在别处 / --system-site-packages），那种情况交给 `probeIpykernel()` 实跑一次。
 */
export function hasIpykernel(prefix) {
  const candidates = []
  const direct = [join(prefix, "Lib", "site-packages", "ipykernel"), join(prefix, "lib", "site-packages", "ipykernel")]
  candidates.push(...direct)
  const lib = join(prefix, "lib")
  if (existsSync(lib)) {
    try {
      for (const n of readdirSync(lib)) {
        if (n.indexOf("python") === 0) candidates.push(join(lib, n, "site-packages", "ipykernel"))
      }
    } catch {
      /* ignore */
    }
  }
  return candidates.some((dir) => existsSync(join(dir, "__init__.py")))
}

/** spawn 探测的缓存：同一个解释器只真跑一次（起内核前会用到它）。 */
const probeCache = new Map()

/**
 * 真跑一次 `import ipykernel` —— 文件系统检查的**兜底**，消除假阳性/假阴性。
 * 结果按 python 路径缓存（含失败），避免每次启动都拖几百毫秒。
 * @returns {{ok:boolean, detail?:string}}
 */
export function probeIpykernel(python) {
  const key = String(python || "")
  if (!key) return { ok: false, detail: "empty python path" }
  const hit = probeCache.get(key)
  if (hit) return hit
  let result
  try {
    const r = spawnSync(key, ["-c", "import ipykernel, jupyter_client; print('ok')"], {
      encoding: "utf8",
      timeout: 20000,
      windowsHide: true,
    })
    if (r.status === 0 && String(r.stdout).includes("ok")) result = { ok: true }
    else {
      const err = String(r.stderr || "").trim().split(/\r?\n/).filter(Boolean).pop() || `exit ${r.status}`
      result = { ok: false, detail: err.slice(0, 300) }
    }
  } catch (err) {
    result = { ok: false, detail: String((err && err.message) || err).slice(0, 300) }
  }
  probeCache.set(key, result)
  return result
}

/** conda 环境前缀清单：environments.txt → ~/.conda/envs → 常见安装位置。 */
export function condaPrefixes() {
  const out = []
  const seen = new Set()
  function add(p) {
    if (!p) return
    const n = String(p).replace(/[\\/]+$/, "")
    if (!n) return
    const key = n.toLowerCase()
    if (seen.has(key) || !existsSync(n)) return
    seen.add(key)
    out.push(n)
  }
  const envTxt = join(homedir(), ".conda", "environments.txt")
  if (existsSync(envTxt)) {
    try {
      for (const line of readFileSync(envTxt, "utf8").split(/\r?\n/)) add(line.trim())
    } catch {
      /* ignore */
    }
  }
  const envsDir = join(homedir(), ".conda", "envs")
  if (existsSync(envsDir)) {
    try {
      for (const n of readdirSync(envsDir)) add(join(envsDir, n))
    } catch {
      /* ignore */
    }
  }
  add("C:\\ProgramData\\anaconda3")
  add(join(homedir(), "anaconda3"))
  add(join(homedir(), "miniconda3"))
  return out
}

export function kernelIdFor(prefix, python) {
  const base = prefix ? String(prefix).split(/[\\/]/).filter(Boolean).pop() : "python"
  return `conda:${base}:${String(python || "").slice(-24)}`
}

let kernelCache = { at: 0, kernels: null }

/**
 * 候选内核列表（15s 缓存）。装了 ipykernel 的排前面 —— 用户下拉里一眼能挑对。
 * @returns {Array<{id,name,kind,prefix,python,hasIpykernel,display}>}
 */
export function listKernels(now = Date.now()) {
  if (kernelCache.kernels && now - kernelCache.at < 15000) return kernelCache.kernels
  const kernels = []
  for (const prefix of condaPrefixes()) {
    const python = pythonFromPrefix(prefix)
    if (!python) continue
    const name = String(prefix).split(/[\\/]/).filter(Boolean).pop() || prefix
    kernels.push({
      id: kernelIdFor(prefix, python),
      name,
      kind: "conda",
      prefix,
      python,
      hasIpykernel: hasIpykernel(prefix),
      display: `${name}  ·  ${python}`,
    })
  }
  kernels.sort((a, b) => {
    if (a.hasIpykernel !== b.hasIpykernel) return a.hasIpykernel ? -1 : 1
    return String(a.name).localeCompare(String(b.name))
  })
  kernelCache = { at: now, kernels }
  return kernels
}

/** 测试用：清掉缓存，让下一次探测重新扫盘。 */
export function resetCache() {
  kernelCache = { at: 0, kernels: null }
  envselCache = null
}

/**
 * 决定这个会话用哪个解释器。
 * 顺序：显式 config → envsel（含父会话继承，**且必须真有 ipykernel**）→ conda 里有 ipykernel 的 → PATH。
 *
 * 关键细节（评审指出）：envsel 里选中的解释器**也要校验 ipykernel**。
 * 否则用户在 python-env 插件里选了个没装 ipykernel 的环境，就会原样复现
 * `No module named 'ipykernel'` —— 那正是这一轮要修的报错。
 * 命中但缺 ipykernel 时**不硬用**，而是降级到有 ipykernel 的环境，并在结果里标注原因。
 *
 * `source` 的含义（调用方据此决定要不要把 kernelId 固化）：
 *   config / selected —— 用户显式指定，可固化
 *   envsel / conda    —— 自动探测，**不要固化**（否则 envsel 后续变更对本会话永久失效）
 *   path              —— 兜底，通常没有 ipykernel，调用方应给出可诊断提示
 *
 * @param {{sessionId?:string, parents?:Map<string,string>, configPython?:string}} opts
 * @returns {{python:string, source:string, kernelId?:string, display?:string, warning?:string}}
 */
export function resolvePython(opts = {}) {
  const { sessionId, parents, configPython } = opts
  if (configPython && existsSync(configPython)) {
    return { python: configPython, source: "config" }
  }

  const fromEnvsel = envselPython(sessionId, parents)
  if (fromEnvsel) {
    const hit = listKernels().find((k) => k.python.toLowerCase() === fromEnvsel.toLowerCase())
    // 校验 envsel 选中的解释器**真的能用 ipykernel**：
    //   已知前缀且 fs 说装了（有 __init__.py）→ 信它，省一次 spawn；
    //   其余情况（fs 说没有、或根本不是 conda 登记过的路径）→ **实跑** `import ipykernel`。
    // 早先这里是一行三元表达式，因运算符优先级变成「未知路径永不探测」，
    // 结果 envsel 指到一个非 python 的 exe 也照用 → 内核又炸（被 test/python-envsel.mjs 抓到）。
    const verified = hit && hit.hasIpykernel ? { ok: true } : probeIpykernel(fromEnvsel)
    if (!verified.ok) {
      const usable = listKernels().find((k) => k.hasIpykernel)
      if (usable) {
        return {
          python: usable.python,
          source: "conda",
          kernelId: usable.id,
          display: usable.display,
          warning: `envsel 里选的解释器跑不了 ipykernel（${verified.detail || "未知原因"}），已降级到 ${usable.name}`,
        }
      }
      // 没有别的可用环境：如实返回 + 明确 warning，让调用方去拦（ensureSidecar 会报错）
      return {
        python: fromEnvsel,
        source: "envsel",
        kernelId: hit && hit.id,
        display: hit && hit.display,
        warning: `envsel 里选的解释器跑不了 ipykernel（${verified.detail || "未知原因"}），且没有其它可用环境`,
      }
    }
    return { python: fromEnvsel, source: "envsel", kernelId: hit && hit.id, display: hit && hit.display }
  }

  const withKernel = listKernels().find((k) => k.hasIpykernel)
  if (withKernel) {
    return { python: withKernel.python, source: "conda", kernelId: withKernel.id, display: withKernel.display }
  }
  const fallback = process.platform === "win32" ? "python" : "python3"
  return {
    python: fallback,
    source: "path",
    display: fallback,
    warning: "没有探测到装了 ipykernel 的环境，回落到 PATH 上的 python（可能 import ipykernel 失败）",
  }
}

/** 找一个内核 id 对应的 python（前端内核下拉用）。 */
export function kernelById(id) {
  return listKernels().find((k) => k.id === id) || null
}

/**
 * 诊断清单：出错时告诉用户「你有哪些候选、各自什么状态」，而不是一句裸错误。
 * 不 spawn 进程，只看文件系统，所以可以放心在 500 响应里带出去。
 */
export function kernelDiagnostics() {
  const envsel = envselSelections()
  const selections = envsel
    ? Object.entries(envsel).map(([sid, sel]) => ({
        sessionId: sid,
        python: (sel && sel.python && (sel.python.pythonCommand || sel.python.python)) || null,
        exists: !!(sel && envselPythonOf(sel)),
      }))
    : []
  return {
    envselPath: envselStatePath(),
    envselFound: envsel !== null,
    selections,
    lookup: {
      DSH_ENV_PYTHON: process.env.DSH_ENV_PYTHON || null,
      DSH_PYTHON: process.env.DSH_PYTHON || null,
      DSH_PYTHON_ENV_PATH: process.env.DSH_PYTHON_ENV_PATH || null,
    },
    kernels: listKernels().map((k) => ({
      id: k.id,
      name: k.name,
      python: k.python,
      hasIpykernel: k.hasIpykernel,
    })),
    hint:
      "内核需要 ipykernel。若上面没有任何 hasIpykernel=true，请在该环境里 pip install ipykernel，" +
      "或在 Notepad 的 python-env 插件里选一个装了 ipykernel 的解释器，再在 notebook 工具栏的内核下拉里选它。",
    parentOfDir: (p) => dirname(p),
  }
}

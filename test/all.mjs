/**
 * 跑全部测试。任何一个失败就非零退出。
 *
 *   node dsh-notebook-v2/test/all.mjs           # 全跑（含真内核）
 *   node dsh-notebook-v2/test/all.mjs --fast     # 跳过真内核（没装 ipykernel 的机器用）
 *
 * 需要 ipykernel 的用例会用 DSH_PYTHON（默认 PATH 里的 python）。
 */

import { spawnSync } from "node:child_process"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const HERE = dirname(fileURLToPath(import.meta.url))
const fast = process.argv.includes("--fast")

const suites = [
  ["host 冒烟（SSE/seq/续传/工具）", "smoke.mjs", false],
  ["模型 + .ipynb 无损（纯逻辑）", "model.mjs", false],
  ["解释器/内核发现（真机崩溃的防线）", "python.mjs", false],
  ["envsel 降级回归（选了没装 ipykernel 的环境）", "python-envsel.mjs", false],
  ["AI 桥（提示词/chunk/流式/错误）", "ai.mjs", false],
  ["AI 流式（HTTP 层，假 llm）", "ai-http.mjs", false],
  ["内核变量探针（Kernel-aware Prompt 的数据源）", "vars.mjs", false],
  ["客户端纯逻辑（MIME/折叠/键位/主题/diff）", "client-logic.mjs", false],
  ["客户端注册契约", "smoke-client.mjs", false],
  ["markdown 渲染（GFM/公式/消毒路径/图片改写）", "markdown.mjs", false],
  ["大纲（md 标题 + Python 符号树）", "outline.mjs", false],
  ["单元格类型（code/markdown/raw/shell + %%bash 往返）", "celltypes.mjs", false],
  ["shell 执行器（跨平台/流式/超时/中断）", "shell.mjs", false],
  ["内核端到端（需要 ipykernel）", "kernel.mjs", true],
]

let failed = 0
for (const [label, file, needsKernel] of suites) {
  if (needsKernel && fast) {
    console.log(`\n=== ${label} —— 跳过（--fast）`)
    continue
  }
  console.log(`\n=== ${label}`)
  const r = spawnSync(process.execPath, [join(HERE, file)], {
    stdio: "inherit",
    env: process.env,
    cwd: join(HERE, ".."),
  })
  if (r.status !== 0) failed += 1
}

console.log(`\n${failed === 0 ? "所有测试通过 ✅" : `${failed} 个套件失败 ❌`}`)
process.exit(failed === 0 ? 0 : 1)

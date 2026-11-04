# AI 代码补全 / Notebook AI 开源实现调研

> 调研时间：2026-11-04 ｜ 基线：`dsh-notebook-v2` @ `lib/client.js`（6459 行）、`lib/ai.js`、`lib/index.js`
> 调研方式：官方文档 + 仓库源码（raw 直读）+ 厂商工程博客；闭源部分单独标注证据等级（见 §5）
> 所有结论尽量附 URL；标「推测」的是我没验证到一手证据的推断。

---

## 一句话结论

开源实现的差距**不在「会不会调模型」**，而在四件工程事：**① 输入即取消 + 前缀缓存（延迟/成本）② 局部接受（词/行）与多候选（交互）③ 结构化上下文（FIM 拼接、跨 cell、kernel 变量）④ 上下文过滤器（什么时候**不发请求**）**——我们目前 ① ② ④ 基本空缺，③ 只做了「前 3 格源码」。

## P0 建议清单（最多 6 条，每条一行）

1. **在途请求即时取消**：每次 `docChanged` 立刻 `abort()` 上一个请求（现在只在组件 destroy 时 abort，纯烧 token + 结果必被丢弃）——参考 Continue 的 `completionId` + AbortController、JupyterLab 的流式取消。
2. **前缀缓存（最长前缀匹配）**：同 prefix 直接复用、退格复用——参考 Continue `AutocompleteLruCache`（1000 条 LRU + SQLite，`longest-key-startsWith` + `value.startsWith(rest)` 校验）。
3. **把已经写好但没接线的 `acceptWord` 接上键**（`Ctrl/Alt-→` 按词接受），并补一个「按行接受」——现在 `acceptWord` 是死代码（`client.js:452` 定义，全仓库 0 处调用）。
4. **触发判据从「只允许行尾」放宽为「行尾 + 行中（右侧只剩空白/闭合符）」**——这是 `shouldRequestCompletion` 现在最伤的体验限制；Copilot 的做法正是「行中只在右侧是空白/`)`/`]` 时才发」。
5. **kernel 变量进补全提示词**：`/nb2/vars` 已经存在且改写通道已在用（`ai.js:114`），补全通道却完全没用——notebook 场景这是最高性价比的质量杠杆。
6. **失败要可见**：现在 catch 一律 `return null`（`client.js:5458`），超时/鉴权/限流与「模型觉得没啥可补」在 UI 上完全一样；至少要一个错误态指示（JupyterLab ghost 的 error indicator 就是 5s 后自动消失的红点）。

---

## 0. 证据等级说明（先说清楚哪些是硬证据）

| 等级 | 含义 | 本次覆盖 |
|---|---|---|
| **A 源码级** | 直接读实现文件，可给 file:line | Continue、Tabby、JupyterLab（`ghost.ts`/`inline.ts`）、jupyter-ai-lite、VS Code `vscode.d.ts` |
| **B 官方文档/协议** | 官方规格或文档，行为有保证但实现细节不公开 | LSP 3.18、VS Code API、JupyterLab 用户文档、Continue/Tabby 文档、Cursor 帮助中心 |
| **C 厂商工程博客** | 官方口径，但数字多为自测/A-B | GitHub Copilot（FIM/NES/eagerness）、Zed（Zeta）、Supermaven |
| **D 逆向/二手** | 反编译或第三方描述，版本可能过期 | copilot-explorer（Copilot 1.57 逆向）、Codeium Supercomplete 介绍 |

---

## 1. 表 1：能力清单 —— 它们到底提供了什么

列说明：**✅ 有 ｜ ⚠️ 部分/有条件 ｜ ❌ 无 ｜ — 不适用**

### 表 1a · 触发与上下文

| 能力 | Continue.dev | Tabby | JupyterLab 生态（内置 + 第三方 provider） | VS Code API / LSP 3.18 | GitHub Copilot | 其它（Zed / Cursor / Supermaven） |
|---|---|---|---|---|---|---|
| **自动触发（防抖）** | ✅ 默认 `debounceDelay: 250ms`，用「请求 ID 是否仍是最新」判过期（不是简单 clearTimeout）<br>[AutocompleteDebouncer.ts](https://github.com/continuedev/continue/blob/main/core/autocomplete/util/AutocompleteDebouncer.ts) | ✅ IDE 端防抖 + 服务端流式；`[completion] max_input_length=1536 / max_decoding_tokens=64`<br>[docs](https://tabby.tabbyml.com/docs/administration/code-completion/) | ✅ 每个 provider 独立 `debouncerDelay`（可配）+ `timeout`<br>[用户文档](https://jupyterlab.readthedocs.io/en/latest/user/completer.html) | ⚠️ API 层不规定防抖：「用户停止输入时」由编辑器决定<br>[vscode.d.ts](https://github.com/microsoft/vscode/blob/main/src/vscode-dts/vscode.d.ts) | ✅ 有防抖 + 「继续打字时自动适配已有建议」 | Zed ✅；Cursor ✅；Supermaven ✅（自建推理栈） |
| **手动触发快捷键** | ✅ VS Code 侧 `editor.action.inlineSuggest.trigger` 自行绑键 | ✅ VS Code 命令 | ✅ `Alt+\` 显式请求（**与我们同键位**） | ✅ `InlineCompletionTriggerKind.Invoke` | ✅ | Zed ✅（`alt-tab`/`alt-l`） |
| **换行后触发** | ✅ 任一 doc 变更后按防抖触发 | ✅ | ✅ 打字即触发 | — | ✅ | ✅ |
| **注释行触发（注释→代码）** | ⚠️ 无专门「注释语义」规则，靠模型 | ❌ 无专门规则 | ⚠️ 无 | ❌ | ⚠️ 无公开规则（但 prompt 里含注释上下文） | Cursor ⚠️ 无文档 |
| **「只在编辑态触发」** | ✅ 仅活动编辑器 | ✅ | ✅ 仅活动 cell | ✅ 由编辑器 host 控制 | ✅ | ✅ |
| **同文件 prefix + suffix（FIM）** | ✅ 核心就是 prefix/suffix 拼接 | ✅ FIM 模板 `{prefix}{suffix}` 可配<br>[model 配置](https://tabby.tabbyml.com/docs/administration/model/) | ✅ provider 拿 `request.text`+`offset` 自己切前缀后缀 | ✅ `range`/`insertText`，suffix 由编辑器给 | ✅ 官方称 FIM 带来 **+10% 相对接受率**<br>[blog](https://github.blog/ai-and-ml/github-copilot/how-github-copilot-is-getting-better-at-understanding-your-code/) | Zed ✅（但 NES 走「重写」而非 FIM）；Supermaven ✅ |
| **跨文件 import / 邻接标签页** | ✅ 三类：@-cursor 符号的 LSP 定义、匹配到的 import 符号、最近打开/编辑文件片段<br>[context-selection](https://docs.continue.dev/ide-extensions/autocomplete/context-selection) | ✅ 仓库索引（tree-sitter） | ❌ 内置无（provider 自行决定） | ❌ 协议不管上下文来源 | ✅「neighboring tabs」：取最近 20 个**同语言**文件，滑窗 + Jaccard 选片段，**+5% 相对接受率** | Cursor ✅ 跨文件编辑（有 portal 窗口提示） |
| **仓库级检索（RAG）** | ✅ @Codebase 体系（autocomplete 里是轻量检索，非全量向量） | ✅ **BM25 + tree-sitter 片段 + token 倒排索引**，片段以行注释风格注入，预算 ~2000 token<br>[blog](https://www.tabbyml.com/blog/repository-context-for-code-completion) | ❌ | ❌ | ⚠️ 官方称「实验向量库」阶段（2023 口径） | ❌（Supermaven 用 300k 长上下文替代检索） |
| **最近编辑** | ✅「recent file context」 | ⚠️ 索引侧 | ❌ | ❌ | ⚠️ NES 显式用「最近编辑序列」 | ✅ Cursor「基于你最近的编辑」；Supermaven「按 diff 序列训练」 |
| **光标处变量类型** | ✅ 走 LSP `textDocument/definition` 取类型/定义 | ⚠️ 依赖索引里的符号 | ✅ **kernel 可回答**，但 provider 里默认没用（JupyterLab 的 History provider 只用历史执行行） | ❌ | ⚠️ 无公开细节 | Cursor ✅（文档称结合 linter 错误） |
| **Notebook 跨 cell 上下文** | ❌ 不做 notebook 特化 | ❌ | ✅ provider 能拿到 `NotebookPanel`（jupyter-ai-lite：**上+下所有 code cell** 拼进 prompt）<br>[completion-provider.ts](https://github.com/jupyterlab/jupyter-ai-lite/blob/main/packages/jupyternaut-lite/src/completion/completion-provider.ts) | ⚠️ 每个 cell 是独立 TextDocument，跨 cell 需扩展自己拼 | ⚠️ 无公开细节 | ❌ |
| **Kernel 运行时变量（notebook 独有）** | — | — | ⚠️ **有基础设施，没人用在补全里**（JupyterLab 有 kernel `complete_request`，但那是补全列表不是 LLM 上下文） | — | — | — |
| **代码被拒后停止打扰** | ⚠️ 有后处理丢弃，无「用户刚拒过就少发」 | ❌ | ❌ | ❌ | ✅ **contextual filter**：11 特征逻辑回归打分，<15% 直接不发请求<br>[逆向](https://thakkarparth007.github.io/copilot-explorer/posts/copilot-internals.html) | ❌ |

### 表 1b · 接受交互与呈现

| 能力 | Continue.dev | Tabby | JupyterLab 生态 | VS Code / LSP | Copilot | 其它 |
|---|---|---|---|---|---|---|
| **全量接受** | ✅ Tab | ✅ Tab | ✅ `Tab` 或 `Alt+End` | ✅ Tab（host 实现） | ✅ Tab | ✅ |
| **按词部分接受** | ⚠️ 依赖宿主命令（VS Code `acceptNextWord`） | ❌ | ❌ 协议无此概念 | ✅ 编辑器命令 `editor.action.inlineSuggest.acceptNextWord`（**不在扩展 API 里**，是 host 命令） | ✅ `Ctrl-→` | Cursor ✅ `Cmd/Ctrl-→`（官方文档写明） |
| **按行部分接受** | ⚠️ 同上 | ❌ | ❌ | ✅ `acceptNextLine` | ✅ | Cursor ⚠️ 无文档 |
| **拒绝** | ✅ Esc | ✅ | ✅ Esc | ✅ | ✅ Esc / 继续打字即隐式拒绝 | ✅ |
| **多候选轮换** | ❌ 单条 | ❌ | ✅ **`Alt+[` / `Alt+]` 轮换**，widget 显示「第 n/N 条」 | ✅ 返回数组即支持，host 提供 next/previous | ✅ 显式触发时返回多条 | ❌（Cursor 无文档） |
| **接受后 undo** | ✅ 走宿主编辑栈 | ✅ | ✅ 单事务插入 | ✅ | ✅ | ✅ |
| **接受时自动格式化** | ⚠️ 有「修正缩进」后处理，不做整段 format | ❌ | ❌ | ❌ | ⚠️ 无公开说明 | ❌ |
| **单行/多行幽灵文本** | ✅（`multilineCompletions: auto/always/never`） | ✅ | ✅ **多行 + `minLines/maxLines`（默认 2/4）+ 超出行数折叠成 `⇓` 悬停展开** | ✅ host 渲染 | ✅ | ✅ |
| **diff 预览** | ✅ Next Edit 用 diff overlay | ❌ | ❌ | ⚠️ 需 `isInlineEdit` 提案 API | ✅ NES 是 diff 形态 | Zed ✅（重写式，天然是 diff）；Cursor ✅ |
| **内联 diff 面板（可编辑）** | ✅（Next Edit 里可编辑再接受） | ❌ | ❌ | ❌ | ⚠️ NES 有 inline edit menu（提案 API `showInlineEditMenu`） | Cursor ✅ |
| **状态指示（在途/失败）** | ⚠️ 状态栏图标 | ⚠️ | ✅ **streaming indicator + error indicator（5s 自动消失，hover 显示 message）** | ✅ host 有 loading 态 | ✅ | ✅ |
| **流式 ghosts（逐 token 长出）** | ✅ 有 streaming transforms | ✅「incremental decoding」 | ✅ `stream()` + `uncover` 动画 | ⚠️ 提案 API 支持 | ✅ | ✅ |

### 表 1c · 延迟/成本、质量策略、设置

| 能力 | Continue.dev | Tabby | JupyterLab 生态 | VS Code / LSP | Copilot | 其它 |
|---|---|---|---|---|---|---|
| **取消（AbortController）** | ✅ 每请求 `completionId` + controller；**postprocess 前检查 `token.aborted`**<br>[CompletionProvider.ts](https://github.com/continuedev/continue/blob/main/core/autocomplete/CompletionProvider.ts) | ✅ 流式 + 提前停止 | ✅ 切换/新键入即丢 | ✅ `CancellationToken` 参数 | ✅ 官方称「输入即取消」为基本设计 | ✅ |
| **缓存** | ✅ **最长前缀匹配 LRU**（1000 条、SQLite 落盘、30s flush） | ✅ 服务端 prompt cache | ❌ provider 各自实现 | ❌ 无（host 不做语义缓存） | ✅「aggressively caches」+ **suffix 跨调用缓存**（逆向） | Supermaven ✅ 长上下文 + 栈内缓存 |
| **超时** | ✅ `modelTimeout`（默认 150ms 级） | ✅ | ✅ 每 provider `timeout` | ⚠️ 无标准 | ✅ | Zed ✅（p50<200ms / p90<500ms 目标） |
| **Token 预算** | ✅ `maxPromptTokens: 1024`、`prefixPercentage: 0.3`、`maxSuffixPercentage: 0.2` | ✅ `max_input_length=1536`、`max_decoding_tokens=64` | ⚠️ 由 provider 定 | ❌ | ✅ `suffixPercent` 默认 ~15%，按元素优先级填预算（逆向） | — |
| **模型分级（快模型补全 / 强模型改写）** | ✅ 独立 `autocomplete` model role | ✅ 独立 completion 模型 | ✅ provider 粒度 | — | ✅（另有「3-in-1」统一补全/NES/长距离 NES 模型） | Cursor ✅（自研 Tab 模型） |
| **FIM 特殊 token 模板** | ✅ **20+ 种模板**：`<fim_prefix>/<fim_suffix>/<fim_middle>`（StarCoder/Qwen/CodeGemma）、`[SUFFIX]..[PREFIX]..`（Codestral）、`<PRE>/<SUF>/<MID>`（CodeLlama）、`<｜fim▁begin｜>..`（DeepSeek）、**hole-filler 自然语言模板**（GPT/Claude）<br>[AutocompleteTemplate.ts](https://github.com/continuedev/continue/blob/main/core/autocomplete/templating/AutocompleteTemplate.ts) | ✅ `prompt_template` 可配，内置注释里列了 StarCoder/CodeGemma token<br>[languages.rs](https://github.com/TabbyML/tabby/blob/main/crates/tabby-common/src/languages.rs) | ⚠️ jupyter-ai-lite 用 `<PRE>..<SUF>..<MID>`（CodeLlama 风格）+ 系统提示 | ❌ | ❌ 闭源（早期是 Codex insert mode） | Zed 明确**不用 FIM**：改为「重写光标附近片段」 |
| **stop 序列** | ✅ 每模板自带（如 Codestral `\n+++++ `、DeepSeek `//`） | ✅ | ⚠️ | ❌ | ✅（逆向可见） | — |
| **去重叠** | ✅ 后处理链 | ✅ | ❌ | ❌ | ✅「用户已输入则丢弃」 | — |
| **空建议抑制** | ✅ | ✅ | ✅（`items: []`） | ✅（返回空数组） | ✅ | ✅ |
| **重复建议抑制** | ✅「丢弃过度重复的响应」 | ⚠️ | ❌ | ❌ | ✅ 重复检测在客户端**和**代理服务端都做 | ✅ |
| **字符串/注释里是否补全** | ⚠️ `onlyMyCode: true`（排除依赖/生成代码），无语法级判定 | ⚠️ 符号索引 | ❌ | ❌ | ⚠️ 行中黑名单 + contextual filter 特征含「最后字符」 | Cursor ⚠️ 按扩展名禁用（非语法级） |
| **独立开关** | ✅ | ✅ | ✅ 每 provider `enabled` | ✅ `editor.inlineSuggest.enabled` | ✅ | ✅ |
| **模型选择** | ✅ | ✅ | ✅ | — | ✅ | ✅ |
| **延迟可调** | ✅ `debounceDelay` | ⚠️ 服务端 | ✅ `debouncerDelay` | ❌ | ✅（eagerness，见 §2） | ❌ |
| **最大行数可调** | ✅ `multilineCompletions` | ❌ | ✅ `maxLines/minLines` | ❌ | ✅ | ❌ |
| **按语言/文件开关** | ✅ `disableInFiles` glob | ✅ `additional_languages` | ⚠️ provider 自定 | ✅ `DocumentSelector` | ✅ 按语言（contextual filter 权重） | Cursor ✅ 按扩展名禁用 |
| **Telemetry/隐私** | ✅ 可关 | ✅ 可自托管 | ✅ 无遥测 | — | ✅ 可 opt-out（opt-out 后片段不出本机） | ✅ |

> **注**：`onlyMyCode`/`disableInFiles`/`multilineCompletions`/`debounceDelay` 等键名与默认值来自 Continue 官方文档的 `autocompleteOptions` 段（[deep-dive](https://docs.continue.dev/customize/deep-dives/autocomplete)）。

---

## 2. Next Edit Suggestion（NES）专段 —— 近两年的主战场

**一句话**：NES 不是「补全的加强版」，而是**换了任务定义**——从「在光标处插入文本」变成「在任意位置改写一段文本」，因此**必须有 diff 呈现 + 跳转**，也必须**专门训模型**。我们短期内不该做，但必须理解它的取舍。

### 2.1 GitHub Copilot NES（闭源，但有大量官方口径）

- **起点**：2025-02 上线，定位是「预测下一处逻辑编辑」的**专用低延迟模型**，明确说「前沿通用模型不达标：小的质量差、大的太慢」<br>[Evolving NES blog](https://github.blog/ai-and-ml/github-copilot/evolving-github-copilots-next-edit-suggestions-through-custom-model-training/)
- **训练数据是最大障碍**：用 PR diff 训练**失败**了（只含最终态、无时序、几乎没有「不该编辑」的负样本、丢掉了被放弃的编辑），实测**比普通 LLM 还差**；改为**采集真人编辑会话** + SFT，再用 RL + 大模型 grader 判优（grader 还要求「diff 在 UI 上易读」）。
- **成本/延迟工程**（对我们最有参考价值）：NES **每分钟跑很多次**，所以
  - 精简 prompt、**复用缓存 token**、去掉无用标记 → 直接降延迟；
  - 缩短响应长度；
  - 用 LLM grader 过掉低信号样本，再加「no-edit」负样本降低**过度打扰**。
- **效果指标**（A/B，官方表格）：November 版相对线上 **shown rate −24.5%、acceptance +26.5%、hide rate −25.6%** —— 注意**「少显示」本身就是正向指标**，这是 NES 与补全完全不同的产品逻辑。
- **交互**：diff overlay，`Tab` 接受 / `Esc` 拒绝；接受后光标落到最后一处改动行；**「Long-Distance NES」**可跨文件跳转。
- **eagerness（2026-10，最新）**：一个模型三种行为，用**控制标签** `<|aggression|>low<|/aggression|>`（high 同款，medium 不加标签）；用**编辑距离**作为 eagerness 的可度量代理（同时反映「改多大」与「改多频繁」）。保持默认行为用 on-policy distillation。<br>[VS Code blog](https://code.visualstudio.com/blogs/2026/10/27/configurable-eagerness)
- **VS Code 侧如何承载 NES**（源码级，A 级）：`InlineCompletionItem.isInlineEdit` 与 `showInlineEditMenu` 是**提案 API**（`_isAdditionsProposedApiEnabled` 才透传），主线程把它映射成 `presentation: item.isInlineEdit ? 'nextEditSuggestion' : 'inlineCompletion'`<br>[extHostLanguageFeatures.ts](https://github.com/microsoft/vscode/blob/main/src/vs/workbench/api/common/extHostLanguageFeatures.ts)、[mainThreadLanguageFeatures.ts](https://github.com/microsoft/vscode/blob/main/src/vs/workbench/api/browser/mainThreadLanguageFeatures.ts)
  → **结论**：稳定 API 里**没有** NES 概念；要做 diff 式编辑建议，只能借「整段 range 替换」的 inline completion 模拟。

### 2.2 Zed Zeta（**开源**，目前最好的可复刻 NES 参考）

[zed.dev/blog/edit-prediction](https://zed.dev/blog/edit-prediction) + 模型/数据集 [zed-industries/zeta](https://huggingface.co/zed-industries/zeta)

- **明确否掉 FIM**：「FIM 只能补光标处，NES 要在**任意位置**编辑，结构不匹配」→ 改为 **editing by rewriting**：给「最近编辑列表 + 光标位置」，让模型**重写光标附近一段文本**，客户端算 diff。
- **延迟指标（可直接当我们的验收线）**：p50 **<200ms**、p90 **<500ms**。
- **关键技巧**：重写式输出**大部分与输入相同**，于是用 **n-gram 搜索输入找到可并行起跳点做投机解码**，把「多 token 重写」压回可接受延迟。
- 模型：Qwen2.5-Coder-7B 派生 + SFT(LoRA/Unsloth) + **DPO（~150 条精选负例解决「局部乱删改」）**，数据集开源。
- **UX 冲突处理**：LSP 补全菜单打开时**不预览**预测，按 `Alt/Option` 才预览并隐藏菜单；Linux 给 `alt-l` 备选；`Tab` 可连续接受多处。
- 评测方法（很实用）：**用更大的 LLM 当裁判**判「是否达成意图」，而非断言具体 token（temperature=0 + seed 降低抖动）。

### 2.3 Continue Next Edit（开源，实验性）

- 需要专门模型（**Instinct** 开源模型 / Mercury Coder），VS Code only，JetBrains 未支持。
- 流程：捕获光标 + **最近编辑历史** → 预测 → **diff overlay** 呈现 → `Tab` 接受 / `Esc` 拒绝 → 接受后光标落到最后改动行 → 再 `Tab` 跳到**下一处**编辑位置。
- 触发：**「你刚做完一次改动」**时自动激活（不是打字防抖）。<br>[next-edit 文档](https://docs.continue.dev/ide-extensions/autocomplete/next-edit)

### 2.4 其它（可观察行为）

- **Cursor Tab**：多行编辑 + 自动补 import + 跨文件协调编辑；接受后**再按 Tab 会「jump-in-file」到下一个编辑位置**；跨文件时底部出现 portal 窗口。<br>[cursor.com/help/ai-features/tab](https://cursor.com/help/ai-features/tab)
- **Supermaven**：不按文件看代码，**按「编辑序列（git diff 视角）」训练**，300k token 上下文，官方自测延迟 250ms（Copilot 783ms / Cursor 1883ms，**厂商自测，有利益相关**）。<br>[blog](https://supermaven.com/blog/introducing-supermaven)
- **Codeium/Windsurf Supercomplete**：宣称「edit-based」而非 insert-based，能预测「下一次跳转」。**本次未找到一手实现文档**（见 §5）。

**对我们的判断**：NES 的**产品价值高但成本极高**（专模型 + 编辑会话数据 + 评测体系 + diff UI）。开源项目里只有 Zed 真正做成了「可复刻」的形态，且它靠**投机解码 + 自建推理**才达标。我们在本地 HTTP + 通用 chat 模型的条件下做 NES，延迟会落在 1–3s，**体验上是负收益**——不建议做，见 §4「不值得做」。

---

## 3. 表 2：实现手法 —— 具体怎么做（可复用要点）

### 3.1 CM6 里做 inline completion（我们直接可用）

**标准骨架**（`StateField` + `Decoration.widget`，我们已经是这个形状，`client.js:293`）：

```js
const field = CM.StateField.define({
  create: () => null,
  update(v, tr) { /* effect 设/清；tr.docChanged 或 tr.selection 则置空 */ },
  provide: f => CM.EditorView.decorations.from(f, v => v ? CM.Decoration.set([...]) : CM.Decoration.none)
})
```

**JupyterLab 的 `ghost.ts` 是这条路的「工业级答案」，值得逐条抄**（[ghost.ts](https://github.com/jupyterlab/jupyterlab/blob/main/packages/completer/src/ghost.ts)）：

| 问题 | JupyterLab 的做法 | 我们现在 |
|---|---|---|
| 幽灵文本位置漂移 | `addMark` effect 带 `map: (old, change) => ({from: change.mapPos(old.from)})`，**随事务映射**，不靠「重设」 | ⚠️ 任何 doc 变更直接置 null，宁可闪烁也不漂 |
| 用户继续打字时的体验 | **增量收缩**：若插入文本恰好是幽灵内容的前缀（`spec.content.startsWith(line)`），就 `slice` 掉已输入部分，**幽灵跟着后退**；只有删除/替换才移除 | ❌ 一律清除 → 打一个字就没了 |
| 多行高度抖动 | 移除多行幽灵时插入 **`TransientLineSpacer`/`TransientLetterSpacer`**，延迟 700ms + 300ms 动画后才真正塌陷 | ❌ 无（多行时会跳） |
| 超长建议 | `maxLines` 截断 + 隐藏部分包成 `⇓` 悬停展开；`minLines` 预留行数稳定高度 | ❌ 全量渲染 |
| 语法高亮 | 复用 `EditorLanguageRegistry.highlight(content, lang, dom)` 把高亮 HTML 塞进 widget | ❌ 纯灰斜体 |
| 在途/失败 | `streaming` → 尾随光标动画；`error` → 红点，**5s 后自动移除**，`title=message` | ⚠️ 只有全局 `onBusy` |
| 逐 token | `addedPart` 只把「本次新增后缀」包成 `jp-GhostText-streamedToken` 做 `uncover` 动画 | ❌ 无流式 |
| 失焦 | `domEventHandlers({blur})` → `setTimeout(0)` 后清 ghost（避免打断编辑器更新） | ❌ 未处理 |
| 多 provider 共存 | widget 打 `dataset.providedBy = providerId`，CSS 可按 provider 定制 | — |

**部分接受的实现**（我们已有 `acceptWord` 雏形，`client.js:452`）：
- 按词：`/^[^\s]*\s?/` 切出首词 → `dispatch({changes:{from:pos,to:pos,insert:piece}, effects: setGhost.of({pos: pos+piece.length, suggestion: rest})})`。
- 按行：`suggestion.slice(0, suggestion.indexOf("\n")+1)` 同法；**关键是把剩余建议的 `pos` 一起平移**，否则下一次接受会插错位置。
- **undo 语义**：一次 `dispatch` 就是一条 undo 记录 → 按词接受 5 次会有 5 步 undo。VS Code/GitHub 的语义是「接受动作本身可整体撤销」，若要那效果需用 `CM.history` 的 `isolateHistory` 或自己合并事务（成本高，可先不做）。

**注**：在 CM6 里**不必**用 `@codemirror/autocomplete` 的 inline suggestion——那个包面向「补全列表」，多行幽灵文本 + 自定义 keymap 用 `StateField + Decoration.widget` 更可控（JupyterLab 也是这么做的）。

### 3.2 VS Code `InlineCompletionItemProvider` 协议（B 级，稳定 API）

```ts
provideInlineCompletionItems(document, position, context, token): ProviderResult<InlineCompletionItem[] | InlineCompletionList>
InlineCompletionItem { insertText: string | SnippetString; filterText?; range?: Range; command?: Command }
InlineCompletionTriggerKind { Invoke = 0, Automatic = 1 }
InlineCompletionContext { triggerKind, selectedCompletionInfo? }
```

要点（[vscode.d.ts](https://github.com/microsoft/vscode/blob/main/src/vscode-dts/vscode.d.ts)）：
- **`range` 必须在同一行内**（原文：`Must begin and end on the same line`）→ **多行替换不是标准能力**，这是 NES 必须走提案 API 的根本原因。
- **「Prefer replacements over insertions」**：用 `range` 覆盖已输入的前缀，用户退格时体验更好（否则建议会被 filterText 判掉）。
- `filterText` 语义：**「替换后的文本」是 filterText 的前缀**才显示。
- `command`：接受后执行（可用来做「接受后高亮/统计/继续请求」）。
- **Notebook 里如何工作**：每个 cell 是一个 `TextDocument`（URI 形如 `vscode-notebook-cell:///.../nb.ipynb#cellId`），provider 对 cell 文档同样触发；**跨 cell 上下文完全靠扩展自己拼**（协议不提供）。可用 `DocumentSelector { notebookType: 'jupyter-notebook' }` 限定 notebook。
- 提案 API 才有：`isInlineEdit`（diff 式）、`showInlineEditMenu`、`supportsRename`、`displayLocation`（见 §2.1 源码证据）。

### 3.3 LSP 3.18 `textDocument/inlineCompletion`（B 级，协议原文）

[规范](https://microsoft.github.io/language-server-protocol/specifications/lsp/3.18/specification/#textDocument_inlineCompletion)

- `InlineCompletionParams extends TextDocumentPositionParams` + `context.triggerKind`（`Invoked=1` / `Automatic=2`）+ `selectedCompletionInfo`。
- `InlineCompletionItem { insertText: string | StringValue; filterText?; range?; command? }`，`range` 同样**限单行**。
- 规范原文有两句很值得我们写进设计注释：
  - 「inline completion 通常补**更大块**文本（例如整个方法），且**允许语法/语义不完整**」；
  - 「多条时，客户端可决定让用户轮换，或仅用其 filterText 过滤」。
- **注意**：规范**不规定** debounce、缓存、取消语义（取消走通用 `$/cancelRequest`）。

### 3.4 FIM 提示词构造（A 级，Continue 全量模板可抄）

**拼接三类**（[AutocompleteTemplate.ts](https://github.com/continuedev/continue/blob/main/core/autocomplete/templating/AutocompleteTemplate.ts)）：

| 形态 | 例 | 适用 |
|---|---|---|
| 特殊 token 三段式 | `<fim_prefix>{prefix}<fim_suffix>{suffix}<fim_middle>` | StarCoder/Stable/Qwen2.5-Coder(非 repo 版)/CodeGemma/Granite |
| 反序 + 标记 | Codestral：`[SUFFIX]{suffix}[PREFIX]{prefix}` | Codestral |
| CodeLlama | `<PRE> {prefix} <SUF>{suffix} <MID>` | CodeLlama |
| DeepSeek | `<｜fim▁begin｜>…<｜fim▁hole｜>…<｜fim▁end｜>` | deepseek-coder |
| **自然语言填空**（无 FIM 训练时） | 把 `[BLANK]` 放进代码块 + 「Fill in the blank…」指令；GPT/Claude 走 **hole-filler** 长模板（`<COMPLETION>…</COMPLETION>` + stop） | **通用 chat 模型（我们的情况）** |

**多文件/RAG 注入格式**：Codestral 用 `+++++ {path}\n{content}`，Qwen 多文件用 `<|repo_name|>…<|file_sep|>path\n<content>`，StarCoder2 用 `<file_sep>`，Tabby 用**行注释包起来**（`// Path: …`）以保证「不破坏语义、模型易读」。

**预算分配（可直接抄的参数）**：

| 来源 | 参数 | 值 |
|---|---|---|
| Continue | `maxPromptTokens` / `prefixPercentage` / `maxSuffixPercentage` | 1024 / 0.3 / 0.2 |
| Tabby | `max_input_length` / `max_decoding_tokens` | 1536 字符 / 64 token |
| Copilot（逆向） | `suffixPercent` | ~15% |
| Copilot（官方） | 整个上下文窗口 | ~6000 字符（2023 口径，后扩到 8k token） |

**我们该怎么落地**：我们是**通用 chat 模型**（`dsh llm.stream`），**没有 FIM 训练**。所以：
- ❌ 不要硬拼 `<fim_prefix>`——那是给 FIM 训练过的模型用的，拼了只会退化；
- ✅ 学 **Continue 的 hole-filler / gptAutocompleteTemplate 思路**：把 prefix/suffix 放进代码块 + `[BLANK]`/`<CURSOR>` 标记 + 明确「只输出替换内容」+ stop 序列。我们现在的 `ghost` 提示词（`ai.js:63-97`）已经接近这个，缺的是：**stop 序列**、**显式 token 预算**、**`max_tokens` 上限**。

### 3.5 取消与并发

**Continue 模式（最干净）**：每次请求生成 `completionId` → 建 `AbortController` 登记 → 新请求进来先 abort 旧的 → **后处理前检查 `token.aborted`**（避免把半截结果 postprocess 后展示）→ 结束时 `deleteAbortController`。

**我们现状（`client.js:329-376`）**：`schedule()` 只 `clearTimeout` + 新定时器；**in-flight 的 `ac` 只在 `destroy()` 里 abort**（`client.js:398-412`）。所以「打了 2 个字」会：旧请求继续跑完 → 结果因 `doc` 比对失败被丢弃 → **白烧一次 token + 占一个连接**。修法：在 `schedule()` 开头（和 `docChanged` 时）abort `inflight`，并把 `inflight` 的判定改成「只接受最新一次请求的结果」。

### 3.6 缓存（Continue 的「最长前缀匹配」是关键技巧）

[AutocompleteLruCache.ts](https://github.com/continuedev/continue/blob/main/core/autocomplete/util/AutocompleteLruCache.ts)：

```
get(prefix):
  找最长的已缓存 key，使 prefix.startsWith(key)
  且 entry.value.startsWith(prefix.slice(key.length))   // 校验：剩余输入确实是补全的前缀
  → 返回 value.slice(prefix.length - key.length)        // 把已输入部分裁掉
```

- 效果：**退格 / 继续敲同一个词 → 立刻命中**，不用等网络；
- 容量 1000、SQLite 落盘、30s 批量 flush、时间戳做 LRU；
- 我们只要内存版就够（结合我们的场景，key 可用 `cellId + prefix 尾部 N 字符` 的 hash，避免存整段）。

### 3.7 Notebook 里取 kernel 变量 / 输出作为上下文

- **JupyterLab 生态**：provider 直接拿 `NotebookPanel` → 遍历 `notebook.widgets` 取 `cell.model.sharedModel.source`（jupyter-ai-lite 就是这么拼上/下 cell 的，见其 `_extractNotebookContext`）。
- **Kernel 侧**：Jupyter 协议里 `complete_request` / `inspect_request` 是**补全列表/文档**，不是给 LLM 的上下文；真正有用的是**用户命名空间的自省**（JupyterLab 用 `%who`/`dir()` 一类手段，Provider 里可调 kernel 执行代码）。
- **我们已经有现成的**：`/nb2/vars`（`lib/index.js:1456`，带 `maxAgeMs` 缓存 + 超时兜底），返回 `{name, type, detail}`，且 `ai.js:114` 的**改写**通道已经在用它（`vars.slice(0, 24)`）。补全通道**一行没传**——这是最容易补的一块。

### 3.8 「不发请求」的判据（Copilot contextual filter，D 级但极有启发）

逆向（Copilot 1.57）显示它是**11 特征逻辑回归**，输出「值得请求」的分数，**低于 15% 就不发**。特征包括：语言、上一次建议是否被接受/拒绝、距上次接受/拒绝的时长、prompt 最后一行长度、**光标前最后一个字符**。

几个权重结论很反直觉但可复用：
- 行尾是 `)`/`]` → 分数更低（-0.999 / -0.970）；行尾是 `(`/`[` → 更高（0.932 / 0.049）→ **「刚打开的括号才值得补」**；
- 语言权重不同（php > js > python > rust > dart）；
- **行中请求**只在「光标右侧是空白/闭合括号」时才发。

我们 `shouldRequestCompletion`（`client.js:205`）的本质就是**手写的 0/1 版 filter**：只判行尾 + 末尾非运算符 + 非空行。可以直接升级为「打分 + 阈值」，把「上一次被拒」「光标前字符」两个特征加进去。

---

## 4. 表 3：差距与建议（以 `dsh-notebook-v2` 现状为基线）

### 4.1 现状核对（源码级，均已读过）

| 能力 | 现状 | 证据 |
|---|---|---|
| 自动触发 | ✅ 550ms 防抖（`setTimeout(..., 550)`），`minGap 600` 二次限流 | `client.js:329-376`（`374`、`339/345`） |
| 手动触发 | ✅ `Alt-\`（`force`，绕过 enabled） | `client.js:2639`、`433` |
| 触发前提 | ⚠️ **只允许行尾**（`tail.trim()` 即返回 false）、prefix ≥3 字符、非空行、末尾非运算符黑名单 | `client.js:205-228` |
| 注释行特判 | ✅ 纯注释 → 另起一行插代码（prompt 与插入位置**同一套判定**） | `client.js:754`、`772`、`ai.js:71-73` |
| 上下文 | ⚠️ 当前格 prefix+suffix + **前 3 个 code/bash 格**（每格尾部 1500 字符） | `client.js:5417-5426`、`index.js:1590` |
| kernel 变量 | ❌ 补全通道完全没用（改写通道用了） | `ai.js:114` vs `ai.js:63-97` |
| 注释字符串外/内判定 | ⚠️ 只有「行首 `#`」；无字符串/多行字符串判定 | `client.js:754` |
| 全量接受 | ✅ `Tab`（keymap 第一条，防被 `indentWithTab` 抢） | `client.js:2626`、`438` |
| 按词接受 | ❌ **死代码**：`acceptWord` 定义但**全仓库 0 处调用** | `client.js:452`（grep 仅命中定义与 `.bak`） |
| 按行接受 | ❌ 无 | — |
| 拒绝 | ✅ `Esc` | `client.js:466`、`2640` |
| 多候选 | ❌ 单条 | — |
| undo | ✅ 走 CM 事务（一次 dispatch） | `client.js:441-445` |
| 多行幽灵文本 | ⚠️ 单个 `Decoration.widget` + `whiteSpace: "pre"`；**无 maxLines、无折叠、无行高预留** | `client.js:271-288`、`415-422` |
| 语法高亮 ghost | ❌ 只有灰+斜体 | 同上 |
| diff 预览 | ❌ | — |
| 在途指示 | ✅ `onBusy` → 面板状态栏 | `client.js:5406`、`354` |
| 失败可见 | ❌ 一律 `return null` | `client.js:5458-5460` |
| **在途取消** | ❌ **只在 destroy 时 abort**，新键入不取消 | `client.js:398-412`、`329` |
| 缓存 | ❌ 无 | — |
| 超时 | ✅ 客户端 6000ms；服务端 clamp 1500–20000ms | `client.js:5436`、`index.js:1574` |
| token 预算 / max_tokens | ❌ 无显式上限 | `index.js:1580-1602` |
| stop 序列 | ❌ 无 | `index.js` 未传 |
| 重复/已输入抑制 | ✅ `normalizeSuggestion`（去围栏/只取第一段）+ `trimOverlap` + `prefix.endsWith` 兜底 | `client.js:231`、`249`、`5456` |
| 模型/开关 | ✅ 独立 `aiPrefs.completion`（有/无 provider/model/effort） | `client.js:699-737`、`5439-5441` |
| 延迟/最大行数/按语言开关 | ❌ 全是硬编码常量 | `client.js:374` |
| NES | ❌ | — |

### 4.2 建议表（能力 ｜ 现状 ｜ 参考实现 ｜ 工作量 ｜ 优先级）

| # | 能力 | 现状 | 参考实现（项目 / API） | 工作量 | 优先级 |
|---|---|---|---|---|---|
| 1 | 在途请求即时取消 | ❌ | Continue `completionId`+AbortController；JupyterLab 切换即丢 | **S** | **P0** |
| 2 | 前缀缓存（最长前缀匹配） | ❌ | Continue `AutocompleteLruCache`（内存版即可） | **S** | **P0** |
| 3 | 按词接受接线 | ❌ 死代码 | 已有 `acceptWord`；VS Code `acceptNextWord`；Cursor `Ctrl-→` | **S** | **P0** |
| 4 | 按行接受 | ❌ | VS Code `acceptNextLine`；JupyterLab 无（可自造） | **S** | **P1** |
| 5 | 触发放宽：行中（右侧仅空白/闭合符） | ⚠️ 只行尾 | Copilot 逆向：行中仅当右侧是空白/`)`/`]`；LSP `selectedCompletionInfo` | **S** | **P0** |
| 6 | 上下文过滤器（打分/阈值 + 「刚被拒就少发」） | ❌ | Copilot contextual filter（11 特征 LR 版可简化成 5 特征） | **M** | **P1** |
| 7 | kernel 变量进补全提示 | ❌ | `/nb2/vars` 已存在；`ai.js:114` 已有格式化代码 | **S** | **P0** |
| 8 | 跨格上下文增强（含 markdown 意图、后序格、按预算截断） | ⚠️ 只前序 3 格 | jupyter-ai-lite `_extractNotebookContext`（上+下 + 预算） | **S** | **P1** |
| 9 | 失败可见（错误态/超时态） | ❌ | JupyterLab ghost `error` 红点 5s 自动消失 | **S** | **P0** |
| 10 | 多行 ghost 渲染加固（maxLines + 折叠 + 行高预留） | ⚠️ 全量渲染 | JupyterLab `ghost.ts`（`maxLines`/`⇓`/spacer） | **M** | **P1** |
| 11 | 增量收缩（打字时幽灵后退而非消失） | ❌ | JupyterLab `FilterAndUpdate` + `startsWith` 切片 | **M** | **P1** |
| 12 | ghost 语法高亮 | ❌ | JupyterLab `EditorLanguageRegistry.highlight`（我们可复用已 vendor 的 lezer/highlight） | **M** | **P2** |
| 13 | 设置项：延迟 / 最大行数 / 按语言开关 | ❌ 硬编码 | Continue `debounceDelay`/`multilineCompletions`/`disableInFiles`；JupyterLab `debouncerDelay`/`maxLines` | **S** | **P1** |
| 14 | stop 序列 + max_tokens 上限 | ❌ | Continue 每模板自带 stop；Tabby `max_decoding_tokens=64` | **S** | **P1** |
| 15 | 流式 ghosts（逐 token 长出） | ❌ | JupyterLab `stream()` + `uncover`；Continue streaming transforms | **L** | **P2** |
| 16 | 多候选轮换 | ❌ | JupyterLab `Alt+[`/`Alt+]` + widget 计数 | **M** | **P2** |
| 17 | diff 预览 / inline diff 面板 | ❌ | Zed「重写式 + diff」；Copilot NES；VS Code 提案 `isInlineEdit` | **L** | **P2** |
| 18 | NES（预测下一处编辑位置） | ❌ | Zed Zeta（开源可复刻）、Continue Next Edit、Copilot NES | **XL** | **P2（不建议现在做）** |
| 19 | 仓库级 RAG 检索 | ❌ | Tabby（tree-sitter + BM25）；Continue @Codebase | **L** | **P2（不建议）** |

### 4.3 值得做 vs 不值得做

**✅ 值得做（性价比排序）**

1. **取消 + 缓存**（#1/#2）：纯工程，零产品风险，直接省 token 并把「退格重看」变成 0 延迟。
2. **部分接受**（#3/#4）：代码 80% 已存在（`acceptWord`），接个键 + 补按行切分即可，**用户感知极强**。
3. **kernel 变量**（#7）：数据链路已经在（`/nb2/vars` + `ai.js` 格式化），**补全质量提升最直接**——notebook 里「df 有哪些列」正是模型最容易瞎猜的地方。
4. **触发放宽 + 轻量过滤器**（#5/#6）：把「只行尾」这个硬门槛拆掉，同时用打分避免请求爆炸。
5. **失败可见 + 设置项**（#9/#13/#14）：让用户能自己调（延迟/行数/开关），比我们拍常量更省事。
6. **多行渲染加固**（#10/#11）：现在多行建议在 CM 里没有行高预留，长建议会把下方内容推走。

**❌ 不值得做 / 有大坑（明确不建议）**

| 不建议 | 理由 |
|---|---|
| **自训 NES 模型** | Copilot 明确说过「PR diff 训不出来，比普通 LLM 还差」，Zed 靠**自建推理 + 投机解码**才做到 p50<200ms。我们是本地 HTTP + 通用 chat 模型，延迟 1–3s，NES 在 1s+ 的场景下**纯负收益**（打断感 > 帮助）。 |
| **用 FIM 特殊 token** | 我们的模型**没被 FIM 训练过**。硬拼 `<fim_prefix>` 只会退化（Continue 只对 FIM 模型用这套；对 GPT/Claude 它切到 hole-filler 模板）。要么走「填空式自然语言提示」，要么换 FIM 模型。 |
| **仓库级 RAG（tree-sitter + BM25）** | Tabby 那套需要索引服务 + 增量重建 + 语言解析；notebook 场景收益远低于 IDE，而我们已有「主对话引用 cell」的显式通道。**P2 且优先级应低于前 14 项**。 |
| **逐 token 流式 ghost** | 要改 `llm.stream` → SSE → CM widget 三处，收益是「早 300ms 看到半句」，但半句代码可能误导且要处理「流中断」。JupyterLab 做了，但它有现成的 provider 抽象。 |
| **多候选默认返回 N 条** | token ×N、延迟 ×N（通常串行）。只在「用户显式 `Alt-\`」时请求多条才划算（JupyterLab 就是这个语义）。 |
| **接受后自动格式化** | 会把用户手写风格改掉（我们已有「保持用户风格」的提示词约束）；且 notebook 里 format 需要额外依赖。 |

### 4.4 分批落地顺序（每批 3–5 项，可独立验收）

**批次 1 —— 成本与手感（约 1 天，4 项，全 S）**
- #1 在途取消、#2 前缀缓存、#3 按词接受接线、#9 失败可见
- **验收**：① 连打 5 个字符，Network 面板只有最后 1 个请求未 abort；② 退格后 0 网络请求即恢复 ghost；③ `Ctrl-→` 吃一词、剩余仍在；④ 断网时格上出现「补全失败」而非静默。

**批次 2 —— 质量（约 2 天，4 项）**
- #7 kernel 变量、#8 跨格上下文增强、#5 行中触发、#14 stop/max_tokens
- **验收**：① 提示词里出现 `Live kernel variables` 段（可用 `/nb2/ai/complete` 响应里回显 debug 字段验证）；② markdown 格里的「意图注释」进入上下文；③ 光标在 `df.` 之后（右侧为空）能出建议；④ 服务端日志里 `stop` 生效、单次输出 ≤ N 行。

**批次 3 —— 可调与稳定（约 2 天，4 项）**
- #13 设置项（延迟/最大行数/按语言）、#10 多行加固、#11 增量收缩、#6 过滤器 v1（5 特征打分）
- **验收**：① 设置面板三项可改且立刻生效（无需刷新）；② 10 行建议不把下方内容推走，超出部分折叠；③ 逐字输入时幽灵后退而非闪没；④ 「刚按 Esc 拒绝」后 2 秒内不再发请求。

**批次 4 —— 呈现增强（约 3–5 天，2–3 项，可选）**
- #16 多候选（仅 `Alt-\` 时）、#12 ghost 语法高亮、#17 diff 预览（先用「整段 range 替换 + 删除线」近似）
- **验收**：① `Alt-\` 出 2–3 条可轮换；② ghost 有颜色；③ 编辑型建议以 diff 形式呈现且接受后是单条 undo。

**明确排除**：#18 NES、#19 RAG（除非将来接入专门的 NES 小模型 + 本地推理）。

---

## 5. 不确定性清单（哪些是推测 / 哪些没验证）

**闭源推测类**
1. **Copilot 内部实现**：全部来自 2022 年的**反编译**（[copilot-explorer](https://thakkarparth007.github.io/copilot-explorer/posts/copilot-internals.html)，版本 1.57）+ 官方营销博客。contextual filter 的 11 特征权重、suffix 缓存、模型名（"cushman-ml"）都是**当时版本**的行为，**当前版本一定变了**。文中「~6000 字符上下文」也是 2023 口径（官方后来称扩到 8k token）。
2. **NES 的模型与输出格式**：官方只说「diff-based format」「3-in-1 模型」「eagerness 控制标签 `<|aggression|>`」。**该标签是训练用控制符，不是公开 API**，我不能确认线上请求是否也带它。
3. **Cursor Tab / Windsurf Supercomplete**：均闭源，只有产品文档与第三方描述。Cursor 的「按词接受 `Ctrl-→`」来自**帮助中心 + 社区帖**，不是 API 文档。**Codeium Supercomplete 我未找到一手实现文档**（仅二手教程站），本报告未对其技术细节下结论。
4. **Supermaven**：300k 上下文 / 250ms 延迟均为**厂商自测**（且是对比竞品的营销数据），无第三方复现。

**我没验证到 / 需要实测的**
5. **`jupyter-ai` 是否有 inline completion**：我在其默认分支**未搜到** `IInlineCompletionProvider`，且主仓库已瘦身为壳（只剩 `jupyter_ai/__init__.py` + `submodules`），真实代码在 submodule 里**未深入**。JupyterLab 官方文档说 inline provider 由扩展贡献（例：jupyterlite-ai / jupyter-ai-lite）。**结论保守表述**：jupyter-ai 当前定位是 chat/ACP 代理；inline completion 在 JupyterLab 生态里是 `@jupyterlab/completer` 的 provider 扩展点，不代表 jupyter-ai 提供。
6. **`%ai`/`%%ai` magics**：属 jupyter-ai 2.x 时代能力，**本次未在 main 分支验证** `jupyter_ai_magics` 是否仍在（仓库结构已变）。
7. **我们多行 ghost 的真实渲染**：`client.js:271-288` 是单个 inline `Decoration.widget` + `whiteSpace: "pre"`。**推测**多行文本会挤在光标位置、不产生真正的行盒（下方内容不被推开）——但**我本次没在真机跑过**，需实测确认，再决定 #10 的做法（可能要改用 block widget 或 `Decoration.line` + 占位）。
8. **表 1a 里「Copilot 注释行触发」**：无公开规则，标 ⚠️ 是保守写法，不代表它没有。
9. **链接时效性**：源码链接均指向 `main`/`gh-pages` 分支的当前内容，随上游变动可能失效；Continue/JupyterLab 的行号未来会漂，引用时建议以文件名 + 符号名定位。
10. **Continue 的 `modelTimeout` 默认值**：文档示例里写的是 `modelTimeout: 150`，但**单位与默认值语义我未在源码中逐一核对**（150ms 对一次 LLM 请求偏小，可能单位是 ms 但仅指"首 token 等待"）——引用时请以「示例配置值」而非「默认值」理解。

**方法论上的局限**
11. 本次是**只读调研 + 源码/文档交叉核对**，**没有安装或运行** Continue / Tabby / JupyterLab 做行为实测；所有「行为表现」来自文档或源码推导。
12. 表 2 的 CM6 建议基于 JupyterLab `ghost.ts` 的读解，**未在我们仓库的 CM vendor 版本上验证 API 可用性**（`Decoration.widget`/`mapPos`/`EditorView.decorations.from` 均为 CM6 稳定 API，风险低，但仍需一次冒烟）。

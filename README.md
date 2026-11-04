# dsh-notebook-v2

**中文** · [English](README.en.md)

给 **DeepSeek Harness** 用的自研 Jupyter 前端插件：右栏里一个真正的 notebook ——
常驻内核、**流式输出**、多标签、`.ipynb` 语义等价读写、**内联 AI 改写与补全**、VS Code 手感。

`MIT` · `Node ≥ 20` · `DSH Desktop 0.2.1-rc.x`

## 安装

```bash
git clone https://github.com/LearnItHard/dsh-notebook-v2.git
cd dsh-notebook-v2
node scripts/install.mjs
```

重启 DeepSeek Harness（或重载窗口）→ 右栏「+」里出现 **Notebook (v2)**。

- 装进别的 profile：`node scripts/install.mjs --profile <profile目录>`
  默认 `~/.dsh/profiles/desktop`（Windows：`%USERPROFILE%\.dsh\profiles\desktop`）
- 先看它会改什么：加 `--dry-run`；不想要了：`node scripts/uninstall.mjs`
- 脚本幂等，写前自动备份 profile 的 `package.json`
- 内核需要 `ipykernel`；没装 Python 也能用 Shell 格（`bash` / `pwsh` 子进程）

## 能做什么

**工具栏**

| 行 | 内容 |
|---|---|
| 1 | 同步状态点 · notebook 标题 · `未保存 ●` · 保存 · 另存为 |
| 2 | ▶ 运行全部 · ■ 中断 · ↻ 重启 · ↻ 重启并清空 · 清空输出 · ＋ 代码 · ＋ MD · ＋ SH · ✕ 删除 · ≡ 大纲 · AI 补全 |
| 3 | `内核 idle` 状态点 · **内核下拉（conda 环境，缺 `ipykernel` 的禁选）** · 📁 工作目录（点击修改） |
| 标签条 | 多 notebook 标签 · ＋打开（内联路径输入） · ＋新建 |

**单元格类型**：`代码` / `Markdown` / `Shell` / `Raw`（每格左侧下拉切换）。
Markdown 默认渲染、点一下进编辑；Shell 走**独立子进程**（`cmd` / `bash` / `pwsh` 自动选，不需要 Python 内核）。
`.ipynb` 里 Shell 格就是标准 Jupyter 写法「带 `%%bash` 魔法行的 code 格」，在 JupyterLab / VS Code 里仍合法。

**输出**：`print` 一行一行往外冒（`print` 一万行只产生**一个**输出块）；
`text/html`（沙箱 iframe + 高度回传）、图片、`application/json` 折叠树、`text/latex`（KaTeX）、
markdown（表格/公式/代码块/引用）；超长输出「头 300 + 尾 100 + 展开」。

**大纲（TOC）**：`≡ 大纲` 展开，列 markdown 标题（按级别缩进，代码块里的 `#` 不算标题）+ 每格首行，点击跳转。
大纲栏**宽度可拖**：拖内侧边缘实时变宽变窄，松手记住；双击分隔条复位 200px，聚焦后 `←/→` 微调。

**md 标题折叠**（对齐 VS Code Notebook）：markdown 格里**首个非空行是标题**（`#`…`######`，或 setext 的 `===`/`---`）
的格，左侧出现 `▾`。折起来后，它下面直到**下一个同级或更高级标题**之前的格全部隐藏，
原地留一条 `⋯ 已折叠 N 格 · 点击展开`。标题格自己永远可见；嵌套按层级算；大纲跳转到被折叠的格会自动展开。

**AI 自动补全**：`AI 补全` 开关（**默认关**，会消耗 token）。停止输入 ~0.5s 后光标处出现灰色续写建议
→ `Tab` 接受 / `Esc` 丢弃，一打字即作废。超时或失败静默不打扰。

**AI 内联改写（`Mod-K`）**：指令 → 逐 token 流式 → **行级 diff** 评审（`+N −M`）→
接受（`Mod-↵`）/ 接受并运行 / 重试 / 拒绝（`Esc`）。后端走宿主 `ctx.llm.stream()`，
provider/model 来自 `config.ai`，留空自动解析。

**内核**：常驻、变量跨格保留；Interrupt / Restart / RestartAndClear / RestartAndRunAll 四语义；
内核下拉换 conda 环境、工作目录可改（都会重启内核）。

**多 notebook**：同会话多标签，切换即切活动 notebook；重复打开同一路径只激活不重载。

**无损读写**：读入 → 写回**语义等价**（`attachments`、`metadata.widgets`、历史插件写入的 `metadata.dsh`、
以及不认识的字段全部原样保留）。

**不做**（v1 非目标）：ipywidgets 交互、调试器、远程 / SLURM 内核、多人协作、Monaco 级类型检查。

## 快捷键

编辑态（CodeMirror 6，支持查找/折叠/多光标/括号匹配/补全/撤销历史）：

`Shift-Enter` 运行并下移 · `Ctrl(-Alt)-Enter` 运行 · `Alt-Enter` 运行并插格 ·
`Mod-F` 查找 · `Mod-S` 保存 · `Mod-K` 内联 AI · `Tab` 接受补全

容器态（选中整格、不进编辑）：

`Enter` 进格 · `↑↓` 选格 · `Delete` 删格 · `Esc` 退出编辑

## 内核与解释器

工具栏「内核」下拉里选的是**会话级**的，切换会重启内核。没手动选时按这个顺序自动挑：

1. `config.python`（`cordis.patch.yml` 里填了就用它）
2. Python 环境选择插件（`python-env`）在本会话 / 父会话里选过的解释器
3. 扫本机 conda 环境，挑第一个**真装了 `ipykernel`** 的
4. 最后才回落到 `PATH` 上的 `python`

**内核下拉里没有你的环境**，或报 `No module named 'ipykernel'`：在那个环境里 `pip install ipykernel`，
再回到工具栏下拉里选它。**没有 Python 也能用** —— Shell 格走独立子进程，不需要内核。

诊断：`curl http://127.0.0.1:<port>/nb2/diagnostics` 会列出候选内核、是否装了 `ipykernel`、最终选中谁。

## 与 `@beihaizb/dsh-notebook` 同时启用会冲突

`@beihaizb/dsh-notebook` 是**第三方**插件（不是本项目的代码，本项目也不依赖它）。两者的 `nb_*` **工具名完全相同**，
同时启用会重复注册同名工具 —— **只启用其中一个**。本仓库的脚本只会改 profile 的加载列表，不会碰那个插件的文件和数据。

```bash
node scripts/retire-old-plugin.mjs              # 把那个插件从加载列表里去掉
node scripts/retire-old-plugin.mjs --rollback   # 再装回加载列表
```

两个插件可以并存安装（文件都在），只是不能同时启用；`.ipynb` 数据与 `node_modules` 里的内容都不受影响。

## 文档

- 端点契约：[`docs/api-nb2.md`](docs/api-nb2.md) · sidecar 协议：[`docs/protocol-ndjson.md`](docs/protocol-ndjson.md)
- 计划：[需求统一整理与实施计划](docs/plans/2026-11-04-需求统一整理与实施计划.md) · [体验修复 v6](docs/plans/2026-11-04-体验修复v6-计划.md)
- 评审：[Phase 1–3 评审要点](docs/phase1-3-review-brief.md)
- 专题调研：[对话引用 API](docs/research/2026-11-04-chat-reference-api.md) · [AI 补全](docs/research/2026-11-04-ai-completion-survey.md) · [Jupyter 快捷键](docs/research/2026-11-04-jupyter-shortcuts.md)
- 开发 / 排障笔记：[`AGENTS.md`](AGENTS.md)（文件结构、测试套件、实现约定、内核对齐——给改这个项目的人/AI 看）

## 开发

```bash
node test/all.mjs          # 全部套件（含真 ipykernel 端到端）
node test/all.mjs --fast   # 跳过真内核
```

`lib/cm-vendor.js`（CodeMirror 6 + KaTeX 的打包产物）已提交，**使用者无需构建**。
改依赖或升级 CM6 时才需要重新跑 `node scripts/build-cm-vendor.mjs`。

## License

[MIT](LICENSE)

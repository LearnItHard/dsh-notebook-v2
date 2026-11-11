# 更新记录

版本号在 `package.json`；`/nb2/health` 的 `version` 直接读它（不再硬编码）。

## 0.2.1 · 2026-11-11

### 新增

- **`notebook-edit` skill**：把「改这一格」的操作流程（`nb_open` → `nb_get` → `nb_edit_cell`、
  只动一格、报错用 `nb_error_context`）从每条对话消息里搬进 skill。面板投递现在只发
  `@文件 (Cell[n])` + `/notebook-edit <要求>` + 选区 + 一行报错，输入框不再被撑成一堵墙。
  源在 `skills/notebook-edit/SKILL.md`，`node scripts/install-skill.mjs` 同步到 `~/.dsh/skills/`。
- **`/nb2/spill`**：大块输出落盘后可以读回渲染（图片直接显示，其它给「打开」链接），
  不再只显示一行「大块输出已折叠」。只允许读 spill 目录内的文件（越界 403）。
- **`/nb2/kernels` 返回 `resolved`**：没显式选内核时，下拉显示「默认：<环境名>」，
  状态条写「内核未启动 · 默认 xxx」；连默认都没有才显示红色「⚠ 选内核」。

### 修复

- **matplotlib / PIL 的图不显示，只看到「大块输出已折叠 …/nb2-xxxx.bin」**：图片的内联阈值
  从 256KB（所有 mime 共用）提到 6MB 单独判断；真超限落盘后前端用 `/nb2/spill` 读回，
  不再退化成一行文字。落盘目录从随机 `mkstemp` 改成固定的 `%TEMP%\dsh-nb2-spill`，
  文件名带扩展名，启动时清理 24h 前的文件。
- **落盘块显示 `0KB`**：`bytes` 在宿主转发 `display` 事件时被漏掉，现在一并转发。
- **打开 notebook 停在中间的某个格子**：滚动锚点跨 notebook 复用上一本的 `scrollTop`，
  且初始 `pinned: true` 会滚到底。现在按 notebook 路径记 `{top, cellId}`，有记录回到上次位置，
  没记录回第一格顶部。
- **没选内核时不知道能不能跑**：见上面的 `resolved`。

## 0.2.0 · 2026-11-10

### 输出可视化

- pandas DataFrame 表格换成 JupyterLab 的观感：去掉 `<table border="1">` 的粗黑网格，
  表头只留一条下横线，`tbody tr` 斑马纹 + hover，数值右对齐，等宽数字
  （`font-variant-numeric: tabular-nums`）。
- 沙箱 iframe 里的正文色改成**算好的具体色值**（iframe 是独立文档，继承不到宿主 CSS），
  派生色走 `color-mix(in srgb, currentColor …)`：深色主题下不再是黑字压深底。
- stream / traceback 里的 ANSI 转义序列（16 色 / 256 色 / truecolor、粗体、下划线）
  解析成彩色 span，不再原样显示成 `[31m` 这种残渣；折叠前先剥离，避免切在序列中间。
- 报错块配色走主题（原来写死 `#ff9a9a`，浅色主题下几乎读不出来），traceback 默认折成首尾。
- 纯文本输出改 `pre-wrap`：面板只有半屏宽，长行不再顶出横向滚动条。
- MIME 优先级表只保留**有渲染分支**的 mime：plotly / ipywidgets 的输出不再退化成一大坨 JSON。

### 修复

- **同一个 cell 重跑会累加输出**：`cell.started` 现在清空上一轮输出（宿主 `notebook._onStarted`
  与客户端 `reduceEvent` 两处），修「跑三次出现三份重复结果」。
- 内核崩溃 / 启动超时后，那一格收敛成错误并释放队列闸门，不再永久卡在 `running`。
- 强制 UTF-8 stdio：Windows 下含中文的代码不再炸 `SyntaxError: invalid character`，内核也不会被编码错误打死。

### 新增

- AI 补全：分级接受（按词 / 按行）、最长前缀缓存、设置项改完立即生效。
- 需要项目上下文的改写走「交给对话」，由带完整工作区的 Agent 动手（内联 AI 只看得到本格与邻格）。
- `/nb2/health` 的版本号改为从 `package.json` 读取。

## 0.0.1 · 2026-11-04

- 首个版本：右栏 notebook 面板，常驻内核、流式输出、多标签、markdown / 代码 / Shell 单元格、
  `.ipynb` 语义等价读写、大纲栏。

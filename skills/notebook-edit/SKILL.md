---
name: notebook-edit
description: 在 DSH 右栏的 notebook 面板里改 / 修 / 解释**某一格**。消息里带 `@xxx.ipynb (Cell[n])` 定位行（可能还有 `/notebook-edit` 和一段选区）时用；走 nb_* 工具，不猜文件内容。
whenToUse: 用户从 notebook 面板投递「改这一格 / 修这个报错 / 解释这格」，消息以 `@<path> (Cell[n])` 或 `/notebook-edit` 开头；用户说「改 notebook 里的第 n 格」「把这一格改成…」「这格为什么报错」。
---

# 改 notebook 的一格（nb_* 工具链）

> 这是 dsh-notebook-v2 面板的配套 skill。面板投递的消息刻意很短，只给定位 + 要求；
> 上下文一律由 agent 用工具自己拿，所以**不要**要求用户再贴代码。

## 0. 先解析定位行

投递正文第一行固定是：

```
@<工作区相对路径或绝对路径> (Cell[3] L4-L8)
```

- `Cell[n]` 是**显示序号（1-based）**，不是内部 cellId。
- `L4-L8` 是格内 1-based 行号，只有带选区时才有。
- `@` 后面是 notebook 路径；相对路径相对工作区。

## 1. 按顺序做

1. `nb_open({ path })` 打开这个 notebook（已经是活动标签时等价于激活）。
2. `nb_get`（或 `nb_context`）拿 cells：每格有 `cellId` 与 `source`，**第 n 个格子**就是要改的那格。
3. 有选区（`Lx-Ly`）→ 只改那几行；没有 → 改整格。
4. `nb_edit_cell({ cellId, source })` 写回。要立刻验证就跑 `nb_edit_and_run_cell`。
5. 一句话说改了什么。不要把整段代码贴回对话。

## 2. 硬约束

- **只动指定那一格**。其它格原样保留，不要重排、不要格式化整本。
- 源码以 `nb_get` 读到的为准，不要凭消息里的片段猜。
- 报错排查用 `nb_error_context` 拿完整 traceback（消息里只有一行 `ename: evalue`）。
- 变量 / 列名用 `nb_list_vars` / `nb_inspect_object`，不要反问用户。
- 不要 `nb_save`，除非用户明确说要存盘（面板里保存是用户的事）。
- 面板的 AI 补全 / 内联改写只看到本格 + 邻格；需要项目上下文时就应该走「交给对话」，这也是本 skill 存在的原因。

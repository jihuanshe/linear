---
name: automation
title: Unattended execution and write verification
description: 无人值守执行的输出契约、JSON 校验、Markdown 文件 flag 与写后读回验证
keywords:
  - json
  - automation
  - no-pager
  - exit-code
  - pagination
  - verification
  - 自动化
  - 校验
  - 分页
  - 验证
commands:
  - issue view
  - issue query
  - issue create
  - issue update
  - issue comment add
  - issue comment list
  - document view
seeAlso:
  - core
  - graphql
---

# 无人值守执行与写入验证

输出要被程序消费，或写入结果需要核验时，读本指南。

## 输出契约

- `--json` 和 `--no-pager` 不是全局选项，按目标子命令的 `--help` 确认。
- 消费输出前：设 `NO_COLOR=1`，stdout 与 stderr 分开重定向，检查退出码，用 `jq -e` 验证后再使用：

```bash
NO_COLOR=1 linear issue view ENG-123 --json >result.json 2>error.log &&
  jq -e . result.json >/dev/null
```

- 绝不用 `2>&1` 合并流再喂给 JSON 解析器。
- 首选防线是 `--json`；`NO_COLOR=1` 只兜底，部分帮助、版本、错误和 Markdown 渲染路径仍可能输出 ANSI 序列。人类可读输出不是稳定协议。没有 `--json` 这类结构化输出且必须解析时，显式剥离 ANSI 并只解析文档化的值，不解析终端布局。
- 读取 document 正文用 `document view --raw` 绕过终端 Markdown 渲染；需要元数据加内容的结构化信封时用 `--json`。
- 交互提示在无人值守环境用 `LINEAR_PROMPT_DISABLED=1` 禁用；提示被禁用后缺输入的命令会失败而不是挂起。禁用提示不代表获得写入授权。
- 后续命令显式传 Issue 标识。`issue view` 等命令省略参数时会从当前 Git branch 推断目标，无人值守脚本在仓库 checkout 里可能因此打到错误的 Issue。

## 分页形状

`issue query --json` 返回连接对象，不是裸数组。节点在 `.nodes`，分页信息在 `.pageInfo`。`--limit` 超过单页大小或传 `0`（不设上限）时，CLI 自动翻页并拼接各页的 `nodes`，保留连接形状，不扁平化、不重命名字段：

```bash
jq -e '.nodes | arrays' project-issues.json >/dev/null &&
  jq '.nodes[] | {identifier, title, priority}' project-issues.json
```

`issue comment list --json` 同样返回 connection envelope `{nodes,pageInfo}`，而不是评论数组。例如：

```bash
linear issue comment list ENG-123 --json >comments.json &&
  jq -e '.nodes | arrays' comments.json >/dev/null &&
  jq '{comments: [.nodes[] | {id, body}], pageInfo}' comments.json
```

## Markdown 走文件 flag

多行 Markdown 一律用文件 flag：`issue create` / `issue update` 用 `--description-file`，`comment add` / `comment update` 用 `--body-file`。这避免 shell 转义破坏换行、防止字面 `\n` 进入正文。内联 flag（`--description`、`--body`）只用于单行内容。

```bash
cat > "$TMPDIR/description.md" <<'EOF'
## Summary

多行 Markdown 内容。
EOF
linear issue create --title "My Issue" --description-file "$TMPDIR/description.md"
```

## 写后读回

写入不以命令退出码为终点。用结构化读取核对本次修改的字段：

- 专用写命令无 `--json` 时，通过暴露相关字段的 `view` / `list` 读回；都不覆盖时用只读 `linear api` 查询验证。
- 只有人类输出可用时，核对文档化的值并明确说明「结果未经结构化验证」。
- 批量修改前后，把同一完整查询的 JSON 分别保存为快照：先比较排序后的 `.nodes[].identifier` 集合（不能只比数量），再按 identifier 比较本次涉及的目标字段。对新出现的 identifier 单独读取全文，不把旧快照的判断直接套用。

## 时序现实

AI 准备材料需要时间，期间上游对象可能已被他人修改。多步写入前重读目标当前值；发现与预期基线不符时停下报告差异，不盲目覆盖。

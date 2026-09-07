import { assertEquals, assertStringIncludes } from "@std/assert"
import { fromFileUrl } from "@std/path"
import { assertSnapshot } from "@std/testing/snapshot"
import { cli } from "../../../src/cli.ts"
import { guideSources } from "../../../src/guides/content.ts"
import { listGuides } from "../../../src/guides/guides.ts"

const main = fromFileUrl(new URL("../../../src/main.ts", import.meta.url))
const guidesDir = fromFileUrl(new URL("../../../docs/guides", import.meta.url))
const { denoDir } = JSON.parse(new TextDecoder().decode(
  (await new Deno.Command(Deno.execPath(), {
    args: ["info", "--json"],
    stdout: "piped",
  }).output()).stdout,
)) as { denoDir: string }

async function run(args: string[]) {
  const root = await Deno.makeTempDir()
  try {
    const result = await new Deno.Command(Deno.execPath(), {
      args: ["run", "--allow-all", "--quiet", main, ...args],
      stdout: "piped",
      stderr: "piped",
      clearEnv: true,
      env: {
        HOME: root,
        XDG_CONFIG_HOME: root,
        DENO_DIR: denoDir,
        NO_COLOR: "1",
      },
    }).output()
    const decoder = new TextDecoder()
    return {
      code: result.code,
      stdout: decoder.decode(result.stdout),
      stderr: decoder.decode(result.stderr),
    }
  } finally {
    await Deno.remove(root, { recursive: true })
  }
}

Deno.test("guide prints the concise index", async (t) => {
  const result = await run(["guide"])

  assertEquals(result.code, 0, result.stderr)
  assertEquals(result.stderr, "")
  await assertSnapshot(t, result.stdout)
})

Deno.test("guide --json preserves stable metadata", async () => {
  const result = await run(["guide", "--json"])

  assertEquals(result.code, 0, result.stderr)
  const documents = JSON.parse(result.stdout)
  assertEquals(
    documents.map((entry: { name: string }) => entry.name),
    [
      "core",
      "automation",
      "issue-authoring",
      "issue-delivery",
      "graphql",
      "doctor",
      "markdown",
    ],
  )
  for (const entry of documents) {
    assertEquals(Object.keys(entry).sort(), ["commands", "description", "name"])
    assertEquals(typeof entry.description, "string")
    assertEquals(Array.isArray(entry.commands), true)
  }
})

Deno.test("guide name prints only the Markdown body", async () => {
  const result = await run(["guide", "core"])

  assertEquals(result.code, 0, result.stderr)
  assertEquals(result.stderr, "")
  assertEquals(result.stdout.startsWith("# 命令发现与选择"), true)
  assertEquals(result.stdout.includes("\n---\n"), false)
})

Deno.test("guide fails with guidance for an unknown name", async () => {
  const result = await run(["guide", "no-such-guide"])

  assertEquals(result.code === 0, false)
  assertEquals(result.stdout, "")
  assertStringIncludes(result.stderr, "✗")
  assertStringIncludes(result.stderr, "no-such-guide")
  assertStringIncludes(
    result.stderr,
    "core, automation, issue-authoring, issue-delivery, graphql",
  )
})

Deno.test("guide --json returns a named guide body and metadata", async () => {
  const result = await run(["guide", "core", "--json"])

  assertEquals(result.code, 0, result.stderr)
  assertEquals(result.stderr, "")
  const document = JSON.parse(result.stdout)
  assertEquals(document.name, "core")
  assertEquals(typeof document.description, "string")
  assertEquals(Array.isArray(document.commands), true)
  assertEquals(document.body.startsWith("# 命令发现与选择"), true)
})

Deno.test("removed plural and nested guide commands are unavailable", async () => {
  for (const args of [["guides"], ["guide", "list"], ["guide", "read"]]) {
    const result = await run(args)
    assertEquals(result.code === 0, false, args.join(" "))
  }
})

Deno.test("the import manifest embeds every source guide exactly once", async () => {
  const files = new Set<string>()
  for await (const entry of Deno.readDir(guidesDir)) {
    if (entry.isFile && entry.name.endsWith(".md")) {
      files.add(entry.name.replace(/\.md$/, ""))
    }
  }
  assertEquals(new Set(Object.keys(guideSources)), files)
})

function commandExists(path: string): boolean {
  let current = cli as unknown as {
    getCommand(name: string): unknown
  }
  for (const segment of path.split(" ")) {
    const next = current.getCommand(segment)
    if (next == null) return false
    current = next as typeof current
  }
  return true
}

Deno.test("guide metadata references only canonical commands", () => {
  const names = new Set(listGuides().map((guide) => guide.metadata.name))
  assertEquals(names.size, listGuides().length)
  for (const guide of listGuides()) {
    for (const command of guide.metadata.commands) {
      assertEquals(
        commandExists(command),
        true,
        `${guide.metadata.name} references unknown command: ${command}`,
      )
    }
  }
})

Deno.test("domain usage lists related guides without embedding bodies", async () => {
  const result = await run(["issue", "usage"])

  assertEquals(result.code, 0, result.stderr)
  assertStringIncludes(result.stdout, "related guides:")
  assertStringIncludes(result.stdout, "issue-authoring")
  assertStringIncludes(result.stdout, "guides: linear guide <name>")
  assertEquals(/^# /m.test(result.stdout), false)
})

Deno.test("leaf help shows a Related guides breadcrumb", async () => {
  const update = await run(["issue", "update", "--help"])
  assertEquals(update.code, 0, update.stderr)
  assertStringIncludes(
    update.stdout,
    "Related guides: core, automation, issue-authoring",
  )

  const api = await run(["api", "--help"])
  assertEquals(api.code, 0, api.stderr)
  assertStringIncludes(api.stdout, "Related guides: automation, graphql")
})

Deno.test("usage JSON exposes guide metadata additively", async () => {
  const result = await run(["issue", "usage", "--json"])

  assertEquals(result.code, 0, result.stderr)
  const document = JSON.parse(result.stdout)
  const domainGuides = document.command.guides.map(
    (guide: { name: string }) => guide.name,
  )
  assertEquals(domainGuides.includes("issue-authoring"), true)

  const update = document.subcommands.find(
    (command: { name: string }) => command.name === "update",
  )
  assertEquals(
    update.guides.map((guide: { name: string }) => guide.name),
    ["core", "automation", "issue-authoring", "markdown"],
  )
  for (const field of ["name", "path", "writes", "outputModes"]) {
    assertEquals(field in update, true, `${field} missing from usage JSON`)
  }
})

Deno.test("guide commands never write and stay network-free", () => {
  const guide = cli.getCommand("guide")
  if (guide == null) throw new Error("guide command not registered")
  const meta = guide.getMeta()
  assertEquals(meta["Writes"], undefined)
  assertEquals(guide.getCommands(), [])
})

Deno.test("Markdown authoring help gives an actionable route without a skill", async () => {
  for (
    const path of [
      "issue create",
      "issue update",
      "issue comment add",
      "issue comment update",
      "document create",
      "document update",
    ]
  ) {
    const result = await run([...path.split(" "), "--help"])
    assertEquals(result.code, 0, result.stderr)
    assertEquals(result.stderr, "")
    assertStringIncludes(result.stdout, "For API Markdown bodies")
    assertStringIncludes(result.stdout, "bare Linear URL")
    assertStringIncludes(
      result.stdout,
      "Named profile links can also mention people",
    )
    assertStringIncludes(result.stdout, "handling varies by body")
    assertStringIncludes(result.stdout, "linear team members <TEAM> --json")
    assertStringIncludes(result.stdout, "linear guide markdown")
  }
  const reference = await run(["guide", "markdown", "--json"])
  assertEquals(reference.code, 0, reference.stderr)
  assertEquals(reference.stderr, "")
  const guide = JSON.parse(reference.stdout)
  assertStringIncludes(guide.body, "+++ [服务器日志]")
  assertStringIncludes(guide.body, "\n+++\n")
  assertStringIncludes(guide.body, "不根据名字、邮箱或 UUID 拼接")
  assertStringIncludes(guide.body, "因正文类型及创建／更新路径而异")
  assertStringIncludes(
    guide.body,
    "在 Issue 创建、Comment 新增及更新时生成提及",
  )
  assertStringIncludes(guide.body, "在 Issue 更新、Document 创建及更新时为文本")
  assertStringIncludes(guide.body, "导出的 Markdown 不是富文本的无损备份")
  assertEquals(guide.commands.includes("issue apply"), true)
  const delivery = await run(["guide", "issue-delivery", "--json"])
  assertEquals(delivery.code, 0, delivery.stderr)
  assertStringIncludes(JSON.parse(delivery.stdout).body, "不证明富文本节点等价")
})

import { assertEquals, assertStringIncludes } from "@std/assert"
import { fromFileUrl } from "@std/path"
import { assertSnapshot } from "@std/testing/snapshot"
import { cli } from "../../../src/cli.ts"
import { guideSources } from "../../../src/guides/content.ts"
import { listGuides } from "../../../src/guides/guides.ts"

const main = fromFileUrl(new URL("../../../src/main.ts", import.meta.url))
const guidesDir = fromFileUrl(new URL("../../../docs/guides", import.meta.url))

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

Deno.test("guide rejects name with --json", async () => {
  const result = await run(["guide", "core", "--json"])

  assertEquals(result.code === 0, false)
  assertEquals(result.stdout, "")
  assertStringIncludes(result.stderr, "✗")
  assertStringIncludes(result.stderr, "cannot be used with --json")
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
  assertEquals(result.stdout.includes("# "), false)
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
    ["core", "automation", "issue-authoring"],
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

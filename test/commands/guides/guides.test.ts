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

Deno.test("guides list prints the concise index", async (t) => {
  const result = await run(["guides", "list"])

  assertEquals(result.code, 0, result.stderr)
  assertEquals(result.stderr, "")
  await assertSnapshot(t, result.stdout)
})

Deno.test("zero-argument guides shows the same index", async () => {
  const list = await run(["guides", "list"])
  const bare = await run(["guides"])

  assertEquals(bare.code, 0, bare.stderr)
  assertEquals(bare.stdout, list.stdout)
})

Deno.test("guides list --json preserves stable metadata", async () => {
  const result = await run(["guides", "list", "--json"])

  assertEquals(result.code, 0, result.stderr)
  const documents = JSON.parse(result.stdout)
  assertEquals(
    documents.map((entry: { name: string }) => entry.name),
    ["core", "automation", "issue-authoring", "graphql"],
  )
  for (const entry of documents) {
    assertEquals(typeof entry.title, "string")
    assertEquals(typeof entry.description, "string")
    assertEquals(Array.isArray(entry.keywords), true)
    assertEquals(Array.isArray(entry.commands), true)
    assertEquals(Array.isArray(entry.seeAlso), true)
  }
})

Deno.test("guides read prints only the Markdown body", async () => {
  const result = await run(["guides", "read", "core"])

  assertEquals(result.code, 0, result.stderr)
  assertEquals(result.stderr, "")
  assertEquals(result.stdout.startsWith("# 命令发现与选择"), true)
  assertEquals(result.stdout.includes("\n---\n"), false)
})

Deno.test("guides read fails with guidance for an unknown name", async () => {
  const result = await run(["guides", "read", "no-such-guide"])

  assertEquals(result.code === 0, false)
  assertEquals(result.stdout, "")
  assertStringIncludes(result.stderr, "✗")
  assertStringIncludes(result.stderr, "no-such-guide")
  assertStringIncludes(
    result.stderr,
    "core, automation, issue-authoring, graphql",
  )
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

Deno.test("guide metadata references only canonical commands and real guides", () => {
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
    for (const reference of guide.metadata.seeAlso) {
      assertEquals(
        names.has(reference),
        true,
        `${guide.metadata.name} seeAlso references unknown guide: ${reference}`,
      )
    }
  }
})

Deno.test("guide commands never write and stay network-free", () => {
  const guides = cli.getCommand("guides")
  if (guides == null) throw new Error("guides command not registered")
  const meta = guides.getMeta()
  assertEquals(meta["Writes"], undefined)
  for (const child of guides.getCommands()) {
    assertEquals(child.getMeta()["Writes"], undefined)
  }
})

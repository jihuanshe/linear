import { assertEquals, assertRejects } from "@std/assert"
import { join } from "@std/path"
import { loadManifest } from "../../src/delivery/manifest.ts"
import { ValidationError } from "../../src/utils/errors.ts"

async function withManifest(
  manifest: unknown,
  run: (manifestPath: string, dir: string) => Promise<void>,
): Promise<void> {
  const dir = await Deno.makeTempDir()
  try {
    const manifestPath = join(dir, "delivery.json")
    await Deno.writeTextFile(manifestPath, JSON.stringify(manifest))
    await run(manifestPath, dir)
  } finally {
    await Deno.remove(dir, { recursive: true })
  }
}

Deno.test("manifest validation fails before any mutation could run", async (t) => {
  const invalidCases: Array<[string, unknown, string]> = [
    [
      "update without identifier",
      {
        schemaVersion: 1,
        workspace: "jihuanshe",
        issues: [{ operation: "update", set: { title: "x" } }],
      },
      "requires an identifier",
    ],
    [
      "create with base",
      {
        schemaVersion: 1,
        workspace: "jihuanshe",
        issues: [{
          operation: "create",
          team: "DATA",
          set: { title: "x" },
          base: { title: "y" },
        }],
      },
      "base only applies to update",
    ],
    [
      "base field outside set",
      {
        schemaVersion: 1,
        workspace: "jihuanshe",
        issues: [{
          operation: "update",
          identifier: "DATA-1",
          set: { title: "x" },
          base: { priority: 2 },
        }],
      },
      "base.priority",
    ],
    [
      "team on update",
      {
        schemaVersion: 1,
        workspace: "jihuanshe",
        issues: [{
          operation: "update",
          identifier: "DATA-1",
          team: "DATA",
          set: { title: "x" },
        }],
      },
      "team only applies to create",
    ],
    [
      "empty label set on update",
      {
        schemaVersion: 1,
        workspace: "jihuanshe",
        issues: [{
          operation: "update",
          identifier: "DATA-1",
          set: { labels: [] },
        }],
      },
      "cannot clear the whole label set",
    ],
    [
      "assignee null on create",
      {
        schemaVersion: 1,
        workspace: "jihuanshe",
        issues: [{
          operation: "create",
          team: "DATA",
          set: { title: "x", assignee: null },
        }],
      },
      "no unassign flag",
    ],
    [
      "empty comment body string",
      {
        schemaVersion: 1,
        workspace: "jihuanshe",
        issues: [{
          operation: "update",
          identifier: "DATA-1",
          comments: [{ body: "   " }],
        }],
      },
      "body is empty",
    ],
    [
      "empty comment",
      {
        schemaVersion: 1,
        workspace: "jihuanshe",
        issues: [{
          operation: "update",
          identifier: "DATA-1",
          comments: [{}],
        }],
      },
      "needs a body",
    ],
    [
      "empty set",
      {
        schemaVersion: 1,
        workspace: "jihuanshe",
        issues: [{
          operation: "update",
          identifier: "DATA-1",
          set: {},
        }],
      },
      "set must contain at least one field",
    ],
    [
      "unknown field rejected by strict schema",
      {
        schemaVersion: 1,
        workspace: "jihuanshe",
        issues: [{
          operation: "update",
          identifier: "DATA-1",
          set: { title: "x", estimate: 3 },
        }],
      },
      "estimate",
    ],
    [
      "missing referenced file",
      {
        schemaVersion: 1,
        workspace: "jihuanshe",
        issues: [{
          operation: "update",
          identifier: "DATA-1",
          comments: [{ body: "b", files: [{ path: "absent.yrp" }] }],
        }],
      },
      "absent.yrp",
    ],
  ]
  for (const [name, manifest, message] of invalidCases) {
    await t.step(name, async () => {
      await withManifest(manifest, async (manifestPath) => {
        await assertRejects(
          () => loadManifest(manifestPath),
          ValidationError,
          message,
        )
      })
    })
  }
})

Deno.test("manifest inventories referenced files with size, MIME, and sha256", async () => {
  const dir = await Deno.makeTempDir()
  try {
    const body = join(dir, "comment.md")
    await Deno.writeTextFile(body, "hello")
    const manifestPath = join(dir, "delivery.json")
    await Deno.writeTextFile(
      manifestPath,
      JSON.stringify({
        schemaVersion: 1,
        workspace: "jihuanshe",
        issues: [{
          operation: "update",
          identifier: "DATA-1",
          comments: [{ bodyFile: "comment.md" }],
        }],
      }),
    )
    const loaded = await loadManifest(manifestPath)
    const file = loaded.files.get("comment.md")
    assertEquals(file?.size, 5)
    assertEquals(file?.contentType, "text/markdown")
    assertEquals(file?.sha256.length, 64)
  } finally {
    await Deno.remove(dir, { recursive: true })
  }
})

Deno.test("issue-delivery guide file attachment example parses", async () => {
  const guide = await Deno.readTextFile(
    new URL("../../docs/guides/issue-delivery.md", import.meta.url),
  )
  const example = guide.match(/```json\n([\s\S]*?)\n```/)
  if (example == null) {
    throw new Error("issue-delivery guide has no JSON example")
  }

  await withManifest(JSON.parse(example[1]), async (manifestPath, dir) => {
    await Deno.writeTextFile(join(dir, "description.md"), "description")
    await Deno.writeTextFile(join(dir, "evidence.md"), "evidence")
    await Deno.writeFile(join(dir, "replay-a.yrp"), new Uint8Array([1, 2, 3]))

    const loaded = await loadManifest(manifestPath)
    assertEquals(loaded.manifest.issues[0].attachments?.[1], {
      kind: "file",
      path: "replay-a.yrp",
      title: "Raw replay",
    })
  })
})

Deno.test("manifest inventory rejects files over the upload limit", async () => {
  const dir = await Deno.makeTempDir()
  try {
    const big = join(dir, "big.bin")
    const file = await Deno.open(big, { write: true, create: true })
    await file.truncate(100 * 1024 * 1024 + 1)
    file.close()
    const manifestPath = join(dir, "delivery.json")
    await Deno.writeTextFile(
      manifestPath,
      JSON.stringify({
        schemaVersion: 1,
        workspace: "jihuanshe",
        issues: [{
          operation: "update",
          identifier: "DATA-1",
          comments: [{ body: "evidence", files: [{ path: "big.bin" }] }],
        }],
      }),
    )
    await assertRejects(
      async () => await loadManifest(manifestPath),
      ValidationError,
      "too large",
    )
  } finally {
    await Deno.remove(dir, { recursive: true })
  }
})

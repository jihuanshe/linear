import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert"
import { join } from "@std/path"
import {
  applyManifest,
  checkpointPath,
  type CommandResult,
  type CommandRunner,
  normalizeMarkdown,
  planManifest,
} from "../../src/delivery/engine.ts"
import { loadManifest } from "../../src/delivery/manifest.ts"
import { ValidationError } from "../../src/utils/errors.ts"

// Every scenario runs against an injected fake runner: the delivery contract
// must be fully decidable without a network, and the recorded call log is the
// proof of which commands would have executed.

const REMOTE_VIEW = {
  title: "Old title",
  description: "Old body",
  priority: 2,
  state: { name: "Todo" },
  assignee: null,
  labels: { nodes: [{ name: "bug" }] },
  project: null,
  parent: null,
}

function fakeRunner(
  handler: (args: string[]) => CommandResult | undefined,
): CommandRunner & { calls: string[][] } {
  const calls: string[][] = []
  return {
    calls,
    run(args: string[]) {
      calls.push(args)
      return Promise.resolve(
        handler(args) ?? { code: 0, stdout: "{}", stderr: "" },
      )
    },
  }
}

function viewResult(overrides: Record<string, unknown> = {}): CommandResult {
  return {
    code: 0,
    stdout: JSON.stringify({ ...REMOTE_VIEW, ...overrides }),
    stderr: "",
  }
}

async function writeManifest(
  dir: string,
  manifest: unknown,
): Promise<string> {
  const manifestPath = join(dir, "delivery.json")
  await Deno.writeTextFile(manifestPath, JSON.stringify(manifest, null, 2))
  return manifestPath
}

Deno.test("plan reads update targets and never writes", async () => {
  const dir = await Deno.makeTempDir()
  try {
    const evidence = join(dir, "evidence.yrp")
    await Deno.writeFile(evidence, new Uint8Array([1, 2, 3]))
    const manifestPath = await writeManifest(dir, {
      schemaVersion: 1,
      workspace: "jihuanshe",
      issues: [{
        operation: "update",
        identifier: "DATA-606",
        set: { title: "New title", priority: 1 },
        base: { title: "Old title" },
        comments: [{ body: "evidence", files: [{ path: "evidence.yrp" }] }],
        attachments: [{
          kind: "url",
          url: "https://example.com/source",
          title: "Source",
        }],
        relations: [{ type: "related", issue: "DATA-580" }],
      }],
    })
    const runner = fakeRunner((args) =>
      args[1] === "view" ? viewResult() : undefined
    )
    const loaded = await loadManifest(manifestPath)
    const plan = await planManifest({ loaded, runner })

    assertEquals(plan.status, "ready")
    assertEquals(runner.calls.length, 1)
    assertEquals(runner.calls[0].slice(0, 3), ["issue", "view", "DATA-606"])
    const verdicts = Object.fromEntries(
      plan.issues[0].fields.map((field) => [field.field, field.verdict]),
    )
    assertEquals(verdicts, { title: "write", priority: "write" })
    assertEquals(plan.issues[0].items.length, 4)
    assertEquals(plan.files[0].reference, "evidence.yrp")
    assertEquals(plan.files[0].contentType, "application/octet-stream")
  } finally {
    await Deno.remove(dir, { recursive: true })
  }
})

Deno.test("plan flags a conflict when a colleague changed the field since base", async () => {
  const dir = await Deno.makeTempDir()
  try {
    const manifestPath = await writeManifest(dir, {
      schemaVersion: 1,
      workspace: "jihuanshe",
      issues: [{
        operation: "update",
        identifier: "DATA-606",
        set: { title: "New title" },
        base: { title: "A different old title" },
      }],
    })
    const runner = fakeRunner((args) =>
      args[1] === "view" ? viewResult() : undefined
    )
    const loaded = await loadManifest(manifestPath)
    const plan = await planManifest({ loaded, runner })

    assertEquals(plan.status, "conflict")
    assertEquals(plan.issues[0].fields[0].verdict, "conflict")
  } finally {
    await Deno.remove(dir, { recursive: true })
  }
})

Deno.test("apply creates, threads the identifier, and reads back", async () => {
  const dir = await Deno.makeTempDir()
  try {
    const image = join(dir, "before.png")
    await Deno.writeFile(image, new Uint8Array([137, 80]))
    const manifestPath = await writeManifest(dir, {
      schemaVersion: 1,
      workspace: "jihuanshe",
      issues: [{
        operation: "create",
        team: "DATA",
        set: { title: "New issue", labels: ["bug"] },
        comments: [{ body: "screenshot", files: [{ path: "before.png" }] }],
        attachments: [{
          kind: "url",
          url: "https://example.com/spec",
          title: "Spec",
        }],
        relations: [{ type: "blocks", issue: "DATA-1" }],
      }],
    })
    const runner = fakeRunner((args) => {
      if (args[1] === "create") {
        return {
          code: 0,
          stdout: JSON.stringify({
            success: true,
            issue: { id: "uuid", identifier: "DATA-700", url: "u" },
          }),
          stderr: "",
        }
      }
      if (args[1] === "view") return viewResult({ title: "New issue" })
      return undefined
    })
    const loaded = await loadManifest(manifestPath)
    const outcome = await applyManifest({ loaded, runner })

    assertEquals(outcome.status, "completed")
    assertEquals(
      outcome.items.map((item) => item.status),
      ["applied", "applied", "applied", "applied"],
    )
    assertEquals(outcome.createdIdentifiers["0"], "DATA-700")
    const kinds = runner.calls.map((call) => call.slice(0, 3).join(" "))
    assertEquals(kinds[0].startsWith("issue create"), true)
    assertEquals(kinds[1], "issue comment add")
    assertEquals(runner.calls[1][3], "DATA-700")
    assertEquals(kinds[2], "issue link DATA-700")
    assertEquals(kinds[3], "issue relation add")
    assertEquals(outcome.readBack["DATA-700"] != null, true)
  } finally {
    await Deno.remove(dir, { recursive: true })
  }
})

Deno.test("apply reports partial success and resumes without repeating", async () => {
  const dir = await Deno.makeTempDir()
  try {
    const evidence = join(dir, "evidence.yrp")
    await Deno.writeFile(evidence, new Uint8Array([1]))
    const manifestPath = await writeManifest(dir, {
      schemaVersion: 1,
      workspace: "jihuanshe",
      issues: [{
        operation: "update",
        identifier: "DATA-606",
        set: { title: "New title" },
        comments: [{ body: "evidence", files: [{ path: "evidence.yrp" }] }],
        attachments: [{
          kind: "file",
          path: "evidence.yrp",
          title: "Raw evidence",
        }],
      }],
    })
    let commentAttempts = 0
    const runner = fakeRunner((args) => {
      if (args[1] === "view") return viewResult()
      if (args[1] === "comment") {
        commentAttempts += 1
        if (commentAttempts === 1) {
          return { code: 1, stdout: "", stderr: "✗ upload failed" }
        }
      }
      return undefined
    })
    const loaded = await loadManifest(manifestPath)
    const first = await applyManifest({ loaded, runner })

    assertEquals(first.status, "stopped-on-failure")
    assertEquals(
      first.items.map((item) => item.status),
      ["applied", "failed", "unattempted"],
    )

    const second = await applyManifest({
      loaded: await loadManifest(manifestPath),
      runner,
    })
    assertEquals(second.status, "completed")
    assertEquals(
      second.items.map((item) => item.status),
      ["skipped", "applied", "applied"],
    )
    const updateCalls = runner.calls.filter((call) => call[1] === "update")
    assertEquals(updateCalls.length, 1)
  } finally {
    await Deno.remove(dir, { recursive: true })
  }
})

Deno.test("an unknown outcome blocks further runs until reconciled", async () => {
  const dir = await Deno.makeTempDir()
  try {
    const manifestPath = await writeManifest(dir, {
      schemaVersion: 1,
      workspace: "jihuanshe",
      issues: [{
        operation: "create",
        team: "DATA",
        set: { title: "New issue" },
      }],
    })
    const runner = fakeRunner((args) =>
      args[1] === "create" ? { code: 1, stdout: "", stderr: "" } : undefined
    )
    const loaded = await loadManifest(manifestPath)
    const outcome = await applyManifest({ loaded, runner })

    assertEquals(outcome.status, "stopped-on-unknown")
    assertEquals(outcome.items[0].status, "unknown")

    await assertRejects(
      async () =>
        await applyManifest({
          loaded: await loadManifest(manifestPath),
          runner,
        }),
      ValidationError,
      "unresolved unknown",
    )
    const checkpoint = JSON.parse(
      await Deno.readTextFile(checkpointPath(manifestPath)),
    )
    const statuses = Object.values(
      checkpoint.items as Record<string, { status: string }>,
    )
    assertEquals(statuses[0].status, "unknown")
  } finally {
    await Deno.remove(dir, { recursive: true })
  }
})

Deno.test("idempotent and conflicting updates never invoke issue update", async () => {
  const dir = await Deno.makeTempDir()
  try {
    const idempotentPath = await writeManifest(dir, {
      schemaVersion: 1,
      workspace: "jihuanshe",
      issues: [{
        operation: "update",
        identifier: "DATA-606",
        set: { title: "Old title", labels: ["bug"] },
      }],
    })
    const runner = fakeRunner((args) =>
      args[1] === "view" ? viewResult() : undefined
    )
    const outcome = await applyManifest({
      loaded: await loadManifest(idempotentPath),
      runner,
    })
    assertEquals(outcome.status, "completed")
    assertStringIncludes(outcome.items[0].detail ?? "", "idempotent")
    assertEquals(runner.calls.some((call) => call[1] === "update"), false)

    const conflictPath = join(dir, "conflict.json")
    await Deno.writeTextFile(
      conflictPath,
      JSON.stringify({
        schemaVersion: 1,
        workspace: "jihuanshe",
        issues: [{
          operation: "update",
          identifier: "DATA-606",
          set: { title: "New title" },
          base: { title: "Some other title" },
        }],
      }),
    )
    const conflictRunner = fakeRunner((args) =>
      args[1] === "view" ? viewResult() : undefined
    )
    const conflictOutcome = await applyManifest({
      loaded: await loadManifest(conflictPath),
      runner: conflictRunner,
    })
    assertEquals(conflictOutcome.status, "conflict")
    assertEquals(
      conflictRunner.calls.some((call) => call[1] === "update"),
      false,
    )
  } finally {
    await Deno.remove(dir, { recursive: true })
  }
})

Deno.test("a batch stops at the first failure by default and continues with the flag", async () => {
  const batchManifest = {
    schemaVersion: 1,
    workspace: "jihuanshe",
    issues: [
      {
        operation: "update",
        identifier: "DATA-1",
        set: { title: "First" },
      },
      {
        operation: "update",
        identifier: "DATA-2",
        set: { title: "Second" },
      },
    ],
  }
  const failFirstUpdate = () => {
    let updates = 0
    return fakeRunner((args) => {
      if (args[1] === "view") return viewResult()
      if (args[1] === "update") {
        updates += 1
        if (updates === 1) {
          return { code: 1, stdout: "", stderr: "✗ state not found" }
        }
      }
      return undefined
    })
  }

  const stopDir = await Deno.makeTempDir()
  try {
    const manifestPath = await writeManifest(stopDir, batchManifest)
    const runner = failFirstUpdate()
    const outcome = await applyManifest({
      loaded: await loadManifest(manifestPath),
      runner,
    })
    assertEquals(outcome.status, "stopped-on-failure")
    assertEquals(
      outcome.items.map((item) => item.status),
      ["failed", "unattempted"],
    )
    assertEquals(outcome.summary.failed, 1)
    assertEquals(outcome.summary.unattempted, 1)
  } finally {
    await Deno.remove(stopDir, { recursive: true })
  }

  const continueDir = await Deno.makeTempDir()
  try {
    const manifestPath = await writeManifest(continueDir, batchManifest)
    const runner = failFirstUpdate()
    const outcome = await applyManifest({
      loaded: await loadManifest(manifestPath),
      runner,
      continueOnFailure: true,
    })
    assertEquals(outcome.status, "completed-with-failures")
    assertEquals(
      outcome.items.map((item) => item.status),
      ["failed", "applied"],
    )
    assertEquals(outcome.readBack["DATA-2"] != null, true)
    assertEquals(outcome.readBack["DATA-1"] == null, true)
  } finally {
    await Deno.remove(continueDir, { recursive: true })
  }
})

Deno.test("markdown normalization absorbs Linear's equivalent rewrites only", () => {
  assertEquals(
    normalizeMarkdown("* one\r\n* two  \n"),
    normalizeMarkdown("- one\n- two"),
  )
  assertEquals(
    normalizeMarkdown("- one") === normalizeMarkdown("- one changed"),
    false,
  )
})

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
import { formatApply } from "../../src/commands/issue/issue-apply.ts"
import { formatPlan } from "../../src/commands/issue/issue-plan.ts"
import { loadManifest } from "../../src/delivery/manifest.ts"
import { ValidationError } from "../../src/utils/errors.ts"

// Every scenario runs against an injected fake runner: the delivery contract
// must be fully decidable without a network, and the recorded call log is the
// proof of which commands would have executed.

const REMOTE_VIEW = {
  identifier: "DATA-606",
  archivedAt: null,
  trashed: false,
  title: "Old title",
  description: "Old body",
  priority: 2,
  state: { name: "Todo", type: "unstarted" },
  assignee: null,
  labels: {
    nodes: [{ name: "bug" }],
    pageInfo: { hasNextPage: false },
  },
  project: null,
  parent: null,
  relations: {
    nodes: [],
    pageInfo: { hasNextPage: false },
  },
  inverseRelations: {
    nodes: [],
    pageInfo: { hasNextPage: false },
  },
}

function fakeRunner(
  handler: (args: string[]) => CommandResult | undefined,
): CommandRunner & { calls: string[][] } {
  const calls: string[][] = []
  return {
    calls,
    run(args: string[]) {
      // The workspace identity preflight is answered here and kept out of the
      // recorded calls so scenarios assert only their own command sequences.
      if (args[0] === "auth" && args[1] === "whoami") {
        return Promise.resolve(
          handler(args) ?? {
            code: 0,
            stdout: JSON.stringify({ organization: { urlKey: "jihuanshe" } }),
            stderr: "",
          },
        )
      }
      calls.push(args)
      const result = handler(args)
      if (result != null) return Promise.resolve(result)
      if (args[0] === "issue" && args[1] === "view") {
        return Promise.resolve(viewResult({ identifier: args[2] }))
      }
      return Promise.resolve(
        { code: 0, stdout: "{}", stderr: "" },
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
        base: { title: "Old title", priority: 2 },
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

Deno.test("plan summarizes create content without duplicating long bodies", async () => {
  const dir = await Deno.makeTempDir()
  try {
    await Deno.writeTextFile(join(dir, "description.md"), "Preview body")
    await Deno.writeTextFile(join(dir, "comment.md"), "Evidence caption")
    await Deno.writeFile(join(dir, "evidence.yrp"), new Uint8Array([1, 2, 3]))
    const manifestPath = await writeManifest(dir, {
      schemaVersion: 1,
      workspace: "jihuanshe",
      issues: [{
        operation: "create",
        team: "DATA",
        set: {
          title: "Preview title",
          descriptionFile: "description.md",
          priority: 2,
          state: "Todo",
          assignee: "alex",
          labels: ["Bug"],
          project: "Linear CLI",
        },
        comments: [{
          bodyFile: "comment.md",
          files: [{ path: "evidence.yrp" }],
          public: true,
        }],
        attachments: [{
          kind: "file",
          path: "evidence.yrp",
          title: "Raw replay",
        }],
        relations: [{ type: "related", issue: "DATA-580" }],
      }],
    })
    const plan = await planManifest({
      loaded: await loadManifest(manifestPath),
      runner: fakeRunner(() => undefined),
    })

    const issue = plan.issues[0]
    assertEquals(issue.fields, [])
    assertEquals(issue.summary.team, "DATA")
    assertEquals(issue.summary.set?.title, "Preview title")
    assertEquals(issue.summary.set?.description?.source, "file")
    assertEquals(issue.summary.comments?.[0].body?.source, "file")
    assertEquals(issue.summary.comments?.[0].public, true)
    assertEquals(issue.summary.comments?.[0].files[0].reference, "evidence.yrp")
    assertEquals(issue.summary.attachments?.[0].kind, "file")
    assertEquals(issue.summary.relations, [{
      type: "related",
      issue: "DATA-580",
      verdict: "add",
    }])
    assertEquals(JSON.stringify(plan).includes("Preview body"), false)
    assertEquals(JSON.stringify(plan).includes("Evidence caption"), false)

    const human = formatPlan(plan)
    assertStringIncludes(human, 'title: "Preview title"')
    assertStringIncludes(human, "description: file description.md")
    assertStringIncludes(human, "uploads: public")
    assertStringIncludes(human, 'attachment: file evidence.yrp as "Raw replay"')
    assertStringIncludes(human, "relation: related DATA-580 — add")
    assertEquals(human.includes("Preview body"), false)
  } finally {
    await Deno.remove(dir, { recursive: true })
  }
})

Deno.test("relation conflicts refuse an update before any mutation", async () => {
  const dir = await Deno.makeTempDir()
  try {
    const manifestPath = await writeManifest(dir, {
      schemaVersion: 1,
      workspace: "jihuanshe",
      issues: [{
        operation: "update",
        identifier: "DATA-606",
        set: { title: "New title" },
        base: { title: "Old title" },
        comments: [{ body: "Evidence" }],
        relations: [{ type: "blocks", issue: "DATA-580" }],
      }],
    })
    const existingRelated = viewResult({
      relations: {
        nodes: [{
          type: "related",
          relatedIssue: { identifier: "DATA-580" },
        }],
        pageInfo: { hasNextPage: false },
      },
    })
    const runner = fakeRunner((args) =>
      args[1] === "view" ? existingRelated : undefined
    )
    const loaded = await loadManifest(manifestPath)

    const plan = await planManifest({ loaded, runner })
    assertEquals(plan.status, "conflict")
    assertEquals(plan.issues[0].summary.relations?.[0].verdict, "conflict")
    assertStringIncludes(
      plan.issues[0].summary.relations?.[0].detail ?? "",
      "related DATA-580",
    )

    const outcome = await applyManifest({ loaded, runner })
    assertEquals(outcome.status, "conflict")
    assertEquals(
      outcome.items.map(({ status }) => status),
      ["unattempted", "unattempted", "failed"],
    )
    assertEquals(
      runner.calls.some((args) =>
        ["update", "comment", "relation"].includes(args[1])
      ),
      false,
    )
  } finally {
    await Deno.remove(dir, { recursive: true })
  }
})

Deno.test("equivalent relations checkpoint idempotently without mutation", async () => {
  const dir = await Deno.makeTempDir()
  try {
    const manifestPath = await writeManifest(dir, {
      schemaVersion: 1,
      workspace: "jihuanshe",
      issues: [{
        operation: "update",
        identifier: "DATA-606",
        relations: [{ type: "related", issue: "DATA-580" }],
      }],
    })
    const runner = fakeRunner((args) =>
      args[1] === "view"
        ? viewResult({
          relations: {
            nodes: [{
              type: "related",
              relatedIssue: { identifier: "DATA-580" },
            }],
            pageInfo: { hasNextPage: false },
          },
        })
        : undefined
    )
    const loaded = await loadManifest(manifestPath)
    const first = await applyManifest({ loaded, runner })

    assertEquals(first.status, "completed")
    assertEquals(first.items[0].status, "applied")
    assertStringIncludes(first.items[0].detail ?? "", "idempotent")
    assertEquals(
      runner.calls.filter((args) => args[1] === "relation").length,
      0,
    )
    assertStringIncludes(formatApply(first), "verified DATA-606")

    const viewCallsBeforeResume = runner.calls.filter((args) =>
      args[1] === "view"
    ).length
    const resumed = await applyManifest({ loaded, runner })
    assertEquals(resumed.status, "completed")
    assertEquals(resumed.items[0].status, "skipped")
    assertEquals(
      runner.calls.filter((args) => args[1] === "view").length -
        viewCallsBeforeResume,
      1,
    )
  } finally {
    await Deno.remove(dir, { recursive: true })
  }
})

Deno.test("virtual idempotence waits for the preceding relation mutation", async () => {
  const dir = await Deno.makeTempDir()
  try {
    const manifestPath = await writeManifest(dir, {
      schemaVersion: 1,
      workspace: "jihuanshe",
      issues: [{
        operation: "update",
        identifier: "DATA-606",
        relations: [
          { type: "related", issue: "DATA-580" },
          { type: "related", issue: "DATA-580" },
        ],
      }],
    })
    let relationCalls = 0
    const runner = fakeRunner((args) => {
      if (args[1] === "view") return viewResult()
      if (args[1] === "relation") {
        relationCalls += 1
        return { code: 1, stdout: "", stderr: "✗ relation failed" }
      }
      return undefined
    })
    const outcome = await applyManifest({
      loaded: await loadManifest(manifestPath),
      runner,
      continueOnFailure: true,
    })

    assertEquals(outcome.status, "completed-with-failures")
    assertEquals(outcome.items.map(({ status }) => status), [
      "failed",
      "failed",
    ])
    assertEquals(relationCalls, 2)
    const checkpoint = JSON.parse(
      await Deno.readTextFile(checkpointPath(manifestPath)),
    ) as { items: Record<string, { status: string }> }
    assertEquals(
      Object.values(checkpoint.items).map(({ status }) => status),
      ["failed", "failed"],
    )
  } finally {
    await Deno.remove(dir, { recursive: true })
  }
})

Deno.test("relation conflicts preserve applied checkpoint items on resume", async () => {
  const dir = await Deno.makeTempDir()
  try {
    const manifestPath = await writeManifest(dir, {
      schemaVersion: 1,
      workspace: "jihuanshe",
      issues: [{
        operation: "update",
        identifier: "DATA-606",
        set: { title: "New title" },
        base: { title: "Old title" },
        relations: [{ type: "blocks", issue: "DATA-580" }],
      }],
    })
    let relationConflict = false
    let relationCalls = 0
    const runner = fakeRunner((args) => {
      if (args[1] === "view") {
        return relationConflict
          ? viewResult({
            title: "New title",
            relations: {
              nodes: [{
                type: "related",
                relatedIssue: { identifier: "DATA-580" },
              }],
              pageInfo: { hasNextPage: false },
            },
          })
          : viewResult()
      }
      if (args[1] === "relation") {
        relationCalls += 1
        return { code: 1, stdout: "", stderr: "✗ relation failed" }
      }
      return undefined
    })
    const loaded = await loadManifest(manifestPath)
    const first = await applyManifest({ loaded, runner })
    assertEquals(first.status, "stopped-on-failure")
    assertEquals(first.items.map(({ status }) => status), ["applied", "failed"])

    relationConflict = true
    const resumed = await applyManifest({ loaded, runner })
    assertEquals(resumed.status, "conflict")
    assertEquals(resumed.items.map(({ status }) => status), [
      "skipped",
      "failed",
    ])
    assertEquals(resumed.verification[0].status, "verified")
    assertEquals(relationCalls, 1)
  } finally {
    await Deno.remove(dir, { recursive: true })
  }
})

Deno.test("conflicting create relations refuse before creating the issue", async () => {
  const dir = await Deno.makeTempDir()
  try {
    const manifestPath = await writeManifest(dir, {
      schemaVersion: 1,
      workspace: "jihuanshe",
      issues: [{
        operation: "create",
        team: "DATA",
        set: { title: "New issue" },
        relations: [
          { type: "related", issue: "DATA-580" },
          { type: "blocks", issue: "DATA-580" },
        ],
      }],
    })
    const runner = fakeRunner(() => undefined)
    const loaded = await loadManifest(manifestPath)

    const plan = await planManifest({ loaded, runner })
    assertEquals(plan.status, "conflict")
    assertEquals(
      plan.issues[0].summary.relations?.map(({ verdict }) => verdict),
      ["add", "conflict"],
    )

    const outcome = await applyManifest({ loaded, runner })
    assertEquals(outcome.status, "conflict")
    assertEquals(
      outcome.items.map(({ status }) => status),
      ["unattempted", "unattempted", "failed"],
    )
    assertEquals(runner.calls.length, 0)
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

Deno.test("description updates preserve an explicit null base", async () => {
  const dir = await Deno.makeTempDir()
  try {
    await Deno.writeTextFile(join(dir, "description.md"), "New body")
    const manifestPath = await writeManifest(dir, {
      schemaVersion: 1,
      workspace: "jihuanshe",
      issues: [{
        operation: "update",
        identifier: "DATA-606",
        set: { descriptionFile: "description.md" },
        base: { description: null },
      }],
    })
    const loaded = await loadManifest(manifestPath)
    const ready = await planManifest({
      loaded,
      runner: fakeRunner((args) =>
        args[1] === "view" ? viewResult({ description: null }) : undefined
      ),
    })
    const conflict = await planManifest({
      loaded,
      runner: fakeRunner((args) =>
        args[1] === "view"
          ? viewResult({ description: "Colleague body" })
          : undefined
      ),
    })

    assertEquals(ready.issues[0].fields[0].verdict, "write")
    assertEquals(conflict.issues[0].fields[0].verdict, "conflict")
  } finally {
    await Deno.remove(dir, { recursive: true })
  }
})

Deno.test("field guards compare canonical priority, state, and project values", async () => {
  const dir = await Deno.makeTempDir()
  try {
    const manifestPath = await writeManifest(dir, {
      schemaVersion: 1,
      workspace: "jihuanshe",
      issues: [{
        operation: "update",
        identifier: "DATA-606",
        set: {
          priority: 1,
          state: "started",
          project: "alpha-slug",
        },
        base: { priority: null, state: "Todo", project: null },
      }],
    })
    const runner = fakeRunner((args) =>
      args[1] === "view"
        ? viewResult({ priority: 0, project: null })
        : undefined
    )
    const plan = await planManifest({
      loaded: await loadManifest(manifestPath),
      runner,
    })

    assertEquals(plan.status, "ready")
    assertEquals(
      Object.fromEntries(
        plan.issues[0].fields.map((field) => [field.field, field.verdict]),
      ),
      {
        priority: "write",
        state: "write",
        project: "write",
      },
    )

    const aliasPath = join(dir, "aliases.json")
    await Deno.writeTextFile(
      aliasPath,
      JSON.stringify({
        schemaVersion: 1,
        workspace: "jihuanshe",
        issues: [{
          operation: "update",
          identifier: "DATA-606",
          set: { state: "started", project: "alpha-slug" },
          base: { state: "Todo", project: null },
        }],
      }),
    )
    const aliasRunner = fakeRunner((args) =>
      args[1] === "view"
        ? viewResult({
          state: { name: "In Progress", type: "started" },
          project: {
            id: "project-id",
            name: "Alpha",
            slugId: "alpha-slug",
          },
        })
        : undefined
    )
    const aliases = await planManifest({
      loaded: await loadManifest(aliasPath),
      runner: aliasRunner,
    })
    assertEquals(
      aliases.issues[0].fields.filter((field) =>
        field.field === "state" || field.field === "project"
      ).map((field) => field.verdict),
      ["idempotent", "idempotent"],
    )
  } finally {
    await Deno.remove(dir, { recursive: true })
  }
})

Deno.test("label guards refuse a truncated remote set", async () => {
  const dir = await Deno.makeTempDir()
  try {
    const manifestPath = await writeManifest(dir, {
      schemaVersion: 1,
      workspace: "jihuanshe",
      issues: [{
        operation: "update",
        identifier: "DATA-606",
        set: { labels: ["bug"] },
        base: { labels: ["bug"] },
      }],
    })
    const runner = fakeRunner((args) =>
      args[1] === "view"
        ? viewResult({
          labels: {
            nodes: [{ name: "bug" }],
            pageInfo: { hasNextPage: true },
          },
        })
        : undefined
    )

    await assertRejects(
      async () =>
        planManifest({
          loaded: await loadManifest(manifestPath),
          runner,
        }),
      ValidationError,
      "label set exceeds",
    )
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
      if (args[1] === "view") {
        return viewResult({ identifier: "DATA-700", title: "New issue" })
      }
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
    assertEquals(outcome.verification, [{
      issueIndex: 0,
      target: "DATA-700",
      status: "verified",
    }])
  } finally {
    await Deno.remove(dir, { recursive: true })
  }
})

Deno.test("apply reports successful mutations with failed read-back as unverified", async () => {
  const cases = [
    {
      name: "nonzero view",
      readBack: {
        code: 1,
        stdout: "",
        stderr: "✗ synthetic read-back failure",
      },
      detail: "synthetic read-back failure",
    },
    {
      name: "invalid JSON",
      readBack: { code: 0, stdout: "not json", stderr: "" },
      detail: "invalid JSON",
    },
  ]
  for (const testCase of cases) {
    const dir = await Deno.makeTempDir()
    try {
      const manifestPath = await writeManifest(dir, {
        schemaVersion: 1,
        workspace: "jihuanshe",
        issues: [{
          operation: "update",
          identifier: "DATA-606",
          set: { title: "New title" },
          base: { title: "Old title" },
        }],
      })
      let viewCalls = 0
      const runner = fakeRunner((args) => {
        if (args[1] === "view") {
          viewCalls += 1
          return viewCalls < 3 ? viewResult() : testCase.readBack
        }
        return undefined
      })
      const outcome = await applyManifest({
        loaded: await loadManifest(manifestPath),
        runner,
      })

      assertEquals(outcome.status, "applied-unverified", testCase.name)
      assertEquals(outcome.items[0].status, "applied")
      assertEquals(outcome.readBack, {})
      assertEquals(outcome.verification[0].status, "failed")
      assertStringIncludes(
        outcome.verification[0].detail ?? "",
        testCase.detail,
      )
      assertStringIncludes(formatApply(outcome), "failed DATA-606")
    } finally {
      await Deno.remove(dir, { recursive: true })
    }
  }
})

Deno.test("an all-skipped resume retries final read-back", async () => {
  const dir = await Deno.makeTempDir()
  try {
    const manifestPath = await writeManifest(dir, {
      schemaVersion: 1,
      workspace: "jihuanshe",
      issues: [{
        operation: "update",
        identifier: "DATA-606",
        set: { title: "New title" },
        base: { title: "Old title" },
      }],
    })
    let viewCalls = 0
    const runner = fakeRunner((args) => {
      if (args[1] === "view") {
        viewCalls += 1
        return viewCalls === 3
          ? { code: 1, stdout: "", stderr: "✗ temporary read-back failure" }
          : viewResult()
      }
      return undefined
    })
    const first = await applyManifest({
      loaded: await loadManifest(manifestPath),
      runner,
    })
    assertEquals(first.status, "applied-unverified")
    const callsBeforeResume = viewCalls
    const resumed = await applyManifest({
      loaded: await loadManifest(manifestPath),
      runner,
    })

    assertEquals(resumed.status, "completed")
    assertEquals(resumed.items.map((item) => item.status), ["skipped"])
    assertEquals(viewCalls - callsBeforeResume, 1)
    assertEquals(
      runner.calls.filter((call) => call[1] === "update").length,
      1,
    )
    assertEquals(resumed.verification[0].status, "verified")
    assertEquals(resumed.readBack["DATA-606"] != null, true)
  } finally {
    await Deno.remove(dir, { recursive: true })
  }
})

Deno.test("all-skipped verification failures stay applied-unverified", async () => {
  const cases: Array<[string, CommandResult, string]> = [
    [
      "nonzero view",
      { code: 1, stdout: "", stderr: "✗ read-back unavailable" },
      "read-back unavailable",
    ],
    [
      "invalid JSON",
      { code: 0, stdout: "not json", stderr: "" },
      "invalid JSON",
    ],
    [
      "no issue object",
      { code: 0, stdout: "null", stderr: "" },
      "no issue object",
    ],
    [
      "mismatched identifier",
      {
        code: 0,
        stdout: JSON.stringify({ identifier: "DATA-999" }),
        stderr: "",
      },
      "DATA-999",
    ],
  ]
  for (const [name, failedView, detail] of cases) {
    const dir = await Deno.makeTempDir()
    try {
      const manifestPath = await writeManifest(dir, {
        schemaVersion: 1,
        workspace: "jihuanshe",
        issues: [{
          operation: "update",
          identifier: "DATA-606",
          set: { title: "New title" },
          base: { title: "Old title" },
        }],
      })
      let failVerification = false
      let resumedViewCalls = 0
      const runner = fakeRunner((args) => {
        if (args[1] === "view") {
          if (failVerification) {
            resumedViewCalls += 1
            return failedView
          }
          return viewResult()
        }
        return undefined
      })
      const first = await applyManifest({
        loaded: await loadManifest(manifestPath),
        runner,
      })
      assertEquals(first.status, "completed")

      failVerification = true
      const resumed = await applyManifest({
        loaded: await loadManifest(manifestPath),
        runner,
      })
      assertEquals(resumed.status, "applied-unverified", name)
      assertEquals(resumed.items.map((item) => item.status), ["skipped"])
      assertEquals(resumedViewCalls, 1)
      assertStringIncludes(resumed.verification[0].detail ?? "", detail)
      assertEquals(
        runner.calls.filter((call) => call[1] === "update").length,
        1,
      )
    } finally {
      await Deno.remove(dir, { recursive: true })
    }
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
        base: { title: "Old title" },
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

Deno.test("resume refuses when an issue is inserted before applied entries", async () => {
  const dir = await Deno.makeTempDir()
  try {
    const createOk = (title: string) => ({
      operation: "create",
      team: "DATA",
      set: { title },
    })
    const manifestPath = await writeManifest(dir, {
      schemaVersion: 1,
      workspace: "jihuanshe",
      issues: [createOk("Issue A"), {
        operation: "update",
        identifier: "DATA-606",
        relations: [{ type: "related", issue: "DATA-9999" }],
      }],
    })
    const runner = fakeRunner((args) => {
      if (args[1] === "view") return viewResult()
      if (args[1] === "create") {
        return {
          code: 0,
          stdout: JSON.stringify({ issue: { identifier: "DATA-700" } }),
          stderr: "",
        }
      }
      if (args[1] === "relation") {
        return { code: 1, stdout: "", stderr: "✗ Could not find issue" }
      }
      return undefined
    })
    const first = await applyManifest({
      loaded: await loadManifest(manifestPath),
      runner,
    })
    assertEquals(first.status, "stopped-on-failure")
    assertEquals(first.items[0].status, "applied")

    // A helpful teammate prepends a new issue: every applied position shifts.
    await writeManifest(dir, {
      schemaVersion: 1,
      workspace: "jihuanshe",
      issues: [createOk("Inserted issue"), createOk("Issue A"), {
        operation: "update",
        identifier: "DATA-606",
        relations: [{ type: "related", issue: "DATA-580" }],
      }],
    })
    const callsBefore = runner.calls.length
    await assertRejects(
      async () =>
        await applyManifest({
          loaded: await loadManifest(manifestPath),
          runner,
        }),
      ValidationError,
      "no longer match any manifest item",
    )
    // The refusal happens before any remote work.
    assertEquals(runner.calls.length, callsBefore)
  } finally {
    await Deno.remove(dir, { recursive: true })
  }
})

Deno.test("resume refuses when an applied issue is removed or edited", async () => {
  const dir = await Deno.makeTempDir()
  try {
    const manifestPath = await writeManifest(dir, {
      schemaVersion: 1,
      workspace: "jihuanshe",
      issues: [{
        operation: "create",
        team: "DATA",
        set: { title: "Issue A" },
      }],
    })
    const runner = fakeRunner((args) =>
      args[1] === "create"
        ? {
          code: 0,
          stdout: JSON.stringify({ issue: { identifier: "DATA-700" } }),
          stderr: "",
        }
        : undefined
    )
    const first = await applyManifest({
      loaded: await loadManifest(manifestPath),
      runner,
    })
    assertEquals(first.status, "completed")

    // Editing the applied issue orphans its checkpoint key; re-running would
    // create a second issue instead of updating the first.
    await writeManifest(dir, {
      schemaVersion: 1,
      workspace: "jihuanshe",
      issues: [{
        operation: "create",
        team: "DATA",
        set: { title: "Issue A, reworded" },
      }],
    })
    await assertRejects(
      async () =>
        await applyManifest({
          loaded: await loadManifest(manifestPath),
          runner,
        }),
      ValidationError,
      "no longer match any manifest item",
    )
  } finally {
    await Deno.remove(dir, { recursive: true })
  }
})

Deno.test("resume allows appending new issues after applied entries", async () => {
  const dir = await Deno.makeTempDir()
  try {
    const manifestPath = await writeManifest(dir, {
      schemaVersion: 1,
      workspace: "jihuanshe",
      issues: [{
        operation: "create",
        team: "DATA",
        set: { title: "Issue A" },
      }],
    })
    let created = 0
    const runner = fakeRunner((args) => {
      if (args[1] === "create") {
        created += 1
        return {
          code: 0,
          stdout: JSON.stringify({
            issue: { identifier: `DATA-70${created}` },
          }),
          stderr: "",
        }
      }
      return undefined
    })
    const first = await applyManifest({
      loaded: await loadManifest(manifestPath),
      runner,
    })
    assertEquals(first.status, "completed")

    await writeManifest(dir, {
      schemaVersion: 1,
      workspace: "jihuanshe",
      issues: [
        { operation: "create", team: "DATA", set: { title: "Issue A" } },
        { operation: "create", team: "DATA", set: { title: "Issue B" } },
      ],
    })
    const second = await applyManifest({
      loaded: await loadManifest(manifestPath),
      runner,
    })
    assertEquals(second.status, "completed")
    assertEquals(
      second.items.map((item) => item.status),
      ["skipped", "applied"],
    )
    assertEquals(created, 2)
  } finally {
    await Deno.remove(dir, { recursive: true })
  }
})

Deno.test("apply refuses archived, trashed, and alias-resolved targets", async () => {
  const cases = [
    {
      overrides: { archivedAt: "2026-01-01T00:00:00.000Z" },
      expect: "archived",
    },
    { overrides: { trashed: true }, expect: "trash" },
    { overrides: { identifier: "DATA-999" }, expect: "resolved to DATA-999" },
  ]
  for (const { overrides, expect } of cases) {
    const dir = await Deno.makeTempDir()
    try {
      const manifestPath = await writeManifest(dir, {
        schemaVersion: 1,
        workspace: "jihuanshe",
        issues: [{
          operation: "update",
          identifier: "DATA-606",
          set: { title: "New title" },
          base: { title: "Old title" },
        }],
      })
      const runner = fakeRunner((args) =>
        args[1] === "view" ? viewResult(overrides) : undefined
      )
      const outcome = await applyManifest({
        loaded: await loadManifest(manifestPath),
        runner,
      })
      assertEquals(outcome.status, "stopped-on-failure")
      assertEquals(outcome.items[0].status, "failed")
      assertStringIncludes(outcome.items[0].detail ?? "", expect)
      assertEquals(runner.calls.some((call) => call[1] === "update"), false)
    } finally {
      await Deno.remove(dir, { recursive: true })
    }
  }
})

Deno.test("plan reports object drift as a conflict", async () => {
  const dir = await Deno.makeTempDir()
  try {
    const manifestPath = await writeManifest(dir, {
      schemaVersion: 1,
      workspace: "jihuanshe",
      issues: [{
        operation: "update",
        identifier: "DATA-606",
        set: { title: "New title" },
        base: { title: "Old title" },
      }],
    })
    const runner = fakeRunner((args) =>
      args[1] === "view"
        ? viewResult({ archivedAt: "2026-01-01T00:00:00.000Z" })
        : undefined
    )
    const plan = await planManifest({
      loaded: await loadManifest(manifestPath),
      runner,
    })
    assertEquals(plan.status, "conflict")
    assertStringIncludes(plan.issues[0].drift ?? "", "archived")
  } finally {
    await Deno.remove(dir, { recursive: true })
  }
})

Deno.test("apply refuses when resolved credentials mismatch the manifest workspace", async () => {
  const dir = await Deno.makeTempDir()
  try {
    const manifestPath = await writeManifest(dir, {
      schemaVersion: 1,
      workspace: "jihuanshe",
      issues: [{
        operation: "update",
        identifier: "DATA-606",
        set: { title: "New title" },
        base: { title: "Old title" },
      }],
    })
    const runner = fakeRunner((args) =>
      args[0] === "auth" && args[1] === "whoami"
        ? {
          code: 0,
          stdout: JSON.stringify({ organization: { urlKey: "kadoraba" } }),
          stderr: "",
        }
        : undefined
    )
    await assertRejects(
      async () =>
        await applyManifest({
          loaded: await loadManifest(manifestPath),
          runner,
        }),
      ValidationError,
      "belong to kadoraba",
    )
    // The refusal happens before any remote command beyond the probe.
    assertEquals(runner.calls.length, 0)
  } finally {
    await Deno.remove(dir, { recursive: true })
  }
})

Deno.test("a launched mutation is checkpointed before its result", async () => {
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
    let inFlight: string | null = null
    const runner = fakeRunner((args) => {
      if (args[1] === "create") {
        const checkpoint = JSON.parse(
          Deno.readTextFileSync(checkpointPath(manifestPath)),
        ) as { items: Record<string, { status: string }> }
        inFlight = Object.values(checkpoint.items)[0]?.status ?? null
        return {
          code: 0,
          stdout: JSON.stringify({ issue: { identifier: "DATA-700" } }),
          stderr: "",
        }
      }
      return undefined
    })
    const outcome = await applyManifest({
      loaded: await loadManifest(manifestPath),
      runner,
    })
    assertEquals(outcome.status, "completed")
    assertEquals(inFlight, "unknown")
    const final = JSON.parse(
      await Deno.readTextFile(checkpointPath(manifestPath)),
    ) as { items: Record<string, { status: string }> }
    assertEquals(Object.values(final.items)[0].status, "applied")
  } finally {
    await Deno.remove(dir, { recursive: true })
  }
})

Deno.test("plan reads comment-only update targets", async () => {
  const dir = await Deno.makeTempDir()
  try {
    const manifestPath = await writeManifest(dir, {
      schemaVersion: 1,
      workspace: "jihuanshe",
      issues: [{
        operation: "update",
        identifier: "DATA-606",
        comments: [{ body: "evidence" }],
      }],
    })
    const runner = fakeRunner((args) =>
      args[1] === "view"
        ? viewResult({ archivedAt: "2026-01-01T00:00:00.000Z" })
        : undefined
    )
    const plan = await planManifest({
      loaded: await loadManifest(manifestPath),
      runner,
    })
    assertEquals(runner.calls.some((call) => call[1] === "view"), true)
    assertEquals(plan.status, "conflict")
    assertStringIncludes(plan.issues[0].drift ?? "", "archived")
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
        base: { title: "Old title", labels: ["bug"] },
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

Deno.test("batch preflight refuses a later conflict before any mutation", async () => {
  const dir = await Deno.makeTempDir()
  try {
    const manifestPath = await writeManifest(dir, {
      schemaVersion: 1,
      workspace: "jihuanshe",
      issues: [
        {
          operation: "update",
          identifier: "DATA-1",
          set: { title: "First" },
          base: { title: "Old title" },
        },
        {
          operation: "update",
          identifier: "DATA-2",
          set: { title: "Second" },
          base: { title: "Old title" },
        },
      ],
    })
    const runner = fakeRunner((args) =>
      args[1] === "view"
        ? viewResult({
          identifier: args[2],
          title: args[2] === "DATA-2" ? "Colleague title" : "Old title",
        })
        : undefined
    )
    const outcome = await applyManifest({
      loaded: await loadManifest(manifestPath),
      runner,
    })

    assertEquals(outcome.status, "conflict")
    assertEquals(outcome.items.map((item) => item.status), [
      "unattempted",
      "failed",
    ])
    assertEquals(runner.calls.some((args) => args[1] === "update"), false)

    const continued = await applyManifest({
      loaded: await loadManifest(manifestPath),
      runner,
      continueOnFailure: true,
    })
    assertEquals(continued.status, "conflict")
    assertEquals(continued.items.map((item) => item.status), [
      "applied",
      "failed",
    ])
    assertEquals(
      runner.calls.filter((args) => args[1] === "update").length,
      1,
    )
  } finally {
    await Deno.remove(dir, { recursive: true })
  }
})

Deno.test("batch preflight reports read failure without mutating", async () => {
  const dir = await Deno.makeTempDir()
  try {
    const manifestPath = await writeManifest(dir, {
      schemaVersion: 1,
      workspace: "jihuanshe",
      issues: [
        {
          operation: "update",
          identifier: "DATA-1",
          set: { title: "First" },
          base: { title: "Old title" },
        },
        {
          operation: "update",
          identifier: "DATA-2",
          set: { title: "Second" },
          base: { title: "Old title" },
        },
      ],
    })
    const runner = fakeRunner((args) =>
      args[1] === "view" && args[2] === "DATA-2"
        ? { code: 1, stdout: "", stderr: "✗ issue not found" }
        : undefined
    )
    const outcome = await applyManifest({
      loaded: await loadManifest(manifestPath),
      runner,
    })

    assertEquals(outcome.status, "stopped-on-failure")
    assertEquals(outcome.items.map((item) => item.status), [
      "unattempted",
      "failed",
      "unattempted",
    ])
    assertStringIncludes(outcome.items[1].detail ?? "", "issue not found")
    assertEquals(outcome.summary.failed, 1)
    assertEquals(outcome.summary.unattempted, 2)
    assertEquals(runner.calls.some((args) => args[1] === "update"), false)
  } finally {
    await Deno.remove(dir, { recursive: true })
  }
})

Deno.test("continue mode handles read failures per issue", async () => {
  const dir = await Deno.makeTempDir()
  try {
    const manifestPath = await writeManifest(dir, {
      schemaVersion: 1,
      workspace: "jihuanshe",
      issues: [
        {
          operation: "update",
          identifier: "DATA-1",
          set: { title: "First" },
          base: { title: "Old title" },
        },
        {
          operation: "update",
          identifier: "DATA-2",
          set: { title: "Second" },
          base: { title: "Old title" },
        },
      ],
    })
    const runner = fakeRunner((args) => {
      if (args[1] === "view" && args[2] === "DATA-1") {
        return { code: 1, stdout: "", stderr: "✗ issue not found" }
      }
      if (args[1] === "view" && args[2] === "DATA-2") {
        return viewResult({ identifier: "DATA-2", title: "Old title" })
      }
      return undefined
    })
    const outcome = await applyManifest({
      loaded: await loadManifest(manifestPath),
      runner,
      continueOnFailure: true,
    })

    assertEquals(outcome.status, "completed-with-failures")
    assertEquals(outcome.items.map((item) => item.status), [
      "failed",
      "unattempted",
      "applied",
    ])
    assertEquals(
      runner.calls.filter((args) => args[1] === "view").length,
      3,
    )
    assertEquals(
      runner.calls.filter((args) => args[1] === "update").length,
      1,
    )
  } finally {
    await Deno.remove(dir, { recursive: true })
  }
})

Deno.test("per-issue guard rechecks after a clean batch preflight", async () => {
  const dir = await Deno.makeTempDir()
  try {
    const manifestPath = await writeManifest(dir, {
      schemaVersion: 1,
      workspace: "jihuanshe",
      issues: [{
        operation: "update",
        identifier: "DATA-606",
        set: { title: "New title" },
        base: { title: "Old title" },
      }],
    })
    let viewCalls = 0
    const runner = fakeRunner((args) => {
      if (args[1] !== "view") return undefined
      viewCalls += 1
      return viewResult({
        title: viewCalls === 1 ? "Old title" : "Colleague title",
      })
    })
    const outcome = await applyManifest({
      loaded: await loadManifest(manifestPath),
      runner,
    })

    assertEquals(outcome.status, "conflict")
    assertStringIncludes(outcome.items[0].detail ?? "", "changed remotely")
    assertEquals(runner.calls.some((args) => args[1] === "update"), false)
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
        base: { title: "Old title" },
      },
      {
        operation: "update",
        identifier: "DATA-2",
        set: { title: "Second" },
        base: { title: "Old title" },
      },
    ],
  }
  const failFirstUpdate = () => {
    let updates = 0
    return fakeRunner((args) => {
      if (args[1] === "view") return viewResult({ identifier: args[2] })
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
  // Real round-trip sample (Kadoraba sandbox): Linear compresses table
  // delimiter rows on save.
  assertEquals(
    normalizeMarkdown("| 列 A | 列 B |\n| ---- | ---- |\n| 表格 | 单元格 |"),
    normalizeMarkdown("| 列 A | 列 B |\n| -- | -- |\n| 表格 | 单元格 |"),
  )
  assertEquals(
    normalizeMarkdown("| :--- | ---: |"),
    normalizeMarkdown("| :-- | --: |"),
  )
  // Real round-trip sample: Linear wraps link destinations in angle brackets.
  assertEquals(
    normalizeMarkdown("[evidence.yrp](https://example.com/a)"),
    normalizeMarkdown("[evidence.yrp](<https://example.com/a>)"),
  )
  // Real round-trip samples from the markdown torture issue (ENG-54).
  assertEquals(
    normalizeMarkdown("      - 嵌套无序\n_斜体_ 与 ~~删除线~~\n- [x] 已完成"),
    normalizeMarkdown("      * 嵌套无序\n*斜体* 与 ~~删除线~~\n- [X] 已完成"),
  )
  assertEquals(
    normalizeMarkdown("| :--- | :---: | ---: |"),
    normalizeMarkdown("| -- | -- | -- |"),
  )
  assertEquals(
    normalizeMarkdown("自动链接 https://example.com"),
    normalizeMarkdown("自动链接 [https://example.com](<https://example.com>)"),
  )
  assertEquals(
    normalizeMarkdown("`snake_case_name` stays") ===
      normalizeMarkdown("`snake*case*name` stays"),
    false,
  )
  assertEquals(
    normalizeMarkdown("![img](https://example.com/a)") ===
      normalizeMarkdown("![img](https://example.com/b)"),
    false,
  )
  assertEquals(
    normalizeMarkdown("- one") === normalizeMarkdown("- one changed"),
    false,
  )
  assertEquals(
    normalizeMarkdown("| a | b |") === normalizeMarkdown("| a | c |"),
    false,
  )
})

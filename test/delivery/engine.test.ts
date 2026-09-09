import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert"
import { join } from "@std/path"
import { stub } from "@std/testing/mock"
import {
  type ApplyContext,
  applyManifest,
  planManifest,
} from "../../src/delivery/engine.ts"
import {
  checkpointPath,
  loadCheckpoint,
} from "../../src/delivery/checkpoint.ts"
import {
  type LoadedManifest,
  loadManifest,
} from "../../src/delivery/manifest.ts"
import {
  errorResult,
  ValidationError,
  WriteError,
} from "../../src/utils/errors.ts"
import { formatPlan } from "../../src/commands/issue/issue-plan.ts"
import {
  connection,
  create,
  fixture,
  issue,
  LABEL,
  manifest,
  OTHER_LABEL,
  OTHER_TEAM,
  OTHER_USER,
  STATE,
  update,
  USER,
  WORKSPACE,
} from "./fixture.ts"

const apply = (
  loaded: LoadedManifest,
  options: Partial<Omit<ApplyContext, "loaded">> = {},
) =>
  applyManifest({
    loaded,
    verificationTimeoutMs: 1000,
    verificationDelay: () => Promise.resolve(),
    ...options,
  })

Deno.test("delivery production plan is read-only and CLI apply exposes one machine result", async () => {
  const original = issue()
  const f = await fixture({ issues: [original] })
  try {
    const loaded = await f.load(manifest([update(original)]))
    const plan = await planManifest({ loaded })
    assertEquals(plan.status, "ready")
    assertEquals(plan.issues[0].fields[0].verdict, "write")
    assertEquals(f.mutations().length, 0)
    assertEquals(await loadCheckpoint(f.path), null)
    const cliPlan = await f.cli("plan")
    assertEquals(cliPlan.success, true, cliPlan.stderr)
    assertEquals(cliPlan.json().status, "ready")
    assertEquals(await loadCheckpoint(f.path), null)
    const cliApply = await f.cli("apply")
    assertEquals(cliApply.success, true, cliApply.stdout + cliApply.stderr)
    assertEquals(cliApply.json().ok, true)
    assertEquals(cliApply.json().effect, "applied")
    assertEquals(cliApply.json().data.status, "completed")
    assertEquals(f.mutations().length, 1)
  } finally {
    await f.cleanup()
  }
})

Deno.test("delivery plan summarizes create text and referenced files without duplicate body dumps", async () => {
  const f = await fixture({ issues: [issue(1002)] })
  try {
    await Deno.writeTextFile(
      join(f.dir, "description.md"),
      "Preview body that should stay in its file",
    )
    await Deno.writeTextFile(
      join(f.dir, "comment.md"),
      "Evidence caption that should stay in its file",
    )
    await Deno.writeFile(join(f.dir, "image.png"), new Uint8Array([1, 2, 3]))
    await Deno.writeFile(join(f.dir, "replay.yrp"), new Uint8Array([4, 5, 6]))
    const loaded = await f.load(manifest([{
      operation: "create",
      set: {
        title: "Preview title",
        team: "ENG",
        descriptionFile: "description.md",
        priority: 2,
      },
      comments: [{
        bodyFile: "comment.md",
        files: [{ path: "image.png" }],
        public: true,
      }],
      attachments: [{ kind: "file", path: "replay.yrp", title: "Raw replay" }],
      relations: [{ type: "related", issue: "ENG-1002" }],
    }]))
    const plan = await planManifest({ loaded })
    assertEquals(plan.status, "ready")
    assertEquals(plan.issues[0].fields, [])
    for (const output of [JSON.stringify(plan), formatPlan(plan)]) {
      assertStringIncludes(output, "Preview title")
      assertStringIncludes(output, "description.md")
      assertStringIncludes(output, "comment.md")
      assertEquals(output.includes("Preview body that should"), false)
      assertEquals(output.includes("Evidence caption that should"), false)
    }
    assertEquals(plan.files.length, 4)
    assertEquals(f.mutations().length, 0)
    assertEquals(await loadCheckpoint(f.path), null)
  } finally {
    await f.cleanup()
  }
})

for (
  const when of ["before-plan", "after-plan", "during-resolution"] as const
) {
  Deno.test(`delivery rejects original-value drift ${when} without writing`, async () => {
    const original = issue()
    const f = await fixture({
      issues: [original],
      overrides: (state) =>
        when === "during-resolution"
          ? [{
            queryName: "LookupUserById",
            response: () => {
              state.find(original.id)!.title = "Concurrent title"
              return { data: { users: connection([USER]) } }
            },
          }]
          : [],
    })
    try {
      const loaded = await f.load(
        manifest([
          update(original, {
            title: "Desired title",
            ...(when === "during-resolution" ? { assignee: USER.id } : {}),
          }),
        ]),
      )
      if (when === "before-plan") {
        f.state.find(original.id)!.title = "Concurrent title"
      }
      if (when !== "during-resolution") {
        const plan = await planManifest({ loaded })
        assertEquals(plan.status, when === "before-plan" ? "conflict" : "ready")
      }
      if (when === "after-plan") {
        f.state.find(original.id)!.title = "Concurrent title"
      }
      const result = await apply(loaded)
      assertEquals(result.status, "conflict")
      assertEquals(result.effect, "none")
      assertEquals(f.mutations().length, 0)
    } finally {
      await f.cleanup()
    }
  })
}

Deno.test("delivery guards each Issue immediately before its own mutation", async () => {
  const first = issue(), second = issue(1002)
  const f = await fixture({
    issues: [first, second],
    overrides: (
      state,
    ) => [{
      queryName: "UpdateIssue",
      response: ({ variables }) => {
        const changed = state.patch(
          state.find(variables.id)!,
          variables.input as Record<string, unknown>,
        )
        state.find(second.id)!.title = "Changed while first Issue was updated"
        return { data: { issueUpdate: { success: true, issue: changed } } }
      },
    }],
  })
  try {
    const result = await apply(
      await f.load(manifest([update(first), update(second)])),
    )
    assertEquals(result.status, "conflict")
    assertEquals(result.summary.applied, 1)
    assertEquals(f.mutations().map((request) => request.variables.id), [
      first.id,
    ])
  } finally {
    await f.cleanup()
  }
})

Deno.test("delivery no-op writes nothing and mixed input omits fields already at their desired value", async () => {
  const original = issue()
  const f = await fixture({ issues: [original] })
  try {
    const noop = await apply(
      await f.load(manifest([update(original, { title: original.title })])),
    )
    assertEquals(noop.status, "completed")
    assertEquals(noop.effect, "none")
    assertEquals(f.mutations().length, 0)
    const mixedPath = join(f.dir, "mixed.json")
    await Deno.writeTextFile(
      mixedPath,
      JSON.stringify(
        manifest([update(original, { title: original.title, priority: 1 })]),
      ),
    )
    const result = await apply(await loadManifest(mixedPath))
    assertEquals(result.status, "completed")
    assertEquals(f.mutations()[0].variables.input, { priority: 1 })
  } finally {
    await f.cleanup()
  }
})

Deno.test("delivery extra dependencies still block an already-satisfied target", async () => {
  const original = issue()
  const f = await fixture({
    issues: [
      issue(1001, {
        title: "Desired title",
        description: "Discussion changed",
      }),
    ],
  })
  try {
    const result = await apply(
      await f.load(
        manifest([{ ...update(original), expectFields: ["description"] }]),
      ),
    )
    assertEquals(result.status, "conflict")
    assertEquals(f.mutations().length, 0)
  } finally {
    await f.cleanup()
  }
})

for (
  const [baseText, currentText] of [
    ["https://example.com/_v1_", "https://example.com/*v1*"],
    ["a | b\nc | d", "a | b\n--- | ---\nc | d"],
    ["```ts\nconst x = 1\n```", "```ts\nconst x = 2\n```"],
    ["first  \nsecond", "first\nsecond"],
  ] as const
) {
  Deno.test(`delivery strict Markdown basis rejects changed literal text: ${baseText.slice(0, 24)}`, async () => {
    const original = issue(1001, { description: baseText })
    const f = await fixture({
      issues: [issue(1001, { description: currentText })],
    })
    try {
      const loaded = await f.load(
        manifest([update(original, { description: "Desired" })]),
      )
      assertEquals((await planManifest({ loaded })).status, "conflict")
      assertEquals((await apply(loaded)).status, "conflict")
      assertEquals(f.mutations().length, 0)
    } finally {
      await f.cleanup()
    }
  })
}

Deno.test("delivery preserves explicit null basis and verifies stable reference IDs after renaming", async () => {
  const original = issue(1001, { description: null, assignee: USER })
  const f = await fixture({
    issues: [
      issue(1001, {
        description: null,
        assignee: { ...USER, name: "Renamed", displayName: "renamed" },
      }),
    ],
  })
  try {
    const result = await apply(
      await f.load(
        manifest([
          update(original, { description: "Body", assignee: USER.id }),
        ]),
      ),
    )
    assertEquals(result.status, "completed")
    assertEquals(f.mutations()[0].variables.input, { description: "Body" })
    const checkpoint = (await loadCheckpoint(f.path))!
    assertEquals(
      Object.values(checkpoint.items)[0].expected?.assigneeId,
      USER.id,
    )
  } finally {
    await f.cleanup()
  }
})

Deno.test("delivery does not accept a different assignee UUID with the same display name", async () => {
  const original = issue(1001, { assignee: USER })
  const f = await fixture({ issues: [issue(1001, { assignee: OTHER_USER })] })
  try {
    const result = await apply(
      await f.load(manifest([update(original, { unassign: true })])),
    )
    assertEquals(result.status, "conflict")
    assertEquals(f.mutations().length, 0)
  } finally {
    await f.cleanup()
  }
})

Deno.test("delivery refuses incomplete label sets before any write", async () => {
  const original = issue()
  const f = await fixture({
    issues: [
      issue(1001, {
        labels: {
          nodes: [LABEL],
          pageInfo: { hasNextPage: true, endCursor: null },
        },
      }),
    ],
  })
  try {
    const loaded = await f.load(
      manifest([update(original, { label: ["Feature"] })]),
    )
    assertEquals((await planManifest({ loaded })).status, "failed")
    assertEquals((await apply(loaded)).status, "stopped-on-failure")
    assertEquals(f.mutations().length, 0)
  } finally {
    await f.cleanup()
  }
})

Deno.test("delivery creates once, threads its UUID through comments, attachments and relations, and resumes without replay", async () => {
  const related = issue(1002)
  const f = await fixture({ issues: [related] })
  try {
    const loaded = await f.load(
      manifest([{
        ...create(),
        comments: [{ body: "Evidence" }],
        attachments: [{ kind: "url", url: "https://example.com/proof" }],
        relations: [{ type: "related", issue: related.identifier }],
      }]),
    )
    const result = await apply(loaded)
    assertEquals(result.status, "completed")
    assertEquals(result.summary.applied, 4)
    const created = [...f.state.issues.values()].find((value) =>
      value.id !== related.id
    )!
    assertEquals(result.createdIdentifiers, { "0": created.identifier })
    assertEquals([...f.state.comments.values()][0].issue.id, created.id)
    assertEquals([...f.state.attachments.values()][0].issue.id, created.id)
    assertEquals(f.state.relations[0].issueId, created.id)
    const count = f.mutations().length
    const resumed = await apply(loaded)
    assertEquals(resumed.status, "completed")
    assertEquals(resumed.summary.skipped, 4)
    assertEquals(resumed.createdIdentifiers, result.createdIdentifiers)
    assertEquals(f.mutations().length, count)
    assertEquals(
      Object.hasOwn((await loadCheckpoint(f.path))!, "createdIdentifiers"),
      false,
    )
  } finally {
    await f.cleanup()
  }
})

for (const operation of ["create", "update"] as const) {
  Deno.test(`delivery ${operation} relation conflicts are checked before its field mutation`, async () => {
    const original = issue(), related = issue(1002)
    const f = await fixture({ issues: [original, related] })
    try {
      if (operation === "update") {
        f.state.relations.push({
          id: "existing",
          type: "blocks",
          issueId: original.id,
          relatedIssueId: related.id,
        })
      }
      const relations = operation === "create"
        ? [{ type: "blocks", issue: related.identifier }, {
          type: "related",
          issue: related.identifier,
        }]
        : [{ type: "related", issue: related.identifier }]
      const loaded = await f.load(
        manifest([{
          ...(operation === "create" ? create() : update(original)),
          relations,
        }]),
      )
      assertEquals((await planManifest({ loaded })).status, "failed")
      const result = await apply(loaded)
      assertEquals(result.status, "stopped-on-failure")
      assertEquals(result.effect, "none")
      assertEquals(f.mutations().length, 0)
    } finally {
      await f.cleanup()
    }
  })
}

Deno.test("delivery equivalent and repeated relations keep real receipts without duplicate mutations", async () => {
  const original = issue(), related = issue(1002)
  const f = await fixture({ issues: [original, related] })
  try {
    const loaded = await f.load(
      manifest([{
        operation: "update",
        identifier: original.identifier,
        relations: [{ type: "related", issue: related.identifier }, {
          type: "related",
          issue: related.identifier,
        }],
      }]),
    )
    const result = await apply(loaded)
    assertEquals(result.status, "completed")
    assertEquals(f.mutations().length, 1)
    assertEquals(
      result.items.filter((item) => item.kind === "relation").map((item) =>
        item.receipt
      ),
      [{ kind: "relation", id: "relation-1" }, {
        kind: "relation",
        id: "relation-1",
      }],
    )
    assertEquals((await apply(loaded)).status, "completed")
    assertEquals(f.mutations().length, 1)
  } finally {
    await f.cleanup()
  }
})

Deno.test("delivery preserves partial success and resumes failed work without repeating the created Issue", async () => {
  let blocked = true
  const f = await fixture({
    overrides: () => [{
      queryName: "GetWriteTeamByKey",
      variables: { key: "OPS" },
      response: () =>
        blocked
          ? { errors: [{ message: "Team temporarily unreadable" }] }
          : { data: { teams: connection([OTHER_TEAM]) } },
    }],
  })
  try {
    const loaded = await f.load(
      manifest([create("First"), create("Second", "OPS")]),
    )
    const first = await apply(loaded)
    assertEquals(first.status, "stopped-on-failure")
    assertEquals(first.effect, "applied")
    assertEquals(first.summary.applied, 1)
    assertEquals(first.summary.failed, 1)
    assertEquals(first.summary.unknown, 0)
    blocked = false
    const resumed = await apply(loaded)
    assertEquals(resumed.status, "completed")
    assertEquals(resumed.summary.skipped, 1)
    assertEquals(resumed.summary.applied, 1)
    assertEquals(f.mutations().length, 2)
    assertEquals(
      [...f.state.issues.values()].filter((value) => value.title === "First")
        .length,
      1,
    )
  } finally {
    await f.cleanup()
  }
})

for (const continueOnFailure of [false, true]) {
  Deno.test(`delivery continue=${continueOnFailure} only crosses a proven pre-write failure`, async () => {
    const first = issue(), second = issue(1002), third = issue(1003)
    const f = await fixture({
      issues: [first, second, third],
      overrides: (state) => [{
        queryName: "GetIssueForWrite",
        response: ({ variables }) =>
          state.find(variables.id)?.id === second.id
            ? { errors: [{ message: "Read denied" }] }
            : {
              data: {
                organization: state.organization,
                issue: state.find(variables.id),
              },
            },
      }],
    })
    try {
      const result = await apply(
        await f.load(manifest([update(first), update(second), update(third)])),
        { continueOnFailure },
      )
      assertEquals(
        result.status,
        continueOnFailure ? "completed-with-failures" : "stopped-on-failure",
      )
      assertEquals(result.summary.unknown, 0)
      assertEquals(
        f.mutations().map((request) => request.variables.id),
        continueOnFailure ? [first.id, third.id] : [first.id],
      )
    } finally {
      await f.cleanup()
    }
  })
}

for (
  const mode of [
    "graphql-errors",
    "success-false",
    "missing-payload",
    "missing-id",
    "missing-identifier",
  ] as const
) {
  Deno.test(`delivery ${mode} preserves uncertainty and stops even with continue enabled`, async () => {
    const f = await fixture({
      overrides: (
        state,
      ) => [{
        queryName: "CreateIssue",
        response: ({ variables }) => {
          const created = state.newIssue(
            variables.input as Record<string, unknown>,
          )
          if (mode === "graphql-errors") {
            return {
              data: { issueCreate: { success: true, issue: created } },
              errors: [{ message: "Uncertain fixture response" }],
            }
          }
          if (mode === "success-false") {
            return { data: { issueCreate: { success: false } } }
          }
          if (mode === "missing-payload") return { data: {} }
          return {
            data: {
              issueCreate: {
                success: true,
                issue: mode === "missing-id"
                  ? { identifier: created.identifier }
                  : { id: created.id },
              },
            },
          }
        },
      }],
    })
    try {
      const loaded = await f.load(
        manifest([create("First"), create("Must not execute")]),
      )
      const result = await apply(loaded, { continueOnFailure: true })
      assertEquals(result.status, "stopped-on-unknown")
      assertEquals(result.summary.unknown, 1)
      assertEquals(result.summary.unattempted, 1)
      assertEquals(
        result.effect,
        ["missing-id", "missing-identifier"].includes(mode)
          ? "applied"
          : "unknown",
      )
      assertEquals(f.mutations().length, 1)
      const checkpoint = (await loadCheckpoint(f.path))!
      assertEquals(Object.values(checkpoint.items)[0].status, "unknown")
      if (mode === "graphql-errors") {
        assertStringIncludes(JSON.stringify(checkpoint), "ENG-2001")
      }
      await assertRejects(
        () => apply(loaded, { continueOnFailure: true }),
        ValidationError,
        "unknown",
      )
      assertEquals(f.mutations().length, 1)
    } finally {
      await f.cleanup()
    }
  })
}

Deno.test("delivery saves an in-flight unknown before the server receives a mutation", async () => {
  let path = ""
  let observed = false
  const f = await fixture({
    overrides: (
      state,
    ) => [{
      queryName: "CreateIssue",
      response: async ({ variables }) => {
        const checkpoint = JSON.parse(
          await Deno.readTextFile(checkpointPath(path)),
        )
        assertEquals(
          Object.values(checkpoint.items).map((entry) =>
            (entry as { status: string }).status
          ),
          ["unknown"],
        )
        observed = true
        return {
          data: {
            issueCreate: {
              success: true,
              issue: state.newIssue(variables.input as Record<string, unknown>),
            },
          },
        }
      },
    }],
  })
  path = f.path
  try {
    const result = await apply(await f.load(manifest([create()])))
    assertEquals(result.status, "completed")
    assertEquals(observed, true)
    assertEquals(
      Object.values((await loadCheckpoint(path))!.items)[0].status,
      "completed",
    )
  } finally {
    await f.cleanup()
  }
})

Deno.test("delivery persistence failure after acknowledgement preserves the receipt and blocks replay", async () => {
  const f = await fixture()
  try {
    const loaded = await f.load(manifest([create()]))
    const rename = Deno.rename
    let calls = 0
    const intercept = stub(Deno, "rename", (from, to) => {
      if (++calls === 2) {
        return Promise.reject(
          new Deno.errors.PermissionDenied("Completion checkpoint denied"),
        )
      }
      return rename(from, to)
    })
    let result: unknown
    try {
      result = await apply(loaded)
    } catch (error) {
      result = errorResult(error)
    } finally {
      intercept.restore()
    }
    assertEquals((result as { effect: string }).effect, "applied")
    assertStringIncludes(JSON.stringify(result), "ENG-2001")
    assertEquals(f.mutations().length, 1)
    assertEquals(
      Object.values((await loadCheckpoint(f.path))!.items)[0].status,
      "unknown",
    )
    await assertRejects(() => apply(loaded), ValidationError, "unknown")
    assertEquals(f.mutations().length, 1)
  } finally {
    await f.cleanup()
  }
})

Deno.test("delivery cannot emit a mutation when its initial checkpoint cannot be synced", async () => {
  const f = await fixture()
  try {
    const loaded = await f.load(manifest([create()]))
    const intercept = stub(
      Deno.FsFile.prototype,
      "sync",
      () =>
        Promise.reject(
          new Deno.errors.PermissionDenied("Checkpoint sync denied"),
        ),
    )
    try {
      const error = await assertRejects(() => apply(loaded), WriteError)
      assertEquals(error.effect, "none")
    } finally {
      intercept.restore()
    }
    assertEquals(f.mutations().length, 0)
    assertEquals(await loadCheckpoint(f.path), null)
  } finally {
    await f.cleanup()
  }
})

Deno.test("delivery retains a completed upload when a comment fails before sending and does not upload it again", async () => {
  const original = issue()
  const f = await fixture({ issues: [original] })
  try {
    await Deno.writeFile(join(f.dir, "proof.yrp"), new Uint8Array([1, 2, 3]))
    const loaded = await f.load(
      manifest([{
        operation: "update",
        identifier: original.identifier,
        comments: [{ body: "Evidence", files: [{ path: "proof.yrp" }] }],
      }]),
    )
    const first = await apply(loaded, {
      onProgress: (line) => {
        if (line.startsWith("add comment")) {
          throw new ValidationError("Local comment gate")
        }
      },
    })
    assertEquals(first.status, "stopped-on-failure")
    assertEquals(first.summary.unknown, 0)
    assertEquals(f.server.uploadRequests.length, 1)
    assertEquals(f.state.comments.size, 0)
    const checkpoint = (await loadCheckpoint(f.path))!
    assertEquals(
      Object.values(checkpoint.items).find((entry) =>
        entry.receipt?.kind === "upload"
      )?.status,
      "completed",
    )
    assertEquals(
      JSON.stringify(checkpoint).includes("fixture-upload-secret"),
      false,
    )
    assertEquals(JSON.stringify(checkpoint).includes("uploadUrl"), false)
    const resumed = await apply(loaded)
    assertEquals(resumed.status, "completed")
    assertEquals(f.server.uploadRequests.length, 1)
    assertEquals(f.state.comments.size, 1)
    assertStringIncludes(
      [...f.state.comments.values()][0].body,
      "https://uploads.linear.app/file-1",
    )
  } finally {
    await f.cleanup()
  }
})

Deno.test("delivery upload remains recorded when a sent comment becomes unknown, and resume stays blocked", async () => {
  const original = issue()
  const f = await fixture({
    issues: [original],
    overrides: () => [{
      queryName: "AddComment",
      response: { errors: [{ message: "Comment response uncertain" }] },
    }],
  })
  try {
    await Deno.writeFile(join(f.dir, "proof.yrp"), new Uint8Array([1, 2, 3]))
    const loaded = await f.load(
      manifest([{
        operation: "update",
        identifier: original.identifier,
        comments: [{ body: "Evidence", files: [{ path: "proof.yrp" }] }],
      }]),
    )
    assertEquals((await apply(loaded)).status, "stopped-on-unknown")
    const checkpoint = (await loadCheckpoint(f.path))!
    assertEquals(
      Object.values(checkpoint.items).find((entry) =>
        entry.receipt?.kind === "upload"
      )?.status,
      "completed",
    )
    await assertRejects(() => apply(loaded), ValidationError, "unknown")
    assertEquals(f.server.uploadRequests.length, 1)
  } finally {
    await f.cleanup()
  }
})

Deno.test("delivery resume rechecks pending relation targets before sending a failed comment", async () => {
  const original = issue(), related = issue(1002)
  const f = await fixture({ issues: [original, related] })
  try {
    const loaded = await f.load(
      manifest([{
        operation: "update",
        identifier: original.identifier,
        comments: [{ body: "Do not send until preflight passes" }],
        relations: [{ type: "related", issue: related.identifier }],
      }]),
    )
    assertEquals(
      (await apply(loaded, {
        onProgress: (line) => {
          if (line.startsWith("add comment")) {
            throw new ValidationError("Local comment gate")
          }
        },
      })).status,
      "stopped-on-failure",
    )
    f.state.issues.delete(related.id)
    const resumed = await apply(loaded)
    assertEquals(resumed.status, "stopped-on-failure")
    assertEquals(f.state.comments.size, 0)
    assertEquals(f.mutations().length, 0)
  } finally {
    await f.cleanup()
  }
})

for (const change of ["insert", "remove", "edit"] as const) {
  Deno.test(`delivery resume rejects ${change} of previously completed intent`, async () => {
    const f = await fixture()
    try {
      const value = manifest([create("First"), create("Second")])
      assertEquals((await apply(await f.load(value))).status, "completed")
      const revised = change === "insert"
        ? manifest([create("Inserted"), ...value.issues])
        : change === "remove"
        ? manifest(value.issues.slice(1))
        : manifest([create("Edited"), value.issues[1]])
      const count = f.mutations().length
      const before = await Deno.readTextFile(checkpointPath(f.path))
      await assertRejects(
        async () => await apply(await f.load(revised)),
        ValidationError,
        "completed entries",
      )
      assertEquals(f.mutations().length, count)
      assertEquals(await Deno.readTextFile(checkpointPath(f.path)), before)
    } finally {
      await f.cleanup()
    }
  })
}

Deno.test("delivery resume permits appending new work while keeping completed receipts", async () => {
  const f = await fixture()
  try {
    assertEquals(
      (await apply(await f.load(manifest([create("First")])))).status,
      "completed",
    )
    const resumed = await apply(
      await f.load(manifest([create("First"), create("Second")])),
    )
    assertEquals(resumed.status, "completed")
    assertEquals(resumed.summary.skipped, 1)
    assertEquals(f.mutations().length, 2)
  } finally {
    await f.cleanup()
  }
})

Deno.test("delivery refuses old manifests and old or corrupt ledgers without erasing records", async () => {
  const f = await fixture()
  try {
    const old =
      '{"schemaVersion":1,"createdIdentifiers":{"0":"ENG-7"},"items":{"old":{"status":"applied"}}}'
    await Deno.writeTextFile(checkpointPath(f.path), old)
    await f.write({ ...manifest([create()]), schemaVersion: 1 })
    const cli = await f.cli("apply")
    assertEquals(cli.code, 1)
    assertStringIncludes(cli.stdout, "retired")
    assertEquals(f.server.graphqlRequests.length, 0)
    const loaded = await f.load(manifest([create()]))
    await assertRejects(() => apply(loaded), ValidationError, "v1")
    assertEquals(await Deno.readTextFile(checkpointPath(f.path)), old)
    await Deno.writeTextFile(checkpointPath(f.path), "{")
    await assertRejects(() => apply(loaded), ValidationError, "not valid JSON")
    assertEquals(await Deno.readTextFile(checkpointPath(f.path)), "{")
    assertEquals(f.mutations().length, 0)
  } finally {
    await f.cleanup()
  }
})

Deno.test("delivery validates the entire batch's files before performing an earlier create", async () => {
  const f = await fixture()
  try {
    await f.write(
      manifest([create("Must not run"), {
        operation: "update",
        identifier: issue().identifier,
        comments: [{ body: "Evidence", files: [{ path: "missing.yrp" }] }],
      }]),
    )
    for (const mode of ["plan", "apply"] as const) {
      const result = await f.cli(mode)
      assertEquals(result.code, 1)
      assertStringIncludes(result.stdout, "missing.yrp")
      assertEquals(f.server.graphqlRequests.length, 0)
      assertEquals(f.server.uploadRequests.length, 0)
    }
  } finally {
    await f.cleanup()
  }
})

Deno.test("delivery refuses a changed file before uploading and preserves already-completed field work", async () => {
  const original = issue()
  const f = await fixture({ issues: [original] })
  try {
    const path = join(f.dir, "proof.yrp")
    await Deno.writeFile(path, new Uint8Array([1, 2, 3]))
    const loaded = await f.load(
      manifest([{
        ...update(original),
        comments: [{ body: "Evidence", files: [{ path: "proof.yrp" }] }],
      }]),
    )
    const result = await apply(loaded, {
      onProgress: (line) => {
        if (line.startsWith("upload ")) {
          Deno.writeFileSync(path, new Uint8Array([9, 8, 7]))
        }
      },
    })
    assertEquals(result.status, "stopped-on-failure")
    assertEquals(result.effect, "applied")
    assertEquals(f.mutations().length, 1)
    assertEquals(f.server.uploadRequests.length, 0)
    assertEquals(result.items[0].status, "applied")
  } finally {
    await f.cleanup()
  }
})

Deno.test("delivery rejects mismatched credential workspace and duplicate resolved aliases before mutation", async () => {
  const original = issue()
  const f = await fixture({ issues: [original] })
  try {
    const loaded = await f.load(manifest([update(original)]))
    f.state.organization.urlKey = "another"
    await assertRejects(() => apply(loaded), ValidationError, "do not belong")
    f.state.organization.urlKey = WORKSPACE.urlKey
    f.state.aliases.set("OLD-1001", original.id)
    const aliases = await f.load(manifest([
      {
        operation: "update",
        identifier: original.identifier,
        comments: [{ body: "One" }],
      },
      {
        operation: "update",
        identifier: "OLD-1001",
        comments: [{ body: "Two" }],
      },
    ]))
    await assertRejects(() => apply(aliases), ValidationError, "same Issue")
    assertEquals(f.mutations().length, 0)
    assertEquals(await loadCheckpoint(f.path), null)
  } finally {
    await f.cleanup()
  }
})

for (const mode of ["archived", "trashed", "missing-identifier"] as const) {
  Deno.test(`delivery treats ${mode} target reads as no-effect failures and may continue other Issues`, async () => {
    const original = issue(), other = issue(1002)
    const invalid = issue(
      1001,
      mode === "archived"
        ? { archivedAt: "2026-09-10T00:00:00Z" }
        : mode === "trashed"
        ? { trashed: true }
        : { identifier: "" },
    )
    const f = await fixture({ issues: [invalid, other] })
    try {
      f.state.aliases.set(original.identifier, invalid.id)
      const loaded = await f.load(manifest([
        {
          operation: "update",
          identifier: original.identifier,
          comments: [{ body: "Do not write" }],
        },
        {
          operation: "update",
          identifier: other.identifier,
          comments: [{ body: "Allowed" }],
        },
      ]))
      const result = await apply(loaded, { continueOnFailure: true })
      assertEquals(result.status, "completed-with-failures")
      assertEquals(result.summary.unknown, 0)
      assertEquals(result.items[0].effect, "none")
      assertEquals(f.mutations().length, 1)
      assertEquals([...f.state.comments.values()][0].issue.id, other.id)
    } finally {
      await f.cleanup()
    }
  })
}

Deno.test("delivery never retargets an explicit UUID when an unprotected read returns another object", async () => {
  const original = issue(), other = issue(1002)
  const f = await fixture({
    issues: [original, other],
    overrides: (
      state,
    ) => [{
      queryName: "GetIssueForWrite",
      variables: { id: original.id },
      response: () => ({
        data: { organization: WORKSPACE, issue: state.find(other.id) },
      }),
    }],
  })
  try {
    const loaded = await f.load(
      manifest([{
        operation: "update",
        identifier: original.id,
        set: { title: "Do not retarget" },
        unprotected: true,
      }]),
    )
    const result = await apply(loaded)
    assertEquals(result.effect, "none")
    assertEquals(result.summary.failed, 1)
    assertEquals(f.mutations().length, 0)
  } finally {
    await f.cleanup()
  }
})

Deno.test("delivery keeps state and label identities stable while pruning renamed no-op fields", async () => {
  const original = issue()
  const f = await fixture({
    issues: [
      issue(1001, {
        state: { ...STATE, name: "Renamed state" },
        labels: connection([{ ...LABEL, name: "Renamed label" }]),
      }),
    ],
  })
  try {
    const result = await apply(
      await f.load(
        manifest([
          update(original, { state: STATE.id, label: [LABEL.id], priority: 1 }),
        ]),
      ),
    )
    assertEquals(result.status, "completed")
    assertEquals(f.mutations()[0].variables.input, { priority: 1 })
  } finally {
    await f.cleanup()
  }
})

for (const mode of ["different", "unavailable"] as const) {
  Deno.test(`delivery acknowledged writes remain recorded after ${mode} read-back and are not replayed`, async () => {
    const original = issue()
    let failing = true
    const f = await fixture({
      issues: [original],
      overrides: (
        state,
      ) => [{
        queryName: "GetIssueForWrite",
        response: ({ variables }, history) => {
          const value = state.find(variables.id)
          if (
            failing &&
            history.some((request) =>
              request.query.includes("mutation UpdateIssue")
            )
          ) {
            return mode === "unavailable"
              ? { errors: [{ message: "Read-back denied" }] }
              : {
                data: {
                  organization: WORKSPACE,
                  issue: { ...value, title: "Server formatting differs" },
                },
              }
          }
          return { data: { organization: WORKSPACE, issue: value } }
        },
      }],
    })
    try {
      const loaded = await f.load(manifest([update(original)]))
      const result = await apply(loaded)
      assertEquals(result.status, "applied-unverified")
      assertEquals(result.effect, "applied")
      assertEquals(result.verification[0].status, mode)
      assertEquals(
        Object.values((await loadCheckpoint(f.path))!.items)[0].status,
        "completed",
      )
      const again = await apply(loaded)
      assertEquals(again.status, "applied-unverified")
      assertEquals(again.summary.skipped, 1)
      failing = false
      assertEquals((await apply(loaded)).status, "completed")
      assertEquals(f.mutations().length, 1)
    } finally {
      await f.cleanup()
    }
  })
}

Deno.test("delivery retries delayed visibility reads, never the acknowledged mutation", async () => {
  const original = issue()
  let reads = 0
  const f = await fixture({
    issues: [original],
    overrides: (
      state,
    ) => [{
      queryName: "GetIssueForWrite",
      response: ({ variables }, history) => {
        const written = history.some((request) =>
          request.query.includes("mutation UpdateIssue")
        )
        return {
          data: {
            organization: WORKSPACE,
            issue: written && ++reads < 3 ? original : state.find(variables.id),
          },
        }
      },
    }],
  })
  try {
    const result = await apply(await f.load(manifest([update(original)])))
    assertEquals(result.status, "completed")
    assertEquals(reads, 3)
    assertEquals(f.mutations().length, 1)
  } finally {
    await f.cleanup()
  }
})

Deno.test("delivery read-back deadline cancels only the read and preserves applied state", async () => {
  const original = issue()
  const f = await fixture({
    issues: [original],
    overrides: (
      state,
    ) => [{
      queryName: "GetIssueForWrite",
      response: async ({ variables }, history) => {
        if (
          history.some((request) =>
            request.query.includes("mutation UpdateIssue")
          )
        ) await new Promise((resolve) => setTimeout(resolve, 100))
        return {
          data: { organization: WORKSPACE, issue: state.find(variables.id) },
        }
      },
    }],
  })
  try {
    const result = await apply(await f.load(manifest([update(original)])), {
      verificationTimeoutMs: 20,
    })
    assertEquals(result.status, "applied-unverified")
    assertEquals(result.verification[0].status, "unavailable")
    assertStringIncludes(result.verification[0].detail ?? "", "timed out")
    assertEquals(result.effect, "applied")
    assertEquals(f.mutations().length, 1)
    assertEquals(
      Object.values((await loadCheckpoint(f.path))!.items)[0].status,
      "completed",
    )
    await new Promise((resolve) => setTimeout(resolve, 110))
  } finally {
    await f.cleanup()
  }
})

for (const mode of ["add", "remove"] as const) {
  Deno.test(`delivery verifies native ${mode}Label membership and resume does not reapply the increment`, async () => {
    const original = issue(1001, {
      labels: connection(mode === "add" ? [] : [LABEL]),
    })
    let visible = false
    const f = await fixture({
      issues: [original],
      overrides: (
        state,
      ) => [{
        queryName: "GetIssueForWrite",
        response: ({ variables }, history) => {
          const value = state.find(variables.id)
          if (
            !visible &&
            history.some((request) =>
              request.query.includes("mutation UpdateIssue")
            )
          ) {
            return {
              data: {
                organization: WORKSPACE,
                issue: { ...value, labels: original.labels },
              },
            }
          }
          return { data: { organization: WORKSPACE, issue: value } }
        },
      }],
    })
    try {
      const loaded = await f.load(
        manifest([{
          operation: "update",
          identifier: original.identifier,
          set: mode === "add"
            ? { addLabel: ["Bug"] }
            : { removeLabel: ["Bug"] },
        }]),
      )
      const result = await apply(loaded)
      assertEquals(result.status, "applied-unverified")
      assertEquals(result.verification[0].status, "different")
      const key = mode === "add" ? "addedLabelIds" : "removedLabelIds"
      assertEquals(f.mutations()[0].variables.input, { [key]: [LABEL.id] })
      assertEquals(
        Object.values((await loadCheckpoint(f.path))!.items)[0].expected?.[key],
        [LABEL.id],
      )
      visible = true
      f.state.find(original.id)!.labels.nodes.push(OTHER_LABEL) // Unrelated members do not invalidate an incremental request.
      assertEquals((await apply(loaded)).status, "completed")
      assertEquals(f.mutations().length, 1)
    } finally {
      await f.cleanup()
    }
  })
}

Deno.test("delivery submits captured description and comment bytes without refreshing files after loading", async () => {
  const original = issue()
  const f = await fixture({ issues: [original] })
  try {
    const description = " \nCaptured description\n ",
      body = " \nCaptured comment\n "
    await Deno.writeTextFile(join(f.dir, "description.md"), description)
    await Deno.writeTextFile(join(f.dir, "comment.md"), body)
    const loaded = await f.load(
      manifest([{
        ...update(original, { descriptionFile: "description.md" }),
        comments: [{ bodyFile: "comment.md" }],
      }]),
    )
    await Deno.writeTextFile(join(f.dir, "description.md"), "Changed file")
    await Deno.writeTextFile(join(f.dir, "comment.md"), "Changed file")
    assertEquals((await apply(loaded)).status, "completed")
    assertEquals(f.state.find(original.id)!.description, description)
    assertEquals([...f.state.comments.values()][0].body, body)
  } finally {
    await f.cleanup()
  }
})

Deno.test("delivery verification cannot prove absence of a write racing after the final read", async () => {
  const original = issue()
  let raced = false
  const f = await fixture({
    issues: [original],
    overrides: (
      state,
    ) => [{
      queryName: "UpdateIssue",
      response: ({ variables }) => {
        const target = state.find(variables.id)!
        target.title = "Concurrent edit after the final observed value"
        raced = true
        return {
          data: {
            issueUpdate: {
              success: true,
              issue: state.patch(
                target,
                variables.input as Record<string, unknown>,
              ),
            },
          },
        }
      },
    }],
  })
  try {
    const result = await apply(await f.load(manifest([update(original)])))
    assertEquals(raced, true)
    assertEquals(result.status, "completed")
    assertEquals(result.verification[0].status, "verified")
    assertEquals(f.state.find(original.id)!.title, "Desired title")
    assertEquals(f.mutations().length, 1) // Client observation is not a server CAS.
  } finally {
    await f.cleanup()
  }
})

Deno.test("delivery resume checks that its recorded Issue is still active before pending content", async () => {
  const original = issue()
  const f = await fixture({ issues: [original] })
  try {
    const loaded = await f.load(
      manifest([{
        operation: "update",
        identifier: original.identifier,
        comments: [{ body: "Pending" }],
      }]),
    )
    const first = await apply(loaded, {
      onProgress: (line) => {
        if (line.startsWith("add comment")) {
          throw new ValidationError("Local comment gate")
        }
      },
    })
    assertEquals(first.status, "stopped-on-failure")
    f.state.find(original.id)!.archivedAt = "2026-09-10T00:00:00Z"
    const resumed = await apply(loaded)
    assertEquals(resumed.status, "stopped-on-failure")
    assertEquals(f.mutations().length, 0)
    assertEquals(
      Object.values((await loadCheckpoint(f.path))!.items)[0].status,
      "completed",
    )
  } finally {
    await f.cleanup()
  }
})

for (const kind of ["comment", "attachment", "relation"] as const) {
  Deno.test(`delivery resumed ${kind} receipt verification detects missing objects without replay`, async () => {
    const original = issue(), related = issue(1002)
    const f = await fixture({ issues: [original, related] })
    try {
      const content = kind === "comment"
        ? { comments: [{ body: "Evidence" }] }
        : kind === "attachment"
        ? { attachments: [{ kind: "url", url: "https://example.com/proof" }] }
        : { relations: [{ type: "related", issue: related.identifier }] }
      const loaded = await f.load(
        manifest([{
          operation: "update",
          identifier: original.identifier,
          ...content,
        }]),
      )
      assertEquals((await apply(loaded)).status, "completed")
      if (kind === "comment") f.state.comments.clear()
      else if (kind === "attachment") f.state.attachments.clear()
      else f.state.relations = []
      const resumed = await apply(loaded)
      assertEquals(resumed.status, "applied-unverified")
      assertEquals(resumed.verification[0].status, "different")
      assertEquals(f.mutations().length, 1)
      assertEquals(
        Object.values((await loadCheckpoint(f.path))!.items).every((item) =>
          item.status === "completed"
        ),
        true,
      )
    } finally {
      await f.cleanup()
    }
  })
}

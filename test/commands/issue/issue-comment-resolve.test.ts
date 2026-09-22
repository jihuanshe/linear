import { assertEquals, assertStringIncludes } from "@std/assert"
import {
  commonDenoArgs,
  setupMockLinearServer,
} from "../../utils/test-helpers.ts"

const organization = { id: "workspace-1", urlKey: "test" }
const comment = (id: string, parent: string | null = null) => ({
  id,
  parent: parent == null ? null : { id: parent },
  issue: { id: "issue-1", identifier: "ENG-1" },
  url: `https://linear.app/test/comment/${id}`,
  resolvedAt: null as string | null,
  resolvingCommentId: null as string | null,
  resolvingUser: null,
})

Deno.test("comment add result can resolve the same thread without creating another root", async () => {
  const root = comment("root")
  const reply = { ...comment("new-reply", "root"), body: "Conclusion" }
  const { server, cleanup } = await setupMockLinearServer([
    {
      queryName: "GetIssueId",
      response: { data: { issue: { id: "issue-1" } } },
    },
    {
      queryName: "AddComment",
      response: { data: { commentCreate: { success: true, comment: reply } } },
    },
    {
      queryName: "ReadThreadComment",
      response: ({ variables }) => ({
        data: { organization, comment: variables.id === "root" ? root : reply },
      }),
    },
    {
      queryName: "ResolveComment",
      response: ({ variables }) => {
        root.resolvedAt = "2026-09-22T09:00:00Z"
        root.resolvingCommentId = String(variables.resolvingCommentId)
        return { data: { commentResolve: { success: true, comment: root } } }
      },
    },
  ])
  const run = async (args: string[]) => {
    const result = await new Deno.Command(Deno.execPath(), {
      args: [
        "run",
        ...commonDenoArgs,
        "src/main.ts",
        "issue",
        "comment",
        ...args,
        "--json",
      ],
      stdin: "null",
      stdout: "piped",
      stderr: "piped",
    }).output()
    const stdout = new TextDecoder().decode(result.stdout)
    assertEquals(result.code, 0, stdout)
    assertEquals(new TextDecoder().decode(result.stderr), "")
    return JSON.parse(stdout)
  }
  try {
    const added = await run([
      "add",
      "ENG-1",
      "--parent",
      "root",
      "--body",
      "Conclusion",
    ])
    assertEquals(added.ok, true)
    assertEquals(added.effect, "applied")
    assertEquals(added.data.comment.id, "new-reply")
    assertEquals(added.data.comment.parent.id, "root")
    const resolved = await run([
      "resolve",
      "root",
      "--resolving-comment",
      added.data.comment.id,
    ])
    assertEquals(resolved.ok, true)
    assertEquals(resolved.effect, "applied")
    assertEquals(resolved.data.comment.id, "root")
    assertEquals(resolved.data.comment.resolvingCommentId, "new-reply")
    assertEquals(resolved.data.comment.resolvedAt, "2026-09-22T09:00:00Z")
    const writes = server.graphqlRequests.filter((request) =>
      request.query.includes("mutation ")
    )
    assertEquals(writes.map((request) => request.variables), [
      { input: { issueId: "issue-1", parentId: "root", body: "Conclusion" } },
      { id: "root", resolvingCommentId: "new-reply" },
    ])
  } finally {
    await cleanup()
  }
})

for (const empty of ["", " \n"]) {
  Deno.test(`comment resolution rejects an empty conclusion ID before transport: ${JSON.stringify(empty)}`, async () => {
    const { server, cleanup } = await setupMockLinearServer([])
    try {
      const result = await new Deno.Command(Deno.execPath(), {
        args: [
          "run",
          ...commonDenoArgs,
          "src/main.ts",
          "issue",
          "comment",
          "resolve",
          "root",
          "--resolving-comment",
          empty,
          "--json",
        ],
        stdin: "null",
        stdout: "piped",
        stderr: "piped",
      }).output()
      const output = JSON.parse(new TextDecoder().decode(result.stdout))
      assertEquals(result.code, 1)
      assertEquals(output.ok, false)
      assertEquals(output.effect, "none")
      assertStringIncludes(output.error.message, "Comment ID cannot be empty")
      assertEquals(server.graphqlRequests, [])
    } finally {
      await cleanup()
    }
  })
}

for (
  const scenario of [
    "resolve-root",
    "resolve-reply",
    "unresolve-reply",
    "already-resolved",
    "already-open",
    "wrong-reply",
    "root-as-reply",
    "parent-cycle",
    "wrong-issue",
    "wrong-workspace",
    "unknown-mutation",
    "wrong-receipt",
    "readback-fails",
    "state-mismatch",
    "missing-state",
    "other-resolution",
    "same-resolution",
  ]
) {
  Deno.test(`comment resolution: ${scenario}`, async () => {
    const root = comment("root")
    const comments: Record<string, ReturnType<typeof comment>> = {
      root,
      reply: comment("reply", "root"),
      nested: comment("nested", "reply"),
      other: comment("other"),
    }
    const unresolve = scenario === "unresolve-reply" ||
      scenario === "already-open"
    if (
      unresolve ||
      ["already-resolved", "other-resolution", "same-resolution"].includes(
        scenario,
      )
    ) {
      root.resolvedAt = scenario === "already-open"
        ? null
        : "2026-09-14T01:00:00Z"
      root.resolvingCommentId = "reply"
    }
    if (scenario === "parent-cycle") root.parent = { id: "nested" }
    if (scenario === "wrong-issue") comments.reply.issue.id = "another-issue"
    let mutated = false
    const { server, cleanup } = await setupMockLinearServer([
      {
        queryName: "ReadThreadComment",
        response: ({ variables }) => {
          if (mutated && scenario === "readback-fails") {
            return { errors: [{ message: "read failed" }] }
          }
          const current = { ...comments[String(variables.id)] }
          if (scenario === "missing-state") {
            delete (current as Partial<typeof current>).resolvedAt
          }
          return {
            data: {
              organization:
                scenario === "wrong-workspace" && variables.id === "root"
                  ? { ...organization, id: "other-workspace" }
                  : organization,
              comment: current,
            },
          }
        },
      },
      ...["ResolveComment", "UnresolveComment"].map((queryName) => ({
        queryName,
        response: ({ variables }: { variables: Record<string, unknown> }) => {
          mutated = true
          if (scenario !== "state-mismatch") {
            root.resolvedAt = unresolve ? null : "2026-09-14T02:00:00Z"
            root.resolvingCommentId = unresolve
              ? null
              : String(variables.resolvingCommentId ?? "") || null
          }
          return {
            data: {
              [unresolve ? "commentUnresolve" : "commentResolve"]: {
                success: scenario !== "unknown-mutation",
                comment: {
                  id: scenario === "wrong-receipt" ? "other" : "root",
                },
              },
            },
          }
        },
      })),
    ])
    try {
      const id = [
          "resolve-reply",
          "unresolve-reply",
          "parent-cycle",
          "wrong-issue",
          "wrong-workspace",
        ].includes(scenario)
        ? "nested"
        : "root"
      const resolving = scenario === "wrong-reply"
        ? "other"
        : scenario === "root-as-reply"
        ? "root"
        : scenario === "other-resolution"
        ? "nested"
        : ["resolve-reply", "same-resolution"].includes(scenario)
        ? "reply"
        : undefined
      const result = await new Deno.Command(Deno.execPath(), {
        args: [
          "run",
          ...commonDenoArgs,
          "src/main.ts",
          "issue",
          "comment",
          unresolve ? "unresolve" : "resolve",
          id,
          "--json",
          ...(resolving ? ["--resolving-comment", resolving] : []),
        ],
        stdin: "null",
        stdout: "piped",
        stderr: "piped",
      }).output()
      const output = JSON.parse(new TextDecoder().decode(result.stdout))
      assertEquals(new TextDecoder().decode(result.stderr), "")
      const writes = server.graphqlRequests.filter((request) =>
        request.query.includes("mutation ")
      )
      if (
        ["resolve-root", "resolve-reply", "unresolve-reply"].includes(scenario)
      ) {
        assertEquals(result.code, 0)
        assertEquals(output.effect, "applied")
        assertEquals(output.data.comment.id, "root")
        assertEquals(output.data.comment.resolvedAt != null, !unresolve)
        assertEquals(writes.length, 1)
        assertEquals(writes[0].variables.id, "root")
        if (resolving) {
          assertEquals(writes[0].variables.resolvingCommentId, resolving)
        }
      } else if (
        ["already-resolved", "already-open", "same-resolution"].includes(
          scenario,
        )
      ) {
        assertEquals(result.code, 0)
        assertEquals(output.effect, "none")
        assertEquals(writes.length, 0)
      } else {
        assertEquals(result.code, 1, scenario)
        assertEquals(output.ok, false)
        const applied = ["wrong-receipt", "readback-fails", "state-mismatch"]
          .includes(scenario)
        assertEquals(
          output.effect,
          applied
            ? "applied"
            : scenario === "unknown-mutation"
            ? "unknown"
            : "none",
        )
        assertEquals(
          writes.length,
          applied || scenario === "unknown-mutation" ? 1 : 0,
        )
        if (scenario === "readback-fails") {
          assertStringIncludes(output.error.details.reason, "read failed")
        }
        if (["wrong-reply", "root-as-reply"].includes(scenario)) {
          assertStringIncludes(
            output.error.suggestion,
            "linear issue comment add issue-1 --parent root --body-file conclusion.md --json",
          )
          assertStringIncludes(output.error.suggestion, "data.comment.id")
          assertStringIncludes(output.error.suggestion, "same --workspace")
        }
      }
    } finally {
      await cleanup()
    }
  })
}

for (
  const scenario of [
    "resolve",
    "resolve-reply",
    "unresolve",
    "already-resolved",
    "root-as-resolution",
  ]
) {
  Deno.test(`comment resolution accepts canonical UUID casing: ${scenario}`, async () => {
    const rootId = "abcdefab-1234-4567-89ab-abcdefabcdef"
    const replyId = "fedcbafe-1234-4567-89ab-fedcbafedcba"
    const root = comment(rootId)
    const reply = comment(replyId, rootId)
    const unresolve = scenario === "unresolve"
    if (unresolve || scenario === "already-resolved") {
      root.resolvedAt = "2026-09-14T00:00:00Z"
      root.resolvingCommentId = replyId
    }
    const { server, cleanup } = await setupMockLinearServer([
      {
        queryName: "ReadThreadComment",
        response: ({ variables }) => ({
          data: {
            organization,
            comment: String(variables.id).toLowerCase() === rootId
              ? root
              : reply,
          },
        }),
      },
      ...["ResolveComment", "UnresolveComment"].map((queryName) => ({
        queryName,
        response: ({ variables }: { variables: Record<string, unknown> }) => {
          root.resolvedAt = unresolve ? null : "2026-09-15T00:00:00Z"
          root.resolvingCommentId = unresolve
            ? null
            : String(variables.resolvingCommentId)
          return {
            data: {
              [unresolve ? "commentUnresolve" : "commentResolve"]: {
                success: true,
                comment: { id: rootId },
              },
            },
          }
        },
      })),
    ])
    try {
      const result = await new Deno.Command(Deno.execPath(), {
        args: [
          "run",
          ...commonDenoArgs,
          "src/main.ts",
          "issue",
          "comment",
          unresolve ? "unresolve" : "resolve",
          (scenario === "resolve-reply" || unresolve ? replyId : rootId)
            .toUpperCase(),
          "--json",
          ...(!unresolve
            ? [
              "--resolving-comment",
              (scenario === "root-as-resolution" ? rootId : replyId)
                .toUpperCase(),
            ]
            : []),
        ],
        stdin: "null",
        stdout: "piped",
        stderr: "piped",
      }).output()
      const output = JSON.parse(new TextDecoder().decode(result.stdout))
      const writes = server.graphqlRequests.filter((request) =>
        request.query.includes("mutation ")
      )
      if (scenario === "root-as-resolution") {
        assertEquals(result.code, 1)
        assertEquals(output.effect, "none")
        assertStringIncludes(
          output.error.message,
          "Resolving comment must be a reply",
        )
        assertEquals(writes.length, 0)
      } else {
        assertEquals(result.code, 0, JSON.stringify(output))
        assertEquals(
          output.effect,
          scenario === "already-resolved" ? "none" : "applied",
        )
        assertEquals(writes.length, scenario === "already-resolved" ? 0 : 1)
        if (writes.length) {
          assertEquals(writes[0].variables.id, rootId)
          if (!unresolve) {
            assertEquals(writes[0].variables.resolvingCommentId, replyId)
          }
        }
      }
    } finally {
      await cleanup()
    }
  })
}

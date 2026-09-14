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
      }
    } finally {
      await cleanup()
    }
  })
}

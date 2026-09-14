import { assertEquals, assertStringIncludes } from "@std/assert"
import { issueWriteBasis } from "../../utils/issue-write-fixtures.ts"
import {
  commonDenoArgs,
  setupMockLinearServer,
} from "../../utils/test-helpers.ts"

const comment = (
  id: string,
  parent: string | null,
  resolvedAt: string | null = null,
) => ({
  id,
  parent: parent == null ? null : { id: parent },
  resolvedAt,
  body: `${id} body`,
  createdAt: "2026-09-14T01:00:00Z",
  updatedAt: "2026-09-14T01:00:00Z",
  url: `https://linear.app/test/comment/${id}`,
  user: { displayName: "author" },
  resolvingCommentId: null,
  resolvingUser: null,
  externalUser: null,
})
for (
  const mode of [
    "human",
    "history",
    "json",
    "no-comments",
    "missing-parent",
    "cycle",
    "page-fails",
  ]
) {
  Deno.test(`issue view complete root thread count: ${mode}`, async () => {
    const initial = issueWriteBasis("ENG-123", { id: "team-1", key: "ENG" })
    const first = comment("reply", "root")
    const root = comment("root", mode === "cycle" ? "reply" : null)
    const resolved = comment("resolved", null, "2026-09-14T02:00:00Z")
    const page = mode === "missing-parent" ? [resolved] : [
      root,
      resolved,
      comment("nested", "reply"),
      comment("history-reply", "resolved"),
    ]
    const empty = {
      nodes: [],
      pageInfo: { hasNextPage: false, endCursor: null },
    }
    const { server, cleanup } = await setupMockLinearServer([
      ...["GetIssueDetailsWithComments", "GetIssueDetails"].map((
        queryName,
      ) => ({
        queryName,
        response: {
          data: {
            ...initial,
            issue: {
              ...initial.issue,
              cycle: null,
              attachments: empty,
              children: empty,
              documents: empty,
              relations: empty,
              inverseRelations: empty,
              ...(mode === "no-comments" ? {} : {
                comments: {
                  nodes: [first],
                  pageInfo: { hasNextPage: true, endCursor: "page-1" },
                },
              }),
            },
          },
        },
      })),
      {
        queryName: "GetIssueComments",
        response: mode === "page-fails"
          ? { errors: [{ message: "missing page" }] }
          : {
            data: {
              issue: { comments: { nodes: page, pageInfo: empty.pageInfo } },
            },
          },
      },
    ])
    try {
      const result = await new Deno.Command(Deno.execPath(), {
        args: [
          "run",
          ...commonDenoArgs,
          "src/main.ts",
          "issue",
          "view",
          "ENG-123",
          "--no-download",
          "--no-pager",
          ...(mode === "json"
            ? ["--json"]
            : mode === "history"
            ? ["--show-resolved-threads"]
            : mode === "no-comments"
            ? ["--no-comments"]
            : []),
        ],
        stdin: "null",
        stdout: "piped",
        stderr: "piped",
      }).output()
      const output = new TextDecoder().decode(result.stdout)
      if (["missing-parent", "cycle", "page-fails"].includes(mode)) {
        assertEquals(result.code, 1)
        assertEquals(output, "")
      } else {
        assertEquals(result.code, 0, new TextDecoder().decode(result.stderr))
        if (mode === "json") {
          const data = JSON.parse(output)
          assertEquals(data.issue.comments.nodes, [first, ...page])
          assertEquals(data.issue.comments.pageInfo.hasNextPage, false)
          assertEquals(
            Object.hasOwn(data.issue, "unresolvedThreadCount"),
            false,
          )
        } else if (mode === "no-comments") {
          assertEquals(output.includes("Unresolved threads"), false)
          assertEquals(server.graphqlRequests.length, 1)
        } else {
          assertStringIncludes(output, "**Unresolved threads:** 1")
          assertStringIncludes(output, "nested body")
          assertEquals(
            output.includes("history-reply body"),
            mode === "history",
          )
        }
      }
    } finally {
      await cleanup()
    }
  })
}

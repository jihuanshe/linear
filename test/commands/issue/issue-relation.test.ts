import { snapshotTest } from "@cliffy/testing"
import { assertEquals, assertStringIncludes } from "@std/assert"
import { fromFileUrl } from "@std/path"
import { relationCommand } from "../../../src/commands/issue/issue-relation.ts"
import { stripIgnoredCharacters } from "graphql"
import {
  commonDenoArgs,
  setupMockLinearServer,
} from "../../utils/test-helpers.ts"

const main = fromFileUrl(new URL("../../../src/main.ts", import.meta.url))

for (
  const scenario of [
    "second-page",
    "reverse-related",
    "blocks",
    "blocked-by",
    "duplicate",
    "empty-cursor",
    "repeated-cursor",
    "read-failure",
  ] as const
) {
  Deno.test(`Issue Relation Delete Command - ${scenario}`, async () => {
    const type = scenario === "blocks" || scenario === "blocked-by" ||
        scenario === "duplicate"
      ? scenario
      : "related"
    const source = type === "blocked-by" ? "b" : "a"
    const target = source === "a" ? "b" : "a"
    const fails = scenario === "empty-cursor" ||
      scenario === "repeated-cursor" || scenario === "read-failure"
    const absent = scenario === "blocks" || scenario === "duplicate"
    const firstPageEmpty = scenario === "second-page" ||
      scenario === "reverse-related" || fails || absent
    const edge = {
      id: "edge-id",
      type: type === "blocked-by" ? "blocks" : type,
      relatedIssue: { id: target },
    }
    const page = (
      nodes: typeof edge[],
      hasNextPage = false,
      endCursor: string | null = null,
    ) => ({
      data: {
        issue: { relations: { nodes, pageInfo: { hasNextPage, endCursor } } },
      },
    })
    const { server, cleanup } = await setupMockLinearServer([
      {
        queryName: "GetIssueId",
        variables: { id: "ENG-123" },
        response: { data: { issue: { id: "a" } } },
      },
      {
        queryName: "GetIssueId",
        variables: { id: "ENG-456" },
        response: { data: { issue: { id: "b" } } },
      },
      {
        queryName: "FindIssueRelation",
        variables: { issueId: source, first: 100, after: "page-2" },
        response: scenario === "read-failure"
          ? { errors: [{ message: "Relation inventory unavailable" }] }
          : page([edge], scenario === "repeated-cursor", "page-2"),
      },
      {
        queryName: "FindIssueRelation",
        variables: { issueId: source, first: 100 },
        response: page(
          firstPageEmpty ? [] : [edge],
          scenario === "second-page" || fails,
          scenario === "empty-cursor" ? null : "page-2",
        ),
      },
      {
        queryName: "FindIssueRelation",
        variables: { issueId: target, first: 100 },
        response: page([{ ...edge, relatedIssue: { id: source } }]),
      },
      {
        queryName: "DeleteIssueRelation",
        variables: { id: "edge-id" },
        response: { data: { issueRelationDelete: { success: true } } },
      },
    ])
    try {
      const result = await runRelation(["delete", "ENG-123", type, "ENG-456"])
      assertEquals(result.code, fails || absent ? 1 : 0)
      const mutations = server.graphqlRequests.filter((r) =>
        r.query.includes("mutation ")
      )
      assertEquals(mutations.length, fails || absent ? 0 : 1)
      if (mutations.length) {
        assertEquals(mutations[0].variables, { id: "edge-id" })
      }
      const reads = server.graphqlRequests.filter((r) =>
        r.query.includes("query FindIssueRelation")
      )
      assertEquals(
        reads.map((r) => r.variables.issueId),
        scenario === "reverse-related"
          ? [source, target]
          : scenario === "second-page" || scenario === "repeated-cursor" ||
              scenario === "read-failure"
          ? [source, source]
          : [source],
      )
      assertStringIncludes(
        stripIgnoredCharacters(reads[0].query),
        "relations(first:$first after:$after)",
      )
      assertStringIncludes(
        stripIgnoredCharacters(reads[0].query),
        "pageInfo{hasNextPage endCursor}",
      )
      if (scenario === "empty-cursor" || scenario === "repeated-cursor") {
        assertStringIncludes(result.stderr, "empty or repeated cursor")
      } else if (scenario === "read-failure") {
        assertStringIncludes(result.stderr, "Relation inventory unavailable")
      } else if (absent) {
        assertStringIncludes(result.stderr, "Relation not found")
      }
    } finally {
      await cleanup()
    }
  })
}

async function runRelation(args: string[]) {
  const result = await new Deno.Command(Deno.execPath(), {
    args: ["run", ...commonDenoArgs, main, "issue", "relation", ...args],
    stdout: "piped",
    stderr: "piped",
  }).output()
  const decoder = new TextDecoder()
  return {
    code: result.code,
    stdout: decoder.decode(result.stdout),
    stderr: decoder.decode(result.stderr),
  }
}

// Test help output
await snapshotTest({
  name: "Issue Relation Add Command - Help Text",
  meta: import.meta,
  colors: false,
  args: ["add", "--help"],
  denoArgs: commonDenoArgs,
  async fn() {
    relationCommand.getCommand("add")?.help({ colors: false })
    await relationCommand.parse()
  },
})

// Test: relation add with "blocks" - success message shows original order
await snapshotTest({
  name: "Issue Relation Add Command - blocks",
  meta: import.meta,
  colors: false,
  args: ["add", "ENG-123", "blocks", "ENG-456"],
  denoArgs: commonDenoArgs,
  async fn() {
    const { cleanup } = await setupMockLinearServer([
      {
        queryName: "GetIssueId",
        variables: { id: "ENG-123" },
        response: {
          data: { issue: { id: "issue-id-123" } },
        },
      },
      {
        queryName: "GetIssueId",
        variables: { id: "ENG-456" },
        response: {
          data: { issue: { id: "issue-id-456" } },
        },
      },
      {
        queryName: "GetExistingIssueRelations",
        variables: { issueId: "issue-id-123" },
        response: {
          data: {
            issue: {
              relations: {
                nodes: [],
                pageInfo: { hasNextPage: false },
              },
              inverseRelations: {
                nodes: [],
                pageInfo: { hasNextPage: false },
              },
            },
          },
        },
      },
      {
        queryName: "CreateIssueRelation",
        response: {
          data: {
            issueRelationCreate: {
              success: true,
              issueRelation: { id: "relation-id-1" },
            },
          },
        },
      },
    ])

    try {
      await relationCommand.parse()
    } finally {
      await cleanup()
    }
  },
})

// Test: relation add with "blocked-by" - success message should show original user-specified order
// i.e. "ENG-123 blocked-by ENG-456" NOT "ENG-456 blocked-by ENG-123"
await snapshotTest({
  name: "Issue Relation Add Command - blocked-by shows correct order",
  meta: import.meta,
  colors: false,
  args: ["add", "ENG-123", "blocked-by", "ENG-456"],
  denoArgs: commonDenoArgs,
  async fn() {
    const { cleanup } = await setupMockLinearServer([
      {
        queryName: "GetIssueId",
        variables: { id: "ENG-123" },
        response: {
          data: { issue: { id: "issue-id-123" } },
        },
      },
      {
        queryName: "GetIssueId",
        variables: { id: "ENG-456" },
        response: {
          data: { issue: { id: "issue-id-456" } },
        },
      },
      {
        queryName: "GetExistingIssueRelations",
        variables: { issueId: "issue-id-123" },
        response: {
          data: {
            issue: {
              relations: {
                nodes: [],
                pageInfo: { hasNextPage: false },
              },
              inverseRelations: {
                nodes: [],
                pageInfo: { hasNextPage: false },
              },
            },
          },
        },
      },
      {
        queryName: "CreateIssueRelation",
        response: {
          data: {
            issueRelationCreate: {
              success: true,
              // API is called with swapped IDs (ENG-456 blocks ENG-123),
              // but we should display the user-specified order in the message
              issueRelation: { id: "relation-id-2" },
            },
          },
        },
      },
    ])

    try {
      await relationCommand.parse()
    } finally {
      await cleanup()
    }
  },
})

Deno.test("Issue Relation Add Command - equivalent relation is idempotent", async () => {
  const { cleanup } = await setupMockLinearServer([
    {
      queryName: "GetIssueId",
      variables: { id: "ENG-123" },
      response: { data: { issue: { id: "issue-id-123" } } },
    },
    {
      queryName: "GetIssueId",
      variables: { id: "ENG-456" },
      response: { data: { issue: { id: "issue-id-456" } } },
    },
    {
      queryName: "GetExistingIssueRelations",
      variables: { issueId: "issue-id-123" },
      response: {
        data: {
          issue: {
            relations: {
              nodes: [{
                type: "related",
                relatedIssue: {
                  id: "issue-id-456",
                  identifier: "ENG-456",
                },
              }],
              pageInfo: { hasNextPage: false },
            },
            inverseRelations: {
              nodes: [],
              pageInfo: { hasNextPage: false },
            },
          },
        },
      },
    },
  ])

  try {
    const result = await runRelation([
      "add",
      "ENG-123",
      "related",
      "ENG-456",
    ])
    assertEquals(result.code, 0)
    assertEquals(result.stderr, "")
    assertStringIncludes(
      result.stdout,
      "Relation already exists: ENG-123 related ENG-456",
    )
  } finally {
    await cleanup()
  }
})

Deno.test("Issue Relation Add Command - different relation refuses replacement", async () => {
  const { cleanup } = await setupMockLinearServer([
    {
      queryName: "GetIssueId",
      variables: { id: "ENG-123" },
      response: { data: { issue: { id: "issue-id-123" } } },
    },
    {
      queryName: "GetIssueId",
      variables: { id: "ENG-456" },
      response: { data: { issue: { id: "issue-id-456" } } },
    },
    {
      queryName: "GetExistingIssueRelations",
      variables: { issueId: "issue-id-123" },
      response: {
        data: {
          issue: {
            relations: {
              nodes: [{
                type: "related",
                relatedIssue: {
                  id: "issue-id-456",
                  identifier: "ENG-456",
                },
              }],
              pageInfo: { hasNextPage: false },
            },
            inverseRelations: {
              nodes: [],
              pageInfo: { hasNextPage: false },
            },
          },
        },
      },
    },
  ])

  try {
    const result = await runRelation([
      "add",
      "ENG-123",
      "blocks",
      "ENG-456",
    ])
    assertEquals(result.code, 1)
    assertEquals(result.stdout, "")
    assertStringIncludes(
      result.stderr,
      "Cannot add ENG-123 blocks ENG-456: existing: related ENG-456",
    )
    assertStringIncludes(
      result.stderr,
      "Delete the existing relation explicitly",
    )
  } finally {
    await cleanup()
  }
})

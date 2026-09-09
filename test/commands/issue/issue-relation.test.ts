import { snapshotTest } from "@cliffy/testing"
import { assertEquals, assertStringIncludes } from "@std/assert"
import { fromFileUrl } from "@std/path"
import { relationCommand } from "../../../src/commands/issue/issue-relation.ts"
import {
  commonDenoArgs,
  setupMockLinearServer,
} from "../../utils/test-helpers.ts"

const main = fromFileUrl(new URL("../../../src/main.ts", import.meta.url))

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

import { snapshotTest } from "@cliffy/testing"
import { assertEquals, assertMatch } from "@std/assert"
import { stub } from "@std/testing/mock"
import {
  formatThreadIdLabel,
  viewCommand,
} from "../../../src/commands/issue/issue-view.ts"
import { MockLinearServer } from "../../utils/mock_linear_server.ts"
import { setupMockLinearServer } from "../../utils/test-helpers.ts"

// Common Deno args for permissions
const denoArgs = ["--allow-all", "--quiet"]

// Fields selected by IssueFields that these display cases leave empty.
const emptyIssueFields = {
  archivedAt: null,
  trashed: false,
  priority: 0,
  estimate: null,
  dueDate: null,
  assignee: null,
  project: null,
  projectMilestone: null,
  cycle: null,
  parent: null,
  labels: {
    nodes: [],
    pageInfo: {
      hasNextPage: false,
      endCursor: null,
    },
  },
  children: {
    nodes: [],
  },
  relations: {
    nodes: [],
    pageInfo: {
      hasNextPage: false,
    },
  },
  inverseRelations: {
    nodes: [],
    pageInfo: {
      hasNextPage: false,
    },
  },
  documents: {
    nodes: [],
  },
}

for (const comments of [true, false]) {
  Deno.test(`Issue View Command - JSON includes assignee ID with comments ${comments}`, async () => {
    const assignee = {
      id: "abcdef01-2345-4678-9abc-def012345678",
      name: "Jane Developer",
      displayName: "jane",
    }
    const { server, cleanup } = await setupMockLinearServer([{
      queryName: comments ? "GetIssueDetailsWithComments" : "GetIssueDetails",
      variables: { id: "ENG-123" },
      response: {
        data: {
          organization: {
            id: "99999999-9999-4999-8999-999999999999",
            urlKey: "test-team",
          },
          issue: {
            id: "11111111-1111-4111-8111-000000000123",
            identifier: "ENG-123",
            title: "Assignee identity",
            description: null,
            url: "https://linear.app/test-team/issue/ENG-123",
            branchName: "eng-123",
            archivedAt: null,
            trashed: false,
            priority: 0,
            estimate: null,
            dueDate: null,
            state: {
              id: "33333333-3333-4333-8333-333333333333",
              name: "Todo",
              type: "unstarted",
              color: "#000000",
            },
            assignee,
            project: null,
            projectMilestone: null,
            cycle: null,
            parent: null,
            team: {
              id: "22222222-2222-4222-8222-222222222222",
              key: "ENG",
              activeCycle: null,
            },
            children: { nodes: [] },
            documents: { nodes: [] },
            relations: { nodes: [], pageInfo: { hasNextPage: false } },
            inverseRelations: { nodes: [], pageInfo: { hasNextPage: false } },
            labels: {
              nodes: [],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
            ...(comments
              ? {
                comments: {
                  nodes: [],
                  pageInfo: { hasNextPage: false, endCursor: null },
                },
              }
              : {}),
            attachments: {
              nodes: [],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        },
      },
    }])
    const output: string[] = []
    const logStub = stub(console, "log", (value: string) => output.push(value))
    try {
      await viewCommand.parse([
        "ENG-123",
        "--json",
        ...(comments ? [] : ["--no-comments"]),
      ])
      assertEquals(JSON.parse(output.join("\n")).issue.assignee, assignee)
      assertEquals(JSON.parse(output.join("\n")).organization, {
        id: "99999999-9999-4999-8999-999999999999",
        urlKey: "test-team",
      })
      assertEquals(server.graphqlRequests.length, 1)
      assertMatch(server.graphqlRequests[0].query, /assignee\s*\{\s*id\b/)
    } finally {
      logStub.restore()
      await cleanup()
    }
  })
}

// Test help output
await snapshotTest({
  name: "Issue View Command - Help Text",
  meta: import.meta,
  colors: false,
  args: ["--help"],
  denoArgs,
  async fn() {
    viewCommand.help({ colors: false })
    await viewCommand.parse()
  },
})

// Test with mock GraphQL endpoint - connection refused
// NOTE: This test verifies error handling when the Linear API is unreachable.
// The error output varies by platform (different OS error codes), so we remove it.
// The important behavior (user-friendly error message on stderr) is covered by other "Not Found" tests.

// Test with working mock server - Terminal output (no comments available)
await snapshotTest({
  name: "Issue View Command - With Mock Server Terminal No Comments",
  meta: import.meta,
  colors: false,
  args: ["TEST-123"],
  denoArgs,
  async fn() {
    const server = new MockLinearServer([
      {
        queryName: "GetIssueDetailsWithComments",
        variables: { id: "TEST-123" },
        response: {
          data: {
            organization: {
              id: "99999999-9999-4999-8999-999999999999",
              urlKey: "test-team",
            },
            issue: {
              ...emptyIssueFields,
              id: "11111111-1111-4111-8111-000000000123",
              team: {
                id: "22222222-2222-4222-8222-222222222222",
                key: "TEST",
                activeCycle: null,
              },
              labels: {
                pageInfo: {
                  hasNextPage: false,
                  endCursor: null,
                },
                nodes: [],
              },
              identifier: "TEST-123",
              title: "Fix authentication bug in login flow",
              description:
                "Users are experiencing issues logging in when their session expires. This affects the main authentication flow and needs to be resolved quickly.\n\n## Steps to reproduce\n1. Log in to the application\n2. Wait for session to expire\n3. Try to perform an authenticated action\n4. Observe the error\n\n## Expected behavior\nUser should be redirected to login page with clear messaging.\n\n## Actual behavior\nUser sees cryptic error message and gets stuck.",
              url:
                "https://linear.app/test-team/issue/TEST-123/fix-authentication-bug-in-login-flow",
              branchName: "fix/test-123-auth-bug",
              state: {
                id: "33333333-3333-4333-8333-333333333333",
                type: "started",
                name: "In Progress",
                color: "#f87462",
              },
              comments: {
                pageInfo: {
                  hasNextPage: false,
                  endCursor: null,
                },
                nodes: [],
              },
              attachments: {
                pageInfo: {
                  hasNextPage: false,
                  endCursor: null,
                },
                nodes: [],
              },
            },
          },
        },
      },
    ])

    try {
      await server.start()
      Deno.env.set("LINEAR_GRAPHQL_ENDPOINT", server.getEndpoint())
      Deno.env.set("LINEAR_API_KEY", "Bearer test-token")

      await viewCommand.parse()
    } finally {
      await server.stop()
      Deno.env.delete("LINEAR_GRAPHQL_ENDPOINT")
      Deno.env.delete("LINEAR_API_KEY")
    }
  },
})

// Test with no-comments flag to disable comments
await snapshotTest({
  name: "Issue View Command - With No Comments Flag",
  meta: import.meta,
  colors: false,
  args: ["TEST-123", "--no-comments"],
  denoArgs,
  async fn() {
    const server = new MockLinearServer([
      {
        queryName: "GetIssueDetails",
        variables: { id: "TEST-123" },
        response: {
          data: {
            organization: {
              id: "99999999-9999-4999-8999-999999999999",
              urlKey: "test-team",
            },
            issue: {
              ...emptyIssueFields,
              id: "11111111-1111-4111-8111-000000000123",
              priority: 2,
              assignee: {
                id: "44444444-4444-4444-8444-444444444444",
                name: "jane.smith",
                displayName: "Jane Smith",
              },
              team: {
                id: "22222222-2222-4222-8222-222222222222",
                key: "TEST",
                activeCycle: null,
              },
              labels: {
                pageInfo: {
                  hasNextPage: false,
                  endCursor: null,
                },
                nodes: [],
              },
              identifier: "TEST-123",
              title: "Fix authentication bug in login flow",
              description:
                "Users are experiencing issues logging in when their session expires.",
              url:
                "https://linear.app/test-team/issue/TEST-123/fix-authentication-bug-in-login-flow",
              branchName: "fix/test-123-auth-bug",
              state: {
                id: "33333333-3333-4333-8333-333333333333",
                type: "started",
                name: "In Progress",
                color: "#f87462",
              },
              attachments: {
                pageInfo: {
                  hasNextPage: false,
                  endCursor: null,
                },
                nodes: [],
              },
            },
          },
        },
      },
    ])

    try {
      await server.start()
      Deno.env.set("LINEAR_GRAPHQL_ENDPOINT", server.getEndpoint())
      Deno.env.set("LINEAR_API_KEY", "Bearer test-token")

      await viewCommand.parse()
    } finally {
      await server.stop()
      Deno.env.delete("LINEAR_GRAPHQL_ENDPOINT")
      Deno.env.delete("LINEAR_API_KEY")
    }
  },
})

// Test with comments (default behavior)
await snapshotTest({
  name: "Issue View Command - With Comments Default",
  meta: import.meta,
  colors: false,
  args: ["TEST-123"],
  denoArgs,
  async fn() {
    const server = new MockLinearServer([
      {
        queryName: "GetIssueDetailsWithComments",
        variables: { id: "TEST-123" },
        response: {
          data: {
            organization: {
              id: "99999999-9999-4999-8999-999999999999",
              urlKey: "test-team",
            },
            issue: {
              ...emptyIssueFields,
              id: "11111111-1111-4111-8111-000000000123",
              priority: 1,
              assignee: {
                id: "44444444-4444-4444-8444-444444444444",
                name: "john.doe",
                displayName: "John Doe",
              },
              team: {
                id: "22222222-2222-4222-8222-222222222222",
                key: "TEST",
                activeCycle: null,
              },
              labels: {
                pageInfo: {
                  hasNextPage: false,
                  endCursor: null,
                },
                nodes: [],
              },
              identifier: "TEST-123",
              title: "Fix authentication bug in login flow",
              description:
                "Users are experiencing issues logging in when their session expires.",
              url:
                "https://linear.app/test-team/issue/TEST-123/fix-authentication-bug-in-login-flow",
              branchName: "fix/test-123-auth-bug",
              state: {
                id: "33333333-3333-4333-8333-333333333333",
                type: "started",
                name: "In Progress",
                color: "#f87462",
              },
              comments: {
                pageInfo: {
                  hasNextPage: false,
                  endCursor: null,
                },
                nodes: [
                  {
                    updatedAt: "2024-01-15T10:30:00Z",
                    url: "https://linear.app/issue/TEST-123#comment-1",
                    resolvedAt: null,
                    resolvingCommentId: null,
                    resolvingUser: null,
                    id: "comment-1",
                    body:
                      "I've reproduced this issue on staging. The session timeout seems to be too aggressive.",
                    createdAt: "2024-01-15T10:30:00Z",
                    user: {
                      name: "john.doe",
                      displayName: "John Doe",
                    },
                    externalUser: null,
                    parent: null,
                  },
                  {
                    updatedAt: "2024-01-15T14:22:00Z",
                    url: "https://linear.app/issue/TEST-123#comment-2",
                    resolvedAt: null,
                    resolvingCommentId: null,
                    resolvingUser: null,
                    id: "comment-2",
                    body:
                      "Working on a fix. Will increase the session timeout and add proper error handling.",
                    createdAt: "2024-01-15T14:22:00Z",
                    user: {
                      name: "jane.smith",
                      displayName: "Jane Smith",
                    },
                    externalUser: null,
                    parent: {
                      id: "comment-1",
                    },
                  },
                  {
                    updatedAt: "2024-01-15T15:10:00Z",
                    url: "https://linear.app/issue/TEST-123#comment-3",
                    resolvedAt: null,
                    resolvingCommentId: null,
                    resolvingUser: null,
                    id: "comment-3",
                    body:
                      "Sounds good! Also, we should add better error messaging for expired sessions.",
                    createdAt: "2024-01-15T15:10:00Z",
                    user: {
                      name: "alice.dev",
                      displayName: "Alice Developer",
                    },
                    externalUser: null,
                    parent: {
                      id: "comment-1",
                    },
                  },
                  {
                    updatedAt: "2024-01-15T16:00:00Z",
                    url: "https://linear.app/issue/TEST-123#comment-4",
                    resolvedAt: null,
                    resolvingCommentId: null,
                    resolvingUser: null,
                    id: "comment-4",
                    body:
                      "Should we also consider implementing automatic session refresh?",
                    createdAt: "2024-01-15T16:00:00Z",
                    user: {
                      name: "bob.senior",
                      displayName: "Bob Senior",
                    },
                    externalUser: null,
                    parent: null,
                  },
                ],
              },
              attachments: {
                pageInfo: {
                  hasNextPage: false,
                  endCursor: null,
                },
                nodes: [],
              },
            },
          },
        },
      },
    ])

    try {
      await server.start()
      Deno.env.set("LINEAR_GRAPHQL_ENDPOINT", server.getEndpoint())
      Deno.env.set("LINEAR_API_KEY", "Bearer test-token")

      await viewCommand.parse()
    } finally {
      await server.stop()
      Deno.env.delete("LINEAR_GRAPHQL_ENDPOINT")
      Deno.env.delete("LINEAR_API_KEY")
    }
  },
})

// Test with documents and attachments
await snapshotTest({
  name: "Issue View Command - With Documents And Attachments",
  meta: import.meta,
  colors: false,
  args: ["TEST-246", "--no-comments"],
  denoArgs,
  async fn() {
    const server = new MockLinearServer([
      {
        queryName: "GetIssueDetails",
        queryIncludes: "relations(first: 250)",
        variables: { id: "TEST-246" },
        response: {
          data: {
            organization: {
              id: "99999999-9999-4999-8999-999999999999",
              urlKey: "test-team",
            },
            issue: {
              ...emptyIssueFields,
              id: "11111111-1111-4111-8111-000000000246",
              priority: 2,
              assignee: {
                id: "44444444-4444-4444-8444-444444444444",
                name: "jane.smith",
                displayName: "Jane Smith",
              },
              team: {
                id: "22222222-2222-4222-8222-222222222222",
                key: "TEST",
                activeCycle: null,
              },
              labels: {
                pageInfo: {
                  hasNextPage: false,
                  endCursor: null,
                },
                nodes: [],
              },
              relations: {
                nodes: [
                  {
                    id: "relation-outgoing",
                    type: "blocks",
                    relatedIssue: {
                      identifier: "TEST-247",
                      title: "Blocked follow-up",
                    },
                  },
                ],
                pageInfo: {
                  hasNextPage: false,
                },
              },
              inverseRelations: {
                nodes: [
                  {
                    id: "relation-incoming",
                    type: "related",
                    issue: {
                      identifier: "TEST-245",
                      title: "Related investigation",
                    },
                  },
                ],
                pageInfo: {
                  hasNextPage: false,
                },
              },
              documents: {
                nodes: [
                  {
                    id: "document-1",
                    title: "Implementation plan",
                    slugId: "impl-plan-123",
                    url:
                      "https://linear.app/test-team/document/implementation-plan-impl-plan-123",
                    createdAt: "2024-01-15T09:30:00Z",
                    updatedAt: "2024-01-15T09:45:00Z",
                  },
                  {
                    id: "document-2",
                    title: "QA checklist",
                    slugId: "qa-checklist-456",
                    url:
                      "https://linear.app/test-team/document/qa-checklist-qa-checklist-456",
                    createdAt: "2024-01-15T09:00:00Z",
                    updatedAt: "2024-01-15T09:15:00Z",
                  },
                ],
              },
              identifier: "TEST-246",
              title: "Audit issue resource output",
              description:
                "Ensure issue view shows both attachments and documents.",
              url:
                "https://linear.app/test-team/issue/TEST-246/audit-issue-resource-output",
              branchName: "test-246-issue-resource-output",
              state: {
                id: "33333333-3333-4333-8333-333333333333",
                type: "started",
                name: "In Progress",
                color: "#f87462",
              },
              attachments: {
                pageInfo: {
                  hasNextPage: false,
                  endCursor: null,
                },
                nodes: [
                  {
                    id: "attachment-1",
                    title: "Design mock",
                    url: "https://example.com/design-mock",
                    subtitle: "Figma file",
                    sourceType: "figma",
                    metadata: {},
                    createdAt: "2024-01-15T10:30:00Z",
                  },
                ],
              },
            },
          },
        },
      },
    ])

    try {
      await server.start()
      Deno.env.set("LINEAR_GRAPHQL_ENDPOINT", server.getEndpoint())
      Deno.env.set("LINEAR_API_KEY", "Bearer test-token")

      await viewCommand.parse()
    } finally {
      await server.stop()
      Deno.env.delete("LINEAR_GRAPHQL_ENDPOINT")
      Deno.env.delete("LINEAR_API_KEY")
    }
  },
})

// Test with mock server - Issue not found
await snapshotTest({
  name: "Issue View Command - Issue Not Found",
  meta: import.meta,
  colors: false,
  canFail: true,
  args: ["TEST-999"],
  denoArgs,
  async fn() {
    const server = new MockLinearServer([
      {
        queryName: "GetIssueDetailsWithComments",
        variables: { id: "TEST-999" },
        response: {
          errors: [{
            message: "Issue not found: TEST-999",
            extensions: { code: "NOT_FOUND" },
          }],
        },
      },
    ])

    try {
      await server.start()
      Deno.env.set("LINEAR_GRAPHQL_ENDPOINT", server.getEndpoint())
      Deno.env.set("LINEAR_API_KEY", "Bearer test-token")

      await viewCommand.parse()
    } finally {
      await server.stop()
      Deno.env.delete("LINEAR_GRAPHQL_ENDPOINT")
      Deno.env.delete("LINEAR_API_KEY")
    }
  },
})

// Test JSON output with no comments
await snapshotTest({
  name: "Issue View Command - JSON Output No Comments",
  meta: import.meta,
  colors: false,
  args: ["TEST-123", "--json", "--no-comments"],
  denoArgs,
  async fn() {
    const server = new MockLinearServer([
      {
        queryName: "GetIssueDetails",
        variables: { id: "TEST-123" },
        response: {
          data: {
            organization: {
              id: "99999999-9999-4999-8999-999999999999",
              urlKey: "test-team",
            },
            issue: {
              ...emptyIssueFields,
              id: "11111111-1111-4111-8111-000000000123",
              priority: 3,
              team: {
                id: "22222222-2222-4222-8222-222222222222",
                key: "TEST",
                activeCycle: null,
              },
              labels: {
                pageInfo: {
                  hasNextPage: false,
                  endCursor: null,
                },
                nodes: [],
              },
              identifier: "TEST-123",
              title: "Fix authentication bug in login flow",
              description:
                "Users are experiencing issues logging in when their session expires.",
              url:
                "https://linear.app/test-team/issue/TEST-123/fix-authentication-bug-in-login-flow",
              branchName: "fix/test-123-auth-bug",
              state: {
                id: "33333333-3333-4333-8333-333333333333",
                type: "started",
                name: "In Progress",
                color: "#f87462",
              },
              attachments: {
                pageInfo: {
                  hasNextPage: false,
                  endCursor: null,
                },
                nodes: [],
              },
            },
          },
        },
      },
    ])

    try {
      await server.start()
      Deno.env.set("LINEAR_GRAPHQL_ENDPOINT", server.getEndpoint())
      Deno.env.set("LINEAR_API_KEY", "Bearer test-token")

      await viewCommand.parse()
    } finally {
      await server.stop()
      Deno.env.delete("LINEAR_GRAPHQL_ENDPOINT")
      Deno.env.delete("LINEAR_API_KEY")
    }
  },
})

// Test JSON output with labels
await snapshotTest({
  name: "Issue View Command - JSON Output With Labels",
  meta: import.meta,
  colors: false,
  args: ["TEST-123", "--json", "--no-comments"],
  denoArgs,
  async fn() {
    const server = new MockLinearServer([
      {
        queryName: "GetIssueDetails",
        variables: { id: "TEST-123" },
        response: {
          data: {
            organization: {
              id: "99999999-9999-4999-8999-999999999999",
              urlKey: "test-team",
            },
            issue: {
              ...emptyIssueFields,
              id: "11111111-1111-4111-8111-000000000123",
              team: {
                id: "22222222-2222-4222-8222-222222222222",
                key: "TEST",
                activeCycle: null,
              },
              labels: {
                pageInfo: {
                  hasNextPage: false,
                  endCursor: null,
                },
                nodes: [
                  {
                    id: "label-1",
                    name: "bug",
                    color: "#e5484d",
                  },
                  {
                    id: "label-2",
                    name: "priority:high",
                    color: "#f5a524",
                  },
                ],
              },
              identifier: "TEST-123",
              title: "Fix authentication bug in login flow",
              description:
                "Users are experiencing issues logging in when their session expires.",
              url:
                "https://linear.app/test-team/issue/TEST-123/fix-authentication-bug-in-login-flow",
              branchName: "fix/test-123-auth-bug",
              state: {
                id: "33333333-3333-4333-8333-333333333333",
                type: "started",
                name: "In Progress",
                color: "#f87462",
              },
              attachments: {
                pageInfo: {
                  hasNextPage: false,
                  endCursor: null,
                },
                nodes: [],
              },
            },
          },
        },
      },
    ])

    try {
      await server.start()
      Deno.env.set("LINEAR_GRAPHQL_ENDPOINT", server.getEndpoint())
      Deno.env.set("LINEAR_API_KEY", "Bearer test-token")

      await viewCommand.parse()
    } finally {
      await server.stop()
      Deno.env.delete("LINEAR_GRAPHQL_ENDPOINT")
      Deno.env.delete("LINEAR_API_KEY")
    }
  },
})

// Test JSON output with comments
await snapshotTest({
  name: "Issue View Command - JSON Output With Comments",
  meta: import.meta,
  colors: false,
  args: ["TEST-123", "--json"],
  denoArgs,
  async fn() {
    const server = new MockLinearServer([
      {
        queryName: "GetIssueDetailsWithComments",
        variables: { id: "TEST-123" },
        response: {
          data: {
            organization: {
              id: "99999999-9999-4999-8999-999999999999",
              urlKey: "test-team",
            },
            issue: {
              ...emptyIssueFields,
              id: "11111111-1111-4111-8111-000000000123",
              priority: 2,
              assignee: {
                id: "44444444-4444-4444-8444-444444444444",
                name: "jane.smith",
                displayName: "Jane Smith",
              },
              team: {
                id: "22222222-2222-4222-8222-222222222222",
                key: "TEST",
                activeCycle: null,
              },
              labels: {
                pageInfo: {
                  hasNextPage: false,
                  endCursor: null,
                },
                nodes: [],
              },
              identifier: "TEST-123",
              title: "Fix authentication bug in login flow",
              description:
                "Users are experiencing issues logging in when their session expires.",
              url:
                "https://linear.app/test-team/issue/TEST-123/fix-authentication-bug-in-login-flow",
              branchName: "fix/test-123-auth-bug",
              state: {
                id: "33333333-3333-4333-8333-333333333333",
                type: "started",
                name: "In Progress",
                color: "#f87462",
              },
              comments: {
                pageInfo: {
                  hasNextPage: false,
                  endCursor: null,
                },
                nodes: [
                  {
                    updatedAt: "2024-01-15T10:30:00Z",
                    url: "https://linear.app/issue/TEST-123#comment-1",
                    resolvedAt: null,
                    resolvingCommentId: null,
                    resolvingUser: null,
                    id: "comment-1",
                    body:
                      "I've reproduced this issue on staging. The session timeout seems to be too aggressive.",
                    createdAt: "2024-01-15T10:30:00Z",
                    user: {
                      name: "john.doe",
                      displayName: "John Doe",
                    },
                    externalUser: null,
                    parent: null,
                  },
                  {
                    updatedAt: "2024-01-15T14:22:00Z",
                    url: "https://linear.app/issue/TEST-123#comment-2",
                    resolvedAt: null,
                    resolvingCommentId: null,
                    resolvingUser: null,
                    id: "comment-2",
                    body:
                      "Working on a fix. Will increase the session timeout and add proper error handling.",
                    createdAt: "2024-01-15T14:22:00Z",
                    user: {
                      name: "jane.smith",
                      displayName: "Jane Smith",
                    },
                    externalUser: null,
                    parent: {
                      id: "comment-1",
                    },
                  },
                ],
              },
              attachments: {
                pageInfo: {
                  hasNextPage: false,
                  endCursor: null,
                },
                nodes: [],
              },
            },
          },
        },
      },
    ])

    try {
      await server.start()
      Deno.env.set("LINEAR_GRAPHQL_ENDPOINT", server.getEndpoint())
      Deno.env.set("LINEAR_API_KEY", "Bearer test-token")

      await viewCommand.parse()
    } finally {
      await server.stop()
      Deno.env.delete("LINEAR_GRAPHQL_ENDPOINT")
      Deno.env.delete("LINEAR_API_KEY")
    }
  },
})

// Test JSON output with documents and attachments
await snapshotTest({
  name: "Issue View Command - JSON Output With Documents And Attachments",
  meta: import.meta,
  colors: false,
  args: ["TEST-246", "--json", "--no-comments"],
  denoArgs,
  async fn() {
    const server = new MockLinearServer([
      {
        queryName: "GetIssueDetails",
        queryIncludes: "relations(first: 250)",
        variables: { id: "TEST-246" },
        response: {
          data: {
            organization: {
              id: "99999999-9999-4999-8999-999999999999",
              urlKey: "test-team",
            },
            issue: {
              ...emptyIssueFields,
              id: "11111111-1111-4111-8111-000000000246",
              priority: 2,
              assignee: {
                id: "44444444-4444-4444-8444-444444444444",
                name: "jane.smith",
                displayName: "Jane Smith",
              },
              team: {
                id: "22222222-2222-4222-8222-222222222222",
                key: "TEST",
                activeCycle: null,
              },
              labels: {
                pageInfo: {
                  hasNextPage: false,
                  endCursor: null,
                },
                nodes: [],
              },
              relations: {
                nodes: [
                  {
                    id: "relation-outgoing",
                    type: "blocks",
                    relatedIssue: {
                      identifier: "TEST-247",
                      title: "Blocked follow-up",
                    },
                  },
                ],
                pageInfo: {
                  hasNextPage: false,
                },
              },
              inverseRelations: {
                nodes: [
                  {
                    id: "relation-incoming",
                    type: "related",
                    issue: {
                      identifier: "TEST-245",
                      title: "Related investigation",
                    },
                  },
                ],
                pageInfo: {
                  hasNextPage: false,
                },
              },
              documents: {
                nodes: [
                  {
                    id: "document-1",
                    title: "Implementation plan",
                    slugId: "impl-plan-123",
                    url:
                      "https://linear.app/test-team/document/implementation-plan-impl-plan-123",
                    createdAt: "2024-01-15T09:30:00Z",
                    updatedAt: "2024-01-15T09:45:00Z",
                  },
                  {
                    id: "document-2",
                    title: "QA checklist",
                    slugId: "qa-checklist-456",
                    url:
                      "https://linear.app/test-team/document/qa-checklist-qa-checklist-456",
                    createdAt: "2024-01-15T09:00:00Z",
                    updatedAt: "2024-01-15T09:15:00Z",
                  },
                ],
              },
              identifier: "TEST-246",
              title: "Audit issue resource output",
              description:
                "Ensure issue view shows both attachments and documents.",
              url:
                "https://linear.app/test-team/issue/TEST-246/audit-issue-resource-output",
              branchName: "test-246-issue-resource-output",
              state: {
                id: "33333333-3333-4333-8333-333333333333",
                type: "started",
                name: "In Progress",
                color: "#f87462",
              },
              attachments: {
                pageInfo: {
                  hasNextPage: false,
                  endCursor: null,
                },
                nodes: [
                  {
                    id: "attachment-1",
                    title: "Design mock",
                    url: "https://example.com/design-mock",
                    subtitle: "Figma file",
                    sourceType: "figma",
                    metadata: {},
                    createdAt: "2024-01-15T10:30:00Z",
                  },
                ],
              },
            },
          },
        },
      },
    ])

    try {
      await server.start()
      Deno.env.set("LINEAR_GRAPHQL_ENDPOINT", server.getEndpoint())
      Deno.env.set("LINEAR_API_KEY", "Bearer test-token")

      await viewCommand.parse()
    } finally {
      await server.stop()
      Deno.env.delete("LINEAR_GRAPHQL_ENDPOINT")
      Deno.env.delete("LINEAR_API_KEY")
    }
  },
})

// Test with parent and sub-issues
await snapshotTest({
  name: "Issue View Command - With Parent And Sub-issues",
  meta: import.meta,
  colors: false,
  args: ["TEST-456", "--no-comments"],
  denoArgs,
  async fn() {
    const server = new MockLinearServer([
      {
        queryName: "GetIssueDetails",
        variables: { id: "TEST-456" },
        response: {
          data: {
            organization: {
              id: "99999999-9999-4999-8999-999999999999",
              urlKey: "test-team",
            },
            issue: {
              ...emptyIssueFields,
              id: "11111111-1111-4111-8111-000000000456",
              priority: 2,
              assignee: {
                id: "44444444-4444-4444-8444-444444444444",
                name: "alice.dev",
                displayName: "Alice Developer",
              },
              parent: {
                id: "11111111-1111-4111-8111-000000000100",
                identifier: "TEST-100",
                title: "Epic: Security Improvements",
                state: {
                  name: "In Progress",
                  color: "#f87462",
                },
              },
              team: {
                id: "22222222-2222-4222-8222-222222222222",
                key: "TEST",
                activeCycle: null,
              },
              labels: {
                pageInfo: {
                  hasNextPage: false,
                  endCursor: null,
                },
                nodes: [],
              },
              children: {
                nodes: [
                  {
                    identifier: "TEST-457",
                    title: "Add login form",
                    state: {
                      name: "Done",
                      color: "#4cb782",
                    },
                  },
                  {
                    identifier: "TEST-458",
                    title: "Add password reset flow",
                    state: {
                      name: "Todo",
                      color: "#bec2c8",
                    },
                  },
                  {
                    identifier: "TEST-459",
                    title: "Add OAuth support",
                    state: {
                      name: "In Progress",
                      color: "#f87462",
                    },
                  },
                ],
              },
              identifier: "TEST-456",
              title: "Implement user authentication",
              description: "Add user authentication to the application.",
              url:
                "https://linear.app/test-team/issue/TEST-456/implement-user-authentication",
              branchName: "feat/test-456-auth",
              state: {
                id: "33333333-3333-4333-8333-333333333333",
                type: "started",
                name: "In Progress",
                color: "#f87462",
              },
              attachments: {
                pageInfo: {
                  hasNextPage: false,
                  endCursor: null,
                },
                nodes: [],
              },
            },
          },
        },
      },
    ])

    try {
      await server.start()
      Deno.env.set("LINEAR_GRAPHQL_ENDPOINT", server.getEndpoint())
      Deno.env.set("LINEAR_API_KEY", "Bearer test-token")

      await viewCommand.parse()
    } finally {
      await server.stop()
      Deno.env.delete("LINEAR_GRAPHQL_ENDPOINT")
      Deno.env.delete("LINEAR_API_KEY")
    }
  },
})

// Test with project and milestone
await snapshotTest({
  name: "Issue View Command - With Project And Milestone",
  meta: import.meta,
  colors: false,
  args: ["TEST-789", "--no-comments"],
  denoArgs,
  async fn() {
    const server = new MockLinearServer([
      {
        queryName: "GetIssueDetails",
        variables: { id: "TEST-789" },
        response: {
          data: {
            organization: {
              id: "99999999-9999-4999-8999-999999999999",
              urlKey: "test-team",
            },
            issue: {
              ...emptyIssueFields,
              id: "11111111-1111-4111-8111-000000000789",
              priority: 3,
              assignee: {
                id: "44444444-4444-4444-8444-444444444444",
                name: "bob.senior",
                displayName: "Bob Senior",
              },
              project: {
                id: "55555555-5555-4555-8555-555555555555",
                slugId: "project-slug",
                name: "Platform Infrastructure Q1",
              },
              projectMilestone: {
                id: "66666666-6666-4666-8666-666666666666",
                name: "Phase 2: Observability",
              },
              team: {
                id: "22222222-2222-4222-8222-222222222222",
                key: "TEST",
                activeCycle: null,
              },
              labels: {
                pageInfo: {
                  hasNextPage: false,
                  endCursor: null,
                },
                nodes: [],
              },
              identifier: "TEST-789",
              title: "Add monitoring dashboards",
              description: "Set up Datadog dashboards for the new service.",
              url:
                "https://linear.app/test-team/issue/TEST-789/add-monitoring-dashboards",
              branchName: "feat/test-789-monitoring",
              state: {
                id: "33333333-3333-4333-8333-333333333333",
                type: "started",
                name: "In Progress",
                color: "#f87462",
              },
              attachments: {
                pageInfo: {
                  hasNextPage: false,
                  endCursor: null,
                },
                nodes: [],
              },
            },
          },
        },
      },
    ])

    try {
      await server.start()
      Deno.env.set("LINEAR_GRAPHQL_ENDPOINT", server.getEndpoint())
      Deno.env.set("LINEAR_API_KEY", "Bearer test-token")

      await viewCommand.parse()
    } finally {
      await server.stop()
      Deno.env.delete("LINEAR_GRAPHQL_ENDPOINT")
      Deno.env.delete("LINEAR_API_KEY")
    }
  },
})

// Test with cycle
await snapshotTest({
  name: "Issue View Command - With Cycle",
  meta: import.meta,
  colors: false,
  args: ["TEST-890", "--no-comments"],
  denoArgs,
  async fn() {
    const server = new MockLinearServer([
      {
        queryName: "GetIssueDetails",
        variables: { id: "TEST-890" },
        response: {
          data: {
            organization: {
              id: "99999999-9999-4999-8999-999999999999",
              urlKey: "test-team",
            },
            issue: {
              ...emptyIssueFields,
              id: "11111111-1111-4111-8111-000000000890",
              priority: 4,
              project: {
                id: "55555555-5555-4555-8555-555555555555",
                slugId: "project-slug",
                name: "API Gateway v2",
              },
              cycle: {
                id: "cycle-7",
                name: "Sprint 7",
                number: 7,
                isActive: true,
                isNext: false,
                isPrevious: false,
                isFuture: false,
                isPast: false,
              },
              team: {
                id: "22222222-2222-4222-8222-222222222222",
                key: "TEST",
                activeCycle: {
                  number: 7,
                },
              },
              labels: {
                pageInfo: {
                  hasNextPage: false,
                  endCursor: null,
                },
                nodes: [],
              },
              identifier: "TEST-890",
              title: "Implement rate limiting",
              description: "Add rate limiting to the API gateway.",
              url:
                "https://linear.app/test-team/issue/TEST-890/implement-rate-limiting",
              branchName: "feat/test-890-rate-limiting",
              state: {
                id: "33333333-3333-4333-8333-333333333333",
                type: "unstarted",
                name: "Todo",
                color: "#e2e2e2",
              },
              attachments: {
                pageInfo: {
                  hasNextPage: false,
                  endCursor: null,
                },
                nodes: [],
              },
            },
          },
        },
      },
    ])

    try {
      await server.start()
      Deno.env.set("LINEAR_GRAPHQL_ENDPOINT", server.getEndpoint())
      Deno.env.set("LINEAR_API_KEY", "Bearer test-token")

      await viewCommand.parse()
    } finally {
      await server.stop()
      Deno.env.delete("LINEAR_GRAPHQL_ENDPOINT")
      Deno.env.delete("LINEAR_API_KEY")
    }
  },
})

await snapshotTest({
  name: "Issue View Command - With Upcoming Cycle And No Active Cycle",
  meta: import.meta,
  colors: false,
  args: ["TEST-891", "--no-comments"],
  denoArgs,
  async fn() {
    const server = new MockLinearServer([
      {
        queryName: "GetIssueDetails",
        variables: { id: "TEST-891" },
        response: {
          data: {
            organization: {
              id: "99999999-9999-4999-8999-999999999999",
              urlKey: "test-team",
            },
            issue: {
              ...emptyIssueFields,
              id: "11111111-1111-4111-8111-000000000891",
              priority: 4,
              cycle: {
                id: "cycle-8",
                name: null,
                number: 8,
                isActive: false,
                isNext: true,
                isPrevious: false,
                isFuture: true,
                isPast: false,
              },
              team: {
                id: "22222222-2222-4222-8222-222222222222",
                key: "TEST",
                activeCycle: null,
              },
              labels: {
                pageInfo: {
                  hasNextPage: false,
                  endCursor: null,
                },
                nodes: [],
              },
              identifier: "TEST-891",
              title: "Tune rate limit thresholds",
              description: "Follow-up tuning work.",
              url:
                "https://linear.app/test-team/issue/TEST-891/tune-rate-limit-thresholds",
              branchName: "feat/test-891-tune-thresholds",
              state: {
                id: "33333333-3333-4333-8333-333333333333",
                type: "unstarted",
                name: "Todo",
                color: "#e2e2e2",
              },
              attachments: {
                pageInfo: {
                  hasNextPage: false,
                  endCursor: null,
                },
                nodes: [],
              },
            },
          },
        },
      },
    ])

    try {
      await server.start()
      Deno.env.set("LINEAR_GRAPHQL_ENDPOINT", server.getEndpoint())
      Deno.env.set("LINEAR_API_KEY", "Bearer test-token")

      await viewCommand.parse()
    } finally {
      await server.stop()
      Deno.env.delete("LINEAR_GRAPHQL_ENDPOINT")
      Deno.env.delete("LINEAR_API_KEY")
    }
  },
})

await snapshotTest({
  name: "Issue View Command - Hides Resolved Threads By Default",
  meta: import.meta,
  colors: false,
  args: ["TEST-321"],
  denoArgs,
  async fn() {
    const server = new MockLinearServer([
      {
        queryName: "GetIssueDetailsWithComments",
        variables: { id: "TEST-321" },
        response: {
          data: {
            organization: {
              id: "99999999-9999-4999-8999-999999999999",
              urlKey: "test-team",
            },
            issue: {
              ...emptyIssueFields,
              id: "11111111-1111-4111-8111-000000000321",
              priority: 2,
              team: {
                id: "22222222-2222-4222-8222-222222222222",
                key: "TEST",
                activeCycle: null,
              },
              labels: {
                pageInfo: {
                  hasNextPage: false,
                  endCursor: null,
                },
                nodes: [],
              },
              identifier: "TEST-321",
              title: "Audit resolved comment thread output",
              description:
                "Check how issue view handles resolved comment threads.",
              url:
                "https://linear.app/test-team/issue/TEST-321/audit-resolved-comment-thread-output",
              branchName: "test-321-resolved-thread-output",
              state: {
                id: "33333333-3333-4333-8333-333333333333",
                type: "started",
                name: "In Progress",
                color: "#f87462",
              },
              comments: {
                pageInfo: {
                  hasNextPage: false,
                  endCursor: null,
                },
                nodes: [
                  {
                    updatedAt: "2024-01-15T10:30:00Z",
                    url: "https://linear.app/issue/TEST-321#comment-root-open",
                    resolvedAt: null,
                    resolvingCommentId: null,
                    resolvingUser: null,
                    id: "comment-root-open",
                    body: "Open thread root comment.",
                    createdAt: "2024-01-15T10:30:00Z",
                    user: {
                      name: "john.doe",
                      displayName: "John Doe",
                    },
                    externalUser: null,
                    parent: null,
                  },
                  {
                    updatedAt: "2024-01-15T11:00:00Z",
                    url: "https://linear.app/issue/TEST-321#comment-reply-open",
                    resolvedAt: null,
                    resolvingCommentId: null,
                    resolvingUser: null,
                    id: "comment-reply-open",
                    body: "Reply on the open thread.",
                    createdAt: "2024-01-15T11:00:00Z",
                    user: {
                      name: "jane.smith",
                      displayName: "Jane Smith",
                    },
                    externalUser: null,
                    parent: {
                      id: "comment-root-open",
                    },
                  },
                  {
                    updatedAt: "2024-01-15T12:00:00Z",
                    url:
                      "https://linear.app/issue/TEST-321#comment-root-resolved",
                    resolvedAt: "2024-01-15T12:30:00Z",
                    resolvingCommentId: null,
                    resolvingUser: {
                      name: "alice.dev",
                      displayName: "Alice Developer",
                    },
                    id: "comment-root-resolved",
                    body: "Resolved thread root comment.",
                    createdAt: "2024-01-15T12:00:00Z",
                    user: {
                      name: "alice.dev",
                      displayName: "Alice Developer",
                    },
                    externalUser: null,
                    parent: null,
                  },
                ],
              },
              attachments: {
                pageInfo: {
                  hasNextPage: false,
                  endCursor: null,
                },
                nodes: [],
              },
            },
          },
        },
      },
    ])

    try {
      await server.start()
      Deno.env.set("LINEAR_GRAPHQL_ENDPOINT", server.getEndpoint())
      Deno.env.set("LINEAR_API_KEY", "Bearer test-token")

      await viewCommand.parse()
    } finally {
      await server.stop()
      Deno.env.delete("LINEAR_GRAPHQL_ENDPOINT")
      Deno.env.delete("LINEAR_API_KEY")
    }
  },
})

await snapshotTest({
  name: "Issue View Command - Show Resolved Threads",
  meta: import.meta,
  colors: false,
  args: ["TEST-321", "--show-resolved-threads"],
  denoArgs,
  async fn() {
    const server = new MockLinearServer([
      {
        queryName: "GetIssueDetailsWithComments",
        variables: { id: "TEST-321" },
        response: {
          data: {
            organization: {
              id: "99999999-9999-4999-8999-999999999999",
              urlKey: "test-team",
            },
            issue: {
              ...emptyIssueFields,
              id: "11111111-1111-4111-8111-000000000321",
              priority: 2,
              team: {
                id: "22222222-2222-4222-8222-222222222222",
                key: "TEST",
                activeCycle: null,
              },
              labels: {
                pageInfo: {
                  hasNextPage: false,
                  endCursor: null,
                },
                nodes: [],
              },
              identifier: "TEST-321",
              title: "Audit resolved comment thread output",
              description:
                "Check how issue view handles resolved comment threads.",
              url:
                "https://linear.app/test-team/issue/TEST-321/audit-resolved-comment-thread-output",
              branchName: "test-321-resolved-thread-output",
              state: {
                id: "33333333-3333-4333-8333-333333333333",
                type: "started",
                name: "In Progress",
                color: "#f87462",
              },
              comments: {
                pageInfo: {
                  hasNextPage: false,
                  endCursor: null,
                },
                nodes: [
                  {
                    updatedAt: "2024-01-15T10:30:00Z",
                    url: "https://linear.app/issue/TEST-321#comment-root-open",
                    resolvedAt: null,
                    resolvingCommentId: null,
                    resolvingUser: null,
                    id: "comment-root-open",
                    body: "Open thread root comment.",
                    createdAt: "2024-01-15T10:30:00Z",
                    user: {
                      name: "john.doe",
                      displayName: "John Doe",
                    },
                    externalUser: null,
                    parent: null,
                  },
                  {
                    updatedAt: "2024-01-15T11:00:00Z",
                    url: "https://linear.app/issue/TEST-321#comment-reply-open",
                    resolvedAt: null,
                    resolvingCommentId: null,
                    resolvingUser: null,
                    id: "comment-reply-open",
                    body: "Reply on the open thread.",
                    createdAt: "2024-01-15T11:00:00Z",
                    user: {
                      name: "jane.smith",
                      displayName: "Jane Smith",
                    },
                    externalUser: null,
                    parent: {
                      id: "comment-root-open",
                    },
                  },
                  {
                    updatedAt: "2024-01-15T12:00:00Z",
                    url:
                      "https://linear.app/issue/TEST-321#comment-root-resolved",
                    resolvedAt: "2024-01-15T12:30:00Z",
                    resolvingCommentId: null,
                    resolvingUser: {
                      name: "alice.dev",
                      displayName: "Alice Developer",
                    },
                    id: "comment-root-resolved",
                    body: "Resolved thread root comment.",
                    createdAt: "2024-01-15T12:00:00Z",
                    user: {
                      name: "alice.dev",
                      displayName: "Alice Developer",
                    },
                    externalUser: null,
                    parent: null,
                  },
                ],
              },
              attachments: {
                pageInfo: {
                  hasNextPage: false,
                  endCursor: null,
                },
                nodes: [],
              },
            },
          },
        },
      },
    ])

    try {
      await server.start()
      Deno.env.set("LINEAR_GRAPHQL_ENDPOINT", server.getEndpoint())
      Deno.env.set("LINEAR_API_KEY", "Bearer test-token")

      await viewCommand.parse()
    } finally {
      await server.stop()
      Deno.env.delete("LINEAR_GRAPHQL_ENDPOINT")
      Deno.env.delete("LINEAR_API_KEY")
    }
  },
})

Deno.test("formatThreadIdLabel - keeps thread id visible without hyperlinks", () => {
  assertEquals(
    formatThreadIdLabel(
      "comment-root-open",
      "https://linear.app/issue/TEST-321#comment-root-open",
      false,
    ),
    "[thread: comment-root-open]",
  )
})

Deno.test("formatThreadIdLabel - wraps thread id in OSC-8 hyperlink", () => {
  assertEquals(
    formatThreadIdLabel(
      "comment-root-open",
      "https://linear.app/issue/TEST-321#comment-root-open",
      true,
    ),
    "\x1b]8;;https://linear.app/issue/TEST-321#comment-root-open\x1b\\[thread: comment-root-open]\x1b]8;;\x1b\\",
  )
})

await snapshotTest({
  name: "Issue View Command - JSON Output With Resolved Thread Metadata",
  meta: import.meta,
  colors: false,
  args: ["TEST-654", "--json"],
  denoArgs,
  async fn() {
    const server = new MockLinearServer([
      {
        queryName: "GetIssueDetailsWithComments",
        variables: { id: "TEST-654" },
        response: {
          data: {
            organization: {
              id: "99999999-9999-4999-8999-999999999999",
              urlKey: "test-team",
            },
            issue: {
              ...emptyIssueFields,
              id: "11111111-1111-4111-8111-000000000654",
              team: {
                id: "22222222-2222-4222-8222-222222222222",
                key: "TEST",
                activeCycle: null,
              },
              labels: {
                pageInfo: {
                  hasNextPage: false,
                  endCursor: null,
                },
                nodes: [],
              },
              identifier: "TEST-654",
              title: "Expose resolved thread metadata",
              description: "Test JSON output for resolved thread data.",
              url:
                "https://linear.app/test-team/issue/TEST-654/expose-resolved-thread-metadata",
              branchName: "test-654-resolved-thread-json",
              state: {
                id: "33333333-3333-4333-8333-333333333333",
                type: "backlog",
                name: "Backlog",
                color: "#bec2c8",
              },
              comments: {
                pageInfo: {
                  hasNextPage: false,
                  endCursor: null,
                },
                nodes: [
                  {
                    updatedAt: "2024-01-15T10:30:00Z",
                    url: "https://linear.app/issue/TEST-654#comment-root-json",
                    resolvedAt: "2024-01-15T11:00:00Z",
                    resolvingCommentId: null,
                    resolvingUser: {
                      name: "john.doe",
                      displayName: "John Doe",
                    },
                    id: "comment-root-json",
                    body: "Resolved root comment.",
                    createdAt: "2024-01-15T10:30:00Z",
                    user: {
                      name: "john.doe",
                      displayName: "John Doe",
                    },
                    externalUser: null,
                    parent: null,
                  },
                  {
                    updatedAt: "2024-01-15T10:45:00Z",
                    url: "https://linear.app/issue/TEST-654#comment-reply-json",
                    resolvedAt: null,
                    resolvingCommentId: null,
                    resolvingUser: null,
                    id: "comment-reply-json",
                    body: "Reply under the resolved thread.",
                    createdAt: "2024-01-15T10:45:00Z",
                    user: {
                      name: "jane.smith",
                      displayName: "Jane Smith",
                    },
                    externalUser: null,
                    parent: {
                      id: "comment-root-json",
                    },
                  },
                ],
              },
              attachments: {
                pageInfo: {
                  hasNextPage: false,
                  endCursor: null,
                },
                nodes: [],
              },
            },
          },
        },
      },
    ])

    try {
      await server.start()
      Deno.env.set("LINEAR_GRAPHQL_ENDPOINT", server.getEndpoint())
      Deno.env.set("LINEAR_API_KEY", "Bearer test-token")

      await viewCommand.parse()
    } finally {
      await server.stop()
      Deno.env.delete("LINEAR_GRAPHQL_ENDPOINT")
      Deno.env.delete("LINEAR_API_KEY")
    }
  },
})

// Labels must also surface via the with-comments query path (GetIssueDetailsWithComments),
// not only the --no-comments path. Complements the existing "JSON Output With Labels"
// (which exercises GetIssueDetails) so both fetchIssueDetailsRaw code paths are covered.
await snapshotTest({
  name: "Issue View Command - JSON Output With Labels And Comments",
  meta: import.meta,
  colors: false,
  args: ["TEST-123", "--json"],
  denoArgs,
  async fn() {
    const server = new MockLinearServer([
      {
        queryName: "GetIssueDetailsWithComments",
        variables: { id: "TEST-123" },
        response: {
          data: {
            organization: {
              id: "99999999-9999-4999-8999-999999999999",
              urlKey: "test-team",
            },
            issue: {
              ...emptyIssueFields,
              id: "11111111-1111-4111-8111-000000000123",
              priority: 2,
              assignee: {
                id: "44444444-4444-4444-8444-444444444444",
                name: "jane.smith",
                displayName: "Jane Smith",
              },
              team: {
                id: "22222222-2222-4222-8222-222222222222",
                key: "TEST",
                activeCycle: null,
              },
              labels: {
                pageInfo: {
                  hasNextPage: false,
                  endCursor: null,
                },
                nodes: [
                  {
                    id: "label-1",
                    name: "bug",
                    color: "#e5484d",
                  },
                  {
                    id: "label-2",
                    name: "priority:high",
                    color: "#f5a524",
                  },
                ],
              },
              identifier: "TEST-123",
              title: "Fix authentication bug in login flow",
              description:
                "Users are experiencing issues logging in when their session expires.",
              url:
                "https://linear.app/test-team/issue/TEST-123/fix-authentication-bug-in-login-flow",
              branchName: "fix/test-123-auth-bug",
              state: {
                id: "33333333-3333-4333-8333-333333333333",
                type: "started",
                name: "In Progress",
                color: "#f87462",
              },
              comments: {
                pageInfo: {
                  hasNextPage: false,
                  endCursor: null,
                },
                nodes: [
                  {
                    updatedAt: "2024-01-15T10:30:00Z",
                    url: "https://linear.app/issue/TEST-123#comment-1",
                    resolvedAt: null,
                    resolvingCommentId: null,
                    resolvingUser: null,
                    id: "comment-1",
                    body: "Reproduced on staging.",
                    createdAt: "2024-01-15T10:30:00Z",
                    user: {
                      name: "john.doe",
                      displayName: "John Doe",
                    },
                    externalUser: null,
                    parent: null,
                  },
                ],
              },
              attachments: {
                pageInfo: {
                  hasNextPage: false,
                  endCursor: null,
                },
                nodes: [],
              },
            },
          },
        },
      },
    ])

    try {
      await server.start()
      Deno.env.set("LINEAR_GRAPHQL_ENDPOINT", server.getEndpoint())
      Deno.env.set("LINEAR_API_KEY", "Bearer test-token")

      await viewCommand.parse()
    } finally {
      await server.stop()
      Deno.env.delete("LINEAR_GRAPHQL_ENDPOINT")
      Deno.env.delete("LINEAR_API_KEY")
    }
  },
})

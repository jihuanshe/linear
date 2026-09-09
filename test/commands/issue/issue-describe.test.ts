import { snapshotTest } from "@cliffy/testing"
import { assertEquals } from "@std/assert"
import { stub } from "@std/testing/mock"
import { describeCommand } from "../../../src/commands/issue/issue-describe.ts"
import { MockLinearServer } from "../../utils/mock_linear_server.ts"
import { setupMockLinearServer } from "../../utils/test-helpers.ts"

// Common Deno args for permissions
const denoArgs = ["--allow-all", "--quiet"]

for (const input of ["11111111-1111-4111-8111-000000000123", "OLD-123"]) {
  Deno.test(`Issue Describe uses the canonical returned identifier for ${input}`, async () => {
    const { server, cleanup } = await setupMockLinearServer([{
      queryName: "GetIssueHeader",
      variables: { id: input },
      response: {
        data: {
          issue: {
            id: "11111111-1111-4111-8111-000000000123",
            identifier: "NEW-42",
            title: "Moved issue",
            url: "https://linear.app/test-team/issue/NEW-42",
          },
        },
      },
    }])
    const output: string[] = []
    const log = stub(console, "log", (value: string) => output.push(value))
    try {
      await describeCommand.parse([input])
      assertEquals(output, [
        "NEW-42 Moved issue\n\nLinear-issue: Fixes NEW-42\nLinear-issue-url: https://linear.app/test-team/issue/NEW-42",
      ])
      assertEquals(server.graphqlRequests.length, 1)
    } finally {
      log.restore()
      await cleanup()
    }
  })
}

// Test help output
await snapshotTest({
  name: "Issue Describe Command - Help Text",
  meta: import.meta,
  colors: false,
  args: ["--help"],
  denoArgs,
  async fn() {
    describeCommand.help({ colors: false })
    await describeCommand.parse()
  },
})

// Test with working mock server
await snapshotTest({
  name: "Issue Describe Command - With Mock Server",
  meta: import.meta,
  colors: false,
  args: ["TEST-123"],
  denoArgs,
  async fn() {
    const server = new MockLinearServer([
      {
        queryName: "GetIssueHeader",
        variables: { id: "TEST-123" },
        response: {
          data: {
            issue: {
              id: "11111111-1111-4111-8111-000000000123",
              identifier: "TEST-123",
              title: "Fix authentication bug in login flow",
              url:
                "https://linear.app/test-team/issue/TEST-123/fix-authentication-bug-in-login-flow",
            },
          },
        },
      },
    ])

    try {
      await server.start()
      Deno.env.set("LINEAR_GRAPHQL_ENDPOINT", server.getEndpoint())
      Deno.env.set("LINEAR_API_KEY", "Bearer test-token")

      await describeCommand.parse()
    } finally {
      await server.stop()
      Deno.env.delete("LINEAR_GRAPHQL_ENDPOINT")
      Deno.env.delete("LINEAR_API_KEY")
    }
  },
})

// Test with --references flag
await snapshotTest({
  name: "Issue Describe Command - With References Flag",
  meta: import.meta,
  colors: false,
  args: ["--references", "TEST-456"],
  denoArgs,
  async fn() {
    const server = new MockLinearServer([
      {
        queryName: "GetIssueHeader",
        variables: { id: "TEST-456" },
        response: {
          data: {
            issue: {
              id: "11111111-1111-4111-8111-000000000456",
              identifier: "TEST-456",
              title: "Update user profile page",
              url:
                "https://linear.app/test-team/issue/TEST-456/update-user-profile-page",
            },
          },
        },
      },
    ])

    try {
      await server.start()
      Deno.env.set("LINEAR_GRAPHQL_ENDPOINT", server.getEndpoint())
      Deno.env.set("LINEAR_API_KEY", "Bearer test-token")

      await describeCommand.parse()
    } finally {
      await server.stop()
      Deno.env.delete("LINEAR_GRAPHQL_ENDPOINT")
      Deno.env.delete("LINEAR_API_KEY")
    }
  },
})

// Test with issue not found
await snapshotTest({
  name: "Issue Describe Command - Issue Not Found",
  meta: import.meta,
  colors: false,
  canFail: true,
  args: ["TEST-999"],
  denoArgs,
  async fn() {
    const server = new MockLinearServer([
      {
        queryName: "GetIssueHeader",
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

      await describeCommand.parse()
    } finally {
      await server.stop()
      Deno.env.delete("LINEAR_GRAPHQL_ENDPOINT")
      Deno.env.delete("LINEAR_API_KEY")
    }
  },
})

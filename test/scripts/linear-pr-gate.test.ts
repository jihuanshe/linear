import { assertEquals, assertRejects, assertThrows } from "@std/assert"
import {
  evaluateLinearIssues,
  extractLinearIssueIdentifiers,
  fetchLinearIssue,
  parseAllowedTeamKeys,
} from "../../scripts/ci/linear-pr-gate.ts"

Deno.test("extracts one or more Linear Issue identifiers from the PR body", () => {
  assertEquals(
    extractLinearIssueIdentifiers(
      "Summary\n\nLinear-Issues: card-123 CARD-456",
    ),
    ["CARD-123", "CARD-456"],
  )
})

Deno.test("rejects an absent, duplicate, or malformed metadata line", () => {
  assertThrows(
    () => extractLinearIssueIdentifiers("No issue metadata"),
    Error,
    "must contain one Linear-Issues",
  )
  assertThrows(
    () =>
      extractLinearIssueIdentifiers(
        "Linear-Issues: CARD-1\nLinear-Issues: CARD-2",
      ),
    Error,
    "only one",
  )
  assertThrows(
    () => extractLinearIssueIdentifiers("Linear-Issues: not-an-issue"),
    Error,
    "invalid Linear Issue",
  )
  assertEquals(extractLinearIssueIdentifiers("Linear-Issues: CARD-1"), [
    "CARD-1",
  ])
})

Deno.test("checks allowed team, archived, and canceled issue rules", () => {
  const issues = [
    {
      identifier: "CARD-1",
      archivedAt: null,
      url: "https://linear.app/jihuanshe/issue/CARD-1",
      state: { name: "Todo", type: "unstarted" },
      team: { key: "CARD" },
    },
    {
      identifier: "MOB-2",
      archivedAt: null,
      url: "https://linear.app/jihuanshe/issue/MOB-2",
      state: { name: "Done", type: "completed" },
      team: { key: "MOB" },
    },
    {
      identifier: "CARD-3",
      archivedAt: "2026-08-30T00:00:00.000Z",
      url: "https://linear.app/jihuanshe/issue/CARD-3",
      state: { name: "Canceled", type: "canceled" },
      team: { key: "CARD" },
    },
  ]
  assertEquals(evaluateLinearIssues(issues, parseAllowedTeamKeys("CARD")), [
    "MOB-2 belongs to team MOB, not an allowed team",
    "CARD-3 is archived",
    "CARD-3 is canceled",
  ])
})

Deno.test("fetches an Issue through the Linear GraphQL boundary", async () => {
  let receivedAuthorization = ""
  const server = Deno.serve({ port: 0 }, async (request) => {
    receivedAuthorization = request.headers.get("authorization") || ""
    const body = await request.json() as { variables?: { id?: string } }
    assertEquals(body.variables?.id, "CARD-123")
    return Response.json({
      data: {
        issue: {
          identifier: "CARD-123",
          archivedAt: null,
          url: "https://linear.app/jihuanshe/issue/CARD-123",
          state: { name: "Todo", type: "unstarted" },
          team: { key: "CARD" },
        },
      },
    })
  })
  try {
    const issue = await fetchLinearIssue(
      "CARD-123",
      "test-key",
      `http://127.0.0.1:${server.addr.port}`,
    )
    assertEquals(issue.identifier, "CARD-123")
    assertEquals(receivedAuthorization, "test-key")
  } finally {
    server.shutdown()
  }
})

Deno.test("rejects a GraphQL API error", async () => {
  const server = Deno.serve(
    { port: 0 },
    () =>
      Response.json({ errors: [{ message: "Issue not found" }] }, {
        status: 200,
      }),
  )
  try {
    await assertRejects(
      () =>
        fetchLinearIssue(
          "CARD-404",
          "test-key",
          `http://127.0.0.1:${server.addr.port}`,
        ),
      Error,
      "CARD-404",
    )
  } finally {
    server.shutdown()
  }
})

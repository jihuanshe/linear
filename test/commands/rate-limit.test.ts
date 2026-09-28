import { assertEquals, assertStringIncludes } from "@std/assert"
import {
  setupIssueWriteServer,
  teamWriteIds,
} from "../utils/issue-write-fixtures.ts"
import { commonDenoArgs, setupMockLinearServer } from "../utils/test-helpers.ts"

const reset = Date.now() + 5 * 60_000
const rateLimited = {
  status: 400,
  headers: {
    // Longer than the transport budget, so the query is not retried.
    "retry-after": "120",
    "x-ratelimit-requests-remaining": "0",
    "x-ratelimit-requests-reset": String(reset),
    "x-ratelimit-complexity-remaining": "2999000",
    "x-ratelimit-complexity-reset": String(reset - 60_000),
  },
  response: {
    data: null,
    errors: [{
      message: "Rate limit exceeded",
      extensions: { code: "RATELIMITED" },
    }],
  },
}
const rateLimit = {
  requestsRemaining: 0,
  requestsResetAt: new Date(reset).toISOString(),
  complexityRemaining: 2999000,
  complexityResetAt: new Date(reset - 60_000).toISOString(),
  retryAfter: new Date(reset).toISOString(),
}

async function run(args: string[]) {
  const result = await new Deno.Command(Deno.execPath(), {
    args: ["run", ...commonDenoArgs, "src/main.ts", ...args, "--json"],
    stdin: "null",
    stdout: "piped",
    stderr: "piped",
  }).output()
  return {
    code: result.code,
    body: JSON.parse(new TextDecoder().decode(result.stdout)),
  }
}

Deno.test("rate-limited read reports quota, reset and a safe retry", async () => {
  const { server, cleanup } = await setupMockLinearServer([
    { queryName: "GetIssueDetailsWithComments", ...rateLimited },
  ])
  try {
    const { code, body } = await run(["issue", "view", "ENG-1"])
    assertEquals(code, 1)
    assertEquals(server.graphqlRequests.length, 1)
    assertEquals(body.effect, "none")
    assertEquals(body.error.code, "RateLimited")
    assertEquals(body.error.details.rateLimit, rateLimit)
    assertStringIncludes(body.error.suggestion, "retry this read after")
  } finally {
    await cleanup()
  }
})

Deno.test("rate-limited write stays unknown and asks for reconciliation", async () => {
  const { server, cleanup } = await setupIssueWriteServer([
    {
      queryName: "GetTeamIdByKey",
      variables: { team: "ENG" },
      response: { data: { teams: { nodes: [{ id: teamWriteIds.ENG }] } } },
    },
    { queryName: "CreateIssue", ...rateLimited },
  ], { LINEAR_ISSUE_CREATE_ASSIGN_SELF: "never" })
  try {
    const { code, body } = await run([
      "issue",
      "create",
      "--title",
      "Feedback",
      "--team",
      "ENG",
    ])
    assertEquals(code, 1)
    assertEquals(
      server.graphqlRequests.filter((request) =>
        request.query.includes("mutation CreateIssue")
      ).length,
      1,
    )
    assertEquals(body.effect, "unknown")
    assertEquals(body.error.code, "RateLimited")
    assertEquals(body.error.details.rateLimit, rateLimit)
    assertStringIncludes(body.error.suggestion, "reconcile")
  } finally {
    await cleanup()
  }
})

Deno.test("malformed reset headers cannot erase an unknown mutation effect", async () => {
  const { server, cleanup } = await setupIssueWriteServer([
    {
      queryName: "GetTeamIdByKey",
      variables: { team: "ENG" },
      response: { data: { teams: { nodes: [{ id: teamWriteIds.ENG }] } } },
    },
    {
      ...rateLimited,
      queryName: "CreateIssue",
      headers: {
        ...rateLimited.headers,
        "x-ratelimit-requests-reset": "9".repeat(30),
      },
    },
  ], { LINEAR_ISSUE_CREATE_ASSIGN_SELF: "never" })
  try {
    const { code, body } = await run([
      "issue",
      "create",
      "--title",
      "Feedback",
      "--team",
      "ENG",
    ])
    assertEquals(code, 1)
    assertEquals(
      server.graphqlRequests.filter((request) =>
        request.query.includes("mutation CreateIssue")
      ).length,
      1,
    )
    assertEquals(body.effect, "unknown")
    assertEquals(body.error.code, "RateLimited")
    assertEquals(body.error.details.rateLimit.requestsResetAt, undefined)
  } finally {
    await cleanup()
  }
})

Deno.test("rate-limited errors wait for the latest exhausted quota", async () => {
  const endpointReset = Date.now() + 60_000
  const complexityReset = Date.now() + 120_000
  const requestsReset = Date.now() + 180_000
  const { cleanup } = await setupMockLinearServer([{
    queryName: "GetIssueDetailsWithComments",
    ...rateLimited,
    headers: {
      ...rateLimited.headers,
      "x-ratelimit-endpoint-requests-remaining": "0",
      "x-ratelimit-endpoint-requests-reset": String(endpointReset),
      "x-ratelimit-complexity-remaining": "0",
      "x-ratelimit-complexity-reset": String(complexityReset),
      "x-ratelimit-requests-reset": String(requestsReset),
    },
  }])
  try {
    const { body } = await run(["issue", "view", "ENG-1"])
    assertEquals(
      body.error.details.rateLimit.retryAfter,
      new Date(requestsReset).toISOString(),
    )
  } finally {
    await cleanup()
  }
})

Deno.test("past reset headers are not actionable retry guidance", async () => {
  const { cleanup } = await setupMockLinearServer([{
    queryName: "GetIssueDetailsWithComments",
    ...rateLimited,
    headers: {
      ...rateLimited.headers,
      "x-ratelimit-requests-reset": "0",
    },
  }])
  try {
    const { body } = await run(["issue", "view", "ENG-1"])
    assertEquals(body.error.details.rateLimit.requestsResetAt, undefined)
    assertEquals(body.error.details.rateLimit.retryAfter, undefined)
    assertStringIncludes(
      body.error.suggestion,
      "after the rate limit window resets",
    )
  } finally {
    await cleanup()
  }
})

Deno.test("an unknown exhausted quota suppresses retry guidance", async () => {
  const knownReset = Date.now() + 120_000
  const { cleanup } = await setupMockLinearServer([{
    queryName: "GetIssueDetailsWithComments",
    ...rateLimited,
    headers: {
      ...rateLimited.headers,
      "x-ratelimit-requests-reset": String(knownReset),
      "x-ratelimit-complexity-remaining": "0",
      "x-ratelimit-complexity-reset": "0",
    },
  }])
  try {
    const { body } = await run(["issue", "view", "ENG-1"])
    assertEquals(body.error.details.rateLimit.retryAfter, undefined)
    assertStringIncludes(
      body.error.suggestion,
      "after the rate limit window resets",
    )
  } finally {
    await cleanup()
  }
})

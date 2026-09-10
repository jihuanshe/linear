import { assertEquals } from "@std/assert"
import {
  CliError,
  errorResult,
  extractGraphQLMessage,
  isClientError,
  isDebugMode,
  isNotFoundError,
  NotFoundError,
  ValidationError,
} from "../../src/utils/errors.ts"
import { ClientError, type GraphQLResponse } from "graphql-request"
import { GraphQLError } from "graphql"

Deno.test("isDebugMode - returns false when LINEAR_DEBUG is not set", () => {
  Deno.env.delete("LINEAR_DEBUG")
  assertEquals(isDebugMode(), false)
})

Deno.test("isDebugMode - returns true when LINEAR_DEBUG is '1'", () => {
  Deno.env.set("LINEAR_DEBUG", "1")
  try {
    assertEquals(isDebugMode(), true)
  } finally {
    Deno.env.delete("LINEAR_DEBUG")
  }
})

Deno.test("isDebugMode - returns true when LINEAR_DEBUG is 'true'", () => {
  Deno.env.set("LINEAR_DEBUG", "true")
  try {
    assertEquals(isDebugMode(), true)
  } finally {
    Deno.env.delete("LINEAR_DEBUG")
  }
})

Deno.test("CliError - stores user message", () => {
  const error = new CliError("Something went wrong")
  assertEquals(error.userMessage, "Something went wrong")
  assertEquals(error.message, "Something went wrong")
})

Deno.test("CliError - stores suggestion", () => {
  const error = new CliError("Something went wrong", {
    suggestion: "Try running with --force",
  })
  assertEquals(error.suggestion, "Try running with --force")
})

Deno.test("NotFoundError - formats message correctly", () => {
  const error = new NotFoundError("Issue", "ENG-123")
  assertEquals(error.userMessage, "Issue not found: ENG-123")
  assertEquals(error.entityType, "Issue")
  assertEquals(error.identifier, "ENG-123")
})

Deno.test("ValidationError - stores message and suggestion", () => {
  const error = new ValidationError("Invalid relation type: foo", {
    suggestion: "Must be one of: blocks, related",
  })
  assertEquals(error.userMessage, "Invalid relation type: foo")
  assertEquals(error.suggestion, "Must be one of: blocks, related")
})

// Helper to create test ClientError instances
function createClientError(
  message: string,
  userPresentableMessage?: string,
): ClientError {
  const response = {
    status: 200,
    errors: [
      {
        message,
        extensions: userPresentableMessage
          ? { userPresentableMessage }
          : undefined,
      },
    ],
  } as unknown as GraphQLResponse<unknown>
  return new ClientError(response, { query: "query {}" })
}

Deno.test("extractGraphQLMessage - extracts userPresentableMessage", () => {
  const error = createClientError("Internal error", "Issue not found")
  assertEquals(extractGraphQLMessage(error), "Issue not found")
})

Deno.test("extractGraphQLMessage - falls back to error message", () => {
  const error = createClientError("Entity not found: Issue")
  assertEquals(extractGraphQLMessage(error), "Entity not found: Issue")
})

Deno.test("isNotFoundError - returns true for 'not found' messages", () => {
  const error = createClientError("Entity not found: Issue")
  assertEquals(isNotFoundError(error), true)
})

Deno.test("isNotFoundError - returns false for other errors", () => {
  const error = createClientError("Authentication required")
  assertEquals(isNotFoundError(error), false)
})

Deno.test("isClientError - returns true for ClientError", () => {
  const error = createClientError("Some error")
  assertEquals(isClientError(error), true)
})

Deno.test("isClientError - returns false for other errors", () => {
  const error = new Error("Some error")
  assertEquals(isClientError(error), false)
})

Deno.test("errorResult - only the requested direct mutation acknowledgement proves applied", () => {
  const query = "mutation { projectUpdate { success project { id } } }"
  const data = { projectUpdate: { success: true } }
  const cases = [
    { query, data, effect: "applied" },
    { query, data: { projectUpdate: { success: false } } },
    { query, data: { projectUpdate: { success: "true" } } },
    { query, data: { projectUpdate: { project: { success: true } } } },
    { query, data: { unrelated: { success: true } } },
    { query, data: { projectUpdate: null } },
    { query, data: null },
    { query: "mutation { projectUpdate { project { success } } }", data },
    { query: "mutation { projectUpdate { success: other } }", data },
    { query: "mutation { projectUpdate { ack: success } }", data },
    { query: "mutation { alias: projectUpdate { success } }", data },
    { query: "mutation { projectUpdate { success @skip(if: true) } }", data },
    { query: "mutation { projectUpdate { success } other { success } }", data },
    {
      query:
        "mutation A { projectUpdate { success } } mutation B { other { success } }",
      data,
    },
    {
      query:
        "mutation { ...F } fragment F on Mutation { projectUpdate { success } }",
      data,
    },
    {
      query: "mutation { projectUpdate { ... on Payload { success } } }",
      data,
    },
    { query: [query], data },
    { query: "invalid", data },
    { query: "query { projectUpdate { success } }", data, effect: "none" },
  ]
  for (const fixture of cases) {
    const errors = [new GraphQLError("Late field error")]
    const result = errorResult(
      new ClientError({
        status: 200,
        headers: new Headers(),
        body: JSON.stringify({ data: fixture.data, errors }),
        data: fixture.data,
        errors,
      }, { query: fixture.query }),
    )
    assertEquals(
      result.effect,
      fixture.effect ?? "unknown",
      String(fixture.query),
    )
    assertEquals(result.ok, false)
    assertEquals("details" in result.error && result.error.details, { errors })
    if (fixture.effect !== "none") assertEquals(result.data, fixture.data)
  }
})

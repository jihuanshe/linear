import { assertEquals, assertStringIncludes, assertThrows } from "@std/assert"
import { setCliWorkspace } from "../../src/config.ts"
import {
  createGraphQLClient,
  createPublicGraphQLClient,
  getResolvedApiKey,
} from "../../src/utils/graphql.ts"

Deno.test("GraphQL clients preserve authentication boundaries", async () => {
  const authorizations: Array<string | null> = []
  const server = Deno.serve({
    hostname: "127.0.0.1",
    port: 0,
    onListen: () => {},
  }, (request) => {
    authorizations.push(request.headers.get("authorization"))
    return Response.json({ data: { viewer: { id: "test" } } })
  })

  if (!("port" in server.addr)) {
    await server.shutdown()
    throw new Error("Expected a TCP test server")
  }

  Deno.env.set(
    "LINEAR_GRAPHQL_ENDPOINT",
    `http://127.0.0.1:${server.addr.port}/graphql`,
  )

  try {
    await createGraphQLClient("test-api-key").request(
      "query Test { viewer { id } }",
    )
    await createPublicGraphQLClient().request("query Test { viewer { id } }")
    assertEquals(authorizations, ["test-api-key", null])
  } finally {
    Deno.env.delete("LINEAR_GRAPHQL_ENDPOINT")
    await server.shutdown()
  }
})

Deno.test("getResolvedApiKey - errors when --workspace not found in credentials", () => {
  // Setup - use a workspace name that definitely doesn't exist
  Deno.env.delete("LINEAR_API_KEY")
  setCliWorkspace("nonexistent-workspace-xyz-123")

  try {
    const error = assertThrows(
      () => getResolvedApiKey(),
      Error,
    )
    assertStringIncludes(
      error.message,
      'Workspace "nonexistent-workspace-xyz-123" not found in credentials',
    )
  } finally {
    // Cleanup
    setCliWorkspace(undefined)
  }
})

Deno.test("getResolvedApiKey - errors when configured workspace is not found", () => {
  const workspace = "nonexistent-config-workspace-xyz-123"
  Deno.env.delete("LINEAR_API_KEY")
  Deno.env.set("LINEAR_WORKSPACE", workspace)
  setCliWorkspace(undefined)

  try {
    const error = assertThrows(
      () => getResolvedApiKey(),
      Error,
    )
    assertStringIncludes(
      error.message,
      `Workspace "${workspace}" not found in credentials`,
    )
  } finally {
    Deno.env.delete("LINEAR_WORKSPACE")
  }
})

Deno.test("getResolvedApiKey - errors when LINEAR_API_KEY and --workspace both set", () => {
  // Setup
  Deno.env.set("LINEAR_API_KEY", "test-api-key")
  setCliWorkspace("test-workspace")

  try {
    assertThrows(
      () => getResolvedApiKey(),
      Error,
      "Cannot use --workspace flag when LINEAR_API_KEY environment variable is set",
    )
  } finally {
    // Cleanup
    Deno.env.delete("LINEAR_API_KEY")
    setCliWorkspace(undefined)
  }
})

Deno.test("getResolvedApiKey - returns LINEAR_API_KEY when set without --workspace", () => {
  // Setup
  Deno.env.set("LINEAR_API_KEY", "test-api-key")
  setCliWorkspace(undefined)

  try {
    const result = getResolvedApiKey()
    assertEquals(result, "test-api-key")
  } finally {
    // Cleanup
    Deno.env.delete("LINEAR_API_KEY")
  }
})

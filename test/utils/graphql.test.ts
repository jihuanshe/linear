import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert"
import { stub } from "@std/testing/mock"
import { FakeTime } from "@std/testing/time"
import { setCliWorkspace } from "../../src/config.ts"
import { loadCredentials } from "../../src/credentials.ts"
import { AuthError, errorResult, WriteError } from "../../src/utils/errors.ts"
import {
  createGraphQLClient,
  createPublicGraphQLClient,
  getGraphQLClient,
  getResolvedApiKey,
  withGraphQLContext,
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

Deno.test("getResolvedApiKey - errors when --workspace not found in credentials", async () => {
  using _inventory = stub(Deno, "readTextFileSync", () => "workspaces = []")
  loadCredentials()
  Deno.env.delete("LINEAR_API_KEY")
  setCliWorkspace("nonexistent-workspace-xyz-123")

  try {
    const error = await assertRejects(
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

Deno.test("getResolvedApiKey - errors when configured workspace is not found", async () => {
  using _inventory = stub(Deno, "readTextFileSync", () => "workspaces = []")
  loadCredentials()
  const workspace = "nonexistent-config-workspace-xyz-123"
  Deno.env.delete("LINEAR_API_KEY")
  Deno.env.set("LINEAR_WORKSPACE", workspace)
  setCliWorkspace(undefined)

  try {
    const error = await assertRejects(
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

Deno.test("getResolvedApiKey - errors when LINEAR_API_KEY and --workspace both set", async () => {
  // Setup
  Deno.env.set("LINEAR_API_KEY", "test-api-key")
  setCliWorkspace("test-workspace")

  try {
    await assertRejects(
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

Deno.test("getResolvedApiKey - returns LINEAR_API_KEY when set without --workspace", async () => {
  // Setup
  Deno.env.set("LINEAR_API_KEY", "test-api-key")
  setCliWorkspace(undefined)

  try {
    const result = await getResolvedApiKey()
    assertEquals(result, "test-api-key")
  } finally {
    // Cleanup
    Deno.env.delete("LINEAR_API_KEY")
  }
})

Deno.test("GraphQL client retries a selected query without changing its request or authentication", async () => {
  using time = new FakeTime(0)
  using _now = stub(performance, "now", () => time.now)
  using _random = stub(Math, "random", () => 0)
  const requests: RequestInit[] = []
  using _fetch = stub(globalThis, "fetch", (_input, init) => {
    requests.push(init!)
    return Promise.resolve(
      requests.length === 1
        ? new Response("Unavailable", { status: 503 })
        : Response.json({ data: { viewer: { id: "ok" } } }),
    )
  })
  const pending = createGraphQLClient("test-key").request({
    document:
      "# mutation Fake\nquery Read($id: ID!) { viewer(id: $id) { ...Id } } fragment Id on User { id }",
    variables: { id: "same-id" },
  })
  await time.runMicrotasks()
  await time.runAllAsync()
  assertEquals(await pending, { viewer: { id: "ok" } })
  assertEquals(requests.length, 2)
  assertEquals(requests[0].body, requests[1].body)
  assertEquals(JSON.parse(String(requests[0].body)).operationName, "Read")
  assertEquals(
    requests.map((r) => new Headers(r.headers).get("authorization")),
    [
      "test-key",
      "test-key",
    ],
  )
  assertEquals(time.next(), false)
})

for (const phase of ["headers", "body", "interrupted body"]) {
  Deno.test(`GraphQL client mutation ${phase} failure remains unknown with one dispatch`, async () => {
    using time = new FakeTime(0)
    using _now = stub(performance, "now", () => time.now)
    let cancelled = 0
    using fetchStub = stub(globalThis, "fetch", () => {
      if (phase === "headers") return new Promise<Response>(() => {})
      return Promise.resolve(
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new TextEncoder().encode('{"data":'))
              if (phase === "interrupted body") {
                controller.error(new Deno.errors.ConnectionReset("reset"))
              }
            },
            cancel() {
              cancelled++
            },
          }),
        ),
      )
    })
    const pending = assertRejects(
      () =>
        createGraphQLClient("test-key").request(
          "mutation Write { issueUpdate { success } }",
        ),
      WriteError,
    )
    await time.runMicrotasks()
    await time.runAllAsync()
    const error = await pending
    assertEquals(error.effect, "unknown")
    assertEquals(fetchStub.calls.length, 1)
    assertEquals(cancelled, phase === "body" ? 1 : 0)
    assertEquals(time.now, phase === "interrupted body" ? 0 : 60_000)
    assertEquals(time.next(), false)
  })
}

Deno.test("GraphQL client preserves a complete mutation receipt across a pause after EOF", async () => {
  using time = new FakeTime(0)
  let elapsedAfterEof = 0
  using _now = stub(performance, "now", () => time.now + elapsedAfterEof)
  const decode = TextDecoder.prototype.decode
  using _decode = stub(TextDecoder.prototype, "decode", function (
    this: TextDecoder,
    ...args: Parameters<TextDecoder["decode"]>
  ) {
    const text = decode.apply(this, args)
    // Model a process pause after the entire receipt has been consumed.
    if (args[0] == null) elapsedAfterEof = 60_000
    return text
  })
  const receipt = { issueUpdate: { success: true } }
  using fetchStub = stub(
    globalThis,
    "fetch",
    () => Promise.resolve(Response.json({ data: receipt })),
  )
  assertEquals(
    await createGraphQLClient("test-key").request(
      "mutation Write { issueUpdate { success } }",
    ),
    receipt,
  )
  assertEquals(fetchStub.calls.length, 1)
  assertEquals(time.next(), false)
})

Deno.test("lazy authentication fails before a mutation dispatch with effect none", async () => {
  Deno.env.set("LINEAR_API_KEY", "")
  using fetchStub = stub(globalThis, "fetch", () => {
    throw new Error("must not dispatch")
  })
  try {
    const client = getGraphQLClient()
    const error = await assertRejects(
      () => client.request("mutation Write { issueUpdate { success } }"),
      AuthError,
      "LINEAR_API_KEY is empty",
    )
    assertEquals(errorResult(error).effect, "none")
    assertEquals(fetchStub.calls.length, 0)
  } finally {
    Deno.env.delete("LINEAR_API_KEY")
  }
})

Deno.test("invocation pins the principal across verification, mutation and token consumers", async () => {
  const authorizations: Array<string | null> = []
  using _fetch = stub(globalThis, "fetch", (_input, init) => {
    authorizations.push(new Headers(init?.headers).get("authorization"))
    return Promise.resolve(
      Response.json({ data: { result: { success: true } } }),
    )
  })
  Deno.env.set("LINEAR_API_KEY", "verified-key")
  try {
    await withGraphQLContext(async () => {
      await getGraphQLClient().request("query Verify { organization { id } }")
      Deno.env.set("LINEAR_API_KEY", "replacement-key")
      assertEquals(await getResolvedApiKey(), "verified-key")
      await getGraphQLClient().request(
        "mutation Write { issueUpdate { success } }",
      )
    })
    await withGraphQLContext(async () => {
      await getGraphQLClient().request("query Next { organization { id } }")
    })
    assertEquals(authorizations, [
      "verified-key",
      "verified-key",
      "replacement-key",
    ])
  } finally {
    Deno.env.delete("LINEAR_API_KEY")
  }
})

Deno.test("GraphQL client preserves the caller's shorter verification deadline", async () => {
  using time = new FakeTime(0)
  using _now = stub(performance, "now", () => time.now)
  const controller = new AbortController()
  const reason = new DOMException("Verification timed out", "TimeoutError")
  using fetchStub = stub(
    globalThis,
    "fetch",
    () =>
      Promise.resolve(Response.json({
        errors: [{ message: "Slow down", extensions: { code: "RATELIMITED" } }],
      }, { headers: { "retry-after": "20" } })),
  )
  const pending = assertRejects(() =>
    createGraphQLClient("test-key").request({
      document: "query Read { viewer { id } }",
      signal: controller.signal,
    })
  )
  await time.tickAsync(10_000)
  controller.abort(reason)
  assertEquals(await pending, reason)
  assertEquals(fetchStub.calls.length, 1)
  assertEquals(time.next(), false)
})

import { assertEquals, assertStringIncludes } from "@std/assert"
import { fromFileUrl } from "@std/path"

const main = fromFileUrl(new URL("../../src/main.ts", import.meta.url))
const read =
  "query Read($after: String) { issues(first: 1, after: $after) { nodes { id } pageInfo { hasNextPage endCursor } } }"
const write =
  'mutation Write($after: String) { issueUpdate(id: "ENG-1", input: {priority: 2}) { issue { comments(first: 1, after: $after) { nodes { id } pageInfo { hasNextPage endCursor } } } } }'
const { denoDir } = JSON.parse(new TextDecoder().decode(
  (await new Deno.Command(Deno.execPath(), {
    args: ["info", "--json"],
    stdout: "piped",
  }).output()).stdout,
)) as { denoDir: string }

type RequestBody = {
  query: string
  operationName?: string
  variables?: Record<string, unknown>
}
type Page = { body: unknown; status?: number; raw?: string }

async function runApi(query: string, flags: string[], pages: Page[] = []) {
  const root = await Deno.makeTempDir()
  const requests: RequestBody[] = []
  const server = Deno.serve(
    { hostname: "127.0.0.1", port: 0, onListen() {} },
    async (request) => {
      requests.push(await request.json())
      const page = pages[requests.length - 1]
      if (!page) {
        return Response.json({
          errors: [{ message: "Unexpected extra request" }],
        }, { status: 500 })
      }
      return new Response(page.raw ?? JSON.stringify(page.body), {
        status: page.status ?? 200,
      })
    },
  )
  try {
    const output = await new Deno.Command(Deno.execPath(), {
      args: ["run", "--allow-all", "--quiet", main, "api", query, ...flags],
      stdin: "null",
      stdout: "piped",
      stderr: "piped",
      clearEnv: true,
      env: {
        HOME: root,
        XDG_CONFIG_HOME: root,
        APPDATA: root,
        DENO_DIR: denoDir,
        NO_COLOR: "1",
        LINEAR_API_KEY: "test-token",
        LINEAR_GRAPHQL_ENDPOINT: `http://127.0.0.1:${server.addr.port}`,
      },
    }).output()
    return {
      code: output.code,
      stdout: new TextDecoder().decode(output.stdout),
      stderr: new TextDecoder().decode(output.stderr),
      requests,
    }
  } finally {
    await server.shutdown()
    await Deno.remove(root, { recursive: true })
  }
}

function connection(id: string, cursor: unknown, hasNextPage = true) {
  return { nodes: [{ id }], pageInfo: { hasNextPage, endCursor: cursor } }
}

function page(id: string, cursor: unknown, hasNextPage = true): Page {
  return { body: { data: { issues: connection(id, cursor, hasNextPage) } } }
}

function assertLocalFailure(
  result: { stdout: string; stderr: string },
  effect = "none",
) {
  const failure = JSON.parse(result.stdout)
  assertEquals(failure.ok, false)
  assertEquals(failure.effect, effect)
  assertEquals(failure.data, undefined)
  assertEquals(result.stderr, "")
  return failure.error.message as string
}

for (const mutation of [false, true]) {
  Deno.test(`API rejects explicitly empty JSON variables before transport: mutation=${mutation}`, async () => {
    const result = await runApi(
      mutation ? write : read,
      [...(mutation ? ["--unprotected"] : []), "--variables-json", ""],
    )
    assertEquals(result.code, 1)
    assertEquals(result.requests, [])
    assertStringIncludes(
      assertLocalFailure(result),
      "Invalid JSON for --variables-json",
    )
  })
}

for (
  const test of [
    {
      name: "unprotected mutation without explicit intent",
      query: write,
      flags: [],
      message: "Raw mutations require --unprotected",
    },
    {
      name: "mutation pagination",
      query: write,
      flags: ["--paginate"],
      message: "only supports query",
    },
    {
      name: "explicit mutation pagination",
      query: write,
      flags: ["--paginate", "--unprotected"],
      message: "only supports query",
    },
    {
      name: "ambiguous operation",
      query: `${read}\n${write}`,
      flags: [],
      message: "--operation-name",
    },
    {
      name: "missing selected operation",
      query: `${read}\n${write}`,
      flags: ["--operation-name", "Missing"],
      message: "exactly one operation",
    },
    {
      name: "selected mutation",
      query: `${read}\n${write}`,
      flags: ["--operation-name", "Write"],
      message: "Raw mutations require --unprotected",
    },
    {
      name: "selected mutation pagination",
      query: `${read}\n${write}`,
      flags: ["--operation-name", "Write", "--paginate", "--unprotected"],
      message: "only supports query",
    },
    {
      name: "invalid GraphQL",
      query: "mutation Broken {",
      flags: ["--unprotected"],
      message: "Invalid GraphQL document",
    },
    {
      name: "subscription",
      query: "subscription Events { event { id } }",
      flags: [],
      message: "Subscriptions are not supported",
    },
    {
      name: "unprotected query",
      query: read,
      flags: ["--unprotected"],
      message: "only applies to mutation",
    },
    {
      name: "unused cursor",
      query: "query Read($after: String) { viewer { id } }",
      flags: ["--paginate"],
      message: "exactly one connection",
    },
    {
      name: "undeclared cursor",
      query: "query Read { issues(after: $after) { nodes { id } } }",
      flags: ["--paginate"],
      message: "declare $after: String",
    },
    {
      name: "partial initial cursor",
      query: read,
      flags: ["--paginate", "--variable", "after=already-read"],
      message: "starts at the first page",
    },
  ]
) {
  Deno.test(`API safety rejects ${test.name} before the first request`, async () => {
    const result = await runApi(test.query, test.flags)
    assertEquals(result.code, 1)
    assertEquals(result.requests, [])
    assertStringIncludes(assertLocalFailure(result), test.message)
  })
}

Deno.test("API safety uses the selected query in a mixed document", async () => {
  const query = `${write}\n${read}`
  const result = await runApi(
    query,
    ["--operation-name", "Read", "--paginate"],
    [
      page("one", "a"),
      page("two", "b", false),
    ],
  )
  assertEquals(result.code, 0, result.stderr)
  assertEquals(
    result.requests.map((
      request,
    ) => [request.operationName, request.variables]),
    [
      ["Read", { after: null }],
      ["Read", { after: "a" }],
    ],
  )
  assertEquals(
    result.requests.every((request) => request.query === query),
    true,
  )
  assertEquals(JSON.parse(result.stdout).data.issues, {
    nodes: [{ id: "one" }, { id: "two" }],
    pageInfo: { hasNextPage: false, endCursor: "b" },
  })
})

Deno.test("API safety AST selection ignores mutation text in comments and strings", async () => {
  const query =
    '# mutation Fake { deleteAll }\nquery Find { search(term: "mutation Write") { id } }'
  const envelope = { data: { search: { id: "one" } } }
  const result = await runApi(query, [], [{ body: envelope }])
  assertEquals(result.code, 0, result.stderr)
  assertEquals(result.requests.length, 1)
  assertEquals(JSON.parse(result.stdout), envelope)
})

Deno.test("API safety binds fragment and alias pagination to the selected response path", async () => {
  const query =
    "query Read($after: String) { ...Results } fragment Results on Query { selected: issues(after: $after) { nodes { id } pageInfo { hasNextPage endCursor } } }"
  const result = await runApi(query, ["--paginate"], [
    { body: { data: { selected: connection("one", "a") } } },
    { body: { data: { selected: connection("two", null, false) } } },
  ])
  assertEquals(result.code, 0, result.stderr)
  assertEquals(JSON.parse(result.stdout).data.selected.nodes, [{ id: "one" }, {
    id: "two",
  }])
})

for (const cursor of [null, "", 42]) {
  Deno.test(`API safety rejects hasNextPage with invalid cursor ${JSON.stringify(cursor)}`, async () => {
    const result = await runApi(read, ["--paginate"], [page("one", cursor)])
    assertEquals(result.code, 1)
    assertEquals(result.requests.length, 1)
    assertStringIncludes(
      assertLocalFailure(result),
      "Incomplete API pagination",
    )
  })
}

Deno.test("API safety rejects a nonadjacent cursor loop without partial output", async () => {
  const result = await runApi(read, ["--paginate"], [
    page("one", "a"),
    page("two", "b"),
    page("three", "a"),
  ])
  assertEquals(result.code, 1)
  assertEquals(result.requests.length, 3)
  assertStringIncludes(assertLocalFailure(result), "empty or repeated cursor")
})

for (
  const test of [
    { name: "connection disappears", body: { data: { issues: null } } },
    {
      name: "connection changes path",
      body: { data: { projects: connection("other", null, false) } },
    },
    {
      name: "second connection appears",
      body: {
        data: {
          issues: connection("two", null, false),
          projects: connection("other", null, false),
        },
      },
    },
    {
      name: "nodes disappear",
      body: {
        data: { issues: { pageInfo: { hasNextPage: false, endCursor: null } } },
      },
    },
    {
      name: "hasNextPage disappears",
      body: { data: { issues: { nodes: [], pageInfo: { endCursor: null } } } },
    },
    { name: "pageInfo disappears", body: { data: { issues: { nodes: [] } } } },
  ]
) {
  Deno.test(`API safety fails without partial output when ${test.name}`, async () => {
    const result = await runApi(read, ["--paginate"], [page("one", "a"), {
      body: test.body,
    }])
    assertEquals(result.code, 1)
    assertEquals(result.requests.length, 2)
    assertLocalFailure(result)
  })
}

Deno.test("API safety does not report accumulated pages after a later HTTP read failure", async () => {
  const result = await runApi(read, ["--paginate"], [page("one", "a"), {
    body: null,
    raw: "Upstream unavailable",
    status: 503,
  }])
  assertEquals(result.code, 1)
  assertEquals(result.requests.length, 2)
  assertLocalFailure(result)
})

Deno.test("API safety preserves a later GraphQL partial error without merging prior pages", async () => {
  const envelope = {
    data: { issues: connection("partial", null, false) },
    errors: [{ message: "Resolver failed", path: ["issues", "nodes", 0] }],
  }
  const result = await runApi(read, ["--paginate"], [page("one", "a"), {
    body: envelope,
  }])
  assertEquals(result.code, 1)
  assertEquals(result.requests.length, 2)
  assertEquals(JSON.parse(result.stdout), envelope)
})

for (const status of [200, 400]) {
  for (const mutation of [false, true]) {
    Deno.test(`API safety preserves HTTP ${status} RATELIMITED mutation=${mutation} without retry`, async () => {
      const envelope = {
        data: null,
        errors: [{
          message: "Rate limit exceeded",
          extensions: { code: "RATELIMITED" },
        }],
      }
      const result = await runApi(
        mutation ? write : read,
        mutation ? ["--unprotected"] : [],
        [{ status, body: envelope }],
      )
      assertEquals(result.code, 1)
      assertEquals(result.requests.length, 1)
      assertEquals(result.stderr, "")
      assertEquals(JSON.parse(result.stdout), envelope)
    })
  }
}

Deno.test("API safety sends an explicitly selected raw mutation once and preserves its envelope", async () => {
  const envelope = {
    data: { issueUpdate: { success: true } },
    extensions: { trace: "one" },
  }
  const result = await runApi(`${read}\n${write}`, [
    "--operation-name",
    "Write",
    "--unprotected",
  ], [{ body: envelope }])
  assertEquals(result.code, 0, result.stderr)
  assertEquals(result.requests.length, 1)
  assertEquals(result.requests[0]?.operationName, "Write")
  assertEquals(JSON.parse(result.stdout), envelope)
})

Deno.test("API safety reports unknown when a mutation result is unreadable and does not retry", async () => {
  const result = await runApi(write, ["--unprotected"], [{
    body: null,
    raw: "<html>Connection lost</html>",
  }])
  assertEquals(result.code, 1)
  assertEquals(result.requests.length, 1)
  assertStringIncludes(
    assertLocalFailure(result, "unknown"),
    "mutation outcome is unknown",
  )
})

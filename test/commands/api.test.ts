import { snapshotTest as cliffySnapshotTest } from "@cliffy/testing"
import { assertEquals, assertStringIncludes } from "@std/assert"
import { setColorEnabled } from "@std/fmt/colors"
import { fromFileUrl } from "@std/path"
import { apiCommand } from "../../src/commands/api.ts"
import { loadCredentials } from "../../src/credentials.ts"
import { MockLinearServer } from "../utils/mock_linear_server.ts"

const denoArgs = ["--allow-all", "--quiet"]
// Keep credential/config isolation without downloading dependencies per request.
const { denoDir } = JSON.parse(new TextDecoder().decode(
  (await new Deno.Command(Deno.execPath(), {
    args: ["info", "--json"],
    stdout: "piped",
  }).output()).stdout,
)) as { denoDir: string }

for (const paginate of [false, true]) {
  for (const silent of [false, true]) {
    Deno.test(`API HTTP boundary - invalid JSON paginate=${paginate} silent=${silent}`, async () => {
      const result = await runApiResponse("<html>Upstream unavailable</html>", [
        ...(paginate ? ["--paginate"] : []),
        ...(silent ? ["--silent"] : []),
      ])
      assertEquals(result.code, 1)
      const failure = JSON.parse(result.stdout)
      assertEquals(failure.ok, false)
      assertEquals(failure.effect, "none")
      assertStringIncludes(
        failure.error.message,
        "API response is not valid JSON",
      )
      assertEquals(result.stderr, "")
      assertEquals(result.stdout.includes("<html>"), false)
    })
    Deno.test(`API HTTP boundary - invalid envelope paginate=${paginate} silent=${silent}`, async () => {
      for (const value of [null, [], "invalid", 42, {}]) {
        const result = await runApiResponse(JSON.stringify(value), [
          ...(paginate ? ["--paginate"] : []),
          ...(silent ? ["--silent"] : []),
        ])
        assertEquals(result.code, 1)
        const failure = JSON.parse(result.stdout)
        assertEquals(failure.ok, false)
        assertEquals(failure.effect, "none")
        assertEquals(failure.data, undefined)
        assertStringIncludes(
          failure.error.message,
          "API response is not a GraphQL response object",
        )
        assertEquals(result.stderr, "")
      }
    })
  }
}

for (const hasErrors of [false, true]) {
  for (const silent of [false, true]) {
    Deno.test(`API HTTP boundary - envelope errors=${hasErrors} silent=${silent}`, async () => {
      const envelope = {
        data: { viewer: { id: "user-1" } },
        ...(hasErrors ? { errors: [{ message: "Partial failure" }] } : {}),
        extensions: { traceId: "trace-1" },
      }
      const result = await runApiResponse(
        JSON.stringify(envelope),
        silent ? ["--silent"] : [],
      )
      assertEquals(result.code, hasErrors ? 1 : 0, result.stderr)
      assertEquals(result.stderr, "")
      if (silent) {
        assertEquals(result.stdout, "")
      } else {
        assertEquals(JSON.parse(result.stdout), envelope)
      }
    })
  }
}

for (const mutation of [false, true]) {
  Deno.test(`API HTTP boundary - malformed result fields mutation=${mutation}`, async () => {
    for (
      const envelope of [
        { data: null },
        { data: 9 },
        { data: [] },
        { errors: [] },
        { errors: "bad" },
        { data: {}, errors: [] },
        { data: {}, errors: [null] },
        { data: {}, errors: [{ message: 42 }] },
      ]
    ) {
      const result = await runApiResponse(
        JSON.stringify(envelope),
        mutation ? ["--unprotected"] : [],
      )
      assertEquals(result.code, 1)
      const failure = JSON.parse(result.stdout)
      assertEquals(failure.ok, false)
      assertEquals(failure.effect, mutation ? "unknown" : "none")
      assertEquals(result.stderr, "")
    }
  })

  Deno.test(`API HTTP boundary - errors without data mutation=${mutation}`, async () => {
    for (
      const envelope of [
        { errors: [{ message: "Rejected" }] },
        { data: null, errors: [{ message: "Execution failed" }] },
      ]
    ) {
      const result = await runApiResponse(
        JSON.stringify(envelope),
        mutation ? ["--unprotected"] : [],
      )
      assertEquals(result.code, 1)
      assertEquals(JSON.parse(result.stdout), envelope)
      assertEquals(result.stderr, "")
    }
  })
}

async function runApiResponse(body: string, flags: string[]) {
  const root = await Deno.makeTempDir()
  const query = flags.includes("--unprotected")
    ? 'mutation DeleteComment { commentDelete(id: "dummy-id") { success } }'
    : flags.includes("--paginate")
    ? "query GetIssues($after: String) { issues(after: $after) { nodes { id } pageInfo { hasNextPage endCursor } } }"
    : "query GetViewer { viewer { id } }"
  let requests = 0
  const server = Deno.serve(
    { hostname: "127.0.0.1", port: 0, onListen() {} },
    async (request) => {
      assertEquals(request.method, "POST")
      assertEquals(
        (await request.json()).query,
        query,
      )
      requests++
      return new Response(body, { status: 200 })
    },
  )
  try {
    const result = await new Deno.Command(Deno.execPath(), {
      args: [
        "run",
        "--allow-all",
        "--quiet",
        fromFileUrl(new URL("../../src/main.ts", import.meta.url)),
        "api",
        query,
        ...flags,
      ],
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
    assertEquals(requests, 1)
    return {
      code: result.code,
      stdout: new TextDecoder().decode(result.stdout),
      stderr: new TextDecoder().decode(result.stderr),
    }
  } finally {
    await server.shutdown()
    await Deno.remove(root, { recursive: true })
  }
}

await cliffySnapshotTest({
  name: "API Command - Help Text",
  meta: import.meta,
  colors: false,
  args: ["--help"],
  denoArgs,
  async fn() {
    apiCommand.help({ colors: false })
    await apiCommand.parse()
  },
})

await cliffySnapshotTest({
  name: "API Command - Basic Query",
  meta: import.meta,
  colors: false,
  args: ["query GetViewer { viewer { id name } }"],
  denoArgs,
  async fn() {
    const server = new MockLinearServer([
      {
        queryName: "GetViewer",
        response: {
          data: {
            viewer: {
              id: "user-1",
              name: "Test User",
            },
          },
        },
      },
    ])

    try {
      await server.start()
      Deno.env.set("LINEAR_GRAPHQL_ENDPOINT", server.getEndpoint())
      Deno.env.set("LINEAR_API_KEY", "Bearer test-token")

      await apiCommand.parse()
    } finally {
      await server.stop()
      Deno.env.delete("LINEAR_GRAPHQL_ENDPOINT")
      Deno.env.delete("LINEAR_API_KEY")
    }
  },
})

await cliffySnapshotTest({
  name: "API Command - Variable Flag",
  meta: import.meta,
  colors: false,
  args: [
    "query GetTeam($teamId: String!) { team(id: $teamId) { name } }",
    "--variable",
    "teamId=abc123",
  ],
  denoArgs,
  async fn() {
    const server = new MockLinearServer([
      {
        queryName: "GetTeam",
        variables: { teamId: "abc123" },
        response: {
          data: {
            team: {
              name: "Backend Team",
            },
          },
        },
      },
    ])

    try {
      await server.start()
      Deno.env.set("LINEAR_GRAPHQL_ENDPOINT", server.getEndpoint())
      Deno.env.set("LINEAR_API_KEY", "Bearer test-token")

      await apiCommand.parse()
    } finally {
      await server.stop()
      Deno.env.delete("LINEAR_GRAPHQL_ENDPOINT")
      Deno.env.delete("LINEAR_API_KEY")
    }
  },
})

await cliffySnapshotTest({
  name: "API Command - Variable Type Coercion",
  meta: import.meta,
  colors: false,
  args: [
    "query GetIssues($first: Int!, $active: Boolean!) { issues(first: $first, filter: { active: $active }) { nodes { title } } }",
    "--variable",
    "first=5",
    "--variable",
    "active=true",
  ],
  denoArgs,
  async fn() {
    const server = new MockLinearServer([
      {
        queryName: "GetIssues",
        variables: { first: 5, active: true },
        response: {
          data: {
            issues: {
              nodes: [
                { title: "Issue One" },
                { title: "Issue Two" },
              ],
            },
          },
        },
      },
    ])

    try {
      await server.start()
      Deno.env.set("LINEAR_GRAPHQL_ENDPOINT", server.getEndpoint())
      Deno.env.set("LINEAR_API_KEY", "Bearer test-token")

      await apiCommand.parse()
    } finally {
      await server.stop()
      Deno.env.delete("LINEAR_GRAPHQL_ENDPOINT")
      Deno.env.delete("LINEAR_API_KEY")
    }
  },
})

await cliffySnapshotTest({
  name: "API Command - No Query Error",
  meta: import.meta,
  colors: false,
  args: [],
  denoArgs,
  canFail: true,
  async fn() {
    Deno.env.set("LINEAR_API_KEY", "Bearer test-token")
    try {
      await apiCommand.parse()
    } finally {
      Deno.env.delete("LINEAR_API_KEY")
    }
  },
})

await cliffySnapshotTest({
  name: "API Command - Invalid Variable Format",
  meta: import.meta,
  colors: false,
  args: ["query GetViewer { viewer { id } }", "--variable", "badformat"],
  denoArgs,
  canFail: true,
  async fn() {
    setColorEnabled(false)
    apiCommand.help({ colors: false })
    Deno.env.set("LINEAR_API_KEY", "Bearer test-token")
    try {
      await apiCommand.parse()
    } finally {
      Deno.env.delete("LINEAR_API_KEY")
    }
  },
})

await cliffySnapshotTest({
  name: "API Command - GraphQL Errors Exit Non-Zero",
  meta: import.meta,
  colors: false,
  args: ["query BadQuery { nonexistent { id } }"],
  denoArgs,
  canFail: true,
  async fn() {
    const server = new MockLinearServer([
      {
        queryName: "BadQuery",
        response: {
          data: null,
          errors: [
            {
              message: "Cannot query field 'nonexistent' on type 'Query'",
            },
          ],
        },
      },
    ])

    try {
      await server.start()
      Deno.env.set("LINEAR_GRAPHQL_ENDPOINT", server.getEndpoint())
      Deno.env.set("LINEAR_API_KEY", "Bearer test-token")

      await apiCommand.parse()
    } finally {
      await server.stop()
      Deno.env.delete("LINEAR_GRAPHQL_ENDPOINT")
      Deno.env.delete("LINEAR_API_KEY")
    }
  },
})

await cliffySnapshotTest({
  name: "API Command - Silent Flag",
  meta: import.meta,
  colors: false,
  args: [
    "query GetViewer { viewer { id } }",
    "--silent",
  ],
  denoArgs,
  async fn() {
    const server = new MockLinearServer([
      {
        queryName: "GetViewer",
        response: {
          data: {
            viewer: { id: "user-1" },
          },
        },
      },
    ])

    try {
      await server.start()
      Deno.env.set("LINEAR_GRAPHQL_ENDPOINT", server.getEndpoint())
      Deno.env.set("LINEAR_API_KEY", "Bearer test-token")

      await apiCommand.parse()
    } finally {
      await server.stop()
      Deno.env.delete("LINEAR_GRAPHQL_ENDPOINT")
      Deno.env.delete("LINEAR_API_KEY")
    }
  },
})

await cliffySnapshotTest({
  name: "API Command - Variable From File",
  meta: import.meta,
  colors: false,
  args: [
    "query GetTeam($filter: TeamFilter!) { teams(filter: $filter) { nodes { name } } }",
    "--variable",
    `filter=@${Deno.cwd()}/test/commands/fixtures/api-filter.json`,
  ],
  denoArgs,
  async fn() {
    const server = new MockLinearServer([
      {
        queryName: "GetTeam",
        response: {
          data: {
            teams: {
              nodes: [{ name: "Backend" }],
            },
          },
        },
      },
    ])

    try {
      await server.start()
      Deno.env.set("LINEAR_GRAPHQL_ENDPOINT", server.getEndpoint())
      Deno.env.set("LINEAR_API_KEY", "Bearer test-token")

      await apiCommand.parse()
    } finally {
      await server.stop()
      Deno.env.delete("LINEAR_GRAPHQL_ENDPOINT")
      Deno.env.delete("LINEAR_API_KEY")
    }
  },
})

await cliffySnapshotTest({
  name: "API Command - Paginate",
  meta: import.meta,
  colors: false,
  args: [
    "query GetIssues($after: String) { issues(first: 2, after: $after) { nodes { title } pageInfo { hasNextPage endCursor } } }",
    "--paginate",
  ],
  denoArgs,
  async fn() {
    const server = new MockLinearServer([
      {
        queryName: "GetIssues",
        variables: { after: null },
        response: {
          data: {
            issues: {
              nodes: [
                { title: "Issue 1" },
                { title: "Issue 2" },
              ],
              pageInfo: {
                hasNextPage: true,
                endCursor: "cursor-1",
              },
            },
          },
        },
      },
      {
        queryName: "GetIssues",
        variables: { after: "cursor-1" },
        response: {
          data: {
            issues: {
              nodes: [
                { title: "Issue 3" },
              ],
              pageInfo: {
                hasNextPage: false,
                endCursor: null,
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

      await apiCommand.parse()
    } finally {
      await server.stop()
      Deno.env.delete("LINEAR_GRAPHQL_ENDPOINT")
      Deno.env.delete("LINEAR_API_KEY")
    }
  },
})

await cliffySnapshotTest({
  name: "API Command - No API Key",
  meta: import.meta,
  colors: false,
  args: ["query GetViewer { viewer { id } }"],
  denoArgs,
  canFail: true,
  async fn() {
    const tmpDir = await Deno.makeTempDir()
    try {
      Deno.env.delete("LINEAR_API_KEY")
      Deno.env.set("LINEAR_WORKSPACE", "")
      // Write an empty credentials file so loadCredentials() resets the cached credentials
      await Deno.mkdir(`${tmpDir}/linear`, { recursive: true })
      await Deno.writeTextFile(`${tmpDir}/linear/credentials.toml`, "")
      Deno.env.set("XDG_CONFIG_HOME", tmpDir)
      await loadCredentials()
      await apiCommand.parse()
    } finally {
      Deno.env.delete("LINEAR_WORKSPACE")
      Deno.env.delete("XDG_CONFIG_HOME")
      await loadCredentials() // restore credentials from real path
      await Deno.remove(tmpDir, { recursive: true })
    }
  },
})

await cliffySnapshotTest({
  name: "API Command - Variable Coercion Null And False",
  meta: import.meta,
  colors: false,
  args: [
    "query GetIssues($active: Boolean, $label: String) { issues(filter: { active: $active, label: $label }) { nodes { title } } }",
    "--variable",
    "active=false",
    "--variable",
    "label=null",
  ],
  denoArgs,
  async fn() {
    const server = new MockLinearServer([
      {
        queryName: "GetIssues",
        variables: { active: false, label: null },
        response: {
          data: {
            issues: { nodes: [] },
          },
        },
      },
    ])

    try {
      await server.start()
      Deno.env.set("LINEAR_GRAPHQL_ENDPOINT", server.getEndpoint())
      Deno.env.set("LINEAR_API_KEY", "Bearer test-token")

      await apiCommand.parse()
    } finally {
      await server.stop()
      Deno.env.delete("LINEAR_GRAPHQL_ENDPOINT")
      Deno.env.delete("LINEAR_API_KEY")
    }
  },
})

await cliffySnapshotTest({
  name: "API Command - Value Containing Equals Sign",
  meta: import.meta,
  colors: false,
  args: [
    "query GetIssues($filter: String!) { issues(filter: $filter) { nodes { title } } }",
    "--variable",
    "filter=name eq backend",
  ],
  denoArgs,
  async fn() {
    const server = new MockLinearServer([
      {
        queryName: "GetIssues",
        variables: { filter: "name eq backend" },
        response: {
          data: {
            issues: { nodes: [{ title: "Test" }] },
          },
        },
      },
    ])

    try {
      await server.start()
      Deno.env.set("LINEAR_GRAPHQL_ENDPOINT", server.getEndpoint())
      Deno.env.set("LINEAR_API_KEY", "Bearer test-token")

      await apiCommand.parse()
    } finally {
      await server.stop()
      Deno.env.delete("LINEAR_GRAPHQL_ENDPOINT")
      Deno.env.delete("LINEAR_API_KEY")
    }
  },
})

await cliffySnapshotTest({
  name: "API Command - Paginate Single Page",
  meta: import.meta,
  colors: false,
  args: [
    "query GetIssues($after: String) { issues(first: 10, after: $after) { nodes { title } pageInfo { hasNextPage endCursor } } }",
    "--paginate",
  ],
  denoArgs,
  async fn() {
    const server = new MockLinearServer([
      {
        queryName: "GetIssues",
        variables: { after: null },
        response: {
          data: {
            issues: {
              nodes: [
                { title: "Only Issue" },
              ],
              pageInfo: {
                hasNextPage: false,
                endCursor: null,
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

      await apiCommand.parse()
    } finally {
      await server.stop()
      Deno.env.delete("LINEAR_GRAPHQL_ENDPOINT")
      Deno.env.delete("LINEAR_API_KEY")
    }
  },
})

await cliffySnapshotTest({
  name: "API Command - Paginate Non-Connection Query",
  meta: import.meta,
  colors: false,
  args: [
    "query GetViewer($after: String) { viewer { id name } }",
    "--paginate",
  ],
  denoArgs,
  canFail: true,
  async fn() {
    const server = new MockLinearServer([
      {
        queryName: "GetViewer",
        response: {
          data: {
            viewer: { id: "user-1", name: "Test" },
          },
        },
      },
    ])

    try {
      await server.start()
      Deno.env.set("LINEAR_GRAPHQL_ENDPOINT", server.getEndpoint())
      Deno.env.set("LINEAR_API_KEY", "Bearer test-token")

      await apiCommand.parse()
    } finally {
      await server.stop()
      Deno.env.delete("LINEAR_GRAPHQL_ENDPOINT")
      Deno.env.delete("LINEAR_API_KEY")
    }
  },
})

await cliffySnapshotTest({
  name: "API Command - File Not Found For Variable",
  meta: import.meta,
  colors: false,
  args: [
    "query GetTeam { team { name } }",
    "--variable",
    "filter=@/nonexistent/path.json",
  ],
  denoArgs,
  canFail: true,
  async fn() {
    Deno.env.set("LINEAR_API_KEY", "Bearer test-token")
    try {
      await apiCommand.parse()
    } finally {
      Deno.env.delete("LINEAR_API_KEY")
    }
  },
})

await cliffySnapshotTest({
  name: "API Command - Variables JSON",
  meta: import.meta,
  colors: false,
  args: [
    "query GetIssues($first: Int!, $active: Boolean!) { issues(first: $first, filter: { active: $active }) { nodes { title } } }",
    "--variables-json",
    '{"first": 5, "active": true}',
  ],
  denoArgs,
  async fn() {
    const server = new MockLinearServer([
      {
        queryName: "GetIssues",
        variables: { first: 5, active: true },
        response: {
          data: {
            issues: {
              nodes: [
                { title: "Issue One" },
                { title: "Issue Two" },
              ],
            },
          },
        },
      },
    ])

    try {
      await server.start()
      Deno.env.set("LINEAR_GRAPHQL_ENDPOINT", server.getEndpoint())
      Deno.env.set("LINEAR_API_KEY", "Bearer test-token")

      await apiCommand.parse()
    } finally {
      await server.stop()
      Deno.env.delete("LINEAR_GRAPHQL_ENDPOINT")
      Deno.env.delete("LINEAR_API_KEY")
    }
  },
})

await cliffySnapshotTest({
  name: "API Command - Variables JSON Malformed",
  meta: import.meta,
  colors: false,
  args: [
    "query GetViewer { viewer { id } }",
    "--variables-json",
    "{bad json",
  ],
  denoArgs,
  canFail: true,
  async fn() {
    Deno.env.set("LINEAR_API_KEY", "Bearer test-token")
    try {
      await apiCommand.parse()
    } finally {
      Deno.env.delete("LINEAR_API_KEY")
    }
  },
})

await cliffySnapshotTest({
  name: "API Command - Variables JSON Non-Object",
  meta: import.meta,
  colors: false,
  args: [
    "query GetViewer { viewer { id } }",
    "--variables-json",
    "[1, 2, 3]",
  ],
  denoArgs,
  canFail: true,
  async fn() {
    Deno.env.set("LINEAR_API_KEY", "Bearer test-token")
    try {
      await apiCommand.parse()
    } finally {
      Deno.env.delete("LINEAR_API_KEY")
    }
  },
})

await cliffySnapshotTest({
  name: "API Command - Silent Flag With HTTP Error",
  meta: import.meta,
  colors: false,
  args: [
    "query BadQuery { nonexistent { id } }",
    "--silent",
  ],
  denoArgs,
  canFail: true,
  async fn() {
    const server = new MockLinearServer([
      {
        queryName: "BadQuery",
        status: 400,
        response: {
          errors: [{
            message: "Cannot query field 'nonexistent' on type 'Query'",
            extensions: { code: "GRAPHQL_VALIDATION_FAILED" },
          }],
        },
      },
    ])

    try {
      await server.start()
      Deno.env.set("LINEAR_GRAPHQL_ENDPOINT", server.getEndpoint())
      Deno.env.set("LINEAR_API_KEY", "Bearer test-token")

      await apiCommand.parse()
    } finally {
      await server.stop()
      Deno.env.delete("LINEAR_GRAPHQL_ENDPOINT")
      Deno.env.delete("LINEAR_API_KEY")
    }
  },
})

await cliffySnapshotTest({
  name: "API Command - Variable Coercion Preserves Leading Zeros",
  meta: import.meta,
  colors: false,
  args: [
    "query GetIssue($id: String!) { issue(id: $id) { title } }",
    "--variable",
    "id=007",
  ],
  denoArgs,
  async fn() {
    const server = new MockLinearServer([
      {
        queryName: "GetIssue",
        variables: { id: "007" },
        response: {
          data: {
            issue: { title: "Issue 007" },
          },
        },
      },
    ])

    try {
      await server.start()
      Deno.env.set("LINEAR_GRAPHQL_ENDPOINT", server.getEndpoint())
      Deno.env.set("LINEAR_API_KEY", "Bearer test-token")

      await apiCommand.parse()
    } finally {
      await server.stop()
      Deno.env.delete("LINEAR_GRAPHQL_ENDPOINT")
      Deno.env.delete("LINEAR_API_KEY")
    }
  },
})

await cliffySnapshotTest({
  name: "API Command - Variable Coercion Preserves Scientific Notation",
  meta: import.meta,
  colors: false,
  args: [
    "query GetIssue($id: String!) { issue(id: $id) { title } }",
    "--variable",
    "id=1e5",
  ],
  denoArgs,
  async fn() {
    const server = new MockLinearServer([
      {
        queryName: "GetIssue",
        variables: { id: "1e5" },
        response: {
          data: {
            issue: { title: "Issue 1e5" },
          },
        },
      },
    ])

    try {
      await server.start()
      Deno.env.set("LINEAR_GRAPHQL_ENDPOINT", server.getEndpoint())
      Deno.env.set("LINEAR_API_KEY", "Bearer test-token")

      await apiCommand.parse()
    } finally {
      await server.stop()
      Deno.env.delete("LINEAR_GRAPHQL_ENDPOINT")
      Deno.env.delete("LINEAR_API_KEY")
    }
  },
})

await cliffySnapshotTest({
  name: "API Command - Paginate Multiple Connections Error",
  meta: import.meta,
  colors: false,
  args: [
    "query GetAll($after: String) { issues(first: 10, after: $after) { nodes { title } pageInfo { hasNextPage endCursor } } projects(first: 10, after: $after) { nodes { name } pageInfo { hasNextPage endCursor } } }",
    "--paginate",
  ],
  denoArgs,
  canFail: true,
  async fn() {
    const server = new MockLinearServer([
      {
        queryName: "GetAll",
        variables: { after: null },
        response: {
          data: {
            issues: {
              nodes: [{ title: "Issue 1" }],
              pageInfo: { hasNextPage: true, endCursor: "cursor-1" },
            },
            projects: {
              nodes: [{ name: "Project 1" }],
              pageInfo: { hasNextPage: true, endCursor: "cursor-2" },
            },
          },
        },
      },
    ])

    try {
      await server.start()
      Deno.env.set("LINEAR_GRAPHQL_ENDPOINT", server.getEndpoint())
      Deno.env.set("LINEAR_API_KEY", "Bearer test-token")

      await apiCommand.parse()
    } finally {
      await server.stop()
      Deno.env.delete("LINEAR_GRAPHQL_ENDPOINT")
      Deno.env.delete("LINEAR_API_KEY")
    }
  },
})

await cliffySnapshotTest({
  name: "API Command - Paginate With Nested Connections",
  meta: import.meta,
  colors: false,
  args: [
    "query GetIssues($after: String) { issues(first: 2, after: $after) { nodes { title subIssues { nodes { title } pageInfo { hasNextPage endCursor } } } pageInfo { hasNextPage endCursor } } }",
    "--paginate",
  ],
  denoArgs,
  async fn() {
    const server = new MockLinearServer([
      {
        queryName: "GetIssues",
        variables: { after: null },
        response: {
          data: {
            issues: {
              nodes: [
                {
                  title: "Parent Issue",
                  subIssues: {
                    nodes: [{ title: "Child Issue" }],
                    pageInfo: { hasNextPage: false, endCursor: null },
                  },
                },
              ],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        },
      },
    ])

    try {
      await server.start()
      Deno.env.set("LINEAR_GRAPHQL_ENDPOINT", server.getEndpoint())
      Deno.env.set("LINEAR_API_KEY", "Bearer test-token")

      await apiCommand.parse()
    } finally {
      await server.stop()
      Deno.env.delete("LINEAR_GRAPHQL_ENDPOINT")
      Deno.env.delete("LINEAR_API_KEY")
    }
  },
})

await cliffySnapshotTest({
  name: "API Command - Variable Overrides Variables JSON",
  meta: import.meta,
  colors: false,
  args: [
    "query GetIssues($first: Int!, $active: Boolean!) { issues(first: $first, filter: { active: $active }) { nodes { title } } }",
    "--variables-json",
    '{"first": 10, "active": false}',
    "--variable",
    "first=5",
  ],
  denoArgs,
  async fn() {
    const server = new MockLinearServer([
      {
        queryName: "GetIssues",
        variables: { first: 5, active: false },
        response: {
          data: {
            issues: {
              nodes: [
                { title: "Issue One" },
              ],
            },
          },
        },
      },
    ])

    try {
      await server.start()
      Deno.env.set("LINEAR_GRAPHQL_ENDPOINT", server.getEndpoint())
      Deno.env.set("LINEAR_API_KEY", "Bearer test-token")

      await apiCommand.parse()
    } finally {
      await server.stop()
      Deno.env.delete("LINEAR_GRAPHQL_ENDPOINT")
      Deno.env.delete("LINEAR_API_KEY")
    }
  },
})

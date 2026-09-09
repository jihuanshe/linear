import { assertEquals, assertMatch } from "@std/assert"
import { fromFileUrl, join } from "@std/path"
import { setupMockLinearServer } from "./utils/test-helpers.ts"
import { issueWriteBasis, issueWriteId } from "./utils/issue-write-fixtures.ts"

const main = fromFileUrl(new URL("../src/main.ts", import.meta.url))
const { denoDir } = JSON.parse(new TextDecoder().decode(
  (await new Deno.Command(Deno.execPath(), {
    args: ["info", "--json"],
    stdout: "piped",
  }).output()).stdout,
)) as { denoDir: string }

async function run(args: string[], env: Record<string, string> = {}) {
  const root = await Deno.makeTempDir()
  try {
    const result = await new Deno.Command(Deno.execPath(), {
      args: ["run", "--allow-all", "--quiet", main, ...args],
      stdout: "piped",
      stderr: "piped",
      stdin: "null",
      clearEnv: true,
      env: {
        HOME: root,
        XDG_CONFIG_HOME: join(root, "config"),
        APPDATA: join(root, "config"),
        DENO_DIR: denoDir,
        PATH: Deno.env.get("PATH") ?? "",
        TERM: "xterm-256color",
        ...env,
      },
    }).output()
    const decoder = new TextDecoder()
    return {
      code: result.code,
      stdout: decoder.decode(result.stdout),
      stderr: decoder.decode(result.stderr),
    }
  } finally {
    await Deno.remove(root, { recursive: true })
  }
}

Deno.test("main writes explicit help to stdout with rc 0", async () => {
  const result = await run(["--help"])
  assertEquals(result.code, 0)
  assertMatch(result.stdout, /Usage:\s+linear/)
  assertEquals(result.stderr, "")
})

Deno.test("startup credentials warning honors disabled color policy", async () => {
  const root = await Deno.makeTempDir()
  try {
    const config = join(root, "linear")
    await Deno.mkdir(config, { recursive: true })
    await Deno.writeTextFile(
      join(config, "credentials.toml"),
      'default = "missing"\nworkspaces = ["present"]\n',
    )
    const result = await run(["--help"], {
      HOME: join(root, "home"),
      XDG_CONFIG_HOME: root,
      NO_COLOR: "",
    })
    assertMatch(result.stderr, /Default workspace "missing"/)
    assertEquals(result.stderr.includes("\x1b"), false)
  } finally {
    await Deno.remove(root, { recursive: true })
  }
})

for (
  const [name, args] of [
    ["unknown flag", ["--not-a-real-flag"]],
    ["unknown command", ["not-a-real-command"]],
  ] as const
) {
  Deno.test(`main sends ${name} usage errors only to stderr`, async () => {
    const result = await run([...args])
    assertEquals(result.code, 1)
    assertEquals(result.stdout, "")
    assertMatch(result.stderr, /Unknown (option|command)/)
  })
}

for (
  const args of [
    ["--not-a-real-flag", "--json"],
    ["not-a-real-command", "--json"],
    ["issue", "update", "ENG-123", "--priority", "not-a-number", "--json"],
    ["issue", "update", "ENG-123", "--title", "Desired", "--json"],
    ["issue", "create", "--json"],
    ["api", "--variable", "badformat"],
    ["api"],
    ["--workspace", "sandbox", "api", "--variables-json"],
    ["--workspace=sandbox", "api", "--operation-name"],
  ]
) {
  Deno.test(`main returns one machine failure for ${args.join(" ")}`, async () => {
    const result = await run(args, {
      LINEAR_API_KEY: "test-token",
      LINEAR_GRAPHQL_ENDPOINT: "http://127.0.0.1:1/graphql",
      NO_COLOR: "1",
    })
    assertEquals(result.code, 1)
    const failure = JSON.parse(result.stdout)
    assertEquals(failure.ok, false)
    assertEquals(failure.effect, "none")
    assertEquals(typeof failure.error.code, "string")
    assertEquals(typeof failure.error.message, "string")
    assertEquals(result.stderr, "")
  })
}

for (
  const [name, env] of [
    ["NO_COLOR", { NO_COLOR: "" }],
    ["TERM=dumb", { TERM: "dumb" }],
    ["CLICOLOR=0", { CLICOLOR: "0" }],
  ] as const
) {
  Deno.test(`non-TTY main help has no terminal escapes with ${name}`, async () => {
    const result = await run(["--help"], env)
    assertEquals(result.code, 0)
    assertEquals((result.stdout + result.stderr).includes("\x1b"), false)
  })
}

Deno.test("main rejects disabled prompts without reading stdin", async () => {
  const { server, cleanup } = await setupMockLinearServer([
    {
      queryName: "GetTeamIdByKey",
      variables: { team: "SOURCE" },
      response: {
        data: { teams: { nodes: [{ id: "source-team-id" }] } },
      },
    },
    {
      queryName: "GetTeamDetails",
      variables: { id: "source-team-id" },
      response: {
        data: {
          team: {
            id: "source-team-id",
            key: "SOURCE",
            name: "Source Team",
            issueCount: 0,
          },
        },
      },
    },
  ])

  try {
    const result = await run(["team", "delete", "SOURCE"], {
      LINEAR_API_KEY: "Bearer test-token",
      LINEAR_GRAPHQL_ENDPOINT: server.getEndpoint(),
      LINEAR_PROMPT_DISABLED: "1",
      NO_COLOR: "1",
    })

    assertEquals(result.code, 1)
    assertEquals(result.stdout, "")
    assertMatch(
      result.stderr,
      /Interactive prompting is disabled by LINEAR_PROMPT_DISABLED/,
    )
    assertMatch(result.stderr, /Use --force/)
  } finally {
    await cleanup()
  }
})

Deno.test("main emits one write result for issue update --json", async () => {
  const issueUpdate = {
    success: true,
    issue: {
      id: issueWriteId,
      identifier: "ENG-123",
      url: "https://linear.app/acme/issue/ENG-123/renamed",
      title: "Renamed",
      labels: {
        nodes: [{ id: "label-1", name: "Bug" }],
        pageInfo: { hasNextPage: false, endCursor: null },
      },
    },
  }
  const { server, cleanup } = await setupMockLinearServer([
    { queryName: "GetIssueForWrite", response: { data: issueWriteBasis() } },
    {
      queryName: "UpdateIssue",
      variables: { id: issueWriteId, input: { title: "Renamed" } },
      response: { data: { issueUpdate } },
    },
  ])

  try {
    const result = await run([
      "issue",
      "update",
      "ENG-123",
      "--unprotected",
      "--title",
      "Renamed",
      "--json",
    ], {
      LINEAR_API_KEY: "Bearer test-token",
      LINEAR_GRAPHQL_ENDPOINT: server.getEndpoint(),
      LINEAR_PROMPT_DISABLED: "1",
      NO_COLOR: "1",
    })

    assertEquals(result.code, 0, result.stderr)
    const parsed = JSON.parse(result.stdout)
    assertEquals(parsed.ok, true)
    assertEquals(parsed.effect, "applied")
    assertEquals(parsed.data, issueUpdate)
    assertEquals(result.stderr, "")
  } finally {
    await cleanup()
  }
})

Deno.test("global workspace selection does not change label --all scope", async () => {
  const root = await Deno.makeTempDir()
  const configRoot = join(root, "config")
  const credentialsDir = join(configRoot, "linear")
  await Deno.mkdir(credentialsDir, { recursive: true })
  await Deno.writeTextFile(
    join(credentialsDir, "credentials.toml"),
    'default = "sandbox"\nsandbox = "Bearer test-token"\n',
  )
  const label = {
    id: "team-label-id",
    name: "Team label",
    description: null,
    color: "#5E6AD2",
    team: { key: "ENG", name: "Engineering" },
  }
  const { server, cleanup } = await setupMockLinearServer([{
    queryName: "GetIssueLabels",
    variables: { filter: undefined, first: 100, after: undefined },
    response: {
      data: {
        issueLabels: {
          nodes: [label],
          pageInfo: { hasNextPage: false, endCursor: null },
        },
      },
    },
  }])

  try {
    const result = await run([
      "--workspace",
      "sandbox",
      "label",
      "list",
      "--all",
      "--json",
    ], {
      HOME: join(root, "home"),
      XDG_CONFIG_HOME: configRoot,
      LINEAR_API_KEY: "",
      LINEAR_GRAPHQL_ENDPOINT: server.getEndpoint(),
      NO_COLOR: "1",
    })

    assertEquals(result.code, 0, result.stderr)
    assertEquals(JSON.parse(result.stdout).nodes, [label])
    assertEquals(result.stderr, "")
  } finally {
    await cleanup()
    await Deno.remove(root, { recursive: true })
  }
})

Deno.test("label list workspace-labels uses the workspace label filter", async () => {
  const { server, cleanup } = await setupMockLinearServer([{
    queryName: "GetIssueLabels",
    variables: {
      filter: { team: { null: true } },
      first: 100,
      after: undefined,
    },
    response: {
      data: {
        issueLabels: {
          nodes: [],
          pageInfo: { hasNextPage: false, endCursor: null },
        },
      },
    },
  }])

  try {
    const result = await run([
      "label",
      "list",
      "--workspace-labels",
      "--json",
    ], {
      LINEAR_API_KEY: "Bearer test-token",
      LINEAR_GRAPHQL_ENDPOINT: server.getEndpoint(),
      NO_COLOR: "1",
    })

    assertEquals(result.code, 0, result.stderr)
    assertEquals(JSON.parse(result.stdout).nodes, [])
    assertEquals(result.stderr, "")
  } finally {
    await cleanup()
  }
})

Deno.test("label list rejects conflicting scopes", async () => {
  const result = await run([
    "label",
    "list",
    "--workspace-labels",
    "--all",
    "--json",
  ], {
    LINEAR_API_KEY: "Bearer test-token",
    NO_COLOR: "1",
  })

  assertEquals(result.code, 1)
  const failure = JSON.parse(result.stdout)
  assertEquals(failure.ok, false)
  assertEquals(failure.effect, "none")
  assertMatch(failure.error.message, /Only one label scope can be specified/)
  assertMatch(failure.error.suggestion, /--team, --workspace-labels, or --all/)
  assertEquals(result.stderr, "")
})

Deno.test("label list rejects the old bare workspace flag with migration guidance", async () => {
  const result = await run([
    "label",
    "list",
    "--workspace",
    "--json",
  ])

  assertEquals(result.code, 1)
  const failure = JSON.parse(result.stdout)
  assertEquals(failure.ok, false)
  assertEquals(failure.effect, "none")
  assertMatch(failure.error.message, /Missing value for option "--workspace"/)
  assertMatch(failure.error.message, /--workspace-labels/)
  assertEquals(result.stderr, "")
})

Deno.test("team delete dry-run requires an empty team and points to the migration recipe", async () => {
  const { server, cleanup } = await setupMockLinearServer([
    {
      queryName: "GetTeamIdByKey",
      variables: { team: "SOURCE" },
      response: {
        data: { teams: { nodes: [{ id: "source-team-id" }] } },
      },
    },
    {
      queryName: "GetTeamDetails",
      variables: { id: "source-team-id" },
      response: {
        data: {
          team: {
            id: "source-team-id",
            key: "SOURCE",
            name: "Source Team",
            issueCount: 2,
          },
        },
      },
    },
  ])

  try {
    const result = await run([
      "team",
      "delete",
      "SOURCE",
      "--dry-run",
    ], {
      LINEAR_API_KEY: "Bearer test-token",
      LINEAR_GRAPHQL_ENDPOINT: server.getEndpoint(),
      LINEAR_PROMPT_DISABLED: "1",
      NO_COLOR: "1",
    })

    assertEquals(result.code, 1)
    assertEquals(result.stdout, "")
    assertMatch(result.stderr, /deletion requires an empty team/)
    assertMatch(result.stderr, /linear recipe migrate-team/)
    assertEquals(result.stderr.includes("prompt"), false)
  } finally {
    await cleanup()
  }
})

Deno.test("team delete rejects the retired implicit migration option before requests", async () => {
  const result = await run([
    "team",
    "delete",
    "SOURCE",
    "--move-issues",
    "TARGET",
    "--json",
  ])
  assertEquals(result.code, 1)
  const failure = JSON.parse(result.stdout)
  assertEquals(failure.ok, false)
  assertEquals(failure.effect, "none")
  assertMatch(failure.error.message, /Unknown option.*move-issues/)
  assertEquals(result.stderr, "")
})

Deno.test("team delete rechecks current emptiness before its mutation", async () => {
  let reads = 0
  const { server, cleanup } = await setupMockLinearServer([
    {
      queryName: "GetTeamIdByKey",
      response: {
        data: {
          teams: {
            nodes: [{ id: "source-team-id" }],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      },
    },
    {
      queryName: "GetTeamDetails",
      response: () => ({
        data: {
          team: {
            id: "source-team-id",
            key: "SOURCE",
            name: "Source",
            issueCount: ++reads === 1 ? 0 : 1,
          },
        },
      }),
    },
  ])
  try {
    const result = await run(
      ["team", "delete", "SOURCE", "--force", "--json"],
      {
        LINEAR_API_KEY: "test-token",
        LINEAR_GRAPHQL_ENDPOINT: server.getEndpoint(),
        NO_COLOR: "1",
      },
    )
    assertEquals(result.code, 1)
    const failure = JSON.parse(result.stdout)
    assertEquals(failure.effect, "none")
    assertMatch(failure.error.message, /deletion requires an empty team/)
    assertEquals(reads, 2)
    assertEquals(
      server.graphqlRequests.filter((request) =>
        request.query.includes("mutation ")
      ),
      [],
    )
  } finally {
    await cleanup()
  }
})

for (const payload of [{ success: false }, null]) {
  Deno.test(
    "team delete unconfirmed payload retains unknown effect: " +
      JSON.stringify(payload),
    async () => {
      const { server, cleanup } = await setupMockLinearServer([
        {
          queryName: "GetTeamIdByKey",
          response: {
            data: {
              teams: {
                nodes: [{ id: "source-team-id" }],
                pageInfo: { hasNextPage: false, endCursor: null },
              },
            },
          },
        },
        {
          queryName: "GetTeamDetails",
          response: {
            data: {
              team: {
                id: "source-team-id",
                key: "SOURCE",
                name: "Source",
                issueCount: 0,
              },
            },
          },
        },
        {
          queryName: "DeleteTeam",
          response: { data: { teamDelete: payload } },
        },
      ])
      try {
        const result = await run([
          "team",
          "delete",
          "SOURCE",
          "--force",
          "--json",
        ], {
          LINEAR_API_KEY: "test-token",
          LINEAR_GRAPHQL_ENDPOINT: server.getEndpoint(),
          NO_COLOR: "1",
        })
        assertEquals(result.code, 1)
        assertEquals(JSON.parse(result.stdout).effect, "unknown")
        assertEquals(
          server.graphqlRequests.filter((request) =>
            request.query.includes("mutation ")
          ).length,
          1,
        )
      } finally {
        await cleanup()
      }
    },
  )
}

Deno.test("auth login skips post-write migration prompts when disabled", async () => {
  const root = await Deno.makeTempDir()
  const configRoot = join(root, "config")
  const credentialsDir = join(configRoot, "linear")
  await Deno.mkdir(credentialsDir, { recursive: true })
  await Deno.writeTextFile(
    join(credentialsDir, "credentials.toml"),
    'default = "existing"\nexisting = "lin_api_existing"\n',
  )
  const { server, cleanup } = await setupMockLinearServer([{
    queryName: "AuthLoginViewer",
    response: {
      data: {
        viewer: {
          name: "Sam",
          email: "sam@acme.test",
          organization: { name: "Acme", urlKey: "acme" },
        },
      },
    },
  }])

  try {
    const result = await run([
      "auth",
      "login",
      "--key",
      "lin_api_test",
      "--plaintext",
    ], {
      HOME: join(root, "home"),
      XDG_CONFIG_HOME: configRoot,
      LINEAR_GRAPHQL_ENDPOINT: server.getEndpoint(),
      LINEAR_PROMPT_DISABLED: "1",
      NO_COLOR: "1",
    })

    assertEquals(result.code, 0, result.stderr)
    assertMatch(result.stdout, /Logged in to workspace: Acme \(acme\)/)
    assertEquals(result.stderr, "")
    if (Deno.build.os !== "windows") {
      const stat = await Deno.stat(join(credentialsDir, "credentials.toml"))
      assertEquals(stat.mode! & 0o777, 0o600)
    }
  } finally {
    await cleanup()
    await Deno.remove(root, { recursive: true })
  }
})

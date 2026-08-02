import { assertEquals, assertMatch } from "@std/assert"
import { fromFileUrl, join } from "@std/path"
import { setupMockLinearServer } from "./utils/test-helpers.ts"

const main = fromFileUrl(new URL("../src/main.ts", import.meta.url))

async function run(args: string[], env: Record<string, string> = {}) {
  const result = await new Deno.Command(Deno.execPath(), {
    args: ["run", "--allow-all", "--quiet", main, ...args],
    stdout: "piped",
    stderr: "piped",
    clearEnv: true,
    env: {
      HOME: Deno.env.get("HOME") ?? "",
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
    assertEquals(result.code, 2)
    assertEquals(result.stdout, "")
    assertMatch(result.stderr, /Unknown (option|command)/)
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

Deno.test("main emits only the issueUpdate payload for issue update --json", async () => {
  const issueUpdate = {
    success: true,
    issue: {
      id: "issue-123",
      identifier: "ENG-123",
      url: "https://linear.app/acme/issue/ENG-123/renamed",
      title: "Renamed",
      labels: {
        nodes: [{ id: "label-1", name: "Bug" }],
        pageInfo: { hasNextPage: false, endCursor: null },
      },
    },
  }
  const { server, cleanup } = await setupMockLinearServer([{
    queryName: "UpdateIssue",
    variables: { id: "ENG-123", input: { title: "Renamed" } },
    response: { data: { issueUpdate } },
  }])

  try {
    const result = await run([
      "issue",
      "update",
      "ENG-123",
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
    assertEquals(JSON.parse(result.stdout), issueUpdate)
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
  assertEquals(result.stdout, "")
  assertMatch(result.stderr, /Only one label scope can be specified/)
  assertMatch(result.stderr, /--team, --workspace-labels, or --all/)
})

Deno.test("label list rejects the old bare workspace flag with migration guidance", async () => {
  const result = await run([
    "label",
    "list",
    "--workspace",
    "--json",
  ])

  assertEquals(result.code, 2)
  assertEquals(result.stdout, "")
  assertMatch(result.stderr, /Missing value for option "--workspace"/)
  assertMatch(result.stderr, /--workspace-labels/)
})

Deno.test("team delete dry-run never prompts when a move target is required", async () => {
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
    assertMatch(result.stderr, /must be moved before deletion/)
    assertMatch(result.stderr, /Use --move-issues <teamKey>/)
    assertEquals(result.stderr.includes("prompt"), false)
  } finally {
    await cleanup()
  }
})

Deno.test("team delete validates an explicit move target for an empty team", async () => {
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
    {
      queryName: "GetTeamIdByKey",
      variables: { team: "MISSING" },
      response: { data: { teams: { nodes: [] } } },
    },
  ])

  try {
    const result = await run([
      "team",
      "delete",
      "SOURCE",
      "--move-issues",
      "MISSING",
      "--dry-run",
    ], {
      LINEAR_API_KEY: "Bearer test-token",
      LINEAR_GRAPHQL_ENDPOINT: server.getEndpoint(),
      LINEAR_PROMPT_DISABLED: "1",
      NO_COLOR: "1",
    })

    assertEquals(result.code, 1)
    assertEquals(result.stdout, "")
    assertMatch(result.stderr, /Target team not found: MISSING/)
  } finally {
    await cleanup()
  }
})

Deno.test("team delete preserves completed mappings on a later move failure", async () => {
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
    {
      queryName: "GetTeamIdByKey",
      variables: { team: "TARGET" },
      response: {
        data: { teams: { nodes: [{ id: "target-team-id" }] } },
      },
    },
    {
      queryName: "GetTeamIssuesForMove",
      variables: {
        teamId: "source-team-id",
        first: 100,
        after: undefined,
      },
      response: {
        data: {
          team: {
            issues: {
              nodes: [
                { id: "issue-1", identifier: "SOURCE-1" },
                { id: "issue-2", identifier: "SOURCE-2" },
              ],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        },
      },
    },
    {
      queryName: "MoveIssueToTeam",
      variables: { id: "issue-1", teamId: "target-team-id" },
      response: {
        data: {
          issueUpdate: {
            success: true,
            issue: { identifier: "TARGET-41" },
          },
        },
      },
    },
    {
      queryName: "MoveIssueToTeam",
      variables: { id: "issue-2", teamId: "target-team-id" },
      response: {
        data: { issueUpdate: { success: false, issue: null } },
      },
    },
  ])

  try {
    const result = await run([
      "team",
      "delete",
      "SOURCE",
      "--move-issues",
      "TARGET",
      "--force",
    ], {
      LINEAR_API_KEY: "Bearer test-token",
      LINEAR_GRAPHQL_ENDPOINT: server.getEndpoint(),
      LINEAR_PROMPT_DISABLED: "1",
      NO_COLOR: "1",
    })

    assertEquals(result.code, 1)
    assertEquals(result.stdout, "✓ Moved SOURCE-1 → TARGET-41\n")
    assertMatch(result.stderr, /Failed to move issue SOURCE-2/)
  } finally {
    await cleanup()
  }
})

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

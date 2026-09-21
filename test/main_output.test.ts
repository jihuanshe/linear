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

Deno.test("semantic scalar commands expose identifier and API key without legacy aliases", async () => {
  const key = await run(["auth", "key"], {
    LINEAR_API_KEY: "synthetic-api-key",
  })
  assertEquals(key.code, 0, key.stderr)
  assertEquals(key.stdout, "synthetic-api-key\n")
  assertEquals(key.stderr, "")
  for (const args of [["auth", "token"], ["issue", "id"]]) {
    const result = await run(args)
    assertEquals(result.code, 1)
    assertEquals(result.stdout, "")
    assertMatch(result.stderr, /Unknown command/)
  }

  const root = await Deno.makeTempDir()
  try {
    const git = await new Deno.Command("git", {
      args: ["init", "--quiet", "--initial-branch=eng-731-handoff"],
      cwd: root,
      stdout: "piped",
      stderr: "piped",
    }).output()
    assertEquals(git.code, 0, new TextDecoder().decode(git.stderr))
    const result = await new Deno.Command(Deno.execPath(), {
      args: [
        "run",
        "--allow-all",
        "--quiet",
        "--config",
        fromFileUrl(new URL("../deno.json", import.meta.url)),
        main,
        "issue",
        "identifier",
      ],
      cwd: root,
      clearEnv: true,
      env: {
        HOME: root,
        XDG_CONFIG_HOME: root,
        APPDATA: root,
        DENO_DIR: denoDir,
        PATH: Deno.env.get("PATH") ?? "",
        SystemRoot: Deno.env.get("SystemRoot") ?? "",
        LINEAR_VCS: "git",
      },
      stdout: "piped",
      stderr: "piped",
    }).output()
    assertEquals(result.code, 0, new TextDecoder().decode(result.stderr))
    assertEquals(new TextDecoder().decode(result.stdout), "ENG-731\n")
    assertEquals(result.stderr.length, 0)
  } finally {
    await Deno.remove(root, { recursive: true })
  }
})

Deno.test("main leaf help includes JSON aliases injected by the root command", async () => {
  const result = await run(["document", "view", "--help"])
  assertEquals(result.code, 0)
  assertMatch(result.stdout, /Usage:\s+linear document view/)
  assertMatch(result.stdout, /-j,\s+--json\b/)
  assertEquals(result.stderr, "")
})

Deno.test("credential inventory warning honors disabled color policy", async () => {
  const root = await Deno.makeTempDir()
  try {
    const config = join(root, "linear")
    await Deno.mkdir(config, { recursive: true })
    await Deno.writeTextFile(
      join(config, "credentials.toml"),
      'default = "missing"\nworkspaces = ["present"]\n',
    )
    const result = await run(["auth", "list"], {
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
  const { path, flag, legacyFlag, values, queryName, field, filter } of [
    {
      path: ["issue", "query"],
      flag: "--state-type",
      legacyFlag: "--state",
      values: ["unstarted", "started"],
      queryName: "GetIssuesForQuery",
      field: "issues",
      filter: { state: { type: { in: ["unstarted", "started"] } } },
    },
    {
      path: ["project", "list"],
      flag: "--status-name",
      legacyFlag: "--status",
      values: ["In Progress"],
      queryName: "GetProjects",
      field: "projects",
      filter: { status: { name: { eq: "In Progress" } } },
    },
  ]
) {
  Deno.test(`main forwards ${path.join(" ")} ${flag} and rejects ${legacyFlag} before requests`, async () => {
    const connection = {
      nodes: [],
      pageInfo: { hasNextPage: false, endCursor: null },
    }
    const { server, cleanup } = await setupMockLinearServer([{
      queryName,
      response: { data: { [field]: connection } },
    }])
    const env = {
      LINEAR_API_KEY: "test-token",
      LINEAR_GRAPHQL_ENDPOINT: server.getEndpoint(),
      NO_COLOR: "1",
    }
    try {
      const rejected = await run([
        ...path,
        "--all-teams",
        legacyFlag,
        values[0],
        "--json",
      ], env)
      assertEquals(rejected.code, 1, rejected.stdout + rejected.stderr)
      assertEquals(rejected.stderr, "")
      const failure = JSON.parse(rejected.stdout)
      assertEquals(failure.ok, false)
      assertEquals(failure.effect, "none")
      assertMatch(failure.error.message, /Unknown option/)
      assertEquals(failure.error.message.includes(legacyFlag), true)
      assertEquals(server.graphqlRequests, [])

      const result = await run([
        ...path,
        "--all-teams",
        ...values.flatMap((value) => [flag, value]),
        "--json",
      ], env)
      assertEquals(result.code, 0, result.stdout + result.stderr)
      assertEquals(result.stderr, "")
      assertEquals(JSON.parse(result.stdout), connection)
      assertEquals(server.graphqlRequests.length, 1)
      assertEquals(server.graphqlRequests[0].variables.filter, filter)
    } finally {
      await cleanup()
    }
  })
}

for (
  const args of [
    ["--not-a-real-flag", "--json"],
    ["not-a-real-command", "--json"],
    ["issue", "update", "ENG-123", "--priority", "not-a-number", "--json"],
    ["issue", "update", "ENG-123", "--title", "Desired", "--json"],
    ["issue", "create", "--json"],
    ["api", "--variables-json", "not-json"],
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
      queryName: "GetWriteTeamByKey",
      variables: { key: "SOURCE" },
      response: {
        data: {
          teams: {
            nodes: [{ id: "source-team-id", key: "SOURCE" }],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
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
    assertMatch(result.stderr, /Use --yes/)
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
  const current = issueWriteBasis()
  const { server, cleanup } = await setupMockLinearServer([
    { queryName: "GetIssueForWrite", response: () => ({ data: current }) },
    {
      queryName: "UpdateIssue",
      variables: { id: issueWriteId, input: { title: "Renamed" } },
      response: () => {
        current.issue.title = "Renamed"
        return { data: { issueUpdate } }
      },
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

Deno.test("global workspace requires a value through the command parser", async () => {
  const result = await run([
    "--json",
    "label",
    "list",
    "--workspace",
  ])

  assertEquals(result.code, 1)
  const failure = JSON.parse(result.stdout)
  assertEquals(failure.ok, false)
  assertEquals(failure.effect, "none")
  assertMatch(failure.error.message, /Missing value for option "--workspace"/)
  assertEquals(result.stderr, "")
})

Deno.test("team delete dry-run requires an empty team and points to the migration recipe", async () => {
  const { server, cleanup } = await setupMockLinearServer([
    {
      queryName: "GetWriteTeamByKey",
      variables: { key: "SOURCE" },
      response: {
        data: {
          teams: {
            nodes: [{ id: "source-team-id", key: "SOURCE" }],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
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
      queryName: "GetWriteTeamByKey",
      response: {
        data: {
          teams: {
            nodes: [{ id: "source-team-id", key: "SOURCE" }],
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
      ["team", "delete", "SOURCE", "--yes", "--json"],
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
          queryName: "GetWriteTeamByKey",
          response: {
            data: {
              teams: {
                nodes: [{ id: "source-team-id", key: "SOURCE" }],
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
          "--yes",
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

Deno.test("global JSON works before, between and after aliased command paths", async () => {
  const { server, cleanup } = await setupMockLinearServer([{
    queryName: "GetIssueLabels",
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
    for (const json of ["--json", "-j"]) {
      for (
        const args of [
          [json, "l", "list", "--all"],
          ["l", json, "list", "--all"],
          ["l", "list", json, "--all"],
          ["l", "list", "--all", json],
        ]
      ) {
        const result = await run(args, {
          LINEAR_API_KEY: "test-token",
          LINEAR_GRAPHQL_ENDPOINT: server.getEndpoint(),
        })
        assertEquals(result.code, 0, JSON.stringify(result))
        assertEquals(JSON.parse(result.stdout), {
          nodes: [],
          pageInfo: { hasNextPage: false, endCursor: null },
        })
        assertEquals(result.stderr, "")
      }
    }
    assertEquals(server.graphqlRequests.length, 8)
  } finally {
    await cleanup()
  }
})

Deno.test("global JSON navigation reuses the live usage document at every depth", async () => {
  for (
    const path of [
      [],
      ["i"],
      ["doc"],
      ["issue", "comment"],
      ["issue", "relation"],
    ]
  ) {
    const [navigation, usage] = await Promise.all([
      run(["--json", ...path]),
      run([...path, "usage", "-j"]),
    ])
    assertEquals(navigation.code, 0, JSON.stringify(navigation))
    assertEquals(usage.code, 0, JSON.stringify(usage))
    assertEquals(JSON.parse(navigation.stdout), JSON.parse(usage.stdout))
    assertEquals(JSON.parse(navigation.stdout).command.outputModes, [
      "human",
      "json",
    ])
    assertEquals(navigation.stderr + usage.stderr, "")
  }
})

Deno.test("global JSON rejects unsupported actions without requests or credential changes", async () => {
  const root = await Deno.makeTempDir()
  const credentials = join(root, "linear", "credentials.toml")
  await Deno.mkdir(join(root, "linear"))
  const original = 'default = "sandbox"\nsandbox = "test-token"\n'
  await Deno.writeTextFile(credentials, original)
  const { server, cleanup } = await setupMockLinearServer([])
  try {
    for (
      const args of [
        ["auth", "login", "--key", "lin_api_test", "--plaintext"],
        ["auth", "logout", "sandbox", "--yes"],
        ["auth", "default", "sandbox"],
        ["auth", "migrate"],
        ["auth", "list"],
        ["auth", "key"],
        ["config"],
        ["update"],
        ["issue", "pick"],
        ["issue", "identifier"],
        ["issue", "title"],
        ["issue", "url"],
        ["cycle", "list"],
        ["cycle", "view", "active"],
        ["team", "key"],
        ["completions"],
        ["completions", "bash"],
        ["completions", "fish"],
        ["completions", "zsh"],
        ["completions", "complete", "command"],
      ]
    ) {
      for (const argv of [["--json", ...args], [...args, "-j"]]) {
        const result = await run(argv, {
          XDG_CONFIG_HOME: root,
          LINEAR_API_KEY: "test-token",
          LINEAR_GRAPHQL_ENDPOINT: server.getEndpoint(),
        })
        assertEquals(result.code, 1, JSON.stringify(result))
        if (args[0] === "completions" && argv.at(-1) === "-j") {
          assertEquals(result.stdout, "")
          assertMatch(result.stderr, /Unknown (option|command) "-j"/)
          continue
        }
        const failure = JSON.parse(result.stdout)
        assertEquals(failure.effect, "none")
        assertEquals(
          failure.error.code,
          "UnsupportedOutputError",
          argv.join(" "),
        )
        assertMatch(failure.error.suggestion, /usage --json/)
        assertEquals(result.stderr, "")
        assertEquals(await Deno.readTextFile(credentials), original)
      }
    }
    assertEquals(server.graphqlRequests, [])
  } finally {
    await cleanup()
    await Deno.remove(root, { recursive: true })
  }
})

Deno.test("JSON rejects browser, editor and exclusive output selections before requests", async () => {
  const { server, cleanup } = await setupMockLinearServer([])
  try {
    for (
      const args of [
        ["issue", "view", "ENG-123", "--web"],
        ["issue", "view", "ENG-123", "--app"],
        ["team", "list", "--web"],
        ["project", "list", "--app"],
        ["project", "view", "project-1", "--web"],
        ["initiative", "list", "--app"],
        ["initiative", "view", "initiative-1", "--web"],
        ["document", "view", "document-1", "--web"],
        ["document", "view", "document-1", "--raw"],
        ["document", "update", "document-1", "--edit"],
        ["document", "create", "--interactive"],
        ["project", "create", "--interactive"],
        ["initiative", "update", "initiative-1", "--interactive"],
        ["recipe", "migrate-team", "--source"],
      ]
    ) {
      // Test inherited and locally shadowed option actions separately.
      for (const argv of [["--json", ...args], [...args, "-j"]]) {
        const result = await run(argv, {
          LINEAR_API_KEY: "test-token",
          LINEAR_GRAPHQL_ENDPOINT: server.getEndpoint(),
        })
        assertEquals(result.code, 1, JSON.stringify(result))
        const failure = JSON.parse(result.stdout)
        assertEquals(failure.effect, "none")
        assertEquals(failure.error.code, "ValidationError", argv.join(" "))
        assertMatch(failure.error.message, /--json cannot be combined with/)
        assertEquals(result.stderr, "")
      }
    }
    assertEquals(server.graphqlRequests, [])
  } finally {
    await cleanup()
  }
})

Deno.test("help and version never leak human output when JSON is requested", async () => {
  for (
    const args of [
      ["--json", "--help"],
      ["--help", "--json"],
      ["-hj"],
      ["-jh"],
      ["--json", "--version"],
      ["--version", "--json"],
      ["-Vj"],
      ["-jV"],
      ["--json", "issue", "view", "--help"],
      ["issue", "--json", "view", "--help"],
      ["issue", "view", "--help", "--json"],
      ["issue", "view", "-jh"],
      ["--json", "auth", "login", "--help"],
    ]
  ) {
    const result = await run(args)
    assertEquals(result.code, 1, JSON.stringify(result))
    const failure = JSON.parse(result.stdout)
    assertEquals(failure.ok, false)
    assertEquals(failure.effect, "none")
    assertEquals(result.stderr, "")
  }
})

Deno.test("JSON selection respects parser values, invalid assignments and -- literals", async () => {
  for (
    const args of [
      ["--json=true"],
      ["--json=false"],
      ["--json="],
      ["-j=1"],
      ["issue", "view", "--json=garbage"],
      ["issue", "view", "ENG-123", "-jw"],
      ["issue", "view", "ENG-123", "-wj"],
      ["issue", "query", "--limit", "bad", "-j"],
      ["--json", "api", "--variables-json"],
    ]
  ) {
    const result = await run(args)
    assertEquals(result.code, 1, JSON.stringify(result))
    assertEquals(JSON.parse(result.stdout).effect, "none")
    assertEquals(result.stderr, "")
  }
  for (
    const args of [
      ["--workspace", "--json", "version"],
      ["--workspace", "-j", "version"],
      ["version", "--", "--json", "-j"],
    ]
  ) {
    const result = await run(args)
    assertEquals(result.code, 0, JSON.stringify(result))
    assertMatch(result.stdout, /^distribution: jihuanshe\/linear\nversion:/)
    assertEquals(result.stderr, "")
  }
  for (
    const args of [
      ["issue", "update", "ENG-123", "--title", "--json"],
      ["issue", "update", "ENG-123", "--title", "-j"],
      ["issue", "update", "ENG-123", "--title=--json"],
      ["not-a-command", "--", "--json", "-j"],
    ]
  ) {
    const result = await run(args)
    assertEquals(result.code, 1)
    assertEquals(result.stdout, "", JSON.stringify(result))
    assertEquals(result.stderr.length > 0, true)
  }
})

Deno.test("malformed configuration preserves machine errors for global JSON and raw API", async () => {
  const root = await Deno.makeTempDir()
  await Deno.mkdir(join(root, "linear"))
  await Deno.writeTextFile(join(root, "linear", "linear.toml"), "invalid = [")
  try {
    for (
      const args of [
        ["--json", "team", "list"],
        ["issue", "view", "ENG-123", "-j"],
        ["--workspace", "sandbox", "api", "{ viewer { id } }"],
        ["--json", "api", "{ viewer { id } }"],
      ]
    ) {
      const result = await run(args, { XDG_CONFIG_HOME: root })
      assertEquals(result.code, 1)
      const failure = JSON.parse(result.stdout)
      assertEquals(failure.effect, "none")
      assertMatch(failure.error.message, /Failed to parse config file/)
      assertEquals(result.stderr, "")
    }
  } finally {
    await Deno.remove(root, { recursive: true })
  }
})

Deno.test("raw API retains its GraphQL envelope with optional JSON selectors", async () => {
  const envelope = { data: { viewer: { id: "user-1" } } }
  const { server, cleanup } = await setupMockLinearServer([{
    queryName: "MachineViewer",
    response: envelope,
  }])
  const query = "query MachineViewer { viewer { id } }"
  try {
    for (
      const args of [
        ["api", query],
        ["--json", "api", query],
        ["api", "-j", query],
      ]
    ) {
      const result = await run(args, {
        LINEAR_API_KEY: "test-token",
        LINEAR_GRAPHQL_ENDPOINT: server.getEndpoint(),
      })
      assertEquals(result.code, 0, JSON.stringify(result))
      assertEquals(JSON.parse(result.stdout), envelope)
      assertEquals(result.stderr, "")
    }
    assertEquals(server.graphqlRequests.length, 3)
  } finally {
    await cleanup()
  }
})

Deno.test("JSON keeps human-only display toggles and no-pager compatible", async () => {
  const data = {
    ...issueWriteBasis(),
    issue: {
      ...issueWriteBasis().issue,
      attachments: {
        nodes: [],
        pageInfo: { hasNextPage: false, endCursor: null },
      },
      documents: {
        nodes: [],
        pageInfo: { hasNextPage: false, endCursor: null },
      },
      children: {
        nodes: [],
        pageInfo: { hasNextPage: false, endCursor: null },
      },
    },
  }
  const { server, cleanup } = await setupMockLinearServer([{
    queryName: "GetIssueDetails",
    response: { data },
  }])
  try {
    const result = await run([
      "--json",
      "issue",
      "view",
      "ENG-123",
      "--no-pager",
      "--no-comments",
      "--show-resolved-threads",
    ], {
      LINEAR_API_KEY: "test-token",
      LINEAR_GRAPHQL_ENDPOINT: server.getEndpoint(),
    })
    assertEquals(result.code, 0, JSON.stringify(result))
    const { contextSummary, ...read } = JSON.parse(result.stdout)
    assertEquals(read, data)
    assertEquals(contextSummary.comments.fetched, false)
    assertEquals(result.stderr, "")
  } finally {
    await cleanup()
  }
})

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
  } finally {
    await cleanup()
    await Deno.remove(root, { recursive: true })
  }
})

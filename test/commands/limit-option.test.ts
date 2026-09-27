import { assertEquals } from "@std/assert"
import { fromFileUrl } from "@std/path"
import { MockLinearServer } from "../utils/mock_linear_server.ts"

// Every `--limit` where 0 reads all pages shares one parser. These run the
// real binary entry so parse-time failures take the same path users see.
const main = fromFileUrl(new URL("../../src/main.ts", import.meta.url))
const empty = { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } }

const commands = [
  {
    args: ["issue", "query", "--all-teams"],
    queryName: "GetIssuesForQuery",
    data: { issues: empty },
  },
  {
    args: ["issue", "comment", "list", "TEST-123"],
    queryName: "GetIssueComments",
    data: { issue: { comments: empty } },
  },
  {
    args: ["issue", "history", "TEST-123"],
    queryName: "GetIssueHistory",
    data: { issue: { id: "issue-1", history: empty } },
  },
  {
    args: ["project", "list", "--all-teams"],
    queryName: "GetProjects",
    data: { projects: empty },
  },
  { args: ["team", "list"], queryName: "GetTeams", data: { teams: empty } },
]

async function run(server: MockLinearServer, args: string[]) {
  const output = await new Deno.Command(Deno.execPath(), {
    args: ["run", "--allow-all", "--quiet", main, ...args],
    env: {
      NO_COLOR: "1",
      LINEAR_PROMPT_DISABLED: "1",
      LINEAR_GRAPHQL_ENDPOINT: server.getEndpoint(),
      LINEAR_API_KEY: "Bearer test-token",
    },
    stdout: "piped",
    stderr: "piped",
  }).output()
  return {
    code: output.code,
    stdout: new TextDecoder().decode(output.stdout),
    stderr: new TextDecoder().decode(output.stderr),
  }
}

// These three read their target first, so only the parse-time rejection is
// exercised here; their paging is covered by their own command tests.
const parseOnlyCommands = [
  { args: ["document", "list"] },
  { args: ["project-update", "list", "project-1"] },
  { args: ["initiative-update", "list", "initiative-1"] },
]

for (const { args } of [...commands, ...parseOnlyCommands]) {
  const name = args.slice(0, args[1] === "comment" ? 3 : 2).join(" ")
  Deno.test(`${name} rejects non-integer and unsafe --limit before querying`, async (t) => {
    const server = new MockLinearServer()
    server.start()
    try {
      for (
        const value of ["abc", "1.5", "1e3", "-1", "9007199254740992"]
      ) {
        await t.step(value, async () => {
          const result = await run(server, [
            ...args,
            "--json",
            `--limit=${value}`,
          ])
          assertEquals(result.code, 1)
          assertEquals(result.stderr, "")
          assertEquals(JSON.parse(result.stdout).error, {
            code: "ValidationError",
            message: `--limit must be a non-negative integer (got "${value}")`,
            suggestion:
              "Use a whole number from 0 (all pages) to 9007199254740991.",
          })
        })
      }
      assertEquals(server.graphqlRequests.length, 0)
    } finally {
      await server.stop()
    }
  })
}

Deno.test("--limit above Linear's 250-node page bound is requested in pages of 100", async () => {
  for (const { args, queryName, data } of commands) {
    const server = new MockLinearServer([{ queryName, response: { data } }])
    server.start()
    try {
      const result = await run(server, [...args, "--json", "--limit", "300"])
      assertEquals(result.code, 0, result.stderr)
      assertEquals(
        server.graphqlRequests.map(({ variables }) => variables.first),
        [100],
        args.join(" "),
      )
    } finally {
      await server.stop()
    }
  }
})

Deno.test("invalid --limit reports one human diagnostic on stderr", async () => {
  const server = new MockLinearServer()
  server.start()
  try {
    const result = await run(server, ["issue", "query", "--limit", "1.5"])
    assertEquals(result.code, 1)
    assertEquals(result.stdout, "")
    assertEquals(
      result.stderr,
      '✗ --limit must be a non-negative integer (got "1.5")\n' +
        "  Use a whole number from 0 (all pages) to 9007199254740991.\n",
    )
    assertEquals(server.graphqlRequests.length, 0)
  } finally {
    await server.stop()
  }
})

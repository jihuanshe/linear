import { assertEquals, assertStringIncludes } from "@std/assert"
import { fromFileUrl, join } from "@std/path"

const main = fromFileUrl(new URL("../../src/main.ts", import.meta.url))
const config = fromFileUrl(new URL("../../deno.json", import.meta.url))
const projectId = "11111111-1111-4111-8111-111111111111"
const milestoneId = "22222222-2222-4222-8222-222222222222"
const empty = { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } }
const original = {
  organization: { id: "workspace-id", urlKey: "envelope-test" },
  project: {
    id: projectId,
    name: "Before",
    description: "",
    startDate: null,
    targetDate: null,
    url: "https://linear.app/envelope-test/project/example",
    archivedAt: null,
    status: { id: "status-id" },
    lead: null,
    teams: empty,
    labels: empty,
  },
}
const { denoDir } = JSON.parse(new TextDecoder().decode(
  (await new Deno.Command(Deno.execPath(), {
    args: ["info", "--json"],
    stdout: "piped",
  }).output()).stdout,
)) as { denoDir: string }

const commands = [
  {
    name: "project update",
    mutation: "UpdateProject",
    operations: ["ReadProject", "UpdateProject"],
    args: (basisFile: string) => [
      "project",
      "update",
      projectId,
      "--base-file",
      basisFile,
      "--name",
      "After",
    ],
    partial: {
      projectUpdate: {
        success: true,
        project: { id: projectId, name: "After" },
      },
    },
  },
  {
    name: "milestone create",
    mutation: "CreateProjectMilestone",
    operations: ["CreateProjectMilestone"],
    args: (_basisFile: string) => [
      "milestone",
      "create",
      "--project",
      projectId,
      "--name",
      "Created milestone",
    ],
    partial: {
      projectMilestoneCreate: {
        success: true,
        projectMilestone: { id: milestoneId, name: "Created milestone" },
      },
    },
  },
]

async function runCommand(
  command: typeof commands[number],
  mutationEnvelope: unknown,
  effect = "unknown",
) {
  const root = await Deno.makeTempDir()
  const basisFile = join(root, "original.json")
  await Deno.writeTextFile(basisFile, JSON.stringify(original))
  const operations: string[] = []
  let mutations = 0
  const server = Deno.serve(
    { hostname: "127.0.0.1", port: 0, onListen() {} },
    async (request) => {
      const body = await request.json() as { query: string }
      const operation = body.query.match(/\b(?:query|mutation)\s+(\w+)/)?.[1] ??
        "unnamed"
      operations.push(operation)
      if (operation === "ReadProject") {
        return Response.json({ data: original })
      }
      if (operation === command.mutation) {
        // The request reached the server. Its response cannot prove no effect,
        // even if a resolver or proxy produces an incomplete JSON envelope.
        mutations++
        return Response.json(mutationEnvelope)
      }
      return Response.json({
        errors: [{ message: `Unexpected operation: ${operation}` }],
      }, { status: 500 })
    },
  )
  try {
    const output = await new Deno.Command(Deno.execPath(), {
      args: [
        "run",
        "--cached-only",
        "--quiet",
        "--allow-read",
        "--allow-env",
        "--allow-net=127.0.0.1",
        "--deny-run",
        "--config",
        config,
        main,
        ...command.args(basisFile),
        "--json",
      ],
      cwd: root,
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
        LINEAR_PROMPT_DISABLED: "1",
        LINEAR_API_KEY: "isolated-envelope-test-key",
        LINEAR_GRAPHQL_ENDPOINT: `http://127.0.0.1:${server.addr.port}/graphql`,
      },
    }).output()
    const stdout = new TextDecoder().decode(output.stdout)
    const stderr = new TextDecoder().decode(output.stderr)
    assertEquals(output.code, 1, stdout + stderr)
    assertEquals(stderr, "")
    assertEquals(operations, command.operations)
    assertEquals(
      mutations,
      1,
      "A malformed receipt must not retry the mutation",
    )
    // Parsing all stdout also rejects a second JSON result or mixed progress.
    const result = JSON.parse(stdout)
    assertEquals(result.ok, false)
    assertEquals(result.effect, effect)
    return result
  } finally {
    await server.shutdown()
    await Deno.remove(root, { recursive: true })
  }
}

for (const command of commands) {
  for (
    const response of [{ name: "null data", body: { data: null } }, {
      name: "missing data",
      body: {},
    }]
  ) {
    Deno.test(`mutation envelope: ${command.name} preserves ${response.name} as unknown without retry`, async () => {
      const result = await runCommand(command, response.body)
      assertEquals(result.data, response.body)
      assertStringIncludes(
        result.error.message,
        "Mutation response did not contain GraphQL data",
      )
      assertStringIncludes(result.error.suggestion, "before retrying")
    })
  }

  Deno.test(`mutation envelope: ${command.name} retains partial data and GraphQL errors without retry`, async () => {
    const errors = [{
      message: "Injected late field resolution failure",
      path: [Object.keys(command.partial)[0], "afterCommitField"],
      extensions: { code: "INTERNAL_SERVER_ERROR" },
    }]
    const result = await runCommand(command, {
      data: command.partial,
      errors,
    }, "applied")
    assertEquals(result.data, command.partial)
    assertEquals(result.error.details.errors, errors)
    assertStringIncludes(result.error.message, errors[0].message)
    assertEquals(result.error.suggestion, undefined)
  })
}

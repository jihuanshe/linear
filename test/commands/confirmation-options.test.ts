import { assertEquals, assertExists, assertStringIncludes } from "@std/assert"
import { fromFileUrl } from "@std/path"
import { cli } from "../../src/cli.ts"
import {
  buildUsageDocument,
  type UsageOptionMetadata,
} from "../../src/commands/usage.ts"
import { setupMockLinearServer } from "../utils/test-helpers.ts"

const main = fromFileUrl(new URL("../../src/main.ts", import.meta.url))
const id = "11111111-1111-4111-8111-111111111111"
const finalPage = { hasNextPage: false, endCursor: null }

function commandMetadata() {
  const queue = [...cli.getCommands(true)]
  for (const command of queue) queue.push(...command.getCommands(true))
  return queue.map((command) => buildUsageDocument(command).command)
}

Deno.test("confirmation options use only -y/--yes throughout the command tree", () => {
  const commands = commandMetadata()
  assertEquals(
    commands.filter((command) =>
      command.options.some((option) =>
        option.flags.includes("--force") || option.flags.includes("--confirm")
      )
    ).map((command) => command.path),
    ["linear document update"],
  )
  const confirmations = commands.flatMap((command) =>
    command.options.filter((option) =>
      /skip confirmation/i.test(option.description)
    )
      .map((option) => ({ command, option }))
  )
  assertEquals(confirmations.length, 12)
  for (const { command, option } of confirmations) {
    assertEquals(option.name, "yes", command.path)
    assertEquals(option.flags, ["-y", "--yes"], command.path)
    assertEquals(option.arguments, [], command.path)
    assertEquals(command.writes, true, command.path)
    assertEquals(command.interactive, true, command.path)
    assertEquals(
      command.options.some((item) => item.flags.includes("-f")),
      false,
    )
  }
})

Deno.test("confirmation commands expose semantic positional and bulk placeholders", () => {
  const commands = commandMetadata()
  for (
    const [path, name, required, bulkName] of [
      ["auth logout", "slug", false],
      ["issue delete", "issue", false, "issues"],
      ["issue comment delete", "commentId", true],
      ["team delete", "team", true],
      ["project delete", "project", true],
      ["milestone delete", "milestoneId", true],
      ["initiative archive", "initiative", false, "initiatives"],
      ["initiative delete", "initiative", false, "initiatives"],
      ["initiative unarchive", "initiative", true],
      ["document delete", "document", false, "documents"],
    ] as const
  ) {
    const command = commands.find((item) => item.path === `linear ${path}`)
    assertExists(command)
    assertEquals(command.arguments, [{
      name,
      type: "string",
      required,
      variadic: false,
    }])
    if (bulkName == null) continue
    assertEquals(
      command.options.find((option) => option.name === "bulk")?.arguments,
      [{
        name: bulkName,
        type: "string",
        required: true,
        variadic: true,
      }],
    )
    const file = command.options.find((option) => option.name === "bulk-file")
    assertEquals(file?.arguments, [{
      name: "path",
      type: "string",
      required: true,
      variadic: false,
    }])
    for (const inputName of ["bulk-file", "bulk-stdin"]) {
      const option: UsageOptionMetadata | undefined = command.options.find((
        candidate,
      ) => candidate.name === inputName)
      assertExists(option)
      assertStringIncludes(option.description, "whitespace/comma-separated")
      assertStringIncludes(option.description, "UUIDs")
      if (bulkName === "initiatives") {
        assertStringIncludes(option.description, "no names with spaces")
      }
    }
  }
})

async function runCli(args: string[]) {
  const result = await new Deno.Command(Deno.execPath(), {
    args: ["run", "--allow-all", "--quiet", main, ...args],
    stdin: "null",
    stdout: "piped",
    stderr: "piped",
    env: { LINEAR_PROMPT_DISABLED: "1", NO_COLOR: "1" },
  }).output()
  return {
    code: result.code,
    stdout: new TextDecoder().decode(result.stdout),
    stderr: new TextDecoder().decode(result.stderr),
  }
}

Deno.test("CLI rejects removed confirmation flags before any request", async () => {
  const { server, cleanup } = await setupMockLinearServer([])
  try {
    const cases = [
      ["issue", "delete", id, "--confirm"],
      ["issue", "comment", "delete", id, "--confirm"],
      ["project", "delete", id, "--force"],
      ["project", "delete", id, "-f"],
      ["milestone", "delete", id, "-f"],
      ["team", "delete", "ENG", "--force"],
      ["initiative", "delete", id, "--force"],
      ["auth", "logout", "example", "--force"],
      ["auth", "logout", "example", "-f"],
    ]
    const results = await Promise.all(cases.map(runCli))
    for (const [index, result] of results.entries()) {
      assertEquals(result.code, 1, cases[index].join(" "))
      assertStringIncludes(result.stderr, "Unknown option")
      assertStringIncludes(result.stderr, cases[index].at(-1)!)
    }
    assertEquals(server.graphqlRequests, [])
  } finally {
    await cleanup()
  }
})

for (
  const operation of [
    {
      args: ["project", "delete", id, "-y"],
      query: "DeleteProject",
      field: "projectDelete",
    },
    {
      args: ["milestone", "delete", id, "--yes"],
      query: "DeleteProjectMilestone",
      field: "projectMilestoneDelete",
    },
    {
      args: ["initiative", "delete", id, "--yes"],
      query: "DeleteInitiative",
      field: "initiativeDelete",
    },
    {
      args: ["initiative", "unarchive", id, "-y"],
      query: "UnarchiveInitiative",
      field: "initiativeUnarchive",
    },
    {
      args: ["initiative", "archive", "--yes", "--bulk", id],
      query: "BulkArchiveInitiative",
      field: "initiativeArchive",
    },
  ]
) {
  Deno.test(`CLI ${operation.args.slice(0, 2).join(" ")} skips prompts and mutates with yes`, async () => {
    const entity = {
      id,
      name: "Example",
      slugId: "example",
      url: "https://linear.app/example",
    }
    const { server, cleanup } = await setupMockLinearServer([
      {
        queryName: "ReadInitiative",
        response: {
          data: {
            organization: { id: "workspace-id", urlKey: "example" },
            initiatives: {
              nodes: [{
                ...entity,
                archivedAt: operation.field === "initiativeUnarchive"
                  ? "2026-09-01T00:00:00Z"
                  : null,
                projects: { nodes: [], pageInfo: finalPage },
              }],
              pageInfo: finalPage,
            },
          },
        },
      },
      {
        queryName: operation.query,
        variables: { id },
        response: { data: { [operation.field]: { success: true, entity } } },
      },
    ])
    try {
      const result = await runCli([...operation.args, "--json"])
      assertEquals(result.code, 0, result.stdout + result.stderr)
      assertEquals(result.stderr, "")
      const output = JSON.parse(result.stdout)
      assertEquals(output.ok, true)
      assertEquals(output.effect, "applied")
      const mutations = server.graphqlRequests.filter((request) =>
        /^mutation\b/.test(request.query.trim())
      )
      assertEquals(mutations.length, 1)
      assertStringIncludes(mutations[0].query, operation.query)
      assertEquals(mutations[0].variables, { id })
    } finally {
      await cleanup()
    }
  })
}

Deno.test("CLI without yes refuses noninteractive confirmation and suggests --yes", async () => {
  const { server, cleanup } = await setupMockLinearServer([])
  try {
    const result = await runCli(["project", "delete", id, "--json"])
    assertEquals(result.code, 1)
    const output = JSON.parse(result.stdout)
    assertEquals(output.effect, "none")
    assertStringIncludes(result.stdout, "Use --yes")
    assertEquals(server.graphqlRequests, [])
  } finally {
    await cleanup()
  }
})

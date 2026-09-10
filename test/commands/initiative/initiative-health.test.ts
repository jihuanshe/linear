import { assertEquals, assertMatch, assertStringIncludes } from "@std/assert"
import { stub } from "@std/testing/mock"
import { createCommand } from "../../../src/commands/initiative/initiative-create.ts"
import { deleteCommand } from "../../../src/commands/initiative/initiative-delete.ts"
import { updateCommand } from "../../../src/commands/initiative/initiative-update.ts"
import { Confirm, Input, Select } from "../../../src/utils/prompt.ts"
import { MockLinearServer } from "../../utils/mock_linear_server.ts"
import { setupMockLinearServer } from "../../utils/test-helpers.ts"

const id = "550e8400-e29b-41d4-a716-446655440000"
const organization = { id: "workspace-test", urlKey: "test" }
const pageInfo = { hasNextPage: false, endCursor: null }
const initiative = {
  id,
  slugId: "example",
  name: "Example",
  status: "Active",
  description: null,
  targetDate: null,
  color: null,
  icon: null,
  owner: null,
  projects: { nodes: [] },
  url: "https://linear.app/test/initiative/example",
}

async function runCli(server: MockLinearServer, args: string[]) {
  const result = await new Deno.Command(Deno.execPath(), {
    args: [
      "run",
      "--allow-all",
      "--quiet",
      "src/main.ts",
      "initiative",
      ...args,
    ],
    stdin: "null",
    stdout: "piped",
    stderr: "piped",
    env: {
      LINEAR_GRAPHQL_ENDPOINT: server.getEndpoint(),
      LINEAR_API_KEY: "test-token",
      LINEAR_DEBUG: "0",
      NO_COLOR: "1",
    },
  }).output()
  return {
    code: result.code,
    stdout: new TextDecoder().decode(result.stdout),
    stderr: new TextDecoder().decode(result.stderr),
  }
}

for (const reference of [id, "example", "Example"]) {
  for (const archived of [false, true]) {
    Deno.test(`initiative lifecycle reads ${archived ? "archived" : "active"} ${reference} through the ID-filtered connection`, async () => {
      const remote = {
        ...initiative,
        archivedAt: archived ? "2026-01-01T00:00:00Z" : null,
        trashed: false,
      }
      const server = new MockLinearServer([
        {
          queryName: "FindInitiative",
          variables: { includeArchived: true },
          response: (request) => ({
            data: {
              initiatives: {
                nodes: reference === "Example" &&
                    "slugId" in (request.variables.filter as object)
                  ? []
                  : [{ id }],
                pageInfo,
              },
            },
          }),
        },
        {
          queryName: "ReadInitiative",
          variables: { id },
          response: {
            data: { organization, initiatives: { nodes: [remote], pageInfo } },
          },
        },
        ...[
          "ArchiveInitiative",
          "BulkArchiveInitiative",
          "DeleteInitiative",
          "BulkDeleteInitiative",
          "UnarchiveInitiative",
        ].map((queryName) => ({
          queryName,
          variables: { id },
          response: {
            data: {
              initiativeArchive: { success: true },
              initiativeDelete: { success: true },
              initiativeUnarchive: { success: true, entity: remote },
            },
          },
        })),
      ])
      await server.start()
      try {
        const view = await runCli(server, ["view", reference, "--json"])
        assertEquals(view.code, 0, view.stderr)
        assertEquals(JSON.parse(view.stdout), {
          organization,
          initiative: remote,
        })
        for (const command of ["archive", "delete", "unarchive"]) {
          for (
            const bulk of command === "unarchive" ? [false] : [false, true]
          ) {
            const before = server.graphqlRequests.length
            const result = await runCli(server, [
              command,
              ...(bulk ? ["--bulk", reference] : [reference]),
              "--force",
              "--json",
            ])
            assertEquals(result.code, 0, result.stdout + result.stderr)
            const noop = command === "archive"
              ? archived
              : command === "unarchive" && !archived
            assertEquals(
              JSON.parse(result.stdout).effect,
              noop ? "none" : "applied",
            )
            const writes = server.graphqlRequests.slice(before).filter((
              request,
            ) => /mutation\s/.test(request.query))
            assertEquals(writes.length, noop ? 0 : 1)
            if (!noop) assertEquals(writes[0].variables, { id })
          }
        }
        for (const request of server.graphqlRequests) {
          assertEquals(/\binitiative\s*\(id:/.test(request.query), false)
          if (request.query.includes("query ReadInitiative")) {
            assertMatch(request.query, /includeArchived:\s*true/)
            assertMatch(request.query, /filter:\s*\{\s*id:\s*\{\s*eq:\s*\$id/)
          }
        }
        if (reference === "Example") {
          assertEquals(server.graphqlRequests[1].variables, {
            filter: { name: { eqIgnoreCase: "Example" } },
            includeArchived: true,
          })
        }
      } finally {
        await server.stop()
      }
    })
  }
}

for (const ambiguous of [false, true]) {
  Deno.test(`initiative lifecycle refuses ${ambiguous ? "ambiguous names" : "missing UUIDs"} without mutation`, async () => {
    const server = new MockLinearServer([{
      queryName: ambiguous ? "FindInitiative" : "ReadInitiative",
      response: {
        data: {
          organization,
          initiatives: {
            nodes: ambiguous ? [{ id }, { id: "other" }] : [],
            pageInfo,
          },
        },
      },
    }])
    await server.start()
    try {
      for (const command of ["view", "archive", "delete", "unarchive"]) {
        for (
          const bulk of ["archive", "delete"].includes(command)
            ? [false, true]
            : [false]
        ) {
          const result = await runCli(server, [
            command,
            ...(bulk ? ["--bulk"] : []),
            ambiguous ? "Duplicate" : id,
            ...(command === "view" ? [] : ["--force"]),
            "--json",
          ])
          assertEquals(result.code, 1, result.stdout + result.stderr)
          assertMatch(
            result.stdout + result.stderr,
            ambiguous ? /ambiguous/ : /not found/i,
          )
        }
      }
      assertEquals(
        server.graphqlRequests.some((request) =>
          /mutation\s/.test(request.query)
        ),
        false,
      )
    } finally {
      await server.stop()
    }
  })
}

for (
  const state of [{ archivedAt: "2026-01-01T00:00:00Z", trashed: false }, {
    archivedAt: null,
    trashed: true,
  }]
) {
  Deno.test(`initiative update preserves domain guard ${JSON.stringify(state)}`, async () => {
    const server = new MockLinearServer([{
      queryName: "ReadInitiative",
      queryIncludes: "trashed",
      response: {
        data: {
          organization,
          initiatives: { nodes: [{ ...initiative, ...state }], pageInfo },
        },
      },
    }])
    await server.start()
    try {
      const result = await runCli(server, [
        "update",
        id,
        "--name",
        "Changed",
        "--unprotected",
        "--json",
      ])
      assertEquals(result.code, 1)
      assertStringIncludes(result.stdout, "archived or trashed")
      assertEquals(server.graphqlRequests.length, 1)
    } finally {
      await server.stop()
    }
  })
}

for (const command of ["create", "update"]) {
  Deno.test(`initiative ${command} normalizes supported status casing`, async () => {
    let currentStatus = "Active"
    const server = new MockLinearServer([
      {
        queryName: "ReadInitiative",
        response: () => ({
          data: {
            organization,
            initiatives: {
              nodes: [{ ...initiative, status: currentStatus }],
              pageInfo,
            },
          },
        }),
      },
      {
        queryName: command === "create"
          ? "CreateInitiative"
          : "UpdateInitiative",
        response: {
          data: {
            [command === "create" ? "initiativeCreate" : "initiativeUpdate"]: {
              success: true,
              initiative,
            },
          },
        },
      },
    ])
    await server.start()
    try {
      const help = await runCli(server, [command, "--help"])
      assertEquals(help.code, 0, help.stderr)
      for (
        const canonical of [
          "Planned",
          "Active",
          "Completed",
          "Proposed",
          "Canceled",
        ]
      ) {
        assertStringIncludes(help.stdout, canonical.toLowerCase())
        for (
          const status of [
            canonical,
            canonical.toLowerCase(),
            canonical.toUpperCase(),
          ]
        ) {
          currentStatus = canonical === "Active" ? "Planned" : "Active"
          const before = server.graphqlRequests.filter((request) =>
            /mutation\s/.test(request.query)
          ).length
          const result = await runCli(server, [
            command,
            ...(command === "create"
              ? ["--name", "Example"]
              : [id, "--unprotected"]),
            "--status",
            status,
          ])
          assertEquals(result.code, 0, result.stderr)
          const mutations = server.graphqlRequests.filter((request) =>
            /mutation\s/.test(request.query)
          )
          assertEquals(mutations.length, before + 1)
          assertEquals(
            mutations.at(-1)?.variables.input,
            command === "create"
              ? { name: "Example", status: canonical }
              : { status: canonical },
          )
        }
      }
    } finally {
      await server.stop()
    }
  })

  Deno.test(`initiative ${command} rejects unsupported statuses before API calls`, async () => {
    const server = new MockLinearServer()
    await server.start()
    try {
      for (const status of ["paused", "Paused", "unknown"]) {
        const result = await runCli(server, [
          command,
          ...(command === "create" ? ["--name", "Example"] : [id]),
          "--status",
          status,
        ])
        assertEquals(result.code, 1)
        assertStringIncludes(result.stderr, `Invalid status: ${status}`)
        assertStringIncludes(
          result.stderr,
          "Valid values: planned, active, completed, proposed, canceled",
        )
        assertEquals(server.graphqlRequests.length, 0)
      }
    } finally {
      await server.stop()
    }
  })
}

Deno.test("initiative create leaves omitted status to the server", async () => {
  const server = new MockLinearServer([{
    queryName: "CreateInitiative",
    response: { data: { initiativeCreate: { success: true, initiative } } },
  }])
  await server.start()
  try {
    const result = await runCli(server, ["create", "--name", "Example"])
    assertEquals(result.code, 0, result.stderr)
    assertEquals(server.graphqlRequests[0].variables.input, { name: "Example" })
    const help = await runCli(server, ["create", "--help"])
    assertStringIncludes(help.stdout, "server default")
    assertEquals(/default: planned/i.test(help.stdout), false)
  } finally {
    await server.stop()
  }
})

for (const command of ["create", "update"]) {
  Deno.test(`initiative ${command} interactive choices send canonical status`, async () => {
    const { server, cleanup } = await setupMockLinearServer([
      {
        queryName: "ReadInitiative",
        response: {
          data: {
            organization,
            initiatives: { nodes: [initiative], pageInfo },
          },
        },
      },
      {
        queryName: command === "create"
          ? "CreateInitiative"
          : "UpdateInitiative",
        response: {
          data: {
            [command === "create" ? "initiativeCreate" : "initiativeUpdate"]: {
              success: true,
              initiative,
            },
          },
        },
      },
    ])
    const terminal = stub(
      Object.getPrototypeOf(Deno.stdout),
      "isTerminal",
      () => true,
    )
    const stdinTerminal = stub(
      Object.getPrototypeOf(Deno.stdin),
      "isTerminal",
      () => true,
    )
    const input = stub(
      Input,
      "prompt",
      (options: string | { message: string }) => {
        const message = typeof options === "string" ? options : options.message
        return Promise.resolve(message === "Name:" ? "Example" : "")
      },
    )
    const select = stub(
      Select,
      "prompt",
      (options: { message: string; default?: unknown; options?: unknown }) => {
        assertEquals(options.message, "Status:")
        assertEquals(
          options.default,
          command === "create" ? "Planned" : "Active",
        )
        assertEquals(options.options, [
          { name: "Planned", value: "Planned" },
          { name: "Active", value: "Active" },
          { name: "Completed", value: "Completed" },
          { name: "Proposed", value: "Proposed" },
          { name: "Canceled", value: "Canceled" },
        ])
        return Promise.resolve(command === "create" ? "Proposed" : "Canceled")
      },
    )
    try {
      if (command === "create") {
        await createCommand.parse([
          "--name",
          "Example",
          "--color",
          "#123456",
          "--interactive",
        ])
      } else {
        await updateCommand.parse([id, "--interactive"])
      }
      assertEquals(select.calls.length, 1)
      assertEquals(
        server.graphqlRequests.at(-1)?.variables.input,
        command === "create"
          ? { name: "Example", status: "Proposed", color: "#123456" }
          : { status: "Canceled" },
      )
    } finally {
      select.restore()
      input.restore()
      terminal.restore()
      stdinTerminal.restore()
      await cleanup()
    }
  })
}

for (const bulk of [false, true]) {
  Deno.test(`initiative delete ${bulk ? "bulk" : "single"} preserves confirmation and reports trash`, async () => {
    const server = new MockLinearServer([
      {
        queryName: "ReadInitiative",
        response: {
          data: {
            organization,
            initiatives: { nodes: [initiative], pageInfo },
          },
        },
      },
      {
        queryName: bulk ? "BulkDeleteInitiative" : "DeleteInitiative",
        response: { data: { initiativeDelete: { success: true } } },
      },
    ])
    await server.start()
    try {
      const args = ["delete", ...(bulk ? ["--bulk", id] : [id])]
      const refused = await runCli(server, args)
      assertEquals(refused.code, 1)
      assertStringIncludes(
        refused.stderr,
        "Interactive confirmation required. Use --force to skip.",
      )
      assertEquals(
        server.graphqlRequests.filter((r) => /mutation\s/.test(r.query)).length,
        0,
      )
      const result = await runCli(server, [...args, "--force"])
      assertEquals(result.code, 0, result.stderr)
      assertMatch(result.stdout, /moved .*to trash/i)
      assertEquals(
        /permanent|cannot be undone/i.test(result.stdout + refused.stdout),
        false,
      )
      assertEquals(
        server.graphqlRequests.filter((r) => /mutation\s/.test(r.query)).length,
        1,
      )
      const help = await runCli(server, ["delete", "--help"])
      assertStringIncludes(help.stdout, "Move a Linear initiative to trash")
    } finally {
      await server.stop()
    }
  })
}

Deno.test("initiative delete requires affirmative confirmation and exact name", async () => {
  const { server, cleanup } = await setupMockLinearServer([
    {
      queryName: "ReadInitiative",
      response: {
        data: { organization, initiatives: { nodes: [initiative], pageInfo } },
      },
    },
    {
      queryName: "DeleteInitiative",
      response: { data: { initiativeDelete: { success: true } } },
    },
  ])
  const terminal = stub(
    Object.getPrototypeOf(Deno.stdin),
    "isTerminal",
    () => true,
  )
  let confirmed = false
  let typedName = "wrong"
  const confirm = stub(
    Confirm,
    "prompt",
    (options: string | { message: string; default?: boolean }) => {
      assertEquals(typeof options, "object")
      if (typeof options !== "string") {
        assertStringIncludes(options.message, "to trash?")
        assertEquals(options.default, false)
      }
      return Promise.resolve(confirmed)
    },
  )
  const input = stub(Input, "prompt", () => Promise.resolve(typedName))
  try {
    await deleteCommand.parse([id])
    assertEquals(input.calls.length, 0)
    confirmed = true
    await deleteCommand.parse([id])
    assertEquals(
      server.graphqlRequests.filter((r) => /mutation\s/.test(r.query)).length,
      0,
    )
    typedName = "Example"
    await deleteCommand.parse([id])
    assertEquals(
      server.graphqlRequests.filter((r) => /mutation\s/.test(r.query)).length,
      1,
    )
  } finally {
    input.restore()
    confirm.restore()
    terminal.restore()
    await cleanup()
  }
})

Deno.test("initiative list distinguishes archived and trashed without removing nodes or pageInfo", async () => {
  const nodes = [
    {
      ...initiative,
      name: "Archived",
      archivedAt: "2026-01-01T00:00:00Z",
      trashed: false,
    },
    {
      ...initiative,
      name: "Trashed",
      archivedAt: "2026-01-01T00:00:00Z",
      trashed: true,
    },
  ]
  const pageInfo = { hasNextPage: true, endCursor: "next" }
  const server = new MockLinearServer([{
    queryName: "GetInitiatives",
    queryIncludes: "trashed",
    variables: { includeArchived: true },
    response: { data: { initiatives: { nodes, pageInfo } } },
  }])
  await server.start()
  try {
    const result = await runCli(server, [
      "list",
      "--all-statuses",
      "--archived",
      "--json",
    ])
    assertEquals(result.code, 0, result.stderr)
    assertEquals(JSON.parse(result.stdout), { nodes, pageInfo })
    const human = await runCli(server, ["list", "--all-statuses", "--archived"])
    assertEquals(human.code, 0, human.stderr)
    assertMatch(human.stdout, /Archived\s+Active \(archived\)/)
    assertMatch(human.stdout, /Trashed\s+Active \(trashed\)/)
  } finally {
    await server.stop()
  }
})

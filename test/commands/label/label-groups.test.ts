import { assertEquals, assertStringIncludes } from "@std/assert"
import { MockLinearServer } from "../../utils/mock_linear_server.ts"
import { commonDenoArgs } from "../../utils/test-helpers.ts"

const groupId = "11111111-1111-4111-8111-111111111111"
const labelId = "22222222-2222-4222-8222-222222222222"
const organization = { id: "workspace-1", urlKey: "test" }
const group = {
  id: groupId,
  name: "Platform",
  color: "#112233",
  description: null,
  isGroup: true,
  groupType: "singleSelect",
  parent: null,
  team: null,
  archivedAt: null,
}

async function run(server: MockLinearServer, args: string[]) {
  const result = await new Deno.Command(Deno.execPath(), {
    args: ["run", ...commonDenoArgs, "src/main.ts", "label", ...args, "--json"],
    env: {
      LINEAR_GRAPHQL_ENDPOINT: server.getEndpoint(),
      LINEAR_API_KEY: "test-token",
      LINEAR_PROMPT_DISABLED: "1",
      NO_COLOR: "1",
    },
    stdin: "null",
    stdout: "piped",
    stderr: "piped",
  }).output()
  return {
    code: result.code,
    body: JSON.parse(new TextDecoder().decode(result.stdout)),
    stderr: new TextDecoder().decode(result.stderr),
  }
}

Deno.test("label groups can be created and populated through the CLI", async () => {
  const server = new MockLinearServer([
    {
      queryName: "ReadIssueLabel",
      response: { data: { organization, issueLabel: group } },
    },
    {
      queryName: "CreateIssueLabel",
      response: ({ variables }) => {
        const input = variables.input as Record<string, unknown>
        return {
          data: {
            issueLabelCreate: {
              success: true,
              issueLabel: input.isGroup
                ? { ...group, groupType: input.groupType ?? "singleSelect" }
                : {
                  ...group,
                  id: labelId,
                  name: input.name,
                  isGroup: false,
                  groupType: null,
                  parent: { id: groupId, name: "Platform" },
                },
            },
          },
        }
      },
    },
  ])
  try {
    server.start()
    for (const mode of ["singleSelect", "multiSelect"]) {
      const created = await run(server, [
        "create",
        "--name",
        "Platform",
        "--group",
        "--group-type",
        mode,
      ])
      assertEquals(created.code, 0, JSON.stringify(created.body))
      assertEquals(created.body.data.issueLabel.groupType, mode)
      assertEquals(created.body.data.issueLabel.isGroup, true)
    }
    const child = await run(server, [
      "create",
      "--name",
      "iOS",
      "--parent",
      groupId,
    ])
    assertEquals(child.code, 0, JSON.stringify(child.body))
    assertEquals(child.body.data.issueLabel.parent.id, groupId)
    const writes = server.graphqlRequests.filter((r) =>
      r.query.trim().startsWith("mutation")
    )
    assertEquals(writes.map((r) => r.variables.input), [
      {
        name: "Platform",
        color: "#5E6AD2",
        isGroup: true,
        groupType: "singleSelect",
      },
      {
        name: "Platform",
        color: "#5E6AD2",
        isGroup: true,
        groupType: "multiSelect",
      },
      { name: "iOS", color: "#5E6AD2", parentId: groupId },
    ])
  } finally {
    await server.stop()
  }
})

for (
  const scenario of [
    "write",
    "repeat",
    "conflict",
    "missing basis",
    "wrong workspace",
    "dependency conflict",
    "receipt mismatch",
    "partial receipt",
    "unconfirmed partial receipt",
  ]
) {
  Deno.test(`label group mode update: ${scenario}`, async () => {
    const partialReceipt = scenario === "partial receipt" ||
      scenario === "unconfirmed partial receipt"
    const current = {
      ...group,
      groupType: scenario === "repeat" ? "multiSelect" : "singleSelect",
    }
    const server = new MockLinearServer([
      {
        queryName: "ReadIssueLabel",
        response: { data: { organization, issueLabel: current } },
      },
      {
        queryName: "UpdateIssueLabel",
        response: {
          data: {
            issueLabelUpdate: {
              success: scenario !== "unconfirmed partial receipt",
              issueLabel: {
                ...group,
                groupType: partialReceipt
                  ? null
                  : scenario === "receipt mismatch"
                  ? "singleSelect"
                  : "multiSelect",
              },
            },
          },
          ...(partialReceipt
            ? {
              errors: [{
                message: "Group type unavailable",
                path: ["issueLabelUpdate", "issueLabel", "groupType"],
              }],
            }
            : {}),
        },
      },
    ])
    const path = await Deno.makeTempFile({ suffix: ".json" })
    try {
      server.start()
      const original = await run(server, ["view", groupId])
      assertEquals(original.code, 0)
      assertEquals(original.body, { organization, issueLabel: current })
      if (scenario === "conflict") original.body.issueLabel.groupType = null
      if (scenario === "wrong workspace") {
        original.body.organization.id = "other-workspace"
      }
      if (scenario === "dependency conflict") {
        original.body.issueLabel.isGroup = false
      }
      await Deno.writeTextFile(path, JSON.stringify(original.body))
      const result = await run(server, [
        "update",
        groupId,
        "--group-type",
        "multiSelect",
        ...(scenario === "missing basis" ? [] : ["--base-file", path]),
        ...(scenario === "dependency conflict"
          ? ["--expect-field", "isGroup"]
          : []),
      ])
      const mutations = server.graphqlRequests.filter((r) =>
        r.query.trim().startsWith("mutation")
      )
      if (
        ["conflict", "missing basis", "wrong workspace", "dependency conflict"]
          .includes(scenario)
      ) {
        assertEquals(result.code, 1)
        assertEquals(result.body.effect, "none")
        assertStringIncludes(
          result.body.error.message,
          scenario === "missing basis"
            ? "original read"
            : scenario === "wrong workspace"
            ? "different object or workspace"
            : "Original values changed",
        )
        assertEquals(mutations.length, 0)
      } else if (scenario === "repeat") {
        assertEquals(result.code, 0)
        assertEquals(result.body.effect, "none")
        assertEquals(mutations.length, 0)
      } else {
        assertEquals(
          result.code,
          scenario === "receipt mismatch" || partialReceipt ? 1 : 0,
        )
        assertEquals(
          result.body.effect,
          scenario === "unconfirmed partial receipt" ? "unknown" : "applied",
        )
        if (partialReceipt) {
          assertStringIncludes(
            result.body.error.message,
            "Group type unavailable",
          )
          assertEquals(
            result.body.data.issueLabelUpdate.success,
            scenario !== "unconfirmed partial receipt",
          )
        }
        assertEquals(mutations.map((r) => r.variables), [{
          id: groupId,
          input: { groupType: "multiSelect" },
        }])
      }
      assertEquals(result.stderr, "")
    } finally {
      await server.stop()
      await Deno.remove(path)
    }
  })
}

for (const scenario of ["sets", "clears", "missing receipt parent"]) {
  Deno.test(`label group membership: ${scenario}`, async () => {
    const clear = scenario !== "sets"
    const label = {
      ...group,
      id: labelId,
      isGroup: false,
      groupType: null,
      parent: clear ? { id: groupId, name: "Platform" } : null,
    }
    const server = new MockLinearServer([
      {
        queryName: "ReadIssueLabel",
        response: ({ variables }) => ({
          data: {
            organization,
            issueLabel: variables.id === groupId ? group : label,
          },
        }),
      },
      {
        queryName: "UpdateIssueLabel",
        response: {
          data: {
            issueLabelUpdate: {
              success: true,
              issueLabel: {
                ...label,
                parent: scenario === "missing receipt parent"
                  ? undefined
                  : clear
                  ? null
                  : { id: groupId, name: "Platform" },
              },
            },
          },
        },
      },
    ])
    try {
      server.start()
      const result = await run(server, [
        "update",
        labelId,
        ...(clear ? ["--clear-parent"] : ["--parent", groupId]),
        "--unprotected",
      ])
      assertEquals(
        result.code,
        scenario === "missing receipt parent" ? 1 : 0,
        JSON.stringify(result.body),
      )
      assertEquals(result.body.effect, "applied")
      assertEquals(
        result.body.data.issueLabel.parent?.id ?? null,
        clear ? null : groupId,
      )
      assertEquals(
        server.graphqlRequests.filter((r) =>
          r.query.trim().startsWith("mutation")
        )
          .map((r) => r.variables),
        [{ id: labelId, input: { parentId: clear ? null : groupId } }],
      )
    } finally {
      await server.stop()
    }
  })
}

for (
  const [args, message] of [
    [
      ["create", "--name", "X", "--group-type", "multiSelect"],
      "requires --group",
    ],
    [
      ["create", "--name", "X", "--group", "--parent", groupId],
      "cannot have a parent",
    ],
    [
      ["create", "--name", "X", "--group", "--group-type", "invalid"],
      "singleSelect",
    ],
    [["create", "--name", "X", "--parent", ""], "must be a UUID"],
    [[
      "update",
      labelId,
      "--parent",
      groupId,
      "--clear-parent",
      "--unprotected",
    ], "not both"],
    [
      ["update", labelId, "--group-type", "multiSelect", "--unprotected"],
      "requires an existing label group",
    ],
    [["create", "--name", "X", "--parent", labelId], "active label group"],
  ] as [string[], string][]
) {
  Deno.test(`label group rejects invalid input ${args.join(" ")}`, async () => {
    const server = new MockLinearServer([{
      queryName: "ReadIssueLabel",
      response: {
        data: {
          organization,
          issueLabel: {
            ...group,
            id: labelId,
            isGroup: false,
            groupType: null,
          },
        },
      },
    }])
    try {
      server.start()
      const result = await run(server, args)
      assertEquals(result.code, 1)
      assertEquals(result.body.effect, "none")
      assertStringIncludes(result.body.error.message, message)
      assertEquals(
        server.graphqlRequests.filter((r) =>
          r.query.trim().startsWith("mutation")
        ),
        [],
      )
    } finally {
      await server.stop()
    }
  })
}

import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert"
import { createIssue } from "../../../src/commands/issue/issue-create.ts"
import { updateIssue } from "../../../src/commands/issue/issue-update.ts"
import {
  CliError,
  errorResult,
  NotFoundError,
  ValidationError,
} from "../../../src/utils/errors.ts"
import { Select } from "../../../src/utils/prompt.ts"
import { stub } from "@std/testing/mock"
import type { MockGraphQLRequest } from "../../utils/mock_linear_server.ts"
import { commonDenoArgs } from "../../utils/test-helpers.ts"
import {
  issueWriteBasis,
  issueWriteId,
  setupIssueWriteServer,
  teamWriteIds,
  terminalPage,
} from "../../utils/issue-write-fixtures.ts"

const frontendId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
const backendId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
const opsId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc"
const labels = [
  { id: frontendId, name: "Frontend", isGroup: false, team: null },
  {
    id: backendId,
    name: "Backend",
    isGroup: false,
    team: { id: teamWriteIds.ENG, key: "ENG" },
  },
  { id: opsId, name: "Operations", isGroup: false, team: null },
]
const otherTeam = { id: teamWriteIds.OPS, key: "OPS" }

function setupLabelWriteServer(
  responses: NonNullable<Parameters<typeof setupIssueWriteServer>[0]> = [],
) {
  return setupIssueWriteServer([
    ...responses,
    ...labels.flatMap((label) => [
      ...[label.name, label.name.toLowerCase(), label.name.toUpperCase()].map((
        name,
      ) => ({
        queryName: "GetIssueLabelIdByNameForTeam",
        variables: { name },
        response: {
          data: { issueLabels: { nodes: [label], pageInfo: terminalPage } },
        },
      })),
      {
        queryName: "GetIssueLabelForWrite",
        variables: { id: label.id },
        response: {
          data: { issueLabels: { nodes: [label], pageInfo: terminalPage } },
        },
      },
    ]),
    {
      queryName: "GetWriteTeamByKey",
      response: {
        data: {
          teams: {
            nodes: [{ id: teamWriteIds.ENG, key: "ENG" }],
            pageInfo: terminalPage,
          },
        },
      },
    },
    ...["Create", "Update"].map((operation) => ({
      queryName: `${operation}Issue`,
      response: {
        data: {
          [`issue${operation}`]: {
            success: true,
            issue: issueWriteBasis().issue,
          },
        },
      },
    })),
  ], { LINEAR_ISSUE_CREATE_ASSIGN_SELF: "never" })
}

function labelLookups(requests: readonly MockGraphQLRequest[]) {
  return requests.filter((request) =>
    /query GetIssueLabel(IdByNameForTeam|ForWrite)\b/.test(request.query)
  )
}

function writes(requests: readonly MockGraphQLRequest[]) {
  return requests.filter((request) => request.query.includes("mutation "))
}

function writeLabels(
  operation: "create" | "replace" | "add" | "remove",
  references: string[],
  beforeWrite?: () => Promise<void>,
) {
  return operation === "create"
    ? createIssue({
      title: "Labels",
      team: "ENG",
      label: references,
      beforeWrite,
    })
    : updateIssue({
      [
        operation === "replace"
          ? "label"
          : operation === "add"
          ? "addLabel"
          : "removeLabel"
      ]: references,
      unprotected: true,
      beforeWrite,
    }, "ENG-123")
}

for (const operation of ["create", "replace", "add", "remove"] as const) {
  for (const multiple of [false, true]) {
    Deno.test(`${operation} preserves server name matching with multiple=${multiple}`, async () => {
      // This is an explicit server fixture, not a claim about Linear's Unicode
      // folding: consumers must trust its match rather than re-match with JS.
      const { server, cleanup } = await setupLabelWriteServer([{
        queryName: "GetIssueLabelIdByNameForTeam",
        variables: { name: "ς" },
        response: {
          data: {
            issueLabels: {
              nodes: [{ id: frontendId, name: "Σ" }],
              pageInfo: terminalPage,
            },
          },
        },
      }])
      try {
        await writeLabels(operation, multiple ? ["ς", "Backend"] : ["ς"])
        const lookups = labelLookups(server.graphqlRequests)
        assertEquals(
          lookups.map((r) => r.variables.name),
          multiple ? ["ς", "Backend"] : ["ς"],
        )
        for (const request of lookups) {
          assertEquals(request.variables.team, { id: { eq: teamWriteIds.ENG } })
          assertStringIncludes(request.query, "name: { eqIgnoreCase: $name }")
          assertStringIncludes(request.query, "isGroup: { eq: false }")
        }
        const mutations = writes(server.graphqlRequests)
        assertEquals(mutations.length, 1)
        const input = mutations[0].variables.input as Record<string, unknown>
        const field = operation === "add"
          ? "addedLabelIds"
          : operation === "remove"
          ? "removedLabelIds"
          : "labelIds"
        assertEquals(
          input[field],
          multiple ? [frontendId, backendId] : [frontendId],
        )
      } finally {
        await cleanup()
      }
    })
  }
}

Deno.test("create does not collapse distinct names with identical JavaScript lowercase keys", async () => {
  const { server, cleanup } = await setupLabelWriteServer([
    ...["İ", "i\u0307"].map((name, index) => ({
      queryName: "GetIssueLabelIdByNameForTeam",
      variables: { name },
      response: {
        data: {
          issueLabels: {
            nodes: [{ id: index === 0 ? frontendId : backendId, name }],
            pageInfo: terminalPage,
          },
        },
      },
    })),
  ])
  try {
    await writeLabels("create", ["İ", "i\u0307"])
    assertEquals(
      labelLookups(server.graphqlRequests).map((r) => r.variables.name),
      ["İ", "i\u0307"],
    )
    assertEquals(
      (writes(server.graphqlRequests)[0].variables.input as Record<
        string,
        unknown
      >).labelIds,
      [frontendId, backendId],
    )
  } finally {
    await cleanup()
  }
})

for (const operation of ["create", "replace", "add"] as const) {
  Deno.test(`${operation} deduplicates exact inputs and resolved IDs without caching across writes`, async () => {
    const { server, cleanup } = await setupLabelWriteServer()
    const references = [
      "Backend",
      frontendId.toUpperCase(),
      "Backend",
      frontendId,
      "frontend",
      "Operations",
      "FRONTEND",
    ]
    let beforeWrites = 0
    try {
      for (let invocation = 0; invocation < 2; invocation++) {
        await writeLabels(operation, references, () => {
          beforeWrites++
          return Promise.resolve()
        })
      }
      const lookups = labelLookups(server.graphqlRequests)
      assertEquals(lookups.map((r) => r.variables.name ?? r.variables.id), [
        "Backend",
        frontendId,
        "frontend",
        "Operations",
        "FRONTEND",
        "Backend",
        frontendId,
        "frontend",
        "Operations",
        "FRONTEND",
      ])
      const mutations = writes(server.graphqlRequests)
      assertEquals(mutations.length, operation === "replace" ? 1 : 2)
      assertEquals(beforeWrites, mutations.length)
      for (const mutation of mutations) {
        const input = mutation.variables.input as Record<string, unknown>
        assertEquals(
          input[operation === "add" ? "addedLabelIds" : "labelIds"],
          [backendId, frontendId, opsId],
        )
      }
    } finally {
      await cleanup()
    }
  })
}

const invalidLabelScenarios = [
  {
    name: "missing name",
    reference: "Missing",
    connection: { nodes: [], pageInfo: terminalPage },
    error: NotFoundError,
  },
  {
    name: "missing UUID",
    reference: backendId,
    connection: { nodes: [], pageInfo: terminalPage },
    error: NotFoundError,
  },
  {
    name: "wrong UUID identity",
    reference: backendId,
    connection: { nodes: [labels[2]], pageInfo: terminalPage },
    error: CliError,
  },
  {
    name: "group UUID",
    reference: backendId,
    connection: {
      nodes: [{ ...labels[1], isGroup: true }],
      pageInfo: terminalPage,
    },
    error: ValidationError,
  },
  {
    name: "wrong-team UUID",
    reference: backendId,
    connection: {
      nodes: [{ ...labels[1], team: otherTeam }],
      pageInfo: terminalPage,
    },
    error: ValidationError,
  },
  {
    name: "missing scope",
    reference: backendId,
    connection: {
      nodes: [{ id: backendId, isGroup: false }],
      pageInfo: terminalPage,
    },
    error: CliError,
  },
  {
    name: "missing group",
    reference: backendId,
    connection: {
      nodes: [{ id: backendId, team: null }],
      pageInfo: terminalPage,
    },
    error: CliError,
  },
  {
    name: "missing stable identity",
    reference: "Backend",
    connection: { nodes: [{ id: "" }], pageInfo: terminalPage },
    error: CliError,
  },
  {
    name: "missing nodes",
    reference: "Backend",
    connection: { pageInfo: terminalPage },
    error: CliError,
  },
  {
    name: "missing pageInfo",
    reference: "Backend",
    connection: { nodes: [labels[1]] },
    error: CliError,
  },
  // Neither a locally exact match nor a not-yet-read page may hide ambiguity.
  {
    name: "server Unicode ambiguity",
    reference: "ς",
    connection: {
      nodes: [{ id: frontendId, name: "ς" }, { id: backendId, name: "Σ" }],
      pageInfo: terminalPage,
    },
    error: ValidationError,
  },
  {
    name: "additional server matches",
    reference: "Backend",
    connection: {
      nodes: [labels[1]],
      pageInfo: { hasNextPage: true, endCursor: "next" },
    },
    error: ValidationError,
  },
]

for (const operation of ["create", "add"] as const) {
  for (const scenario of invalidLabelScenarios) {
    for (const multiple of [false, true]) {
      Deno.test(`${operation} rejects ${scenario.name} consistently with multiple=${multiple}`, async () => {
        const { server, cleanup } = await setupLabelWriteServer([{
          queryName: scenario.reference === backendId
            ? "GetIssueLabelForWrite"
            : "GetIssueLabelIdByNameForTeam",
          response: () => ({ data: { issueLabels: scenario.connection } }),
          variables: scenario.reference === backendId
            ? { id: backendId }
            : { name: scenario.reference },
        }])
        let beforeWrites = 0
        try {
          const error = await assertRejects(() =>
            writeLabels(
              operation,
              multiple
                ? ["Operations", scenario.reference]
                : [scenario.reference],
              () => {
                beforeWrites++
                return Promise.resolve()
              },
            ), scenario.error)
          const result = errorResult(error)
          assertEquals(result.effect, "none")
          assertEquals(result.error.code, scenario.error.name)
          assertEquals(beforeWrites, 0)
          assertEquals(writes(server.graphqlRequests), [])
        } finally {
          await cleanup()
        }
      })
    }
  }
}

for (const multiple of [false, true]) {
  Deno.test(`UUID lookup preserves server errors with multiple=${multiple}`, async () => {
    const { server, cleanup } = await setupLabelWriteServer([{
      queryName: "GetIssueLabelForWrite",
      response: {
        errors: [{
          message: "Permission denied",
          extensions: { code: "FORBIDDEN" },
        }],
      },
    }])
    try {
      const error = await assertRejects(
        () =>
          writeLabels("add", multiple ? ["Frontend", backendId] : [backendId]),
        Error,
        "Permission denied",
      )
      assertEquals(error instanceof NotFoundError, false)
      assertEquals(errorResult(error).effect, "none")
      assertEquals(writes(server.graphqlRequests), [])
    } finally {
      await cleanup()
    }
  })
}

for (const operation of ["create", "update"] as const) {
  for (const multiple of [false, true]) {
    Deno.test(`${operation} CLI reports a missing UUID as one JSON NotFoundError with multiple=${multiple}`, async () => {
      const { server, cleanup } = await setupLabelWriteServer([{
        queryName: "GetIssueLabelForWrite",
        response: {
          data: { issueLabels: { nodes: [], pageInfo: terminalPage } },
        },
      }])
      try {
        const option = operation === "create" ? "--label" : "--add-label"
        const result = await new Deno.Command(Deno.execPath(), {
          args: [
            "run",
            ...commonDenoArgs,
            "src/main.ts",
            "issue",
            operation,
            "--json",
            ...(operation === "create"
              ? ["--title", "Missing", "--team", "ENG", "--no-interactive"]
              : ["ENG-123"]),
            ...(multiple ? [option, "Frontend"] : []),
            option,
            backendId,
          ],
          stdin: "null",
          stdout: "piped",
          stderr: "piped",
        }).output()
        assertEquals(result.code, 1)
        assertEquals(new TextDecoder().decode(result.stderr), "")
        const output = JSON.parse(new TextDecoder().decode(result.stdout))
        assertEquals(output.ok, false)
        assertEquals(output.effect, "none")
        assertEquals(output.error.code, "NotFoundError")
        assertStringIncludes(output.error.message, backendId)
        assertEquals(writes(server.graphqlRequests), [])
      } finally {
        await cleanup()
      }
    })
  }
}

for (const swap of [false, true]) {
  Deno.test(`update rejects resolved add-remove overlap (${swap})`, async () => {
    const { server, cleanup } = await setupLabelWriteServer()
    let beforeWrites = 0
    try {
      await assertRejects(
        () =>
          updateIssue({
            addLabel: swap
              ? [frontendId.toUpperCase()]
              : ["Frontend", "Frontend"],
            removeLabel: swap ? ["frontend"] : [frontendId],
            beforeWrite: () => {
              beforeWrites++
              return Promise.resolve()
            },
          }, "ENG-123"),
        ValidationError,
        "Cannot add and remove the same label",
      )
      assertEquals(labelLookups(server.graphqlRequests).length, 2)
      assertEquals(beforeWrites, 0)
      assertEquals(writes(server.graphqlRequests), [])
    } finally {
      await cleanup()
    }
  })
}

for (const drift of ["team", "identity", "labels"] as const) {
  Deno.test(`update rereads after label resolution and rejects ${drift} drift`, async () => {
    let reads = 0
    const original = issueWriteBasis()
    const { server, cleanup } = await setupLabelWriteServer([{
      queryName: "GetIssueForWrite",
      response: () => {
        const current = structuredClone(original)
        if (++reads === 2) {
          if (drift === "team") current.issue.team = otherTeam
          if (drift === "identity") current.issue.id = opsId
          if (drift === "labels") {
            current.issue.labels.nodes = [{ id: opsId, name: "Concurrent" }]
          }
        }
        return { data: current }
      },
    }])
    try {
      await assertRejects(() =>
        updateIssue({ label: ["Frontend", "Backend"], original }, "ENG-123")
      )
      assertEquals(reads, 2)
      assertEquals(labelLookups(server.graphqlRequests).length, 2)
      assertStringIncludes(
        server.graphqlRequests.at(-1)!.query,
        "query GetIssueForWrite",
      )
      assertEquals(server.graphqlRequests.at(-1)!.variables.id, issueWriteId)
      assertEquals(writes(server.graphqlRequests), [])
    } finally {
      await cleanup()
    }
  })
}

Deno.test("interactive create retains sequential label candidate prompts", async () => {
  const { server, cleanup } = await setupLabelWriteServer([
    {
      queryName: "GetIssueLabelIdByNameForTeam",
      response: {
        data: { issueLabels: { nodes: [], pageInfo: terminalPage } },
      },
    },
    {
      queryName: "GetIssueLabelIdOptionsByNameForTeam",
      response: { data: { issueLabels: { nodes: labels.slice(0, 2) } } },
    },
  ])
  using prompt = stub(Select, "prompt", () => Promise.resolve(backendId))
  try {
    await createIssue({
      title: "Interactive",
      team: "ENG",
      label: ["Partial", "Other"],
      interactive: true,
    })
    assertEquals(prompt.calls.length, 2)
    assertEquals(
      server.graphqlRequests.slice(1, -1).map((r) =>
        r.query.match(/query (\w+)/)?.[1]
      ),
      [
        "GetIssueLabelIdByNameForTeam",
        "GetIssueLabelIdOptionsByNameForTeam",
        "GetIssueLabelIdByNameForTeam",
        "GetIssueLabelIdOptionsByNameForTeam",
      ],
    )
    assertEquals(
      (writes(server.graphqlRequests)[0].variables.input as Record<
        string,
        unknown
      >).labelIds,
      [backendId],
    )
  } finally {
    await cleanup()
  }
})

for (const operation of ["create", "update"] as const) {
  for (const priority of [-1, 5, 1.5, NaN, Infinity]) {
    Deno.test(`${operation} shared entry rejects priority ${priority} before transport`, async () => {
      const { server, cleanup } = await setupLabelWriteServer()
      let beforeWrites = 0
      const beforeWrite = () => {
        beforeWrites++
        return Promise.resolve()
      }
      try {
        await assertRejects(
          () =>
            operation === "create"
              ? createIssue({
                title: "Priority",
                team: "ENG",
                priority,
                beforeWrite,
              })
              : updateIssue(
                { priority, unprotected: true, beforeWrite },
                "ENG-123",
              ),
          ValidationError,
          "Priority must be an integer from 0 to 4",
        )
        assertEquals(server.graphqlRequests, [])
        assertEquals(beforeWrites, 0)
      } finally {
        await cleanup()
      }
    })
  }
  for (const priority of [0, 1, 2, 3, 4]) {
    Deno.test(`${operation} shared entry accepts priority ${priority}`, async () => {
      const current = issueWriteBasis()
      current.issue.priority = priority === 4 ? 0 : 4
      const { server, cleanup } = await setupLabelWriteServer([{
        queryName: "GetIssueForWrite",
        response: { data: current },
      }])
      try {
        if (operation === "create") {
          await createIssue({ title: "Priority", team: "ENG", priority })
        } else await updateIssue({ priority, unprotected: true }, "ENG-123")
        assertEquals(
          (writes(server.graphqlRequests)[0].variables.input as Record<
            string,
            unknown
          >).priority,
          priority,
        )
      } finally {
        await cleanup()
      }
    })
  }
}

import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert"
import { createIssue } from "../../../src/commands/issue/issue-create.ts"
import { updateIssue } from "../../../src/commands/issue/issue-update.ts"
import { ValidationError } from "../../../src/utils/errors.ts"
import { Select } from "../../../src/utils/prompt.ts"
import { stub } from "@std/testing/mock"
import type { MockGraphQLRequest } from "../../utils/mock_linear_server.ts"
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

function setupLabelWriteServer(
  responses: NonNullable<Parameters<typeof setupIssueWriteServer>[0]> = [],
) {
  return setupIssueWriteServer([
    ...responses,
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
    /query (ResolveIssueLabelsForWrite|GetIssueLabelIdByNameForTeam|GetIssueLabelForWrite)\b/
      .test(request.query)
  )
}

for (const operation of ["create", "update"] as const) {
  for (const pages of [1, 2, 4]) {
    Deno.test(`${operation} multi-label lookup request count and mutation IDs (${pages} pages)`, async () => {
      const { server, cleanup } = await setupLabelWriteServer([{
        queryName: "ResolveIssueLabelsForWrite",
        response: ({ variables }) => {
          const page = variables.after == null ? 1 : Number(variables.after) + 1
          return {
            data: {
              issueLabels: {
                nodes: pages === 1
                  ? labels
                  : page === 1
                  ? labels.slice(0, 1)
                  : page === pages
                  ? labels.slice(1)
                  : [],
                pageInfo: page < pages
                  ? { hasNextPage: true, endCursor: String(page) }
                  : terminalPage,
              },
            },
          }
        },
      }])
      let beforeWrites = 0
      const beforeWrite = () => {
        beforeWrites++
        assertEquals(
          server.graphqlRequests.some((request) =>
            request.query.includes("mutation ")
          ),
          false,
        )
        return Promise.resolve()
      }
      try {
        if (operation === "create") {
          await createIssue({
            title: "Label count",
            team: "ENG",
            label: ["Backend", "Frontend", "Operations"],
            beforeWrite,
          })
        } else {
          await updateIssue({
            addLabel: ["Frontend", "Operations"],
            removeLabel: ["Backend"],
            beforeWrite,
          }, "ENG-123")
        }
        const lookups = labelLookups(server.graphqlRequests)
        // Before batching these same operation inputs made three direct lookups.
        assertEquals(lookups.length, pages)
        assertEquals(
          lookups.map((request) => request.variables.after),
          [
            undefined,
            ...Array.from(
              { length: pages - 1 },
              (_, index) => String(index + 1),
            ),
          ],
        )
        const names = operation === "create"
          ? ["Backend", "Frontend", "Operations"]
          : ["Frontend", "Operations", "Backend"]
        for (const request of lookups) {
          assertEquals(request.variables.filter, {
            or: names.map((name) => ({
              name: { eqIgnoreCase: name },
              isGroup: { eq: false },
              or: [{ team: { id: { eq: teamWriteIds.ENG } } }, {
                team: { null: true },
              }],
            })),
          })
          assertStringIncludes(request.query, "first: 100")
        }
        const writes = server.graphqlRequests.filter((request) =>
          request.query.includes("mutation ")
        )
        assertEquals(writes.length, 1)
        const input = writes[0].variables.input as Record<string, unknown>
        if (operation === "create") {
          assertEquals(input.labelIds, [backendId, frontendId, opsId])
          assertEquals(input.teamId, teamWriteIds.ENG)
        } else {
          assertEquals(writes[0].variables.id, issueWriteId)
          assertEquals(input, {
            addedLabelIds: [frontendId, opsId],
            removedLabelIds: [backendId],
          })
          const finalRead = server.graphqlRequests.at(-2)!
          assertStringIncludes(finalRead.query, "query GetIssueForWrite")
          assertEquals(finalRead.variables.id, issueWriteId)
        }
        assertEquals(beforeWrites, 1)
      } finally {
        await cleanup()
      }
    })
  }
}

for (const operation of ["create", "replace", "increment"] as const) {
  Deno.test(`${operation} mixed UUID/name labels deduplicate in first-input order without caching writes`, async () => {
    const { server, cleanup } = await setupLabelWriteServer([{
      queryName: "ResolveIssueLabelsForWrite",
      response: {
        data: { issueLabels: { nodes: labels, pageInfo: terminalPage } },
      },
    }])
    const references = [
      "Backend",
      frontendId.toUpperCase(),
      "Backend",
      "frontend",
      "Operations",
      "FRONTEND",
    ]
    let beforeWrites = 0
    const beforeWrite = () => {
      beforeWrites++
      return Promise.resolve()
    }
    try {
      for (let invocation = 0; invocation < 2; invocation++) {
        if (operation === "create") {
          await createIssue({
            title: "Duplicates",
            team: "ENG",
            label: references,
            beforeWrite,
          })
        } else {
          await updateIssue(
            operation === "replace"
              ? { label: references, unprotected: true, beforeWrite }
              : { addLabel: references, beforeWrite },
            "ENG-123",
          )
        }
      }
      const lookups = labelLookups(server.graphqlRequests)
      assertEquals(lookups.length, 2)
      assertEquals(lookups[0].variables.filter, {
        or: [
          {
            name: { eqIgnoreCase: "Backend" },
            isGroup: { eq: false },
            or: [{ team: { id: { eq: teamWriteIds.ENG } } }, {
              team: { null: true },
            }],
          },
          { id: { eq: frontendId } },
          {
            name: { eqIgnoreCase: "frontend" },
            isGroup: { eq: false },
            or: [{ team: { id: { eq: teamWriteIds.ENG } } }, {
              team: { null: true },
            }],
          },
          {
            name: { eqIgnoreCase: "Operations" },
            isGroup: { eq: false },
            or: [{ team: { id: { eq: teamWriteIds.ENG } } }, {
              team: { null: true },
            }],
          },
        ],
      })
      const writes = server.graphqlRequests.filter((request) =>
        request.query.includes("mutation ")
      )
      // A second replacement is a no-op, but still resolves fresh references.
      assertEquals(writes.length, operation === "replace" ? 1 : 2)
      assertEquals(beforeWrites, writes.length)
      for (const write of writes) {
        const input = write.variables.input as Record<string, unknown>
        assertEquals(
          input[operation === "increment" ? "addedLabelIds" : "labelIds"],
          [backendId, frontendId, opsId],
        )
        if (operation !== "create") {
          assertEquals(write.variables.id, issueWriteId)
          assertEquals(Object.keys(input), [
            operation === "increment" ? "addedLabelIds" : "labelIds",
          ])
        }
      }
    } finally {
      await cleanup()
    }
  })
}

for (const operation of ["create", "update"] as const) {
  for (const byId of [false, true]) {
    Deno.test(`${operation} repeated single label retains direct ${byId ? "UUID" : "name"} lookup`, async () => {
      const reference = byId ? frontendId.toUpperCase() : "Frontend"
      const { server, cleanup } = await setupLabelWriteServer([{
        queryName: byId
          ? "GetIssueLabelForWrite"
          : "GetIssueLabelIdByNameForTeam",
        response: {
          data: byId
            ? { issueLabel: labels[0] }
            : { issueLabels: { nodes: [labels[0]], pageInfo: terminalPage } },
        },
      }])
      try {
        const references = [reference, reference.toLowerCase(), reference]
        if (operation === "create") {
          await createIssue({ title: "Single", team: "ENG", label: references })
        } else {
          await updateIssue({ addLabel: references }, "ENG-123")
        }
        assertEquals(labelLookups(server.graphqlRequests).length, 1)
        const input = server.graphqlRequests.at(-1)!.variables.input as Record<
          string,
          unknown
        >
        assertEquals(
          input[operation === "create" ? "labelIds" : "addedLabelIds"],
          [frontendId],
        )
      } finally {
        await cleanup()
      }
    })
  }
}

const otherTeam = { id: teamWriteIds.OPS, key: "OPS" }
const duplicateFrontend = {
  ...labels[0],
  id: opsId,
  team: { id: teamWriteIds.ENG, key: "ENG" },
}
const invalidLabelScenarios = [
  {
    name: "missing name",
    references: ["Frontend", "Missing"],
    nodes: labels,
    error: "Missing",
  },
  {
    name: "missing UUID",
    references: ["Frontend", backendId],
    nodes: [labels[0]],
    error: backendId,
  },
  {
    name: "wrong UUID identity",
    references: ["Frontend", backendId],
    nodes: [labels[0], { ...labels[1], id: opsId }],
    error: backendId,
  },
  {
    name: "ambiguous team and global name",
    references: ["Frontend", "Backend"],
    nodes: [labels[0], labels[1], duplicateFrontend],
    error: "ambiguous",
  },
  {
    name: "group UUID",
    references: ["Frontend", backendId],
    nodes: [labels[0], { ...labels[1], isGroup: true }],
    error: "not assignable",
  },
  {
    name: "wrong-team UUID",
    references: ["Frontend", backendId],
    nodes: [labels[0], { ...labels[1], team: otherTeam }],
    error: "not assignable",
  },
  {
    name: "group name",
    references: ["Frontend", "Backend"],
    nodes: [labels[0], { ...labels[1], isGroup: true }],
    error: "Backend",
  },
  {
    name: "wrong-team name",
    references: ["Frontend", "Backend"],
    nodes: [labels[0], { ...labels[1], team: otherTeam }],
    error: "Backend",
  },
  {
    name: "wrong name",
    references: ["Frontend", "Backend"],
    nodes: [labels[0], { ...labels[1], name: "Other" }],
    error: "Backend",
  },
  {
    name: "missing stable identity",
    references: ["Frontend", "Backend"],
    nodes: [labels[0], { ...labels[1], id: "" }],
    error: "incomplete label",
  },
  {
    name: "missing scope",
    references: ["Frontend", "Backend"],
    nodes: [labels[0], { id: backendId, name: "Backend", isGroup: false }],
    error: "incomplete label",
  },
  {
    name: "blank reference",
    references: ["Frontend", " \t"],
    nodes: labels,
    error: "empty",
  },
]

for (const operation of ["create", "update"] as const) {
  for (const scenario of invalidLabelScenarios) {
    Deno.test(`${operation} batched labels reject ${scenario.name} before write`, async () => {
      const { server, cleanup } = await setupLabelWriteServer([{
        queryName: "ResolveIssueLabelsForWrite",
        response: {
          data: {
            issueLabels: { nodes: scenario.nodes, pageInfo: terminalPage },
          },
        },
      }])
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
                title: "Invalid",
                team: "ENG",
                label: scenario.references,
                beforeWrite,
              })
              : updateIssue(
                { addLabel: scenario.references, beforeWrite },
                "ENG-123",
              ),
          Error,
          scenario.error,
        )
        assertEquals(beforeWrites, 0)
        assertEquals(
          server.graphqlRequests.some((request) =>
            request.query.includes("mutation ")
          ),
          false,
        )
        if (scenario.name === "blank reference") {
          assertEquals(server.graphqlRequests, [])
        }
      } finally {
        await cleanup()
      }
    })
  }
}

const malformedPages = [
  {
    name: "missing nodes",
    pages: [{ pageInfo: terminalPage }],
    error: "missing nodes",
  },
  {
    name: "missing pageInfo",
    pages: [{ nodes: labels }],
    error: "missing pageInfo",
  },
  {
    name: "malformed terminal pageInfo",
    pages: [{ nodes: labels, pageInfo: { hasNextPage: false, endCursor: 1 } }],
    error: "missing pageInfo",
  },
  {
    name: "missing cursor",
    pages: [{
      nodes: labels,
      pageInfo: { hasNextPage: true, endCursor: null },
    }],
    error: "empty or repeated cursor",
  },
  {
    name: "empty cursor",
    pages: [{ nodes: labels, pageInfo: { hasNextPage: true, endCursor: "" } }],
    error: "empty or repeated cursor",
  },
  {
    name: "repeated cursor",
    pages: ["A", "A"].map((endCursor) => ({
      nodes: labels,
      pageInfo: { hasNextPage: true, endCursor },
    })),
    error: "empty or repeated cursor",
  },
  {
    name: "cursor cycle",
    pages: ["A", "B", "A"].map((endCursor) => ({
      nodes: [],
      pageInfo: { hasNextPage: true, endCursor },
    })),
    error: "empty or repeated cursor",
  },
  {
    name: "missing later page",
    pages: [
      { nodes: labels, pageInfo: { hasNextPage: true, endCursor: "A" } },
      null,
    ],
    error: "missing nodes",
  },
  {
    name: "late ambiguity",
    pages: [
      { nodes: labels, pageInfo: { hasNextPage: true, endCursor: "A" } },
      { nodes: [duplicateFrontend], pageInfo: terminalPage },
    ],
    error: "ambiguous",
  },
]

for (const operation of ["create", "update"] as const) {
  for (const scenario of malformedPages) {
    Deno.test(`${operation} batched label pagination rejects ${scenario.name} even after matches`, async () => {
      let page = 0
      const { server, cleanup } = await setupLabelWriteServer([{
        queryName: "ResolveIssueLabelsForWrite",
        response: () => ({ data: { issueLabels: scenario.pages[page++] } }),
      }])
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
                title: "Pagination",
                team: "ENG",
                label: ["Frontend", "Backend"],
                beforeWrite,
              })
              : updateIssue(
                { addLabel: ["Frontend", "Backend"], beforeWrite },
                "ENG-123",
              ),
          Error,
          scenario.error,
        )
        assertEquals(page, scenario.pages.length)
        assertEquals(beforeWrites, 0)
        assertEquals(
          server.graphqlRequests.some((request) =>
            request.query.includes("mutation ")
          ),
          false,
        )
      } finally {
        await cleanup()
      }
    })
  }
}

for (const swap of [false, true]) {
  Deno.test(`update detects mixed UUID/name add-remove conflict (${swap})`, async () => {
    const { server, cleanup } = await setupLabelWriteServer([{
      queryName: "ResolveIssueLabelsForWrite",
      response: {
        data: { issueLabels: { nodes: [labels[0]], pageInfo: terminalPage } },
      },
    }])
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
      assertEquals(labelLookups(server.graphqlRequests).length, 1)
      assertEquals(beforeWrites, 0)
      assertEquals(
        server.graphqlRequests.some((request) =>
          request.query.includes("mutation ")
        ),
        false,
      )
    } finally {
      await cleanup()
    }
  })
}

for (const drift of ["team", "identity", "labels"] as const) {
  Deno.test(`update rereads after all batched label pages and rejects ${drift} drift`, async () => {
    let reads = 0
    const original = issueWriteBasis()
    const { server, cleanup } = await setupLabelWriteServer([
      {
        queryName: "ResolveIssueLabelsForWrite",
        response: ({ variables }) => ({
          data: {
            issueLabels: {
              nodes: variables.after == null
                ? labels.slice(0, 1)
                : labels.slice(1),
              pageInfo: variables.after == null
                ? { hasNextPage: true, endCursor: "A" }
                : terminalPage,
            },
          },
        }),
      },
      {
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
      },
    ])
    let beforeWrites = 0
    try {
      await assertRejects(() =>
        updateIssue({
          label: ["Frontend", "Backend"],
          original,
          beforeWrite: () => {
            beforeWrites++
            return Promise.resolve()
          },
        }, "ENG-123")
      )
      assertEquals(reads, 2)
      assertEquals(labelLookups(server.graphqlRequests).length, 2)
      assertStringIncludes(
        server.graphqlRequests.at(-1)!.query,
        "query GetIssueForWrite",
      )
      assertEquals(server.graphqlRequests.at(-1)!.variables.id, issueWriteId)
      assertEquals(beforeWrites, 0)
      assertEquals(
        server.graphqlRequests.some((request) =>
          request.query.includes("mutation ")
        ),
        false,
      )
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
  const prompt = stub(Select, "prompt", () => Promise.resolve(backendId))
  try {
    await createIssue({
      title: "Interactive",
      team: "ENG",
      label: ["Partial", "Other"],
      interactive: true,
    })
    assertEquals(prompt.calls.length, 2)
    assertEquals(
      server.graphqlRequests.slice(1, -1).map((request) =>
        request.query.match(/query (\w+)/)?.[1]
      ),
      [
        "GetIssueLabelIdByNameForTeam",
        "GetIssueLabelIdOptionsByNameForTeam",
        "GetIssueLabelIdByNameForTeam",
        "GetIssueLabelIdOptionsByNameForTeam",
      ],
    )
    const input = server.graphqlRequests.at(-1)!.variables.input as Record<
      string,
      unknown
    >
    assertEquals(input.labelIds, [backendId])
  } finally {
    prompt.restore()
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
        } else {
          await updateIssue({ priority, unprotected: true }, "ENG-123")
        }
        const input = server.graphqlRequests.at(-1)!.variables.input as Record<
          string,
          unknown
        >
        assertEquals(input.priority, priority)
      } finally {
        await cleanup()
      }
    })
  }
}

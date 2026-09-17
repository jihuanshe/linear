import { assertEquals, assertMatch, assertStringIncludes } from "@std/assert"
import { fromFileUrl } from "@std/path"
import { MockLinearServer } from "../../utils/mock_linear_server.ts"

const main = fromFileUrl(new URL("../../../src/main.ts", import.meta.url))
const issueId = "11111111-1111-4111-8111-000000000123"
const createdAt = "2026-09-05T00:00:00Z"
const terminalPage = { hasNextPage: false, endCursor: "history-last" }

function historyEntry(overrides: Record<string, unknown> = {}) {
  return {
    id: "history-1",
    createdAt,
    updatedAt: createdAt,
    actor: { id: "user-1", name: "alex", displayName: "Alex" },
    botActor: null,
    changes: null,
    ...overrides,
  }
}

function historyResponse(
  nodes: unknown[],
  pageInfo: { hasNextPage: boolean; endCursor: string | null } = terminalPage,
  variables: Record<string, unknown> = { id: "TEST-123", first: 100 },
) {
  return {
    queryName: "GetIssueHistory",
    variables,
    response: {
      data: { issue: { id: issueId, history: { nodes, pageInfo } } },
    },
  }
}

async function runHistory(server: MockLinearServer, args: string[] = []) {
  const output = await new Deno.Command(Deno.execPath(), {
    args: [
      "run",
      "--allow-all",
      "--quiet",
      main,
      "issue",
      "history",
      "TEST-123",
      ...args,
    ],
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

function assertReadFailure(
  result: Awaited<ReturnType<typeof runHistory>>,
  message: string,
) {
  assertEquals(result.code, 1)
  // Parse all of stdout to reject partial history before or after the error.
  const error = JSON.parse(result.stdout)
  assertEquals(Object.keys(error).sort(), ["effect", "error", "ok"])
  assertEquals(error.ok, false)
  assertEquals(error.effect, "none")
  assertStringIncludes(error.error.message, message)
  assertEquals(result.stderr, "")
}

Deno.test("issue history help documents all pages and the optional limit", async () => {
  const server = new MockLinearServer()
  server.start()
  try {
    const result = await runHistory(server, ["--help"])
    assertEquals(result.code, 0, result.stderr)
    assertStringIncludes(result.stdout, "all pages by default")
    assertStringIncludes(result.stdout, "--limit")
    assertStringIncludes(result.stdout, "0 for all pages")
    assertStringIncludes(result.stdout, "--json")
    assertEquals(server.graphqlRequests.length, 0)
  } finally {
    await server.stop()
  }
})

for (
  const scenario of [
    {
      name: "property changes, labels and relations",
      fields: {
        fromTitle: "Old title",
        toTitle: "New title",
        fromPriority: 2,
        toPriority: 0,
        fromEstimate: null,
        toEstimate: 3,
        fromDueDate: "2026-09-30",
        toDueDate: null,
        fromAssignee: null,
        toAssignee: { id: "user-1", name: "alex", displayName: "Alex" },
        fromState: {
          id: "state-1",
          name: "Todo",
          type: "unstarted",
          color: "#aaa",
        },
        toState: {
          id: "state-2",
          name: "Done",
          type: "completed",
          color: "#f00",
        },
        fromProject: { id: "project-1", name: "Old", slugId: "old" },
        toProject: { id: "project-2", name: "New", slugId: "new" },
        addedLabelIds: ["label-1"],
        removedLabelIds: ["label-2"],
        relationChanges: [{ identifier: "TEST-99", type: "added" }],
        changes: { priority: { from: 2, to: 0 } },
      },
      text:
        'Alex: title: Old title -> New title; priority: 2 -> 0; estimate: - -> 3; due date: 2026-09-30 -> -; assignee: - -> Alex; state: Todo -> Done; project: Old -> New; labels added: label-1; labels removed: label-2; relations: [{"identifier":"TEST-99","type":"added"}]; changes: {"priority":{"from":2,"to":0}}',
    },
    {
      name: "unnamed cycles",
      fields: {
        fromCycle: { id: "cycle-4", number: 4, name: null },
        toCycle: { id: "cycle-5", number: 5, name: null },
      },
      text: "Alex: cycle: Cycle 4 -> Cycle 5",
    },
    {
      name: "project conversion",
      fields: {
        toConvertedProject: {
          id: "project-converted",
          name: "Converted Project",
          slugId: "converted-project",
        },
        toConvertedProjectId: "project-converted",
      },
      text: "Alex: converted to project: Converted Project (project-converted)",
    },
    {
      name: "attachment details",
      fields: {
        attachment: {
          id: "attachment-1",
          title: "Design spec",
          url: "https://notion.so/design-spec",
        },
        attachmentId: "attachment-1",
      },
      text:
        "Alex: attachment: Design spec (attachment-1) - https://notion.so/design-spec",
    },
    {
      name: "attachment ID without resolved details",
      fields: { attachment: null, attachmentId: "attachment-deleted" },
      text: "Alex: attachment: attachment-deleted",
    },
    {
      name: "description editors separate from the history actor",
      fields: {
        actor: {
          id: "actor-1",
          name: "workflow",
          displayName: "Workflow Actor",
        },
        updatedDescription: true,
        descriptionUpdatedBy: [{
          id: "editor-1",
          name: "description.editor",
          displayName: "Description Editor",
        }],
      },
      text: "Workflow Actor: description updated by: Description Editor",
    },
    {
      name: "automatic lifecycle flags",
      fields: {
        archived: true,
        trashed: false,
        autoArchived: true,
        autoClosed: true,
      },
      text:
        "Alex: archived: true; trashed: false; automatically archived; automatically closed",
    },
    {
      name: "bot provenance takes precedence over a human actor",
      fields: {
        actor: {
          id: "external",
          name: "external",
          displayName: "External Human",
        },
        botActor: {
          id: "bot-1",
          name: "Automation Bot",
          type: "integration",
          subType: "workflow",
          userDisplayName: "Jordan",
        },
      },
      text: "Automation Bot (bot:integration) [user: Jordan]: metadata changed",
    },
    {
      name: "system actor and false automatic flags",
      fields: { actor: null, autoArchived: false, autoClosed: false },
      text: "system: metadata changed",
    },
    {
      name: "milestone, parent, team, delegation, SLA and releases",
      fields: {
        fromProjectMilestone: null,
        toProjectMilestone: { id: "milestone-1", name: "Launch" },
        fromParent: { id: "parent-1", identifier: "TEST-1", title: "Parent" },
        toParent: null,
        fromTeam: { id: "team-1", key: "OLD", name: "Old team" },
        toTeam: { id: "team-2", key: "NEW", name: "New team" },
        fromDelegate: null,
        toDelegate: {
          id: "delegate-1",
          name: "delegate",
          displayName: "Delegate",
        },
        fromSlaBreached: false,
        toSlaBreached: true,
        fromSlaBreachesAt: null,
        toSlaBreachesAt: "2026-09-30T00:00:00Z",
        fromSlaStartedAt: null,
        toSlaStartedAt: createdAt,
        fromSlaType: null,
        toSlaType: "highPriority",
        addedToReleaseIds: ["release-2"],
        removedFromReleaseIds: ["release-1"],
      },
      text:
        "Alex: milestone: - -> Launch; parent: TEST-1 -> -; team: Old team -> New team; delegate: - -> Delegate; SLA breached: false -> true; SLA breaches at: - -> 2026-09-30T00:00:00Z; SLA started at: - -> 2026-09-05T00:00:00Z; SLA type: - -> highPriority; releases added: release-2; releases removed: release-1",
    },
  ]
) {
  Deno.test(`issue history preserves ${scenario.name} in JSON and human output`, async () => {
    const entry = historyEntry(scenario.fields)
    const server = new MockLinearServer([historyResponse([entry])])
    server.start()
    try {
      const json = await runHistory(server, ["--json"])
      assertEquals(json.code, 0, json.stdout + json.stderr)
      assertEquals(json.stderr, "")
      assertEquals(JSON.parse(json.stdout), {
        nodes: [entry],
        pageInfo: terminalPage,
      })
      assertEquals(server.graphqlRequests.length, 1)
      const query = server.graphqlRequests[0].query
      assertMatch(query, /issue\(id: \$id\)\s*\{\s*id\s+history\(/)
      assertMatch(query, /orderBy: createdAt/)
      // The mock returns fixtures regardless of selection; ensure these fields
      // are also requested, so omitting provenance cannot pass by fixture alone.
      for (const field of Object.keys(entry)) {
        assertMatch(query, new RegExp(`\\b${field}\\b`))
      }
      assertMatch(query, /attachment\s*\{\s*id\s+title\s+url\s*\}/)
      assertMatch(
        query,
        /descriptionUpdatedBy\s*\{\s*id\s+name\s+displayName\s*\}/,
      )

      const human = await runHistory(server)
      assertEquals(human.code, 0, human.stderr)
      assertEquals(human.stderr, "")
      assertEquals(human.stdout, `${createdAt} ${scenario.text}\n`)
      assertEquals(server.graphqlRequests.length, 2)
    } finally {
      await server.stop()
    }
  })
}

for (const limit of [undefined, 0, 100, 101]) {
  Deno.test(`issue history limit ${limit ?? "default"} retains pageInfo and uses the first page UUID`, async () => {
    const firstNodes = Array.from(
      { length: 100 },
      (_, index) => historyEntry({ id: `history-${index}` }),
    )
    const late = historyEntry({ id: "late" })
    const last = historyEntry({ id: "last" })
    const next = { hasNextPage: true, endCursor: "next" }
    const more = { hasNextPage: true, endCursor: "more" }
    const server = new MockLinearServer([
      historyResponse(firstNodes, next),
      historyResponse([late], more, {
        id: issueId,
        first: limit === 101 ? 1 : 100,
        after: "next",
      }),
      historyResponse([last], terminalPage, {
        id: issueId,
        first: 100,
        after: "more",
      }),
    ])
    server.start()
    try {
      const result = await runHistory(server, [
        "--json",
        ...(limit == null ? [] : ["--limit", String(limit)]),
      ])
      assertEquals(result.code, 0, result.stdout + result.stderr)
      assertEquals(result.stderr, "")
      assertEquals(JSON.parse(result.stdout), {
        nodes: limit === 100
          ? firstNodes
          : limit === 101
          ? [...firstNodes, late]
          : [...firstNodes, late, last],
        pageInfo: limit === 100 ? next : limit === 101 ? more : terminalPage,
      })
      assertEquals(server.graphqlRequests.map(({ variables }) => variables), [
        { id: "TEST-123", first: 100 },
        ...(limit === 100
          ? []
          : [{ id: issueId, first: limit === 101 ? 1 : 100, after: "next" }]),
        ...(limit === 100 || limit === 101
          ? []
          : [{ id: issueId, first: 100, after: "more" }]),
      ])
    } finally {
      await server.stop()
    }
  })
}

Deno.test("issue history requests only the remaining small limit and warns when truncated", async () => {
  const first = historyEntry()
  const second = historyEntry({ id: "history-2" })
  const more = { hasNextPage: true, endCursor: "more" }
  const server = new MockLinearServer([
    historyResponse([first], { hasNextPage: true, endCursor: "next" }, {
      id: "TEST-123",
      first: 2,
    }),
    historyResponse([second], more, { id: issueId, first: 1, after: "next" }),
  ])
  server.start()
  try {
    const json = await runHistory(server, ["--limit", "2", "--json"])
    assertEquals(json.code, 0, json.stdout + json.stderr)
    assertEquals(JSON.parse(json.stdout), {
      nodes: [first, second],
      pageInfo: more,
    })
    assertEquals(json.stderr, "")
    assertEquals(server.graphqlRequests.length, 2)
    const human = await runHistory(server, ["--limit", "2"])
    assertEquals(human.code, 0, human.stderr)
    assertStringIncludes(human.stdout, "Warning: history is truncated")
    assertStringIncludes(human.stdout, "increase --limit")
    assertStringIncludes(human.stdout, "--limit 0")
    assertEquals(server.graphqlRequests.length, 4)
  } finally {
    await server.stop()
  }
})

Deno.test("issue history handles an empty terminal connection", async () => {
  const pageInfo = { hasNextPage: false, endCursor: null }
  const server = new MockLinearServer([historyResponse([], pageInfo)])
  server.start()
  try {
    const human = await runHistory(server)
    assertEquals(human.code, 0, human.stderr)
    assertEquals(human.stdout, "No history found for TEST-123\n")
    const json = await runHistory(server, ["--json"])
    assertEquals(json.code, 0, json.stderr)
    assertEquals(JSON.parse(json.stdout), { nodes: [], pageInfo })
  } finally {
    await server.stop()
  }
})

for (const cursors of [["a", "a"], ["a", "b", "a"]]) {
  Deno.test(`issue history rejects cursor cycle ${cursors.join(" -> ")} without partial JSON`, async () => {
    const server = new MockLinearServer(
      cursors.map((endCursor, index) =>
        historyResponse(
          [historyEntry({ id: `history-${index}` })],
          {
            hasNextPage: true,
            endCursor,
          },
          index === 0 ? { id: "TEST-123", first: 100 } : {
            id: issueId,
            first: 100,
            after: cursors[index - 1],
          },
        )
      ),
    )
    server.start()
    try {
      assertReadFailure(
        await runHistory(server, ["--json"]),
        "empty or repeated cursor",
      )
      assertEquals(server.graphqlRequests.length, cursors.length)
    } finally {
      await server.stop()
    }
  })
}

for (
  const { name, history, message } of [
    { name: "missing connection", history: null, message: "missing nodes" },
    {
      name: "missing nodes",
      history: { pageInfo: terminalPage },
      message: "missing nodes",
    },
    {
      name: "missing pageInfo",
      history: { nodes: [] },
      message: "missing pageInfo",
    },
    {
      name: "missing cursor",
      history: { nodes: [], pageInfo: { hasNextPage: true } },
      message: "missing pageInfo",
    },
    ...[null, ""].map((endCursor) => ({
      name: `empty cursor ${JSON.stringify(endCursor)}`,
      history: {
        nodes: [historyEntry()],
        pageInfo: { hasNextPage: true, endCursor },
      },
      message: "empty or repeated cursor",
    })),
  ]
) {
  Deno.test(`issue history rejects ${name} even at its limit`, async () => {
    const server = new MockLinearServer([{
      queryName: "GetIssueHistory",
      response: { data: { issue: { id: issueId, history } } },
    }])
    server.start()
    try {
      assertReadFailure(
        await runHistory(server, ["--json", "--limit", "1"]),
        message,
      )
      assertEquals(server.graphqlRequests.length, 1)
    } finally {
      await server.stop()
    }
  })
}

for (
  const { name, response, message } of [
    {
      name: "missing issue",
      response: { data: { issue: null } },
      message: "Could not read history",
    },
    {
      name: "changed target",
      response: {
        data: {
          issue: {
            id: "22222222-2222-4222-8222-000000000456",
            history: { nodes: [], pageInfo: terminalPage },
          },
        },
      },
      message: "Issue history changed target",
    },
    {
      name: "GraphQL error",
      response: { errors: [{ message: "Later page failed" }] },
      message: "Later page failed",
    },
  ]
) {
  Deno.test(`issue history rejects a later ${name} without partial JSON`, async () => {
    const server = new MockLinearServer([
      historyResponse([historyEntry()], {
        hasNextPage: true,
        endCursor: "next",
      }),
      {
        queryName: "GetIssueHistory",
        variables: { id: issueId, after: "next" },
        response,
      },
    ])
    server.start()
    try {
      assertReadFailure(await runHistory(server, ["--json"]), message)
      assertEquals(server.graphqlRequests.length, 2)
    } finally {
      await server.stop()
    }
  })
}

for (
  const { issue, message } of [
    { issue: null, message: "Issue not found: TEST-123" },
    {
      issue: {
        history: {
          nodes: [historyEntry()],
          pageInfo: { hasNextPage: true, endCursor: "next" },
        },
      },
      message: "Issue history returned no ID",
    },
  ]
) {
  Deno.test(`issue history stops before pagination: ${message}`, async () => {
    const server = new MockLinearServer([{
      queryName: "GetIssueHistory",
      response: { data: { issue } },
    }])
    server.start()
    try {
      assertReadFailure(await runHistory(server, ["--json"]), message)
      assertEquals(server.graphqlRequests.length, 1)
    } finally {
      await server.stop()
    }
  })
}

for (const limit of ["-1", "1.5", "9007199254740992"]) {
  Deno.test(`issue history rejects invalid limit ${limit} before querying`, async () => {
    const server = new MockLinearServer()
    server.start()
    try {
      assertReadFailure(
        await runHistory(server, ["--json", `--limit=${limit}`]),
        "--limit must be a non-negative integer",
      )
      assertEquals(server.graphqlRequests.length, 0)
    } finally {
      await server.stop()
    }
  })
}

import { assertEquals, assertMatch, assertStringIncludes } from "@std/assert"
import { fromFileUrl } from "@std/path"
import { MockLinearServer } from "../../utils/mock_linear_server.ts"

const main = fromFileUrl(new URL("../../../src/main.ts", import.meta.url))
const organization = {
  id: "99999999-9999-4999-8999-999999999999",
  urlKey: "jihuanshe",
}
const issue = {
  id: "11111111-1111-4111-8111-000000000123",
  identifier: "TEST-123",
  title: "Audit the issue",
  url: "https://linear.app/jihuanshe/issue/TEST-123/audit-the-issue",
  createdAt: "2026-09-01T00:00:00Z",
  updatedAt: "2026-09-06T00:00:00Z",
  archivedAt: null,
  trashed: false,
  priority: 2,
  estimate: 3,
  dueDate: "2026-09-30",
  team: { id: "team-1", key: "TEST", name: "Test Team" },
  state: {
    id: "state-1",
    name: "In Progress",
    type: "started",
    color: "#f00",
  },
  assignee: { id: "user-1", name: "alex", displayName: "Alex" },
  project: { id: "project-1", name: "Audit", slugId: "audit-1" },
  projectMilestone: null,
  cycle: null,
}

function historyEntry(
  id: string,
  createdAt: string,
  options: { actor?: unknown; botActor?: unknown } = {},
) {
  return {
    id,
    createdAt,
    updatedAt: createdAt,
    actor: options.actor ?? {
      id: "user-1",
      name: "alex",
      displayName: "Alex",
    },
    botActor: options.botActor ?? null,
    changes: { priority: { from: 1, to: 2 } },
    archived: null,
    trashed: null,
    updatedDescription: null,
    fromTitle: "Old title",
    toTitle: "New title",
    fromPriority: 1,
    toPriority: 2,
    fromEstimate: null,
    toEstimate: null,
    fromDueDate: null,
    toDueDate: null,
    fromAssignee: null,
    toAssignee: { id: "user-1", name: "alex", displayName: "Alex" },
    fromState: {
      id: "state-0",
      name: "Todo",
      type: "unstarted",
      color: "#aaa",
    },
    toState: {
      id: "state-1",
      name: "In Progress",
      type: "started",
      color: "#f00",
    },
    fromProject: null,
    toProject: { id: "project-1", name: "Audit", slugId: "audit-1" },
    toConvertedProject: null,
    toConvertedProjectId: null,
    fromProjectMilestone: null,
    toProjectMilestone: null,
    fromCycle: null,
    toCycle: null,
    fromParent: null,
    toParent: null,
    fromTeam: null,
    toTeam: null,
    fromDelegate: null,
    toDelegate: null,
    addedLabelIds: ["label-1"],
    removedLabelIds: [],
    relationChanges: [{ identifier: "TEST-99", type: "added" }],
  }
}

function currentResponse(
  labels?: {
    nodes: Array<{ id: string; name: string }>
    pageInfo: { hasNextPage: boolean; endCursor: string | null }
  },
) {
  return {
    queryName: "GetIssueAuditCurrent",
    variables: { id: "TEST-123", labelsAfter: null },
    response: {
      data: { organization, issue: labels ? { ...issue, labels } : issue },
    },
  }
}

function conversionHistoryEntry() {
  return {
    ...historyEntry("history-conversion", "2026-09-07T00:00:00Z"),
    changes: null,
    archived: null,
    trashed: null,
    updatedDescription: null,
    fromTitle: null,
    toTitle: null,
    fromPriority: null,
    toPriority: null,
    fromEstimate: null,
    toEstimate: null,
    fromDueDate: null,
    toDueDate: null,
    fromAssignee: null,
    toAssignee: null,
    fromState: null,
    toState: null,
    fromProject: null,
    toProject: null,
    toConvertedProject: {
      id: "project-converted",
      name: "Converted Project",
      slugId: "converted-project",
    },
    toConvertedProjectId: "project-converted",
    fromProjectMilestone: null,
    toProjectMilestone: null,
    fromCycle: null,
    toCycle: null,
    fromParent: null,
    toParent: null,
    fromTeam: null,
    toTeam: null,
    fromDelegate: null,
    toDelegate: null,
    fromSlaBreached: null,
    toSlaBreached: null,
    fromSlaBreachesAt: null,
    toSlaBreachesAt: null,
    fromSlaStartedAt: null,
    toSlaStartedAt: null,
    fromSlaType: null,
    toSlaType: null,
    addedToReleaseIds: [],
    removedFromReleaseIds: [],
    addedLabelIds: [],
    removedLabelIds: [],
    relationChanges: [],
  }
}

function historyResponse(
  nodes: unknown[],
  pageInfo: { hasNextPage: boolean; endCursor: string | null },
  variables: Record<string, unknown>,
) {
  return {
    queryName: "GetIssueAuditHistory",
    variables,
    response: {
      data: { issue: { identifier: "TEST-123", history: { nodes, pageInfo } } },
    },
  }
}

async function runCli(server: MockLinearServer, args: string[]) {
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

Deno.test("issue audit JSON is a self-describing envelope", async () => {
  const server = new MockLinearServer([
    currentResponse(),
    historyResponse(
      [historyEntry("history-1", "2026-09-05T00:00:00Z")],
      { hasNextPage: false, endCursor: null },
      { id: issue.id, first: 1 },
    ),
  ])
  await server.start()
  try {
    const result = await runCli(server, [
      "issue",
      "audit",
      "TEST-123",
      "--limit",
      "1",
      "--json",
    ])
    assertEquals(result.code, 0, result.stderr)
    assertEquals(result.stderr, "")
    const output = JSON.parse(result.stdout)
    assertEquals(output.kind, "issue-audit")
    assertEquals(output.organization, organization)
    assertEquals(output.issue.createdAt, issue.createdAt)
    assertEquals(output.issue.updatedAt, issue.updatedAt)
    assertEquals(output.history.nodes[0].fromTitle, "Old title")
    assertEquals(output.history.nodes[0].toTitle, "New title")
    assertEquals(output.history.nodes[0].fromState.name, "Todo")
    assertEquals(output.history.nodes[0].toState.name, "In Progress")
    assertEquals(output.history.pageInfo, {
      hasNextPage: false,
      endCursor: null,
    })
    assertEquals(output.audit.consistency, "non-atomic")
    assertStringIncludes(output.audit.note, "separate GraphQL requests")
    assertEquals(output.audit.relations, "not-read")
    assertEquals(server.graphqlRequests.length, 2)
    assertMatch(server.graphqlRequests[0].query, /createdAt\s+updatedAt/)
  } finally {
    await server.stop()
  }
})

Deno.test("issue audit human output has Current Snapshot and Change Log", async () => {
  const server = new MockLinearServer([
    currentResponse(),
    historyResponse(
      [historyEntry("history-1", "2026-09-05T00:00:00Z")],
      { hasNextPage: false, endCursor: null },
      { id: issue.id, first: 50 },
    ),
  ])
  await server.start()
  try {
    const result = await runCli(server, ["issue", "audit", "TEST-123"])
    assertEquals(result.code, 0, result.stderr)
    assertStringIncludes(result.stdout, "Current Snapshot")
    assertStringIncludes(result.stdout, "Warning: audit.consistency=non-atomic")
    assertStringIncludes(
      result.stdout,
      "Note: The current issue and history were read through separate GraphQL requests",
    )
    assertStringIncludes(
      result.stdout,
      "Issue: TEST-123 (11111111-1111-4111-8111-000000000123)",
    )
    assertStringIncludes(result.stdout, "Priority: 2")
    assertStringIncludes(result.stdout, "Estimate: 3")
    assertStringIncludes(result.stdout, "Due Date: 2026-09-30")
    assertStringIncludes(result.stdout, "Project Milestone: -")
    assertStringIncludes(result.stdout, "Cycle: -")
    assertStringIncludes(result.stdout, "Archived At: -")
    assertStringIncludes(result.stdout, "Trashed: false")
    assertStringIncludes(result.stdout, "Created: 2026-09-01T00:00:00Z")
    assertStringIncludes(result.stdout, "Change Log")
    assertStringIncludes(result.stdout, "title: Old title -> New title")
    assertStringIncludes(result.stdout, "state: Todo -> In Progress")
    assertEquals(server.graphqlRequests.length, 2)
  } finally {
    await server.stop()
  }
})

Deno.test("issue audit human output warns when history is truncated", async () => {
  const server = new MockLinearServer([
    currentResponse(),
    historyResponse(
      Array.from({ length: 50 }, (_, index) =>
        historyEntry(
          `history-${index + 1}`,
          "2026-09-05T00:00:00Z",
        )),
      { hasNextPage: true, endCursor: "history-next" },
      { id: issue.id, first: 50 },
    ),
  ])
  await server.start()
  try {
    const result = await runCli(server, ["issue", "audit", "TEST-123"])
    assertEquals(result.code, 0, result.stderr)
    assertStringIncludes(
      result.stdout,
      "Warning: history is truncated",
    )
    assertStringIncludes(result.stdout, "increase --limit")
    assertStringIncludes(result.stdout, "--limit 0")
  } finally {
    await server.stop()
  }
})

Deno.test("issue audit human output identifies bot history actors", async () => {
  const server = new MockLinearServer([
    currentResponse(),
    historyResponse(
      [
        historyEntry("history-1", "2026-09-05T00:00:00Z", {
          actor: {
            id: "external-user",
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
        }),
      ],
      { hasNextPage: false, endCursor: null },
      { id: issue.id, first: 50 },
    ),
  ])
  await server.start()
  try {
    const result = await runCli(server, ["issue", "audit", "TEST-123"])
    assertEquals(result.code, 0, result.stderr)
    assertStringIncludes(
      result.stdout,
      "Automation Bot (bot:integration) [user: Jordan]:",
    )
    assertEquals(result.stdout.includes("External Human:"), false)
  } finally {
    await server.stop()
  }
})

Deno.test("issue audit renders conversion history with converted project details", async () => {
  const entry = conversionHistoryEntry()
  const server = new MockLinearServer([
    currentResponse(),
    historyResponse(
      [entry],
      { hasNextPage: false, endCursor: null },
      { id: issue.id, first: 1 },
    ),
  ])
  await server.start()
  try {
    const jsonResult = await runCli(server, [
      "issue",
      "audit",
      "TEST-123",
      "--limit",
      "1",
      "--json",
    ])
    assertEquals(jsonResult.code, 0, jsonResult.stderr)
    const output = JSON.parse(jsonResult.stdout)
    assertEquals(
      output.history.nodes[0].toConvertedProject,
      entry.toConvertedProject,
    )
    assertEquals(
      output.history.nodes[0].toConvertedProjectId,
      entry.toConvertedProjectId,
    )
    assertMatch(server.graphqlRequests[1].query, /toConvertedProject/)
    assertMatch(server.graphqlRequests[1].query, /toConvertedProjectId/)

    const humanResult = await runCli(server, [
      "issue",
      "audit",
      "TEST-123",
      "--limit",
      "1",
    ])
    assertEquals(humanResult.code, 0, humanResult.stderr)
    assertStringIncludes(
      humanResult.stdout,
      "converted to project: Converted Project (project-converted)",
    )
    assertEquals(humanResult.stdout.includes("metadata changed"), false)
  } finally {
    await server.stop()
  }
})

Deno.test("issue audit paginates history and requests only the remaining limit", async () => {
  const firstEntry = historyEntry("history-1", "2026-09-05T00:00:00Z")
  const secondEntry = historyEntry("history-2", "2026-09-06T00:00:00Z")
  const server = new MockLinearServer([
    currentResponse(),
    historyResponse(
      [firstEntry],
      { hasNextPage: true, endCursor: "history-next" },
      { id: issue.id, first: 2 },
    ),
    historyResponse(
      [secondEntry],
      { hasNextPage: false, endCursor: "history-last" },
      { id: issue.id, first: 1, after: "history-next" },
    ),
  ])
  await server.start()
  try {
    const result = await runCli(server, [
      "issue",
      "audit",
      "TEST-123",
      "--limit",
      "2",
      "--json",
    ])
    assertEquals(result.code, 0, result.stderr)
    const output = JSON.parse(result.stdout)
    assertEquals(
      output.history.nodes.map((entry: { id: string }) => entry.id),
      [
        "history-1",
        "history-2",
      ],
    )
    assertEquals(output.history.pageInfo, {
      hasNextPage: false,
      endCursor: "history-last",
    })
    assertEquals(server.graphqlRequests.length, 3)
    assertEquals(server.graphqlRequests[2].variables, {
      id: issue.id,
      first: 1,
      after: "history-next",
    })
  } finally {
    await server.stop()
  }
})

Deno.test("issue audit fails without partial JSON on a repeated history cursor", async () => {
  const server = new MockLinearServer([
    currentResponse(),
    historyResponse(
      [historyEntry("history-1", "2026-09-05T00:00:00Z")],
      { hasNextPage: true, endCursor: "history-loop" },
      { id: issue.id, first: 100 },
    ),
    historyResponse(
      [historyEntry("history-2", "2026-09-06T00:00:00Z")],
      { hasNextPage: true, endCursor: "history-loop" },
      { id: issue.id, first: 100, after: "history-loop" },
    ),
  ])
  await server.start()
  try {
    const result = await runCli(server, [
      "issue",
      "audit",
      "TEST-123",
      "--limit",
      "0",
      "--json",
    ])
    assertEquals(result.code, 1)
    const error = JSON.parse(result.stdout)
    assertEquals(error.ok, false)
    assertEquals(error.effect, "none")
    assertStringIncludes(error.error.message, "empty or repeated cursor")
    assertEquals(result.stderr, "")
  } finally {
    await server.stop()
  }
})

Deno.test("issue audit fails without partial JSON on a repeated label cursor", async () => {
  const server = new MockLinearServer([
    currentResponse({
      nodes: [{ id: "label-1", name: "First label" }],
      pageInfo: { hasNextPage: true, endCursor: "label-loop" },
    }),
    {
      queryName: "GetIssueAuditCurrent",
      variables: { id: issue.id, labelsAfter: "label-loop" },
      response: {
        data: {
          organization,
          issue: {
            ...issue,
            labels: {
              nodes: [{ id: "label-2", name: "Second label" }],
              pageInfo: { hasNextPage: true, endCursor: "label-loop" },
            },
          },
        },
      },
    },
  ])
  await server.start()
  try {
    const result = await runCli(server, [
      "issue",
      "audit",
      "TEST-123",
      "--json",
    ])
    assertEquals(result.code, 1)
    const error = JSON.parse(result.stdout)
    assertEquals(error.ok, false)
    assertEquals(error.effect, "none")
    assertStringIncludes(error.error.message, "empty or repeated cursor")
    assertEquals(result.stdout.includes('"kind": "issue-audit"'), false)
    assertEquals(result.stderr, "")
    assertEquals(server.graphqlRequests.length, 2)
  } finally {
    await server.stop()
  }
})

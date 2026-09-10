import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert"
import {
  extractIssueRelationSnapshot,
  fetchIssuesForQuery,
  getIssueIdentifier,
  getProjectOptionsByName,
  getProjectsForTeam,
  isLinearUuid,
  lookupUserId,
  planIssueRelations,
  resolveMilestoneId,
  resolveProjectId,
  resolveWorkflowState,
  searchIssuesByTerm,
  type WorkflowState,
  workflowStateNotFoundError,
} from "../../src/utils/linear.ts"
import { NotFoundError, ValidationError } from "../../src/utils/errors.ts"
import { setupMockLinearServer } from "../utils/test-helpers.ts"

for (const input of ["", " ", "\t\n"]) {
  Deno.test(`lookupUserId rejects empty reference ${JSON.stringify(input)}`, async () => {
    await assertRejects(
      () => lookupUserId(input),
      ValidationError,
      "User reference cannot be empty",
    )
  })
}

for (
  const scenario of [
    {
      title: "email wins over display and fuzzy",
      counts: [1, 1, 1, 3],
      calls: 1,
      id: "tier-0-0",
    },
    {
      title: "unique display survives three fuzzy matches",
      counts: [0, 1, 0, 3],
      calls: 2,
      id: "tier-1-0",
    },
    {
      title: "exact name wins over fuzzy",
      counts: [0, 0, 1, 3],
      calls: 3,
      id: "tier-2-0",
    },
    {
      title: "unique fuzzy without exact",
      counts: [0, 0, 0, 1],
      calls: 4,
      id: "tier-3-0",
    },
    { title: "missing user", counts: [0, 0, 0, 0], calls: 4, id: undefined },
    {
      title: "ambiguous email stops before display",
      counts: [2, 1, 0, 0],
      calls: 1,
      ambiguous: true,
    },
    {
      title: "ambiguous display stops before exact name",
      counts: [0, 2, 1, 0],
      calls: 2,
      ambiguous: true,
    },
    {
      title: "ambiguous exact name",
      counts: [0, 0, 2, 1],
      calls: 3,
      ambiguous: true,
    },
    {
      title: "ambiguous fuzzy first page",
      counts: [0, 0, 0, 2],
      calls: 4,
      ambiguous: true,
    },
    {
      title: "fuzzy next page cannot select first result",
      counts: [0, 0, 0, 3],
      calls: 4,
      ambiguous: true,
    },
    {
      title: "display next page cannot select first result",
      counts: [0, 3, 1, 1],
      calls: 2,
      ambiguous: true,
    },
  ]
) {
  Deno.test(`lookupUserId ${scenario.title}`, async () => {
    // Preserve significant whitespace and casing in every server-side filter.
    const input = " Ann "
    const filters = [
      { email: { eqIgnoreCase: input } },
      { displayName: { eqIgnoreCase: input } },
      { name: { eqIgnoreCase: input } },
      { name: { containsIgnoreCaseAndAccent: input } },
    ]
    const { server, cleanup } = await setupMockLinearServer(
      filters.map((filter, tier) => ({
        queryName: "LookupUser",
        variables: { filter },
        response: {
          data: {
            users: {
              // A partial page with one row must still reject hasNextPage.
              nodes: Array.from({
                length: scenario.counts[tier] === 3 ? 1 : scenario.counts[tier],
              }, (_, index) => ({ id: `tier-${tier}-${index}` })),
              pageInfo: {
                hasNextPage: scenario.counts[tier] > 2,
                endCursor: null,
              },
            },
          },
        },
      })),
    )
    try {
      if (scenario.ambiguous) {
        await assertRejects(
          () => lookupUserId(input),
          ValidationError,
          "ambiguous",
        )
      } else {
        assertEquals(await lookupUserId(input), scenario.id)
      }
      assertEquals(
        server.graphqlRequests.map((request) => request.variables),
        filters.slice(0, scenario.calls).map((filter) => ({ filter })),
      )
      for (const request of server.graphqlRequests) {
        assertStringIncludes(request.query, "first: 2")
      }
    } finally {
      await cleanup()
    }
  })
}

function relationView(
  outgoing: Array<{ type: string; identifier: string }> = [],
  incoming: Array<{ type: string; identifier: string }> = [],
  hasNextPage = false,
): Record<string, unknown> {
  return {
    relations: {
      nodes: outgoing.map(({ type, identifier }) => ({
        type,
        relatedIssue: { identifier },
      })),
      pageInfo: { hasNextPage },
    },
    inverseRelations: {
      nodes: incoming.map(({ type, identifier }) => ({
        type,
        issue: { identifier },
      })),
      pageInfo: { hasNextPage: false },
    },
  }
}

Deno.test("relation planning preserves type and direction for each Issue pair", () => {
  const plan = (
    type: "blocks" | "blocked-by" | "related" | "duplicate",
    view: Record<string, unknown>,
  ) =>
    planIssueRelations(
      [{ type, issue: "ENG-2" }],
      extractIssueRelationSnapshot(view),
    )[0].verdict

  assertEquals(plan("blocks", relationView()), "add")
  assertEquals(
    plan("blocks", relationView([{ type: "blocks", identifier: "ENG-2" }])),
    "idempotent",
  )
  assertEquals(
    plan(
      "blocked-by",
      relationView([{ type: "blocks", identifier: "ENG-2" }]),
    ),
    "conflict",
  )
  assertEquals(
    plan(
      "blocked-by",
      relationView([], [{ type: "blocks", identifier: "ENG-2" }]),
    ),
    "idempotent",
  )
  assertEquals(
    plan("blocks", relationView([], [{ type: "blocks", identifier: "ENG-2" }])),
    "conflict",
  )
  assertEquals(
    plan("related", relationView([{ type: "related", identifier: "ENG-2" }])),
    "idempotent",
  )
  assertEquals(
    plan(
      "related",
      relationView([], [{ type: "related", identifier: "ENG-2" }]),
    ),
    "idempotent",
  )
  assertEquals(
    plan(
      "duplicate",
      relationView([{ type: "duplicate", identifier: "ENG-2" }]),
    ),
    "idempotent",
  )
  assertEquals(
    plan(
      "duplicate",
      relationView([], [{ type: "duplicate", identifier: "ENG-2" }]),
    ),
    "conflict",
  )
  assertEquals(
    plan("related", relationView([{ type: "similar", identifier: "ENG-2" }])),
    "conflict",
  )
  assertEquals(
    plan("related", relationView([{ type: "blocks", identifier: "ENG-3" }])),
    "add",
  )
})

Deno.test("relation planning fails closed and overlays manifest requests", () => {
  const incomplete = planIssueRelations(
    [{ type: "related", issue: "ENG-2" }],
    extractIssueRelationSnapshot(relationView([], [], true)),
  )
  assertEquals(incomplete[0].verdict, "conflict")
  assertStringIncludes(incomplete[0].detail ?? "", "pagination boundary")

  const conflicting = planIssueRelations(
    [
      { type: "related", issue: "ENG-2" },
      { type: "blocks", issue: "ENG-2" },
    ],
    extractIssueRelationSnapshot(relationView()),
  )
  assertEquals(conflicting.map(({ verdict }) => verdict), ["add", "conflict"])

  const duplicate = planIssueRelations(
    [
      { type: "related", issue: "ENG-2" },
      { type: "related", issue: "eng-2" },
    ],
    extractIssueRelationSnapshot(relationView()),
  )
  assertEquals(duplicate.map(({ verdict }) => verdict), ["add", "idempotent"])
})

Deno.test("getIssueId - handles full issue identifiers", async () => {
  const result = await getIssueIdentifier("ABC-123")
  assertEquals(result, "ABC-123")
})

Deno.test("getIssueId - handles integer-only IDs with team prefix", async () => {
  Deno.env.set("LINEAR_TEAM_ID", "CLI")

  const result = await getIssueIdentifier("123")
  assertEquals(result, "CLI-123")

  Deno.env.delete("LINEAR_TEAM_ID")
})

Deno.test("getIssueId - integer-only id without a team points at `linear config`", async () => {
  // An empty team id is falsy, so getTeamKey() resolves to undefined even
  // though the repo's .linear.toml sets one — this exercises the no-team branch.
  Deno.env.set("LINEAR_TEAM_ID", "")

  try {
    const error = await assertRejects(
      () => getIssueIdentifier("123"),
      ValidationError,
      "no team is set",
    )
    // Regression guard for #245: the suggestion must name the real command
    // (`config`), never the non-existent `configure`.
    assertStringIncludes(error.suggestion ?? "", "linear config")
    assertEquals(error.suggestion?.includes("configure"), false)
  } finally {
    Deno.env.delete("LINEAR_TEAM_ID")
  }
})

Deno.test("getIssueId - rejects invalid integer patterns", async () => {
  Deno.env.set("LINEAR_TEAM_ID", "TEST")

  const result = await getIssueIdentifier("0123") // Leading zero should be rejected
  assertEquals(result, undefined)

  Deno.env.delete("LINEAR_TEAM_ID")
})

Deno.test("getIssueId - rejects zero", async () => {
  Deno.env.set("LINEAR_TEAM_ID", "TEST")

  const result = await getIssueIdentifier("0")
  assertEquals(result, undefined)

  Deno.env.delete("LINEAR_TEAM_ID")
})

Deno.test("searchIssuesByTerm - without limit fetches a single page", async () => {
  const { cleanup } = await setupMockLinearServer([
    {
      queryName: "SearchIssues",
      variables: {
        term: "issue",
        filter: {
          team: { key: { eq: "CLI" } },
        },
      },
      response: {
        data: {
          searchIssues: {
            nodes: [
              {
                id: "issue-1",
                identifier: "CLI-1",
                title: "First issue",
                url: "https://linear.app/schpet/issue/CLI-1/first-issue",
                priority: 2,
                priorityLabel: "High",
                estimate: 3,
                createdAt: "2026-04-01T10:00:00.000Z",
                updatedAt: "2026-04-01T10:00:00.000Z",
                state: {
                  id: "state-1",
                  name: "Backlog",
                  color: "#999999",
                  type: "backlog",
                },
                assignee: null,
                team: {
                  id: "team-1",
                  key: "CLI",
                  name: "Linear CLI",
                  cyclesEnabled: false,
                  activeCycle: null,
                },
                project: null,
                projectMilestone: null,
                cycle: null,
                labels: { nodes: [] },
                inverseRelations: { nodes: [] },
                metadata: {},
              },
            ],
            pageInfo: {
              hasNextPage: true,
              endCursor: "cursor-1",
            },
            totalCount: 2,
          },
        },
      },
    },
  ], { NO_COLOR: "true" })

  try {
    const result = await searchIssuesByTerm("issue", {
      teamKey: "CLI",
    })

    assertEquals(result, {
      nodes: [
        {
          id: "issue-1",
          identifier: "CLI-1",
          title: "First issue",
          url: "https://linear.app/schpet/issue/CLI-1/first-issue",
          priority: 2,
          priorityLabel: "High",
          estimate: 3,
          createdAt: "2026-04-01T10:00:00.000Z",
          updatedAt: "2026-04-01T10:00:00.000Z",
          state: {
            id: "state-1",
            name: "Backlog",
            color: "#999999",
            type: "backlog",
          },
          assignee: null,
          team: {
            id: "team-1",
            key: "CLI",
            name: "Linear CLI",
            cyclesEnabled: false,
            activeCycle: null,
          },
          project: null,
          projectMilestone: null,
          cycle: null,
          labels: { nodes: [] },
          inverseRelations: { nodes: [] },
          metadata: {},
        },
      ],
      pageInfo: {
        hasNextPage: true,
        endCursor: "cursor-1",
      },
      totalCount: 2,
    })
  } finally {
    await cleanup()
  }
})

Deno.test("fetchIssuesForQuery rejects non-adjacent project team cursor cycles", async () => {
  const { server, cleanup } = await setupMockLinearServer([
    {
      queryName: "GetIssuesForQuery",
      response: {
        data: {
          issues: {
            nodes: [{
              id: "issue-1",
              project: {
                id: "project-1",
                teams: {
                  nodes: [{ key: "ENG" }],
                  pageInfo: { hasNextPage: true, endCursor: "cursor-a" },
                },
              },
            }],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      },
    },
    {
      queryName: "GetProjectTeamsForDoctor",
      variables: { after: "cursor-a" },
      response: {
        data: {
          project: {
            teams: {
              nodes: [{ key: "OPS" }],
              pageInfo: { hasNextPage: true, endCursor: "cursor-b" },
            },
          },
        },
      },
    },
    {
      queryName: "GetProjectTeamsForDoctor",
      variables: { after: "cursor-b" },
      response: {
        data: {
          project: {
            teams: {
              nodes: [{ key: "ENG" }],
              pageInfo: { hasNextPage: true, endCursor: "cursor-a" },
            },
          },
        },
      },
    },
  ])
  try {
    await assertRejects(
      () => fetchIssuesForQuery({ includeProjectTeamMetadata: true }),
      Error,
      "empty or repeated cursor",
    )
    assertEquals(server.graphqlRequests.length, 3)
  } finally {
    await cleanup()
  }
})

for (
  const [name, queryName, invoke] of [
    [
      "project options by name",
      "GetProjectIdOptionsByName",
      (name: string) => getProjectOptionsByName(name),
    ],
    [
      "projects for team",
      "GetProjectsForTeam",
      (name: string) => getProjectsForTeam(name),
    ],
  ] as const
) {
  Deno.test(`${name} rejects non-adjacent cursor cycles`, async () => {
    const { server, cleanup } = await setupMockLinearServer([
      {
        queryName,
        variables: { after: undefined },
        response: {
          data: {
            projects: {
              nodes: [{ id: "project-1", name: "First" }],
              pageInfo: { hasNextPage: true, endCursor: "cursor-a" },
            },
          },
        },
      },
      {
        queryName,
        variables: { after: "cursor-a" },
        response: {
          data: {
            projects: {
              nodes: [{ id: "project-2", name: "Second" }],
              pageInfo: { hasNextPage: true, endCursor: "cursor-b" },
            },
          },
        },
      },
      {
        queryName,
        variables: { after: "cursor-b" },
        response: {
          data: {
            projects: {
              nodes: [{ id: "project-3", name: "Third" }],
              pageInfo: { hasNextPage: true, endCursor: "cursor-a" },
            },
          },
        },
      },
    ])
    try {
      await assertRejects(
        () => invoke(name === "projects for team" ? "ENG" : "Project"),
        Error,
        "empty or repeated cursor",
      )
      assertEquals(server.graphqlRequests.length, 3)
    } finally {
      await cleanup()
    }
  })
}

const UUID = "00000000-0000-0000-0000-000000000000"

Deno.test("isLinearUuid - detects UUID format", () => {
  assertEquals(isLinearUuid(UUID), true)
  assertEquals(isLinearUuid("ABNL-99"), false)
  assertEquals(isLinearUuid("F-FOO"), false)
  assertEquals(isLinearUuid("project-name with spaces"), false)
  assertEquals(isLinearUuid(""), false)
})

Deno.test("resolveProjectId - accepts a UUID without an API call", async () => {
  const { cleanup } = await setupMockLinearServer([])
  try {
    const id = await resolveProjectId(UUID)
    assertEquals(id, UUID)
  } finally {
    await cleanup()
  }
})

Deno.test("resolveProjectId - resolves by exact name", async () => {
  const { cleanup } = await setupMockLinearServer([
    {
      queryName: "GetProjectIdByName",
      variables: { name: "Tech Debt" },
      response: {
        data: {
          projects: {
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes: [{ id: "proj-name-uuid" }],
          },
        },
      },
    },
  ])
  try {
    const id = await resolveProjectId("Tech Debt")
    assertEquals(id, "proj-name-uuid")
  } finally {
    await cleanup()
  }
})

Deno.test("resolveProjectId - falls back to slug ID when name does not match", async () => {
  const { cleanup } = await setupMockLinearServer([
    {
      queryName: "GetProjectIdByName",
      variables: { name: "f-foo" },
      response: {
        data: {
          projects: {
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes: [],
          },
        },
      },
    },
    {
      queryName: "GetProjectIdBySlugId",
      variables: { slugId: "f-foo" },
      response: {
        data: {
          projects: {
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes: [{ id: "proj-slug-uuid" }],
          },
        },
      },
    },
  ])
  try {
    const id = await resolveProjectId("f-foo")
    assertEquals(id, "proj-slug-uuid")
  } finally {
    await cleanup()
  }
})

Deno.test("resolveProjectId - throws NotFoundError when nothing matches", async () => {
  const { cleanup } = await setupMockLinearServer([
    {
      queryName: "GetProjectIdByName",
      response: {
        data: {
          projects: {
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes: [],
          },
        },
      },
    },
    {
      queryName: "GetProjectIdBySlugId",
      response: {
        data: {
          projects: {
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes: [],
          },
        },
      },
    },
  ])
  try {
    await assertRejects(
      () => resolveProjectId("nope"),
      NotFoundError,
      "Project not found: nope",
    )
  } finally {
    await cleanup()
  }
})

Deno.test("resolveMilestoneId - accepts UUID directly without a project", async () => {
  const { cleanup } = await setupMockLinearServer([])
  try {
    const id = await resolveMilestoneId(UUID)
    assertEquals(id, UUID)
  } finally {
    await cleanup()
  }
})

Deno.test("resolveMilestoneId - resolves a name within the given project", async () => {
  const { cleanup } = await setupMockLinearServer([
    {
      queryName: "GetProjectMilestonesForLookup",
      variables: { projectId: "proj-1" },
      response: {
        data: {
          project: {
            projectMilestones: {
              nodes: [
                { id: "ms-1", name: "Y26 Q2" },
                { id: "ms-2", name: "Y26 Q3" },
              ],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        },
      },
    },
  ])
  try {
    const id = await resolveMilestoneId("Y26 Q2", "proj-1")
    assertEquals(id, "ms-1")
  } finally {
    await cleanup()
  }
})

for (
  const scenario of [
    "later match",
    "duplicate",
    "same page duplicate",
    "missing",
    "cycle",
    "missing pageInfo",
    "not found",
  ]
) {
  Deno.test(`resolveMilestoneId - paginated ${scenario}`, async () => {
    const { cleanup, server } = await setupMockLinearServer([{
      queryName: "GetProjectMilestonesForLookup",
      response: ({ variables }) => {
        const later = variables.after != null
        return {
          data: {
            project: {
              projectMilestones: {
                nodes: scenario === "same page duplicate"
                  ? [
                    { id: "ms-1", name: "Release" },
                    { id: "ms-2", name: "RELEASE" },
                  ]
                  : [{
                    id: later ? "ms-2" : "ms-1",
                    name: scenario === "not found"
                      ? "other"
                      : later
                      ? "RELEASE"
                      : scenario === "later match"
                      ? "other"
                      : "Release",
                  }],
                ...(scenario === "missing pageInfo" ? {} : {
                  pageInfo: {
                    hasNextPage: scenario !== "same page duplicate" &&
                      (!later || scenario === "cycle"),
                    endCursor: scenario === "missing"
                      ? null
                      : later && scenario !== "cycle"
                      ? null
                      : "cursor-1",
                  },
                }),
              },
            },
          },
        }
      },
    }])
    try {
      if (scenario === "later match") {
        assertEquals(await resolveMilestoneId("release", "proj-1"), "ms-2")
      } else if (scenario.includes("duplicate")) {
        const error = await assertRejects(
          () => resolveMilestoneId("release", "proj-1"),
          ValidationError,
          "ambiguous",
        )
        assertStringIncludes(error.suggestion!, "UUID")
      } else {
        await assertRejects(
          () => resolveMilestoneId("release", "proj-1"),
          Error,
          scenario === "not found"
            ? "not found"
            : "Incomplete project milestones pagination",
        )
      }
      assertEquals(
        server.graphqlRequests.length,
        scenario === "missing" || scenario === "missing pageInfo" ||
          scenario === "same page duplicate"
          ? 1
          : 2,
      )
      assertEquals(server.graphqlRequests[0].variables, {
        projectId: "proj-1",
        after: null,
      })
      if (server.graphqlRequests.length === 2) {
        assertEquals(server.graphqlRequests[1].variables, {
          projectId: "proj-1",
          after: "cursor-1",
        })
      }
    } finally {
      await cleanup()
    }
  })
}

Deno.test("resolveMilestoneId - errors when a name is passed without a project", async () => {
  const { cleanup } = await setupMockLinearServer([])
  try {
    await assertRejects(
      () => resolveMilestoneId("Y26 Q2"),
      ValidationError,
      "Cannot resolve milestone",
    )
  } finally {
    await cleanup()
  }
})

// States are passed to resolveWorkflowState already sorted by position, mirroring
// getWorkflowStates. Duplicate "started" states are ordered so the lower position
// comes first.
const WORKFLOW_STATES: WorkflowState[] = [
  { id: "s-backlog", name: "Backlog", type: "backlog", position: 0 },
  { id: "s-todo", name: "Todo", type: "unstarted", position: 1 },
  { id: "s-progress", name: "In Progress", type: "started", position: 2 },
  { id: "s-review", name: "In Review", type: "started", position: 3 },
  { id: "s-done", name: "Done", type: "completed", position: 4 },
]

Deno.test("resolveWorkflowState - matches by exact name, case-insensitively", () => {
  assertEquals(
    resolveWorkflowState(WORKFLOW_STATES, "in progress")?.id,
    "s-progress",
  )
})

Deno.test("resolveWorkflowState - name match wins over type match", () => {
  // "Done" is a name and "completed" is its type; the name should resolve first.
  assertEquals(resolveWorkflowState(WORKFLOW_STATES, "Done")?.id, "s-done")
})

Deno.test("resolveWorkflowState - matches by type when no name matches", () => {
  assertEquals(
    resolveWorkflowState(WORKFLOW_STATES, "COMPLETED")?.id,
    "s-done",
  )
})

Deno.test("resolveWorkflowState - duplicate types resolve to the first by position", () => {
  assertEquals(
    resolveWorkflowState(WORKFLOW_STATES, "started")?.id,
    "s-progress",
  )
})

Deno.test("resolveWorkflowState - returns undefined when nothing matches", () => {
  assertEquals(resolveWorkflowState(WORKFLOW_STATES, "nope"), undefined)
})

Deno.test("workflowStateNotFoundError - lists valid states and the discovery command", () => {
  const error = workflowStateNotFoundError("ENG", "nope", [
    { id: "s-backlog", name: "Backlog", type: "backlog", position: 0 },
    { id: "s-todo", name: "Todo", type: "unstarted", position: 1 },
  ])
  assertEquals(error instanceof NotFoundError, true)
  assertEquals(error.message, "Workflow state not found: 'nope' for team ENG")
  assertEquals(
    error.suggestion,
    'Valid states: "Backlog" (backlog), "Todo" (unstarted). ' +
      "Run `linear team states ENG` to list them.",
  )
})

Deno.test("workflowStateNotFoundError - escapes quotes in state names", () => {
  const error = workflowStateNotFoundError("ENG", "nope", [
    { id: "s-weird", name: 'Needs "review"', type: "started", position: 0 },
  ])
  assertStringIncludes(error.suggestion ?? "", '"Needs \\"review\\"" (started)')
})

Deno.test("workflowStateNotFoundError - handles a team with no states", () => {
  const error = workflowStateNotFoundError("ENG", "nope", [])
  assertEquals(
    error.suggestion,
    "Team ENG has no workflow states. Run `linear team states ENG`.",
  )
})

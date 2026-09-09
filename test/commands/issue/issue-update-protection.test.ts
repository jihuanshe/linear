import { assertEquals, assertStringIncludes } from "@std/assert"
import { fromFileUrl, join } from "@std/path"
import {
  issueWriteBasis,
  issueWriteId,
  terminalPage,
} from "../../utils/issue-write-fixtures.ts"
import {
  type MockGraphQLRequest,
  MockLinearServer,
} from "../../utils/mock_linear_server.ts"

const main = fromFileUrl(new URL("../../../src/main.ts", import.meta.url))
const engTeam = {
  id: "22222222-2222-4222-8222-222222222222",
  key: "ENG",
  name: "Engineering",
}
const opsTeam = {
  id: "33333333-3333-4333-8333-333333333333",
  key: "OPS",
  name: "Operations",
}
const otherId = "44444444-4444-4444-8444-444444444444"
const projectId = "55555555-5555-4555-8555-555555555555"
const parentId = "66666666-6666-4666-8666-666666666666"
type Basis = ReturnType<typeof issueWriteBasis>

const { denoDir } = JSON.parse(new TextDecoder().decode(
  (await new Deno.Command(Deno.execPath(), {
    args: ["info", "--json"],
    stdout: "piped",
  }).output()).stdout,
)) as { denoDir: string }

interface Model {
  current: Basis
  reads: number
  beforeMutation?: Basis
  projects: Record<string, Array<{ id: string; key: string; name: string }>>
}

interface Scenario {
  initial?: Basis
  original?: Record<string, unknown> | false
  beforeUpdate?: (model: Model) => void
  onRead?: (
    model: Model,
    request: MockGraphQLRequest,
  ) => Record<string, unknown> | undefined
  onLabel?: (
    model: Model,
    request: MockGraphQLRequest,
  ) => Record<string, unknown> | undefined
  onLabelPage?: (
    model: Model,
    request: MockGraphQLRequest,
  ) => Record<string, unknown> | undefined
  mutation?: Record<string, unknown>
  parentReadError?: boolean
  create?: boolean
}

async function runScenario(args: string[], scenario: Scenario = {}) {
  const root = await Deno.makeTempDir()
  const model: Model = {
    current: structuredClone(
      scenario.initial ?? issueWriteBasis("ENG-123", engTeam),
    ),
    reads: 0,
    projects: { [projectId]: [engTeam, opsTeam], [otherId]: [engTeam] },
  }
  const empty = { nodes: [], pageInfo: terminalPage }
  const labelIds: Record<string, string> = {
    frontend: "label-front",
    backend: "label-before",
  }
  const respond = (
    name: string,
    request: MockGraphQLRequest,
  ): Record<string, unknown> => {
    if (name === "GetIssueDetailsWithComments") {
      return {
        data: {
          ...structuredClone(model.current),
          issue: {
            ...structuredClone(model.current.issue),
            comments: empty,
            attachments: empty,
            children: empty,
            documents: empty,
            relations: empty,
            inverseRelations: empty,
          },
        },
      }
    }
    if (name === "GetIssueForWrite") {
      model.reads++
      return scenario.onRead?.(model, request) ??
        { data: structuredClone(model.current) }
    }
    if (name === "GetIssueLabelsForWrite") {
      return scenario.onLabelPage?.(model, request) ??
        { data: { issue: { labels: empty } } }
    }
    if (name === "GetIssueWriteScalars") {
      const { labels: _labels, ...issue } = structuredClone(model.current.issue)
      return { data: { organization: model.current.organization, issue } }
    }
    if (name === "GetIssueLabelIdByNameForTeam") {
      return scenario.onLabel?.(model, request) ??
        {
          data: {
            issueLabels: {
              nodes: [{
                id: labelIds[String(request.variables.name)],
                name: request.variables.name,
              }],
              pageInfo: terminalPage,
            },
          },
        }
    }
    if (name === "GetWriteTeamByKey") {
      return {
        data: {
          teams: {
            nodes: [engTeam, opsTeam].filter((team) =>
              team.key === String(request.variables.key).toUpperCase()
            ),
            pageInfo: terminalPage,
          },
        },
      }
    }
    if (name === "GetIssueProjectId") {
      return { data: { issue: { project: model.current.issue.project } } }
    }
    if (name === "ProjectTeams") {
      return {
        data: {
          project: {
            id: request.variables.id,
            name: "Project",
            teams: {
              nodes: model.projects[String(request.variables.id)] ?? [],
              pageInfo: terminalPage,
            },
          },
        },
      }
    }
    if (name === "GetIssueId") {
      return { data: { issue: { id: parentId, identifier: "ENG-220" } } }
    }
    if (name === "GetParentIssueData") {
      return scenario.parentReadError
        ? { errors: [{ message: "Parent read unavailable" }] }
        : {
          data: {
            issue: { title: "Parent", identifier: "ENG-220", project: null },
          },
        }
    }
    if (name === "CreateIssue") {
      return {
        data: {
          issueCreate: {
            success: true,
            issue: {
              id: issueWriteId,
              identifier: "ENG-124",
              title: "Child",
              url: "https://linear.app/test-team/issue/ENG-124",
              team: engTeam,
            },
          },
        },
      }
    }
    if (name === "UpdateIssue") {
      model.beforeMutation = structuredClone(model.current)
      if (scenario.mutation) return scenario.mutation
      const input = request.variables.input as Record<string, unknown>
      // Model only upstream mutation fields used by these scenarios. All guard
      // decisions and payload construction run in the actual CLI process.
      for (
        const field of [
          "title",
          "description",
          "priority",
          "estimate",
          "dueDate",
        ]
      ) {
        if (Object.hasOwn(input, field)) {
          ;(model.current.issue as Record<string, unknown>)[field] =
            input[field]
        }
      }
      if (input.teamId) {
        model.current.issue.team = [engTeam, opsTeam].find((team) =>
          team.id === input.teamId
        )!
      }
      const labels = new Map(
        model.current.issue.labels.nodes.map((label) => [label.id, label]),
      )
      for (const id of (input.removedLabelIds ?? []) as string[]) {
        labels.delete(id)
      }
      for (const id of (input.addedLabelIds ?? []) as string[]) {
        labels.set(id, { id, name: id })
      }
      model.current.issue.labels.nodes = [...labels.values()]
      return {
        data: {
          issueUpdate: {
            success: true,
            issue: structuredClone(model.current.issue),
          },
        },
      }
    }
    throw new Error(`Unexpected query: ${name}`)
  }
  const names = [
    "GetIssueDetailsWithComments",
    "GetIssueForWrite",
    "GetIssueLabelsForWrite",
    "GetIssueWriteScalars",
    "GetIssueLabelIdByNameForTeam",
    "GetWriteTeamByKey",
    "GetIssueProjectId",
    "ProjectTeams",
    "GetIssueId",
    "GetParentIssueData",
    "CreateIssue",
    "UpdateIssue",
  ]
  const server = new MockLinearServer(
    names.map((name) => ({
      queryName: name,
      response: (request: MockGraphQLRequest) => respond(name, request),
    })),
  )
  await server.start()
  const run = async (command: string[]) => {
    const output = await new Deno.Command(Deno.execPath(), {
      args: ["run", "--allow-all", "--quiet", main, ...command],
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
        LINEAR_API_KEY: "test-token",
        LINEAR_GRAPHQL_ENDPOINT: server.getEndpoint(),
        LINEAR_ISSUE_CREATE_ASSIGN_SELF: "never",
      },
    }).output()
    const stdout = new TextDecoder().decode(output.stdout)
    return {
      code: output.code,
      stdout,
      result: JSON.parse(stdout),
      stderr: new TextDecoder().decode(output.stderr),
    }
  }
  try {
    let originalPath: string | undefined
    if (!scenario.create && scenario.original !== false) {
      let original: Record<string, unknown>
      if (scenario.original) original = scenario.original
      else {
        const read = await run(["issue", "view", "ENG-123", "--json"])
        assertEquals(read.code, 0, read.stdout + read.stderr)
        original = read.result
      }
      originalPath = join(root, "original.json")
      await Deno.writeTextFile(originalPath, JSON.stringify(original))
    }
    scenario.beforeUpdate?.(model)
    const output = await run(
      scenario.create ? ["issue", "create", ...args, "--json"] : [
        "issue",
        "update",
        "ENG-123",
        ...args,
        ...(originalPath ? ["--base-file", originalPath] : []),
        "--json",
      ],
    )
    assertEquals(output.stderr, "")
    const requests = server.graphqlRequests.slice()
    return {
      ...output,
      model,
      requests,
      mutations: requests.filter((request) =>
        /^mutation\b/.test(request.query.trim())
      ),
    }
  } finally {
    await server.stop()
    await Deno.remove(root, { recursive: true })
  }
}

function assertNoWrite(
  result: Awaited<ReturnType<typeof runScenario>>,
  message: string,
) {
  assertEquals(result.code, 1, result.stdout)
  assertEquals(result.result.ok, false)
  assertEquals(result.result.effect, "none")
  assertEquals(result.mutations, [])
  assertStringIncludes(result.result.error.message, message)
}

Deno.test("issue protected update consumes a saved view and sends only the resolved UUID", async () => {
  const result = await runScenario(["--title", "Desired"])
  assertEquals(result.code, 0, result.stdout)
  assertEquals(result.result.effect, "applied")
  assertEquals(result.result.data.issue.id, issueWriteId)
  assertEquals(result.mutations.map((request) => request.variables), [{
    id: issueWriteId,
    input: { title: "Desired" },
  }])
  assertEquals(
    result.requests.filter((request) =>
      request.query.includes("query GetIssueForWrite")
    ).map((request) => request.variables.id),
    ["ENG-123", issueWriteId],
  )
})

Deno.test("issue replacement without an original read fails before the first request", async () => {
  const result = await runScenario(["--title", "Desired"], { original: false })
  assertNoWrite(result, "requires the original read")
  assertEquals(result.requests, [])
})

for (const problem of ["workspace", "object", "missing field"] as const) {
  Deno.test(`issue protected update refuses original ${problem}`, async () => {
    const original = issueWriteBasis("ENG-123", engTeam)
    if (problem === "workspace") original.organization.id = "other-workspace"
    if (problem === "object") original.issue.id = otherId
    if (problem === "missing field") {
      delete (original.issue as Record<string, unknown>).title
    }
    const result = await runScenario([
      "--title",
      problem === "missing field" ? "Before title" : "Desired",
    ], { original })
    assertNoWrite(
      result,
      problem === "missing field"
        ? "missing field title"
        : "different object or workspace",
    )
  })
}

Deno.test("issue protected update rejects drift since the saved view", async () => {
  const result = await runScenario(["--description", "Desired"], {
    beforeUpdate: (model) => {
      model.current.issue.description = "Someone else's edit"
    },
  })
  assertNoWrite(result, "Original values changed: description")
  assertEquals(result.model.current.issue.description, "Someone else's edit")
})

Deno.test("issue protected update rereads after name resolution and rejects the whole mixed patch", async () => {
  const result = await runScenario([
    "--description",
    "Desired",
    "--add-label",
    "frontend",
  ], {
    onLabel(model) {
      model.current.issue.description = "Edited during lookup"
      return undefined
    },
  })
  assertNoWrite(result, "Original values changed: description")
  assertEquals(result.model.reads, 2)
  assertEquals(result.model.current.issue.labels.nodes.map((node) => node.id), [
    "label-before",
  ])
})

Deno.test("issue protected update removes no-op fields from a mixed payload", async () => {
  const result = await runScenario([
    "--title",
    "Already desired",
    "--priority",
    "2",
  ], {
    beforeUpdate(model) {
      model.current.issue.title = "Already desired"
      model.current.issue.description = "Unrelated edit"
    },
  })
  assertEquals(result.code, 0, result.stdout)
  assertEquals(result.mutations[0].variables, {
    id: issueWriteId,
    input: { priority: 2 },
  })
  assertEquals(
    result.result.fields.map((
      field: { field: string; verdict: string },
    ) => [field.field, field.verdict]),
    [["title", "idempotent"], ["priority", "write"]],
  )
  assertEquals(result.model.current.issue.description, "Unrelated edit")
})

Deno.test("issue protected update reports no-op without a mutation", async () => {
  const result = await runScenario(["--title", "Already desired"], {
    beforeUpdate: (model) => {
      model.current.issue.title = "Already desired"
    },
  })
  assertEquals(result.code, 0, result.stdout)
  assertEquals(result.result.effect, "none")
  assertEquals(result.mutations, [])
})

Deno.test("issue protected update checks extra dependencies even when the target field is a no-op", async () => {
  const result = await runScenario([
    "--title",
    "Already desired",
    "--expect-field",
    "priority",
  ], {
    beforeUpdate(model) {
      model.current.issue.title = "Already desired"
      model.current.issue.priority = 2
    },
  })
  assertNoWrite(result, "Original values changed: priority")
})

Deno.test("issue protected Markdown compares exact original URLs", async () => {
  const initial = issueWriteBasis("ENG-123", engTeam)
  initial.issue.description = "https://example.com/_v1_"
  const result = await runScenario(["--description", "Desired"], {
    initial,
    beforeUpdate: (model) => {
      model.current.issue.description = "https://example.com/*v1*"
    },
  })
  assertNoWrite(result, "Original values changed: description")
})

for (
  const [base, remote, desired, applies] of [
    [null, null, "", true],
    ["", null, "Desired", false],
    [null, "", "Desired", false],
  ] as const
) {
  Deno.test(`issue protected description distinguishes ${JSON.stringify(base)} from ${JSON.stringify(remote)}`, async () => {
    const initial = issueWriteBasis("ENG-123", engTeam)
    initial.issue.description = base
    const result = await runScenario(["--description", desired], {
      initial,
      beforeUpdate(model) {
        model.current.issue.description = remote
      },
    })
    if (!applies) assertNoWrite(result, "Original values changed: description")
    else {
      assertEquals(result.code, 0, result.stdout)
      assertEquals(result.result.effect, "applied")
      assertEquals(result.mutations[0].variables, {
        id: issueWriteId,
        input: { description: "" },
      })
    }
  })
}

Deno.test("issue pure label increments require no basis and preserve concurrent labels", async () => {
  const result = await runScenario([
    "--add-label",
    "frontend",
    "--remove-label",
    "backend",
  ], {
    original: false,
    onRead(model) {
      if (model.reads === 2) {
        model.current.issue.labels.nodes.push({
          id: "label-concurrent",
          name: "Concurrent",
        })
      }
      return undefined
    },
  })
  assertEquals(result.code, 0, result.stdout)
  assertEquals(result.mutations[0].variables, {
    id: issueWriteId,
    input: {
      addedLabelIds: ["label-front"],
      removedLabelIds: ["label-before"],
    },
  })
  assertEquals(result.model.current.issue.labels.nodes.map((node) => node.id), [
    "label-concurrent",
    "label-front",
  ])
})

Deno.test("issue label resolution cannot silently switch team scope", async () => {
  const result = await runScenario(["--add-label", "frontend"], {
    original: false,
    onLabel(model) {
      model.current.issue.team = opsTeam
      return undefined
    },
  })
  assertNoWrite(result, "Issue team changed")
})

Deno.test("issue protected update fails a final read without a mutation", async () => {
  const result = await runScenario(["--title", "Desired"], {
    onRead(model) {
      return model.reads === 2
        ? { errors: [{ message: "Final read unavailable" }] }
        : undefined
    },
  })
  assertNoWrite(result, "Final read unavailable")
})

Deno.test("issue protected update rejects a final read for a different UUID", async () => {
  const result = await runScenario(["--title", "Desired"], {
    onRead(model) {
      if (model.reads === 2) model.current.issue.id = otherId
      return undefined
    },
  })
  assertNoWrite(result, "different stable identity")
  assertEquals(result.model.reads, 2)
})

Deno.test("issue protected update checks scalars again after paging its final label read", async () => {
  const result = await runScenario(["--title", "Desired"], {
    onRead(model) {
      if (model.reads !== 2) return undefined
      const observed = structuredClone(model.current)
      return {
        data: {
          ...observed,
          issue: {
            ...observed.issue,
            labels: {
              nodes: [],
              pageInfo: { hasNextPage: true, endCursor: "labels-next" },
            },
          },
        },
      }
    },
    onLabelPage(model, request) {
      assertEquals(request.variables.id, issueWriteId)
      assertEquals(request.variables.after, "labels-next")
      model.current.issue.title = "Colleague edit during label pagination"
      return { data: { issue: { labels: model.current.issue.labels } } }
    },
  })
  assertNoWrite(result, "Original values changed: title")
  assertEquals(
    result.model.current.issue.title,
    "Colleague edit during label pagination",
  )
  assertEquals(
    result.requests.slice(-3).map((request) =>
      request.query.match(/query (\w+)/)?.[1]
    ),
    [
      "GetIssueForWrite",
      "GetIssueLabelsForWrite",
      "GetIssueWriteScalars",
    ],
  )
  assertEquals(result.requests.at(-1)?.variables, { id: issueWriteId })
})

Deno.test("issue client guard has a documented race after the last read", async () => {
  const result = await runScenario(["--title", "Desired"], {
    onRead(model) {
      if (model.reads !== 2) return undefined
      const observed = structuredClone(model.current)
      model.current.issue.title = "Concurrent edit after the read"
      return { data: observed }
    },
  })
  assertEquals(result.code, 0, result.stdout)
  assertEquals(result.result.effect, "applied")
  assertEquals(
    result.model.beforeMutation?.issue.title,
    "Concurrent edit after the read",
  )
  assertEquals(result.model.current.issue.title, "Desired")
  assertEquals(result.mutations.length, 1)
})

Deno.test("issue team move checks the project from the final read", async () => {
  const initial = issueWriteBasis("ENG-123", engTeam)
  initial.issue.project = { id: projectId }
  const result = await runScenario(["--team", "OPS"], {
    initial,
    onRead(model) {
      if (model.reads === 2) model.current.issue.project = { id: otherId }
      return undefined
    },
  })
  assertNoWrite(result, "Issue project changed")
  assertEquals(
    result.requests.filter((request) =>
      request.query.includes("GetIssueProjectId")
    ).every((request) => request.variables.id === issueWriteId),
    true,
  )
})

Deno.test("issue label lookup refuses ambiguous matches before an incremental mutation", async () => {
  const result = await runScenario(["--add-label", "frontend"], {
    original: false,
    onLabel() {
      return {
        data: {
          issueLabels: {
            nodes: [{ id: "team-label", name: "frontend" }, {
              id: "workspace-label",
              name: "frontend",
            }],
            pageInfo: terminalPage,
          },
        },
      }
    },
  })
  assertNoWrite(result, "ambiguous")
})

for (const outcome of ["false", "wrong-id"] as const) {
  Deno.test(`issue mutation ${outcome} does not become a retryable none result`, async () => {
    const result = await runScenario(["--title", "Desired"], {
      mutation: {
        data: {
          issueUpdate: { success: outcome !== "false", issue: { id: otherId } },
        },
      },
    })
    assertEquals(result.code, 1)
    assertEquals(
      result.result.effect,
      outcome === "false" ? "unknown" : "applied",
    )
    assertEquals(result.mutations.length, 1)
  })
}

for (const failed of [false, true]) {
  Deno.test(`issue create normalizes the parent and ${failed ? "stops on failed reads" : "accepts a parent without a project"}`, async () => {
    const result = await runScenario([
      "--title",
      "Child",
      "--team",
      "ENG",
      "--parent",
      "eng-220",
      "--no-interactive",
    ], { create: true, parentReadError: failed })
    if (failed) assertNoWrite(result, "Parent read unavailable")
    else {
      assertEquals(result.code, 0, result.stdout)
      const input = result.mutations[0].variables.input as Record<
        string,
        unknown
      >
      assertEquals(input.parentId, parentId)
      assertEquals(input.projectId, null)
      assertEquals(input.teamId, engTeam.id)
      assertEquals(result.result.effect, "applied")
    }
    assertEquals(
      result.requests.filter((request) =>
        request.query.includes("query GetIssueId")
      ).map((request) => request.variables.id),
      ["ENG-220"],
    )
    assertEquals(
      result.requests.filter((request) =>
        request.query.includes("query GetParentIssueData")
      ).map((request) => request.variables.id),
      [parentId],
    )
  })
}

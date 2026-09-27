import { assertEquals, assertStringIncludes } from "@std/assert"
import { fromFileUrl, join } from "@std/path"
import { setupMockLinearServer } from "../utils/test-helpers.ts"
import type { MockLinearServer } from "../utils/mock_linear_server.ts"

const main = fromFileUrl(new URL("../../src/main.ts", import.meta.url))
const { denoDir } = JSON.parse(new TextDecoder().decode(
  (await new Deno.Command(Deno.execPath(), {
    args: ["info", "--json"],
    stdout: "piped",
  }).output()).stdout,
)) as { denoDir: string }

async function run(
  server: MockLinearServer,
  args: string[],
  env: Record<string, string> = {},
) {
  const root = await Deno.makeTempDir()
  try {
    const result = await new Deno.Command(Deno.execPath(), {
      args: ["run", "--allow-all", "--quiet", main, ...args],
      stdout: "piped",
      stderr: "piped",
      stdin: "null",
      clearEnv: true,
      env: {
        HOME: root,
        XDG_CONFIG_HOME: join(root, "config"),
        APPDATA: join(root, "config"),
        DENO_DIR: denoDir,
        PATH: Deno.env.get("PATH") ?? "",
        NO_COLOR: "1",
        LINEAR_API_KEY: "test-token",
        LINEAR_GRAPHQL_ENDPOINT: server.getEndpoint(),
        ...env,
      },
    }).output()
    const decoder = new TextDecoder()
    return {
      code: result.code,
      stdout: decoder.decode(result.stdout),
      stderr: decoder.decode(result.stderr),
    }
  } finally {
    await Deno.remove(root, { recursive: true })
  }
}

const empty = (nodes: unknown[] = [], hasNextPage = false) => ({
  nodes,
  pageInfo: { hasNextPage, endCursor: null },
})
const issues = {
  nodes: [],
  pageInfo: { hasNextPage: false, endCursor: "upstream-cursor" },
}

type Failure = {
  ok: false
  effect: string
  error: {
    code: string
    message: string
    suggestion?: string
    details?: unknown
  }
}

async function expectNotFound(
  server: MockLinearServer,
  args: string[],
  expected: {
    message: string
    suggestion: string
    details: unknown
    requests: number
  },
  env: Record<string, string> = {},
) {
  const result = await run(server, [...args, "--json"], env)
  assertEquals(result.code, 1, result.stdout + result.stderr)
  const failure = JSON.parse(result.stdout) as Failure
  assertEquals(failure.ok, false)
  assertEquals(failure.effect, "none")
  assertEquals(failure.error.code, "NotFoundError")
  // The command's failure context precedes the message.
  assertEquals(
    failure.error.message.endsWith(`: ${expected.message}`),
    true,
    failure.error.message,
  )
  assertStringIncludes(failure.error.suggestion ?? "", expected.suggestion)
  assertEquals(failure.error.details, expected.details)
  assertEquals(server.graphqlRequests.length, expected.requests)
}

for (
  const { name, args, queryName, data, message, suggestion, details, env } of [
    {
      name: "a team key",
      args: ["issue", "query", "--team", "NOPE"],
      queryName: "GetIssuesForQuery",
      data: { referenceTeams: empty() },
      message: 'Team not found: "NOPE" (--team)',
      suggestion: "`linear team list`",
      details: { option: "--team", values: ["NOPE"] },
    },
    {
      name: "the configured team key",
      args: ["issue", "query"],
      env: { LINEAR_TEAM_KEY: "NOPE" },
      queryName: "GetIssuesForQuery",
      data: { referenceTeams: empty() },
      message: 'Team not found: "NOPE" (configured team_key)',
      suggestion: "`linear team list`",
      details: { option: "configured team_key", values: ["NOPE"] },
    },
    {
      name: "a workflow state name",
      args: ["issue", "query", "--team", "ENG", "--state-name", "Nope"],
      queryName: "GetIssuesForQuery",
      data: { referenceWorkflowStates: empty() },
      message: 'Workflow state not found: "Nope" (--state-name)',
      suggestion: "`linear team states ENG`",
      details: { option: "--state-name", values: ["Nope"] },
    },
    {
      name: "one of several label names",
      args: ["issue", "query", "--all-teams", "-l", "Bug", "-l", "NoSuchLabel"],
      queryName: "GetIssuesForQuery",
      // Label names match case-insensitively, as the issue filter does.
      data: { referenceIssueLabels: empty([{ name: "bug" }]) },
      message: 'Label not found: "NoSuchLabel" (--label)',
      suggestion: "`linear label list --all`",
      details: { option: "--label", values: ["NoSuchLabel"] },
    },
    {
      name: "a project label name with --search",
      args: [
        "issue",
        "query",
        "--all-teams",
        "--search",
        "timeout",
        "--project-label",
        "Nope",
      ],
      queryName: "SearchIssues",
      data: { referenceProjectLabels: empty() },
      message: 'Project label not found: "Nope" (--project-label)',
      suggestion: "projectLabels",
      details: { option: "--project-label", values: ["Nope"] },
    },
    {
      name: "a project UUID",
      args: [
        "issue",
        "query",
        "--project",
        "00000000-0000-4000-8000-000000000000",
      ],
      queryName: "GetIssuesForQuery",
      data: { referenceProjects: empty() },
      message:
        'Project not found: "00000000-0000-4000-8000-000000000000" (--project)',
      suggestion: "`linear project list`",
      details: {
        option: "--project",
        values: ["00000000-0000-4000-8000-000000000000"],
      },
    },
  ]
) {
  Deno.test(`issue query fails on the first page for ${name} that names nothing`, async () => {
    const { server, cleanup } = await setupMockLinearServer([{
      queryName,
      response: {
        data: {
          ...(queryName === "SearchIssues"
            ? { searchIssues: { ...issues, totalCount: 0 } }
            : { issues }),
          ...data,
        },
      },
    }])
    try {
      // One request: the checks ride along with the first issue page.
      await expectNotFound(server, args, {
        message,
        suggestion,
        details,
        requests: 1,
      }, env)
    } finally {
      await cleanup()
    }
  })
}

Deno.test("issue query keeps the filter, result and request count for existing values", async () => {
  const { server, cleanup } = await setupMockLinearServer([{
    queryName: "GetIssuesForQuery",
    response: { data: { issues } },
  }])
  try {
    const result = await run(server, [
      "issue",
      "query",
      "--team",
      "ENG",
      "--state-name",
      "in progress",
      "-l",
      "Bug",
      "--limit",
      "1",
      "--json",
    ])
    assertEquals(result.code, 0, result.stdout + result.stderr)
    assertEquals(JSON.parse(result.stdout), issues)
    assertEquals(server.graphqlRequests.length, 1)
    const { variables } = server.graphqlRequests[0]
    assertEquals(variables.filter, {
      team: { key: { eq: "ENG" } },
      state: { name: { eqIgnoreCase: "in progress" } },
      labels: { some: { name: { eqIgnoreCase: "Bug" } } },
    })
    assertEquals(variables.teamReferenceFilter, { key: { in: ["ENG"] } })
    assertEquals(variables.workflowStateReferenceFilter, {
      name: { eqIgnoreCase: "in progress" },
    })
    assertEquals(variables.issueLabelReferenceFilter, {
      name: { eqIgnoreCase: "Bug" },
    })
  } finally {
    await cleanup()
  }
})

for (
  const { found, code, requests } of [
    { found: [{ name: "Done" }], code: 0, requests: 2 },
    { found: [], code: 1, requests: 2 },
  ]
) {
  Deno.test(
    `issue query re-reads only missing names when a check page is truncated (${
      found.length > 0 ? "found" : "missing"
    })`,
    async () => {
      const { server, cleanup } = await setupMockLinearServer([
        {
          queryName: "GetIssuesForQuery",
          response: {
            data: {
              issues,
              referenceWorkflowStates: empty([{ name: "Todo" }], true),
            },
          },
        },
        {
          queryName: "CheckFilterReferences",
          response: { data: { referenceWorkflowStates: empty(found) } },
        },
      ])
      try {
        const result = await run(server, [
          "issue",
          "query",
          "--all-teams",
          "--state-name",
          "Todo",
          "--state-name",
          "Done",
          "--limit",
          "1",
          "--json",
        ])
        assertEquals(result.code, code, result.stdout + result.stderr)
        if (code === 1) {
          assertStringIncludes(
            JSON.parse(result.stdout).error.message,
            'Workflow state not found: "Done" (--state-name)',
          )
        }
        assertEquals(server.graphqlRequests.length, requests)
        assertEquals(server.graphqlRequests[1].variables, {
          checkWorkflowStateReferences: true,
          workflowStateReferenceFilter: { name: { eqIgnoreCase: "Done" } },
        })
      } finally {
        await cleanup()
      }
    },
  )
}

Deno.test("issue query --url-file checks filter values once, not per URL", async () => {
  const root = await Deno.makeTempDir()
  const urlFile = join(root, "urls.txt")
  await Deno.writeTextFile(
    urlFile,
    "https://example.com/a\nhttps://example.com/b\n",
  )
  const { server, cleanup } = await setupMockLinearServer([
    {
      queryName: "CheckFilterReferences",
      response: { data: { referenceIssueLabels: empty() } },
    },
  ])
  try {
    await expectNotFound(
      server,
      ["issue", "query", "--all-teams", "--url-file", urlFile, "-l", "Nope"],
      {
        message: 'Label not found: "Nope" (--label)',
        suggestion: "`linear label list --all`",
        details: { option: "--label", values: ["Nope"] },
        requests: 1,
      },
    )
  } finally {
    await cleanup()
    await Deno.remove(root, { recursive: true })
  }
})

Deno.test("project list fails for a team key or status name that names nothing", async () => {
  const statuses = empty([{ name: "Backlog" }, { name: "In Progress" }])
  const { server, cleanup } = await setupMockLinearServer([{
    queryName: "GetProjects",
    response: (request) => ({
      data: {
        projects: empty(),
        projectStatuses: statuses,
        ...(request.variables.checkTeamReferences === true &&
            request.variables.teamReferenceFilter != null &&
            JSON.stringify(request.variables.teamReferenceFilter).includes(
              "NOPE",
            )
          ? { referenceTeams: empty() }
          : {}),
      },
    }),
  }])
  try {
    await expectNotFound(server, ["project", "list", "--team", "NOPE"], {
      message: 'Team not found: "NOPE" (--team)',
      suggestion: "`linear team list`",
      details: { option: "--team", values: ["NOPE"] },
      requests: 1,
    })
    await expectNotFound(
      server,
      ["project", "list", "--all-teams", "--status-name", "in progress"],
      {
        message: 'Project status not found: "in progress" (--status-name)',
        suggestion: '"Backlog", "In Progress"',
        details: { option: "--status-name", values: ["in progress"] },
        requests: 2,
      },
    )

    const result = await run(server, [
      "project",
      "list",
      "--team",
      "ENG",
      "--status-name",
      "In Progress",
      "--json",
    ])
    assertEquals(result.code, 0, result.stdout + result.stderr)
    assertEquals(JSON.parse(result.stdout), empty())
    assertEquals(server.graphqlRequests.length, 3)
    assertEquals(server.graphqlRequests[2].variables.filter, {
      accessibleTeams: { some: { key: { eq: "ENG" } } },
      status: { name: { eq: "In Progress" } },
    })
  } finally {
    await cleanup()
  }
})

Deno.test("label list fails for a team key that names nothing instead of showing workspace labels", async () => {
  const labels = empty([{
    id: "label-1",
    name: "Workspace label",
    description: null,
    color: "#000000",
    team: null,
  }])
  const { server, cleanup } = await setupMockLinearServer([{
    queryName: "GetIssueLabels",
    response: (request) => ({
      data: {
        issueLabels: labels,
        ...(JSON.stringify(request.variables.teamReferenceFilter ?? null)
            .includes("NOPE")
          ? { referenceTeams: empty() }
          : {}),
      },
    }),
  }])
  try {
    await expectNotFound(server, ["label", "list", "--team", "nope"], {
      message: 'Team not found: "NOPE" (--team)',
      suggestion: "`linear team list`",
      details: { option: "--team", values: ["NOPE"] },
      requests: 1,
    })

    const result = await run(server, [
      "label",
      "list",
      "--team",
      "ENG",
      "--json",
    ])
    assertEquals(result.code, 0, result.stdout + result.stderr)
    assertEquals(JSON.parse(result.stdout), labels)
    assertEquals(server.graphqlRequests.length, 2)
  } finally {
    await cleanup()
  }
})

Deno.test("document list fails for a project UUID that names nothing", async () => {
  const projectId = "00000000-0000-4000-8000-000000000000"
  const documents = empty([{
    id: "document-1",
    title: "Plan",
    slugId: "plan",
    url: "https://linear.app/doc/plan",
    updatedAt: "2026-09-06T00:00:00Z",
    project: { name: "Launch", slugId: "launch" },
    issue: null,
    creator: { name: "Alex" },
  }])
  const { server, cleanup } = await setupMockLinearServer([{
    queryName: "ListDocuments",
    response: (request) => ({
      data: {
        documents: empty(),
        ...(JSON.stringify(request.variables.projectReferenceFilter ?? null)
            .includes(projectId)
          ? { referenceProjects: empty() }
          : {}),
      },
    }),
  }])
  try {
    await expectNotFound(server, ["document", "list", "--project", projectId], {
      message: `Project not found: "${projectId}" (--project)`,
      suggestion: "`linear project list`",
      details: { option: "--project", values: [projectId] },
      requests: 1,
    })
  } finally {
    await cleanup()
  }

  // An existing project keeps its filter and its single request.
  const existing = "11111111-1111-4111-8111-111111111111"
  const { server: found, cleanup: cleanupFound } = await setupMockLinearServer([
    { queryName: "ListDocuments", response: { data: { documents } } },
  ])
  try {
    const result = await run(found, [
      "document",
      "list",
      "--project",
      existing,
      "--json",
    ])
    assertEquals(result.code, 0, result.stdout + result.stderr)
    assertEquals(JSON.parse(result.stdout), documents)
    assertEquals(found.graphqlRequests.length, 1)
    const { variables } = found.graphqlRequests[0]
    assertEquals(variables.filter, { project: { id: { eq: existing } } })
    assertEquals(variables.projectReferenceFilter, { id: { in: [existing] } })
  } finally {
    await cleanupFound()
  }
})

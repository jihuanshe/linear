import { assertEquals, assertStringIncludes } from "@std/assert"
import { fromFileUrl } from "@std/path"
import type { MockLinearServer } from "../../utils/mock_linear_server.ts"
import { setupMockLinearServer } from "../../utils/test-helpers.ts"

const main = fromFileUrl(new URL("../../../src/main.ts", import.meta.url))

type MockResponses = NonNullable<
  ConstructorParameters<typeof MockLinearServer>[0]
>

function issueNode(
  id: string,
  identifier: string,
  lifecycle: { trashed?: boolean | null; archivedAt?: string | null } = {},
) {
  return {
    id,
    identifier,
    title: `Issue ${identifier}`,
    url: `https://linear.app/test/issue/${identifier}`,
    trashed: lifecycle.trashed ?? null,
    archivedAt: lifecycle.archivedAt ?? null,
    priority: 0,
    priorityLabel: "No priority",
    estimate: null,
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-02T00:00:00.000Z",
    state: { id: "state-1", name: "Todo", color: "#e2e2e2", type: "unstarted" },
    assignee: null,
    team: {
      id: `team-${identifier.split("-")[0]}`,
      key: identifier.split("-")[0],
      name: identifier.split("-")[0],
      cyclesEnabled: false,
      activeCycle: null,
    },
    project: null,
    projectMilestone: null,
    cycle: null,
    labels: { nodes: [] },
    inverseRelations: { nodes: [] },
  }
}

/** Serve `issues(filter: {id: {in}})` from a fixed set, like Linear does. */
function issuesById(nodes: ReturnType<typeof issueNode>[]): MockResponses[0] {
  return {
    queryName: "GetIssuesForQuery",
    response: (request) => {
      const wanted = (request.variables.filter as { id: { in: string[] } }).id
        .in
      return {
        data: {
          issues: {
            nodes: nodes.filter((node) =>
              wanted.includes(node.identifier) || wanted.includes(node.id)
            ),
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      }
    },
  }
}

/** Linear's response when one aliased `issue(id:)` does not exist. */
function aliasNotFound(alias: string) {
  return {
    errors: [{
      message: "Entity not found: Issue",
      path: [alias],
      extensions: {
        type: "invalid input",
        code: "INPUT_ERROR",
        statusCode: 400,
        userError: true,
        userPresentableMessage: "Could not find referenced Issue.",
      },
    }],
    data: null,
  }
}

async function runQuery(responses: MockResponses, args: string[]) {
  const { server, cleanup } = await setupMockLinearServer(responses)
  const root = await Deno.makeTempDir()
  try {
    const result = await new Deno.Command(Deno.execPath(), {
      args: ["run", "--allow-all", "--quiet", main, "issue", "query", ...args],
      cwd: root,
      clearEnv: true,
      env: {
        HOME: root,
        XDG_CONFIG_HOME: root,
        NO_COLOR: "1",
        LINEAR_GRAPHQL_ENDPOINT: server.getEndpoint(),
        LINEAR_API_KEY: "Bearer test-token",
      },
      stdout: "piped",
      stderr: "piped",
    }).output()
    const decoder = new TextDecoder()
    return {
      code: result.code,
      stdout: decoder.decode(result.stdout),
      stderr: decoder.decode(result.stderr),
      requests: server.graphqlRequests,
    }
  } finally {
    await cleanup()
    await Deno.remove(root, { recursive: true })
  }
}

function operations(requests: { query: string }[]): string[] {
  return requests.map((request) =>
    request.query.match(/query\s+(\w+)/)?.[1] ?? "?"
  )
}

Deno.test("Issue Query --id - reads every identifier in one request when all exist", async () => {
  const result = await runQuery(
    [issuesById([
      issueNode("issue-2", "MOB-984"),
      issueNode("issue-1", "ENG-101"),
    ])],
    ["--id", "eng-101", "--id", "MOB-984", "--id", "ENG-101", "--json"],
  )

  assertEquals(result.code, 0, result.stderr)
  const payload = JSON.parse(result.stdout)
  assertEquals(payload.nodes.map((n: { id: string }) => n.id), [
    "issue-1",
    "issue-2",
  ])
  assertEquals(payload.pageInfo, { hasNextPage: false, endCursor: null })
  assertEquals(payload.resolutions, [
    { status: "found", requested: "ENG-101", identifier: "ENG-101" },
    { status: "found", requested: "MOB-984", identifier: "MOB-984" },
  ])
  assertEquals(payload.reconciliation, { requested: 2, read: 2, missing: 0 })
  assertEquals(operations(result.requests), ["GetIssuesForQuery"])
  assertEquals(result.requests[0].variables.filter, {
    id: { in: ["ENG-101", "MOB-984"] },
  })
  assertEquals(result.requests[0].variables.includeArchived, true)
  assertEquals(result.requests[0].variables.first, 100)
})

Deno.test("Issue Query --id - resolves moved, trashed, archived, and missing identifiers without failing the batch", async () => {
  const result = await runQuery(
    [
      issuesById([
        issueNode("issue-1", "ENG-101"),
        issueNode("issue-2", "ENG-102", {
          trashed: true,
          archivedAt: "2026-09-24T00:00:00.000Z",
        }),
        issueNode("issue-3", "ENG-103", {
          archivedAt: "2026-09-20T00:00:00.000Z",
        }),
        issueNode("issue-150", "ENG-150"),
      ]),
      {
        queryName: "ResolveIssueIdentifiers",
        response: (request) =>
          // OLD-7 moved to ENG-150; ENG-999 never existed. Linear reports
          // only the first missing alias and nulls the whole response.
          request.variables.i1 === "ENG-999" ? aliasNotFound("i1") : {
            data: {
              i0: {
                id: "issue-150",
                identifier: "ENG-150",
                trashed: null,
                archivedAt: null,
              },
            },
          },
        status: 200,
      },
    ],
    [
      "--id",
      "ENG-101",
      "--id",
      "OLD-7",
      "--id",
      "ENG-999",
      "--id",
      "ENG-102",
      "--id",
      "ENG-103",
      "--json",
    ],
  )

  assertEquals(result.code, 0, result.stderr)
  const payload = JSON.parse(result.stdout)
  assertEquals(payload.resolutions, [
    { status: "found", requested: "ENG-101", identifier: "ENG-101" },
    { status: "moved", requested: "OLD-7", identifier: "ENG-150" },
    { status: "not_found", requested: "ENG-999" },
    { status: "trashed", requested: "ENG-102", identifier: "ENG-102" },
    { status: "archived", requested: "ENG-103", identifier: "ENG-103" },
  ])
  assertEquals(
    payload.nodes.map((n: { identifier: string }) => n.identifier),
    ["ENG-101", "ENG-150", "ENG-102", "ENG-103"],
  )
  assertEquals(payload.nodes[2].trashed, true)
  assertEquals(payload.reconciliation, { requested: 5, read: 4, missing: 1 })
  // Filter batch, alias round that finds ENG-999 missing, alias reread, and
  // the moved issue's node.
  assertEquals(operations(result.requests), [
    "GetIssuesForQuery",
    "ResolveIssueIdentifiers",
    "ResolveIssueIdentifiers",
    "GetIssuesForQuery",
  ])
  assertEquals(result.requests[1].variables, { i0: "OLD-7", i1: "ENG-999" })
  assertEquals(result.requests[2].variables, { i0: "OLD-7" })
  assertEquals(result.requests[3].variables.filter, {
    id: { in: ["issue-150"] },
  })
})

Deno.test("Issue Query --id - reports missing identifiers when the HTTP status is 400", async () => {
  const result = await runQuery(
    [
      issuesById([]),
      {
        queryName: "ResolveIssueIdentifiers",
        status: 400,
        response: (request) =>
          aliasNotFound(`i${Object.keys(request.variables).length - 1}`),
      },
    ],
    ["--id", "ENG-998", "--id", "ENG-999", "--json"],
  )

  assertEquals(result.code, 0, result.stderr)
  const payload = JSON.parse(result.stdout)
  assertEquals(payload.nodes, [])
  assertEquals(payload.reconciliation, { requested: 2, read: 0, missing: 2 })
  assertEquals(
    payload.resolutions.map((r: { status: string }) => r.status),
    ["not_found", "not_found"],
  )
  assertEquals(operations(result.requests), [
    "GetIssuesForQuery",
    "ResolveIssueIdentifiers",
    "ResolveIssueIdentifiers",
  ])
})

Deno.test("Issue Query --id-file - splits more than one batch and reads every identifier", async () => {
  const nodes = Array.from(
    { length: 150 },
    (_, index) => issueNode(`issue-${index + 1}`, `ENG-${index + 1}`),
  )
  const idFile = await Deno.makeTempFile({ suffix: ".txt" })
  await Deno.writeTextFile(
    idFile,
    "# feedback batch\n\n" +
      nodes.map((node) => node.identifier).join("\n") + "\n",
  )
  try {
    const result = await runQuery([issuesById(nodes)], [
      "--id-file",
      idFile,
      "--json",
    ])

    assertEquals(result.code, 0, result.stderr)
    const payload = JSON.parse(result.stdout)
    assertEquals(payload.reconciliation, {
      requested: 150,
      read: 150,
      missing: 0,
    })
    assertEquals(payload.nodes.length, 150)
    assertEquals(payload.nodes[149].identifier, "ENG-150")
    assertEquals(
      result.requests.map((request) =>
        (request.variables.filter as { id: { in: string[] } }).id.in.length
      ),
      [100, 50],
    )
  } finally {
    await Deno.remove(idFile)
  }
})

Deno.test("Issue Query --id - fails with a non-zero exit when a resolved issue cannot be read", async () => {
  const result = await runQuery(
    [
      // OLD-7 resolves to issue-150, but the node read returns nothing, for
      // example because it was deleted between the two requests.
      issuesById([issueNode("issue-1", "ENG-101")]),
      {
        queryName: "ResolveIssueIdentifiers",
        response: {
          data: {
            i0: {
              id: "issue-150",
              identifier: "ENG-150",
              trashed: null,
              archivedAt: null,
            },
          },
        },
      },
    ],
    ["--id", "ENG-101", "--id", "OLD-7", "--json"],
  )

  assertEquals(result.code, 1)
  const payload = JSON.parse(result.stdout)
  assertEquals(payload.ok, false)
  assertStringIncludes(
    payload.error.message,
    "Issue read reconciliation failed: 2 requested, 1 read + 0 missing",
  )
  assertEquals(payload.error.details.reconciliation, {
    requested: 2,
    read: 1,
    missing: 0,
  })
  assertEquals(payload.error.details.unread, ["OLD-7"])
})

Deno.test("Issue Query --id - prints resolutions and the reconciliation for people", async () => {
  const result = await runQuery(
    [
      issuesById([issueNode("issue-1", "ENG-101")]),
      {
        queryName: "ResolveIssueIdentifiers",
        response: aliasNotFound("i0"),
      },
    ],
    ["--id", "ENG-101", "--id", "ENG-999", "--no-pager"],
  )

  assertEquals(result.code, 0, result.stderr)
  assertStringIncludes(
    result.stdout,
    "ENG-999 does not exist in this workspace",
  )
  assertStringIncludes(result.stdout, "Issue ENG-101")
  assertStringIncludes(
    result.stdout,
    "Read 1 of 2 requested issues; 1 not found.",
  )
})

for (
  const [name, args, message] of [
    [
      "an invalid identifier",
      ["--id", "ENG-0"],
      'Invalid issue identifier in --id: "ENG-0"',
    ],
    [
      "a team key longer than Linear accepts",
      ["--id", "ENG-1", "--id", "ABCDEFGH-1"],
      'Invalid issue identifier in --id: "ABCDEFGH-1"',
    ],
    [
      "a number larger than Linear accepts",
      ["--id", "ENG-1", "--id", "ENG-1000000000"],
      'Invalid issue identifier in --id: "ENG-1000000000"',
    ],
    [
      "a filter",
      ["--id", "ENG-1", "--team", "ENG"],
      "Cannot combine --id with --team",
    ],
    [
      "--url",
      ["--id", "ENG-1", "--url", "https://example.com"],
      "Cannot combine --id with --url",
    ],
    [
      "--id-file",
      ["--id", "ENG-1", "--id-file", "ids.txt"],
      "Cannot use both --id and --id-file",
    ],
  ] as const
) {
  Deno.test(`Issue Query --id - rejects ${name} before any request`, async () => {
    const result = await runQuery([], [...args, "--json"])
    assertEquals(result.code, 1)
    assertStringIncludes(JSON.parse(result.stdout).error.message, message)
    assertEquals(result.requests, [])
  })
}

import { assertEquals, assertStringIncludes } from "@std/assert"
import { fromFileUrl, join } from "@std/path"
import { MockLinearServer } from "../../utils/mock_linear_server.ts"

const main = fromFileUrl(new URL("../../../src/main.ts", import.meta.url))
const organization = {
  id: "99999999-9999-4999-8999-999999999999",
  urlKey: "jihuanshe",
}
const issueId = "11111111-1111-4111-8111-000000000123"
const terminalPage = { hasNextPage: false, endCursor: "last" }
const empty = { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } }

function comment(id: string, parent: string | null = null) {
  return {
    id,
    body: `Comment ${id}`,
    createdAt: "2026-09-06T00:00:00Z",
    updatedAt: "2026-09-06T00:00:00Z",
    url: `https://linear.app/issue/TEST-123#${id}`,
    resolvedAt: null,
    resolvingCommentId: null,
    resolvingUser: null,
    user: { name: "Alex", displayName: "Alex" },
    externalUser: null,
    parent: parent == null ? null : { id: parent },
  }
}

function attachment(id: string) {
  return {
    id,
    title: `PR ${id}`,
    url: `https://github.com/example/repo/pull/${id}`,
    subtitle: null,
    sourceType: "github",
    metadata: { state: "merged" },
    createdAt: "2026-09-06T00:00:00Z",
  }
}

const issue = {
  id: issueId,
  identifier: "TEST-123",
  title: "Read all evidence",
  description: "Issue body",
  url: "https://linear.app/issue/TEST-123",
  archivedAt: null,
  trashed: false,
  branchName: "test-123",
  state: {
    id: "33333333-3333-4333-8333-333333333333",
    name: "Todo",
    type: "unstarted",
    color: "#000000",
  },
  priority: 0,
  estimate: null,
  dueDate: null,
  assignee: null,
  project: null,
  projectMilestone: null,
  cycle: null,
  parent: null,
  team: {
    id: "22222222-2222-4222-8222-222222222222",
    key: "TEST",
    activeCycle: null,
  },
  children: empty,
  documents: empty,
  labels: empty,
  relations: empty,
  inverseRelations: empty,
  comments: {
    nodes: Array.from({ length: 50 }, (_, index) => comment(String(index))),
    pageInfo: { hasNextPage: true, endCursor: "comments-next" },
  },
  attachments: {
    nodes: Array.from({ length: 50 }, (_, index) => attachment(String(index))),
    pageInfo: { hasNextPage: true, endCursor: "attachments-next" },
  },
}

function detailResponse(value: Record<string, unknown>, withComments = true) {
  return {
    queryName: withComments ? "GetIssueDetailsWithComments" : "GetIssueDetails",
    response: { data: { organization, issue: value } },
  }
}

function remainingResponses() {
  return [
    {
      queryName: "GetIssueComments",
      variables: { after: "comments-next", first: 100 },
      response: {
        data: {
          issue: {
            comments: {
              nodes: [comment("late-reply", "0")],
              pageInfo: terminalPage,
            },
          },
        },
      },
    },
    {
      queryName: "GetIssueAttachments",
      variables: { after: "attachments-next", first: 100 },
      response: {
        data: {
          issue: {
            attachments: {
              nodes: [attachment("999")],
              pageInfo: terminalPage,
            },
          },
        },
      },
    },
  ]
}

async function runCli(server: MockLinearServer, args: string[], cwd?: string) {
  const output = await new Deno.Command(Deno.execPath(), {
    args: ["run", "--allow-all", "--quiet", main, ...args],
    cwd,
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
  result: { code: number; stdout: string; stderr: string },
  message: string,
  json = true,
) {
  assertEquals(result.code, 1)
  if (!json) {
    assertEquals(result.stdout, "")
    assertStringIncludes(result.stderr, message)
    return
  }
  // Parsing the whole stdout also rejects a partial page before/after the error.
  const error = JSON.parse(result.stdout)
  assertEquals(Object.keys(error).sort(), ["effect", "error", "ok"])
  assertEquals(error.ok, false)
  assertEquals(error.effect, "none")
  assertStringIncludes(error.error.message, message)
  assertEquals(result.stderr, "")
}

for (const mode of ["query", "search", "mine"]) {
  Deno.test(`issue ${mode} rejects a nonadjacent cursor cycle without partial stdout`, async () => {
    const queryName = mode === "search" ? "SearchIssues" : "GetIssuesForQuery"
    const field = mode === "search" ? "searchIssues" : "issues"
    const server = new MockLinearServer(
      [
        { after: "a", endCursor: "b" },
        { after: "b", endCursor: "a" },
        { after: undefined, endCursor: "a" },
      ].map(({ after, endCursor }) => ({
        queryName,
        variables: after == null ? {} : { after },
        response: {
          data: {
            [field]: {
              nodes: [{
                ...issue,
                id: "issue-1",
                updatedAt: "2026-09-06T00:00:00Z",
              }],
              totalCount: 3,
              pageInfo: { hasNextPage: true, endCursor },
            },
          },
        },
      })),
    )
    await server.start()
    try {
      const result = await runCli(server, [
        "issue",
        mode === "mine" ? "mine" : "query",
        "--team",
        "TEST",
        "--limit",
        "0",
        ...(mode === "mine" ? ["--no-pager"] : ["--json"]),
        ...(mode === "search" ? ["--search", "evidence"] : []),
      ])
      assertReadFailure(result, "empty or repeated cursor", mode !== "mine")
      assertEquals(server.graphqlRequests.length, 3)
      if (mode === "mine") {
        assertEquals(server.graphqlRequests[0].variables.filter, {
          team: { key: { eq: "TEST" } },
          state: { type: { in: ["unstarted"] } },
          assignee: { isMe: { eq: true } },
        })
      }
    } finally {
      await server.stop()
    }
  })
}

for (const search of [false, true]) {
  Deno.test(`issue query search=${search} requests only the remaining limit and retains the cursor`, async () => {
    const queryName = search ? "SearchIssues" : "GetIssuesForQuery"
    const field = search ? "searchIssues" : "issues"
    const continuation = { hasNextPage: true, endCursor: "more" }
    const server = new MockLinearServer([
      {
        queryName,
        variables: { after: "next", first: 1 },
        response: {
          data: {
            [field]: {
              nodes: [{ id: "late" }],
              totalCount: 200,
              pageInfo: continuation,
            },
          },
        },
      },
      {
        queryName,
        variables: { first: 100 },
        response: {
          data: {
            [field]: {
              nodes: Array.from(
                { length: 100 },
                (_, id) => ({ id: String(id) }),
              ),
              totalCount: 200,
              pageInfo: { hasNextPage: true, endCursor: "next" },
            },
          },
        },
      },
    ])
    await server.start()
    try {
      const result = await runCli(server, [
        "issue",
        "query",
        "--all-teams",
        "--limit",
        "101",
        "--json",
        ...(search ? ["--search", "evidence"] : []),
      ])
      assertEquals(result.code, 0, result.stderr)
      const data = JSON.parse(result.stdout)
      assertEquals(data.nodes.length, 101)
      assertEquals(data.nodes.at(-1), { id: "late" })
      assertEquals(data.pageInfo, continuation)
      if (search) assertEquals(data.totalCount, 200)
      assertEquals(server.graphqlRequests.length, 2)
    } finally {
      await server.stop()
    }
  })
}

for (const json of [true, false]) {
  Deno.test(`issue view ${json ? "JSON" : "human"} includes late comments and PR attachments`, async () => {
    const server = new MockLinearServer([
      detailResponse(issue),
      ...remainingResponses(),
    ])
    await server.start()
    try {
      const result = await runCli(server, [
        "issue",
        "view",
        "TEST-123",
        "--no-download",
        "--no-pager",
        ...(json ? ["--json"] : []),
      ])
      assertEquals(result.code, 0, result.stderr)
      assertEquals(result.stderr, "")
      if (json) {
        const data = JSON.parse(result.stdout).issue
        assertEquals(data.comments.nodes.length, 51)
        assertEquals(data.comments.nodes.at(-1).parent.id, "0")
        assertEquals(data.attachments.nodes.at(-1), attachment("999"))
        assertEquals(data.comments.pageInfo, terminalPage)
        assertEquals(data.attachments.pageInfo, terminalPage)
      } else {
        assertStringIncludes(result.stdout, "Comment late-reply")
        assertStringIncludes(
          result.stdout,
          "https://github.com/example/repo/pull/999",
        )
      }
      assertEquals(server.graphqlRequests.length, 3)
      assertEquals(
        server.graphqlRequests.slice(1).every(({ variables }) =>
          variables.id === issueId
        ),
        true,
      )
    } finally {
      await server.stop()
    }
  })
}

for (const command of ["title", "url", "describe"]) {
  Deno.test(`issue ${command} does not depend on attachment pagination`, async () => {
    const server = new MockLinearServer([{
      queryName: "GetIssueHeader",
      variables: { id: "TEST-123" },
      response: {
        data: {
          issue: {
            id: issue.id,
            identifier: issue.identifier,
            title: issue.title,
            url: issue.url,
          },
        },
      },
    }])
    await server.start()
    try {
      const result = await runCli(server, ["issue", command, "TEST-123"])
      assertEquals(result.code, 0, result.stderr)
      assertStringIncludes(
        result.stdout,
        command === "url" ? issue.url : issue.title,
      )
      assertEquals(server.graphqlRequests.length, 1)
      assertEquals(
        /attachments\(|comments\(|description/.test(
          server.graphqlRequests[0].query,
        ),
        false,
      )
    } finally {
      await server.stop()
    }
  })
}

Deno.test("issue view --no-comments paginates attachments without requesting comments", async () => {
  const { comments: _comments, ...withoutComments } = issue
  const server = new MockLinearServer([
    detailResponse(withoutComments, false),
    ...remainingResponses(),
  ])
  await server.start()
  try {
    const result = await runCli(server, [
      "issue",
      "view",
      "TEST-123",
      "--no-comments",
      "--json",
    ])
    assertEquals(result.code, 0, result.stderr)
    const data = JSON.parse(result.stdout).issue
    assertEquals(data.comments, undefined)
    assertEquals(data.attachments.nodes.length, 51)
    assertEquals(server.graphqlRequests.length, 2)
    assertEquals(server.graphqlRequests[1].variables.id, issueId)
    assertEquals(
      server.graphqlRequests.some(({ query }) => query.includes("comments(")),
      false,
    )
  } finally {
    await server.stop()
  }
})

for (const field of ["comments", "attachments", "labels"] as const) {
  const queryName = {
    comments: "GetIssueComments",
    attachments: "GetIssueAttachments",
    labels: "GetIssueLabelsForWrite",
  }[field]
  for (const failure of ["missing", "empty", "cycle", "later-error"]) {
    Deno.test(`issue view rejects ${field} ${failure} pagination without partial stdout`, async () => {
      const pageInfo = failure === "missing" ? undefined : {
        hasNextPage: true,
        endCursor: failure === "empty" ? "" : "a",
      }
      const server = new MockLinearServer([
        detailResponse({
          ...issue,
          comments: empty,
          attachments: empty,
          [field]: { nodes: [], pageInfo },
        }),
        {
          queryName,
          variables: { after: "a" },
          response: failure === "later-error"
            ? { errors: [{ message: "Later page failed" }] }
            : {
              data: {
                issue: {
                  [field]: {
                    nodes: [],
                    pageInfo: { hasNextPage: true, endCursor: "b" },
                  },
                },
              },
            },
        },
        {
          queryName,
          variables: { after: "b" },
          response: {
            data: {
              issue: {
                [field]: {
                  nodes: [],
                  pageInfo: { hasNextPage: true, endCursor: "a" },
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
          "view",
          "TEST-123",
          "--json",
        ])
        assertReadFailure(
          result,
          failure === "later-error"
            ? "Later page failed"
            : `Incomplete ${field}`,
        )
        assertEquals(
          server.graphqlRequests.length,
          failure === "cycle" ? 3 : failure === "later-error" ? 2 : 1,
        )
      } finally {
        await server.stop()
      }
    })
  }
}

for (const limit of [50, 51, 0]) {
  Deno.test(`comment list respects limit ${limit} and retains pageInfo`, async () => {
    const server = new MockLinearServer([
      {
        queryName: "GetIssueComments",
        variables: { after: undefined },
        response: { data: { issue: { comments: issue.comments } } },
      },
      {
        queryName: "GetIssueComments",
        variables: { after: "comments-next", first: limit === 51 ? 1 : 100 },
        response: {
          data: {
            issue: {
              comments: {
                nodes: [comment("late-reply", "0")],
                pageInfo: terminalPage,
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
        "comment",
        "list",
        "TEST-123",
        "--json",
        ...(limit === 50 ? [] : ["--limit", String(limit)]),
      ])
      assertEquals(result.code, 0, result.stderr)
      const data = JSON.parse(result.stdout)
      assertEquals(data.nodes.length, limit === 50 ? 50 : 51)
      assertEquals(
        data.pageInfo,
        limit === 50 ? issue.comments.pageInfo : terminalPage,
      )
      assertEquals(server.graphqlRequests.length, limit === 50 ? 1 : 2)
    } finally {
      await server.stop()
    }
  })
}

for (const limit of ["-1", "1.5"]) {
  Deno.test(`comment list rejects invalid limit ${limit} before querying`, async () => {
    const server = new MockLinearServer()
    await server.start()
    try {
      const result = await runCli(server, [
        "issue",
        "comment",
        "list",
        "TEST-123",
        "--json",
        `--limit=${limit}`,
      ])
      assertReadFailure(
        result,
        "--limit must be a non-negative integer",
      )
      assertEquals(server.graphqlRequests.length, 0)
    } finally {
      await server.stop()
    }
  })
}

Deno.test("comment list --limit 0 rejects repeated cursors without partial stdout", async () => {
  const server = new MockLinearServer([{
    queryName: "GetIssueComments",
    response: { data: { issue: { comments: issue.comments } } },
  }])
  await server.start()
  try {
    const result = await runCli(server, [
      "issue",
      "comment",
      "list",
      "TEST-123",
      "--json",
      "--limit",
      "0",
    ])
    assertReadFailure(
      result,
      "Incomplete comments for TEST-123 pagination",
    )
    assertEquals(server.graphqlRequests.length, 2)
  } finally {
    await server.stop()
  }
})

Deno.test("issue apply JSON preserves progress on stderr and one stdout document", async () => {
  const directory = await Deno.makeTempDir({ prefix: "linear-apply-progress-" })
  const signedUrl = "https://example.invalid/evidence?signature=private-token"
  const filePath = join(directory, "private-evidence.txt")
  const assetUrl = "https://uploads.linear.app/fake/private-evidence.txt"
  const server = new MockLinearServer([
    {
      queryName: "GetDeliveryOrganization",
      response: { data: { organization } },
    },
    {
      queryName: "GetIssueForWrite",
      response: {
        data: {
          organization,
          issue: { ...issue, comments: empty, attachments: empty },
        },
      },
    },
    {
      queryName: "AddComment",
      response: {
        data: { commentCreate: { success: true, comment: comment("created") } },
      },
    },
    {
      queryName: "AttachmentLinkURL",
      response: {
        data: {
          attachmentLinkURL: {
            success: true,
            attachment: {
              id: "linked",
              title: "private title",
              url: signedUrl,
            },
          },
        },
      },
    },
    {
      queryName: "AttachmentCreate",
      response: {
        data: {
          attachmentCreate: {
            success: true,
            attachment: {
              id: "uploaded",
              title: "private file title",
              url: assetUrl,
            },
          },
        },
      },
    },
    {
      queryName: "GetDeliveryCommentReceipt",
      variables: { id: "created" },
      response: {
        data: { comment: { id: "created", issue: { id: issueId } } },
      },
    },
    ...["linked", "uploaded"].map((id) => ({
      queryName: "GetDeliveryAttachmentReceipt",
      variables: { id },
      response: { data: { attachment: { id, issue: { id: issueId } } } },
    })),
  ])
  await server.start()
  server.addResponse({
    queryName: "FileUpload",
    response: {
      data: {
        fileUpload: {
          success: true,
          uploadFile: {
            assetUrl,
            uploadUrl: server.getUploadUrl(),
            headers: [],
          },
        },
      },
    },
  })
  try {
    await Deno.writeTextFile(filePath, "private evidence")
    const path = join(directory, "delivery.json")
    await Deno.writeTextFile(
      path,
      JSON.stringify({
        schemaVersion: 2,
        workspace: organization.urlKey,
        issues: [{
          operation: "update",
          identifier: issue.identifier,
          comments: [{ body: "progress test" }],
          attachments: [{ kind: "url", url: signedUrl }, {
            kind: "file",
            path: filePath,
          }],
        }],
      }),
    )
    const result = await runCli(server, [
      "issue",
      "apply",
      "--file",
      path,
      "--confirm-workspace",
      organization.urlKey,
      "--json",
    ], directory)
    assertEquals(result.code, 0, result.stderr + result.stdout)
    assertEquals(
      result.stderr.trim().split("\n"),
      Array.from({ length: 5 }, (_, index) => "Processing item " + (index + 1)),
    )
    assertEquals(
      result.stderr.includes(signedUrl),
      false,
      "signed URL belongs in the JSON result, not progress logs",
    )
    assertEquals(
      result.stderr.includes(filePath),
      false,
      "private file path belongs in the JSON result, not progress logs",
    )
    assertEquals(result.stderr.includes("private evidence"), false)
    const document = JSON.parse(result.stdout)
    assertEquals(document.ok, true)
    assertEquals(document.effect, "applied")
    const outcome = document.data
    assertEquals(outcome.status, "completed")
    assertEquals(outcome.summary.applied, 4)
    assertEquals(outcome.summary.skipped, 1)
    assertEquals(
      outcome.items.filter((item: { kind: string }) =>
        item.kind === "attachment"
      ).map((item: { describe: string }) => item.describe),
      ["link " + signedUrl, "attach " + filePath],
    )
    assertEquals(outcome.verification[0].status, "verified")
    assertEquals(
      server.graphqlRequests.filter(({ query }) =>
        query.includes("mutation AddComment")
      ).length,
      1,
    )
    assertEquals(server.uploadRequests.length, 1)
  } finally {
    await server.stop()
    await Deno.remove(directory, { recursive: true })
  }
})

Deno.test("issue apply resolves self through the same CLI API credentials on resume", async () => {
  const directory = await Deno.makeTempDir({ prefix: "linear-assignee-alias-" })
  const userId = "abcdef01-2345-4678-9abc-def012345678"
  let assigned = false
  const server = new MockLinearServer([
    {
      queryName: "GetDeliveryOrganization",
      response: { data: { organization } },
    },
    {
      queryName: "GetViewerId",
      response: { data: { viewer: { id: userId } } },
    },
    {
      queryName: "GetIssueForWrite",
      response: () => ({
        data: {
          organization,
          issue: {
            ...issue,
            assignee: assigned
              ? { id: userId, name: "Alex", displayName: "alex" }
              : null,
            comments: empty,
            attachments: empty,
          },
        },
      }),
    },
    {
      queryName: "UpdateIssue",
      variables: { id: issueId, input: { assigneeId: userId } },
      response: () => {
        assigned = true
        return {
          data: {
            issueUpdate: {
              success: true,
              issue: {
                id: issueId,
                identifier: issue.identifier,
                title: issue.title,
                url: issue.url,
              },
            },
          },
        }
      },
    },
  ])
  await server.start()
  const upstream = server.getEndpoint()
  const observedCredentials: Array<
    { operation: string; authorization: string | null }
  > = []
  const proxy = Deno.serve({
    hostname: "127.0.0.1",
    port: 0,
    onListen: () => {},
  }, async (request) => {
    const body = await request.text()
    const query = JSON.parse(body).query as string
    observedCredentials.push({
      operation: query.match(/(?:query|mutation)\s+(\w+)/)?.[1] ?? "unknown",
      authorization: request.headers.get("authorization"),
    })
    return await fetch(upstream, {
      method: "POST",
      headers: request.headers,
      body,
    })
  })
  server.getEndpoint = () => "http://127.0.0.1:" + proxy.addr.port + "/graphql"
  try {
    const path = join(directory, "delivery.json")
    await Deno.writeTextFile(
      path,
      JSON.stringify({
        schemaVersion: 2,
        workspace: organization.urlKey,
        issues: [{
          operation: "update",
          identifier: issue.identifier,
          set: { assignee: "self" },
          base: {
            organization,
            issue: {
              ...issue,
              assignee: null,
              comments: empty,
              attachments: empty,
            },
          },
        }],
      }),
    )
    const args = [
      "issue",
      "apply",
      "--file",
      path,
      "--confirm-workspace",
      organization.urlKey,
      "--json",
    ]
    for (let attempt = 0; attempt < 2; attempt++) {
      const result = await runCli(server, args, directory)
      assertEquals(result.code, 0, result.stderr + result.stdout)
      const document = JSON.parse(result.stdout)
      assertEquals(document.ok, true)
      assertEquals(document.data.status, "completed")
      assertEquals(document.data.verification[0].status, "verified")
      if (attempt === 1) {
        assertEquals(document.effect, "none")
        assertEquals(document.data.summary.skipped, 1)
      }
    }
    assertEquals(
      server.graphqlRequests.filter(({ query }) =>
        query.includes("mutation UpdateIssue")
      ).length,
      1,
    )
    assertEquals(
      server.graphqlRequests.filter(({ query }) =>
        query.includes("query GetViewerId")
      ).length,
      1,
    )
    assertEquals(
      observedCredentials.filter((request) =>
        request.operation === "GetViewerId"
      ).map((request) => request.authorization),
      ["Bearer test-token"],
    )
    assertEquals(
      observedCredentials.every((request) =>
        request.authorization === "Bearer test-token"
      ),
      true,
    )
  } finally {
    await proxy.shutdown()
    await server.stop()
    await Deno.remove(directory, { recursive: true })
  }
})

Deno.test("issue view completes labels with the stable UUID before publishing its basis", async () => {
  const label = { id: "label-1", name: "Bug", color: "#123456" }
  const server = new MockLinearServer([
    detailResponse({
      ...issue,
      comments: empty,
      attachments: empty,
      labels: {
        nodes: [label],
        pageInfo: { hasNextPage: true, endCursor: "labels-next" },
      },
    }),
    {
      queryName: "GetIssueLabelsForWrite",
      variables: { id: issueId, first: 100, after: "labels-next" },
      response: {
        data: {
          issue: {
            labels: {
              nodes: [{ ...label, id: "label-2", name: "Priority" }],
              pageInfo: terminalPage,
            },
          },
        },
      },
    },
  ])
  await server.start()
  try {
    const result = await runCli(server, ["issue", "view", "TEST-123", "--json"])
    assertEquals(result.code, 0, result.stdout + result.stderr)
    const data = JSON.parse(result.stdout)
    assertEquals(data.organization, organization)
    assertEquals(data.issue.id, issueId)
    assertEquals(
      data.issue.labels.nodes.map((node: { id: string }) => node.id),
      ["label-1", "label-2"],
    )
    assertEquals(data.issue.labels.pageInfo, terminalPage)
    assertEquals(server.graphqlRequests.length, 2)
  } finally {
    await server.stop()
  }
})

import { assertEquals, assertStringIncludes } from "@std/assert"
import { fromFileUrl, join } from "@std/path"
import { MockLinearServer } from "../../utils/mock_linear_server.ts"

const main = fromFileUrl(new URL("../../../src/main.ts", import.meta.url))
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
  identifier: "TEST-123",
  title: "Read all evidence",
  description: "Issue body",
  url: "https://linear.app/issue/TEST-123",
  archivedAt: null,
  trashed: false,
  branchName: "test-123",
  state: { name: "Todo", type: "unstarted", color: "#000000" },
  priority: 0,
  assignee: null,
  project: null,
  projectMilestone: null,
  cycle: null,
  parent: null,
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
    response: { data: { issue: value } },
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
      assertEquals(result.code, 1)
      assertEquals(result.stdout, "")
      assertStringIncludes(result.stderr, "empty or repeated cursor")
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
        const data = JSON.parse(result.stdout)
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
    } finally {
      await server.stop()
    }
  })
}

for (const command of ["title", "url", "describe"]) {
  Deno.test(`issue ${command} does not depend on attachment pagination`, async () => {
    const server = new MockLinearServer([detailResponse(issue, false)])
    await server.start()
    try {
      const result = await runCli(server, ["issue", command, "TEST-123"])
      assertEquals(result.code, 0, result.stderr)
      assertStringIncludes(
        result.stdout,
        command === "url" ? issue.url : issue.title,
      )
      assertEquals(server.graphqlRequests.length, 1)
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
    const data = JSON.parse(result.stdout)
    assertEquals(data.comments, undefined)
    assertEquals(data.attachments.nodes.length, 51)
    assertEquals(server.graphqlRequests.length, 2)
    assertEquals(
      server.graphqlRequests.some(({ query }) => query.includes("comments(")),
      false,
    )
  } finally {
    await server.stop()
  }
})

for (const field of ["comments", "attachments"] as const) {
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
          queryName: field === "comments"
            ? "GetIssueComments"
            : "GetIssueAttachments",
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
          queryName: field === "comments"
            ? "GetIssueComments"
            : "GetIssueAttachments",
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
        assertEquals(result.code, 1)
        assertEquals(result.stdout, "")
        assertStringIncludes(
          result.stderr,
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
      assertEquals(result.code, 1)
      assertEquals(result.stdout, "")
      assertStringIncludes(
        result.stderr,
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
    assertEquals(result.code, 1)
    assertEquals(result.stdout, "")
    assertStringIncludes(
      result.stderr,
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
      queryName: "AuthStatus",
      response: { data: { viewer: { organization: { urlKey: "jihuanshe" } } } },
    },
    detailResponse({
      ...issue,
      comments: {
        nodes: [{ ...comment("created"), resolvedAt: "2026-09-08T00:00:00Z" }],
        pageInfo: terminalPage,
      },
      attachments: {
        nodes: [attachment("linked"), attachment("uploaded")],
        pageInfo: terminalPage,
      },
    }),
    {
      queryName: "GetIssueId",
      response: { data: { issue: { id: "issue-id" } } },
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
        schemaVersion: 1,
        workspace: "jihuanshe",
        issues: [{
          operation: "update",
          identifier: "TEST-123",
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
      "jihuanshe",
      "--json",
    ], directory)
    assertEquals(result.code, 0, result.stderr)
    assertEquals(
      result.stderr,
      "→ issue 1/1: comment 1\n→ issue 1/1: attachment 1\n→ issue 1/1: attachment 2\n",
    )
    const outcome = JSON.parse(result.stdout)
    assertEquals(outcome.status, "completed")
    assertEquals(outcome.summary.applied, 3)
    assertEquals(outcome.items[1].describe, `link ${signedUrl}`)
    assertEquals(outcome.items[2].describe, `attach ${filePath}`)
    assertEquals(outcome.verification[0].status, "verified")
    assertEquals(
      server.graphqlRequests.filter(({ query }) =>
        query.includes("mutation AddComment")
      ).length,
      1,
    )
  } finally {
    await server.stop()
    await Deno.remove(directory, { recursive: true })
  }
})

Deno.test("issue apply resolves self through the same CLI API credentials on resume", async () => {
  const directory = await Deno.makeTempDir({ prefix: "linear-assignee-alias-" })
  const userId = "abcdef01-2345-4678-9abc-def012345678"
  const server = new MockLinearServer([
    {
      queryName: "AuthStatus",
      response: { data: { viewer: { organization: { urlKey: "jihuanshe" } } } },
    },
    {
      queryName: "GetViewerId",
      response: { data: { viewer: { id: userId } } },
    },
    detailResponse({
      ...issue,
      assignee: { id: userId, name: "Alex", displayName: "alex" },
      comments: empty,
      attachments: empty,
    }),
    {
      queryName: "UpdateIssue",
      variables: { id: "TEST-123", input: { assigneeId: userId } },
      response: {
        data: {
          issueUpdate: {
            success: true,
            issue: {
              id: "issue-id",
              identifier: "TEST-123",
              title: "Read all evidence",
              url: issue.url,
            },
          },
        },
      },
    },
  ])
  await server.start()
  try {
    const path = join(directory, "delivery.json")
    await Deno.writeTextFile(
      path,
      JSON.stringify({
        schemaVersion: 1,
        workspace: "jihuanshe",
        issues: [{
          operation: "update",
          identifier: "TEST-123",
          set: { assignee: "self" },
          base: { assignee: userId },
        }],
      }),
    )
    const args = [
      "issue",
      "apply",
      "--file",
      path,
      "--confirm-workspace",
      "jihuanshe",
      "--json",
    ]
    for (let attempt = 0; attempt < 2; attempt++) {
      const result = await runCli(server, args, directory)
      assertEquals(result.code, 0, result.stderr)
      const outcome = JSON.parse(result.stdout)
      assertEquals(outcome.status, "completed")
      assertEquals(outcome.verification[0].status, "verified")
      if (attempt === 1) assertEquals(outcome.summary.skipped, 1)
    }
    assertEquals(
      server.graphqlRequests.filter((x) =>
        x.query.includes("mutation UpdateIssue")
      ).length,
      1,
    )
    assertEquals(
      server.graphqlRequests.filter((x) =>
        x.query.includes("query GetViewerId")
      ).length,
      3,
    )
  } finally {
    await server.stop()
    await Deno.remove(directory, { recursive: true })
  }
})

import { assertEquals } from "@std/assert"
import { fromFileUrl, join } from "@std/path"
import { MockLinearServer } from "../../utils/mock_linear_server.ts"

const main = fromFileUrl(new URL("../../../src/main.ts", import.meta.url))
const organization = {
  id: "99999999-9999-4999-8999-999999999999",
  urlKey: "jihuanshe",
}
const issueId = "11111111-1111-4111-8111-000000000123"
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
    issue: { id: issueId },
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
    issue: { id: issueId },
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
              issue: { id: issueId },
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
              issue: { id: issueId },
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
      ["fields", "comment", "attachment", "upload", "attachment"].map(
        (kind, index) =>
          `Processing item ${index + 1}: ${issue.identifier} (${kind})`,
      ),
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

import { stripIgnoredCharacters } from "graphql"
import { assertEquals, assertStringIncludes } from "@std/assert"
import { fromFileUrl, join } from "@std/path"
import { MockLinearServer } from "../../utils/mock_linear_server.ts"

const ISSUE = "abcdef01-2345-4678-9abc-def012345678"
const STATE = "abcdef02-2345-4678-9abc-def012345678"
const LABEL = "abcdef03-2345-4678-9abc-def012345678"
const OTHER = "abcdef04-2345-4678-9abc-def012345678"
const empty = { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } }
const detail = {
  id: ISSUE,
  identifier: "NEW-42",
  title: "Issue",
  description: "Body",
  url: "https://linear.app/test/issue/NEW-42",
  archivedAt: null,
  trashed: false,
  state: { id: STATE, name: "Working", type: "started" },
  assignee: null,
  project: null,
  priority: 0,
  labels: { nodes: [{ id: LABEL, name: "Bug" }], pageInfo: empty.pageInfo },
  comments: empty,
  attachments: empty,
  relations: empty,
  inverseRelations: empty,
}
async function run(server: MockLinearServer, dir: string, args: string[]) {
  const result = await new Deno.Command(Deno.execPath(), {
    args: [
      "run",
      "--allow-all",
      "--quiet",
      "--config",
      fromFileUrl(new URL("../../../deno.json", import.meta.url)),
      fromFileUrl(new URL("../../../src/main.ts", import.meta.url)),
      ...args,
    ],
    cwd: dir,
    clearEnv: true,
    env: {
      PATH: Deno.env.get("PATH") ?? "",
      HOME: dir,
      DENO_DIR: Deno.env.get("DENO_DIR") ??
        join(Deno.env.get("HOME") ?? dir, ".cache", "deno"),
      LINEAR_API_KEY: "Bearer test-token",
      LINEAR_GRAPHQL_ENDPOINT: server.getEndpoint(),
      LINEAR_PROMPT_DISABLED: "1",
      LINEAR_ISSUE_CREATE_ASSIGN_SELF: "never",
      NO_COLOR: "1",
    },
    stdout: "piped",
    stderr: "piped",
  }).output()
  return {
    code: result.code,
    stdout: new TextDecoder().decode(result.stdout),
    stderr: new TextDecoder().decode(result.stderr),
  }
}

Deno.test("create and view IDs compose into update, comment and link", async () => {
  const server = new MockLinearServer([
    {
      queryName: "GetTeamIdByKey",
      response: { data: { teams: { nodes: [{ id: "new-team" }] } } },
    },
    {
      queryName: "CreateIssue",
      response: {
        data: {
          issueCreate: {
            success: true,
            issue: {
              id: ISSUE,
              identifier: "NEW-42",
              url: detail.url,
              team: { key: "NEW" },
            },
          },
        },
      },
    },
    {
      queryName: "GetIssueIdentifierById",
      variables: { id: ISSUE },
      response: { data: { issue: { identifier: "NEW-42" } } },
    },
    {
      queryName: "GetIssueDetailsWithComments",
      response: { data: { issue: detail } },
    },
    { queryName: "GetIssueDetails", response: { data: { issue: detail } } },
    {
      queryName: "GetIssueTeam",
      variables: { id: "NEW-42" },
      response: { data: { issue: { team: { id: "new-team", key: "NEW" } } } },
    },
    {
      queryName: "GetWorkflowStates",
      variables: { teamKey: "NEW" },
      response: {
        data: {
          team: {
            states: {
              nodes: [{
                id: STATE,
                name: "Working",
                type: "started",
                position: 1,
              }],
            },
          },
        },
      },
    },
    {
      queryName: "GetIssueLabelIdForTeam",
      variables: { id: LABEL, teamKey: "NEW" },
      response: { data: { issueLabels: { nodes: [{ id: LABEL }] } } },
    },
    {
      queryName: "UpdateIssue",
      variables: { id: "NEW-42", input: { stateId: STATE, labelIds: [LABEL] } },
      response: { data: { issueUpdate: { success: true, issue: detail } } },
    },
    {
      queryName: "AddComment",
      response: {
        data: {
          commentCreate: {
            success: true,
            comment: { id: OTHER, body: "Proof", url: detail.url },
          },
        },
      },
    },
    {
      queryName: "GetIssueId",
      variables: { id: "NEW-42" },
      response: { data: { issue: { id: ISSUE } } },
    },
    {
      queryName: "AttachmentLinkURL",
      variables: { issueId: ISSUE },
      response: {
        data: {
          attachmentLinkURL: {
            success: true,
            attachment: {
              id: OTHER,
              title: "Proof",
              url: "https://example.com/proof",
            },
          },
        },
      },
    },
  ])
  await server.start()
  const dir = await Deno.makeTempDir()
  try {
    const created = await run(server, dir, [
      "issue",
      "create",
      "--team",
      "NEW",
      "--title",
      "Issue",
      "--json",
    ])
    assertEquals(created.code, 0, created.stderr)
    const id = JSON.parse(created.stdout).issue.id
    const viewed = await run(server, dir, [
      "issue",
      "view",
      id.toUpperCase(),
      "--json",
    ])
    assertEquals(viewed.code, 0, viewed.stderr)
    const viewQuery = stripIgnoredCharacters(
      server.graphqlRequests.find((r) =>
        r.query.includes("GetIssueDetailsWithComments")
      )!.query,
    )
    assertStringIncludes(viewQuery, "issue(id:$id){id identifier")
    assertStringIncludes(viewQuery, "state{id name")
    const data = JSON.parse(viewed.stdout)
    assertEquals(data.id, id)
    const updated = await run(server, dir, [
      "issue",
      "update",
      data.id,
      "--state",
      data.state.id,
      "--label",
      data.labels.nodes[0].id,
      "--json",
    ])
    assertEquals(updated.code, 0, updated.stderr)
    const labelQuery = stripIgnoredCharacters(
      server.graphqlRequests.find((r) =>
        r.query.includes("GetIssueLabelIdForTeam")
      )!.query,
    )
    assertStringIncludes(labelQuery, "id:{eq:$id}")
    assertStringIncludes(labelQuery, "team:{key:{eq:$teamKey}}")
    assertStringIncludes(labelQuery, "team:{null:true}")
    const commented = await run(server, dir, [
      "issue",
      "comment",
      "add",
      id,
      "--body",
      "Proof",
      "--json",
    ])
    assertEquals(commented.code, 0, commented.stderr)
    const linked = await run(server, dir, [
      "issue",
      "link",
      id,
      "https://example.com/proof",
      "--json",
    ])
    assertEquals(linked.code, 0, linked.stderr)
    assertEquals(
      server.graphqlRequests.filter((r) =>
        r.query.includes("GetIssueIdentifierById")
      ).length,
      4,
    )
    assertEquals(
      server.graphqlRequests.filter((r) => r.query.includes("mutation "))
        .length,
      4,
    )
  } finally {
    await server.stop()
    await Deno.remove(dir, { recursive: true })
  }
})

for (const kind of ["state", "label"] as const) {
  Deno.test(`an unavailable ${kind} UUID never falls back to a matching name`, async () => {
    const server = new MockLinearServer([
      {
        queryName: "GetIssueTeam",
        response: { data: { issue: { team: { id: "new-team", key: "NEW" } } } },
      },
      {
        queryName: "GetWorkflowStates",
        response: {
          data: {
            team: {
              states: {
                nodes: [{
                  id: OTHER,
                  name: STATE,
                  type: "started",
                  position: 1,
                }],
              },
            },
          },
        },
      },
      {
        queryName: "GetIssueLabelIdForTeam",
        variables: { id: LABEL, teamKey: "NEW" },
        response: { data: { issueLabels: { nodes: [] } } },
      },
    ])
    await server.start()
    const dir = await Deno.makeTempDir()
    try {
      const result = await run(server, dir, [
        "issue",
        "update",
        "OLD-1",
        `--${kind}`,
        kind === "state" ? STATE : LABEL,
        "--json",
      ])
      assertEquals(result.code, 1)
      assertEquals(
        server.graphqlRequests.some((r) => r.query.includes("mutation ")),
        false,
      )
      assertEquals(
        server.graphqlRequests.some((r) =>
          r.query.includes("GetIssueLabelIdByNameForTeam")
        ),
        false,
      )
      assertStringIncludes(result.stderr, "not found")
    } finally {
      await server.stop()
      await Deno.remove(dir, { recursive: true })
    }
  })
}

Deno.test("old issue numbers resolve state and labels in the current team", async () => {
  const server = new MockLinearServer([
    {
      queryName: "GetIssueTeam",
      variables: { id: "OLD-1" },
      response: { data: { issue: { team: { id: "new-team", key: "NEW" } } } },
    },
    {
      queryName: "GetWorkflowStates",
      variables: { teamKey: "NEW" },
      response: {
        data: {
          team: {
            states: {
              nodes: [{
                id: STATE,
                name: "Working",
                type: "started",
                position: 1,
              }],
            },
          },
        },
      },
    },
    {
      queryName: "GetIssueLabelIdByNameForTeam",
      variables: { name: "Bug", teamKey: "NEW" },
      response: {
        data: { issueLabels: { nodes: [{ id: LABEL, name: "Bug" }] } },
      },
    },
    {
      queryName: "UpdateIssue",
      variables: { id: "OLD-1", input: { stateId: STATE, labelIds: [LABEL] } },
      response: { data: { issueUpdate: { success: true, issue: detail } } },
    },
  ])
  await server.start()
  const dir = await Deno.makeTempDir()
  try {
    const result = await run(server, dir, [
      "issue",
      "update",
      "OLD-1",
      "--state",
      "Working",
      "--label",
      "Bug",
      "--json",
    ])
    assertEquals(result.code, 0, result.stderr)
    assertEquals(
      server.graphqlRequests.some((r) => r.variables.teamKey === "OLD"),
      false,
    )
  } finally {
    await server.stop()
    await Deno.remove(dir, { recursive: true })
  }
})

for (const input of [ISSUE, "OLD-1"]) {
  Deno.test(`start uses the current issue team without a default team: ${input}`, async () => {
    const server = new MockLinearServer([
      {
        queryName: "GetIssueIdentifierById",
        variables: { id: ISSUE },
        response: { data: { issue: { identifier: "NEW-42" } } },
      },
      {
        queryName: "GetIssueDetails",
        response: {
          data: { issue: { ...detail, branchName: "new-42-native" } },
        },
      },
      {
        queryName: "GetWorkflowStates",
        variables: { teamKey: "NEW" },
        response: {
          data: {
            team: {
              states: {
                nodes: [{
                  id: STATE,
                  name: "Working",
                  type: "started",
                  position: 1,
                }],
              },
            },
          },
        },
      },
      {
        queryName: "UpdateIssueState",
        variables: {
          issueId: input === ISSUE ? "NEW-42" : "OLD-1",
          stateId: STATE,
        },
        response: { data: { issueUpdate: { success: true } } },
      },
    ])
    await server.start()
    const dir = await Deno.makeTempDir()
    try {
      for (
        const args of [
          ["init", "-b", "main"],
          ["config", "user.name", "Linear Test"],
          ["config", "user.email", "test@example.com"],
          [
            "-c",
            "commit.gpgsign=false",
            "commit",
            "--allow-empty",
            "-m",
            "initial",
          ],
        ]
      ) {
        const r = await new Deno.Command("git", {
          args,
          cwd: dir,
          stdout: "null",
          stderr: "piped",
        }).output()
        assertEquals(r.success, true)
      }
      const result = await run(server, dir, ["issue", "start", input])
      assertEquals(result.code, 0, result.stderr)
      const branch = await new Deno.Command("git", {
        args: ["branch", "--show-current"],
        cwd: dir,
        stdout: "piped",
      }).output()
      assertEquals(
        new TextDecoder().decode(branch.stdout).trim(),
        "new-42-native",
      )
      assertEquals(
        server.graphqlRequests.some((r) => r.variables.teamKey === "NEW"),
        true,
      )
    } finally {
      await server.stop()
      await Deno.remove(dir, { recursive: true })
    }
  })
}

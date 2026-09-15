import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert"
import { join } from "@std/path"
import {
  issueWriteBasis,
  issueWriteId,
} from "../../utils/issue-write-fixtures.ts"
import {
  commonDenoArgs,
  setupMockLinearServer,
} from "../../utils/test-helpers.ts"

const markdown =
  "第一段  \n软换行\n\n第二段\n\n- 项目\n  - 子项目\n\n```js\nconst literal = '\\n'\n```\n\n@name https://linear.app/test/profiles/person\n"
async function run(args: string[]) {
  const result = await new Deno.Command(Deno.execPath(), {
    args: ["run", ...commonDenoArgs, "src/main.ts", "issue", ...args, "--json"],
    stdin: "null",
    stdout: "piped",
    stderr: "piped",
  }).output()
  assertEquals(new TextDecoder().decode(result.stderr), "")
  return {
    code: result.code,
    output: JSON.parse(new TextDecoder().decode(result.stdout)),
  }
}

function exportSnapshot() {
  const basis = issueWriteBasis("ENG-123", { id: "team-1", key: "ENG" })
  return {
    ...basis,
    issue: {
      ...basis.issue,
      comments: {
        nodes: [{
          id: "comment-1",
          body: "Keep this decision",
          resolvedAt: null,
          quotedText: "Original passage",
          documentContentId: "content-1",
        }],
        pageInfo: { hasNextPage: false, endCursor: null as string | null },
      },
      attachments: {
        nodes: [{
          id: "attachment-1",
          title: "Evidence",
          url: "https://example.test/evidence",
        }],
        pageInfo: { hasNextPage: false, endCursor: null as string | null },
      },
    },
  }
}

for (
  const scenario of [
    "unchanged",
    "edit",
    "conflict",
    "existing-directory",
    "missing-description",
    "empty-description",
    "issue-url",
    "changed-discussion",
  ]
) {
  Deno.test(`issue export and guarded update: ${scenario}`, async () => {
    const directory = await Deno.makeTempDir()
    const output = join(directory, "edit space ' $draft")
    const current = exportSnapshot()
    current.issue.description = scenario === "empty-description" ? "" : markdown
    const original = structuredClone(current)
    const { server, cleanup } = await setupMockLinearServer([
      {
        queryName: "GetIssueReferenceWorkspace",
        response: { data: { organization: current.organization } },
      },
      {
        queryName: "GetIssueDetailsWithComments",
        response: () => ({
          data: scenario === "missing-description"
            ? {
              ...current,
              issue: { ...current.issue, description: undefined },
            }
            : current,
        }),
      },
      {
        queryName: "GetIssueForWrite",
        response: () => ({ data: current }),
      },
      {
        queryName: "UpdateIssue",
        response: ({ variables }) => {
          current.issue.description =
            (variables.input as { description: string }).description
          return {
            data: { issueUpdate: { success: true, issue: current.issue } },
          }
        },
      },
    ])
    try {
      if (scenario === "existing-directory") {
        await Deno.mkdir(output)
        await Deno.writeTextFile(join(output, "original.json"), "keep")
      }
      const exported = await run([
        "export",
        scenario === "issue-url"
          ? "https://linear.app/test-team/issue/ENG-123/a-title"
          : "ENG-123",
        "--output",
        output,
      ])
      if (
        scenario === "existing-directory" || scenario === "missing-description"
      ) {
        assertEquals(exported.code, 1)
        assertEquals(exported.output.effect, "none")
        if (scenario === "existing-directory") {
          assertEquals(
            await Deno.readTextFile(join(output, "original.json")),
            "keep",
          )
          assertEquals(server.graphqlRequests.length, 1)
        }
        return
      }
      assertEquals(exported.code, 0)
      assertEquals(
        server.graphqlRequests.find((request) =>
          request.query.includes("GetIssueDetailsWithComments")
        )!.variables.id,
        "ENG-123",
      )
      assertEquals(exported.output.issue.id, issueWriteId)
      const baseFile = exported.output.baseFile
      const descriptionFile = exported.output.descriptionFile
      assertEquals(JSON.parse(await Deno.readTextFile(baseFile)), original)
      assertEquals(
        await Deno.readTextFile(descriptionFile),
        original.issue.description,
      )
      assertEquals(
        server.graphqlRequests.length,
        scenario === "issue-url" ? 2 : 1,
      )
      const desired =
        ["edit", "conflict", "changed-discussion"].includes(scenario)
          ? markdown + "\n当前结论。\n"
          : current.issue.description!
      await Deno.writeTextFile(descriptionFile, desired)
      if (scenario === "conflict") current.issue.description = "同事的修改"
      if (scenario === "changed-discussion") {
        current.issue.comments.nodes[0].body = "New reply"
      }
      const updated = await run([
        "update",
        issueWriteId,
        "--base-file",
        baseFile,
        "--description-file",
        descriptionFile,
      ])
      const writes = server.graphqlRequests.filter((request) =>
        request.query.includes("mutation ")
      )
      assertEquals(JSON.parse(await Deno.readTextFile(baseFile)), original)
      if (scenario === "conflict") {
        assertEquals(updated.code, 1)
        assertEquals(updated.output.effect, "none")
        assertStringIncludes(
          updated.output.error.message,
          "Original values changed: description",
        )
        assertEquals(writes.length, 0)
      } else {
        assertEquals(updated.code, 0)
        assertEquals(
          updated.output.effect,
          ["edit", "changed-discussion"].includes(scenario)
            ? "applied"
            : "none",
        )
        assertEquals(
          writes.length,
          ["edit", "changed-discussion"].includes(scenario) ? 1 : 0,
        )
        if (["edit", "changed-discussion"].includes(scenario)) {
          assertEquals(writes[0].variables.input, { description: desired })
        }
      }
    } finally {
      await cleanup()
      await Deno.remove(directory, { recursive: true })
    }
  })
}

Deno.test("issue export can retry the same directory after a failed read", async () => {
  const directory = await Deno.makeTempDir()
  const output = join(directory, "draft")
  const current = exportSnapshot()
  let reads = 0
  const { cleanup } = await setupMockLinearServer([{
    queryName: "GetIssueDetailsWithComments",
    response: () =>
      ++reads === 1
        ? { errors: [{ message: "temporarily unavailable" }] }
        : { data: current },
  }])
  try {
    const failed = await run(["export", "ENG-123", "--output", output])
    assertEquals(failed.code, 1)
    assertEquals(failed.output.effect, "none")
    const retried = await run(["export", "ENG-123", "--output", output])
    assertEquals(retried.code, 0)
    assertEquals(
      await Deno.readTextFile(retried.output.descriptionFile),
      current.issue.description,
    )
    assertEquals(
      JSON.parse(await Deno.readTextFile(retried.output.baseFile)),
      current,
    )
  } finally {
    await cleanup()
    await Deno.remove(directory, { recursive: true })
  }
})

for (const failure of [null, "comments", "attachments"] as const) {
  Deno.test(`issue export completes discussion and evidence pages: ${failure ?? "success"}`, async () => {
    const directory = await Deno.makeTempDir()
    const output = join(directory, "draft")
    const current = exportSnapshot()
    for (const field of ["comments", "attachments"] as const) {
      current.issue[field].pageInfo = {
        hasNextPage: true,
        endCursor: `${field}-next`,
      }
    }
    const lateComment = {
      id: "comment-2",
      body: "Later decision",
      resolvedAt: "2026-09-14T00:00:00Z",
      quotedText: "Later passage",
      documentContentId: "content-1",
    }
    const lateAttachment = {
      id: "attachment-2",
      title: "Later evidence",
      url: "https://example.test/later",
    }
    const { cleanup } = await setupMockLinearServer([
      { queryName: "GetIssueDetailsWithComments", response: { data: current } },
      ...(["comments", "attachments"] as const).map((field) => ({
        queryName: field === "comments"
          ? "GetIssueComments"
          : "GetIssueAttachments",
        variables: { after: `${field}-next`, first: 100 },
        response: failure === field
          ? { errors: [{ message: "Later page failed" }] }
          : {
            data: {
              issue: {
                [field]: {
                  nodes: [field === "comments" ? lateComment : lateAttachment],
                  pageInfo: { hasNextPage: false, endCursor: null },
                },
              },
            },
          },
      })),
    ])
    try {
      const result = await run(["export", "ENG-123", "--output", output])
      if (failure) {
        assertEquals(result.code, 1)
        assertEquals(result.output.effect, "none")
        await assertRejects(() => Deno.stat(output), Deno.errors.NotFound)
      } else {
        assertEquals(result.code, 0)
        const saved =
          JSON.parse(await Deno.readTextFile(result.output.baseFile)).issue
        assertEquals(saved.comments.nodes, [
          ...current.issue.comments.nodes,
          lateComment,
        ])
        assertEquals(saved.attachments.nodes, [
          ...current.issue.attachments.nodes,
          lateAttachment,
        ])
        assertEquals(saved.comments.pageInfo.hasNextPage, false)
        assertEquals(saved.attachments.pageInfo.hasNextPage, false)
      }
    } finally {
      await cleanup()
      await Deno.remove(directory, { recursive: true })
    }
  })
}

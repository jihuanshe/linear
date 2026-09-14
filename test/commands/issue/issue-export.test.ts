import { assertEquals, assertStringIncludes } from "@std/assert"
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

for (
  const scenario of [
    "unchanged",
    "edit",
    "conflict",
    "existing-directory",
    "missing-description",
    "empty-description",
    "issue-url",
  ]
) {
  Deno.test(`issue export and guarded update: ${scenario}`, async () => {
    const directory = await Deno.makeTempDir()
    const output = join(directory, "edit space ' $draft")
    const current = issueWriteBasis("ENG-123", { id: "team-1", key: "ENG" })
    current.issue.description = scenario === "empty-description" ? "" : markdown
    const original = structuredClone(current)
    const { server, cleanup } = await setupMockLinearServer([
      {
        queryName: "GetIssueReferenceWorkspace",
        response: { data: { organization: current.organization } },
      },
      {
        queryName: "GetIssueForWrite",
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
          request.query.includes("GetIssueForWrite")
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
      const desired = scenario === "edit" || scenario === "conflict"
        ? markdown + "\n当前结论。\n"
        : current.issue.description!
      await Deno.writeTextFile(descriptionFile, desired)
      if (scenario === "conflict") current.issue.description = "同事的修改"
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
          scenario === "edit" ? "applied" : "none",
        )
        assertEquals(writes.length, scenario === "edit" ? 1 : 0)
        if (scenario === "edit") {
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
  const current = issueWriteBasis("ENG-123", { id: "team-1", key: "ENG" })
  let reads = 0
  const { cleanup } = await setupMockLinearServer([{
    queryName: "GetIssueForWrite",
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

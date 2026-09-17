import { assertEquals, assertStringIncludes } from "@std/assert"
import { stub } from "@std/testing/mock"
import { cli } from "../../src/cli.ts"
import {
  getWorkspaceUrl,
  openIssuePage,
  openProjectPage,
  openTeamAssigneeView,
} from "../../src/utils/actions.ts"
import { withGraphQLContext } from "../../src/utils/graphql.ts"

Deno.test("browser actions use authenticated organization and canonical resource URLs", async () => {
  const names = ["LINEAR_API_KEY", "LINEAR_WORKSPACE", "LINEAR_TEAM_KEY"]
  Deno.env.set("LINEAR_API_KEY", "synthetic-selected-key")
  Deno.env.set("LINEAR_WORKSPACE", "wrong-config-workspace")
  Deno.env.set("LINEAR_TEAM_KEY", "ABC")
  const opened: string[][] = []
  const Command = Deno.Command
  using _commands = stub(
    Deno,
    "Command",
    function (...args: unknown[]) {
      const [command, options] = args as ConstructorParameters<typeof Command>
      const browser = ["open", "xdg-open", "cmd"].includes(String(command))
      if (browser) opened.push(options?.args ?? [])
      return new class extends Command {
        override output(): Promise<Deno.CommandOutput> {
          if (!browser) return super.output()
          return Promise.resolve({
            success: true,
            code: 0,
            signal: null,
            stdout: new Uint8Array(),
            stderr: new Uint8Array(),
          })
        }
      }(command, options)
    },
  )
  const requests: Array<
    { name: string; variables: unknown; authorization: string | null }
  > = []
  using _fetch = stub(globalThis, "fetch", (_input, init) => {
    const request = JSON.parse(String(init?.body))
    requests.push({
      name: request.operationName,
      variables: request.variables,
      authorization: new Headers(init?.headers).get("authorization"),
    })
    const data = request.operationName === "BrowserIssue"
      ? {
        issue: { url: "https://linear.app/actual/issue/ABC-9/canonical-title" },
      }
      : request.operationName === "BrowserProject"
      ? {
        project: {
          url: "https://linear.app/actual/project/canonical-project/overview",
        },
      }
      : { organization: { urlKey: "actual" } }
    return Promise.resolve(Response.json({ data }))
  })
  using _log = stub(console, "log", () => {})
  try {
    await withGraphQLContext(async () => {
      assertEquals(await getWorkspaceUrl(), "https://linear.app/actual")
      await openIssuePage("ABC-9")
      await openProjectPage("project-uuid")
      await openTeamAssigneeView()
      for (const resource of ["team", "project", "initiative"]) {
        await cli.parse([resource, "list", "--web"])
      }
    })
    assertEquals(
      requests.map((request) => request.authorization),
      Array(7).fill("synthetic-selected-key"),
    )
    assertEquals(requests[1].variables, { id: "ABC-9" })
    assertEquals(requests[2].variables, { id: "project-uuid" })
    assertStringIncludes(
      opened[0].join(" "),
      "https://linear.app/actual/issue/ABC-9/canonical-title",
    )
    assertStringIncludes(
      opened[1].join(" "),
      "https://linear.app/actual/project/canonical-project/overview",
    )
    assertStringIncludes(
      opened[2].join(" "),
      "https://linear.app/actual/team/ABC/active?filter=",
    )
    for (
      const [index, suffix] of [
        "settings/teams",
        "team/ABC/projects/all",
        "initiatives",
      ].entries()
    ) {
      assertStringIncludes(
        opened[index + 3].join(" "),
        `https://linear.app/actual/${suffix}`,
      )
    }
    assertEquals(
      opened.flat().some((arg) => arg.includes("wrong-config-workspace")),
      false,
    )
  } finally {
    for (const name of names) Deno.env.delete(name)
  }
})

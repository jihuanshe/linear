import { assertEquals, assertStringIncludes } from "@std/assert"
import { stripAnsiCode } from "@std/fmt/colors"
import { stub } from "@std/testing/mock"
import { cli } from "../../src/cli.ts"
import { setupMockLinearServer } from "../utils/test-helpers.ts"

const id = "abcdef01-2345-4678-9abc-def012345678"
const connection = {
  nodes: [],
  pageInfo: { hasNextPage: false, endCursor: null },
}

for (const resource of ["project", "document"]) {
  for (const lifecycle of ["active", "archived", "deleted"]) {
    for (const mode of ["json", "terminal", "pipe"]) {
      Deno.test(`${resource} view ${mode} distinguishes ${lifecycle} without changing body output`, async () => {
        const archivedAt = lifecycle === "active"
          ? null
          : "2026-09-17T00:00:00Z"
        // The nullable upstream flag is not inferred from archivedAt or coerced.
        const trashed = lifecycle === "active" ? null : lifecycle === "deleted"
        const { server, cleanup } = await setupMockLinearServer([{
          queryName: resource === "project"
            ? "GetProjectDetails"
            : mode === "json"
            ? "GetDocumentWithComments"
            : "GetDocument",
          response: {
            data: {
              organization: { id: "workspace", urlKey: "test" },
              [resource]: {
                id,
                name: "Lifecycle record",
                title: "Lifecycle record",
                slugId: "lifecycle-record",
                url: `https://linear.app/test/${resource}/lifecycle-record`,
                content: "Saved body",
                archivedAt,
                trashed,
                createdAt: "2026-01-01T00:00:00Z",
                updatedAt: "2026-09-17T00:00:00Z",
                status: { id: "planned", name: "Planned", color: "#123456" },
                teams: connection,
                labels: connection,
                issues: connection,
                comments: connection,
              },
            },
          },
        }])
        const output: string[] = []
        const stubs = [
          stub(console, "log", (...values: unknown[]) => {
            output.push(values.join(" "))
          }),
          stub(Deno.stdout, "isTerminal", () => mode === "terminal"),
          stub(Deno.stderr, "isTerminal", () => false),
          stub(Deno, "consoleSize", () => ({ columns: 100, rows: 40 })),
        ]
        try {
          await cli.parse([
            resource,
            "view",
            id,
            ...(mode === "json" ? ["--json"] : []),
          ])
          assertEquals(server.graphqlRequests.length, 1)
          assertStringIncludes(server.graphqlRequests[0].query, "trashed")
          const text = stripAnsiCode(output.join("\n"))
          if (mode === "json") {
            const result = JSON.parse(text)[resource]
            assertEquals(result.trashed, trashed)
            assertEquals(result.archivedAt, archivedAt)
          } else if (resource === "document" && mode === "pipe") {
            assertEquals(text, "Saved body")
          } else {
            assertStringIncludes(text, "Saved body")
            assertEquals(
              text.includes("Deleted (in trash)"),
              lifecycle === "deleted",
            )
            assertEquals(text.includes("Archived"), lifecycle === "archived")
          }
        } finally {
          for (const item of stubs.reverse()) item.restore()
          await cleanup()
        }
      })
    }
  }
}

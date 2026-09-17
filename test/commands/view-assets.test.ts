import { assertEquals, assertStringIncludes } from "@std/assert"
import { stub } from "@std/testing/mock"
import { cli } from "../../src/cli.ts"
import { connection, issue, WORKSPACE } from "../delivery/fixture.ts"
import { setupMockLinearServer } from "../utils/test-helpers.ts"

const image = "https://uploads.linear.app/private/diagram.png"
const attachment = "https://public.linear.app/public/report.txt"
const content = `![Figure](${image})\n\n[report.txt](${attachment})`

for (const resource of ["issue", "document"]) {
  for (const mode of ["pipe", "terminal", "json"]) {
    Deno.test(`${resource} view ${mode} reads text and leaves assets at their original URLs`, async () => {
      const { server, cleanup } = await setupMockLinearServer([{
        queryName: resource === "issue"
          ? "GetIssueDetailsWithComments"
          : mode === "json"
          ? "GetDocumentWithComments"
          : "GetDocument",
        response: {
          data: {
            organization: WORKSPACE,
            ...(resource === "issue"
              ? {
                issue: {
                  ...issue(1001, { description: content }),
                  children: connection(),
                  documents: connection(),
                  relations: connection(),
                  inverseRelations: connection(),
                  comments: connection(),
                  attachments: connection([{
                    id: "attachment-1",
                    title: "report.txt",
                    url: attachment,
                    sourceType: null,
                    createdAt: "2026-01-01T00:00:00Z",
                    updatedAt: "2026-01-01T00:00:00Z",
                    metadata: {},
                  }]),
                },
              }
              : {
                document: {
                  id: "document-1",
                  title: "Evidence",
                  content,
                  url: "https://linear.app/testing/document/evidence",
                  createdAt: "2026-01-01T00:00:00Z",
                  updatedAt: "2026-01-02T00:00:00Z",
                  creator: { name: "Author" },
                  comments: connection(),
                },
              }),
          },
        },
      }])
      const output: string[] = []
      const fetch = globalThis.fetch
      const requests: string[] = []
      const fetchStub = stub(globalThis, "fetch", (input, init) => {
        const url = input instanceof Request ? input.url : String(input)
        requests.push(url)
        if (url !== server.getEndpoint()) {
          return Promise.reject(new Error(`Unexpected asset request: ${url}`))
        }
        return fetch(input, init)
      })
      const writes: string[] = []
      const stubs = [
        stub(console, "log", (...values: unknown[]) => {
          output.push(values.join(" "))
        }),
        stub(Deno.stdout, "isTerminal", () => mode === "terminal"),
        stub(Deno.stderr, "isTerminal", () => false),
        stub(Deno, "consoleSize", () => ({ columns: 100, rows: 40 })),
        stub(Deno, "mkdir", () => {
          writes.push("mkdir")
          return Promise.resolve()
        }),
        stub(Deno, "writeFile", () => {
          writes.push("writeFile")
          return Promise.resolve()
        }),
        stub(Deno, "writeTextFile", () => {
          writes.push("writeTextFile")
          return Promise.resolve()
        }),
      ]
      try {
        await cli.parse([
          resource,
          "view",
          resource === "issue" ? "ENG-1001" : "document-1",
          ...(resource === "issue" ? ["--no-pager"] : []),
          ...(mode === "json" ? ["--json"] : []),
        ])
        assertEquals(requests, [server.getEndpoint()])
        assertEquals(writes, [])
        const text = output.join("\n")
        if (mode === "json") {
          const result = JSON.parse(text)[resource]
          assertEquals(
            result[resource === "issue" ? "description" : "content"],
            content,
          )
        } else {
          assertStringIncludes(text, "Figure")
          assertStringIncludes(text, "report.txt")
        }
        if (mode !== "terminal") {
          assertStringIncludes(text, image)
          assertStringIncludes(text, attachment)
        }
      } finally {
        for (const item of stubs.reverse()) item.restore()
        fetchStub.restore()
        await cleanup()
      }
    })
  }
}

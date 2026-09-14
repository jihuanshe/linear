import { assertEquals } from "@std/assert"
import { buildSchema, parse, validate } from "graphql"
import { guideSources } from "../../../src/guides/content.ts"
import {
  commonDenoArgs,
  setupMockLinearServer,
} from "../../utils/test-helpers.ts"

Deno.test("guide context exports select full descriptions and content through the real paginator", async () => {
  const source = guideSources.automation
  const queries = [
    ...source.matchAll(/linear api '(query Context[^']+)' --paginate/g),
  ].map((match) => match[1])
  assertEquals(queries.length, 2)
  const schema = buildSchema(await Deno.readTextFile("graphql/schema.graphql"))
  for (const query of queries) {
    assertEquals(
      validate(schema, parse(query)).map((error) => error.message),
      [],
    )
    const projects = query.includes("ContextProjects")
    const key = projects ? "projects" : "initiatives"
    const nodes = [1, 2].map((n) => ({
      id: `${key}-${n}`,
      name: `name ${n}`,
      url: `https://linear.app/test/${key}/${n}`,
      description: `description ${n}`.repeat(100),
      content: `# Body ${n}\n\n\n- Content\n`.repeat(100),
    }))
    const organization = { id: "workspace", urlKey: "test" }
    const { server, cleanup } = await setupMockLinearServer([{
      queryName: projects ? "ContextProjects" : "ContextInitiatives",
      response: ({ variables }) => ({
        data: {
          organization,
          [key]: {
            nodes: [nodes[variables.after == null ? 0 : 1]],
            pageInfo: variables.after == null
              ? { hasNextPage: true, endCursor: "next" }
              : { hasNextPage: false, endCursor: null },
          },
        },
      }),
    }])
    try {
      const result = await new Deno.Command(Deno.execPath(), {
        args: [
          "run",
          ...commonDenoArgs,
          "src/main.ts",
          "api",
          query,
          "--paginate",
        ],
        stdin: "null",
        stdout: "piped",
        stderr: "piped",
      }).output()
      assertEquals(result.code, 0, new TextDecoder().decode(result.stderr))
      assertEquals(JSON.parse(new TextDecoder().decode(result.stdout)), {
        data: {
          organization,
          [key]: { nodes, pageInfo: { hasNextPage: false, endCursor: null } },
        },
      })
      assertEquals(server.graphqlRequests.length, 2)
    } finally {
      await cleanup()
    }
  }
})

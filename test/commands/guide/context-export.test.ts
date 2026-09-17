import { assertEquals } from "@std/assert"
import { buildSchema, executeSync, parse, validate } from "graphql"
import { guideSources } from "../../../src/guides/content.ts"
import {
  commonDenoArgs,
  setupMockLinearServer,
} from "../../utils/test-helpers.ts"

const emptyConnection = {
  nodes: [],
  pageInfo: { hasNextPage: false, endCursor: null },
}

Deno.test("guide context exports preserve full bodies, resource directories and unfinished inner pages", async () => {
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
      ...(projects
        ? {
          archivedAt: null,
          trashed: null,
          status: n === 1
            ? { name: "In Progress", type: "started" }
            : { name: "Canceled", type: "canceled" },
          lead: n === 1 ? { id: "user-1", name: "Lead" } : null,
          priority: n,
          startDate: null,
          targetDate: "2026-12-31",
          teams: {
            nodes: [{ id: `team-${n}`, key: `T${n}`, name: `Team ${n}` }],
            pageInfo: { hasNextPage: false, endCursor: `team-${n}` },
          },
          labels: emptyConnection,
          initiatives: {
            nodes: [{
              id: "initiative",
              name: "Goal",
              url: "https://example.com/goal",
            }],
            pageInfo: { hasNextPage: false, endCursor: "initiative" },
          },
          documents: n === 1
            ? {
              nodes: [{
                id: "doc-1",
                title: "Routing boundaries",
                url: "https://example.com/document",
                updatedAt: "2026-09-17T00:00:00.000Z",
              }],
              pageInfo: { hasNextPage: true, endCursor: "more-documents" },
            }
            : emptyConnection,
          externalLinks: {
            nodes: [{
              id: "link",
              label: "Design",
              url: "https://example.com/design",
            }],
            pageInfo: { hasNextPage: false, endCursor: "link" },
          },
          attachments: {
            nodes: [{
              id: "attachment",
              title: "Evidence",
              subtitle: null,
              url: "https://example.com/evidence",
            }],
            pageInfo: { hasNextPage: false, endCursor: "attachment" },
          },
        }
        : {}),
    }))
    const organization = { id: "workspace", urlKey: "test" }
    const { server, cleanup } = await setupMockLinearServer([{
      queryName: projects ? "ContextProjects" : "ContextInitiatives",
      // Execute the actual selection: a canned response would pass even if the
      // guide omitted content, state or resources, or fetched document bodies.
      response: ({ query, variables }) => ({
        ...executeSync({
          schema,
          document: parse(query),
          variableValues: variables,
          rootValue: {
            organization,
            [key]: (args: { after?: string; filter?: unknown }) => {
              assertEquals(args.filter, undefined)
              return {
                nodes: [nodes[args.after == null ? 0 : 1]],
                pageInfo: args.after == null
                  ? { hasNextPage: true, endCursor: "next" }
                  : { hasNextPage: false, endCursor: null },
              }
            },
          },
        }),
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
      assertEquals(server.graphqlRequests[1].variables.after, "next")
    } finally {
      await cleanup()
    }
  }
})

Deno.test("guide resumes a project document directory through its own pagination", async () => {
  const query = guideSources.automation.match(
    /linear api '(query ProjectDocuments[^']+)'/,
  )?.[1]
  if (query == null) throw new Error("ProjectDocuments example missing")
  const schema = buildSchema(await Deno.readTextFile("graphql/schema.graphql"))
  assertEquals(validate(schema, parse(query)).map((error) => error.message), [])
  const organization = { id: "workspace", urlKey: "test" }
  const nodes = [1, 2].map((n) => ({
    id: `doc-${n}`,
    title: `Document ${n}`,
    url: `https://example.com/document/${n}`,
    updatedAt: "2026-09-17T00:00:00.000Z",
  }))
  const { server, cleanup } = await setupMockLinearServer([{
    queryName: "ProjectDocuments",
    response: ({ query, variables }) => ({
      ...executeSync({
        schema,
        document: parse(query),
        variableValues: variables,
        rootValue: {
          organization,
          project: ({ id }: { id: string }) => ({
            id,
            documents: ({ after }: { after?: string }) => ({
              nodes: [nodes[after == null ? 0 : 1]],
              pageInfo: after == null
                ? { hasNextPage: true, endCursor: "doc-next" }
                : { hasNextPage: false, endCursor: null },
            }),
          }),
        },
      }),
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
        "--variables-json",
        '{"id":"project-1"}',
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
        project: {
          id: "project-1",
          documents: {
            nodes,
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      },
    })
    assertEquals(server.graphqlRequests.length, 2)
    assertEquals(server.graphqlRequests[1].variables, {
      id: "project-1",
      after: "doc-next",
    })
  } finally {
    await cleanup()
  }
})

import { assertEquals } from "@std/assert"
import { fromFileUrl } from "@std/path"
import { buildSchema, getIntrospectionQuery, graphqlSync } from "graphql"

const main = fromFileUrl(new URL("../../src/main.ts", import.meta.url))
const introspection = graphqlSync({
  schema: buildSchema("type Query { ping: String }"),
  source: getIntrospectionQuery(),
})

Deno.test("schema command selects authenticated and public clients", async () => {
  const authorizations: Array<string | null> = []
  const server = Deno.serve({
    hostname: "127.0.0.1",
    port: 0,
    onListen: () => {},
  }, (request) => {
    authorizations.push(request.headers.get("authorization"))
    return Response.json(introspection)
  })

  if (!("port" in server.addr)) {
    await server.shutdown()
    throw new Error("Expected a TCP test server")
  }

  const endpoint = `http://127.0.0.1:${server.addr.port}/graphql`
  const run = async (args: string[]) => {
    const result = await new Deno.Command(Deno.execPath(), {
      args: [
        "run",
        "--allow-all",
        "--quiet",
        main,
        "schema",
        "--json",
        ...args,
      ],
      stdout: "piped",
      stderr: "piped",
      clearEnv: true,
      env: {
        HOME: Deno.env.get("HOME") ?? "/nonexistent",
        LINEAR_API_KEY: "test-api-key",
        LINEAR_GRAPHQL_ENDPOINT: endpoint,
        NO_COLOR: "1",
      },
    }).output()
    const stderr = new TextDecoder().decode(result.stderr)
    assertEquals(result.code, 0, stderr)
    JSON.parse(new TextDecoder().decode(result.stdout))
  }

  try {
    await run([])
    await run(["--unauthenticated"])
    assertEquals(authorizations, ["test-api-key", null])
  } finally {
    await server.shutdown()
  }
})

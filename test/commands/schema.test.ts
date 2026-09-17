import { assertEquals, assertStringIncludes } from "@std/assert"
import { fromFileUrl } from "@std/path"
import { buildSchema, getIntrospectionQuery, graphqlSync } from "graphql"

const main = fromFileUrl(new URL("../../src/main.ts", import.meta.url))
const introspection = graphqlSync({
  schema: buildSchema("type Query { ping: String }"),
  source: getIntrospectionQuery(),
})

Deno.test("schema command selects authenticated and public clients", async () => {
  const authorizations: Array<string | null> = []
  let fail = false
  const server = Deno.serve({
    hostname: "127.0.0.1",
    port: 0,
    onListen: () => {},
  }, (request) => {
    authorizations.push(request.headers.get("authorization"))
    if (fail) {
      return Response.json(
        { errors: [{ message: "Authentication required" }] },
        {
          status: 401,
        },
      )
    }
    return Response.json(introspection)
  })

  if (!("port" in server.addr)) {
    await server.shutdown()
    throw new Error("Expected a TCP test server")
  }

  const endpoint = `http://127.0.0.1:${server.addr.port}/graphql`
  const run = async (args: string[], code = 0) => {
    const result = await new Deno.Command(Deno.execPath(), {
      args: [
        "run",
        "--allow-all",
        "--quiet",
        main,
        "schema",
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
    assertEquals(result.code, code, stderr)
    assertEquals(stderr, "")
    const stdout = new TextDecoder().decode(result.stdout)
    return stdout
  }

  try {
    assertEquals(JSON.parse(await run(["--json"])), introspection.data)
    assertEquals(
      JSON.parse(await run(["-j", "--unauthenticated"])),
      introspection.data,
    )
    const output = await Deno.makeTempFile()
    try {
      const stdout = await run(["-jo", output])
      assertEquals(stdout, "")
      assertEquals(
        JSON.parse(await Deno.readTextFile(output)),
        introspection.data,
      )
      const sdl = "type Query {\n  ping: String\n}\n"
      assertEquals(await run([]), sdl)
      assertEquals(
        await run(["--output", output]),
        `Schema written to ${output}\n`,
      )
      assertEquals(await Deno.readTextFile(output), sdl)
      fail = true
      const failure = JSON.parse(await run(["--json", "--output", output], 1))
      assertEquals(failure.ok, false)
      assertEquals(failure.effect, "none")
      assertStringIncludes(failure.error.message, "Authentication required")
      assertEquals(await Deno.readTextFile(output), sdl)
      fail = false
      const localFailure = JSON.parse(
        await run(["--json", "--output", `${output}/missing.json`], 1),
      )
      assertEquals(localFailure.ok, false)
      assertEquals(localFailure.effect, "none")
    } finally {
      await Deno.remove(output)
    }
    assertEquals(authorizations, [
      "test-api-key",
      null,
      ...Array(5).fill("test-api-key"),
    ])
  } finally {
    await server.shutdown()
  }
})

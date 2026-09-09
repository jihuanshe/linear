import { assertEquals, assertStringIncludes } from "@std/assert"
import { fromFileUrl, join } from "@std/path"

const main = fromFileUrl(new URL("../../src/main.ts", import.meta.url))
const config = fromFileUrl(new URL("../../deno.json", import.meta.url))
const id = "11111111-1111-4111-8111-111111111111"
const { denoDir } = JSON.parse(new TextDecoder().decode(
  (await new Deno.Command(Deno.execPath(), {
    args: ["info", "--json"],
    stdout: "piped",
  }).output()).stdout,
)) as { denoDir: string }

type Family = "project-update" | "initiative-update"
type Input = "read-error" | "empty" | "markdown"
const markdown = "A sentence, with spaces.\n\n- two  spaces\n"
const readErrorPreload = `
  let reads = 0;
  Object.defineProperty(Deno.stdin, "readable", {
    value: new ReadableStream({
      pull(controller) {
        if (reads++ === 0) {
          controller.enqueue(new TextEncoder().encode("Partial Markdown\\n"));
        } else {
          controller.error(new Error("injected stdin read failure"));
        }
      },
    }),
  });
`

interface RequestBody {
  query: string
  variables: {
    input?: { body?: string; health?: string }
  }
}

async function runCreate(family: Family, input: Input) {
  const root = await Deno.makeTempDir({ prefix: "linear-progress-stdin-" })
  const mutations: RequestBody[] = []
  const entity = family === "project-update"
    ? "projectUpdate"
    : "initiativeUpdate"
  const server = Deno.serve(
    { hostname: "127.0.0.1", port: 0, onListen() {} },
    async (request) => {
      const body = await request.json() as RequestBody
      if (!/^mutation\b/.test(body.query.trim())) {
        return Response.json({
          data: { initiative: { name: "Example", slugId: "example" } },
        })
      }
      mutations.push(body)
      return Response.json({
        data: {
          [`${entity}Create`]: {
            success: true,
            [entity]: { id, ...body.variables.input },
          },
        },
      })
    },
  )
  try {
    const child = new Deno.Command(Deno.execPath(), {
      args: [
        "run",
        "--config",
        config,
        "--cached-only",
        "--allow-read",
        "--allow-env",
        "--allow-net=127.0.0.1",
        "--deny-write",
        "--deny-run",
        "--deny-ffi",
        "--quiet",
        ...(input === "read-error"
          ? [
            "--preload",
            `data:application/javascript,${
              encodeURIComponent(readErrorPreload)
            }`,
          ]
          : []),
        main,
        family,
        "create",
        id,
        "--health",
        "onTrack",
        "--json",
      ],
      cwd: root,
      stdin: input === "markdown" ? "piped" : "null",
      stdout: "piped",
      stderr: "piped",
      clearEnv: true,
      env: {
        XDG_CONFIG_HOME: join(root, "config"),
        APPDATA: join(root, "config"),
        DENO_DIR: denoDir,
        NO_COLOR: "1",
        LINEAR_API_KEY: "test-token",
        LINEAR_GRAPHQL_ENDPOINT: `http://127.0.0.1:${server.addr.port}/graphql`,
      },
    }).spawn()
    if (input === "markdown") {
      const writer = child.stdin.getWriter()
      await writer.write(new TextEncoder().encode(markdown))
      await writer.close()
    }
    const output = await child.output()
    const stdout = new TextDecoder().decode(output.stdout)
    return {
      code: output.code,
      stdout,
      stderr: new TextDecoder().decode(output.stderr),
      mutations,
    }
  } finally {
    await server.shutdown()
    await Deno.remove(root, { recursive: true })
  }
}

for (const family of ["project-update", "initiative-update"] as const) {
  Deno.test(`${family} create refuses partial stdin read errors even with health`, async () => {
    const output = await runCreate(family, "read-error")
    assertEquals(output.code, 1, output.stdout + output.stderr)
    const result = JSON.parse(output.stdout)
    assertEquals(result.ok, false)
    assertEquals(result.effect, "none")
    assertStringIncludes(
      result.error.message,
      "Failed to read update content from stdin",
    )
    assertStringIncludes(result.error.message, "injected stdin read failure")
    assertEquals(output.mutations, [])
  })

  for (const input of ["empty", "markdown"] as const) {
    Deno.test(`${family} create accepts ${input} stdin with health`, async () => {
      const output = await runCreate(family, input)
      assertEquals(output.code, 0, output.stdout + output.stderr)
      const result = JSON.parse(output.stdout)
      assertEquals(result.ok, true)
      assertEquals(result.effect, "applied")
      assertEquals(output.mutations.length, 1)
      assertEquals(output.mutations[0].variables.input, {
        [family === "project-update" ? "projectId" : "initiativeId"]: id,
        ...(input === "markdown" ? { body: markdown } : {}),
        health: "onTrack",
      })
    })
  }
}

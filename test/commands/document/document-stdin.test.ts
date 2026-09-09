import { assertEquals, assertStringIncludes } from "@std/assert"
import { fromFileUrl, join } from "@std/path"

const main = fromFileUrl(new URL("../../../src/main.ts", import.meta.url))
const config = fromFileUrl(new URL("../../../deno.json", import.meta.url))
const id = "11111111-1111-4111-8111-111111111111"
const projectId = "22222222-2222-4222-8222-222222222222"
const markdown =
  "  # Draft 中文🃏\r\n\r\nA sentence, with spaces.\n\n- two  spaces\n"
const { denoDir } = JSON.parse(new TextDecoder().decode(
  (await new Deno.Command(Deno.execPath(), {
    args: ["info", "--json"],
    stdout: "piped",
  }).output()).stdout,
)) as { denoDir: string }

type Input = "slow-first" | "slow-eof" | "read-error" | "markdown" | "empty"

interface RequestBody {
  query: string
  variables: {
    id: string
    input?: Record<string, string>
  }
}

function preload(input: Input): string {
  const stream = ["slow-first", "slow-eof", "read-error"].includes(input)
    ? `
      Object.defineProperty(Deno.stdin, "readable", {
        get() {
          const bytes = new TextEncoder().encode(${JSON.stringify(markdown)});
          let reads = 0;
          return new ReadableStream({
            async pull(controller) {
              if (${JSON.stringify(input)} === "slow-first") {
                await new Promise(resolve => setTimeout(resolve, 300));
                controller.enqueue(bytes);
                controller.close();
              } else if (reads++ === 0) {
                controller.enqueue(bytes.subarray(0, 12));
              } else if (${JSON.stringify(input)} === "read-error") {
                controller.error(new Error("injected stdin read failure"));
              } else {
                await new Promise(resolve => setTimeout(resolve, 300));
                controller.enqueue(bytes.subarray(12));
                controller.close();
              }
            },
          }, { highWaterMark: 0 });
        },
      });
    `
    : ""
  return `
    ${stream}
    const document = {
      id: ${
    JSON.stringify(id)
  }, title: "Original title", content: "Old content",
      icon: null, project: null, archivedAt: null,
      url: "https://example.invalid/document"
    };
    globalThis.fetch = async (_request, init) => {
      const body = JSON.parse(init.body);
      console.error("GRAPHQL_REQUEST " + JSON.stringify(body));
      if (body.query.includes("query ReadDocument")) {
        return Response.json({
          data: {
            organization: { id: "workspace-1", urlKey: "test" },
            document
          }
        });
      }
      if (body.query.includes("mutation UpdateDocument")) {
        const { projectId, ...fields } = body.variables.input;
        return Response.json({
          data: {
            documentUpdate: {
              success: true,
              document: {
                ...document, ...fields,
                ...(projectId ? { project: { id: projectId } } : {})
              }
            }
          }
        });
      }
      throw new Error("Unexpected GraphQL request: " + body.query);
    };
  `
}

async function runUpdate(
  input: Input,
  args: string[] = [],
  fileContent?: string,
) {
  const root = await Deno.makeTempDir({ prefix: "linear-document-stdin-" })
  try {
    if (fileContent != null) {
      const path = join(root, "content.md")
      await Deno.writeTextFile(path, fileContent)
      args = [...args, "--content-file", path]
    }
    const child = new Deno.Command(Deno.execPath(), {
      args: [
        "run",
        "--config",
        config,
        "--cached-only",
        "--allow-read",
        "--allow-env",
        "--deny-net",
        "--deny-write",
        "--deny-run",
        "--deny-ffi",
        "--quiet",
        "--preload",
        `data:application/javascript,${encodeURIComponent(preload(input))}`,
        main,
        "document",
        "update",
        id,
        "--unprotected",
        "--force",
        "--json",
        ...args,
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
        LINEAR_GRAPHQL_ENDPOINT: "https://example.invalid/graphql",
      },
    }).spawn()
    if (input === "markdown") {
      const writer = child.stdin.getWriter()
      await writer.write(new TextEncoder().encode(markdown))
      await writer.close()
    }
    const output = await child.output()
    const stdout = new TextDecoder().decode(output.stdout)
    const stderr = new TextDecoder().decode(output.stderr)
    const requests = stderr.split("\n")
      .filter((line) => line.startsWith("GRAPHQL_REQUEST "))
      .map((line) =>
        JSON.parse(line.slice("GRAPHQL_REQUEST ".length))
      ) as RequestBody[]
    return {
      code: output.code,
      stdout,
      stderr,
      requests,
      mutations: requests.filter((request) =>
        request.query.includes("mutation UpdateDocument")
      ),
    }
  } finally {
    await Deno.remove(root, { recursive: true })
  }
}

for (const input of ["slow-first", "slow-eof", "markdown"] as const) {
  Deno.test(`document update preserves complete ${input} stdin`, async () => {
    const output = await runUpdate(input)
    assertEquals(output.code, 0, output.stdout + output.stderr)
    const result = JSON.parse(output.stdout)
    assertEquals(result.ok, true)
    assertEquals(result.effect, "applied")
    assertEquals(result.data.document.content, markdown)
    assertEquals(output.mutations.map((request) => request.variables), [
      { id, input: { content: markdown } },
    ])
  })
}

Deno.test("document update combines stdin with title, icon, and project", async () => {
  const output = await runUpdate("markdown", [
    "--title",
    "New title",
    "--icon",
    "📝",
    "--project",
    projectId,
  ])
  assertEquals(output.code, 0, output.stdout + output.stderr)
  assertEquals(output.mutations.map((request) => request.variables), [
    {
      id,
      input: { title: "New title", icon: "📝", projectId, content: markdown },
    },
  ])
})

Deno.test("document update refuses partial stdin read errors before any write", async () => {
  const output = await runUpdate("read-error", ["--title", "New title"])
  assertEquals(output.code, 1, output.stdout + output.stderr)
  const result = JSON.parse(output.stdout)
  assertEquals(result.ok, false)
  assertEquals(result.effect, "none")
  assertStringIncludes(
    result.error.message,
    "Failed to read document content from stdin",
  )
  assertStringIncludes(result.error.message, "injected stdin read failure")
  assertEquals(output.requests, [])
})

Deno.test("document update empty stdin preserves content in title-only updates", async () => {
  const output = await runUpdate("empty", ["--title", "New title"])
  assertEquals(output.code, 0, output.stdout + output.stderr)
  assertEquals(output.mutations.map((request) => request.variables), [
    { id, input: { title: "New title" } },
  ])
  assertEquals(JSON.parse(output.stdout).data.document.content, "Old content")
})

Deno.test("document update empty stdin alone does not clear content", async () => {
  const output = await runUpdate("empty")
  assertEquals(output.code, 1, output.stdout + output.stderr)
  const result = JSON.parse(output.stdout)
  assertEquals(result.effect, "none")
  assertStringIncludes(result.error.message, "No update fields provided")
  assertEquals(output.requests, [])
})

Deno.test("document update explicit content takes precedence over stdin", async () => {
  const content = "# Explicit content\n"
  const output = await runUpdate("read-error", ["--content", content])
  assertEquals(output.code, 0, output.stdout + output.stderr)
  assertEquals(output.mutations.map((request) => request.variables), [
    { id, input: { content } },
  ])
})

Deno.test("document update content file takes precedence over stdin", async () => {
  const content = "# Content file\n"
  const output = await runUpdate("read-error", [], content)
  assertEquals(output.code, 0, output.stdout + output.stderr)
  assertEquals(output.mutations.map((request) => request.variables), [
    { id, input: { content } },
  ])
})

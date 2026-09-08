import { assertEquals, assertStringIncludes } from "@std/assert"
import { stub } from "@std/testing/mock"
import { join } from "@std/path"
import { downloadCommand } from "../../src/commands/download.ts"

const assetUrl = "https://uploads.linear.app/workspace/asset"
const abcHash =
  "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"

async function run(
  args: string[],
  transport: typeof fetch,
  existing?: string,
  source = assetUrl,
) {
  const dir = await Deno.makeTempDir()
  const path = join(dir, "asset.bin")
  if (existing != null) await Deno.writeTextFile(path, existing)
  const previousKey = Deno.env.get("LINEAR_API_KEY")
  Deno.env.set("LINEAR_API_KEY", "download-test-secret")
  const logs: string[] = []
  const errors: string[] = []
  const exit = new Error("test exit")
  let code = 0
  using _fetch = stub(globalThis, "fetch", transport)
  using _log = stub(
    console,
    "log",
    (...values: unknown[]) => logs.push(values.join(" ")),
  )
  using _error = stub(
    console,
    "error",
    (...values: unknown[]) => errors.push(values.join(" ")),
  )
  using _exit = stub(Deno, "exit", (value?: number): never => {
    code = value ?? 0
    throw exit
  })
  try {
    try {
      await downloadCommand.parse([
        source,
        "--output",
        path,
        "--json",
        ...args,
      ])
    } catch (error) {
      if (error !== exit) throw error
    }
    const files = []
    for await (const entry of Deno.readDir(dir)) files.push(entry.name)
    const content = files.includes("asset.bin")
      ? await Deno.readTextFile(path)
      : null
    return {
      code,
      stdout: logs.join(""),
      stderr: errors.join("\n"),
      files,
      content,
      path,
    }
  } finally {
    if (previousKey == null) Deno.env.delete("LINEAR_API_KEY")
    else Deno.env.set("LINEAR_API_KEY", previousKey)
    await Deno.remove(dir, { recursive: true })
  }
}

Deno.test("download CLI verifies bytes and strips credentials on storage redirects", async () => {
  let requests = 0
  const result = await run(
    ["--sha256", abcHash.toUpperCase()],
    (input, init) => {
      requests++
      assertEquals(init?.redirect, "manual")
      if (requests === 1) {
        assertEquals(String(input), assetUrl)
        assertEquals(
          new Headers(init?.headers).get("authorization"),
          "download-test-secret",
        )
        return Promise.resolve(
          new Response(null, {
            status: 302,
            headers: {
              location: "https://storage.example/asset?signature=private",
            },
          }),
        )
      }
      assertEquals(
        String(input),
        "https://storage.example/asset?signature=private",
      )
      assertEquals(new Headers(init?.headers).has("authorization"), false)
      return Promise.resolve(new Response("abc"))
    },
  )
  assertEquals(requests, 2)
  assertEquals(result.code, 0)
  assertEquals(result.stderr, "")
  assertEquals(result.content, "abc")
  assertEquals(result.files, ["asset.bin"])
  assertEquals(JSON.parse(result.stdout), {
    assetUrl,
    path: result.path,
    size: 3,
    sha256: abcHash,
  })
})

Deno.test("download CLI mismatch fails without publishing a file", async () => {
  const result = await run(
    ["--sha256", "0".repeat(64)],
    () => Promise.resolve(new Response("abc")),
  )
  assertEquals(result.code, 1)
  assertEquals(result.stdout, "")
  assertStringIncludes(result.stderr, "SHA-256 mismatch")
  assertEquals(result.files, [])
})

Deno.test("download CLI refuses existing files before network access", async () => {
  const result = await run([], () => {
    throw new Error("unexpected fetch")
  }, "original")
  assertEquals(result.code, 1)
  assertEquals(result.stdout, "")
  assertEquals(result.content, "original")
  assertStringIncludes(result.stderr, "Output already exists")
})

Deno.test("download CLI handles HTTP failure and interrupted bodies without partial output", async () => {
  for (
    const response of [
      new Response("denied", { status: 403 }),
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("partial"))
          },
          pull(controller) {
            controller.error(new Error("connection interrupted"))
          },
        }),
      ),
    ]
  ) {
    const result = await run([], () => Promise.resolve(response))
    assertEquals(result.code, 1)
    assertEquals(result.stdout, "")
    assertEquals(result.files, [])
  }
})

Deno.test("download CLI rejects malformed checksum before requesting bytes", async () => {
  const result = await run(["--sha256", "wrong"], () => {
    throw new Error("unexpected fetch")
  })
  assertEquals(result.code, 1)
  assertStringIncludes(result.stderr, "64 hexadecimal digits")
  assertEquals(result.files, [])
})

Deno.test("download CLI rejects unsafe redirects without a second request", async () => {
  for (
    const location of [
      "http://storage.example/asset",
      "https://user:secret@storage.example/asset",
    ]
  ) {
    let calls = 0
    const result = await run([], () => {
      calls++
      return Promise.resolve(
        new Response(null, { status: 302, headers: { location } }),
      )
    })
    assertEquals(calls, 1)
    assertEquals(result.code, 1)
    assertEquals(result.files, [])
  }
})

Deno.test("download CLI does not overwrite a file created while downloading", async () => {
  // The transport boundary can race a local writer without mocking filesystem semantics.
  const dir = await Deno.makeTempDir()
  const path = join(dir, "raced.bin")
  const oldKey = Deno.env.get("LINEAR_API_KEY")
  Deno.env.set("LINEAR_API_KEY", "download-test-secret")
  using _fetch = stub(globalThis, "fetch", async () => {
    await Deno.writeTextFile(path, "other writer")
    return new Response("abc")
  })
  using _error = stub(console, "error", () => {})
  const exit = new Error("exit")
  using _exit = stub(Deno, "exit", (code?: number): never => {
    assertEquals(code, 1)
    throw exit
  })
  try {
    try {
      await downloadCommand.parse([assetUrl, "--output", path, "--json"])
      throw new Error("expected failure")
    } catch (error) {
      assertEquals(error, exit)
    }
    assertEquals(await Deno.readTextFile(path), "other writer")
    const files = []
    for await (const file of Deno.readDir(dir)) files.push(file.name)
    assertEquals(files, ["raced.bin"])
  } finally {
    if (oldKey == null) Deno.env.delete("LINEAR_API_KEY")
    else Deno.env.set("LINEAR_API_KEY", oldKey)
    await Deno.remove(dir, { recursive: true })
  }
})

Deno.test("download CLI refuses spoofed or insecure asset URLs before authentication", async () => {
  for (
    const url of [
      "not a URL",
      "http://uploads.linear.app/asset",
      "https://uploads.linear.app.example.com/asset",
      "https://example.com/uploads.linear.app/asset",
      "https://user:secret@uploads.linear.app/asset",
      "https://uploads.linear.app:444/asset",
    ]
  ) {
    const result = await run(
      [],
      () => {
        throw new Error("unexpected fetch")
      },
      undefined,
      url,
    )
    assertEquals(result.code, 1)
    assertEquals(result.stdout, "")
    assertStringIncludes(result.stderr, "Expected an HTTPS uploads.linear.app")
    assertEquals(result.files, [])
  }
})

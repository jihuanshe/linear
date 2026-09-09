import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert"
import { fromFileUrl, join } from "@std/path"
import {
  MAX_FILE_SIZE,
  prepareUploads,
  uploadFile,
} from "../../src/utils/upload.ts"
import { ValidationError } from "../../src/utils/errors.ts"
import { setupMockLinearServer } from "../utils/test-helpers.ts"
import type { MockLinearServer } from "../utils/mock_linear_server.ts"

const main = fromFileUrl(new URL("../../src/main.ts", import.meta.url))
const secret = "upload-header-secret-fixture"
const signature = "signed-put-capability-fixture"
const assetUrl = "https://uploads.linear.app/fixture/asset"
const bytes = new Uint8Array([0, 255, 1, 13, 10, 128, 127])
const identity = {
  queryName: "GetIssueId",
  response: { data: { issue: { id: "11111111-1111-4111-8111-111111111111" } } },
}
function grant(server: MockLinearServer) {
  return {
    success: true,
    uploadFile: {
      assetUrl,
      uploadUrl: server.getUploadUrl() + "?signature=" + signature,
      headers: [{ key: "x-upload-proof", value: secret }],
    },
  }
}
async function invoke(args: string[], debug = false) {
  const result = await new Deno.Command(Deno.execPath(), {
    args: ["run", "--allow-all", "--quiet", main, ...args],
    env: { NO_COLOR: "1", LINEAR_DEBUG: debug ? "1" : "0" },
    stdout: "piped",
    stderr: "piped",
  }).output()
  return {
    code: result.code,
    stdout: new TextDecoder().decode(result.stdout),
    stderr: new TextDecoder().decode(result.stderr),
  }
}
function noCapabilities(output: string) {
  assertEquals(output.includes(secret), false, output)
  assertEquals(output.includes(signature), false, output)
  assertEquals(output.includes('"uploadUrl"'), false, output)
}

for (const command of ["upload", "comment"] as const) {
  Deno.test(`${command} validates the second file size before any write`, async () => {
    const directory = await Deno.makeTempDir()
    const { server, cleanup } = await setupMockLinearServer([identity])
    try {
      const first = join(directory, "first.png"),
        second = join(directory, "too-large.bin")
      await Deno.writeFile(first, bytes)
      const sparse = await Deno.open(second, { createNew: true, write: true })
      await sparse.truncate(MAX_FILE_SIZE + 1)
      sparse.close()
      const args = command === "upload"
        ? ["upload", first, second, "--json"]
        : [
          "issue",
          "comment",
          "add",
          "ENG-1",
          "--attach",
          first,
          "--attach",
          second,
          "--json",
        ]
      const result = await invoke(args)
      assertEquals(result.code, 1)
      const output = JSON.parse(result.stdout)
      assertEquals(output.effect, "none")
      assertStringIncludes(output.error.message, "File too large")
      assertEquals(server.graphqlRequests.length, 0)
      assertEquals(server.uploadRequests.length, 0)
    } finally {
      await cleanup()
      await Deno.remove(directory, { recursive: true })
    }
  })
}

Deno.test("prepared upload hash drift refuses the grant and does not call beforeWrite", async () => {
  const path = await Deno.makeTempFile()
  const { server, cleanup } = await setupMockLinearServer([])
  let writes = 0
  try {
    await Deno.writeFile(path, bytes)
    const [prepared] = await prepareUploads([path])
    await Deno.writeTextFile(path, "changed")
    await assertRejects(
      () =>
        uploadFile(path, {
          expectedSha256: prepared.sha256,
          beforeWrite: () => {
            writes++
            return Promise.resolve()
          },
        }),
      ValidationError,
      "File changed after validation",
    )
    assertEquals(writes, 0)
    assertEquals(server.graphqlRequests.length, 0)
  } finally {
    await cleanup()
    await Deno.remove(path)
  }
})

Deno.test("comment add sends captured body and binary bytes even if files change during the grant", async () => {
  const directory = await Deno.makeTempDir()
  const file = join(directory, "proof.bin"),
    bodyFile = join(directory, "body.md")
  const body = "line one\r\n  spacing and | pipes\r\n"
  const { server, cleanup } = await setupMockLinearServer([identity])
  server.addResponse({
    queryName: "FileUpload",
    response: async () => {
      await Deno.writeTextFile(file, "different after capture")
      await Deno.writeTextFile(bodyFile, "different intent after capture")
      return { data: { fileUpload: grant(server) } }
    },
  })
  server.addResponse({
    queryName: "AddComment",
    response: ({ variables }) => ({
      data: {
        commentCreate: {
          success: true,
          comment: {
            id: "comment-created",
            body: (variables.input as { body: string }).body,
            url: "https://linear.app/issue/ENG-1#comment-created",
            createdAt: "2026-09-10T00:00:00Z",
            user: null,
          },
        },
      },
    }),
  })
  try {
    await Deno.writeFile(file, bytes)
    await Deno.writeTextFile(bodyFile, body)
    const result = await invoke([
      "issue",
      "comment",
      "add",
      "ENG-1",
      "--body-file",
      bodyFile,
      "--attach",
      file,
      "--json",
    ])
    assertEquals(result.code, 0, result.stdout + result.stderr)
    const output = JSON.parse(result.stdout)
    assertEquals(
      output.data.comment.body,
      body + "\n\n[proof.bin](" + assetUrl + ")",
    )
    assertEquals(server.uploadRequests[0].body, bytes)
    assertEquals(server.uploadRequests[0].headers["x-upload-proof"], secret)
    assertEquals(output.receipts[0].assetUrl, assetUrl)
    noCapabilities(result.stdout + result.stderr)
  } finally {
    await cleanup()
    await Deno.remove(directory, { recursive: true })
  }
})

for (const kind of ["comment", "attachment"] as const) {
  for (const missingReceipt of [false, true]) {
    Deno.test(`${kind} failure after upload preserves the asset and never retries (missing receipt=${missingReceipt})`, async () => {
      const path = await Deno.makeTempFile({ suffix: ".png" })
      const { server, cleanup } = await setupMockLinearServer([identity])
      server.addResponse({
        queryName: "FileUpload",
        response: () => ({ data: { fileUpload: grant(server) } }),
      })
      const queryName = kind === "comment" ? "AddComment" : "AttachmentCreate"
      const field = kind === "comment" ? "commentCreate" : "attachmentCreate"
      server.addResponse({
        queryName,
        response: {
          data: { [field]: { success: missingReceipt, [kind]: null } },
        },
      })
      try {
        await Deno.writeFile(path, bytes)
        const args = kind === "comment"
          ? [
            "issue",
            "comment",
            "add",
            "ENG-1",
            "--body",
            "Evidence",
            "--attach",
            path,
            "--json",
          ]
          : ["issue", "attach", "ENG-1", path, "--json"]
        const result = await invoke(args, true)
        assertEquals(result.code, 1)
        const output = JSON.parse(result.stdout)
        assertEquals(output.effect, missingReceipt ? "applied" : "unknown")
        assertEquals(output.receipts[0].assetUrl, assetUrl)
        assertEquals(server.uploadRequests.length, 1)
        assertEquals(
          server.graphqlRequests.filter((r) =>
            r.query.includes("mutation " + queryName)
          ).length,
          1,
        )
        noCapabilities(result.stdout + result.stderr)
      } finally {
        await cleanup()
        await Deno.remove(path)
      }
    })
  }
}

for (const command of ["upload", "comment"] as const) {
  Deno.test(`${command} keeps the first asset when a later prepared file changes`, async () => {
    const directory = await Deno.makeTempDir(),
      first = join(directory, "first.png"),
      second = join(directory, "second.png")
    const { server, cleanup } = await setupMockLinearServer([identity])
    server.addResponse({
      queryName: "FileUpload",
      response: async () => {
        await Deno.writeTextFile(second, "modified")
        return { data: { fileUpload: grant(server) } }
      },
    })
    try {
      await Deno.writeFile(first, bytes)
      await Deno.writeFile(second, bytes)
      const args = command === "upload"
        ? ["upload", first, second, "--json"]
        : [
          "issue",
          "comment",
          "add",
          "ENG-1",
          "--attach",
          first,
          "--attach",
          second,
          "--json",
        ]
      const result = await invoke(args)
      assertEquals(result.code, 1)
      const output = JSON.parse(result.stdout)
      assertEquals(output.effect, "applied")
      assertStringIncludes(
        output.error.message,
        "File changed after validation",
      )
      assertEquals(output.receipts[0].assetUrl, assetUrl)
      assertEquals(server.uploadRequests.length, 1)
      assertEquals(
        server.graphqlRequests.filter((r) =>
          r.query.includes("mutation FileUpload")
        ).length,
        1,
      )
      assertEquals(
        server.graphqlRequests.some((r) =>
          r.query.includes("mutation AddComment")
        ),
        false,
      )
    } finally {
      await cleanup()
      await Deno.remove(directory, { recursive: true })
    }
  })
}

for (
  const scenario of ["partial", "unconfirmed", "incomplete", "missing"] as const
) {
  for (const json of [false, true]) {
    Deno.test(`upload grant ${scenario} hides signed capabilities with debug enabled (json=${json})`, async () => {
      const path = await Deno.makeTempFile({ suffix: ".png" })
      const { server, cleanup } = await setupMockLinearServer([])
      const payload = scenario === "missing"
        ? { success: true, uploadFile: null }
        : scenario === "incomplete"
        ? {
          ...grant(server),
          uploadFile: { ...grant(server).uploadFile, uploadUrl: "" },
        }
        : { ...grant(server), success: scenario !== "unconfirmed" }
      server.addResponse({
        queryName: "FileUpload",
        response: {
          data: { fileUpload: payload },
          ...(["partial", "unconfirmed"].includes(scenario)
            ? { errors: [{ message: `Grant failed: ${signature} ${secret}` }] }
            : {}),
        },
      })
      try {
        await Deno.writeFile(path, bytes)
        const result = await invoke([
          "upload",
          path,
          ...(json ? ["--json"] : []),
        ], true)
        assertEquals(result.code, 1)
        noCapabilities(result.stdout + result.stderr)
        if (json) {
          const output = JSON.parse(result.stdout)
          assertEquals(output.ok, false)
          assertEquals(
            output.effect,
            scenario === "unconfirmed" ? "unknown" : "applied",
          )
          if (["partial", "incomplete"].includes(scenario)) {
            assertEquals(output.receipts[0].assetUrl, assetUrl)
            assertEquals(output.receipts[0].stage, "signed")
          }
        } else assertEquals(result.stdout, "")
        assertEquals(server.graphqlRequests.length, 1)
        assertEquals(server.uploadRequests.length, 0)
      } finally {
        await cleanup()
        await Deno.remove(path)
      }
    })
  }
}

for (const json of [false, true]) {
  Deno.test(`upload PUT rejection preserves the asset candidate without exposing headers or status text (json=${json})`, async () => {
    const path = await Deno.makeTempFile({ suffix: ".png" })
    let puts = 0
    const transfer = Deno.serve({
      hostname: "127.0.0.1",
      port: 0,
      onListen: () => {},
    }, async (request) => {
      assertEquals(request.headers.get("x-upload-proof"), secret)
      assertEquals(new Uint8Array(await request.arrayBuffer()), bytes)
      puts++
      return new Response(secret, { status: 403, statusText: signature })
    })
    const { server, cleanup } = await setupMockLinearServer([])
    server.addResponse({
      queryName: "FileUpload",
      response: {
        data: {
          fileUpload: {
            ...grant(server),
            uploadFile: {
              ...grant(server).uploadFile,
              uploadUrl: `http://127.0.0.1:${
                (transfer.addr as Deno.NetAddr).port
              }/upload?signature=${signature}`,
            },
          },
        },
      },
    })
    try {
      await Deno.writeFile(path, bytes)
      const result = await invoke(
        ["upload", path, ...(json ? ["--json"] : [])],
        true,
      )
      assertEquals(result.code, 1)
      noCapabilities(result.stdout + result.stderr)
      assertStringIncludes(result.stdout + result.stderr, "HTTP 403")
      if (json) {
        const output = JSON.parse(result.stdout)
        assertEquals(output.effect, "unknown")
        assertEquals(output.receipts[0].assetUrl, assetUrl)
        assertEquals(output.receipts[0].stage, "unknown")
      } else assertEquals(result.stdout, "")
      assertEquals(puts, 1)
      assertEquals(server.graphqlRequests.length, 1)
    } finally {
      await cleanup()
      await transfer.shutdown()
      await Deno.remove(path)
    }
  })
}

Deno.test("link does not claim success when its acknowledged response has no attachment identity", async () => {
  const { server, cleanup } = await setupMockLinearServer([identity, {
    queryName: "AttachmentLinkURL",
    response: {
      data: { attachmentLinkURL: { success: true, attachment: null } },
    },
  }])
  try {
    const result = await invoke(["issue", "link", "ENG-1", assetUrl, "--json"])
    assertEquals(result.code, 1)
    const output = JSON.parse(result.stdout)
    assertEquals(output.ok, false)
    assertEquals(output.effect, "applied")
    assertEquals(
      server.graphqlRequests.filter((r) =>
        r.query.includes("mutation AttachmentLinkURL")
      ).length,
      1,
    )
  } finally {
    await cleanup()
  }
})

Deno.test("upload success returns one standard JSON result with the stored asset metadata", async () => {
  const directory = await Deno.makeTempDir()
  const path = join(directory, "proof.png")
  const { server, cleanup } = await setupMockLinearServer([])
  server.addResponse({
    queryName: "FileUpload",
    response: () => ({ data: { fileUpload: grant(server) } }),
  })
  try {
    await Deno.writeFile(path, bytes)
    const result = await invoke(["upload", path, "--json"])
    assertEquals(result.code, 0, result.stdout + result.stderr)
    assertEquals(result.stderr, "")
    assertEquals(JSON.parse(result.stdout), {
      ok: true,
      effect: "applied",
      data: [{
        assetUrl,
        filename: "proof.png",
        size: bytes.length,
        contentType: "image/png",
        public: false,
      }],
    })
    assertEquals(server.uploadRequests[0].body, bytes)
    noCapabilities(result.stdout)
  } finally {
    await cleanup()
    await Deno.remove(directory, { recursive: true })
  }
})

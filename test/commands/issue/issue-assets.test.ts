import { assertEquals, assertStringIncludes } from "@std/assert"
import { join } from "@std/path"
import { MockLinearServer } from "../../utils/mock_linear_server.ts"
import { commonDenoArgs } from "../../utils/test-helpers.ts"

const raw = "  Original  \r\n\r\n- one\r\n  - two\r\n\\n\r\n"
const url = "https://uploads.linear.app/test/asset"
const snippet = "[evidence\\]draft.txt](https://uploads.linear.app/test/asset)"

Deno.test("asset guide tasks: sidebar attachment, new comment with files, and protected merge into an existing comment", async () => {
  const dir = await Deno.makeTempDir()
  const file = join(dir, "evidence]draft.txt")
  const image = join(dir, "screenshot.png")
  const bodyFile = join(dir, "body.md")
  let remoteBody = raw
  let failAssociation = false
  let failSecondGrant = false
  let driftDuringUpload = false
  let grants = 0
  const server = new MockLinearServer([
    {
      queryName: "GetIssueId",
      response: { data: { issue: { id: "issue-1" } } },
    },
    {
      queryName: "ReadComment",
      response: () => ({
        data: {
          organization: { id: "workspace-1", urlKey: "test" },
          comment: { id: "comment-1", body: remoteBody, archivedAt: null },
        },
      }),
    },
    {
      queryName: "AttachmentCreate",
      response: () => ({
        data: {
          attachmentCreate: {
            success: !failAssociation,
            attachment: failAssociation ? null : {
              id: "attachment-1",
              issue: { id: "issue-1" },
              url,
              title: "Evidence",
            },
          },
        },
      }),
    },
    {
      queryName: "AddComment",
      response: () => ({
        data: {
          commentCreate: {
            success: !failAssociation,
            comment: failAssociation
              ? null
              : { id: "comment-2", issue: { id: "issue-1" }, url },
          },
        },
      }),
    },
    {
      queryName: "UpdateComment",
      response: () => ({
        data: {
          commentUpdate: {
            success: !failAssociation,
            comment: failAssociation ? null : { id: "comment-1", url },
          },
        },
      }),
    },
  ])
  try {
    await Deno.writeTextFile(file, "proof bytes")
    await Deno.writeFile(image, new Uint8Array([0x89, 0x50, 0x4e, 0x47]))
    await Deno.writeTextFile(bodyFile, raw)
    server.start()
    server.addResponse({
      queryName: "FileUpload",
      response: () => {
        if (driftDuringUpload) remoteBody = "Someone else's change"
        return {
          data: {
            fileUpload: {
              success: true,
              uploadFile: {
                assetUrl: url,
                uploadUrl: failSecondGrant && ++grants === 2
                  ? undefined
                  : server.getUploadUrl(),
                headers: [],
              },
            },
          },
        }
      },
    })
    const run = async (args: string[], success = true) => {
      const result = await new Deno.Command(Deno.execPath(), {
        args: ["run", ...commonDenoArgs, "src/main.ts", ...args],
        env: {
          LINEAR_API_KEY: "test-key",
          LINEAR_GRAPHQL_ENDPOINT: server.getEndpoint(),
        },
        stdin: "null",
        stdout: "piped",
        stderr: "piped",
      }).output()
      const out = new TextDecoder().decode(result.stdout)
      assertEquals(
        result.code,
        success ? 0 : 1,
        out + new TextDecoder().decode(result.stderr),
      )
      return out
    }

    await run([
      "issue",
      "attach",
      "ENG-1",
      file,
      "--title",
      "Evidence",
      "--json",
    ])
    assertEquals(server.graphqlRequests.at(-1)?.variables.input, {
      issueId: "issue-1",
      url,
      title: "Evidence",
    })
    assertEquals(
      new TextDecoder().decode(server.uploadRequests[0].body),
      "proof bytes",
    )

    // Two generated snippets must be separate paragraphs, with the original prefix untouched.
    await run([
      "issue",
      "comment",
      "add",
      "ENG-1",
      "--body-file",
      bodyFile,
      "--attach",
      image,
      "--attach",
      file,
      "--json",
    ])
    assertEquals(server.graphqlRequests.at(-1)?.variables.input, {
      issueId: "issue-1",
      body: raw +
        "\n\n![screenshot.png](https://uploads.linear.app/test/asset)\n\n" +
        snippet,
    })
    await run(["issue", "comment", "add", "ENG-1", "--attach", file, "--json"])
    assertEquals(server.graphqlRequests.at(-1)?.variables.input, {
      issueId: "issue-1",
      body: snippet,
    })

    // Save the production raw view before uploading or editing.
    const saved = await run(["issue", "comment", "view", "comment-1", "--json"])
    const base = join(dir, "comment-base.json")
    await Deno.writeTextFile(base, saved)
    const updateArgs = [
      "issue",
      "comment",
      "update",
      "comment-1",
      "--base-file",
      base,
    ]
    const direct = JSON.parse(
      await run([
        ...updateArgs,
        "--attach",
        image,
        "--attach",
        file,
        "--json",
      ]),
    )
    assertEquals(direct.effect, "applied")
    assertEquals(direct.data.comment.id, "comment-1")
    assertEquals(direct.receipts.map((r: { filename: string }) => r.filename), [
      "screenshot.png",
      "evidence]draft.txt",
    ])
    assertEquals(server.graphqlRequests.at(-1)?.variables, {
      id: "comment-1",
      input: {
        body: raw +
          "\n\n![screenshot.png](https://uploads.linear.app/test/asset)\n\n" +
          snippet,
      },
    })
    const replacement =
      "\ufeff  Revised\r\n\r\n  - Keep indentation\r\n\\n  \r\n"
    await Deno.writeTextFile(bodyFile, replacement)
    await run([
      ...updateArgs,
      "--body-file",
      bodyFile,
      "--attach",
      file,
      "--json",
    ])
    assertEquals(server.graphqlRequests.at(-1)?.variables.input, {
      body: replacement + "\n\n" + snippet,
    })
    for (const duringUpload of [false, true]) {
      driftDuringUpload = duringUpload
      remoteBody = duringUpload ? raw : "Already changed"
      const before = server.graphqlRequests.length
      const transfers = server.uploadRequests.length
      const conflict = JSON.parse(
        await run([
          ...updateArgs,
          // Equal-to-current desired text must not hide a stale original before upload.
          ...(duringUpload ? [] : ["--body", remoteBody]),
          "--attach",
          file,
          "--json",
        ], false),
      )
      assertStringIncludes(
        conflict.error.message,
        "Original values changed: body",
      )
      assertEquals(conflict.error.details.dependencies, ["body"])
      assertEquals(conflict.effect, duringUpload ? "applied" : "none")
      assertEquals(
        server.uploadRequests.length - transfers,
        duringUpload ? 1 : 0,
      )
      assertEquals(conflict.receipts?.length ?? 0, duringUpload ? 1 : 0)
      assertEquals(
        server.graphqlRequests.slice(before).some((r) =>
          r.query.includes("mutation UpdateComment")
        ),
        false,
      )
    }
    driftDuringUpload = false
    remoteBody = raw

    // Independent upload and custom placement remain available without re-uploading.
    const extracted = await new Deno.Command("jq", {
      args: ["-e", "-j", ".comment.body", base],
      stdout: "piped",
      stderr: "piped",
    }).output()
    assertEquals(extracted.code, 0)
    assertEquals(new TextDecoder().decode(extracted.stdout), raw)
    const upload = await run(["upload", file])
    assertStringIncludes(upload, "  markdown: " + snippet)
    const merged = new TextDecoder().decode(extracted.stdout) + "\n\n" + snippet
    await Deno.writeTextFile(bodyFile, merged)
    await run([
      "issue",
      "comment",
      "update",
      "comment-1",
      "--body-file",
      bodyFile,
      "--base-file",
      base,
      "--json",
    ])
    assertEquals(server.graphqlRequests.at(-1)?.variables, {
      id: "comment-1",
      input: { body: raw + "\n\n" + snippet },
    })
    remoteBody = "Someone else's change"
    const beforeConflict = server.graphqlRequests.length
    const conflict = JSON.parse(
      await run([
        "issue",
        "comment",
        "update",
        "comment-1",
        "--body-file",
        bodyFile,
        "--base-file",
        base,
        "--json",
      ], false),
    )
    assertEquals(conflict.effect, "none")
    assertEquals(
      server.graphqlRequests.slice(beforeConflict).some((r) =>
        r.query.includes("mutation")
      ),
      false,
    )

    // Explicit blank source, invalid UTF-8, unreadable source, or missing identifier must not upload.
    const badFile = join(dir, "bad.md")
    for (
      const bytes of [
        new Uint8Array(),
        new TextEncoder().encode(" \r\n"),
        new Uint8Array([255]),
      ]
    ) {
      await Deno.writeFile(badFile, bytes)
      const before = server.graphqlRequests.length
      const rejected = JSON.parse(
        await run([
          "issue",
          "comment",
          "add",
          "ENG-1",
          "--body-file",
          badFile,
          "--attach",
          file,
          "--json",
        ], false),
      )
      assertEquals(rejected.effect, "none")
      assertEquals(server.graphqlRequests.length, before)
    }
    for (
      const args of [
        ["issue", "comment", "add", "ENG-1", "--body", "", "--attach", file],
        [
          "issue",
          "comment",
          "add",
          "ENG-1",
          "--body-file",
          join(dir, "missing"),
          "--attach",
          file,
        ],
        ["issue", "comment", "add", "--body", "present"],
        ["issue", "comment", "add", "ENG-1"],
        ["issue", "attach", "ENG-1", file, "--comment", "not supported"],
        [...updateArgs, "--body", "", "--attach", file],
        [...updateArgs, "--body-file", badFile, "--attach", file],
        [...updateArgs, "--attach", file, "--attach", join(dir, "missing")],
        [...updateArgs, "--body", "present", "--public"],
        ["issue", "comment", "update", "comment-1", "--attach", file],
      ]
    ) {
      const before = server.graphqlRequests.length
      await run([...args, "--json"], false)
      assertEquals(server.graphqlRequests.length, before)
    }
    remoteBody = replacement
    await run([
      "issue",
      "comment",
      "update",
      "comment-1",
      "--unprotected",
      "--attach",
      file,
      "--json",
    ])
    assertEquals(server.graphqlRequests.at(-1)?.variables.input, {
      body: replacement + "\n\n" + snippet,
    })
    remoteBody = raw
    failAssociation = true
    for (
      const args of [
        ["issue", "attach", "ENG-1", file],
        ["issue", "comment", "add", "ENG-1", "--attach", file],
        [...updateArgs, "--attach", file],
      ]
    ) {
      const result = JSON.parse(await run([...args, "--json"], false))
      assertEquals(result.effect, "unknown")
      assertEquals(result.receipts, [{
        kind: "upload",
        assetUrl: url,
        filename: "evidence]draft.txt",
        size: 11,
        contentType: "text/plain",
        public: false,
      }])
    }
    failSecondGrant = true
    for (const args of [["issue", "comment", "add", "ENG-1"], updateArgs]) {
      grants = 0
      const beforeGrantFailure = server.graphqlRequests.length
      const transfers = server.uploadRequests.length
      const staged = JSON.parse(
        await run([
          ...args,
          "--attach",
          file,
          "--attach",
          file,
          "--json",
        ], false),
      )
      assertEquals(staged.effect, "applied")
      assertEquals(staged.receipts.length, 2)
      assertEquals(staged.receipts[0].assetUrl, url)
      assertEquals(staged.receipts[1].assetUrl, url)
      assertEquals(staged.receipts[1].stage, "signed")
      assertEquals(server.uploadRequests.length - transfers, 1)
      assertEquals(
        server.graphqlRequests.slice(beforeGrantFailure).some((r) =>
          /mutation (AddComment|UpdateComment)/.test(r.query)
        ),
        false,
      )
    }
  } finally {
    await server.stop()
    await Deno.remove(dir, { recursive: true })
  }
})

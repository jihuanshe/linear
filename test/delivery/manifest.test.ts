import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert"
import { fromFileUrl, join } from "@std/path"
import { stub } from "@std/testing/mock"
import { contentFrom, loadManifest } from "../../src/delivery/manifest.ts"
import { ValidationError } from "../../src/utils/errors.ts"
import {
  basis,
  connection,
  create,
  fixture,
  issue,
  manifest,
  update,
  WORKSPACE,
} from "./fixture.ts"

async function withManifest(
  value: unknown,
  run: (path: string, dir: string) => Promise<void>,
) {
  const dir = await Deno.makeTempDir()
  const path = join(dir, "delivery.json")
  try {
    await Deno.writeTextFile(path, JSON.stringify(value))
    await run(path, dir)
  } finally {
    await Deno.remove(dir, { recursive: true })
  }
}

Deno.test("manifest v2 validates all local intent before any request", async (t) => {
  const original = issue()
  const invalid: [string, unknown][] = [
    ["missing update identity", { operation: "update", set: { title: "New" } }],
    ["create cannot carry an existing identity", {
      ...create(),
      identifier: original.identifier,
    }],
    ["create cannot carry a base", { ...create(), base: basis(original) }],
    ["create requires team in set", {
      operation: "create",
      set: { title: "New" },
    }],
    ["legacy top-level team", {
      operation: "create",
      team: "ENG",
      set: { title: "New" },
    }],
    ["replacement requires original basis", {
      operation: "update",
      identifier: original.identifier,
      set: { title: "New" },
    }],
    ["cannot combine original and unprotected", {
      ...update(original),
      unprotected: true,
    }],
    ["cannot combine base and baseFile", {
      ...update(original),
      baseFile: "original.json",
    }],
    ["expectFields needs a replacement basis", {
      operation: "update",
      identifier: original.identifier,
      set: { addLabel: ["Bug"] },
      expectFields: ["title"],
    }],
    ["empty label replacement", update(original, { label: [] })],
    [
      "replace and increment labels are distinct",
      update(original, { label: ["Bug"], addLabel: ["Feature"] }),
    ],
    [
      "use unassign rather than null assignee",
      update(original, { assignee: null }),
    ],
    [
      "assignee and unassign conflict",
      update(original, { assignee: "alex", unassign: true }),
    ],
    [
      "cycle and clearCycle conflict",
      update(original, { cycle: "current", clearCycle: true }),
    ],
    ["create rejects update-only options", {
      operation: "create",
      set: { title: "New", team: "ENG", addLabel: ["Bug"] },
    }],
    ["create rejects clearProject", {
      operation: "create",
      set: { title: "New", team: "ENG", clearProject: true },
    }],
    [
      "project and clearProject conflict",
      update(original, { project: "P", clearProject: true }),
    ],
    [
      "milestone and clearProject conflict",
      update(original, { milestone: "M", clearProject: true }),
    ],
    ["unknown field is rejected", update(original, { imaginaryField: "x" })],
    ["empty set is rejected", update(original, {})],
    ["empty comment string", {
      operation: "update",
      identifier: original.identifier,
      comments: [{ body: " " }],
    }],
    ["empty comment", {
      operation: "update",
      identifier: original.identifier,
      comments: [{}],
    }],
    ["body and bodyFile conflict", {
      operation: "update",
      identifier: original.identifier,
      comments: [{ body: "text", bodyFile: "body.md" }],
    }],
    ["public needs files", {
      operation: "update",
      identifier: original.identifier,
      comments: [{ body: "text", public: true }],
    }],
    ["empty delivery", {
      operation: "update",
      identifier: original.identifier,
    }],
    ["non-HTTP attachment", {
      operation: "update",
      identifier: original.identifier,
      attachments: [{ kind: "url", url: "file:///tmp/report" }],
    }],
  ]
  for (const [name, entry] of invalid) {
    await t.step(name, async () => {
      await withManifest(manifest([entry]), async (path) => {
        await assertRejects(() => loadManifest(path), ValidationError)
      })
    })
  }
})

Deno.test("manifest missing basis explains recovery for the specific entry and workspace", async () => {
  const has = Deno.env.has.bind(Deno.env)
  using _environment = stub(
    Deno.env,
    "has",
    (key) => key === "LINEAR_API_KEY" ? false : has(key),
  )
  const original = issue(2048)
  const entry = {
    operation: "update",
    identifier: original.identifier,
    set: { title: "New" },
  }
  const value = manifest([
    create(),
    entry,
  ], "delivery-workspace")
  await withManifest(value, async (path, dir) => {
    const error = await assertRejects(() => loadManifest(path), ValidationError)
    const suggestion = error.suggestion!
    assertStringIncludes(
      suggestion,
      "(set -C; linear --workspace 'delivery-workspace' issue view 'ENG-2048' --json > original.json)",
    )
    assertStringIncludes(suggestion, "Stop if the read fails")
    assertStringIncludes(
      suggestion,
      'confirm organization.urlKey in the saved read is "delivery-workspace"; stop if it differs',
    )
    assertStringIncludes(suggestion, "reconfirm your intended change")
    assertStringIncludes(suggestion, "issues[1].baseFile")
    assertStringIncludes(suggestion, "absolute path")
    assertStringIncludes(suggestion, "resolved from the manifest directory")
    assertEquals(suggestion.includes("--base-file"), false)

    const baseFile = join(dir, "original.json")
    await Deno.writeTextFile(
      baseFile,
      JSON.stringify({
        ...basis(original),
        organization: { ...WORKSPACE, urlKey: "delivery-workspace" },
      }),
    )
    value.issues[1] = { ...entry, baseFile }
    await Deno.writeTextFile(path, JSON.stringify(value))
    const loaded = await loadManifest(path)
    assertEquals(loaded.originals.get(1)?.issue, original)
  })
})

for (const credentialSource of ["environment", "dotenv"]) {
  Deno.test({
    name:
      `manifest recovery executes its suggested read with ${credentialSource} credentials`,
    ignore: Deno.build.os === "windows",
    async fn() {
      const original = issue(2048)
      const f = await fixture({
        issues: [original],
        overrides: () => [{
          queryName: "GetIssueDetailsWithComments",
          response: {
            data: {
              organization: WORKSPACE,
              issue: {
                ...original,
                comments: connection(),
                attachments: connection(),
                children: connection(),
                documents: connection(),
                relations: connection(),
                inverseRelations: connection(),
              },
            },
          },
        }],
      })
      const run = (command: string) =>
        new Deno.Command("sh", {
          args: [
            "-c",
            `${credentialSource === "dotenv" ? "unset LINEAR_API_KEY;" : ""}
linear() { "$DENO_BIN" run --allow-all --quiet --config="$DENO_CONFIG" "$CLI_MAIN" "$@"; }
${command}`,
          ],
          cwd: f.dir,
          env: {
            LINEAR_API_KEY: "test-token",
            LINEAR_GRAPHQL_ENDPOINT: f.server.getEndpoint(),
            DENO_BIN: Deno.execPath(),
            DENO_CONFIG: fromFileUrl(
              new URL("../../deno.json", import.meta.url),
            ),
            CLI_MAIN: fromFileUrl(
              new URL("../../src/main.ts", import.meta.url),
            ),
            NO_COLOR: "1",
          },
          stdin: "null",
          stdout: "piped",
          stderr: "piped",
        }).output()
      try {
        if (credentialSource === "dotenv") {
          await Deno.writeTextFile(
            join(f.dir, ".env"),
            "LINEAR_API_KEY=test-token\n",
          )
        }
        const entry = {
          operation: "update",
          identifier: original.identifier,
          set: { title: "Recovered title" },
        }
        const value = manifest([create(), entry])
        await f.write(value)
        const plan = await run("linear issue plan --file delivery.json --json")
        assertEquals(plan.code, 1)
        const error = JSON.parse(new TextDecoder().decode(plan.stdout))
        assertEquals(error.effect, "none")
        const suggestion = error.error.suggestion as string
        assertEquals(suggestion.includes("--workspace"), false)
        assertStringIncludes(
          suggestion,
          'organization.urlKey in the saved read is "testing"',
        )
        assertStringIncludes(suggestion, "issues[1].baseFile")
        assertEquals(f.server.graphqlRequests, [])

        const readCommand =
          suggestion.match(/\(set -C; .*? > original\.json\)/)![0]
        const read = await run(readCommand)
        assertEquals(read.code, 0, new TextDecoder().decode(read.stderr))
        const baseFile = join(f.dir, "original.json")
        const saved = await Deno.readTextFile(baseFile)
        const originalRead = JSON.parse(saved)
        assertEquals(originalRead.organization.urlKey, "testing")
        assertEquals(originalRead.issue.id, original.id)
        value.issues[1] = { ...entry, baseFile }
        await f.write(value)
        assertEquals(
          (await loadManifest(f.path)).originals.get(1)?.issue,
          originalRead.issue,
        )

        const requestsBeforeRepeat = f.server.graphqlRequests.length
        const repeated = await run(readCommand)
        assertEquals(repeated.success, false)
        assertEquals(await Deno.readTextFile(baseFile), saved)
        assertEquals(f.server.graphqlRequests.length, requestsBeforeRepeat)
        originalRead.organization.urlKey = "another-workspace"
        await Deno.writeTextFile(baseFile, JSON.stringify(originalRead))
        await assertRejects(
          () => loadManifest(f.path),
          ValidationError,
          "manifest workspace",
        )
        assertEquals(f.mutations(), [])
      } finally {
        await f.cleanup()
      }
    },
  })
}

Deno.test("manifest v2 accepts native null presence and independent original fields", async () => {
  const original = issue(1001, { description: null, assignee: null })
  await withManifest(
    manifest([{
      ...update(original, { description: "New" }),
      expectFields: ["state"],
    }]),
    async (path) => {
      const loaded = await loadManifest(path)
      assertEquals(loaded.originals.get(0), basis(original))
      assertEquals(
        (loaded.originals.get(0)?.issue as { description: string | null })
          .description,
        null,
      )
      assertEquals(loaded.manifest.issues[0].expectFields, ["state"])
    },
  )
})

Deno.test("manifest v2 rejects duplicate identifiers, aliases carrying the same UUID and incomplete coordinates", async () => {
  const original = issue()
  for (
    const entries of [
      [
        { ...update(original), identifier: original.identifier.toLowerCase() },
        update(original),
      ],
      [{ ...update(original), identifier: original.id }, update(original)],
      [{
        operation: "update",
        identifier: "580",
        comments: [{ body: "Note" }],
      }],
      [{
        operation: "update",
        identifier: original.identifier,
        relations: [{ type: "related", issue: "580" }],
      }],
    ]
  ) {
    await withManifest(manifest(entries), async (path) => {
      await assertRejects(() => loadManifest(path), ValidationError)
    })
  }
})

Deno.test("manifest v2 accepts explicit unprotected writes and native incremental labels without invented bases", async () => {
  for (
    const entry of [
      {
        operation: "update",
        identifier: issue().identifier,
        set: { title: "New" },
        unprotected: true,
      },
      {
        operation: "update",
        identifier: issue().identifier,
        set: { addLabel: ["Bug"] },
      },
      {
        operation: "update",
        identifier: issue().identifier,
        comments: [{ body: "Note" }],
      },
    ]
  ) {
    await withManifest(manifest([entry]), async (path) => {
      const loaded = await loadManifest(path)
      assertEquals(loaded.originals.size, 0)
    })
  }
})

Deno.test("manifest v2 inventories the entire batch and captures exact text once", async () => {
  const original = issue()
  await withManifest(
    manifest([
      {
        ...update(original, { descriptionFile: "desired.md" }),
        base: undefined,
        baseFile: "original.json",
      },
      {
        operation: "create",
        set: { title: "New", team: "ENG" },
        comments: [{ bodyFile: "body.md", files: [{ path: "proof.yrp" }] }],
        attachments: [{ kind: "file", path: "proof.yrp" }],
      },
    ]),
    async (path, dir) => {
      await Deno.writeTextFile(
        join(dir, "original.json"),
        JSON.stringify(basis(original)),
      )
      await Deno.writeTextFile(
        join(dir, "desired.md"),
        " \nExact description\n ",
      )
      await Deno.writeTextFile(join(dir, "body.md"), "Evidence\n")
      await Deno.writeFile(join(dir, "proof.yrp"), new Uint8Array([1, 2, 3]))
      const loaded = await loadManifest(path)
      assertEquals(loaded.files.size, 4)
      assertEquals(loaded.files.get("proof.yrp")?.size, 3)
      assertEquals(loaded.files.get("body.md")?.contentType, "text/markdown")
      assertEquals(loaded.files.get("body.md")?.sha256.length, 64)
      assertEquals(loaded.originals.get(0), basis(original))
      await Deno.writeTextFile(join(dir, "desired.md"), "Changed after loading")
      assertEquals(
        contentFrom(loaded, undefined, "desired.md"),
        " \nExact description\n ",
      )
    },
  )
})

Deno.test("manifest v2 rejects missing, empty, oversized and invalid-public files throughout a batch", async () => {
  for (
    const mode of [
      "missing",
      "directory",
      "empty-body",
      "too-large",
      "public-nonimage",
      "bad-base-json",
      "wrong-workspace",
    ] as const
  ) {
    const first = create("First must not run")
    const second = mode === "bad-base-json" || mode === "wrong-workspace"
      ? { ...update(issue()), base: undefined, baseFile: "evidence.bin" }
      : {
        operation: "update",
        identifier: issue().identifier,
        comments: [
          mode === "empty-body" ? { bodyFile: "evidence.bin" } : {
            body: "Evidence",
            files: [{ path: "evidence.bin" }],
            public: mode === "public-nonimage",
          },
        ],
      }
    await withManifest(manifest([first, second]), async (path, dir) => {
      const file = join(dir, "evidence.bin")
      if (mode === "directory") await Deno.mkdir(file)
      else if (mode === "too-large") {
        const handle = await Deno.open(file, { write: true, create: true })
        await handle.truncate(100 * 1024 * 1024 + 1)
        handle.close()
      } else if (mode !== "missing") {
        await Deno.writeTextFile(
          file,
          mode === "empty-body"
            ? " \n"
            : mode === "wrong-workspace"
            ? JSON.stringify({
              ...basis(issue()),
              organization: { ...WORKSPACE, urlKey: "another" },
            })
            : "not JSON",
        )
      }
      await assertRejects(() => loadManifest(path), ValidationError)
    })
  }
})

Deno.test("manifest v2 rejects the old protocol without changing its manifest or checkpoint", async () => {
  await withManifest({
    schemaVersion: 1,
    workspace: "testing",
    issues: [{ operation: "create", team: "ENG", set: { title: "Old" } }],
  }, async (path) => {
    const old = await Deno.readTextFile(path)
    const checkpoint = `${path}.checkpoint.json`
    await Deno.writeTextFile(
      checkpoint,
      '{"schemaVersion":1,"createdIdentifiers":{"0":"ENG-1"},"items":{}}',
    )
    const before = await Deno.readTextFile(checkpoint)
    const error = await assertRejects(
      () => loadManifest(path),
      ValidationError,
      "schemaVersion 1 is retired",
    )
    assertStringIncludes(error.suggestion ?? "", "checkpoint")
    assertEquals(await Deno.readTextFile(path), old)
    assertEquals(await Deno.readTextFile(checkpoint), before)
  })
})

Deno.test("issue-delivery guide v2 file example parses against the production loader", async () => {
  const guide = await Deno.readTextFile(
    new URL("../../docs/guides/issue-delivery.md", import.meta.url),
  )
  const example = guide.match(/```json\n([\s\S]*?)\n```/)
  if (!example) throw new Error("Guide has no JSON example")
  const value = JSON.parse(example[1])
  await withManifest(value, async (path, dir) => {
    await Deno.writeTextFile(
      join(dir, "original.json"),
      JSON.stringify({
        organization: { ...WORKSPACE, urlKey: value.workspace },
        issue: issue(123, { identifier: "ENG-123" }),
      }),
    )
    await Deno.writeTextFile(join(dir, "desired.md"), "Desired description")
    await Deno.writeTextFile(join(dir, "evidence.md"), "Evidence")
    await Deno.writeFile(join(dir, "screenshot.png"), new Uint8Array([1, 2, 3]))
    await Deno.writeFile(join(dir, "replay.yrp"), new Uint8Array([1, 2, 3]))
    const loaded = await loadManifest(path)
    assertEquals(loaded.manifest.schemaVersion, 2)
    assertEquals(loaded.manifest.issues[1].set?.team, "ENG")
    assertEquals(loaded.manifest.issues[0].attachments?.[1], {
      kind: "file",
      path: "replay.yrp",
      title: "原始 Replay",
    })
  })
})

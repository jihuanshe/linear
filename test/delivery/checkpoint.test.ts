import { assertEquals, assertRejects } from "@std/assert"
import { dirname, join } from "@std/path"
import { stub } from "@std/testing/mock"
import {
  type Checkpoint,
  type CheckpointItem,
  checkpointPath,
  type DeliveryReceipt,
  loadCheckpoint,
  prepareCheckpoint,
  saveCheckpoint,
} from "../../src/delivery/checkpoint.ts"
import { ValidationError } from "../../src/utils/errors.ts"

const workspace = { id: "workspace-1", urlKey: "test" }
const issue: DeliveryReceipt = {
  kind: "issue",
  id: "issue-1",
  identifier: "ENG-1",
}
const upload: DeliveryReceipt = {
  kind: "upload",
  assetUrl: "https://uploads.linear.app/file-1",
  filename: "report.txt",
  size: 12,
  contentType: "text/plain",
  public: false,
}
const completed = (receipt: DeliveryReceipt = issue): CheckpointItem => ({
  status: "completed",
  effect: "applied",
  receipt,
})
const ledger = (items: Record<string, CheckpointItem> = {}): Checkpoint => ({
  schemaVersion: 2,
  workspace,
  items,
})

async function withCheckpoint(
  value: unknown,
  run: (manifestPath: string) => Promise<void>,
): Promise<void> {
  const dir = await Deno.makeTempDir()
  try {
    const path = join(dir, "delivery.json")
    if (value !== undefined) {
      await Deno.writeTextFile(
        checkpointPath(path),
        typeof value === "string" ? value : JSON.stringify(value),
      )
    }
    await run(path)
  } finally {
    await Deno.remove(dir, { recursive: true })
  }
}

Deno.test("checkpoint v2 starts empty only when the ledger does not exist", async () => {
  await withCheckpoint(undefined, async (path) => {
    assertEquals(await loadCheckpoint(path), null)
    assertEquals(
      await prepareCheckpoint(
        path,
        [{ key: "fields:key", kind: "fields" }],
        workspace,
      ),
      ledger(),
    )
    assertEquals(
      await loadCheckpoint(path),
      null,
      "prepare must not write a ledger",
    )
  })
})

Deno.test("checkpoint v2 retains finite receipts, exact expected fields and unknown evidence", async () => {
  const value = ledger({
    fields: {
      ...completed(),
      expected: {
        title: "Exact _v1_",
        priority: 0,
        assigneeId: null,
        labelIds: ["label-1", "label-2"],
        flag: false,
      },
    },
    noop: { status: "completed", effect: "none", receipt: issue },
    comment: completed({ kind: "comment", id: "comment-1" }),
    attachment: completed({ kind: "attachment", id: "attachment-1" }),
    relation: completed({ kind: "relation", id: "relation-1" }),
    upload: completed(upload),
    failed: {
      status: "failed",
      effect: "none",
      note: "Local validation failed",
    },
    unknown: {
      status: "unknown",
      effect: "unknown",
      data: { response: { id: "possibly-created" } },
    },
    acknowledged: {
      status: "unknown",
      effect: "applied",
      note: "No reliable object receipt",
      data: { success: true },
    },
  })
  await withCheckpoint(
    value,
    async (path) => assertEquals(await loadCheckpoint(path), value),
  )
})

Deno.test("checkpoint v2 resumes matching completed work and retains independently uploaded files", async () => {
  const value = ledger({
    fields: completed(),
    upload: completed(upload),
    comment: { status: "failed", effect: "none", note: "Not sent" },
  })
  await withCheckpoint(value, async (path) => {
    const result = await prepareCheckpoint(path, [
      { key: "fields", kind: "fields" },
      { key: "upload", kind: "upload" },
      { key: "comment", kind: "comment" },
      { key: "new", kind: "relation" },
    ], workspace)
    assertEquals(result, value)
    assertEquals(result.items.upload.receipt, upload)
    assertEquals(Object.hasOwn(result, "createdIdentifiers"), false)
  })
})

Deno.test("checkpoint v2 accepts each execution kind only with its corresponding receipt", async () => {
  const receipts: [string, DeliveryReceipt][] = [
    ["fields", issue],
    ["upload", upload],
    ["comment", { kind: "comment", id: "comment-1" }],
    ["attachment", { kind: "attachment", id: "attachment-1" }],
    ["relation", { kind: "relation", id: "relation-1" }],
  ]
  for (const [kind, receipt] of receipts) {
    await withCheckpoint(ledger({ item: completed(receipt) }), async (path) => {
      assertEquals(
        (await prepareCheckpoint(path, [{ key: "item", kind }], workspace))
          .items.item.receipt,
        receipt,
      )
      await assertRejects(
        () =>
          prepareCheckpoint(path, [{
            key: "item",
            kind: kind === "fields" ? "comment" : "fields",
          }], workspace),
        ValidationError,
        "receipt does not match",
      )
    })
  }
})

Deno.test("checkpoint v2 blocks every unknown outcome even if its key vanished or data looks successful", async () => {
  for (const effect of ["unknown", "applied"] as const) {
    await withCheckpoint(
      ledger({
        old: {
          status: "unknown",
          effect,
          data: { success: true, id: "issue-1", identifier: "ENG-1" },
        },
      }),
      async (path) => {
        for (
          const items of [[{ key: "old", kind: "fields" }], [{
            key: "new",
            kind: "fields",
          }]]
        ) {
          await assertRejects(
            () => prepareCheckpoint(path, items, workspace),
            ValidationError,
            "unresolved unknown outcomes",
          )
        }
      },
    )
  }
})

Deno.test("checkpoint v2 rejects a disappeared completed key and permits removal of unexecuted work", async () => {
  await withCheckpoint(ledger({ original: completed() }), async (path) => {
    await assertRejects(
      () =>
        prepareCheckpoint(path, [{
          key: "edited-or-reordered",
          kind: "fields",
        }], workspace),
      ValidationError,
      "completed entries that no longer match",
    )
  })
  const failed = ledger({ old: { status: "failed", effect: "none" } })
  await withCheckpoint(failed, async (path) => {
    assertEquals(
      await prepareCheckpoint(
        path,
        [{ key: "new", kind: "fields" }],
        workspace,
      ),
      failed,
    )
  })
})

Deno.test("checkpoint v2 rejects a different workspace ID or slug without changing the ledger", async () => {
  await withCheckpoint(ledger({ item: completed() }), async (path) => {
    const original = await Deno.readTextFile(checkpointPath(path))
    for (
      const target of [{ ...workspace, id: "different" }, {
        ...workspace,
        urlKey: "different",
      }]
    ) {
      await assertRejects(
        () =>
          prepareCheckpoint(path, [{ key: "item", kind: "fields" }], target),
        ValidationError,
        "different workspace",
      )
      await assertRejects(
        () => saveCheckpoint(path, { ...ledger(), workspace: target }),
        ValidationError,
        "different workspace",
      )
    }
    assertEquals(await Deno.readTextFile(checkpointPath(path)), original)
  })
})

Deno.test("checkpoint v2 rejects invalid or duplicate execution keys before preparing work", async () => {
  await withCheckpoint(undefined, async (path) => {
    for (
      const items of [
        [{ key: "", kind: "fields" }],
        [{ key: "same", kind: "fields" }, { key: "same", kind: "comment" }],
        [{ key: "item", kind: "script" }],
      ]
    ) {
      await assertRejects(
        () => prepareCheckpoint(path, items, workspace),
        ValidationError,
      )
    }
    await assertRejects(
      () => prepareCheckpoint(path, [], { id: "", urlKey: "test" }),
      ValidationError,
    )
  })
})

Deno.test("checkpoint v2 refuses v1 without migrating, erasing or overwriting old execution records", async () => {
  const old = {
    schemaVersion: 1,
    createdIdentifiers: { "0": "ENG-1" },
    items: { item: { status: "applied" } },
  }
  await withCheckpoint(old, async (path) => {
    const original = await Deno.readTextFile(checkpointPath(path))
    for (
      const read of [
        () => loadCheckpoint(path),
        () => prepareCheckpoint(path, [], workspace),
        () => saveCheckpoint(path, ledger()),
      ]
    ) {
      const error = await assertRejects(
        read,
        ValidationError,
        "schema v1 cannot be resumed",
      )
      assertEquals(
        error.suggestion?.includes(
          "Keep " + checkpointPath(path) + " unchanged",
        ),
        true,
      )
      assertEquals(await Deno.readTextFile(checkpointPath(path)), original)
    }
  })
})

Deno.test("checkpoint v2 does not interpret malformed, incomplete or newer ledgers as empty", async () => {
  for (
    const value of ["{", "", { schemaVersion: 2 }, {
      schemaVersion: 2,
      workspace,
    }, { ...ledger(), schemaVersion: 3 }]
  ) {
    await withCheckpoint(value, async (path) => {
      const original = await Deno.readTextFile(checkpointPath(path))
      await assertRejects(() => loadCheckpoint(path), ValidationError)
      await assertRejects(() => saveCheckpoint(path, ledger()), ValidationError)
      assertEquals(await Deno.readTextFile(checkpointPath(path)), original)
    })
  }
})

Deno.test("checkpoint v2 rejects invalid status, effect, receipt and evidence combinations", async () => {
  const invalid = [
    { status: "applied", effect: "applied", receipt: issue },
    { status: "skipped", effect: "none" },
    { status: "unattempted", effect: "none" },
    { status: "completed", effect: "applied" },
    { status: "completed", effect: "unknown", receipt: issue },
    { status: "failed", effect: "applied" },
    { status: "failed", effect: "none", receipt: issue },
    { status: "unknown", effect: "none" },
    { status: "unknown", effect: "applied", receipt: issue },
    {
      status: "completed",
      effect: "applied",
      receipt: issue,
      data: { success: true },
    },
    { status: "failed", effect: "none", data: { success: false } },
    { status: "unknown", effect: "unknown", expected: { title: "New" } },
    {
      status: "completed",
      effect: "applied",
      receipt: { kind: "comment", id: "comment-1" },
      expected: { body: "New" },
    },
    {
      status: "completed",
      effect: "applied",
      receipt: issue,
      expected: { invalid: [1] },
    },
    {
      status: "completed",
      effect: "applied",
      receipt: issue,
      expected: { invalid: {} },
    },
  ]
  for (const item of invalid) {
    await withCheckpoint({ ...ledger(), items: { item } }, async (path) => {
      await assertRejects(() => loadCheckpoint(path), ValidationError)
    })
  }
})

Deno.test("checkpoint v2 rejects malformed receipts instead of accepting partial identities or uploads", async () => {
  for (
    const receipt of [
      { kind: "issue", id: "issue-1" },
      { kind: "issue", id: "", identifier: "ENG-1" },
      { kind: "comment", id: "" },
      { kind: "attachment" },
      { kind: "relation" },
      { ...upload, assetUrl: "not-a-url" },
      { ...upload, size: -1 },
      { ...upload, size: 1.5 },
      { ...upload, public: "false" },
      { ...upload, contentType: "" },
      { ...upload, filename: "" },
    ]
  ) {
    await withCheckpoint({
      ...ledger(),
      items: { item: { status: "completed", effect: "applied", receipt } },
    }, async (path) => {
      await assertRejects(
        () => loadCheckpoint(path),
        ValidationError,
        "receipt",
      )
    })
  }
})

Deno.test("checkpoint v2 rejects unsupported fields and never silently drops an execution key", async () => {
  for (
    const value of [
      { ...ledger(), createdIdentifiers: {} },
      { ...ledger(), manifestSha256: "unused" },
      { ...ledger(), retryAll: true },
      {
        ...ledger(),
        items: { item: { status: "failed", effect: "none", retry: true } },
      },
      '{"schemaVersion":2,"workspace":{"id":"workspace-1","urlKey":"test"},"items":{"__proto__":{"status":"unknown","effect":"unknown"}}}',
      '{"schemaVersion":2,"workspace":{"id":"workspace-1","urlKey":"test"},"items":{"fields":{"status":"completed","effect":"applied","receipt":{"kind":"issue","id":"issue-1","identifier":"ENG-1"},"expected":{"constructor":"must not disappear"}}}}',
    ]
  ) {
    await withCheckpoint(value, async (path) => {
      await assertRejects(() => loadCheckpoint(path), ValidationError)
    })
  }
})

Deno.test("checkpoint v2 save cannot erase unknown work or discard completed effects", async () => {
  for (
    const item of [
      completed(),
      { status: "unknown", effect: "unknown" } as const,
    ]
  ) {
    await withCheckpoint(ledger({ item }), async (path) => {
      const before = await Deno.readTextFile(checkpointPath(path))
      await assertRejects(
        () => saveCheckpoint(path, ledger()),
        ValidationError,
        "Cannot discard",
      )
      assertEquals(await Deno.readTextFile(checkpointPath(path)), before)
    })
  }
  await withCheckpoint(ledger({ item: completed() }), async (path) => {
    await assertRejects(
      () =>
        saveCheckpoint(
          path,
          ledger({ item: { status: "failed", effect: "none" } }),
        ),
      ValidationError,
      "Cannot discard or downgrade",
    )
  })
})

Deno.test("checkpoint v2 atomically installs a synced file and round-trips completion", async () => {
  await withCheckpoint(
    ledger({ item: { status: "unknown", effect: "unknown" } }),
    async (path) => {
      const before = await Deno.readTextFile(checkpointPath(path))
      const events: string[] = []
      const sync = Deno.FsFile.prototype.sync
      const rename = Deno.rename
      const syncStub = stub(
        Deno.FsFile.prototype,
        "sync",
        function (this: Deno.FsFile) {
          events.push("sync")
          return sync.call(this)
        },
      )
      const renameStub = stub(Deno, "rename", async (from, to) => {
        assertEquals(events, ["sync"], "file must be synced before rename")
        assertEquals(dirname(String(from)), dirname(checkpointPath(path)))
        assertEquals(String(to), checkpointPath(path))
        assertEquals(
          await Deno.readTextFile(checkpointPath(path)),
          before,
          "old ledger survives until replacement",
        )
        events.push("rename")
        await rename(from, to)
      })
      try {
        await saveCheckpoint(path, ledger({ item: completed() }))
      } finally {
        renameStub.restore()
        syncStub.restore()
      }
      assertEquals(events, ["sync", "rename"])
      assertEquals(await loadCheckpoint(path), ledger({ item: completed() }))
      assertEquals(
        (await Array.fromAsync(Deno.readDir(dirname(path)))).map((entry) =>
          entry.name
        ),
        ["delivery.json.checkpoint.json"],
      )
    },
  )
})

Deno.test("checkpoint v2 sync or rename failure preserves the existing file and removes the temporary file", async () => {
  for (const phase of ["sync", "rename"] as const) {
    await withCheckpoint(ledger(), async (path) => {
      const before = await Deno.readTextFile(checkpointPath(path))
      const failure = new Deno.errors.PermissionDenied(`${phase} denied`)
      const intercept = phase === "sync"
        ? stub(Deno.FsFile.prototype, "sync", () => Promise.reject(failure))
        : stub(Deno, "rename", () => Promise.reject(failure))
      try {
        await assertRejects(
          () =>
            saveCheckpoint(
              path,
              ledger({ item: { status: "unknown", effect: "unknown" } }),
            ),
          Deno.errors.PermissionDenied,
          `${phase} denied`,
        )
      } finally {
        intercept.restore()
      }
      assertEquals(await Deno.readTextFile(checkpointPath(path)), before)
      assertEquals(
        (await Array.fromAsync(Deno.readDir(dirname(path)))).map((entry) =>
          entry.name
        ),
        ["delivery.json.checkpoint.json"],
      )
    })
  }
})

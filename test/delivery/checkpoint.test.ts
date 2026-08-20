import { assertEquals, assertRejects } from "@std/assert"
import { join } from "@std/path"
import {
  checkpointPath,
  loadCheckpoint,
} from "../../src/delivery/checkpoint.ts"
import { ValidationError } from "../../src/utils/errors.ts"

async function withCheckpoint(
  value: unknown,
  run: (manifestPath: string) => Promise<void>,
): Promise<void> {
  const dir = await Deno.makeTempDir()
  try {
    const manifestPath = join(dir, "delivery.json")
    await Deno.writeTextFile(
      checkpointPath(manifestPath),
      typeof value === "string" ? value : JSON.stringify(value),
    )
    await run(manifestPath)
  } finally {
    await Deno.remove(dir, { recursive: true })
  }
}

Deno.test("checkpoint accepts only persisted item statuses", async () => {
  await withCheckpoint({
    schemaVersion: 1,
    manifestSha256: "abc",
    createdIdentifiers: { "0": "DATA-1" },
    items: {
      applied: { status: "applied" },
      failed: { status: "failed", note: "retryable" },
      unknown: { status: "unknown" },
    },
  }, async (manifestPath) => {
    const checkpoint = await loadCheckpoint(manifestPath)
    assertEquals(checkpoint?.items, {
      applied: { status: "applied" },
      failed: { status: "failed", note: "retryable" },
      unknown: { status: "unknown" },
    })
  })
})

Deno.test("checkpoint rejects output-only item statuses", async () => {
  for (const status of ["skipped", "unattempted"]) {
    await withCheckpoint({
      schemaVersion: 1,
      manifestSha256: "abc",
      createdIdentifiers: {},
      items: { item: { status } },
    }, async (manifestPath) => {
      await assertRejects(
        () => loadCheckpoint(manifestPath),
        ValidationError,
        "items.item.status",
      )
    })
  }
})

Deno.test("checkpoint rejects malformed JSON and incomplete shapes", async () => {
  await withCheckpoint("{", async (manifestPath) => {
    await assertRejects(
      () => loadCheckpoint(manifestPath),
      ValidationError,
      "not valid JSON",
    )
  })
  await withCheckpoint({ schemaVersion: 1 }, async (manifestPath) => {
    await assertRejects(
      () => loadCheckpoint(manifestPath),
      ValidationError,
      "manifestSha256",
    )
  })
})

Deno.test("checkpoint rejects unknown fields", async () => {
  await withCheckpoint({
    schemaVersion: 1,
    manifestSha256: "abc",
    createdIdentifiers: {},
    items: {},
    retryAll: true,
  }, async (manifestPath) => {
    await assertRejects(
      () => loadCheckpoint(manifestPath),
      ValidationError,
      "retryAll",
    )
  })
})

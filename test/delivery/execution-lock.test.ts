import { assertEquals, assertRejects, assertThrows } from "@std/assert"
import { join } from "@std/path"
import { stub } from "@std/testing/mock"
import {
  checkpointPath,
  loadCheckpoint,
} from "../../src/delivery/checkpoint.ts"
import { applyManifest, type ApplyOutcome } from "../../src/delivery/engine.ts"
import { loadManifest } from "../../src/delivery/manifest.ts"
import { ValidationError } from "../../src/utils/errors.ts"
import { create, fixture, manifest, WORKSPACE } from "./fixture.ts"

// Deadlines diagnose broken synchronization; test ordering never uses sleeps.
async function bounded<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("Lock test timed out")),
          10000,
        )
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

function observeNextLock() {
  const attempted = Promise.withResolvers<void>()
  const nativeLock = Deno.FsFile.prototype.lock
  let acquired = false
  const intercept = stub(
    Deno.FsFile.prototype,
    "lock",
    async function (this: Deno.FsFile, exclusive?: boolean) {
      const pending = nativeLock.call(this, exclusive)
      attempted.resolve()
      await pending
      acquired = true
    },
  )
  return {
    attempted: attempted.promise,
    get acquired() {
      return acquired
    },
    restore: () => intercept.restore(),
  }
}

Deno.test("delivery lock serializes independent apply handles before ledger loading and through verification", async () => {
  const preparing = Promise.withResolvers<void>()
  const allowPreparation = Promise.withResolvers<void>()
  const verifying = Promise.withResolvers<void>()
  const allowVerification = Promise.withResolvers<void>()
  let organizations = 0
  const f = await fixture({
    issues: [],
    overrides: (state) => [{
      queryName: "GetDeliveryOrganization",
      response: async () => {
        if (++organizations === 1) {
          preparing.resolve()
          await allowPreparation.promise
        }
        return { data: { organization: WORKSPACE } }
      },
    }, {
      queryName: "GetIssueForWrite",
      response: async ({ variables }) => {
        verifying.resolve()
        await allowVerification.promise
        return {
          data: { organization: WORKSPACE, issue: state.find(variables.id) },
        }
      },
    }],
  })
  const runs: Promise<ApplyOutcome>[] = []
  let observer: ReturnType<typeof observeNextLock> | undefined
  try {
    const loaded = await f.load(manifest([{
      ...create(),
      comments: [{ body: "Write once" }],
    }]))
    // A symlinked directory and the original name resolve to one ledger and
    // lock inode without moving an existing ledger to a new canonical name.
    const alias = join(f.dir, "alias")
    await Deno.symlink(f.dir, alias, {
      type: Deno.build.os === "windows" ? "junction" : "dir",
    })
    const aliased = await loadManifest(join(alias, ".", "delivery.json"))
    runs.push(applyManifest({ loaded }))
    await bounded(preparing.promise)
    assertEquals(await loadCheckpoint(f.path), null)
    using probe = await Deno.open(`${checkpointPath(f.path)}.lock`, {
      read: true,
      write: true,
    })
    const inode = (await probe.stat()).ino
    assertEquals(await probe.tryLock(true), false)
    observer = observeNextLock()
    runs.push(applyManifest({ loaded: aliased }))
    await bounded(observer.attempted)
    assertEquals(observer.acquired, false)
    assertEquals(organizations, 1)
    allowPreparation.resolve()
    await bounded(verifying.promise)
    assertEquals(
      Object.values((await loadCheckpoint(f.path))!.items).map((item) =>
        item.status
      ),
      ["completed", "completed"],
    )
    assertEquals(observer.acquired, false, "retain lock during read-back")
    assertEquals(await probe.tryLock(true), false)
    allowVerification.resolve()
    const [first, second] = await bounded(Promise.all(runs))
    assertEquals(first.status, "completed")
    assertEquals(first.summary.applied, 2)
    assertEquals(second.status, "completed")
    assertEquals(second.summary.skipped, 2)
    assertEquals(f.mutations().length, 2)
    assertEquals(f.state.issues.size, 1)
    assertEquals(f.state.comments.size, 1)
    assertEquals(await probe.tryLock(true), true, "completion releases lock")
    const retained = await Deno.stat(`${checkpointPath(f.path)}.lock`)
    assertEquals(retained.ino, inode, "lock sidecar must never be replaced")
    assertEquals(retained.size, 0)
  } finally {
    allowPreparation.resolve()
    allowVerification.resolve()
    await Promise.allSettled(runs)
    observer?.restore()
    await f.cleanup()
  }
})

for (const outcome of ["completed", "unconfirmed", "terminated"] as const) {
  Deno.test(`delivery lock preserves ${outcome} process outcomes for the waiting apply`, async () => {
    const dispatched = Promise.withResolvers<void>()
    const allowResponse = Promise.withResolvers<void>()
    const f = await fixture({
      issues: [],
      overrides: (state) => [{
        queryName: "CreateIssue",
        response: async ({ variables }) => {
          const created = state.newIssue(
            variables.input as Record<string, unknown>,
          )
          dispatched.resolve()
          await allowResponse.promise
          return {
            data: {
              issueCreate: {
                success: true,
                issue: outcome === "unconfirmed" ? { id: created.id } : created,
              },
            },
          }
        },
      }],
    })
    let child: Deno.ChildProcess | undefined
    let output: Promise<Deno.CommandOutput> | undefined
    let exited = false
    let observer: ReturnType<typeof observeNextLock> | undefined
    let waiting: Promise<unknown> | undefined
    try {
      const loaded = await f.load(manifest([{
        ...create(),
        comments: [{ body: "Must not be sent after unknown" }],
      }]))
      // Only the process boundary differs: this executes the production apply,
      // with the same fixture server and on-disk manifest as the waiting call.
      const code = `
        import { applyManifest } from ${
        JSON.stringify(new URL("../../src/delivery/engine.ts", import.meta.url))
      };
        import { loadManifest } from ${
        JSON.stringify(
          new URL("../../src/delivery/manifest.ts", import.meta.url),
        )
      };
        console.log(JSON.stringify(await applyManifest({
          loaded: await loadManifest(Deno.args[0])
        })));
      `
      child = new Deno.Command(Deno.execPath(), {
        args: ["eval", "--quiet", code, f.path],
        env: {
          LINEAR_API_KEY: "test-token",
          LINEAR_GRAPHQL_ENDPOINT: f.server.getEndpoint(),
        },
        stdin: "null",
        stdout: "piped",
        stderr: "piped",
      }).spawn()
      output = child.output().then((result) => {
        exited = true
        return result
      })
      await bounded(dispatched.promise)
      assertEquals(
        Object.values((await loadCheckpoint(f.path))!.items)[0].status,
        "unknown",
      )
      using probe = await Deno.open(`${checkpointPath(f.path)}.lock`, {
        read: true,
        write: true,
      })
      assertEquals(await probe.tryLock(true), false)
      observer = observeNextLock()
      waiting = outcome === "completed"
        ? applyManifest({ loaded }).then((result) => {
          assertEquals(result.status, "completed")
          assertEquals(result.summary.skipped, 2)
        })
        : assertRejects(
          () => applyManifest({ loaded, continueOnFailure: true }),
          ValidationError,
          "unresolved unknown outcomes",
        )
      await bounded(observer.attempted)
      assertEquals(observer.acquired, false)
      if (outcome === "terminated") child.kill("SIGKILL")
      else allowResponse.resolve()
      const result = await bounded(output)
      assertEquals(
        result.success,
        outcome !== "terminated",
        new TextDecoder().decode(result.stderr),
      )
      if (outcome !== "terminated") {
        assertEquals(
          JSON.parse(new TextDecoder().decode(result.stdout)).status,
          outcome === "completed" ? "completed" : "stopped-on-unknown",
        )
      }
      allowResponse.resolve()
      await bounded(waiting)
      assertEquals(f.mutations().length, outcome === "completed" ? 2 : 1)
      assertEquals(f.state.issues.size, 1)
      assertEquals(f.state.comments.size, outcome === "completed" ? 1 : 0)
      assertEquals(
        Object.values((await loadCheckpoint(f.path))!.items)[0].status,
        outcome === "completed" ? "completed" : "unknown",
      )
      assertEquals(
        await probe.tryLock(true),
        true,
        "return or throw releases lock",
      )
    } finally {
      allowResponse.resolve()
      if (child != null && !exited) child.kill("SIGKILL")
      await Promise.allSettled([output, waiting])
      observer?.restore()
      await f.cleanup()
    }
  })
}

Deno.test("delivery lock acquisition failure closes the handle without reading the ledger or dispatching", async () => {
  const f = await fixture()
  let handle: Deno.FsFile | undefined
  const intercept = stub(
    Deno.FsFile.prototype,
    "lock",
    function (this: Deno.FsFile) {
      handle = this
      return Promise.reject(new Deno.errors.NotSupported("Lock unavailable"))
    },
  )
  try {
    const loaded = await f.load(manifest([create()]))
    await assertRejects(
      () => applyManifest({ loaded }),
      Deno.errors.NotSupported,
      "Lock unavailable",
    )
    assertThrows(() => handle!.statSync(), Deno.errors.BadResource)
    assertEquals(await loadCheckpoint(f.path), null)
    assertEquals(f.server.graphqlRequests.length, 0)
  } finally {
    intercept.restore()
    await f.cleanup()
  }
})

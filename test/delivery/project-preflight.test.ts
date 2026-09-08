import { assertEquals, assertStringIncludes } from "@std/assert"
import { join } from "@std/path"
import {
  applyManifest,
  type CommandResult,
  type CommandRunner,
  planManifest,
} from "../../src/delivery/engine.ts"
import { loadManifest } from "../../src/delivery/manifest.ts"

async function writeManifest(dir: string, manifest: unknown): Promise<string> {
  const path = join(dir, "delivery.json")
  await Deno.writeTextFile(path, JSON.stringify(manifest))
  return path
}

function fakeRunner(
  handler: (args: string[]) => CommandResult | undefined,
): CommandRunner & { calls: string[][] } {
  const calls: string[][] = []
  return {
    calls,
    run(args) {
      if (args[0] === "auth") {
        return Promise.resolve({
          code: 0,
          stdout: '{"organization":{"urlKey":"jihuanshe"}}',
          stderr: "",
        })
      }
      calls.push(args)
      return Promise.resolve(
        handler(args) ??
          {
            code: 0,
            stdout: JSON.stringify({ identifier: args[2], project: null }),
            stderr: "",
          },
      )
    },
  }
}

for (const operation of ["create", "update"] as const) {
  for (const compatible of [true, false]) {
    Deno.test(`delivery project preflight ${operation}: compatible=${compatible}`, async () => {
      const dir = await Deno.makeTempDir()
      try {
        const path = await writeManifest(dir, {
          schemaVersion: 1,
          workspace: "jihuanshe",
          issues: [
            operation === "create"
              ? {
                operation,
                team: "DATA",
                set: { title: "Title", project: "Release" },
              }
              : {
                operation,
                identifier: "DATA-606",
                set: { project: "Release" },
                base: { project: null },
              },
          ],
        })
        let written = false
        const runner = fakeRunner((args) => {
          if (["create", "update"].includes(args[1])) written = true
          if (args[1] === "view") {
            return {
              code: 0,
              stdout: JSON.stringify({
                identifier: args[2],
                title: "Title",
                project: written ? { id: "p1", name: "Release" } : null,
              }),
              stderr: "",
            }
          }
          if (args[0] === "project") {
            return {
              code: 0,
              stdout: JSON.stringify({
                id: "p1",
                name: "Release",
                teams: {
                  nodes: compatible ? [{ key: "DATA" }] : [{ key: "OPS" }],
                  pageInfo: { hasNextPage: false },
                },
              }),
              stderr: "",
            }
          }
          if (args[1] === "create") {
            return {
              code: 0,
              stdout: '{"issue":{"identifier":"DATA-700"}}',
              stderr: "",
            }
          }
          return undefined
        })
        const loaded = await loadManifest(path)
        const plan = await planManifest({ loaded, runner })
        assertEquals(plan.status, compatible ? "ready" : "conflict")
        assertEquals(
          runner.calls.some((args) => ["create", "update"].includes(args[1])),
          false,
        )
        const result = await applyManifest({ loaded, runner })
        assertEquals(
          result.status,
          compatible ? "completed" : "stopped-on-failure",
        )
        assertEquals(
          runner.calls.filter((args) => ["create", "update"].includes(args[1]))
            .length,
          compatible ? 1 : 0,
        )
        if (!compatible) {
          assertStringIncludes(result.items[0].detail ?? "", "does not belong")
          assertEquals(
            result.items.some((item) => item.status === "unknown"),
            false,
          )
        }
      } finally {
        await Deno.remove(dir, { recursive: true })
      }
    })
  }
}

/**
 * Conformance runner outcomes that no case can observe: what --update keeps
 * failing, bindings, readbacks, unreported live leftovers, empty filters and
 * the live workspace check. A stub executable stands in for `linear`, so
 * nothing here reaches Linear.
 */
import { assert, assertEquals, assertStringIncludes } from "@std/assert"
import { join } from "@std/path"
import { parseCase } from "../../conformance/runner/case.ts"
import { runCase, type RunOptions } from "../../conformance/runner/run.ts"

const repo = new URL("../..", import.meta.url).pathname
const world = JSON.parse(
  Deno.readTextFileSync(join(repo, "conformance/world.json")),
)
const SEED = JSON.stringify({
  Issue: [{
    id: "1a000000-0000-4000-8000-000000000001",
    identifier: "ENG-7",
    number: 7,
    team: "0c000000-0000-4000-8000-000000000001",
    state: "0d000000-0000-4000-8000-000000000002",
    title: "Old title",
    labels: [],
  }],
})

/**
 * `linear echo ...` prints its arguments, `linear sleep` hangs, `linear hang`
 * prints "ok" and exits 0 once terminated,
 * `linear auth whoami --json` reports the workspace named by LINEAR_API_KEY,
 * and anything else fails.
 */
const STUB = `#!/bin/sh
case "$1" in
  echo) shift; echo "$@" ;;
  sleep) exec sleep 10 ;;
  hang) trap 'exit 0' TERM; echo ok; sleep 10 >/dev/null 2>&1 & wait ;;
  auth) printf '{"organization":{"name":"%s","urlKey":"%s"}}\\n' "$LINEAR_API_KEY" "$LINEAR_API_KEY" ;;
  *) exit 1 ;;
esac
`

async function withStub(
  run: (dir: string, binary: string) => Promise<void>,
): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "conformance-runner-test-" })
  const binary = join(dir, "linear")
  await Deno.writeTextFile(binary, STUB)
  await Deno.chmod(binary, 0o755)
  try {
    await run(dir, binary)
  } finally {
    await Deno.remove(dir, { recursive: true })
  }
}

async function runText(
  dir: string,
  binary: string,
  text: string,
  options: Partial<RunOptions> = {},
) {
  const path = join(dir, "case.txtar")
  await Deno.writeTextFile(path, text)
  const result = await runCase(parseCase(path, "case", text), {
    binary,
    world,
    vars: { TEAM: "ENG", RUN: "zrun" },
    update: false,
    timeoutMs: 10_000,
    ...options,
  })
  return { result, after: await Deno.readTextFile(path) }
}

Deno.test("conformance runner - --update rewrites streams but keeps other failures failing", async () => {
  await withStub(async (dir, binary) => {
    const mixed = await runText(
      dir,
      binary,
      `-- run --\nlinear echo hi\n-- stdout --\nwrong\n-- mutations.json --\n{"issueUpdate": 1}\n`,
      { update: true },
    )
    assertEquals(mixed.result.status, "fail")
    assertStringIncludes(mixed.after, "-- stdout --\nhi\n")

    const streamOnly = await runText(
      dir,
      binary,
      `-- run --\nlinear echo hi\n-- stdout --\nwrong\n`,
      { update: true },
    )
    assertEquals(streamOnly.result.status, "pass")
    assertStringIncludes(streamOnly.after, "-- stdout --\nhi\n")

    const timeout = `-- run --\nlinear sleep\n-- stdout --\nwrong\n`
    const timedOut = await runText(dir, binary, timeout, {
      update: true,
      timeoutMs: 200,
    })
    assertEquals(timedOut.result.status, "fail")
    assertEquals(timedOut.after, timeout)
  })
})

Deno.test("conformance runner - state.json bindings reach later steps", async () => {
  await withStub(async (dir, binary) => {
    const { result } = await runText(
      dir,
      binary,
      `-- seed.json --\n${SEED}\n-- run --\nlinear echo first\n-- stdout --\nfirst\n-- state.json --\n{"Issue": [{"identifier": "{{=KEY}}"}]}\n-- run --\nlinear echo {{KEY}}\n-- stdout --\nENG-7\n`,
    )
    assertEquals(result.status, "pass", result.messages.join("\n"))
  })
})

Deno.test("conformance runner - readbacks check what cleanup left", async () => {
  await withStub(async (dir, binary) => {
    const base =
      `-- run --\nlinear echo ISSUE-1\n-- stdout --\n{{=ISSUE}}\n-- cleanup --\nlinear echo deleted\n`
    const matches = await runText(
      dir,
      binary,
      `${base}-- readback --\nlinear echo gone {{ISSUE}}\n-- stdout --\ngone ISSUE-1\n`,
    )
    assertEquals(matches.result.status, "pass")
    for (
      const readback of [
        `-- readback --\nlinear echo gone {{ISSUE}}\n-- stdout --\nstill there\n`,
        `-- readback --\nlinear echo gone {{TYPO}}\n-- stdout --\n{{*}}\n`,
      ]
    ) {
      const { result } = await runText(dir, binary, base + readback)
      assertEquals(result.status, "fail", readback)
      assertStringIncludes(result.messages.join("\n"), "readback")
    }
    // Matching output and exit code do not count once the readback timed out.
    const hung = await runText(
      dir,
      binary,
      `-- run --\nlinear echo hi\n-- stdout --\nhi\n-- readback --\nlinear hang\n-- stdout --\nok\n`,
      { timeoutMs: 300 },
    )
    assertEquals(hung.result.status, "fail")
    assertStringIncludes(hung.result.messages.join("\n"), "timed out")
  })
})

Deno.test("conformance runner - live cleanup that cannot run is reported with the run prefix", async () => {
  await withStub(async (dir, binary) => {
    const { result } = await runText(
      dir,
      binary,
      `live: true\n-- run --\nlinear create\n-- stdout.json --\n{"id": "{{=ISSUE}}"}\n-- cleanup --\nlinear delete {{ISSUE}}\n`,
      { live: { apiKey: "stub" } },
    )
    assertEquals(result.status, "fail")
    const messages = result.messages.join("\n")
    assertStringIncludes(messages, "cleanup skipped")
    assertStringIncludes(messages, "zrun")
  })
})

async function runMain(args: string[], env: Record<string, string> = {}) {
  const output = await new Deno.Command(Deno.execPath(), {
    args: ["run", "--allow-all", "conformance/runner/main.ts", ...args],
    cwd: repo,
    // Only what the runner needs; no Linear credential from the caller.
    env: {
      PATH: Deno.env.get("PATH") ?? "",
      HOME: Deno.env.get("HOME") ?? "",
      ...env,
    },
    clearEnv: true,
    stdout: "piped",
    stderr: "piped",
  }).output()
  return { code: output.code, stderr: new TextDecoder().decode(output.stderr) }
}

Deno.test("conformance runner - a filter that selects no cases fails", async () => {
  await withStub(async (_dir, binary) => {
    const { code, stderr } = await runMain([
      "--binary",
      binary,
      "--filter",
      "no-such-case",
    ])
    assertEquals(code, 2)
    assertStringIncludes(stderr, "selects no cases")
  })
})

Deno.test("conformance runner - live runs refuse any workspace but Kadoraba", async () => {
  await withStub(async (_dir, binary) => {
    // The stub reports the workspace named by the key it receives, so this
    // credential belongs to "other" and the caller names that workspace.
    const named = await runMain(["--binary", binary, "--live", "other"], {
      LINEAR_KADORABA_API_KEY: "other",
    })
    assertEquals(named.code, 2)
    const reported = await runMain(["--binary", binary, "--live", "kadoraba"], {
      LINEAR_KADORABA_API_KEY: "other",
    })
    assertEquals(reported.code, 2)
    assert(reported.stderr.includes("reports workspace other"))
  })
})

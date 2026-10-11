/**
 * Run the conformance cases against a `linear` executable.
 *
 *   deno run -A conformance/runner/main.ts --binary /abs/path/linear
 *   ... --filter issue/ --jobs 4 --update
 *   ... --live kadoraba   (real API; needs LINEAR_KADORABA_API_KEY)
 */
import { parseArgs } from "@std/cli/parse-args"
import { expandGlob } from "@std/fs/expand-glob"
import { join, relative, resolve } from "@std/path"
import { type Case, parseCase } from "./case.ts"
import { type CaseResult, runCase, type RunOptions } from "./run.ts"

const root = resolve(import.meta.dirname!, "..")

const args = parseArgs(Deno.args, {
  string: ["binary", "filter", "jobs", "live", "timeout"],
  boolean: ["update", "verbose"],
})
if (args.binary == null) {
  console.error(
    "usage: main.ts --binary <path> [--filter <text>] [--jobs <n>] [--update] [--live <workspace-url-key>]",
  )
  Deno.exit(2)
}
const binary = resolve(args.binary)

const cases: Case[] = []
for await (const entry of expandGlob("cases/**/*.txtar", { root })) {
  const name = relative(join(root, "cases"), entry.path).replace(/\.txtar$/, "")
  if (args.filter != null && !name.includes(args.filter)) continue
  cases.push(parseCase(entry.path, name, await Deno.readTextFile(entry.path)))
}
cases.sort((a, b) => a.name.localeCompare(b.name))

const options: RunOptions = {
  binary,
  world: JSON.parse(await Deno.readTextFile(join(root, "world.json"))),
  vars: { TEAM: "ENG", RUN: "zrun" },
  update: args.update,
  timeoutMs: Number(args.timeout ?? 30_000),
}

if (args.live != null) {
  const apiKey = Deno.env.get("LINEAR_KADORABA_API_KEY")
  if (apiKey == null || apiKey === "") {
    console.error("--live needs LINEAR_KADORABA_API_KEY")
    Deno.exit(2)
  }
  // Confirm the workspace with the exact executable before any write.
  const home = await Deno.makeTempDir()
  const whoami = await new Deno.Command(binary, {
    args: ["auth", "whoami", "--json"],
    env: {
      PATH: Deno.env.get("PATH") ?? "",
      HOME: home,
      LINEAR_API_KEY: apiKey,
    },
    clearEnv: true,
  }).output()
  await Deno.remove(home, { recursive: true })
  const urlKey = whoami.code === 0
    ? JSON.parse(new TextDecoder().decode(whoami.stdout)).organization?.urlKey
    : undefined
  if (urlKey !== args.live) {
    console.error(
      `refusing live run: executable reports workspace ${
        urlKey ?? "(none)"
      }, expected ${args.live}`,
    )
    Deno.exit(2)
  }
  options.live = { apiKey }
  options.vars.RUN = `cf${Date.now().toString(36)}`
  options.update = false
}

const jobs = Number(
  args.jobs ?? (args.live != null ? 4 : navigator.hardwareConcurrency),
)
const results: CaseResult[] = []
let next = 0
const started = performance.now()
await Promise.all(
  Array.from({ length: Math.max(1, jobs) }, async () => {
    while (next < cases.length) {
      const testCase = cases[next++]
      let result: CaseResult
      try {
        result = await runCase(testCase, options)
      } catch (error) {
        result = {
          name: testCase.name,
          status: "fail",
          messages: [String((error as Error).stack ?? error)],
          durationMs: 0,
        }
      }
      results.push(result)
      const mark =
        { pass: "ok  ", fail: "FAIL", skip: "skip", gap: "GAP " }[result.status]
      if (result.status !== "pass" || args.verbose || result.updated) {
        console.log(`${mark} ${result.name} (${result.durationMs}ms)`)
        for (const message of result.messages) {
          console.log(message.replace(/^/gm, "     "))
        }
      }
    }
  }),
)

const count = (status: CaseResult["status"]) =>
  results.filter((r) => r.status === status).length
console.log(
  `\n${count("pass")} passed, ${count("fail")} failed, ${
    count("gap")
  } fake gaps, ${count("skip")} skipped (${cases.length} cases, ${jobs} jobs, ${
    ((performance.now() - started) / 1000).toFixed(1)
  }s)`,
)
Deno.exit(count("fail") + count("gap") > 0 ? 1 : 0)

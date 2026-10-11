/**
 * Execute one case against a CLI executable.
 *
 * Offline, every case gets its own fake Linear seeded with world.json plus the
 * case's seed. Live, the executable talks to the real API with the experiment
 * credential, and offline-only assertions (state, mutation counts, request
 * counts) are skipped.
 */
import { join } from "@std/path"
import { API_KEY, FakeLinear, type FaultRule } from "../fake-linear/server.ts"
import { type Seed, Store } from "../fake-linear/store.ts"
import { type Case, formatTxtar, type Section, type Step } from "./case.ts"
import {
  lineDiff,
  matchJson,
  matchText,
  substitute,
  type Vars,
} from "./match.ts"

export interface RunOptions {
  binary: string
  world: Seed
  live?: { apiKey: string }
  vars: Vars
  update: boolean
  timeoutMs: number
}

export interface CaseResult {
  name: string
  status: "pass" | "fail" | "skip" | "gap"
  messages: string[]
  durationMs: number
  updated?: boolean
}

interface Output {
  code: number
  stdout: string
  stderr: string
  timedOut: boolean
}

const decoder = new TextDecoder()

async function execute(
  options: RunOptions,
  argv: string[],
  env: Record<string, string>,
  cwd: string,
  stdin: string | undefined,
): Promise<Output> {
  const signal = AbortSignal.timeout(options.timeoutMs)
  const child = new Deno.Command(options.binary, {
    args: argv,
    cwd,
    env,
    clearEnv: true,
    stdin: "piped",
    stdout: "piped",
    stderr: "piped",
    signal,
  }).spawn()
  const writer = child.stdin.getWriter()
  try {
    if (stdin != null) await writer.write(new TextEncoder().encode(stdin))
  } catch { /* the executable may exit without reading stdin */ }
  await writer.close().catch(() => {})
  const output = await child.output()
  return {
    code: output.code,
    stdout: decoder.decode(output.stdout),
    stderr: decoder.decode(output.stderr),
    timedOut: signal.aborted,
  }
}

function trimFinalNewline(text: string): string {
  return text.endsWith("\n") ? text.slice(0, -1) : text
}

/** Compare one stream; return bindings, or an error message. */
function checkStream(
  label: string,
  section: Section | undefined,
  actual: string,
  vars: Vars,
): Vars | string {
  if (section == null) {
    return actual === "" ? {} : `${label} should be empty, got:\n${actual}`
  }
  if (section.name.endsWith(".json")) {
    let parsed: unknown
    try {
      parsed = JSON.parse(actual)
    } catch {
      return `${label} is not one JSON document:\n${actual}`
    }
    const result = matchJson(JSON.parse(section.content), parsed, vars)
    if ("path" in result) {
      return `${label} at ${result.path}: ${result.message}\n${actual}`
    }
    return result.bindings
  }
  const expected = trimFinalNewline(section.content)
  const bindings = matchText(expected, trimFinalNewline(actual), vars)
  if (bindings == null) {
    let shown = expected
    try {
      shown = substitute(expected, vars)
    } catch { /* show the raw pattern */ }
    return `${label} differs:\n${lineDiff(shown, trimFinalNewline(actual))}`
  }
  return bindings
}

/** Compare the fake's records; return bindings, or an error message. */
function checkState(
  pattern: string,
  snapshot: Seed,
  vars: Vars,
): Vars | string {
  const expected = JSON.parse(substitute(pattern, vars)) as Record<
    string,
    unknown[]
  >
  const bindings: Vars = {}
  for (const [typename, records] of Object.entries(expected)) {
    const open = records.map((record) => ({
      "...": true,
      ...(record as object),
    }))
    const result = matchJson(
      open,
      snapshot[typename] ?? [],
      { ...vars, ...bindings },
      typename,
    )
    if ("path" in result) return `state ${result.path}: ${result.message}`
    Object.assign(bindings, result.bindings)
  }
  return bindings
}

function childEnv(
  options: RunOptions,
  home: string,
  endpoint: string | undefined,
  extra: Record<string, string>,
  vars: Vars,
): Record<string, string> {
  const env: Record<string, string> = {
    PATH: Deno.env.get("PATH") ?? "/usr/bin:/bin",
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: join(home, ".config"),
    TMPDIR: join(home, "tmp"),
    TZ: "UTC",
    LANG: "C.UTF-8",
    NO_COLOR: "1",
    TERM: "dumb",
    LINEAR_API_KEY: options.live?.apiKey ?? API_KEY,
  }
  if (endpoint != null) env.LINEAR_GRAPHQL_ENDPOINT = endpoint
  for (const [key, value] of Object.entries(extra)) {
    env[key] = substitute(value, vars)
  }
  return env
}

export async function runCase(
  testCase: Case,
  options: RunOptions,
): Promise<CaseResult> {
  const started = performance.now()
  const result = (
    status: CaseResult["status"],
    messages: string[],
    updated = false,
  ): CaseResult => ({
    name: testCase.name,
    status,
    messages,
    durationMs: Math.round(performance.now() - started),
    updated,
  })

  if (testCase.live) {
    const fakeOnly = testCase.seed != null ||
      testCase.steps.some((step) => step.faults != null)
    if (fakeOnly) {
      return result("fail", [
        "live: true cases cannot use seed.json or faults.json",
      ])
    }
  } else if (options.live != null) {
    return result("skip", [])
  }

  const root = await Deno.makeTempDir({ prefix: "linear-conformance-" })
  const home = join(root, "home")
  const work = join(root, "work")
  await Deno.mkdir(join(home, "tmp"), { recursive: true })
  await Deno.mkdir(work)

  let fake: FakeLinear | undefined
  if (options.live == null) {
    const store = new Store(options.world)
    if (testCase.seed != null) store.seed(JSON.parse(testCase.seed))
    fake = new FakeLinear(store)
    fake.start()
  }

  const vars: Vars = { ...options.vars, WORK: work, HOME: home }
  const failures: string[] = []
  // The subset of failures that --update cannot rewrite.
  const unfixable: string[] = []
  const updates = new Map<Step, { output: Output; failed: Set<string> }>()
  let label = ""
  try {
    for (const [index, step] of testCase.steps.entries()) {
      // Update mode keeps going to record every step's output.
      if (failures.length > 0 && !options.update) break
      label = `step ${index + 1} (${step.command})`
      for (const [path, content] of Object.entries(step.files)) {
        const target = join(work, substitute(path, vars))
        await Deno.mkdir(join(target, ".."), { recursive: true })
        await Deno.writeTextFile(target, substitute(content, vars))
      }
      if (fake != null) fake.faults = (step.faults ?? []) as FaultRule[]
      const before = fake?.requests.length ?? 0
      const attemptsBefore = fake?.attempts ?? 0
      let argv: string[]
      try {
        argv = step.argv.map((arg) => substitute(arg, vars))
      } catch (error) {
        const message = `${label}: ${(error as Error).message}`
        failures.push(message)
        unfixable.push(message)
        break
      }
      const output = await execute(
        options,
        argv,
        childEnv(options, home, fake?.endpoint, step.env, vars),
        work,
        step.stdin == null ? undefined : substitute(step.stdin, vars),
      )
      if (step.redirect != null) {
        await Deno.writeTextFile(
          join(work, substitute(step.redirect, vars)),
          output.stdout,
        )
        output.stdout = ""
      }
      const failed = new Set<string>()
      updates.set(step, { output, failed })
      const problems: string[] = []
      const blocking: string[] = []
      const block = (problem: string) => {
        problems.push(problem)
        blocking.push(problem)
      }
      if (output.timedOut) {
        problems.push(`timed out after ${options.timeoutMs}ms`)
      }
      if (output.code !== step.exit) {
        failed.add("exit")
        problems.push(`exit code ${output.code}, expected ${step.exit}`)
      }
      for (
        const [stream, section, actual] of [
          ["stdout", step.stdout, output.stdout],
          ["stderr", step.stderr, output.stderr],
        ] as const
      ) {
        const checked = checkStream(stream, section, actual, vars)
        if (typeof checked === "string") {
          failed.add(stream)
          problems.push(checked)
        } else Object.assign(vars, checked)
      }
      if (fake != null) {
        if (step.noRequests && fake.attempts > attemptsBefore) {
          block(
            `expected no requests, got ${fake.attempts - attemptsBefore}`,
          )
        }
        if (step.mutations != null) {
          const result = matchJson(
            JSON.parse(step.mutations),
            fake.mutationCounts(before),
            vars,
            "mutations",
          )
          if ("path" in result) {
            block(`${result.path}: ${result.message}`)
          }
        }
        if (step.state != null) {
          const checked = checkState(step.state, fake.snapshot(), vars)
          if (typeof checked === "string") block(checked)
          else Object.assign(vars, checked)
        }
      }
      for (const section of step.filesAfter) {
        const path = join(work, substitute(section.arg ?? "", vars))
        let content: string
        try {
          content = await Deno.readTextFile(path)
        } catch {
          block(`file ${section.arg} does not exist`)
          continue
        }
        const checked = checkStream(
          `file ${section.arg}`,
          section,
          content,
          vars,
        )
        if (typeof checked === "string") block(checked)
        else Object.assign(vars, checked)
      }
      if (fake != null && fake.gaps.length > 0) {
        return result("gap", [
          `${label}: fake-linear does not implement what the executable used:`,
          ...new Set(fake.gaps),
        ])
      }
      if (problems.length > 0) {
        failures.push(`${label}:\n${problems.join("\n")}`)
      }
      const kept = output.timedOut ? problems : blocking
      if (kept.length > 0) {
        unfixable.push(`${label}:\n${kept.join("\n")}`)
      }
    }
  } catch (error) {
    // E.g. an expectation uses a variable an earlier mismatch left unbound.
    const message = `${label}: ${(error as Error).message}`
    failures.push(message)
    unfixable.push(message)
  } finally {
    for (const argv of testCase.cleanup) {
      let words: string[]
      try {
        words = argv.map((arg) => substitute(arg, vars))
      } catch (error) {
        // A step that should have bound the variable failed. Offline, the fake
        // goes away with the case; live, what the case created may remain.
        if (options.live != null) {
          const message = `cleanup skipped: linear ${argv.join(" ")}: ${
            (error as Error).message
          }\nobjects this case created may remain in Kadoraba; find them by the run prefix ${vars.RUN}`
          failures.push(message)
          unfixable.push(message)
        }
        continue
      }
      const output = await execute(
        options,
        words,
        childEnv(options, home, fake?.endpoint, {}, vars),
        work,
        undefined,
      )
      if (output.code !== 0) {
        const message = `cleanup failed: linear ${
          words.join(" ")
        }\n${output.stderr}${output.stdout}`
        failures.push(message)
        unfixable.push(message)
      }
    }
    await fake?.stop()
    await Deno.remove(root, { recursive: true }).catch(() => {})
  }

  // A killed run's output is not an expectation to record.
  for (const { output, failed } of updates.values()) {
    if (output.timedOut) failed.clear()
  }
  const rewritten = [...updates.values()].some(({ failed }) => failed.size > 0)
  if (
    failures.length > 0 && options.update && options.live == null && rewritten
  ) {
    const names = testCase.live
      ? Object.keys(vars).filter((name) =>
        name === "RUN" ||
        !(name in options.vars || name === "WORK" || name === "HOME")
      )
      : null
    await Deno.writeTextFile(
      testCase.path,
      rewrite(testCase, updates, vars, names),
    )
    return unfixable.length > 0
      ? result("fail", ["updated expectations", ...unfixable], true)
      : result("pass", ["updated expectations"], true)
  }
  return result(failures.length > 0 ? "fail" : "pass", failures)
}

const EXPECTATIONS = new Set(["stdout", "stdout.json", "stderr", "exit"])

/**
 * In live cases, write variable values back as {{NAME}} and leave IDs and
 * timestamps open, so the expectation holds for whatever the real API assigns.
 */
function templatize(text: string, vars: Vars, names: string[] | null): string {
  if (names == null) return text
  for (const name of names) {
    const value = vars[name]
    if (value == null || value.length < 3) continue
    for (
      const [form, token] of [[value, name], [
        value.toLowerCase(),
        `${name}|lower`,
      ]]
    ) {
      const escaped = form.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
      text = text.replace(
        new RegExp(`(?<![A-Za-z0-9])${escaped}(?![0-9])`, "g"),
        `{{${token}}}`,
      )
    }
  }
  return text
    .replace(
      /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g,
      "{{*}}",
    )
    .replace(/\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z/g, "{{*}}")
}

/**
 * GraphQL error locations point into the client's query text, which another
 * implementation lays out differently.
 */
function wildcardLocations(key: string, value: unknown): unknown {
  return key === "locations" ? "{{*}}" : value
}

function freshSection(
  stream: "stdout" | "stderr",
  actual: string,
  vars: Vars,
  names: string[] | null,
): Section | undefined {
  if (actual === "") return undefined
  if (stream === "stdout") {
    try {
      const json = JSON.stringify(JSON.parse(actual), wildcardLocations, 2)
      return {
        name: "stdout.json",
        content: templatize(json + "\n", vars, names),
      }
    } catch { /* plain text */ }
  }
  const text = actual.endsWith("\n") ? actual : actual + "\n"
  return { name: stream, content: templatize(text, vars, names) }
}

/** Rewrite only the stdout, stderr and exit expectations that failed. */
function rewrite(
  testCase: Case,
  outputs: Map<Step, { output: Output; failed: Set<string> }>,
  vars: Vars,
  names: string[] | null,
): string {
  const sections: Section[] = []
  for (const section of testCase.sections) {
    const recorded = section.step == null || section.step < 0
      ? undefined
      : outputs.get(testCase.steps[section.step])
    const stream = section.name.replace(".json", "")
    if (EXPECTATIONS.has(section.name) && recorded?.failed.has(stream)) continue
    sections.push(section)
    if (section.name !== "run" || recorded == null) continue
    const { output, failed } = recorded
    for (const name of ["stdout", "stderr"] as const) {
      if (!failed.has(name)) continue
      const fresh = freshSection(name, output[name], vars, names)
      if (fresh != null) sections.push(fresh)
    }
    if (failed.has("exit") && output.code !== 0) {
      sections.push({ name: "exit", content: `${output.code}\n` })
    }
  }
  return formatTxtar(testCase.comment, sections)
}

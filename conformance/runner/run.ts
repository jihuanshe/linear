/**
 * Execute one case against a CLI executable.
 *
 * Offline, every case gets its own fake Linear seeded with world.json plus the
 * case's seed. Live, the executable talks to the real API with the experiment
 * credential, and offline-only assertions (state, mutation counts, request
 * counts) are skipped.
 */
import { join } from "@std/path"
import { decodeBase64 } from "@std/encoding/base64"
import { API_KEY, FakeLinear, type FaultRule } from "../fake-linear/server.ts"
import { type Seed, Store, WORLD_NOW } from "../fake-linear/store.ts"
import { type Case, formatTxtar, type Section, type Step } from "./case.ts"
import { executeTty, ttySupported } from "./tty.ts"
import {
  lineDiff,
  matchJson,
  matchText,
  substitute,
  type Vars,
} from "./match.ts"

export interface RunOptions {
  /** Also run cases marked `slow: true`. */
  slow?: boolean
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
  stdin: string | Uint8Array | undefined,
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
    if (stdin != null) {
      await writer.write(
        typeof stdin === "string" ? new TextEncoder().encode(stdin) : stdin,
      )
    }
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

/**
 * Apply a patch to a JSON document: an array is an RFC 6902 JSON Patch
 * (add, replace, remove), anything else an RFC 7386 merge patch.
 */
function applyPatch(target: unknown, patch: unknown): unknown {
  if (!Array.isArray(patch)) return mergePatch(target, patch)
  let document = structuredClone(target)
  for (
    const { op, path, value } of patch as {
      op: string
      path: string
      value?: unknown
    }[]
  ) {
    if (!["add", "replace", "remove"].includes(op)) {
      throw new Error(`unsupported JSON Patch op ${op}`)
    }
    if (path !== "" && !path.startsWith("/")) {
      throw new Error(`JSON Patch path must start with "/": ${path}`)
    }
    const keys = path === ""
      ? []
      : path.split("/").slice(1).map((key) =>
        key.replaceAll("~1", "/").replaceAll("~0", "~")
      )
    if (keys.length === 0) {
      if (op === "remove") throw new Error("JSON Patch cannot remove the root")
      document = value
      continue
    }
    let parent: unknown = document
    for (const key of keys.slice(0, -1)) {
      if (parent === null || typeof parent !== "object" || !(key in parent)) {
        throw new Error(`JSON Patch path does not exist: ${path}`)
      }
      parent = (parent as Record<string, unknown>)[key]
    }
    if (parent === null || typeof parent !== "object") {
      throw new Error(`JSON Patch path does not exist: ${path}`)
    }
    const last = keys.at(-1)!
    if (Array.isArray(parent)) {
      // Arrays insert or append ("-") with add; replace and remove need an
      // existing element.
      const index = last === "-" ? parent.length : Number(last)
      const limit = op === "add" ? parent.length : parent.length - 1
      if (!Number.isInteger(index) || index < 0 || index > limit) {
        throw new Error(`JSON Patch index out of range: ${path}`)
      }
      if (op === "add") parent.splice(index, 0, value)
      else if (op === "replace") parent[index] = value
      else parent.splice(index, 1)
      continue
    }
    const object = parent as Record<string, unknown>
    if (op !== "add" && !(last in object)) {
      throw new Error(`JSON Patch path does not exist: ${path}`)
    }
    if (op === "remove") delete object[last]
    else object[last] = value
  }
  return document
}

/** RFC 7386 JSON merge patch: null deletes a key, objects merge, others replace. */
function mergePatch(target: unknown, patch: unknown): unknown {
  if (patch === null || typeof patch !== "object" || Array.isArray(patch)) {
    return patch
  }
  const result: Record<string, unknown> =
    target !== null && typeof target === "object" && !Array.isArray(target)
      ? { ...target as Record<string, unknown> }
      : {}
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete result[key]
    else result[key] = mergePatch(result[key], value)
  }
  return result
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
  if (endpoint != null) {
    env.LINEAR_GRAPHQL_ENDPOINT = endpoint
    // Relative dates count from the fake world's current time.
    env.LINEAR_NOW = WORLD_NOW
  }
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

  if (testCase.slow && options.slow !== true) return result("skip", [])
  if (testCase.timeoutMs != null) {
    options = { ...options, timeoutMs: testCase.timeoutMs }
  }
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
      for (const [path, base64] of Object.entries(step.binaryFiles)) {
        const target = join(work, substitute(path, vars))
        await Deno.mkdir(join(target, ".."), { recursive: true })
        await Deno.writeFile(target, decodeBase64(base64))
      }
      for (const path of step.executables) {
        await Deno.chmod(join(work, substitute(path, vars)), 0o755)
      }
      for (const [path, patch] of Object.entries(step.patches)) {
        const target = join(work, substitute(path, vars))
        const patched = applyPatch(
          JSON.parse(await Deno.readTextFile(target)),
          JSON.parse(substitute(patch, vars)),
        )
        await Deno.writeTextFile(
          target,
          JSON.stringify(patched, null, 2) + "\n",
        )
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
      const env = childEnv(options, home, fake?.endpoint, step.env, vars)
      let output: Output
      if (step.tty != null) {
        if (!ttySupported()) {
          return result("skip", [
            `${label}: no pseudo-terminal on ${Deno.build.os}`,
          ])
        }
        const tty = await executeTty(
          options.binary,
          argv,
          env,
          work,
          substitute(step.tty, vars),
          options.timeoutMs,
        )
        if (tty.problem != null) {
          const message = `${label}: ${tty.problem}\n${tty.stdout.slice(-2000)}`
          failures.push(message)
          unfixable.push(message)
          break
        }
        output = tty
      } else {
        output = await execute(
          options,
          argv,
          env,
          work,
          step.stdinBytes != null
            ? decodeBase64(step.stdinBytes)
            : step.stdin == null
            ? undefined
            : substitute(step.stdin, vars),
        )
      }
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
        problems.push(
          `timed out after ${options.timeoutMs}ms; output so far:\n${
            (output.stdout + output.stderr).slice(-1500)
          }`,
        )
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
          // A terminal transcript changes with keystroke timing, and a pattern
          // that binds variables would lose them; fix those by hand.
          if (step.tty != null || section?.content.includes("{{=")) {
            block(checked)
          } else {
            failed.add(stream)
            problems.push(checked)
          }
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
    // Teardown runs even if a cleanup or readback throws.
    try {
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
      for (const check of testCase.readbacks) {
        const problem = await readback(options, check, vars, home, work, fake)
        if (problem != null) {
          failures.push(problem)
          unfixable.push(problem)
        }
      }
    } finally {
      await fake?.stop()
      await Deno.remove(root, { recursive: true }).catch(() => {})
    }
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

/** Live, Linear may take a moment to reflect a cleanup. */
const READBACK_ATTEMPTS = 5
const READBACK_DELAY_MS = 2_000

/** Run one readback after cleanup; return an error message if it never matches. */
async function readback(
  options: RunOptions,
  check: Step,
  vars: Vars,
  home: string,
  work: string,
  fake: FakeLinear | undefined,
): Promise<string | undefined> {
  let words: string[]
  let env: Record<string, string>
  try {
    words = check.argv.map((arg) => substitute(arg, vars))
    env = childEnv(options, home, fake?.endpoint, check.env, vars)
  } catch (error) {
    return `readback skipped: linear ${check.argv.join(" ")}: ${
      (error as Error).message
    }`
  }
  const attempts = options.live == null ? 1 : READBACK_ATTEMPTS
  let problems: string[] = []
  for (let attempt = 1; attempt <= attempts; attempt++) {
    if (attempt > 1) {
      await new Promise((resolve) => setTimeout(resolve, READBACK_DELAY_MS))
    }
    const output = await execute(
      options,
      words,
      env,
      work,
      undefined,
    )
    problems = []
    const bindings: Vars = {}
    if (output.timedOut) {
      problems.push(`timed out after ${options.timeoutMs}ms`)
    }
    if (output.code !== check.exit) {
      problems.push(`exit code ${output.code}, expected ${check.exit}`)
    }
    for (
      const [stream, section, actual] of [
        ["stdout", check.stdout, output.stdout],
        ["stderr", check.stderr, output.stderr],
      ] as const
    ) {
      try {
        const checked = checkStream(stream, section, actual, {
          ...vars,
          ...bindings,
        })
        if (typeof checked === "string") problems.push(checked)
        else Object.assign(bindings, checked)
      } catch (error) {
        problems.push(`${stream}: ${(error as Error).message}`)
      }
    }
    if (problems.length === 0) {
      Object.assign(vars, bindings)
      return undefined
    }
  }
  return `readback failed after cleanup: linear ${words.join(" ")}\n${
    problems.join("\n")
  }`
}

const EXPECTATIONS = new Set(["stdout", "stdout.json", "stderr", "exit"])

/**
 * In live cases, write variable values back as {{NAME}} and leave IDs and
 * timestamps open, so the expectation holds for whatever the real API assigns.
 */
function templatize(text: string, vars: Vars, names: string[] | null): string {
  // Per-run directories differ every time, in every case.
  for (const name of ["WORK", "HOME"]) {
    const value = vars[name]
    if (value != null) text = text.replaceAll(value, `{{${name}}}`)
  }
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

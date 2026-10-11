/**
 * Case files: txtar archives (https://pkg.go.dev/golang.org/x/tools/txtar).
 *
 * The comment before the first section is the case description. Sections are
 * read in order: inputs (`file`, `stdin`, `env`, `faults.json`) apply to the
 * next `run`; expectations (`stdout`, `exit`, ...) check the preceding one.
 * See conformance/README.md for the full format.
 */

export interface Section {
  name: string
  arg?: string
  content: string
  /** Index of the run this section belongs to; -1 before the first run. */
  step?: number
}

export interface Step {
  command: string
  argv: string[]
  /** Workdir-relative file that receives stdout instead of the stdout check. */
  redirect?: string
  stdin?: string
  env: Record<string, string>
  files: Record<string, string>
  faults?: unknown[]
  stdout?: Section
  stderr?: Section
  exit: number
  state?: string
  mutations?: string
  noRequests: boolean
  filesAfter: Section[]
}

export interface Case {
  path: string
  name: string
  comment: string
  description: string
  /** Also run against the real API (`live: true` in the description). */
  live: boolean
  seed?: string
  steps: Step[]
  cleanup: string[][]
  /** Commands that check what cleanup left; only stdout, stderr and exit. */
  readbacks: Step[]
  sections: Section[]
}

export function parseTxtar(
  text: string,
): { comment: string; sections: Section[] } {
  const lines = text.split("\n")
  if (lines.at(-1) === "") lines.pop()
  const comment: string[] = []
  const sections: Section[] = []
  let current: { name: string; arg?: string; lines: string[] } | undefined
  const flush = () => {
    if (current == null) return
    const content = current.lines.length > 0
      ? current.lines.join("\n") + "\n"
      : ""
    sections.push({ name: current.name, arg: current.arg, content })
  }
  for (const line of lines) {
    const marker = /^-- (\S+)(?: (.+?))? --$/.exec(line)
    if (marker != null) {
      flush()
      current = { name: marker[1], arg: marker[2], lines: [] }
    } else if (current == null) {
      comment.push(line)
    } else {
      current.lines.push(line)
    }
  }
  flush()
  return { comment: comment.map((line) => line + "\n").join(""), sections }
}

export function formatTxtar(comment: string, sections: Section[]): string {
  let text = comment.endsWith("\n") || comment === "" ? comment : comment + "\n"
  for (const section of sections) {
    text += `-- ${section.name}${
      section.arg == null ? "" : " " + section.arg
    } --\n`
    text += section.content
  }
  return text
}

/**
 * Split a command line into words: whitespace separates words, single quotes
 * are literal, double quotes allow \" and \\ escapes, and a backslash outside
 * quotes escapes the next character. No expansion happens here.
 */
export function splitWords(line: string): string[] {
  const words: string[] = []
  let word = ""
  let inWord = false
  for (let i = 0; i < line.length; i++) {
    const c = line[i]
    if (c === "'") {
      const end = line.indexOf("'", i + 1)
      if (end < 0) throw new Error(`unterminated ' in: ${line}`)
      word += line.slice(i + 1, end)
      i = end
      inWord = true
    } else if (c === '"') {
      i++
      for (; i < line.length && line[i] !== '"'; i++) {
        if (line[i] === "\\" && (line[i + 1] === '"' || line[i + 1] === "\\")) {
          i++
        }
        word += line[i]
      }
      if (i >= line.length) throw new Error(`unterminated " in: ${line}`)
      inWord = true
    } else if (c === "\\") {
      word += line[++i] ?? ""
      inWord = true
    } else if (/\s/.test(c)) {
      if (inWord) words.push(word)
      word = ""
      inWord = false
    } else {
      word += c
      inWord = true
    }
  }
  if (inWord) words.push(word)
  return words
}

function parseCommand(
  content: string,
  where: string,
): { argv: string[]; redirect?: string } {
  const line = content.trim()
  if (line.includes("\n")) throw new Error(`${where}: one command per section`)
  const words = splitWords(line)
  if (words[0] !== "linear") {
    throw new Error(`${where}: command must start with "linear"`)
  }
  // Only an unquoted trailing `> path` redirects; a quoted ">" stays an argument.
  const redirect = /\s>\s*(\S+)$/.exec(line)
  if (redirect != null && words.at(-2) === ">") {
    return { argv: words.slice(1, -2), redirect: words.at(-1) }
  }
  return { argv: words.slice(1) }
}

export function parseCase(path: string, name: string, text: string): Case {
  const { comment, sections } = parseTxtar(text)
  const description = comment.split("\n").filter((l) => !/^\w+:/.test(l))
    .join("\n").trim()
  const live = /^live:\s*true\s*$/m.test(comment)
  const result: Case = {
    path,
    name,
    comment,
    description,
    live,
    steps: [],
    cleanup: [],
    readbacks: [],
    sections,
  }
  let env: Record<string, string> = {}
  let pending: Omit<
    Step,
    "command" | "argv" | "exit" | "noRequests" | "filesAfter"
  > = {
    env,
    files: {},
  }
  let step: Step | undefined
  let readback: Step | undefined
  const expect = (section: Section) => {
    if (readback != null) {
      throw new Error(
        `${path}: "${section.name}" cannot check a readback; use stdout, stderr or exit`,
      )
    }
    if (step == null) {
      throw new Error(`${path}: "${section.name}" must follow a run section`)
    }
    return step
  }
  const output = (section: Section) => readback ?? expect(section)
  for (const section of sections) {
    const where = `${path}: ${section.name}`
    // Sections after a readback belong to it, not to a run step.
    section.step = readback != null
      ? -1
      : section.name === "run"
      ? result.steps.length
      : result.steps.length - 1
    if (readback != null && section.name === "run") {
      throw new Error(`${where}: run sections must come before readbacks`)
    }
    switch (section.name) {
      case "seed.json":
        if (result.steps.length > 0) throw new Error(`${where} must come first`)
        result.seed = section.content
        break
      case "file":
        pending.files[section.arg ?? ""] = section.content
        break
      case "stdin":
        pending.stdin = section.content
        break
      case "env":
        env = { ...env }
        for (const line of section.content.split("\n")) {
          if (line.trim() === "") continue
          const eq = line.indexOf("=")
          if (eq < 0) throw new Error(`${where}: expected KEY=VALUE`)
          env[line.slice(0, eq)] = line.slice(eq + 1)
        }
        pending.env = env
        break
      case "faults.json":
        pending.faults = JSON.parse(section.content)
        break
      case "run":
        step = {
          ...pending,
          command: section.content.trim(),
          ...parseCommand(section.content, where),
          exit: 0,
          noRequests: false,
          filesAfter: [],
        }
        result.steps.push(step)
        pending = { env, files: {} }
        break
      case "stdout":
      case "stdout.json":
        output(section).stdout = section
        break
      case "stderr":
        output(section).stderr = section
        break
      case "exit":
        output(section).exit = Number(section.content.trim())
        break
      case "state.json":
        expect(section).state = section.content
        break
      case "mutations.json":
        expect(section).mutations = section.content
        break
      case "no-requests":
        expect(section).noRequests = true
        break
      case "file-after":
      case "file-after.json":
        expect(section).filesAfter.push(section)
        break
      case "cleanup":
        result.cleanup.push(parseCommand(section.content, where).argv)
        break
      case "readback":
        readback = {
          env,
          files: {},
          command: section.content.trim(),
          ...parseCommand(section.content, where),
          exit: 0,
          noRequests: false,
          filesAfter: [],
        }
        result.readbacks.push(readback)
        break
      default:
        throw new Error(`${where}: unknown section`)
    }
  }
  if (result.steps.length === 0) throw new Error(`${path}: no run section`)
  return result
}

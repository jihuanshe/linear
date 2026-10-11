/**
 * Expectation matching.
 *
 * `{{NAME}}` inserts a variable (`{{NAME|lower}}` lowercased), `{{*}}` matches anything, and `{{=NAME}}`
 * matches anything and binds it to NAME for later steps. In JSON expectations
 * these work inside string values; an object entry `"...": true` allows keys
 * that the expectation does not list. Everything else must match exactly.
 */

export type Vars = Record<string, string>

const TOKEN = /\{\{(=?)([A-Za-z_][A-Za-z0-9_]*|\*)(\|lower)?\}\}/g

function lookupVar(
  vars: Vars,
  name: string,
  filter: string | undefined,
): string {
  const value = vars[name]
  if (value == null) throw new Error(`undefined variable {{${name}}}`)
  return filter === "|lower" ? value.toLowerCase() : value
}

export function substitute(text: string, vars: Vars): string {
  return text.replace(
    TOKEN,
    (token, bind: string, name: string, filter?: string) => {
      if (bind !== "" || name === "*") return token
      return lookupVar(vars, name, filter)
    },
  )
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

/** Match `actual` against a text pattern, returning new bindings or null. */
export function matchText(
  pattern: string,
  actual: string,
  vars: Vars,
): Vars | null {
  const names: string[] = []
  let source = ""
  let last = 0
  for (const token of pattern.matchAll(TOKEN)) {
    source += escapeRegExp(pattern.slice(last, token.index))
    const [, bind, name, filter] = token
    if (name === "*") source += "[\\s\\S]*?"
    else if (bind === "=") {
      names.push(name)
      source += "([^\\n]*?)"
    } else {
      source += escapeRegExp(lookupVar(vars, name, filter))
    }
    last = token.index + token[0].length
  }
  source += escapeRegExp(pattern.slice(last))
  const match = new RegExp(`^${source}$`).exec(actual)
  if (match == null) return null
  return Object.fromEntries(names.map((name, i) => [name, match[i + 1]]))
}

export interface JsonMismatch {
  path: string
  message: string
}

export function matchJson(
  pattern: unknown,
  actual: unknown,
  vars: Vars,
  path = "$",
): { bindings: Vars } | JsonMismatch {
  const bindings: Vars = {}
  const fail = (message: string) => ({ path, message })
  if (typeof pattern === "string") {
    if (pattern === "{{*}}") return { bindings }
    const bind = /^\{\{=([A-Za-z_][A-Za-z0-9_]*)\}\}$/.exec(pattern)
    if (bind != null) {
      bindings[bind[1]] = typeof actual === "string"
        ? actual
        : JSON.stringify(actual)
      return { bindings }
    }
    if (typeof actual !== "string") {
      return fail(`expected string, got ${JSON.stringify(actual)}`)
    }
    const result = matchText(pattern, actual, vars)
    if (result == null) {
      return fail(
        `expected ${JSON.stringify(substitute(pattern, vars))}, got ${
          JSON.stringify(actual)
        }`,
      )
    }
    return { bindings: result }
  }
  if (Array.isArray(pattern)) {
    if (!Array.isArray(actual)) {
      return fail(`expected array, got ${JSON.stringify(actual)}`)
    }
    if (pattern.length !== actual.length) {
      return fail(`expected ${pattern.length} items, got ${actual.length}`)
    }
    for (let i = 0; i < pattern.length; i++) {
      const result = matchJson(
        pattern[i],
        actual[i],
        { ...vars, ...bindings },
        `${path}[${i}]`,
      )
      if ("path" in result) return result
      Object.assign(bindings, result.bindings)
    }
    return { bindings }
  }
  if (pattern !== null && typeof pattern === "object") {
    if (
      actual === null || typeof actual !== "object" || Array.isArray(actual)
    ) {
      return fail(`expected object, got ${JSON.stringify(actual)}`)
    }
    const expected = pattern as Record<string, unknown>
    const object = actual as Record<string, unknown>
    const open = expected["..."] === true
    for (const key of Object.keys(expected)) {
      if (key === "...") continue
      if (!(key in object)) return fail(`missing key ${JSON.stringify(key)}`)
      const result = matchJson(
        expected[key],
        object[key],
        { ...vars, ...bindings },
        `${path}.${key}`,
      )
      if ("path" in result) return result
      Object.assign(bindings, result.bindings)
    }
    if (!open) {
      const extra = Object.keys(object).filter((key) => !(key in expected))
      if (extra.length > 0) return fail(`unexpected keys ${extra.join(", ")}`)
    }
    return { bindings }
  }
  if (pattern !== actual) {
    return fail(
      `expected ${JSON.stringify(pattern)}, got ${JSON.stringify(actual)}`,
    )
  }
  return { bindings }
}

/** A minimal line diff for failure messages. */
export function lineDiff(expected: string, actual: string): string {
  const a = expected.split("\n")
  const b = actual.split("\n")
  const out: string[] = []
  const n = Math.max(a.length, b.length)
  for (let i = 0; i < n; i++) {
    if (a[i] === b[i]) out.push(`  ${a[i]}`)
    else {
      if (a[i] != null) out.push(`- ${a[i]}`)
      if (b[i] != null) out.push(`+ ${b[i]}`)
    }
  }
  return out.join("\n")
}

import { parse } from "@std/toml"
import { join, resolve } from "@std/path"
import { loadSync } from "@std/dotenv"
import * as v from "valibot"
import { ValidationError } from "./utils/errors.ts"

let config: Record<string, unknown> | undefined
let environmentLoaded = false

function exists(path: string): boolean {
  try {
    Deno.statSync(path)
    return true
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return false
    throw new ValidationError(`Could not inspect configuration path: ${path}`)
  }
}

function gitRoot(): string | undefined {
  try {
    const result = new Deno.Command("git", {
      args: ["rev-parse", "--show-toplevel"],
      stderr: "null",
    }).outputSync()
    if (!result.success) return
    return new TextDecoder().decode(result.stdout).trim() || undefined
  } catch {
    // Git is optional, including when running outside a repository.
    return
  }
}

/** Load dotenv only for an executing action, never while building navigation. */
export function loadEnvironment(): void {
  if (environmentLoaded) return
  const root = gitRoot()
  const envPath = exists(".env") ? ".env" : root && join(root, ".env")
  if (envPath && exists(envPath)) {
    const variables = loadSync({ envPath })
    for (const [key, value] of Object.entries(variables)) {
      if (
        ["LINEAR_", "GH_", "GITHUB_"].some((prefix) =>
          key.startsWith(prefix)
        ) &&
        Deno.env.get(key) === undefined
      ) Deno.env.set(key, value)
    }
  }
  environmentLoaded = true
}

function globalConfigPath(): string | undefined {
  if (Deno.build.os === "windows") {
    const appData = Deno.env.get("APPDATA")
    return appData ? join(appData, "linear", "linear.toml") : undefined
  }
  const home = Deno.env.get("HOME")
  const directory = Deno.env.get("XDG_CONFIG_HOME") ||
    (home ? join(home, ".config") : undefined)
  return directory ? join(directory, "linear", "linear.toml") : undefined
}

/** The reader and wizard use exactly the same project precedence. */
export function getProjectConfigPath(): string {
  const root = gitRoot()
  const global = globalConfigPath()
  for (
    const path of new Set([
      resolve("linear.toml"),
      ...(root ? [join(root, "linear.toml")] : []),
    ])
  ) {
    if (path !== global && exists(path)) {
      throw new ValidationError(`Unsupported project config file: ${path}`, {
        suggestion:
          "Move its non-secret settings to .linear.toml. Project linear.toml is no longer supported; store credentials with `linear auth login` or LINEAR_API_KEY.",
      })
    }
  }
  const paths = [
    resolve(".linear.toml"),
    ...(root
      ? [join(root, ".linear.toml"), join(root, ".config", "linear.toml")]
      : []),
  ]
  return paths.find(exists) ?? (root ? join(root, ".linear.toml") : paths[0])
}

function readConfig(path: string): Record<string, unknown> {
  let source: string
  try {
    source = Deno.readTextFileSync(path)
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return {}
    throw new ValidationError(`Failed to read config file at ${path}`)
  }
  let parsed: Record<string, unknown>
  try {
    parsed = parse(source)
  } catch {
    // TOML diagnostics can contain the source line, including a secret.
    throw new ValidationError(`Failed to parse config file at ${path}`)
  }
  if (Object.hasOwn(parsed, "api_key")) {
    throw new ValidationError(`Unsupported api_key in config file at ${path}`, {
      suggestion:
        "Remove api_key from this file and use LINEAR_API_KEY or `linear auth login`. No fallback credential was selected.",
    })
  }
  if (Object.hasOwn(parsed, "team_id")) {
    throw new ValidationError(`Unsupported team_id in config file at ${path}`, {
      suggestion:
        "Replace team_id with team_key containing the Team.key (for example, ENG), not a team UUID. team_id is no longer supported.",
    })
  }
  return parsed
}

export function loadConfig(): void {
  loadEnvironment()
  if (Deno.env.get("LINEAR_TEAM_ID") != null) {
    throw new ValidationError(
      "Unsupported environment variable LINEAR_TEAM_ID",
      {
        suggestion:
          "Unset LINEAR_TEAM_ID and use LINEAR_TEAM_KEY containing the Team.key (for example, ENG), not a team UUID.",
      },
    )
  }
  if (config != null) return
  const project = getProjectConfigPath()
  const global = globalConfigPath()
  config = { ...(global ? readConfig(global) : {}), ...readConfig(project) }
}

const TRUTHY = ["true", "yes", "y", "on", "1", "t"]
const FALSY = ["false", "no", "n", "off", "0", "f"]

function coerceBool(value: unknown): unknown {
  if (typeof value === "string") {
    const lower = value.toLowerCase()
    if (TRUTHY.includes(lower)) return true
    if (FALSY.includes(lower)) return false
  }
  return value
}

const BooleanLike = v.pipe(v.unknown(), v.transform(coerceBool), v.boolean())
const NonEmptyString = v.pipe(v.string(), v.minLength(1))

export const ISSUE_SORT_VALUES = ["manual", "priority"] as const
export type IssueSort = (typeof ISSUE_SORT_VALUES)[number]
export const DEFAULT_ISSUE_SORT: IssueSort = "priority"

const OptionsSchema = v.object({
  team_key: v.optional(NonEmptyString),
  workspace: v.optional(NonEmptyString),
  issue_sort: v.optional(v.picklist(ISSUE_SORT_VALUES)),
  issue_create_ask_project: v.optional(BooleanLike),
  issue_create_assign_self: v.optional(v.picklist(["always", "auto", "never"])),
  vcs: v.optional(v.picklist(["git", "jj"])),
  hyperlink_format: v.optional(v.string()),
})

export type Options = v.InferOutput<typeof OptionsSchema>
export type OptionName = keyof Options

function getRawOption(optionName: OptionName, cliValue?: string): unknown {
  loadConfig()
  return cliValue ??
    Deno.env.get("LINEAR_" + optionName.toUpperCase()) ??
    config?.[optionName]
}

export function getOption<T extends OptionName>(
  optionName: T,
  cliValue?: string,
): Options[T] {
  const raw = getRawOption(optionName, cliValue)
  const result = v.safeParse(OptionsSchema, { [optionName]: raw })
  if (result.success) return result.output[optionName] as Options[T]
  throw new ValidationError(`Invalid value for ${optionName}`, {
    suggestion:
      `Check the command option, LINEAR_${optionName.toUpperCase()}, and configuration file. An invalid value is not treated as unset.`,
  })
}

export function resolveIssueSort(cliValue?: string): IssueSort {
  return getOption("issue_sort", cliValue) ?? DEFAULT_ISSUE_SORT
}

let cliWorkspace: string | undefined

export function setCliWorkspace(workspace: string | undefined) {
  cliWorkspace = workspace
}

export function getCliWorkspace(): string | undefined {
  return cliWorkspace
}

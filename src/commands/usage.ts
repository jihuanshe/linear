import { type Argument, Command, type Option } from "@cliffy/command"

export interface UsageCommandSource {
  getName(): string
  getPath(): string
  getAliases(): string[]
  getDescription(): string
  getMeta(): Record<string, string>
  getArguments(): Argument[]
  getBaseOptions(): Option[]
  getGlobalOptions(): Option[]
  getCommands(): UsageCommandSource[]
  getCommand(name: string): UsageCommandSource | undefined
}

type JsonValue =
  | boolean
  | number
  | string
  | null
  | JsonValue[]

export interface UsageArgumentMetadata {
  name: string
  type: string
  required: boolean
  variadic: boolean
  list: boolean
  description?: string
}

export type UsageOutputMode = "human" | "json"

export interface UsageConfirmationMetadata {
  requiredUnless: string
}

export interface UsageOptionMetadata {
  name: string
  flags: string[]
  description: string
  arguments: UsageArgumentMetadata[]
  staticallyRequired: boolean
  repeatable: boolean
  /**
   * A static default representable in usage JSON v1. Absence does not prove
   * that the command has no runtime-computed default.
   */
  default?: JsonValue
}

export interface UsageCommandMetadata {
  name: string
  path: string
  usage: string
  aliases: string[]
  description: string
  arguments: UsageArgumentMetadata[]
  options: UsageOptionMetadata[]
  hasSubcommands: boolean
  details: string
  writes: boolean
  interactive: boolean
  confirmation: UsageConfirmationMetadata | null
  outputModes: UsageOutputMode[]
}

/**
 * Usage JSON v1 is additive: readers must ignore unknown fields. Removing an
 * existing field or changing its type requires a schemaVersion increment.
 */
export interface UsageDocument {
  schemaVersion: 1
  command: UsageCommandMetadata
  globalOptions: UsageOptionMetadata[]
  subcommands: UsageCommandMetadata[]
}

export interface UsageMetadataAnnotation {
  writes?: boolean
  interactive?: boolean
  confirmationRequiredUnless?: string
  outputModes?: UsageOutputMode[]
}

interface UsageMetadataTarget {
  meta(name: string, value: string): unknown
}

const META_WRITES = "Writes"
const META_INTERACTIVE = "Interactive"
const META_CONFIRMATION = "Confirmation required unless"
const META_OUTPUT_MODES = "Output modes"

/**
 * Add semantics Cliffy's arguments and options cannot express themselves.
 * `writes` covers commands that can mutate persistent remote or user-configured
 * local state. Transient cache writes and explicit export destinations, such as
 * `schema --output`, do not count.
 */
export function withUsageMetadata<T extends UsageMetadataTarget>(
  command: T,
  metadata: UsageMetadataAnnotation,
): T {
  if (metadata.writes === true) {
    command.meta(META_WRITES, "true")
  }
  if (metadata.interactive === true) {
    command.meta(META_INTERACTIVE, "true")
  }
  if (metadata.confirmationRequiredUnless != null) {
    command.meta(META_CONFIRMATION, metadata.confirmationRequiredUnless)
  }
  if (metadata.outputModes != null) {
    command.meta(META_OUTPUT_MODES, metadata.outputModes.join(","))
  }
  return command
}

function argumentMetadata(
  argument: Argument,
): UsageArgumentMetadata {
  return {
    name: argument.name,
    type: argument.type,
    required: !argument.optional,
    variadic: argument.variadic === true,
    list: argument.list === true,
    ...(argument.description == null
      ? {}
      : { description: argument.description }),
  }
}

function serializableDefault(value: unknown): JsonValue | undefined {
  if (value == null) {
    return value === null ? null : undefined
  }
  if (
    typeof value === "boolean" || typeof value === "number" ||
    typeof value === "string"
  ) {
    return value
  }
  if (Array.isArray(value)) {
    const values = value.map(serializableDefault)
    if (values.some((item) => item === undefined)) {
      return undefined
    }
    return values as JsonValue[]
  }
  return undefined
}

function optionMetadata(option: Option): UsageOptionMetadata {
  const defaultValue = "default" in option
    ? serializableDefault(option.default)
    : undefined
  return {
    name: option.name,
    flags: option.flags,
    description: option.description,
    arguments: option.args.map(argumentMetadata),
    staticallyRequired: option.required === true,
    repeatable: option.collect === true,
    ...(defaultValue === undefined ? {} : { default: defaultValue }),
  }
}

function visibleSubcommands(
  command: UsageCommandSource,
): UsageCommandSource[] {
  return command.getCommands().filter((child) => child.getName() !== "usage")
}

function localOptions(command: UsageCommandSource): Option[] {
  return command.getBaseOptions().filter((option) => option.global !== true)
}

function globalOptions(command: UsageCommandSource): Option[] {
  const options = [
    ...command.getGlobalOptions(),
    ...command.getBaseOptions().filter((option) => option.global === true),
  ]
  return options.filter(
    (option, index) =>
      options.findIndex((candidate) => candidate.name === option.name) ===
        index,
  )
}

function formatArgument(argument: UsageArgumentMetadata): string {
  const name = `${argument.name}${argument.variadic ? "..." : ""}`
  return argument.required ? `<${name}>` : `[${name}]`
}

function commandUsage(command: UsageCommandSource): string {
  const parts = [
    command.getPath(),
    ...command.getArguments().map(argumentMetadata).map(formatArgument),
  ]
  if (localOptions(command).length > 0) {
    parts.push("[options]")
  }
  return parts.join(" ")
}

function outputModes(command: UsageCommandSource): UsageOutputMode[] {
  const configured = command.getMeta()[META_OUTPUT_MODES]
  if (configured != null) {
    return configured.split(",").filter((mode): mode is UsageOutputMode =>
      mode === "human" || mode === "json"
    )
  }
  return localOptions(command).some((option) => option.name === "json")
    ? ["human", "json"]
    : ["human"]
}

function commandMetadata(command: UsageCommandSource): UsageCommandMetadata {
  const path = command.getPath()
  const subcommands = visibleSubcommands(command)
  const meta = command.getMeta()
  const confirmationRequiredUnless = meta[META_CONFIRMATION]
  return {
    name: command.getName(),
    path,
    usage: commandUsage(command),
    aliases: command.getAliases(),
    description: command.getDescription(),
    arguments: command.getArguments().map(argumentMetadata),
    options: localOptions(command).map(optionMetadata),
    hasSubcommands: subcommands.length > 0,
    details: command.getCommand("usage") == null
      ? `${path} --help`
      : `${path} usage`,
    writes: meta[META_WRITES] === "true",
    interactive: meta[META_INTERACTIVE] === "true",
    confirmation: confirmationRequiredUnless == null
      ? null
      : { requiredUnless: confirmationRequiredUnless },
    outputModes: outputModes(command),
  }
}

export function buildUsageDocument(command: UsageCommandSource): UsageDocument {
  return {
    schemaVersion: 1,
    command: commandMetadata(command),
    globalOptions: globalOptions(command).map(optionMetadata),
    subcommands: visibleSubcommands(command).map(commandMetadata),
  }
}

function summary(description: string): string {
  return description.split("\n").map((line) => line.trim()).find(Boolean) ?? ""
}

function commandSignature(command: UsageCommandMetadata): string {
  const names = [command.name, ...command.aliases].join(", ")
  const suffix = command.usage.slice(command.path.length)
  return `${names}${suffix}`
}

function commandSummary(command: UsageCommandMetadata): string {
  const capabilities = [
    ...(command.writes ? ["writes"] : []),
    ...(command.interactive ? ["interactive"] : []),
    ...(command.confirmation == null
      ? []
      : [`confirm: ${command.confirmation.requiredUnless}`]),
    ...(command.outputModes.includes("json") ? ["json"] : []),
  ]
  const suffix = capabilities.length === 0
    ? ""
    : ` [${capabilities.join("; ")}]`
  return `${summary(command.description)}${suffix}`
}

function optionSignature(option: UsageOptionMetadata): string {
  const flags = option.flags.join(", ")
  const values = option.arguments.map(formatArgument).join(" ")
  return values === "" ? flags : `${flags} ${values}`
}

function appendRows(
  lines: string[],
  header: string,
  rows: Array<{ label: string; description: string }>,
): void {
  if (rows.length === 0) return
  lines.push("", `${header}:`)
  const width = Math.max(...rows.map((row) => row.label.length))
  for (const row of rows) {
    lines.push(`  ${row.label.padEnd(width + 2)}${row.description}`)
  }
}

export function formatUsage(
  document: UsageDocument,
  includeSubcommandOptions: boolean,
): string {
  const lines = [
    `${document.command.path} — ${summary(document.command.description)}`,
  ]

  appendRows(
    lines,
    "commands",
    document.subcommands.map((command) => ({
      label: commandSignature(command),
      description: commandSummary(command),
    })),
  )
  appendRows(
    lines,
    "global options",
    document.globalOptions.map((option) => ({
      label: optionSignature(option),
      description: option.description,
    })),
  )

  if (includeSubcommandOptions) {
    for (const command of document.subcommands) {
      appendRows(
        lines,
        `${command.name} options`,
        command.options.map((option) => ({
          label: optionSignature(option),
          description: option.description,
        })),
      )
    }
  }

  lines.push(
    "",
    includeSubcommandOptions
      ? `detail: ${document.command.path} <command> --help`
      : "detail: linear <domain> usage; linear <command> --help",
    `machine-readable: ${document.command.path} usage --json`,
  )
  if (document.subcommands.some((command) => command.name === "guides")) {
    lines.push("workflows: linear guides list; linear guides read <name>")
  }
  return lines.join("\n")
}

export function createUsageAction(includeSubcommandOptions: boolean) {
  return function (this: UsageCommandSource): void {
    console.log(
      formatUsage(
        buildUsageDocument(this),
        includeSubcommandOptions,
      ),
    )
  }
}

export function createUsageCommand(
  target: UsageCommandSource,
  includeSubcommandOptions: boolean,
) {
  return new Command()
    .description(`Show usage for ${target.getPath()}`)
    .option("--json", "Output machine-readable command metadata")
    .action(({ json }) => {
      const document = buildUsageDocument(target)
      console.log(
        json
          ? JSON.stringify(document, null, 2)
          : formatUsage(document, includeSubcommandOptions),
      )
    })
}

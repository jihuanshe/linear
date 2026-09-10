import {
  type ArgumentValue,
  Command,
  Type,
  ValidationError,
} from "@cliffy/command"
import { withUsageMetadata } from "./usage.ts"
import denoConfig from "../../deno.json" with { type: "json" }
import {
  type DocumentNode,
  Kind,
  type OperationDefinitionNode,
  parse,
  type SelectionSetNode,
} from "graphql"
import { getGraphQLEndpoint, getResolvedApiKey } from "../utils/graphql.ts"
import { completeConnection, type Connection } from "../utils/pagination.ts"
import { setMachineOutput } from "../utils/write-result.ts"
import {
  CliError,
  handleError,
  ValidationError as AppValidationError,
  WriteError,
} from "../utils/errors.ts"

class VariableType extends Type<[string, string]> {
  parse({ value }: ArgumentValue): [string, string] {
    const [key, ...rest] = value.split("=")
    if (rest.length === 0) {
      throw new ValidationError(
        `Invalid variable format: ${value}. Variables must be in key=value format, e.g. --variable teamId=abc`,
      )
    }
    return [key, rest.join("=")]
  }
}

export const apiCommand = withUsageMetadata(new Command(), {
  writes: true,
  outputModes: ["json"],
})
  .name("api")
  .description(
    "Run raw GraphQL queries or explicitly unprotected mutations.\n\nRaw mutations require --unprotected and do not provide domain guards, receipts or checkpoints. Requests are not retried; inspect data/errors and reconcile uncertain writes.",
  )
  .type("variable", new VariableType())
  .arguments("[query:string]")
  .option(
    "--variable <variable:variable>",
    "Variable in key=value format (coerces booleans, numbers, null; @file reads from path)",
    { collect: true },
  )
  .option(
    "--variables-json <json:string>",
    "JSON object of variables (merged with --variable, which takes precedence)",
    { preserveEmpty: true },
  )
  .option(
    "--operation-name <name:string>",
    "Select the GraphQL operation (required when the document contains multiple operations)",
  )
  .option(
    "--unprotected",
    "Explicitly allow a raw mutation without domain guards, receipts or checkpoints",
  )
  .option(
    "--paginate",
    "Read one query connection to its final page using $after (mutations are rejected)",
  )
  .option(
    "--silent",
    "Suppress response output (exit code still reflects errors)",
  )
  .action(async (options, query?: string) => {
    setMachineOutput(true)
    try {
      const resolvedQuery = await resolveQuery(query)
      const document = parseDocument(resolvedQuery)
      const operation = selectOperation(document, options.operationName)
      if (options.paginate && operation.operation !== "query") {
        throw new AppValidationError(
          "--paginate only supports query operations",
        )
      }
      if (operation.operation === "subscription") {
        throw new AppValidationError(
          "Subscriptions are not supported by this HTTP request command",
        )
      }
      if (operation.operation === "mutation" && !options.unprotected) {
        throw new AppValidationError("Raw mutations require --unprotected", {
          suggestion:
            "Use a dedicated command for domain guards. --unprotected only permits raw transport; it does not provide guards, receipts or checkpoints.",
        })
      }
      if (options.unprotected && operation.operation !== "mutation") {
        throw new AppValidationError(
          "--unprotected only applies to mutation operations",
        )
      }
      const connectionPath = options.paginate
        ? paginationPath(document, operation)
        : undefined
      const variables = await buildVariables(
        options.variable,
        options.variablesJson,
      )
      if (options.paginate && variables.after != null) {
        throw new AppValidationError(
          "--paginate starts at the first page; omit the after variable",
          {
            suggestion:
              "To read a bounded page from an existing cursor, omit --paginate.",
          },
        )
      }

      const apiKey = getResolvedApiKey()
      if (!apiKey) {
        throw new AppValidationError(
          "No API key configured",
          {
            suggestion:
              "Set LINEAR_API_KEY, add api_key to .linear.toml, or run `linear auth login`.",
          },
        )
      }

      const headers = {
        "Content-Type": "application/json",
        Authorization: apiKey,
        "User-Agent": `jihuanshe-linear/${denoConfig.version}`,
      }

      const request = {
        query: resolvedQuery,
        ...(options.operationName
          ? { operationName: options.operationName }
          : {}),
      }
      if (connectionPath) {
        await executePaginated(
          request,
          variables,
          headers,
          options.silent ?? false,
          connectionPath,
        )
      } else {
        await executeSingle(
          request,
          variables,
          headers,
          options.silent ?? false,
          operation.operation === "mutation",
        )
      }
    } catch (error) {
      handleError(error, "API request failed")
    }
  })

function parseDocument(query: string): DocumentNode {
  try {
    return parse(query)
  } catch (error) {
    throw new AppValidationError(
      `Invalid GraphQL document: ${
        error instanceof Error ? error.message : String(error)
      }`,
    )
  }
}

function selectOperation(
  document: DocumentNode,
  operationName?: string,
): OperationDefinitionNode {
  const operations = document.definitions.filter((definition) =>
    definition.kind === Kind.OPERATION_DEFINITION &&
    (operationName == null || definition.name?.value === operationName)
  ) as OperationDefinitionNode[]
  if (operations.length !== 1) {
    throw new AppValidationError(
      operationName == null
        ? "Provide exactly one operation or select one with --operation-name"
        : `--operation-name ${operationName} must identify exactly one operation`,
    )
  }
  return operations[0]!
}

/** Bind pagination to the selected operation and the field receiving $after. */
function paginationPath(
  document: DocumentNode,
  operation: OperationDefinitionNode,
): string[] {
  const after = operation.variableDefinitions?.find((definition) =>
    definition.variable.name.value === "after"
  )
  if (
    after?.type.kind !== Kind.NAMED_TYPE || after.type.name.value !== "String"
  ) {
    throw new AppValidationError(
      "--paginate requires the selected query to declare $after: String",
    )
  }
  const fragments = new Map(
    document.definitions.flatMap((definition) =>
      definition.kind === Kind.FRAGMENT_DEFINITION
        ? [[definition.name.value, definition] as const]
        : []
    ),
  )
  const paths = new Map<string, string[]>()
  function walk(
    selectionSet: SelectionSetNode,
    path: string[],
    active = new Set<string>(),
  ) {
    for (const selection of selectionSet.selections) {
      if (selection.kind === Kind.FIELD) {
        const next = [...path, selection.alias?.value ?? selection.name.value]
        if (
          selection.arguments?.some((argument) =>
            argument.name.value === "after" &&
            argument.value.kind === Kind.VARIABLE &&
            argument.value.name.value === "after"
          )
        ) {
          paths.set(JSON.stringify(next), next)
        }
        if (selection.selectionSet) walk(selection.selectionSet, next, active)
      } else if (selection.kind === Kind.INLINE_FRAGMENT) {
        walk(selection.selectionSet, path, active)
      } else {
        const name = selection.name.value
        const fragment = fragments.get(name)
        if (!fragment || active.has(name)) {
          throw new AppValidationError(
            `Cannot paginate missing or cyclic fragment ${name}`,
          )
        }
        walk(fragment.selectionSet, path, new Set([...active, name]))
      }
    }
  }
  walk(operation.selectionSet, ["data"])
  if (paths.size !== 1) {
    throw new AppValidationError(
      "--paginate requires exactly one connection using after: $after",
      {
        suggestion: "Split independent connections into separate queries.",
      },
    )
  }
  return [...paths.values()][0]!
}

interface RawRequest {
  query: string
  operationName?: string
}

async function requestPage(
  request: RawRequest,
  variables: Record<string, unknown>,
  headers: Record<string, string>,
  silent: boolean,
): Promise<Record<string, unknown>> {
  const body: Record<string, unknown> = { ...request }
  if (Object.keys(variables).length > 0) {
    body.variables = variables
  }

  const response = await fetch(getGraphQLEndpoint(), {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  })

  const text = await response.text()

  const parsed = parseResponse(text)
  const hasGraphQLErrors = Array.isArray(parsed.errors) &&
    parsed.errors.length > 0
  if (!response.ok || hasGraphQLErrors) {
    // Preserve partial data and GraphQL errors, including HTTP 400 RATELIMITED.
    // No retry: a raw mutation may already have had effects.
    if (!silent) outputJSON(parsed, text)
    Deno.exit(1)
  }
  return parsed
}

async function executeSingle(
  request: RawRequest,
  variables: Record<string, unknown>,
  headers: Record<string, string>,
  silent: boolean,
  mutation: boolean,
): Promise<void> {
  let parsed: Record<string, unknown>
  try {
    parsed = await requestPage(request, variables, headers, silent)
  } catch (error) {
    if (mutation) {
      throw new WriteError(
        "Raw mutation outcome is unknown; no GraphQL result was received",
        {
          effect: "unknown",
          cause: error,
          suggestion:
            "Reconcile the target object's state before any retry. This command did not retry the mutation.",
        },
      )
    }
    throw error
  }
  if (!silent) outputJSON(parsed, JSON.stringify(parsed))
}

async function executePaginated(
  request: RawRequest,
  variables: Record<string, unknown>,
  headers: Record<string, string>,
  silent: boolean,
  connectionPath: string[],
): Promise<void> {
  let mergedResponse: Record<string, unknown> | undefined
  async function readPage(after: string | null): Promise<Connection<unknown>> {
    const parsed = await requestPage(
      request,
      { ...variables, after },
      headers,
      silent,
    )
    if (countConnections(parsed.data) > 1) {
      throw new AppValidationError(
        "--paginate does not support queries with multiple paginated connections",
        {
          suggestion:
            "Use cursor-based pagination manually with $after and pageInfo { hasNextPage endCursor }.",
        },
      )
    }

    mergedResponse ??= parsed
    return getConnection(parsed, connectionPath)
  }
  const connection = await completeConnection(
    await readPage(null),
    readPage,
    "API",
  )
  if (!silent && mergedResponse) {
    replaceConnectionPage(
      mergedResponse,
      connectionPath,
      connection.nodes,
      connection.pageInfo,
    )
    outputJSON(mergedResponse, JSON.stringify(mergedResponse))
  }
}

function getConnection(
  response: Record<string, unknown>,
  path: string[],
): Connection<unknown> {
  let value: unknown = response
  for (const segment of path) {
    if (value == null || typeof value !== "object" || Array.isArray(value)) {
      throw new CliError(
        "Incomplete API pagination: connection path is missing or changed",
      )
    }
    value = (value as Record<string, unknown>)[segment]
  }
  if (value == null || typeof value !== "object" || Array.isArray(value)) {
    throw new CliError(
      "Incomplete API pagination: connection path is missing or changed",
    )
  }
  // completeConnection validates untrusted nodes/pageInfo before consuming them.
  return value as Connection<unknown>
}

function replaceConnectionPage(
  response: Record<string, unknown>,
  path: string[],
  nodes: unknown[],
  pageInfo: Record<string, unknown>,
): void {
  let value: unknown = response
  for (const segment of path) {
    if (value == null || typeof value !== "object") {
      throw new CliError(
        "Could not locate the paginated connection in response",
      )
    }
    value = (value as Record<string, unknown>)[segment]
  }

  if (value == null || typeof value !== "object") {
    throw new CliError("Could not locate the paginated connection in response")
  }

  const connection = value as Record<string, unknown>
  connection.nodes = nodes
  connection.pageInfo = pageInfo
}

function countConnections(obj: unknown): number {
  if (obj == null || typeof obj !== "object") return 0

  const record = obj as Record<string, unknown>

  if ("pageInfo" in record && "nodes" in record) {
    return 1
  }

  let count = 0
  for (const value of Object.values(record)) {
    count += countConnections(value)
  }

  return count
}

function parseResponse(text: string): Record<string, unknown> {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new CliError("API response is not valid JSON")
  }
  if (
    parsed == null || typeof parsed !== "object" || Array.isArray(parsed) ||
    !("data" in parsed || "errors" in parsed)
  ) {
    throw new CliError("API response is not a GraphQL response object")
  }
  if (
    ("errors" in parsed &&
      (!Array.isArray(parsed.errors) || parsed.errors.length === 0 ||
        parsed.errors.some((error: unknown) =>
          error == null || typeof error !== "object" ||
          !("message" in error) || typeof error.message !== "string"
        ))) ||
    ("data" in parsed && parsed.data != null &&
      (typeof parsed.data !== "object" || Array.isArray(parsed.data))) ||
    (!("errors" in parsed) && (!("data" in parsed) || parsed.data == null))
  ) {
    throw new CliError("API response has invalid GraphQL result fields")
  }
  return parsed as Record<string, unknown>
}

function outputJSON(parsed: unknown, rawText: string): void {
  if (Deno.stdout.isTerminal()) {
    try {
      console.log(JSON.stringify(parsed, null, 2))
    } catch {
      console.log(rawText)
    }
  } else {
    Deno.stdout.writeSync(new TextEncoder().encode(
      typeof parsed === "string" ? rawText : JSON.stringify(parsed),
    ))
  }
}

async function resolveQuery(positionalArg?: string): Promise<string> {
  if (positionalArg && positionalArg !== "-") {
    return positionalArg
  }

  const explicit = positionalArg === "-"

  if (explicit || !Deno.stdin.isTerminal()) {
    const content = explicit
      ? await readAllStdin()
      : await readStdinWithTimeout()
    if (content) {
      return content
    }
  }

  throw new AppValidationError("No query provided", {
    suggestion:
      "Provide a query as an argument: linear api '{ viewer { id } }'\n  Or pipe from stdin: echo '{ viewer { id } }' | linear api",
  })
}

async function readAllStdin(): Promise<string | undefined> {
  const chunks: Uint8Array[] = []
  for await (const chunk of Deno.stdin.readable) {
    chunks.push(chunk)
  }
  const text = new TextDecoder().decode(concatChunks(chunks)).trim()
  return text.length > 0 ? text : undefined
}

async function readStdinWithTimeout(): Promise<string | undefined> {
  try {
    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error("stdin timeout")), 100)
    })
    const result = await Promise.race([readAllStdin(), timeoutPromise])
    return result
  } catch {
    return undefined
  }
}

function concatChunks(chunks: Uint8Array[]): Uint8Array {
  const totalLength = chunks.reduce((sum, c) => sum + c.length, 0)
  const combined = new Uint8Array(totalLength)
  let offset = 0
  for (const chunk of chunks) {
    combined.set(chunk, offset)
    offset += chunk.length
  }
  return combined
}

async function buildVariables(
  variableEntries?: [string, string][],
  variablesJson?: string,
): Promise<Record<string, unknown>> {
  const variables: Record<string, unknown> = {}

  if (variablesJson != null) {
    let parsed: unknown
    try {
      parsed = JSON.parse(variablesJson)
    } catch {
      throw new AppValidationError(
        `Invalid JSON for --variables-json: ${variablesJson}`,
        {
          suggestion:
            'Provide a valid JSON object, e.g. --variables-json \'{"key": "value"}\'',
        },
      )
    }
    if (parsed == null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new AppValidationError(
        `--variables-json must be a JSON object, got ${
          Array.isArray(parsed) ? "array" : typeof parsed
        }`,
        {
          suggestion:
            'Provide a JSON object, e.g. --variables-json \'{"key": "value"}\'',
        },
      )
    }
    Object.assign(variables, parsed)
  }

  if (variableEntries) {
    for (const [key, rawValue] of variableEntries) {
      variables[key] = await resolveTypedValue(rawValue)
    }
  }

  return variables
}

async function resolveTypedValue(value: string): Promise<unknown> {
  if (value === "@-") {
    const content = await readAllStdin()
    if (content == null) {
      throw new AppValidationError("No data on stdin for @- value")
    }
    return parseJSONOrString(content)
  }

  if (value.startsWith("@")) {
    const filePath = value.slice(1)
    try {
      const content = await Deno.readTextFile(filePath)
      return parseJSONOrString(content.trim())
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) {
        throw new AppValidationError(`File not found: ${filePath}`)
      }
      throw new CliError(
        `Failed to read file: ${filePath}`,
        { cause: error },
      )
    }
  }

  return coerceValue(value)
}

function parseJSONOrString(content: string): unknown {
  try {
    return JSON.parse(content)
  } catch {
    return content
  }
}

function coerceValue(value: string): unknown {
  if (value === "true") return true
  if (value === "false") return false
  if (value === "null") return null

  const num = Number(value)
  if (value !== "" && !isNaN(num) && String(num) === value) return num

  return value
}

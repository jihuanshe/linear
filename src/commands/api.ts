import { Command } from "@cliffy/command"
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
import { graphqlFetch } from "../utils/graphql-transport.ts"
import { completeConnection, type Connection } from "../utils/pagination.ts"
import { setMachineOutput } from "../utils/write-result.ts"
import {
  CliError,
  handleError,
  ValidationError as AppValidationError,
  WriteError,
} from "../utils/errors.ts"

export const apiCommand = withUsageMetadata(new Command(), {
  writes: true,
  outputModes: ["json"],
})
  .name("api")
  .description(
    "Run raw GraphQL queries or explicitly unprotected mutations.\n\nPass a query argument or '-' to read stdin to EOF.\n\nRaw mutations require --unprotected and do not provide domain guards, receipts or checkpoints. Queries may retry explicit server overload responses within a bounded deadline; mutations are never retried. Inspect data/errors and reconcile uncertain writes.",
  )
  .arguments("[query:string]")
  .option(
    "--variables-json <json:string>",
    "JSON object of variables (mutually exclusive with --variables-file)",
    { preserveEmpty: true },
  )
  .option(
    "--variables-file <path:string>",
    "Read a JSON object of variables from a file, not stdin (mutually exclusive with --variables-json)",
    { preserveEmpty: true },
  )
  .option(
    "--operation-name <name:string>",
    "Select the GraphQL operation (required when the document contains multiple operations)",
    { preserveEmpty: true },
  )
  .option(
    "--unprotected",
    "Explicitly allow a raw mutation without domain guards, receipts or checkpoints",
  )
  .option(
    "--paginate",
    "Read one query connection to its final page using $after (mutations are rejected)",
  )
  .action(async (options, query?: string) => {
    setMachineOutput(true)
    try {
      const variables = await buildVariables(
        options.variablesJson,
        options.variablesFile,
      )
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
      if (options.paginate && variables.after != null) {
        throw new AppValidationError(
          "--paginate starts at the first page; omit the after variable",
          {
            suggestion:
              "To read a bounded page from an existing cursor, omit --paginate.",
          },
        )
      }

      const apiKey = await getResolvedApiKey()
      if (!apiKey) {
        throw new AppValidationError(
          "No API key configured",
          {
            suggestion: "Set LINEAR_API_KEY or run `linear auth login`.",
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
          connectionPath,
        )
      } else {
        await executeSingle(
          request,
          variables,
          headers,
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
          if (
            selection.arguments?.some((argument) =>
              argument.name.value === "last" || argument.name.value === "before"
            )
          ) {
            throw new AppValidationError(
              "--paginate supports forward pagination only; remove last and before arguments",
            )
          }
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
): Promise<Record<string, unknown>> {
  const body: Record<string, unknown> = { ...request }
  if (Object.keys(variables).length > 0) {
    body.variables = variables
  }

  const response = await graphqlFetch(getGraphQLEndpoint(), {
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
    // The shared transport only retries definitively selected queries.
    outputJSON(parsed, text)
    Deno.exit(1)
  }
  return parsed
}

async function executeSingle(
  request: RawRequest,
  variables: Record<string, unknown>,
  headers: Record<string, string>,
  mutation: boolean,
): Promise<void> {
  let parsed: Record<string, unknown>
  try {
    parsed = await requestPage(request, variables, headers)
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
  outputJSON(parsed, JSON.stringify(parsed))
}

async function executePaginated(
  request: RawRequest,
  variables: Record<string, unknown>,
  headers: Record<string, string>,
  connectionPath: string[],
): Promise<void> {
  let mergedResponse: Record<string, unknown> | undefined
  async function readPage(after: string | null): Promise<Connection<unknown>> {
    const parsed = await requestPage(
      request,
      { ...variables, after },
      headers,
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
  if (mergedResponse) {
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

  if (positionalArg === "-") {
    const content = (await new Response(Deno.stdin.readable).text()).trim()
    if (content) {
      return content
    }
  }

  throw new AppValidationError("No query provided", {
    suggestion:
      "Provide a query as an argument: linear api '{ viewer { id } }'\n  Or read stdin explicitly: linear api - < query.graphql",
  })
}

async function buildVariables(
  variablesJson?: string,
  variablesFile?: string,
): Promise<Record<string, unknown>> {
  if (variablesJson != null && variablesFile != null) {
    throw new AppValidationError(
      "--variables-json and --variables-file are mutually exclusive",
    )
  }
  if (variablesFile != null) {
    if (variablesFile === "" || variablesFile === "-") {
      throw new AppValidationError(
        "--variables-file requires a file path, not stdin",
      )
    }
    try {
      variablesJson = await Deno.readTextFile(variablesFile)
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) {
        throw new AppValidationError(`File not found: ${variablesFile}`)
      }
      throw new CliError(
        `Failed to read file: ${variablesFile}`,
        { cause: error },
      )
    }
  }
  if (variablesJson == null) return {}
  const source = variablesFile == null ? "--variables-json" : "--variables-file"
  let parsed: unknown
  try {
    parsed = JSON.parse(variablesJson)
  } catch {
    throw new AppValidationError(`Invalid JSON for ${source}`)
  }
  if (parsed == null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new AppValidationError(`${source} must be a JSON object`)
  }
  return parsed as Record<string, unknown>
}

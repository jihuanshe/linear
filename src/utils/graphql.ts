import { ClientError, GraphQLClient } from "graphql-request"
import { gray } from "@std/fmt/colors"
import { getCliWorkspace, getOption } from "../config.ts"
import { getCredentialApiKey } from "../credentials.ts"
import denoConfig from "../../deno.json" with { type: "json" }
import { extractGraphQLMessage, isDebugMode, WriteError } from "./errors.ts"
import { Kind, parse } from "graphql"
import { LINEAR_API_ENDPOINT } from "../const.ts"
import { withTerminalColors } from "./terminal.ts"
import { AsyncLocalStorage } from "node:async_hooks"

export { ClientError }

// One invocation resolves its credentials once. A login/config change during
// a long apply must not swap the principal after workspace verification.
const invocationClient = new AsyncLocalStorage<
  { active: boolean; client?: GraphQLClient }
>()

export function withGraphQLContext<T>(action: () => Promise<T>): Promise<T> {
  const invocation: { active: boolean; client?: GraphQLClient } = {
    active: true,
  }
  return invocationClient.run(invocation, async () => {
    try {
      return await action()
    } finally {
      // The cache belongs to this awaited invocation. A still-reachable async
      // context must not lend its finished invocation's principal to later work.
      invocation.active = false
      invocation.client = undefined
    }
  })
}

// Re-export error utilities for backward compatibility
export { isClientError } from "./errors.ts"

/**
 * Logs a GraphQL ClientError formatted for display to the user.
 * @deprecated Use handleError from errors.ts for consistent error handling
 */
export function logClientError(error: ClientError): void {
  const message = extractGraphQLMessage(error)
  console.error(`✗ ${message}\n`)

  // Only show query details in debug mode
  if (isDebugMode()) {
    withTerminalColors(Deno.stderr, () => {
      const rawQuery = error.request?.query
      const query = typeof rawQuery === "string" ? rawQuery.trim() : rawQuery
      const vars = JSON.stringify(error.request?.variables, null, 2)

      console.error(gray(String(query)))
      console.error("")
      console.error(gray(vars))
    })
  }
}

function workspaceCredentialNotFound(workspace: string): Error {
  return new Error(
    `Workspace "${workspace}" not found in credentials. ` +
      `Run \`linear auth login\` to add it, or \`linear auth list\` to see configured workspaces.`,
  )
}

/**
 * Get the resolved API key following the precedence chain:
 * 1. LINEAR_API_KEY env var (conflicts with --workspace)
 * 2. api_key in project config
 * 3. --workspace flag → credentials lookup
 * 4. Project's workspace config → credentials lookup
 * 5. default workspace from credentials file
 */
export function getResolvedApiKey(): string | undefined {
  const cliWorkspace = getCliWorkspace()
  const envApiKey = Deno.env.get("LINEAR_API_KEY")

  // Error if both LINEAR_API_KEY and --workspace are set
  if (envApiKey && cliWorkspace) {
    throw new Error(
      "Cannot use --workspace flag when LINEAR_API_KEY environment variable is set. " +
        "Either unset LINEAR_API_KEY or remove the --workspace flag.",
    )
  }

  // 1: LINEAR_API_KEY env var
  if (envApiKey) {
    return envApiKey
  }

  // 2: api_key in project config
  const configApiKey = getOption("api_key")
  if (configApiKey) {
    return configApiKey
  }

  // 3: --workspace flag → credentials lookup
  if (cliWorkspace) {
    const key = getCredentialApiKey(cliWorkspace)
    if (key) return key
    // Explicit --workspace flag must match a configured workspace
    throw workspaceCredentialNotFound(cliWorkspace)
  }

  // 4: Project's workspace config → credentials lookup
  const projectWorkspace = getOption("workspace")
  if (projectWorkspace) {
    const key = getCredentialApiKey(projectWorkspace)
    if (key) return key
    throw workspaceCredentialNotFound(projectWorkspace)
  }

  // 5: Default workspace from credentials file
  return getCredentialApiKey()
}

/**
 * Get the GraphQL endpoint URL.
 */
export function getGraphQLEndpoint(): string {
  return Deno.env.get("LINEAR_GRAPHQL_ENDPOINT") || LINEAR_API_ENDPOINT
}

function createClient(apiKey?: string): GraphQLClient {
  return new GraphQLClient(getGraphQLEndpoint(), {
    headers: {
      ...(apiKey == null ? {} : { Authorization: apiKey }),
      "User-Agent": `jihuanshe-linear/${denoConfig.version}`,
    },
    fetch: async (input, init) => {
      // All typed requests use GraphQL JSON. Classify before transport so a
      // fetch exception after sending a mutation is never called zero-effect.
      let mutation = false
      if (typeof init?.body === "string") {
        const body = JSON.parse(init.body) as { query?: string }
        if (typeof body.query === "string") {
          mutation = parse(body.query).definitions.some((definition) =>
            definition.kind === Kind.OPERATION_DEFINITION &&
            definition.operation === "mutation"
          )
        }
      }
      try {
        const response = await fetch(input, init)
        if (!mutation) return response
        // Buffer the small GraphQL receipt here as well: body interruption or
        // invalid JSON after HTTP headers is still an unknown mutation.
        const text = await response.text()
        const decoded: unknown = JSON.parse(text)
        const envelope = decoded != null && typeof decoded === "object" &&
            !Array.isArray(decoded)
          ? decoded as { data?: unknown; errors?: unknown }
          : undefined
        const hasErrors = Array.isArray(envelope?.errors) &&
          envelope.errors.length > 0
        if (
          envelope == null ||
          (!hasErrors &&
            (envelope.data == null || typeof envelope.data !== "object" ||
              Array.isArray(envelope.data)))
        ) {
          throw new WriteError(
            "Mutation response did not contain GraphQL data",
            {
              effect: "unknown",
              data: decoded,
              suggestion:
                "Reconcile the remote outcome before retrying this write.",
            },
          )
        }
        return new Response(text, {
          status: response.status,
          statusText: response.statusText,
          headers: response.headers,
        })
      } catch (cause) {
        if (!mutation) throw cause
        if (cause instanceof WriteError) throw cause
        throw new WriteError("Mutation response was not received", {
          effect: "unknown",
          cause,
          suggestion:
            "Reconcile the remote outcome before retrying this write.",
        })
      }
    },
  })
}

/**
 * Create a GraphQL client with an explicit API key.
 * Use this when you need to validate a specific key (e.g., during auth login).
 */
export function createGraphQLClient(apiKey: string): GraphQLClient {
  return createClient(apiKey)
}

/** Create an unauthenticated client for public GraphQL operations. */
export function createPublicGraphQLClient(): GraphQLClient {
  return createClient()
}

export function getGraphQLClient(): GraphQLClient {
  const invocation = invocationClient.getStore()
  if (invocation?.active && invocation.client != null) return invocation.client
  const apiKey = getResolvedApiKey()
  if (!apiKey) {
    throw new Error(
      "No API key configured. Set LINEAR_API_KEY, add api_key to .linear.toml, or run `linear auth login`.",
    )
  }

  const client = createGraphQLClient(apiKey)
  if (invocation?.active) invocation.client = client
  return client
}

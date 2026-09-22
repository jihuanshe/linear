import { ClientError, GraphQLClient } from "graphql-request"
import {
  getCliWorkspace,
  getOption,
  loadConfig,
  loadEnvironment,
} from "../config.ts"
import { getCredentialApiKey } from "../credentials.ts"
import denoConfig from "../../deno.json" with { type: "json" }
import { AuthError, ValidationError, WriteError } from "./errors.ts"
import { graphqlFetch, graphQLOperation } from "./graphql-transport.ts"
import { LINEAR_API_ENDPOINT } from "../const.ts"
import { AsyncLocalStorage } from "node:async_hooks"

export { ClientError }

// One invocation resolves its credentials once. A login/config change during
// a long apply must not swap the principal after workspace verification.
interface Invocation {
  active: boolean
  client?: GraphQLClient
  apiKey?: Promise<string | undefined>
}

const invocationClient = new AsyncLocalStorage<Invocation>()

export function withGraphQLContext<T>(action: () => Promise<T>): Promise<T> {
  const invocation: Invocation = {
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
      invocation.apiKey = undefined
    }
  })
}

function workspaceCredentialNotFound(workspace: string): Error {
  return new AuthError(
    `Workspace "${workspace}" not found in credentials. ` +
      `Run \`linear auth login\` to add it, or \`linear auth list\` to see configured workspaces.`,
  )
}

/**
 * Get the resolved API key following the precedence chain:
 * 1. LINEAR_API_KEY env var (conflicts with --workspace)
 * 2. --workspace flag → credentials lookup
 * 3. LINEAR_WORKSPACE or project's workspace config → credentials lookup
 * 4. default workspace from credentials file
 */
async function resolveApiKey(): Promise<string | undefined> {
  // Reject obsolete/invalid selected configuration even if an env key exists.
  loadConfig()
  const cliWorkspace = getCliWorkspace()
  const envApiKey = Deno.env.get("LINEAR_API_KEY")

  // Error if both LINEAR_API_KEY and --workspace are set
  if (envApiKey != null && cliWorkspace != null) {
    throw new AuthError(
      "Cannot use --workspace flag when LINEAR_API_KEY environment variable is set. " +
        "Either unset LINEAR_API_KEY or remove the --workspace flag.",
      {
        suggestion:
          "To keep using the environment credential, remove --workspace and run linear auth whoami --json to confirm organization.urlKey before continuing. To use stored workspace credentials instead, unset LINEAR_API_KEY and remove it from any loaded .env, then retain --workspace.",
      },
    )
  }

  if (envApiKey != null) {
    if (envApiKey.trim() === "") throw new AuthError("LINEAR_API_KEY is empty")
    return envApiKey
  }

  if (cliWorkspace != null) {
    if (cliWorkspace === "") {
      throw new ValidationError("--workspace must not be empty")
    }
    const key = await getCredentialApiKey(cliWorkspace)
    if (key) return key
    // Explicit --workspace flag must match a configured workspace
    throw workspaceCredentialNotFound(cliWorkspace)
  }

  const projectWorkspace = getOption("workspace")
  if (projectWorkspace != null) {
    const key = await getCredentialApiKey(projectWorkspace)
    if (key) return key
    throw workspaceCredentialNotFound(projectWorkspace)
  }

  return await getCredentialApiKey()
}

/** Resolve once per invocation, shared by typed requests and attachment fetches. */
export function getResolvedApiKey(): Promise<string | undefined> {
  const invocation = invocationClient.getStore()
  if (!invocation?.active) return resolveApiKey()
  return invocation.apiKey ??= resolveApiKey()
}

/**
 * Get the GraphQL endpoint URL.
 */
export function getGraphQLEndpoint(): string {
  loadEnvironment()
  return Deno.env.get("LINEAR_GRAPHQL_ENDPOINT") || LINEAR_API_ENDPOINT
}

function createClient(
  apiKey?: string | (() => Promise<string>),
): GraphQLClient {
  return new GraphQLClient(getGraphQLEndpoint(), {
    headers: {
      ...(typeof apiKey === "string" ? { Authorization: apiKey } : {}),
      "User-Agent": `jihuanshe-linear/${denoConfig.version}`,
    },
    fetch: async (input, init) => {
      // Authentication and local validation happen before the dispatch boundary.
      // They must never become an unknown mutation or trigger transport retries.
      if (typeof apiKey === "function") {
        const key = await apiKey()
        const headers = new Headers(init?.headers)
        headers.set("Authorization", key)
        init = { ...init, headers }
      }
      // All typed requests use GraphQL JSON. Classify before transport so a
      // fetch exception after sending a mutation is never called zero-effect.
      const operation = graphQLOperation(init?.body)
      const mutation = operation === "mutation" || operation == null
      try {
        const response = await graphqlFetch(input, init)
        if (!mutation) return response
        // Transport has already bounded and buffered the receipt. Invalid JSON
        // or a missing receipt after headers is still an unknown mutation.
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
  let resolved: Promise<string> | undefined
  const client = createClient(() =>
    resolved ??= (async () => {
      const apiKey = await getResolvedApiKey()
      if (!apiKey) {
        throw new AuthError("No API key configured", {
          suggestion: "Set LINEAR_API_KEY or run `linear auth login`.",
        })
      }
      return apiKey
    })()
  )
  if (invocation?.active) invocation.client = client
  return client
}

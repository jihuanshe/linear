/**
 * User-friendly error handling for the Linear CLI.
 *
 * Design philosophy (inspired by Rust's error handling ecosystem):
 * - User-facing messages should be clean and actionable
 * - Stack traces only shown when LINEAR_DEBUG=1
 * - Errors should explain what went wrong and suggest how to fix it
 * - GraphQL errors should be parsed and presented nicely
 */

import { ClientError } from "graphql-request"
import { gray, red } from "@std/fmt/colors"
import { withTerminalColors } from "./terminal.ts"
import { Kind, parse } from "graphql"
import { isMachineOutput, type WriteEffect } from "./write-result.ts"

/**
 * Check if debug mode is enabled via LINEAR_DEBUG environment variable.
 */
export function isDebugMode(): boolean {
  const debug = Deno.env.get("LINEAR_DEBUG")
  return debug === "1" || debug === "true"
}

/**
 * Base class for CLI errors with user-friendly messages.
 */
export class CliError extends Error {
  /** The clean, user-facing message */
  readonly userMessage: string
  /** Suggestion for how to fix the issue (optional) */
  readonly suggestion?: string
  readonly details?: unknown

  constructor(
    userMessage: string,
    options?: { suggestion?: string; cause?: unknown; details?: unknown },
  ) {
    super(userMessage)
    this.name = "CliError"
    this.userMessage = userMessage
    this.suggestion = options?.suggestion
    this.details = options?.details
    if (options?.cause) {
      this.cause = options.cause
    }
  }
}

/** A write's observed effect survives subsequent validation or read failure. */
export class WriteError extends CliError {
  readonly effect: WriteEffect
  readonly data?: unknown
  readonly receipts?: unknown

  constructor(message: string, options: {
    effect: WriteEffect
    data?: unknown
    receipts?: unknown
    suggestion?: string
    cause?: unknown
    details?: unknown
  }) {
    super(message, options)
    this.name = "WriteError"
    this.effect = options.effect
    this.data = options.data
    this.receipts = options.receipts
  }
}

/** A failed or malformed mutation payload is not proof that no effect landed. */
export function assertMutationSuccess(payload: unknown, data: unknown): void {
  if (
    payload == null || typeof payload !== "object" ||
    !Object.hasOwn(payload, "success") ||
    (payload as { success: unknown }).success !== true
  ) {
    throw new WriteError("Mutation was not confirmed", {
      effect: "unknown",
      data,
      suggestion: "Reconcile the remote outcome before retrying this write.",
    })
  }
}

/** Call after success:true; missing/wrong identity preserves that acknowledgement. */
export function assertMutationReceipt<T extends { id?: unknown }>(
  entity: T | null | undefined,
  data: unknown,
  expectedId?: string,
): asserts entity is T & { id: string } {
  if (entity == null || typeof entity.id !== "string" || entity.id === "") {
    throw new WriteError("Mutation succeeded but returned no object identity", {
      effect: "applied",
      data,
      suggestion:
        "Locate the created or changed object before continuing; do not repeat the mutation.",
    })
  }
  if (
    expectedId != null && entity.id.toLowerCase() !== expectedId.toLowerCase()
  ) {
    throw new WriteError("Mutation returned a different object identity", {
      effect: "applied",
      data,
      suggestion: "Reconcile the returned object before continuing.",
    })
  }
}

function requestWasMutation(error: ClientError): boolean {
  try {
    const query = error.request.query
    return (Array.isArray(query) ? query : [query]).some((source) => {
      const document = typeof source === "string" ? parse(source) : source
      return document.definitions.some((definition) =>
        definition.kind === Kind.OPERATION_DEFINITION &&
        definition.operation === "mutation"
      )
    })
  } catch {
    // A received ClientError with an unclassifiable request cannot prove
    // zero effects. Fail conservatively rather than authorizing a retry.
    return true
  }
}

/** Only an unambiguous, directly selected mutation acknowledgement is proof. */
function mutationWasAcknowledged(error: ClientError): boolean {
  try {
    const query = error.request.query
    if (Array.isArray(query)) return false
    const document = typeof query === "string" ? parse(query) : query
    if (document.definitions.length !== 1) return false
    const operation = document.definitions[0]
    if (
      operation.kind !== Kind.OPERATION_DEFINITION ||
      operation.operation !== "mutation" ||
      operation.selectionSet.selections.length !== 1
    ) return false
    const field = operation.selectionSet.selections[0]
    if (
      field.kind !== Kind.FIELD || field.alias != null ||
      (field.directives?.length ?? 0) !== 0
    ) return false
    const selections = field.selectionSet?.selections
    if (
      selections == null ||
      selections.some((selection) => selection.kind !== Kind.FIELD)
    ) return false
    const success = selections.filter((selection) =>
      selection.kind === Kind.FIELD &&
      (selection.alias?.value ?? selection.name.value) === "success"
    )
    if (
      success.length !== 1 || success[0].kind !== Kind.FIELD ||
      success[0].name.value !== "success" || success[0].alias != null ||
      (success[0].directives?.length ?? 0) !== 0
    ) return false
    const data: unknown = error.response.data
    if (
      data == null || typeof data !== "object" || Array.isArray(data) ||
      !Object.hasOwn(data, field.name.value)
    ) return false
    const payload = (data as Record<string, unknown>)[field.name.value]
    return payload != null && typeof payload === "object" &&
      !Array.isArray(payload) && Object.hasOwn(payload, "success") &&
      (payload as { success: unknown }).success === true
  } catch {
    return false
  }
}

export function errorResult(error: unknown, context?: string) {
  const message = error instanceof CliError
    ? error.userMessage
    : isClientError(error)
    ? extractGraphQLMessage(error)
    : error instanceof Error
    ? error.message
    : String(error)
  const effect: WriteEffect = error instanceof WriteError
    ? error.effect
    : isClientError(error) && requestWasMutation(error)
    ? mutationWasAcknowledged(error) ? "applied" : "unknown"
    : "none"
  return {
    ok: false as const,
    effect,
    ...(error instanceof WriteError && error.data !== undefined
      ? { data: error.data }
      : isClientError(error) && requestWasMutation(error) &&
          error.response.data !== undefined
      ? { data: error.response.data }
      : {}),
    ...(error instanceof WriteError && error.receipts !== undefined
      ? { receipts: error.receipts }
      : {}),
    error: {
      code: error instanceof Error ? error.name : "Error",
      message: context == null ? message : `${context}: ${message}`,
      ...(error instanceof CliError && error.suggestion != null
        ? { suggestion: error.suggestion }
        : effect === "unknown"
        ? {
          suggestion:
            "Reconcile the remote outcome before retrying this write.",
        }
        : {}),
      ...(error instanceof CliError && error.details !== undefined
        ? { details: error.details }
        : isClientError(error)
        ? { details: { errors: error.response.errors } }
        : {}),
    },
  }
}

/** Preserve confirmed earlier effects when a later step of a command fails. */
export function withAppliedReceipts(
  error: unknown,
  receipts: unknown[],
): unknown {
  if (receipts.length === 0) return error
  const result = errorResult(error)
  return new WriteError(result.error.message, {
    effect: result.effect === "unknown" ? "unknown" : "applied",
    cause: error,
    suggestion: result.error.suggestion,
    ...(result.data === undefined ? {} : { data: result.data }),
    ...("details" in result.error ? { details: result.error.details } : {}),
    receipts: [
      ...receipts,
      ...(error instanceof WriteError && Array.isArray(error.receipts)
        ? error.receipts
        : []),
    ],
  })
}

/**
 * Error for when an entity (issue, project, team, etc.) is not found.
 */
export class NotFoundError extends CliError {
  readonly entityType: string
  readonly identifier: string

  constructor(
    entityType: string,
    identifier: string,
    options?: { suggestion?: string },
  ) {
    const message = `${entityType} not found: ${identifier}`
    super(message, options)
    this.name = "NotFoundError"
    this.entityType = entityType
    this.identifier = identifier
  }
}

/**
 * Error for invalid user input (arguments, flags, etc.).
 */
export class ValidationError extends CliError {
  constructor(message: string, options?: { suggestion?: string }) {
    super(message, options)
    this.name = "ValidationError"
  }
}

/**
 * Error for authentication/authorization issues.
 */
export class AuthError extends CliError {
  constructor(message: string, options?: { suggestion?: string }) {
    super(message, {
      suggestion: options?.suggestion ??
        "Run `linear auth login` to authenticate.",
      ...options,
    })
    this.name = "AuthError"
  }
}

/**
 * Extract a user-friendly message from a GraphQL ClientError.
 *
 * Tries to find:
 * 1. userPresentableMessage from Linear's API
 * 2. First error message from the response
 * 3. Falls back to the error message
 */
export function extractGraphQLMessage(error: ClientError): string {
  const extensions = error.response?.errors?.[0]?.extensions
  const userMessage = extensions?.userPresentableMessage as string | undefined

  if (userMessage) {
    return userMessage
  }

  const firstError = error.response?.errors?.[0]
  if (firstError?.message) {
    return firstError.message
  }

  return error.message
}

/**
 * Check if a GraphQL error indicates an entity was not found.
 */
export function isNotFoundError(error: ClientError): boolean {
  const message = extractGraphQLMessage(error).toLowerCase()
  return message.includes("not found") || message.includes("entity not found")
}

/**
 * Check if an error is a GraphQL ClientError.
 */
export function isClientError(error: unknown): error is ClientError {
  return error instanceof ClientError
}

/**
 * Format and display an error to the user.
 *
 * In normal mode: Shows a clean, user-friendly message
 * In debug mode (LINEAR_DEBUG=1): Also shows the full error details
 */
export function handleError(error: unknown, context?: string): never {
  if (isMachineOutput()) {
    console.log(JSON.stringify(errorResult(error, context), null, 2))
    Deno.exit(1)
  }
  withTerminalColors(Deno.stderr, () => {
    if (error instanceof CliError) {
      printCliError(error, context)
    } else if (isClientError(error)) {
      printGraphQLError(error, context)
    } else if (error instanceof Error) {
      printGenericError(error, context)
    } else {
      printUnknownError(error, context)
    }
  })

  const result = errorResult(error)
  if (result.effect !== "none") {
    console.error(
      `Write effect: ${result.effect}; do not blindly repeat the operation.`,
    )
    if (error instanceof WriteError && error.receipts !== undefined) {
      console.error(JSON.stringify({ receipts: error.receipts }))
    }
  }

  Deno.exit(1)
}

function printCliError(error: CliError, context?: string): void {
  const prefix = context ? `${context}: ` : ""
  console.error(red(`✗ ${prefix}${error.userMessage}`))

  if (error.suggestion) {
    console.error(gray(`  ${error.suggestion}`))
  }

  if (isDebugMode() && error.cause) {
    printDebugInfo(error.cause)
  }
}

function printGraphQLError(error: ClientError, context?: string): void {
  const message = extractGraphQLMessage(error)
  const prefix = context ? `${context}: ` : ""

  // Check for common error patterns and provide helpful messages
  if (isNotFoundError(error)) {
    console.error(red(`✗ ${prefix}${message}`))
  } else {
    console.error(red(`✗ ${prefix}${message}`))
  }

  if (isDebugMode()) {
    printDebugInfo(error)
    const query = error.request?.query
    const vars = error.request?.variables
    if (query) {
      console.error(gray("\nQuery:"))
      console.error(gray(String(query).trim()))
    }
    if (vars) {
      console.error(gray("\nVariables:"))
      console.error(gray(JSON.stringify(vars, null, 2)))
    }
  }
}

function printGenericError(error: Error, context?: string): void {
  const prefix = context ? `${context}: ` : ""
  console.error(red(`✗ ${prefix}${error.message}`))

  if (isDebugMode()) {
    printDebugInfo(error)
  }
}

function printUnknownError(error: unknown, context?: string): void {
  const prefix = context ? `${context}: ` : ""
  console.error(red(`✗ ${prefix}${String(error)}`))

  if (isDebugMode()) {
    console.error(gray("\nDebug info:"))
    console.error(gray(JSON.stringify(error, null, 2)))
  }
}

function printDebugInfo(error: unknown): void {
  console.error(gray("\nStack trace (LINEAR_DEBUG=1):"))
  if (error instanceof Error && error.stack) {
    console.error(gray(error.stack))
  }
}

/**
 * Wrap an async operation with error handling.
 * Similar to Rust's .context() for adding context to errors.
 *
 * @example
 * const issue = await withContext(
 *   () => getIssue(id),
 *   "Failed to fetch issue"
 * );
 */
export async function withContext<T>(
  fn: () => Promise<T>,
  context: string,
): Promise<T> {
  try {
    return await fn()
  } catch (error) {
    if (error instanceof CliError) {
      // Re-throw with context added
      throw new CliError(`${context}: ${error.userMessage}`, {
        suggestion: error.suggestion,
        cause: error.cause ?? error,
      })
    }
    if (isClientError(error)) {
      const message = extractGraphQLMessage(error)
      throw new CliError(`${context}: ${message}`, { cause: error })
    }
    if (error instanceof Error) {
      throw new CliError(`${context}: ${error.message}`, { cause: error })
    }
    throw new CliError(`${context}: ${String(error)}`, { cause: error })
  }
}

/**
 * Create a standardized "not found" error handler for GraphQL queries.
 *
 * @example
 * const issue = await client.request(query, { id })
 *   .catch(handleNotFound("Issue", issueIdentifier));
 */
export function handleNotFound(
  entityType: string,
  identifier: string,
): (error: unknown) => never {
  return (error: unknown) => {
    if (isClientError(error) && isNotFoundError(error)) {
      throw new NotFoundError(entityType, identifier)
    }
    throw error
  }
}

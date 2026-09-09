/**
 * Bulk operation utilities for Linear CLI
 *
 * Provides common infrastructure for --bulk, --bulk-file, and --bulk-stdin flags
 * across initiative archive/delete, issue delete and document delete.
 */

import { shouldShowSpinner } from "./hyperlink.ts"
import { errorResult, NotFoundError, WriteError } from "./errors.ts"
import type { WriteEffect } from "./write-result.ts"

/**
 * Result of a single bulk operation
 */
export interface BulkOperationResult {
  id: string
  name?: string
  success: boolean
  effect: WriteEffect
  error?: string
  data?: unknown
  receipts?: unknown
}

/**
 * Summary of bulk operation execution
 */
export interface BulkOperationSummary {
  total: number
  succeeded: number
  failed: number
  effect: WriteEffect
  unattempted: string[]
  results: BulkOperationResult[]
}

/**
 * Options for executing bulk operations
 */
export interface BulkExecutionOptions {
  /** Show progress during execution */
  showProgress?: boolean
  /** Enable colored output */
  colorEnabled?: boolean
}

/**
 * Read IDs from stdin (piped input)
 * Supports one ID per line or space-separated IDs
 */
export async function readIdsFromStdin(): Promise<string[]> {
  const decoder = new TextDecoder()
  const chunks: Uint8Array[] = []

  for await (const chunk of Deno.stdin.readable) {
    chunks.push(chunk)
  }

  // Concatenate all chunks into a single Uint8Array
  const totalLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0)
  const combined = new Uint8Array(totalLength)
  let offset = 0
  for (const chunk of chunks) {
    combined.set(chunk, offset)
    offset += chunk.length
  }

  const input = decoder.decode(combined)
  return parseIds(input)
}

/**
 * Read IDs from a file
 * Supports one ID per line or space-separated IDs
 */
export async function readIdsFromFile(filePath: string): Promise<string[]> {
  try {
    const content = await Deno.readTextFile(filePath)
    return parseIds(content)
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      throw new NotFoundError("File", filePath)
    }
    throw error
  }
}

/**
 * Parse IDs from text input
 * Supports newline-separated, space-separated, or comma-separated IDs
 */
function parseIds(input: string): string[] {
  return input
    .split(/[\n\r,\s]+/)
    .map((id) => id.trim())
    .filter((id) => id.length > 0)
}

/**
 * Collect IDs from various sources (CLI args, file, stdin)
 */
export async function collectBulkIds(options: {
  /** IDs provided via --bulk flag */
  bulk?: string[]
  /** File path provided via --bulk-file flag */
  bulkFile?: string
  /** Whether --bulk-stdin flag was used */
  bulkStdin?: boolean
}): Promise<string[]> {
  const allIds: string[] = []

  // Collect from --bulk flag
  if (options.bulk && options.bulk.length > 0) {
    allIds.push(...options.bulk)
  }

  // Collect from --bulk-file
  if (options.bulkFile) {
    const fileIds = await readIdsFromFile(options.bulkFile)
    allIds.push(...fileIds)
  }

  // Collect from stdin
  if (options.bulkStdin) {
    const stdinIds = await readIdsFromStdin()
    allIds.push(...stdinIds)
  }

  // Deduplicate
  return [...new Set(allIds)]
}

/**
 * Execute bulk operations with progress reporting
 *
 * @param ids - Array of IDs to process
 * @param operation - Function that executes the operation for a single ID
 * @param options - Execution options
 * @returns Summary of all operations
 */
export async function executeBulkOperations<T extends BulkOperationResult>(
  ids: string[],
  operation: (id: string) => Promise<T>,
  options: BulkExecutionOptions = {},
): Promise<BulkOperationSummary> {
  const {
    showProgress = true,
    colorEnabled = true,
  } = options

  const results: BulkOperationResult[] = []
  let completed = 0
  const total = ids.length

  const spinnerEnabled = shouldShowSpinner()

  // Progress display helper
  const updateProgress = () => {
    if (showProgress && spinnerEnabled) {
      const percent = Math.round((completed / total) * 100)
      const succeeded = results.filter((r) => r.success).length
      const failed = completed - succeeded
      const status = colorEnabled
        ? `\r⏳ Processing: ${completed}/${total} (${percent}%) - ✓ ${succeeded} ✗ ${failed}`
        : `\rProcessing: ${completed}/${total} (${percent}%) - OK: ${succeeded} Failed: ${failed}`
      Deno.stderr.writeSync(new TextEncoder().encode(status))
    }
  }

  // Start one write at a time so an unknown outcome stops later writes.
  for (const id of ids) {
    let result: BulkOperationResult
    try {
      result = await operation(id)
    } catch (error) {
      const failure = errorResult(error)
      result = {
        id,
        success: false,
        effect: failure.effect,
        error: failure.error.message,
        ...(error instanceof WriteError
          ? { data: error.data, receipts: error.receipts }
          : {}),
      }
    }
    results.push(result)
    completed++
    updateProgress()
    if (result.effect === "unknown") break
  }

  // Clear progress line
  if (showProgress && spinnerEnabled) {
    Deno.stderr.writeSync(
      new TextEncoder().encode("\r" + " ".repeat(80) + "\r"),
    )
  }

  const succeeded = results.filter((r) => r.success).length

  return {
    total,
    succeeded,
    failed: results.length - succeeded,
    effect: results.some((result) => result.effect === "unknown")
      ? "unknown"
      : results.some((result) => result.effect === "applied")
      ? "applied"
      : "none",
    unattempted: ids.slice(results.length),
    results,
  }
}

/**
 * Print bulk operation summary
 */
export function printBulkSummary(
  summary: BulkOperationSummary,
  options: {
    entityName: string
    operationName: string
    colorEnabled?: boolean
    showDetails?: boolean
  },
): void {
  const { entityName, operationName, colorEnabled = true, showDetails = true } =
    options

  console.log("")

  if (summary.failed === 0) {
    const msg =
      `✓ Successfully ${operationName} ${summary.succeeded} ${entityName}${
        summary.succeeded !== 1 ? "s" : ""
      }`
    console.log(colorEnabled ? msg : msg.replace("✓", "OK:"))
  } else if (summary.succeeded === 0 && summary.unattempted.length === 0) {
    const msg = `✗ Failed to ${
      operationName.replace(/ed$/, "")
    } all ${summary.total} ${entityName}${summary.total !== 1 ? "s" : ""}`
    console.log(colorEnabled ? msg : msg.replace("✗", "FAILED:"))
  } else {
    console.log(
      `Completed: ${summary.succeeded}/${summary.total} ${entityName}${
        summary.total !== 1 ? "s" : ""
      } ${operationName}`,
    )
    console.log(`  ✓ Succeeded: ${summary.succeeded}`)
    console.log(`  ✗ Failed: ${summary.failed}`)
  }

  if (summary.unattempted.length > 0) {
    console.log(
      `  Not attempted after unknown outcome: ${summary.unattempted.length}`,
    )
  }

  // Show details for failures
  if (showDetails && summary.failed > 0) {
    console.log("\nFailed operations:")
    for (const result of summary.results) {
      if (!result.success) {
        const name = result.name ? ` (${result.name})` : ""
        console.log(
          `  - ${result.id}${name}: ${result.error || "Unknown error"}`,
        )
      }
    }
  }
}

/**
 * Check if bulk mode is requested based on options
 */
export function isBulkMode(options: {
  bulk?: string[]
  bulkFile?: string
  bulkStdin?: boolean
}): boolean {
  return Boolean(
    (options.bulk && options.bulk.length > 0) ||
      options.bulkFile ||
      options.bulkStdin,
  )
}

import { findIssueIdentifierInText } from "./issue-identifier.ts"

/**
 * Utilities for jj (Jujutsu) version control system
 */

/**
 * Formats an issue description for jj describe
 * Returns the issue title and Linear-issue trailer
 */
export function formatIssueDescription(
  issueId: string,
  title: string,
  url: string,
  magicWord = "Fixes",
): string {
  return `${issueId} ${title}\n\nLinear-issue: ${magicWord} ${issueId}\nLinear-issue-url: ${url}`
}

/**
 * Parses a Linear issue identifier from a Linear-issue trailer value
 * Supports two formats:
 * - New format: "Fixes ABC-123" (with magic words)
 * - Old format: [ABC-123](https://linear.app/...)
 * Returns the issue identifier (e.g., "ABC-123") or null if not found
 */
export function parseLinearIssueFromTrailer(
  trailerValue: string,
): string | null {
  return findIssueIdentifierInText(trailerValue)?.identifier ?? null
}

/**
 * Parses the output from jj log trailers command
 * Returns the last valid issue ID from the first commit with Linear-issue trailer(s)
 * If multiple trailers exist in a commit, returns the last one
 */
export function parseJjTrailersOutput(output: string): string | null {
  // Collect all valid issue IDs from the first commit with Linear-issue trailer(s)
  // If multiple trailers exist in a commit, use the last one
  const lines = output.split("\n")
  let lastValidIssueId: string | null = null

  for (const line of lines) {
    const trimmed = line.trim()
    if (trimmed) {
      const issueId = parseLinearIssueFromTrailer(trimmed)
      if (issueId) {
        lastValidIssueId = issueId
      }
    } else if (lastValidIssueId) {
      // Empty line indicates end of current commit's trailers
      // Return the last valid issue ID found in this commit
      return lastValidIssueId
    }
  }

  // Return the last valid issue ID found (handles case where output doesn't end with blank line)
  return lastValidIssueId
}

/**
 * Gets the current Linear issue ID from jj commit trailers
 * Searches the current change and ancestors for the most recent Linear-issue trailer
 * If multiple Linear-issue trailers exist in a commit, returns the last one
 * Returns the issue identifier (e.g., "ABC-123") or null if not found
 */
export async function getJjLinearIssue(): Promise<string | null> {
  // Use jj log with trailers template to extract Linear-issue trailer value
  // Search all ancestors starting from current change
  const process = await new Deno.Command("jj", {
    args: [
      "log",
      "-r",
      "::@",
      "-T",
      'trailers.map(|t| if(t.key() == "Linear-issue", t.value(), ""))',
      "--no-graph",
    ],
  }).output()

  if (!process.success) {
    return null
  }

  const output = new TextDecoder().decode(process.stdout)
  return parseJjTrailersOutput(output)
}

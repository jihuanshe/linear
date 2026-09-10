import { getOption } from "../config.ts"
import { getCurrentBranch } from "./git.ts"
import { findIssueIdentifierInText } from "./issue-identifier.ts"
import { getJjLinearIssue } from "./jj.ts"

export type VcsType = "git" | "jj"

export function getVcs(): VcsType {
  return getOption("vcs") || "git"
}

/**
 * Returns an appropriate error message when no issue identifier is found
 */
export function getNoIssueFoundMessage(): string {
  const vcs = getVcs()
  switch (vcs) {
    case "git":
      return "The current branch does not contain a valid Linear issue identifier."
    case "jj":
      return "No Linear-issue trailer found in current or ancestor commits."
    default:
      throw vcs satisfies never
  }
}

/**
 * Gets the current issue identifier from VCS state
 * For git: extracts from branch name
 * For jj: extracts from Linear-issue trailer in commit history
 * Returns the issue identifier (e.g., "ABC-123") or null if not found
 */
export async function getCurrentIssueFromVcs(): Promise<string | null> {
  const vcs = getVcs()

  switch (vcs) {
    case "git": {
      const branch = await getCurrentBranch()
      if (!branch) return null

      const issueIdentifier = findIssueIdentifierInText(branch)?.identifier
      return issueIdentifier ?? null
    }
    case "jj": {
      return await getJjLinearIssue()
    }
    default:
      throw vcs satisfies never
  }
}

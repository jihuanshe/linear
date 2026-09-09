import { open } from "@opensrc/deno-open"
import { getIssueIdentifier, getTeamKey } from "./linear.ts"
import { getOption } from "../config.ts"
import { encodeBase64 } from "@std/encoding/base64"
import { getNoIssueFoundMessage } from "./vcs.ts"
import { LINEAR_WEB_BASE_URL } from "../const.ts"

export async function openIssuePage(
  providedId?: string,
  options: { app?: boolean; web?: boolean } = {},
) {
  const issueId = await getIssueIdentifier(providedId)
  if (!issueId) {
    console.error(getNoIssueFoundMessage())
    Deno.exit(1)
  }

  const workspace = getOption("workspace")
  if (!workspace) {
    console.error(
      "workspace is not set via command line, configuration file, or environment.",
    )
    Deno.exit(1)
  }

  const url = `${LINEAR_WEB_BASE_URL}/${workspace}/issue/${issueId}`
  const destination = options.app ? "Linear.app" : "web browser"
  console.log(`Opening ${url} in ${destination}`)
  await open(url, options.app ? { app: { name: "Linear" } } : undefined)
}

export async function openProjectPage(
  projectId: string,
  options: { app?: boolean; web?: boolean } = {},
) {
  const workspace = getOption("workspace")
  if (!workspace) {
    console.error(
      "workspace is not set via command line, configuration file, or environment.",
    )
    Deno.exit(1)
  }

  const url = `${LINEAR_WEB_BASE_URL}/${workspace}/project/${projectId}`
  const destination = options.app ? "Linear.app" : "web browser"
  console.log(`Opening ${url} in ${destination}`)
  await open(url, options.app ? { app: { name: "Linear" } } : undefined)
}

export async function openTeamAssigneeView(options: { app?: boolean } = {}) {
  const teamKey = getTeamKey()
  if (!teamKey) {
    console.error(
      "Could not determine team key from configuration or directory name.",
    )
    Deno.exit(1)
  }

  const workspace = getOption("workspace")
  if (!workspace) {
    console.error(
      "workspace is not set via command line, configuration file, or environment.",
    )
    Deno.exit(1)
  }

  const filterObj = {
    "and": [{ "assignee": { "or": [{ "isMe": { "eq": true } }] } }],
  }
  const filter = encodeBase64(JSON.stringify(filterObj)).replace(/=/g, "")
  const url =
    `${LINEAR_WEB_BASE_URL}/${workspace}/team/${teamKey}/active?filter=${filter}`
  await open(url, options.app ? { app: { name: "Linear" } } : undefined)
}

import { open } from "@opensrc/deno-open"
import { getIssueIdentifier, getTeamKey } from "./linear.ts"
import { encodeBase64 } from "@std/encoding/base64"
import { getNoIssueFoundMessage } from "./vcs.ts"
import { LINEAR_WEB_BASE_URL } from "../const.ts"
import { gql } from "../__codegen__/gql.ts"
import { getGraphQLClient } from "./graphql.ts"

/** Browser navigation uses the same authenticated principal as API operations. */
export async function getWorkspaceUrl(): Promise<string> {
  const { organization } = await getGraphQLClient().request(gql(`
    query BrowserWorkspace {
      organization { urlKey }
    }
  `))
  return `${LINEAR_WEB_BASE_URL}/${organization.urlKey}`
}

export async function openIssuePage(
  providedId?: string,
  options: { app?: boolean; web?: boolean } = {},
) {
  const issueId = await getIssueIdentifier(providedId)
  if (!issueId) {
    console.error(getNoIssueFoundMessage())
    Deno.exit(1)
  }

  const { issue } = await getGraphQLClient().request(
    gql(`
    query BrowserIssue($id: String!) {
      issue(id: $id) { url }
    }
  `),
    { id: issueId },
  )
  const url = issue.url
  const destination = options.app ? "Linear.app" : "web browser"
  console.log(`Opening ${url} in ${destination}`)
  await open(url, options.app ? { app: { name: "Linear" } } : undefined)
}

export async function openProjectPage(
  projectId: string,
  options: { app?: boolean; web?: boolean } = {},
) {
  const { project } = await getGraphQLClient().request(
    gql(`
    query BrowserProject($id: String!) {
      project(id: $id) { url }
    }
  `),
    { id: projectId },
  )
  const url = project.url
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

  const workspaceUrl = await getWorkspaceUrl()
  const filterObj = {
    "and": [{ "assignee": { "or": [{ "isMe": { "eq": true } }] } }],
  }
  const filter = encodeBase64(JSON.stringify(filterObj)).replace(/=/g, "")
  const url = `${workspaceUrl}/team/${teamKey}/active?filter=${filter}`
  await open(url, options.app ? { app: { name: "Linear" } } : undefined)
}

import { unicodeWidth } from "@std/cli"
import { Command } from "@cliffy/command"
import { rgb24, underline } from "@std/fmt/colors"
import { gql } from "../../__codegen__/gql.ts"
import type { ListDocumentsQueryVariables } from "../../__codegen__/graphql.ts"
import { getGraphQLClient } from "../../utils/graphql.ts"
import { getTimeAgo, padDisplay, truncateText } from "../../utils/display.ts"
import {
  getIssueId,
  getIssueReference,
  resolveProjectId,
} from "../../utils/linear.ts"
import { shouldShowSpinner } from "../../utils/hyperlink.ts"
import {
  completeConnection,
  limitType,
  warnIfTruncated,
} from "../../utils/pagination.ts"
import {
  handleError,
  NotFoundError,
  ValidationError,
} from "../../utils/errors.ts"

const ListDocuments = gql(`
  query ListDocuments($filter: DocumentFilter, $first: Int, $after: String) {
    documents(filter: $filter, first: $first, after: $after) {
      nodes {
        id
        title
        slugId
        url
        updatedAt
        project {
          name
          slugId
        }
        issue {
          identifier
          title
        }
        creator {
          name
        }
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }
`)

export const listCommand = new Command()
  .name("list")
  .description("List documents")
  .alias("l")
  .option(
    "--project <project:string>",
    "Filter by project (UUID, slug ID, exact name, or Linear URL)",
  )
  .option(
    "--issue <issue:string>",
    "Filter by issue (UUID, identifier, number in the configured team, or Linear URL)",
    { preserveEmpty: true },
  )
  .option(
    "--json",
    "Output {nodes, pageInfo}; pageInfo.hasNextPage is true when --limit left more documents",
  )
  .type("limit", limitType)
  .option(
    "--limit <limit:limit>",
    "Maximum number of documents (use 0 for all pages)",
    { default: 50 },
  )
  .action(async ({ project, issue, json, limit }) => {
    const { Spinner } = await import("@std/cli/unstable-spinner")
    const showSpinner = shouldShowSpinner() && !json
    const spinner = showSpinner ? new Spinner() : null
    spinner?.start()

    try {
      // Build filter based on options
      let filter:
        | NonNullable<ListDocumentsQueryVariables["filter"]>
        | undefined = undefined

      if (project) {
        filter = {
          ...(filter ?? {}),
          project: { id: { eq: await resolveProjectId(project) } },
        }
      }

      if (issue != null) {
        const reference = await getIssueReference(issue)
        if (!reference) {
          throw new ValidationError(`Invalid issue reference: ${issue}`)
        }
        const issueId = await getIssueId(reference)
        if (!issueId) {
          throw new NotFoundError("Issue", issue)
        }
        filter = {
          ...(filter ?? {}),
          issue: { id: { eq: issueId } },
        }
      }

      const client = getGraphQLClient()
      const fetchPage = async (
        after?: string,
        first = limit > 0 ? Math.min(100, limit) : 100,
      ) =>
        (await client.request(ListDocuments, { filter, first, after }))
          .documents
      const documentsConnection = await completeConnection(
        await fetchPage(),
        fetchPage,
        "documents",
        limit,
      )
      spinner?.stop()
      const documents = documentsConnection.nodes

      if (json) {
        console.log(JSON.stringify(documentsConnection, null, 2))
        return
      }

      if (documents.length === 0) {
        console.log("No documents found.")
        return
      }

      // Calculate column widths based on actual data
      const { columns } = Deno.stdout.isTerminal()
        ? Deno.consoleSize()
        : { columns: 120 }

      const SLUG_WIDTH = Math.max(
        4, // minimum width for "SLUG" header
        ...documents.map((doc) => doc.slugId.length),
      )

      // Get attachment column (project name or issue identifier)
      const getAttachment = (doc: typeof documents[0]) => {
        if (doc.project?.name) return doc.project.name
        if (doc.issue?.identifier) return doc.issue.identifier
        return "-"
      }

      const ATTACHMENT_WIDTH = Math.max(
        10, // minimum width for "ATTACHMENT" header
        ...documents.map((doc) => unicodeWidth(getAttachment(doc))),
      )

      const UPDATED_WIDTH = Math.max(
        7, // minimum width for "UPDATED" header
        ...documents.map((doc) => getTimeAgo(new Date(doc.updatedAt)).length),
      )

      const SPACE_WIDTH = 3 // spaces between columns
      const fixed = SLUG_WIDTH + ATTACHMENT_WIDTH + UPDATED_WIDTH + SPACE_WIDTH
      const PADDING = 1
      const availableWidth = Math.max(columns - PADDING - fixed, 10)
      const maxTitleWidth = Math.max(
        ...documents.map((doc) => unicodeWidth(doc.title)),
      )
      const titleWidth = Math.min(maxTitleWidth, availableWidth)

      // Print header
      const header = [
        padDisplay("SLUG", SLUG_WIDTH),
        padDisplay("TITLE", titleWidth),
        padDisplay("ATTACHMENT", ATTACHMENT_WIDTH),
        padDisplay("UPDATED", UPDATED_WIDTH),
      ]

      console.log(underline(header.join(" ")))

      // Print each document
      for (const doc of documents) {
        const truncTitle = padDisplay(
          truncateText(doc.title, titleWidth),
          titleWidth,
        )

        const attachment = getAttachment(doc)
        const updated = getTimeAgo(new Date(doc.updatedAt))

        console.log(
          `${padDisplay(doc.slugId, SLUG_WIDTH)} ${truncTitle} ${
            padDisplay(attachment, ATTACHMENT_WIDTH)
          } ${rgb24(padDisplay(updated, UPDATED_WIDTH), 0x808080)}`,
        )
      }
      warnIfTruncated(documentsConnection, "document", "documents")
    } catch (error) {
      spinner?.stop()
      handleError(error, "Failed to list documents")
    }
  })

import { Command } from "@cliffy/command"
import { renderMarkdown } from "../../utils/markdown.ts"
import type { Extension } from "@littletof/charmd"
import { fetchIssueDetailsRaw, getIssueReference } from "../../utils/linear.ts"
import type { FetchedIssueComment } from "../../utils/linear.ts"
import { Spinner } from "@std/cli/unstable-spinner"
import { openIssuePage } from "../../utils/actions.ts"
import {
  formatCycleShort,
  formatRelativeTime,
  getPriorityDisplay,
} from "../../utils/display.ts"
import { pipeToUserPager, shouldUsePager } from "../../utils/pager.ts"
import { bold, underline } from "@std/fmt/colors"
import { getOption } from "../../config.ts"
import {
  hyperlink,
  shouldEnableHyperlinks,
  shouldShowSpinner,
} from "../../utils/hyperlink.ts"
import { createHyperlinkExtension } from "../../utils/charmd-hyperlink-extension.ts"
import { handleError, ValidationError } from "../../utils/errors.ts"
import {
  formatIssueContextMarkdown,
  summarizeIssueContext,
} from "../../utils/issue-context.ts"

export const viewCommand = new Command()
  .name("view")
  .description(
    "View issue details with all comments and attachments, or open in browser/app. Accepts an issue UUID, identifier (e.g. ENG-123), number in the configured team, or Linear URL; omit to use the current Git or Jujutsu context.\n\nOutput starts with a Context section: assignee vs. the current account, parent, sub-issues, relations, attachment and comment counts, the latest comment by another account, and state, assignee or project changes by other accounts from the latest 50 history entries. Read it before cancelling, marking as duplicate or re-assigning; the full change log is issue history.",
  )
  .alias("v")
  .arguments("[issue:string]")
  .option("-w, --web", "Open in web browser")
  .option("-a, --app", "Open in Linear.app")
  .option("--no-comments", "Exclude comments from the output")
  .option(
    "--show-resolved-threads",
    "Include resolved threads in human output; JSON always retains all fetched threads",
  )
  .option("--no-pager", "Disable automatic paging for long output")
  .option(
    "-j, --json",
    "Output {organization, viewer, issue, contextSummary} without a write envelope; the issue is in issue. Includes all fetched threads (even resolved) and issue.history (latest 50); comments and attachments retain {nodes, pageInfo}",
  )
  .action(async (options, issueArg) => {
    const { web, app, comments, showResolvedThreads, pager, json } = options
    const showComments = comments !== false
    const usePager = pager !== false

    if (web || app) {
      await openIssuePage(issueArg, { app, web: !app })
      return
    }

    try {
      const issueReference = await getIssueReference(issueArg)
      if (!issueReference) {
        throw new ValidationError(
          "Could not determine issue reference",
          {
            suggestion:
              "Provide an Issue UUID, identifier such as ENG-123, or Linear Issue URL.",
          },
        )
      }

      const spinner = shouldShowSpinner() && !json ? new Spinner() : null
      spinner?.start()
      let readData: Awaited<ReturnType<typeof fetchIssueDetailsRaw>>
      try {
        readData = await fetchIssueDetailsRaw(
          issueReference,
          showComments,
          true,
        )
      } finally {
        spinner?.stop()
      }
      const contextSummary = summarizeIssueContext(readData)
      if (json) {
        console.log(JSON.stringify({ ...readData, contextSummary }, null, 2))
        return
      }

      const issueData = readData.issue
      const issueComments = "comments" in issueData
        ? issueData.comments.nodes
        : undefined
      const attachments = issueData.attachments?.nodes ?? []
      const documents = issueData.documents?.nodes ?? []
      const children = issueData.children?.nodes ?? []
      const { description } = issueData

      const derivedComments = issueComments
        ? deriveCommentView(issueComments, showResolvedThreads === true)
        : undefined

      const configuredHyperlinkFormat = getOption("hyperlink_format")
      const hyperlinkFormat =
        configuredHyperlinkFormat && shouldEnableHyperlinks()
          ? configuredHyperlinkFormat
          : undefined

      const { title } = issueData
      const { identifier } = issueData

      const metaParts: string[] = []
      if (issueData.state) {
        metaParts.push(`**State:** ${issueData.state.name}`)
      }
      metaParts.push(`**Priority:** ${getPriorityDisplay(issueData.priority)}`)
      const assigneeDisplay = issueData.assignee != null
        ? `@${issueData.assignee.displayName}`
        : "Unassigned"
      metaParts.push(`**Assignee:** ${assigneeDisplay}`)
      if (issueData.project) {
        metaParts.push(`**Project:** ${issueData.project.name}`)
      }
      if (issueData.projectMilestone) {
        metaParts.push(`**Milestone:** ${issueData.projectMilestone.name}`)
      }
      if (issueData.cycle) {
        const cycleShort = formatCycleShort(
          issueData.cycle,
          issueData.team?.activeCycle?.number,
        )
        const cycleLabel = issueData.cycle.name != null
          ? `#${issueData.cycle.number} ${issueData.cycle.name}`
          : `#${issueData.cycle.number}`
        const cycleDisplay = cycleShort.text.startsWith("#")
          ? cycleLabel
          : `${cycleLabel} (${cycleShort.text})`
        metaParts.push(`**Cycle:** ${cycleDisplay}`)
      }
      if (derivedComments) {
        metaParts.push(
          `**Unresolved threads:** ${derivedComments.unresolvedThreadCount}`,
        )
      }
      const metaLine = metaParts.length > 0
        ? "\n\n" + metaParts.join(" | ")
        : ""

      let markdown = `# ${identifier}: ${title}${metaLine}\n\n${
        formatIssueContextMarkdown(contextSummary)
      }${description ? "\n" + description : ""}`

      if (Deno.stdout.isTerminal()) {
        const { columns: terminalWidth } = Deno.consoleSize()
        const extensions = hyperlinkFormat
          ? [createHyperlinkExtension(hyperlinkFormat)]
          : []

        const renderedMarkdown = renderMarkdown(markdown, {
          lineWidth: terminalWidth,
          extensions,
        })

        const outputLines: string[] = []
        outputLines.push(...renderedMarkdown.split("\n"))

        const hierarchyMarkdown = formatIssueHierarchyAsMarkdown(
          issueData.parent,
          children,
        )
        if (hierarchyMarkdown) {
          const renderedHierarchy = renderMarkdown(hierarchyMarkdown, {
            lineWidth: terminalWidth,
            extensions,
          })
          outputLines.push(...renderedHierarchy.split("\n"))
        }

        if (attachments.length > 0) {
          const attachmentsMarkdown = formatAttachmentsAsMarkdown(
            attachments,
          )
          const renderedAttachments = renderMarkdown(attachmentsMarkdown, {
            lineWidth: terminalWidth,
            extensions,
          })
          outputLines.push(...renderedAttachments.split("\n"))
        }

        if (documents.length > 0) {
          const documentsMarkdown = formatDocumentsAsMarkdown(
            documents,
          )
          const renderedDocuments = renderMarkdown(documentsMarkdown, {
            lineWidth: terminalWidth,
            extensions,
          })
          outputLines.push(...renderedDocuments.split("\n"))
        }

        if (
          showComments && derivedComments &&
          derivedComments.visibleRootComments.length > 0
        ) {
          outputLines.push("")
          outputLines.push("## Comments")
          outputLines.push("")
          outputLines.push(
            ...captureCommentsForTerminal(
              derivedComments.visibleRootComments,
              derivedComments.repliesByRootId,
              terminalWidth,
              extensions,
            ),
          )
        }

        if (
          showComments && derivedComments &&
          derivedComments.hiddenResolvedThreadCount > 0
        ) {
          outputLines.push("")
          outputLines.push(
            formatResolvedThreadsSummary(
              derivedComments.hiddenResolvedThreadCount,
            ),
          )
        }

        const finalOutput = outputLines.join("\n")

        if (shouldUsePager(outputLines, usePager)) {
          await pipeToUserPager(finalOutput)
        } else {
          console.log(finalOutput)
        }
      } else {
        markdown += formatIssueHierarchyAsMarkdown(
          issueData.parent,
          children,
        )

        if (attachments.length > 0) {
          markdown += formatAttachmentsAsMarkdown(
            attachments,
          )
        }

        if (documents.length > 0) {
          markdown += formatDocumentsAsMarkdown(documents)
        }

        if (
          showComments && derivedComments &&
          derivedComments.visibleRootComments.length > 0
        ) {
          markdown += "\n\n## Comments\n\n"
          markdown += formatCommentsAsMarkdown(
            derivedComments.visibleRootComments,
            derivedComments.repliesByRootId,
          )
        }

        if (
          showComments && derivedComments &&
          derivedComments.hiddenResolvedThreadCount > 0
        ) {
          markdown += "\n\n" +
            formatResolvedThreadsSummary(
              derivedComments.hiddenResolvedThreadCount,
            )
        }

        console.log(markdown)
      }
    } catch (error) {
      handleError(error, "Failed to view issue")
    }
  })

type IssueDetails = Awaited<ReturnType<typeof fetchIssueDetailsRaw>>["issue"]
type IssueRef = Pick<
  NonNullable<IssueDetails["parent"]>,
  "identifier" | "title" | "state"
>

function formatIssueHierarchyAsMarkdown(
  parent: IssueRef | null | undefined,
  children: IssueRef[] | undefined,
): string {
  let markdown = ""

  if (parent) {
    markdown += `\n\n## Parent\n\n`
    markdown +=
      `- **${parent.identifier}**: ${parent.title} _[${parent.state.name}]_\n`
  }

  if (children && children.length > 0) {
    markdown += `\n\n## Sub-issues\n\n`
    for (const child of children) {
      markdown +=
        `- **${child.identifier}**: ${child.title} _[${child.state.name}]_\n`
    }
  }

  return markdown
}

function deriveCommentView(
  comments: FetchedIssueComment[],
  showResolvedThreads: boolean,
) {
  const rootComments = comments
    .filter((comment) => comment.parent == null)
    .slice()
    .sort((a, b) =>
      new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
    )

  const commentsById = new Map(comments.map((comment) => [comment.id, comment]))
  const rootIdByCommentId = new Map<string, string>()
  const repliesByRootId = new Map<string, FetchedIssueComment[]>()

  function getRootId(commentId: string): string {
    const cached = rootIdByCommentId.get(commentId)
    if (cached != null) {
      return cached
    }

    const ancestors = new Set<string>()
    let currentId = commentId
    while (true) {
      if (ancestors.has(currentId)) {
        throw new ValidationError("Comment thread contains a parent cycle")
      }
      ancestors.add(currentId)
      const current = commentsById.get(currentId)
      if (!current) {
        throw new ValidationError(
          "Comment thread is incomplete: a parent was not returned",
        )
      }
      if (current.parent == null) {
        for (const ancestor of ancestors) {
          rootIdByCommentId.set(ancestor, currentId)
        }
        return currentId
      }
      currentId = current.parent.id
    }
  }

  for (const comment of comments) {
    if (comment.parent == null) {
      continue
    }

    const rootId = getRootId(comment.id)
    const replies = repliesByRootId.get(rootId)
    if (replies) {
      replies.push(comment)
    } else {
      repliesByRootId.set(rootId, [comment])
    }
  }

  for (const replies of repliesByRootId.values()) {
    replies.sort((a, b) =>
      new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
    )
  }

  const visibleRootComments = showResolvedThreads
    ? rootComments
    : rootComments.filter((comment) => comment.resolvedAt == null)

  return {
    visibleRootComments,
    repliesByRootId,
    unresolvedThreadCount:
      rootComments.filter((comment) => comment.resolvedAt == null).length,
    hiddenResolvedThreadCount: rootComments.length - visibleRootComments.length,
  }
}

function formatCommentHeader(
  author: string,
  date: string,
  suffix = "",
  indent = "",
): string {
  const suffixText = suffix ? ` ${suffix}` : ""
  return `${indent}${underline(bold(`@${author}`))} ${
    underline(`commented ${date}`)
  }${suffixText}`
}

function getCommentAuthor(comment: FetchedIssueComment): string {
  return comment.user?.displayName ||
    comment.user?.name ||
    comment.externalUser?.displayName ||
    comment.externalUser?.name ||
    "Unknown"
}

export function formatThreadIdLabel(
  threadId: string,
  url: string,
  enableHyperlinks: boolean,
): string {
  const displayText = `[thread: ${threadId}]`
  return enableHyperlinks ? hyperlink(displayText, url) : displayText
}

function getThreadHeaderSuffix(
  rootComment: FetchedIssueComment,
  enableHyperlinks: boolean,
): string {
  const parts = [
    formatThreadIdLabel(
      rootComment.id,
      rootComment.url,
      enableHyperlinks,
    ),
  ]
  if (rootComment.resolvedAt != null) {
    parts.push("[resolved]")
  }
  return parts.join(" ")
}

function formatCommentsAsMarkdown(
  rootComments: FetchedIssueComment[],
  repliesByRootId: Map<string, FetchedIssueComment[]>,
): string {
  let markdown = ""

  for (const rootComment of rootComments) {
    const replies = repliesByRootId.get(rootComment.id) ?? []
    const rootAuthor = getCommentAuthor(rootComment)
    const rootDate = formatRelativeTime(rootComment.createdAt)
    const suffix = getThreadHeaderSuffix(rootComment, false)

    markdown += `- **@${rootAuthor}** - *${rootDate}* ${suffix}

`
    markdown += `  ${rootComment.body.split("\n").join("\n  ")}

`

    for (const reply of replies) {
      const replyAuthor = getCommentAuthor(reply)
      const replyDate = formatRelativeTime(reply.createdAt)

      markdown += `  - **@${replyAuthor}** - *${replyDate}*

`
      markdown += `    ${reply.body.split("\n").join("\n    ")}

`
    }
  }

  return markdown
}

function captureCommentsForTerminal(
  rootComments: FetchedIssueComment[],
  repliesByRootId: Map<string, FetchedIssueComment[]>,
  width: number,
  extensions: Extension[] = [],
): string[] {
  const outputLines: string[] = []
  const enableHyperlinks = shouldEnableHyperlinks()

  for (const [index, rootComment] of rootComments.entries()) {
    const replies = repliesByRootId.get(rootComment.id) ?? []
    const rootAuthor = getCommentAuthor(rootComment)
    const rootDate = formatRelativeTime(rootComment.createdAt)
    const suffix = getThreadHeaderSuffix(rootComment, enableHyperlinks)

    outputLines.push(formatCommentHeader(rootAuthor, rootDate, suffix))
    const renderedRootBody = renderMarkdown(rootComment.body, {
      lineWidth: width,
      extensions,
    })
    outputLines.push(...renderedRootBody.split("\n"))

    if (replies.length > 0) {
      outputLines.push("")
    }

    for (const reply of replies) {
      const replyAuthor = getCommentAuthor(reply)
      const replyDate = formatRelativeTime(reply.createdAt)

      outputLines.push(formatCommentHeader(replyAuthor, replyDate, "", "  "))
      const renderedReplyBody = renderMarkdown(reply.body, {
        lineWidth: width - 2,
        extensions,
      })
      outputLines.push(
        ...renderedReplyBody.split("\n").map((line) => "  " + line),
      )
    }

    if (index < rootComments.length - 1) {
      outputLines.push("")
    }
  }

  return outputLines
}

function formatResolvedThreadsSummary(hiddenCount: number): string {
  const noun = hiddenCount == 1 ? "thread" : "threads"
  return "Resolved " + noun + " hidden: " + hiddenCount +
    ". Use --show-resolved-threads to show them."
}

// Type for attachments and documents
type AttachmentInfo = IssueDetails["attachments"]["nodes"][number]
type DocumentInfo = IssueDetails["documents"]["nodes"][number]

/**
 * Format attachments as markdown for display
 */
function formatAttachmentsAsMarkdown(
  attachments: AttachmentInfo[],
): string {
  if (attachments.length === 0) {
    return ""
  }

  let markdown = "\n\n## Attachments\n\n"

  for (const attachment of attachments) {
    const sourceLabel = attachment.sourceType
      ? ` _[${attachment.sourceType}]_`
      : ""

    markdown += `- **${attachment.title}**: ${attachment.url}${sourceLabel}\n`

    if (attachment.subtitle) {
      markdown += `  _${attachment.subtitle}_\n`
    }
  }

  return markdown
}

function formatDocumentsAsMarkdown(documents: DocumentInfo[]): string {
  if (documents.length === 0) {
    return ""
  }

  let markdown = "\n\n## Documents\n\n"

  for (const document of documents) {
    markdown += `- **${document.title}**: ${document.url}\n`
  }

  return markdown
}

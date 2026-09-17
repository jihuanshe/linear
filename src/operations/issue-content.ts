import { gql } from "../__codegen__/gql.ts"
import { getGraphQLClient } from "../utils/graphql.ts"
import type { UploadResult } from "../utils/upload.ts"
import {
  assertMutationReferences,
  assertMutationSuccess,
  ValidationError,
} from "../utils/errors.ts"

export function formatAsMarkdownLink(
  result: Pick<UploadResult, "filename" | "assetUrl" | "contentType">,
): string {
  // Entities keep line breaks in filenames inside the generated link label.
  const label = result.filename.replace(/[\\`*_[\]<>!&\r\n]/g, (character) => {
    if (character === "\r") return "&#13;"
    if (character === "\n") return "&#10;"
    return `\\${character}`
  })
  const url = result.assetUrl.replace(
    /[\s()<>\\]/g,
    (character) =>
      encodeURIComponent(character).replace(/\(/g, "%28").replace(/\)/g, "%29"),
  ).replaceAll("&", "&amp;")
  return `${
    result.contentType.startsWith("image/") ? "!" : ""
  }[${label}](${url})`
}

/** Validate supplied prose before uploading; append generated snippets without rewriting it. */
export function composeCommentBody(
  body: string | undefined,
  files: readonly Pick<
    UploadResult,
    "filename" | "assetUrl" | "contentType"
  >[] = [],
): string {
  if (body != null && !body.trim()) {
    throw new ValidationError("Comment body cannot be empty")
  }
  return [
    ...(body == null ? [] : [body]),
    ...files.map(formatAsMarkdownLink),
  ].join("\n\n")
}

/** These functions own one remote object each; the caller already resolved its Issue UUID. */
export async function createIssueComment(
  issueId: string,
  options: {
    body: string
    parentId?: string
    beforeWrite?: () => Promise<void>
  },
) {
  if (options.body.trim() === "") {
    throw new ValidationError("Comment body cannot be empty")
  }
  const mutation = gql(`
    mutation AddComment($input: CommentCreateInput!) {
      commentCreate(input: $input) {
        success
        comment {
          id body createdAt url user { name displayName }
          issue { id }
          parent { id }
        }
      }
    }
  `)
  await options.beforeWrite?.()
  const data = await getGraphQLClient().request(mutation, {
    input: { issueId, body: options.body, parentId: options.parentId },
  })
  assertMutationSuccess(data?.commentCreate, data)
  const comment = data.commentCreate.comment
  assertMutationReferences(comment, data, {
    issue: issueId,
    ...(options.parentId != null ? { parent: options.parentId } : {}),
  })
  return { comment }
}

export async function linkIssueUrl(
  issueId: string,
  options: { url: string; title?: string; beforeWrite?: () => Promise<void> },
) {
  let url: URL
  try {
    url = new URL(options.url)
  } catch {
    throw new ValidationError("Link must be an HTTP or HTTPS URL")
  }
  if (!["http:", "https:"].includes(url.protocol)) {
    throw new ValidationError("Link must be an HTTP or HTTPS URL")
  }
  const mutation = gql(`
    mutation AttachmentLinkURL($issueId: String!, $url: String!, $title: String) {
      attachmentLinkURL(issueId: $issueId, url: $url, title: $title) {
        success
        attachment { id title url issue { id } }
      }
    }
  `)
  await options.beforeWrite?.()
  const data = await getGraphQLClient().request(mutation, {
    issueId,
    url: options.url,
    title: options.title,
  })
  assertMutationSuccess(data?.attachmentLinkURL, data)
  const attachment = data.attachmentLinkURL.attachment
  assertMutationReferences(attachment, data, { issue: issueId })
  return { attachment }
}

export async function createIssueAttachment(
  issueId: string,
  options: {
    url: string
    title: string
    beforeWrite?: () => Promise<void>
  },
) {
  const mutation = gql(`
    mutation AttachmentCreate($input: AttachmentCreateInput!) {
      attachmentCreate(input: $input) {
        success
        attachment { id url title issue { id } }
      }
    }
  `)
  await options.beforeWrite?.()
  const data = await getGraphQLClient().request(mutation, {
    input: {
      issueId,
      title: options.title,
      url: options.url,
    },
  })
  assertMutationSuccess(data?.attachmentCreate, data)
  const attachment = data.attachmentCreate.attachment
  assertMutationReferences(attachment, data, { issue: issueId })
  return { attachment }
}

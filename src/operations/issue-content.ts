import { gql } from "../__codegen__/gql.ts"
import { getGraphQLClient } from "../utils/graphql.ts"
import {
  assertMutationReceipt,
  assertMutationSuccess,
  ValidationError,
} from "../utils/errors.ts"

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
        comment { id body createdAt url user { name displayName } }
      }
    }
  `)
  await options.beforeWrite?.()
  const data = await getGraphQLClient().request(mutation, {
    input: { issueId, body: options.body, parentId: options.parentId },
  })
  assertMutationSuccess(data?.commentCreate, data)
  const comment = data.commentCreate.comment
  assertMutationReceipt(comment, data)
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
        attachment { id title url }
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
  assertMutationReceipt(attachment, data)
  return { attachment }
}

export async function createIssueAttachment(
  issueId: string,
  options: {
    url: string
    title: string
    commentBody?: string
    beforeWrite?: () => Promise<void>
  },
) {
  const mutation = gql(`
    mutation AttachmentCreate($input: AttachmentCreateInput!) {
      attachmentCreate(input: $input) {
        success
        attachment { id url title }
      }
    }
  `)
  await options.beforeWrite?.()
  const data = await getGraphQLClient().request(mutation, {
    input: {
      issueId,
      title: options.title,
      url: options.url,
      commentBody: options.commentBody,
    },
  })
  assertMutationSuccess(data?.attachmentCreate, data)
  const attachment = data.attachmentCreate.attachment
  assertMutationReceipt(attachment, data)
  return { attachment }
}

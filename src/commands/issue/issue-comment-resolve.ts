import { Command } from "@cliffy/command"
import { gql } from "../../__codegen__/gql.ts"
import { getGraphQLClient } from "../../utils/graphql.ts"
import {
  assertMutationReceipt,
  assertMutationSuccess,
  handleError,
  NotFoundError,
  ValidationError,
  WriteError,
} from "../../utils/errors.ts"
import { printWriteResult } from "../../utils/write-result.ts"
import { withUsageMetadata } from "../usage.ts"

const ThreadComment = gql(`
  query ReadThreadComment($id: String!) {
    organization { id urlKey }
    comment(id: $id) {
      id url parent { id } issue { id identifier }
      resolvedAt resolvingCommentId resolvingUser { id name displayName }
    }
  }
`)
const ResolveComment = gql(`
  mutation ResolveComment($id: String!, $resolvingCommentId: String) {
    commentResolve(id: $id, resolvingCommentId: $resolvingCommentId) {
      success comment { id }
    }
  }
`)
const UnresolveComment = gql(`
  mutation UnresolveComment($id: String!) {
    commentUnresolve(id: $id) { success comment { id } }
  }
`)

/** Follow real parent links; never assume a reply ID is the mutation target. */
async function readRoot(
  client: ReturnType<typeof getGraphQLClient>,
  id: string,
) {
  const seen = new Set<string>()
  let organizationId: string | undefined
  let issueId: string | undefined
  while (true) {
    if (!id.trim() || seen.has(id)) {
      throw new ValidationError("Invalid or cyclic comment parent chain")
    }
    seen.add(id)
    const result = await client.request(ThreadComment, { id })
    const comment = result.comment
    if (!comment) throw new NotFoundError("Comment", id)
    if (
      comment.id !== id || !result.organization?.id || !comment.issue?.id ||
      comment.parent === undefined || comment.resolvedAt === undefined ||
      (organizationId != null && organizationId !== result.organization.id) ||
      (issueId != null && issueId !== comment.issue.id)
    ) {
      throw new ValidationError(
        "Comment thread identity or state is inconsistent",
      )
    }
    organizationId = result.organization.id
    issueId = comment.issue.id
    if (comment.parent == null) return result
    id = comment.parent.id
  }
}

async function changeResolution(
  id: string,
  resolveThread: boolean,
  resolvingCommentId?: string,
) {
  if (!id.trim() || resolvingCommentId?.trim() === "") {
    throw new ValidationError("Comment ID cannot be empty")
  }
  const client = getGraphQLClient()
  const initial = await readRoot(client, id)
  const root = initial.comment!
  if (resolvingCommentId != null) {
    const reply = await readRoot(client, resolvingCommentId)
    if (
      resolvingCommentId === root.id || reply.comment!.id !== root.id ||
      reply.organization.id !== initial.organization.id
    ) {
      throw new ValidationError(
        "Resolving comment must be a reply in this thread",
      )
    }
  }
  if ((root.resolvedAt != null) === resolveThread) {
    if (
      resolvingCommentId != null &&
      root.resolvingCommentId !== resolvingCommentId
    ) {
      throw new ValidationError(
        "Thread is already resolved with a different resolving comment",
        {
          suggestion:
            "Read the current resolution before explicitly unresolving it.",
        },
      )
    }
    return { effect: "none" as const, data: initial }
  }
  const data = resolveThread
    ? await client.request(ResolveComment, { id: root.id, resolvingCommentId })
    : await client.request(UnresolveComment, { id: root.id })
  const payload = "commentResolve" in data
    ? data.commentResolve
    : data.commentUnresolve
  assertMutationSuccess(payload, data)
  assertMutationReceipt(payload.comment, data, root.id)
  try {
    const verified = await readRoot(client, root.id)
    if (
      verified.organization.id !== initial.organization.id ||
      verified.comment!.id !== root.id ||
      verified.comment!.issue!.id !== root.issue!.id ||
      (verified.comment!.resolvedAt != null) !== resolveThread ||
      (verified.comment!.resolvingCommentId !== (resolvingCommentId ?? null))
    ) {
      throw new ValidationError(
        "Read-back does not match the requested thread state",
      )
    }
    return { effect: "applied" as const, data: verified }
  } catch (error) {
    throw new WriteError("Thread mutation succeeded but verification failed", {
      effect: "applied",
      data,
      cause: error,
      suggestion:
        "Read the root comment before continuing; do not repeat the mutation.",
      details: {
        reason: error instanceof Error ? error.message : String(error),
      },
    })
  }
}

export const commentResolveCommand = withUsageMetadata(new Command(), {
  writes: true,
})
  .name("resolve")
  .description(
    "Resolve an Issue comment thread; a reply ID is followed to its root. Reads back the root state; never retries a mutation.",
  )
  .arguments("<commentId:string>")
  .option(
    "--resolving-comment <replyId:string>",
    "Reply in the same thread that records the resolution",
    { preserveEmpty: true },
  )
  .option(
    "--json",
    "Output a JSON write result with the read-back in data.comment",
  )
  .action(async ({ json, resolvingComment }, id) => {
    try {
      const result = await changeResolution(id, true, resolvingComment)
      if (json) printWriteResult(result.data, { effect: result.effect })
      else {console.log(
          `${
            result.effect === "none" ? "Already resolved" : "✓ Resolved"
          } thread ${result.data.comment!.id}`,
        )}
    } catch (error) {
      handleError(error, "Failed to resolve comment")
    }
  })

export const commentUnresolveCommand = withUsageMetadata(new Command(), {
  writes: true,
})
  .name("unresolve")
  .description(
    "Reopen an Issue comment thread; a reply ID is followed to its root. Reads back the root state; never retries a mutation.",
  )
  .arguments("<commentId:string>")
  .option(
    "--json",
    "Output a JSON write result with the read-back in data.comment",
  )
  .action(async ({ json }, id) => {
    try {
      const result = await changeResolution(id, false)
      if (json) printWriteResult(result.data, { effect: result.effect })
      else {console.log(
          `${
            result.effect === "none" ? "Already unresolved" : "✓ Unresolved"
          } thread ${result.data.comment!.id}`,
        )}
    } catch (error) {
      handleError(error, "Failed to unresolve comment")
    }
  })

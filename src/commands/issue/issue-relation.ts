import { Command } from "@cliffy/command"
import { gql } from "../../__codegen__/gql.ts"
import { getGraphQLClient } from "../../utils/graphql.ts"
import {
  extractIssueRelationSnapshot,
  getIssueIdentifier,
  planIssueRelations,
} from "../../utils/linear.ts"
import { readIssueHeader } from "../../utils/issue-read.ts"
import { completeConnection } from "../../utils/pagination.ts"
import {
  assertMutationReceipt,
  assertMutationSuccess,
  CliError,
  handleError,
  NotFoundError,
  ValidationError,
} from "../../utils/errors.ts"
import { printWriteResult, writeResult } from "../../utils/write-result.ts"
import { withUsageMetadata } from "../usage.ts"

const RELATION_TYPES = ["blocks", "blocked-by", "related", "duplicate"] as const
export type RelationType = (typeof RELATION_TYPES)[number]

const ExistingRelations = gql(`
  query GetExistingIssueRelations($issueId: String!) {
    issue(id: $issueId) {
      relations(first: 100) {
        nodes { id type relatedIssue { id identifier title } }
        pageInfo { hasNextPage endCursor }
      }
      inverseRelations(first: 100) {
        nodes { id type issue { id identifier title } }
        pageInfo { hasNextPage endCursor }
      }
    }
  }
`)
const OutgoingRelations = gql(`
  query GetIssueOutgoingRelations($issueId: String!, $first: Int!, $after: String) {
    issue(id: $issueId) {
      relations(first: $first, after: $after) {
        nodes { id type relatedIssue { id identifier title } }
        pageInfo { hasNextPage endCursor }
      }
    }
  }
`)
const IncomingRelations = gql(`
  query GetIssueIncomingRelations($issueId: String!, $first: Int!, $after: String) {
    issue(id: $issueId) {
      inverseRelations(first: $first, after: $after) {
        nodes { id type issue { id identifier title } }
        pageInfo { hasNextPage endCursor }
      }
    }
  }
`)
const CreateRelation = gql(`
  mutation CreateIssueRelation($input: IssueRelationCreateInput!) {
    issueRelationCreate(input: $input) { success issueRelation { id } }
  }
`)
const DeleteRelation = gql(`
  mutation DeleteIssueRelation($id: String!) {
    issueRelationDelete(id: $id) { success }
  }
`)

function parseType(value: string): RelationType {
  const type = value.toLowerCase() as RelationType
  if (!RELATION_TYPES.includes(type)) {
    throw new ValidationError(`Invalid relation type: ${value}`, {
      suggestion: `Must be one of: ${RELATION_TYPES.join(", ")}`,
    })
  }
  return type
}

async function resolveIssue(ref?: string) {
  const identifier = await getIssueIdentifier(ref)
  if (!identifier) {
    throw new ValidationError(
      `Could not resolve issue identifier: ${ref ?? "current issue"}`,
    )
  }
  const issue = await readIssueHeader(identifier)
  if (!issue.id) throw new CliError("Issue lookup returned no stable identity")
  return issue
}

/** Complete both directions; missing or cyclic cursors fail before any write. */
export async function readIssueRelationInventory(issueId: string) {
  const client = getGraphQLClient()
  const data = await client.request(ExistingRelations, { issueId })
  if (!data.issue) throw new NotFoundError("Issue", issueId)
  const relations = await completeConnection(
    data.issue.relations,
    async (after, first) => {
      const page = await client.request(OutgoingRelations, {
        issueId,
        after,
        first,
      })
      if (!page.issue) throw new NotFoundError("Issue", issueId)
      return page.issue.relations
    },
    `outgoing relations for ${issueId}`,
  )
  const inverseRelations = await completeConnection(
    data.issue.inverseRelations,
    async (after, first) => {
      const page = await client.request(IncomingRelations, {
        issueId,
        after,
        first,
      })
      if (!page.issue) throw new NotFoundError("Issue", issueId)
      return page.issue.inverseRelations
    },
    `incoming relations for ${issueId}`,
  )
  return { relations, inverseRelations }
}

async function relationContext(
  issueRef: string,
  type: RelationType,
  relatedRef: string,
) {
  parseType(type)
  const issue = await resolveIssue(issueRef)
  const relatedIssue = await resolveIssue(relatedRef)
  if (issue.id === relatedIssue.id) {
    throw new ValidationError("An issue cannot be related to itself")
  }
  const input = {
    issueId: type === "blocked-by" ? relatedIssue.id : issue.id,
    relatedIssueId: type === "blocked-by" ? issue.id : relatedIssue.id,
    type: type === "blocked-by" ? "blocks" as const : type,
  }
  const inventory = await readIssueRelationInventory(issue.id)
  const edges = [
    ...inventory.relations.nodes.map((r) => ({
      id: r.id,
      type: r.type,
      issueId: issue.id,
      relatedIssueId: r.relatedIssue.id,
    })),
    ...inventory.inverseRelations.nodes.map((r) => ({
      id: r.id,
      type: r.type,
      issueId: r.issue.id,
      relatedIssueId: issue.id,
    })),
  ]
  const relation = edges.find((r) =>
    r.type === input.type && (
      (r.issueId === input.issueId &&
        r.relatedIssueId === input.relatedIssueId) ||
      (input.type === "related" && r.issueId === input.relatedIssueId &&
        r.relatedIssueId === input.issueId)
    )
  )
  return { issue, relatedIssue, type, input, inventory, relation }
}

/** Read-only preparation for plan; apply calls addIssueRelation to read again. */
export async function prepareIssueRelation(
  issueRef: string,
  type: RelationType,
  relatedRef: string,
) {
  const context = await relationContext(issueRef, type, relatedRef)
  const plan = planIssueRelations([{
    type,
    issue: context.relatedIssue.identifier,
    issueId: context.relatedIssue.id,
  }], extractIssueRelationSnapshot(context.inventory))[0]
  if (plan.verdict === "conflict") {
    throw new ValidationError(
      `Cannot add ${context.issue.identifier} ${type} ${context.relatedIssue.identifier}: ${
        plan.detail ?? "an existing relation would be replaced"
      }`,
      {
        suggestion:
          "Delete the existing relation explicitly before adding a different type or direction.",
      },
    )
  }
  if (plan.verdict === "idempotent" && !context.relation?.id) {
    throw new CliError("Existing relation has no stable identity")
  }
  return { ...context, verdict: plan.verdict }
}

/** The command and delivery call this mutation owner; preparation has no effects. */
export async function addIssueRelation(
  issueRef: string,
  type: RelationType,
  relatedRef: string,
  options: { beforeWrite?: () => Promise<void> } = {},
) {
  const prepared = await prepareIssueRelation(issueRef, type, relatedRef)
  const { issue, relatedIssue } = prepared
  if (prepared.verdict === "idempotent") {
    return writeResult({
      issue,
      relatedIssue,
      type,
      relation: prepared.relation!,
    }, { effect: "none" })
  }
  const client = getGraphQLClient()
  await options.beforeWrite?.()
  const data = await client.request(CreateRelation, { input: prepared.input })
  assertMutationSuccess(data.issueRelationCreate, data)
  const relation = data.issueRelationCreate.issueRelation
  assertMutationReceipt(relation, data)
  return writeResult({ issue, relatedIssue, type, relation })
}

const addRelationCommand = withUsageMetadata(new Command(), { writes: true })
  .name("add")
  .description("Add a relation without replacing an existing type or direction")
  .arguments("<issueId:string> <relationType:string> <relatedIssueId:string>")
  .option("--json", "Output the confirmed relation or no-op as JSON")
  .example(
    "Mark issue as blocked by another",
    "linear issue relation add ENG-123 blocked-by ENG-100",
  )
  .example(
    "Mark issue as blocking another",
    "linear issue relation add ENG-123 blocks ENG-456",
  )
  .example(
    "Mark issues as related",
    "linear issue relation add ENG-123 related ENG-456",
  )
  .example(
    "Mark ENG-123 as a duplicate of ENG-100",
    "linear issue relation add ENG-123 duplicate ENG-100",
  )
  .action(async ({ json }, issue, type, relatedIssue) => {
    try {
      const result = await addIssueRelation(
        issue,
        parseType(type),
        relatedIssue,
      )
      if (json) printWriteResult(result.data, { effect: result.effect })
      else {console.log(`✓ ${
          result.effect === "none"
            ? "Relation already exists"
            : "Created relation"
        }: ${result.data.issue.identifier} ${result.data.type} ${result.data.relatedIssue.identifier}`)}
    } catch (error) {
      handleError(error, "Failed to create relation")
    }
  })

const deleteRelationCommand = withUsageMetadata(new Command(), { writes: true })
  .name("delete")
  .description("Delete the specified relation between two issues")
  .arguments("<issueId:string> <relationType:string> <relatedIssueId:string>")
  .option("--json", "Output the confirmed deletion as JSON")
  .action(async ({ json }, issueRef, typeArg, relatedRef) => {
    try {
      const { issue, relatedIssue, type, relation } = await relationContext(
        issueRef,
        parseType(typeArg),
        relatedRef,
      )
      if (!relation?.id) {
        throw new NotFoundError(
          "Relation",
          `${type} between ${issue.identifier} and ${relatedIssue.identifier}`,
        )
      }
      const data = await getGraphQLClient().request(DeleteRelation, {
        id: relation.id,
      })
      assertMutationSuccess(data.issueRelationDelete, data)
      if (json) {
        printWriteResult({
          issue,
          relatedIssue,
          type,
          relation,
          ...data.issueRelationDelete,
        })
      } else {console.log(
          `✓ Deleted relation: ${issue.identifier} ${type} ${relatedIssue.identifier}`,
        )}
    } catch (error) {
      handleError(error, "Failed to delete relation")
    }
  })

const listRelationsCommand = new Command()
  .name("list")
  .description("List all outgoing and incoming relations for an issue")
  .arguments("[issueId:string]")
  .option(
    "--json",
    "Output the issue and complete relation connections as JSON",
  )
  .action(async ({ json }, issueRef) => {
    try {
      const issue = await resolveIssue(issueRef)
      const inventory = await readIssueRelationInventory(issue.id)
      if (json) {
        console.log(
          JSON.stringify({ issue: { ...issue, ...inventory } }, null, 2),
        )
        return
      }
      console.log(`Relations for ${issue.identifier}: ${issue.title}`)
      console.log()
      const outgoing = inventory.relations.nodes,
        incoming = inventory.inverseRelations.nodes
      if (!outgoing.length && !incoming.length) {
        console.log("  No relations")
        return
      }
      if (outgoing.length) {
        console.log("Outgoing:")
        for (const rel of outgoing) {
          console.log(
            `  ${issue.identifier} ${rel.type} ${rel.relatedIssue.identifier}: ${rel.relatedIssue.title}`,
          )
        }
      }
      if (incoming.length) {
        if (outgoing.length) console.log()
        console.log("Incoming:")
        for (const rel of incoming) {
          console.log(
            `  ${issue.identifier} ${
              rel.type === "blocks" ? "blocked-by" : rel.type
            } ${rel.issue.identifier}: ${rel.issue.title}`,
          )
        }
      }
    } catch (error) {
      handleError(error, "Failed to list relations")
    }
  })

export const relationCommand = new Command()
  .name("relation")
  .description("Manage issue relations")
  .action(function () {
    this.showHelp()
  })
  .command("add", addRelationCommand)
  .command("delete", deleteRelationCommand)
  .command("list", listRelationsCommand)

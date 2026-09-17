import { requireProjectTeam } from "../../utils/project-teams.ts"
import { Command } from "@cliffy/command"
import { withUsageMetadata } from "../usage.ts"
import { withMarkdownHint } from "../../utils/markdown-help.ts"
import { gql } from "../../__codegen__/gql.ts"
import type { IssueUpdateInput } from "../../__codegen__/graphql.ts"
import { getGraphQLClient } from "../../utils/graphql.ts"
import { readTextSource } from "../../utils/text-source.ts"
import {
  getCycleIdByNameOrNumber,
  getIssueId,
  getIssueIdentifier,
  getProjectIdByName,
  getWorkflowStates,
  isLinearUuid,
  lookupUserId,
  resolveIssueLabelIdsForTeam,
  resolveMilestoneId,
  resolveWorkflowState,
  workflowStateNotFoundError,
} from "../../utils/linear.ts"
import {
  errorResult,
  handleError,
  NotFoundError,
  ValidationError,
  WriteError,
} from "../../utils/errors.ts"

import { readIssueBasis, resolveWriteTeam } from "../../utils/issue-read.ts"
import {
  connectionField,
  loadBasisFile,
  prepareReplacement,
  type ReadBasis,
  referenceField,
  scalarField,
  validateReplacementOptions,
} from "../../utils/replacement.ts"
import { writeResult } from "../../utils/write-result.ts"
import {
  differentIssueFields,
  type ReadBackOptions,
  withReadBackRetries,
} from "../../utils/issue-verification.ts"
import {
  assertMutationReceipt,
  assertMutationSuccess,
} from "../../utils/errors.ts"

export interface UpdateIssueOptions {
  assignee?: string
  unassign?: boolean
  dueDate?: string
  parent?: string
  priority?: number
  estimate?: number
  description?: string
  descriptionFile?: string
  label?: string[]
  addLabel?: string[]
  removeLabel?: string[]
  team?: string
  project?: string
  state?: string
  milestone?: string
  cycle?: string
  clearCycle?: boolean
  title?: string
  baseFile?: string
  original?: ReadBasis
  unprotected?: boolean
  expectField?: string[]
  beforeWrite?: () => Promise<void>
}

export function validateIssueWriteOptions(options: UpdateIssueOptions) {
  if (
    options.priority !== undefined &&
    (!Number.isInteger(options.priority) || options.priority < 0 ||
      options.priority > 4)
  ) {
    throw new ValidationError("Priority must be an integer from 0 to 4")
  }
  for (
    const field of [
      "assignee",
      "dueDate",
      "parent",
      "team",
      "project",
      "state",
      "milestone",
      "cycle",
      "title",
    ] as const
  ) {
    if (options[field] != null && !options[field].trim()) {
      throw new ValidationError(
        field === "assignee"
          ? "User reference cannot be empty"
          : `${field} cannot be empty`,
      )
    }
  }
  for (const field of ["label", "addLabel", "removeLabel"] as const) {
    if (options[field]?.some((value) => !value.trim())) {
      throw new ValidationError(`${field} cannot contain an empty reference`)
    }
  }
}

export const issueReplacementFields = {
  title: scalarField("title"),
  description: scalarField("description"),
  priority: scalarField("priority"),
  estimate: scalarField("estimate"),
  dueDate: scalarField("dueDate"),
  stateId: referenceField("state"),
  assigneeId: referenceField("assignee"),
  labelIds: connectionField("labels"),
  teamId: referenceField("team"),
  projectId: referenceField("project"),
  parentId: referenceField("parent"),
  projectMilestoneId: referenceField("projectMilestone"),
  cycleId: referenceField("cycle"),
}
/** Shared by the direct command and delivery; returns values, never exits or prints. */
export async function prepareIssueUpdate(
  options: UpdateIssueOptions,
  issueIdArg?: string,
) {
  if (issueIdArg == null || !issueIdArg.trim()) {
    throw new ValidationError(
      "An explicit issue reference is required (UUID, identifier, or Linear Issue URL)",
    )
  }
  validateIssueWriteOptions(options)
  const {
    assignee,
    unassign,
    clearCycle,
    dueDate,
    parent,
    priority,
    estimate,
    description,
    descriptionFile,
    label: labelReferences,
    addLabel: addedLabelReferences,
    removeLabel: removedLabelReferences,
    team,
    project,
    state,
    milestone,
    cycle,
    title,
  } = options
  if (options.original != null && options.baseFile != null) {
    throw new ValidationError("Provide one original read")
  }
  const original = options.original ??
    (options.baseFile == null
      ? undefined
      : await loadBasisFile(options.baseFile))
  const hasReplacement = [
    assignee,
    dueDate,
    parent,
    priority,
    estimate,
    description,
    descriptionFile,
    team,
    project,
    state,
    milestone,
    cycle,
    title,
    labelReferences,
  ].some((value) => value !== undefined) || unassign === true ||
    clearCycle === true
  if (
    hasReplacement || original != null || (options.expectField?.length ?? 0) > 0
  ) {
    validateReplacementOptions({
      original,
      unprotected: options.unprotected,
      expectFields: options.expectField,
    })
  }
  const replacesLabels = (labelReferences?.length ?? 0) > 0
  const addsLabels = (addedLabelReferences?.length ?? 0) > 0
  const removesLabels = (removedLabelReferences?.length ?? 0) > 0

  if (replacesLabels && (addsLabels || removesLabels)) {
    throw new ValidationError(
      "Cannot combine --label with --add-label or --remove-label",
      {
        suggestion:
          "Use --label to replace all labels, or use --add-label and --remove-label for incremental changes.",
      },
    )
  }

  if (unassign && assignee != null) {
    throw new ValidationError(
      "Cannot specify both --assignee and --unassign",
      {
        suggestion:
          "Use --assignee <user> to set an assignee, or --unassign on its own to clear it.",
      },
    )
  }

  if (clearCycle && cycle != null) {
    throw new ValidationError(
      "Cannot specify both --cycle and --clear-cycle",
      {
        suggestion:
          "Use --cycle <cycle> to set a cycle, or --clear-cycle on its own to remove it.",
      },
    )
  }

  if (
    assignee == null && !unassign && dueDate == null && parent == null &&
    priority == null && estimate == null && description == null &&
    descriptionFile == null && !replacesLabels && !addsLabels &&
    !removesLabels && team == null && project == null && state == null &&
    milestone == null && cycle == null && !clearCycle && title == null
  ) {
    throw new ValidationError(
      "At least one update option must be provided",
      {
        suggestion:
          "Use a field option such as --title, --state, --add-label, or --remove-label.",
      },
    )
  }

  const finalDescription = await readTextSource(
    "description",
    description,
    descriptionFile,
  )

  const issueReference = await getIssueIdentifier(issueIdArg)
  if (!issueReference) {
    throw new ValidationError(
      `Invalid issue reference: ${issueIdArg}`,
      {
        suggestion:
          "Provide an issue identifier such as ENG-123, a UUID, or a Linear Issue URL.",
      },
    )
  }

  const target = await readIssueBasis(issueReference)
  const writeTeam = team == null
    ? target.issue.team
    : await resolveWriteTeam(team)
  const teamKey = writeTeam.key
  const teamId = writeTeam.id
  let stateId: string | undefined
  if (state != null) {
    const states = await getWorkflowStates(teamId)
    const workflowState = isLinearUuid(state)
      ? states.find((entry) => entry.id.toLowerCase() === state.toLowerCase())
      : resolveWorkflowState(states, state)
    if (!workflowState) {
      throw workflowStateNotFoundError(teamKey, state, states)
    }
    stateId = workflowState.id
  }

  let assigneeId: string | undefined
  if (assignee !== undefined) {
    assigneeId = await lookupUserId(assignee)
    if (!assigneeId) {
      throw new NotFoundError("User", assignee)
    }
  }

  const [labelIds, addedLabelIds, removedLabelIds] =
    await resolveIssueLabelIdsForTeam(
      [labelReferences, addedLabelReferences, removedLabelReferences],
      teamId,
    )
  const removedLabelIdSet = new Set(removedLabelIds)
  if (addedLabelIds.some((labelId) => removedLabelIdSet.has(labelId))) {
    throw new ValidationError(
      "Cannot add and remove the same label in one update",
      {
        suggestion:
          "Remove the duplicate label from either --add-label or --remove-label.",
      },
    )
  }

  let projectId: string | undefined = undefined
  if (project !== undefined) {
    projectId = await getProjectIdByName(project)
    if (projectId === undefined) {
      throw new NotFoundError("Project", project, {
        suggestion:
          "Pass a project UUID, slug ID (from `linear project list`), or exact project name.",
      })
    }
  }

  const targetProjectId = projectId ??
    (team != null ? target.issue.project?.id : undefined)
  if (targetProjectId != null) {
    await requireProjectTeam(
      targetProjectId,
      writeTeam.id,
      teamKey,
    )
  }

  let projectMilestoneId: string | undefined
  let milestoneProjectId: string | undefined
  if (milestone != null) {
    if (isLinearUuid(milestone)) {
      projectMilestoneId = milestone
    } else {
      milestoneProjectId = projectId ??
        target.issue.project?.id
      if (milestoneProjectId == null) {
        throw new ValidationError(
          "--milestone requires --project to be set (issue has no existing project)",
          {
            suggestion:
              "Use --project to specify the project for the milestone, or pass a milestone UUID directly.",
          },
        )
      }
      projectMilestoneId = await resolveMilestoneId(
        milestone,
        milestoneProjectId,
      )
    }
  }

  let cycleId: string | undefined
  if (cycle != null) {
    if (!teamId) {
      throw new NotFoundError("Team", teamKey)
    }
    cycleId = await getCycleIdByNameOrNumber(cycle, teamId)
  }

  // Build the update input object, only including fields that were provided.
  // Clearing a field requires an explicit flag (see --unassign); never set
  // a field to null implicitly.
  const input: IssueUpdateInput = {}

  if (title !== undefined) input.title = title
  if (unassign) {
    input.assigneeId = null
  } else if (assigneeId != null) {
    input.assigneeId = assigneeId
  }
  if (dueDate !== undefined) input.dueDate = dueDate
  if (parent !== undefined) {
    const parentReference = await getIssueIdentifier(parent)
    if (!parentReference) {
      throw new ValidationError(
        `Could not resolve parent issue identifier: ${parent}`,
      )
    }
    const parentId = await getIssueId(parentReference)
    if (!parentId) {
      throw new NotFoundError("Parent issue", parentReference)
    }
    input.parentId = parentId
  }
  if (priority !== undefined) input.priority = priority
  if (estimate !== undefined) input.estimate = estimate
  if (finalDescription !== undefined) input.description = finalDescription
  if (labelIds.length > 0) input.labelIds = labelIds
  if (addedLabelIds.length > 0) input.addedLabelIds = addedLabelIds
  if (removedLabelIds.length > 0) input.removedLabelIds = removedLabelIds
  if (team != null) input.teamId = teamId
  if (projectId !== undefined) input.projectId = projectId
  if (projectMilestoneId !== undefined) {
    input.projectMilestoneId = projectMilestoneId
  }
  if (clearCycle) {
    input.cycleId = null
  } else if (cycleId !== undefined) {
    input.cycleId = cycleId
  }
  if (stateId !== undefined) input.stateId = stateId

  const { addedLabelIds: add, removedLabelIds: remove, ...replacement } = input
  const current = await readIssueBasis(target.issue.id)
  // Name resolution used this team. A concurrent move must not change its scope.
  if (team == null && current.issue.team.id !== target.issue.team.id) {
    throw new ValidationError("Issue team changed while resolving the update")
  }
  if (
    team != null && project == null &&
    current.issue.project?.id !== target.issue.project?.id
  ) {
    throw new ValidationError(
      "Issue project changed while checking team compatibility",
    )
  }
  // A milestone name uses the explicit project or the initial read's project.
  if (
    project == null && milestoneProjectId != null &&
    current.issue.project?.id !== milestoneProjectId
  ) {
    throw new ValidationError(
      "Issue project changed while resolving the milestone",
    )
  }
  if (remove != null) {
    const currentLabelIds = new Set(
      current.issue.labels.nodes.map(({ id }) => id),
    )
    const missing = remove.filter((id) => !currentLabelIds.has(id))
    if (missing.length > 0) {
      throw new ValidationError(
        `Cannot remove labels that are not on ${current.issue.identifier}: ${
          missing.join(", ")
        }`,
        {
          suggestion:
            "Read the issue's current labels before changing --remove-label.",
        },
      )
    }
  }
  const planned = prepareReplacement({
    objectKey: "issue",
    targetId: target.issue.id,
    original,
    current,
    desired: replacement,
    fields: issueReplacementFields,
    unprotected: options.unprotected || (!hasReplacement && original == null),
    expectFields: options.expectField,
  })
  const payload: IssueUpdateInput = {
    ...planned.input,
    ...(add == null ? {} : { addedLabelIds: add }),
    ...(remove == null ? {} : { removedLabelIds: remove }),
  }
  const fields = [...planned.fields]
  for (const inputField of ["addedLabelIds", "removedLabelIds"] as const) {
    const desired = payload[inputField]
    if (desired != null) {
      fields.push({
        field: "labels",
        inputField,
        desired: issueReplacementFields.labelIds.normalize(desired),
        remote: issueReplacementFields.labelIds.read(current.issue),
        verdict: "write",
      })
    }
  }
  return { input: payload, current, fields }
}

const updateIssueMutation = gql(`
  mutation UpdateIssue($id: String!, $input: IssueUpdateInput!) {
    issueUpdate(id: $id, input: $input) {
      success
      issue {
        id
        identifier
        url
        title
        priority
        labels(first: 100) {
          nodes {
            id
            name
          }
          pageInfo {
            hasNextPage
            endCursor
          }
        }
      }
    }
  }
`)

export async function updateIssue(
  options: UpdateIssueOptions,
  issueIdArg?: string,
) {
  const prepared = await prepareIssueUpdate(options, issueIdArg)
  return await executeIssueUpdate(prepared, options.beforeWrite)
}

// Delivery records this receipt before performing its own final verification.
async function executeIssueUpdate(
  { input, current, fields }: Awaited<ReturnType<typeof prepareIssueUpdate>>,
  beforeWrite?: () => Promise<void>,
) {
  if (Object.keys(input).length === 0) {
    return writeResult({ success: true, issue: current.issue }, {
      effect: "none",
      fields,
    })
  }
  await beforeWrite?.()
  const data = await getGraphQLClient().request(updateIssueMutation, {
    id: current.issue.id,
    input,
  })
  assertMutationSuccess(data?.issueUpdate, data)
  const issue = data.issueUpdate.issue
  assertMutationReceipt(issue, data, current.issue.id)
  return writeResult({ ...data.issueUpdate, issue }, { fields })
}

export async function updateIssueAndVerify(
  options: UpdateIssueOptions,
  issueIdArg?: string,
  verificationOptions: ReadBackOptions = {},
) {
  const prepared = await prepareIssueUpdate(options, issueIdArg)
  const result = await executeIssueUpdate(prepared, options.beforeWrite)
  if (result.effect === "none") return result
  const expected = Object.fromEntries(
    prepared.fields.map((field) => [field.inputField, field.desired]),
  )
  const observed = await withReadBackRetries(async (signal) => {
    const scope = "issue-fields" as const
    try {
      signal.throwIfAborted()
      const readBack = await readIssueBasis(prepared.current.issue.id, signal)
      if (readBack.organization.id !== prepared.current.organization.id) {
        throw new ValidationError("Read-back returned a different workspace")
      }
      const different = differentIssueFields(
        readBack.issue,
        expected,
        issueReplacementFields,
      )
      return {
        verification: {
          scope,
          status: different.length ? "different" as const : "verified" as const,
          ...(different.length ? { fields: different } : {}),
        },
        readBack,
      }
    } catch (error) {
      return {
        verification: {
          scope,
          status: "unavailable" as const,
          detail: signal.aborted
            ? "Read-back timed out"
            : errorResult(error).error.message,
        },
      }
    }
  }, verificationOptions)
  if (observed.verification.status !== "verified") {
    throw new WriteError(
      "Issue mutation succeeded but read-back did not verify",
      {
        effect: "applied",
        data: result.data,
        details: { ...observed, fields: prepared.fields },
        suggestion:
          "Read the issue before continuing; do not repeat the mutation.",
      },
    )
  }
  return { ...result, ...observed }
}

export const updateCommand = withUsageMetadata(new Command(), { writes: true })
  .name("update")
  .description(withMarkdownHint(
    "Update an issue; verify fields with up to 3 reads without repeating the write",
  ))
  .arguments("<issueId:string>")
  .option(
    "-a, --assignee <assignee:string>",
    "Assignee (user UUID, username, name, email, 'self', or '@me')",
    { preserveEmpty: true },
  )
  .option(
    "--unassign",
    "Clear the issue's assignee (cannot be combined with --assignee)",
  )
  .option(
    "--due-date <dueDate:string>",
    "Due date of the issue",
    { preserveEmpty: true },
  )
  .option(
    "--parent <parent:string>",
    "Parent issue (UUID, identifier, or Linear Issue URL)",
    { preserveEmpty: true },
  )
  .option(
    "-p, --priority <priority:number>",
    "Priority (0 = no priority, 1 = urgent, 2 = high, 3 = medium, 4 = low)",
    { preserveEmpty: true },
  )
  .option(
    "--estimate <estimate:number>",
    "Points estimate of the issue",
    { preserveEmpty: true },
  )
  .option(
    "-d, --description <description:string>",
    "Description of the issue (empty string clears it)",
    { preserveEmpty: true },
  )
  .option(
    "--description-file <path:string>",
    "Read description from a file (preferred for markdown content)",
    { preserveEmpty: true },
  )
  .option(
    "-l, --label <label:string>",
    "Replace all issue labels. May be repeated.",
    { collect: true, preserveEmpty: true },
  )
  .option(
    "--add-label <label:string>",
    "Add an issue label without replacing existing labels. May be repeated.",
    { collect: true, preserveEmpty: true },
  )
  .option(
    "--remove-label <label:string>",
    "Remove an issue label without replacing other labels. May be repeated.",
    { collect: true, preserveEmpty: true },
  )
  .option(
    "--team <team:string>",
    "Move the issue to this team (UUID or key)",
    { preserveEmpty: true },
  )
  .option(
    "--project <project:string>",
    "Project to assign the issue to (UUID, slug ID, or name)",
    { preserveEmpty: true },
  )
  .option(
    "-s, --state <state:string>",
    "Workflow state for the issue (UUID, name, or type)",
    { preserveEmpty: true },
  )
  .option(
    "--milestone <milestone:string>",
    "Project milestone (UUID, or name when --project is set or the issue already has a project)",
    { preserveEmpty: true },
  )
  .option(
    "--cycle <cycle:string>",
    "Cycle name, number, 'active'/'now', 'next', 'previous', or a relative offset like +1 (use --cycle=-1 for negatives). Use --clear-cycle to remove the issue from its cycle",
    { preserveEmpty: true },
  )
  .option(
    "--clear-cycle",
    "Remove the issue from its cycle",
  )
  .option("-t, --title <title:string>", "Title of the issue", {
    preserveEmpty: true,
  })
  .option(
    "--base-file <path:string>",
    "Saved view --json output from before editing; compare original values before writing",
    { preserveEmpty: true },
  )
  .option(
    "--unprotected",
    "Skip original-value comparison; domain checks still apply",
  )
  .option(
    "--expect-field <field:string>",
    "Require this API field to match the saved original value (repeatable)",
    { collect: true, preserveEmpty: true },
  )
  .option(
    "-j, --json",
    "Output a JSON write result with the mutation receipt, verification, and readBack",
  )
  .action(async (options, issueIdArg) => {
    try {
      const result = await updateIssueAndVerify(options, issueIdArg)
      if (options.json) console.log(JSON.stringify(result, null, 2))
      else {
        const issue = result.data.issue
        console.log(
          (result.effect === "none" ? "Unchanged" : "✓ Updated") + " issue " +
            issue.identifier + ": " + issue.title,
        )
        console.log(issue.url)
      }
    } catch (error) {
      handleError(error, "Failed to update issue")
    }
  })

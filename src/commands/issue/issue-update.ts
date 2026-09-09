import { requireProjectTeam } from "../../utils/project-teams.ts"
import { Command } from "@cliffy/command"
import { withUsageMetadata } from "../usage.ts"
import { withMarkdownHint } from "../../utils/markdown-help.ts"
import { gql } from "../../__codegen__/gql.ts"
import type { IssueUpdateInput } from "../../__codegen__/graphql.ts"
import { getGraphQLClient } from "../../utils/graphql.ts"
import {
  getCycleIdByNameOrNumber,
  getIssueId,
  getIssueIdentifier,
  getIssueLabelIdByNameForTeam,
  getIssueProjectId,
  getProjectIdByName,
  getWorkflowStates,
  isLinearUuid,
  lookupUserId,
  resolveMilestoneId,
  resolveWorkflowState,
  workflowStateNotFoundError,
} from "../../utils/linear.ts"
import {
  handleError,
  NotFoundError,
  ValidationError,
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
    label: labels,
    addLabel: addedLabels,
    removeLabel: removedLabels,
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
    labels,
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
  const replacesLabels = labels != null && labels.length > 0
  const addsLabels = addedLabels != null && addedLabels.length > 0
  const removesLabels = removedLabels != null && removedLabels.length > 0

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

  // Validate that description and descriptionFile are not both provided
  if (description != null && descriptionFile != null) {
    throw new ValidationError(
      "Cannot specify both --description and --description-file",
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

  // Read description from file if provided
  let finalDescription = description
  if (descriptionFile === "") {
    throw new ValidationError("Description file path cannot be empty")
  }
  if (descriptionFile != null) {
    try {
      finalDescription = await Deno.readTextFile(descriptionFile)
    } catch (error) {
      throw new ValidationError(
        `Failed to read description file: ${descriptionFile}`,
        {
          suggestion: `Error: ${
            error instanceof Error ? error.message : String(error)
          }`,
        },
      )
    }
  }

  // Resolve the Issue reference from the argument or current VCS context.
  const issueId = await getIssueIdentifier(issueIdArg)
  if (!issueId) {
    throw new ValidationError(
      "Could not determine issue identifier",
      {
        suggestion:
          "Provide an issue identifier such as ENG-123, a UUID, or a VCS context containing an issue identifier.",
      },
    )
  }

  const target = await readIssueBasis(issueId)
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

  const resolveLabelIds = async (
    labelNames: string[] | undefined,
  ): Promise<string[]> => {
    const ids = new Set<string>()
    for (const label of labelNames ?? []) {
      const labelId = await getIssueLabelIdByNameForTeam(label, teamId)
      if (!labelId) {
        throw new NotFoundError("Issue label", label)
      }
      ids.add(labelId)
    }
    return [...ids]
  }

  const labelIds = await resolveLabelIds(labels)
  const addedLabelIds = await resolveLabelIds(addedLabels)
  const removedLabelIds = await resolveLabelIds(removedLabels)
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
    (team != null ? await getIssueProjectId(target.issue.id) : undefined)
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
        await getIssueProjectId(target.issue.id)
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
    const parentIdentifier = await getIssueIdentifier(parent)
    if (!parentIdentifier) {
      throw new ValidationError(
        `Could not resolve parent issue identifier: ${parent}`,
      )
    }
    const parentId = await getIssueId(parentIdentifier)
    if (!parentId) {
      throw new NotFoundError("Parent issue", parentIdentifier)
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
  // A milestone name uses the project observed by its own lookup.
  if (
    project == null && milestoneProjectId != null &&
    current.issue.project?.id !== milestoneProjectId
  ) {
    throw new ValidationError(
      "Issue project changed while resolving the milestone",
    )
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
  const { input, current, fields } = await prepareIssueUpdate(
    options,
    issueIdArg,
  )
  if (Object.keys(input).length === 0) {
    return writeResult({ success: true, issue: current.issue }, {
      effect: "none",
      fields,
    })
  }
  await options.beforeWrite?.()
  const data = await getGraphQLClient().request(updateIssueMutation, {
    id: current.issue.id,
    input,
  })
  assertMutationSuccess(data?.issueUpdate, data)
  const issue = data.issueUpdate.issue
  assertMutationReceipt(issue, data, current.issue.id)
  return writeResult({ ...data.issueUpdate, issue }, { fields })
}

export const updateCommand = withUsageMetadata(new Command(), { writes: true })
  .name("update")
  .description(withMarkdownHint("Update a linear issue"))
  .arguments("[issueId:string]")
  .option(
    "-a, --assignee <assignee:string>",
    "Assignee (user UUID, username, name, email, 'self', or '@me')",
  )
  .option(
    "--unassign",
    "Clear the issue's assignee (cannot be combined with --assignee)",
  )
  .option(
    "--due-date <dueDate:string>",
    "Due date of the issue",
  )
  .option(
    "--parent <parent:string>",
    "Parent issue (if any) as a team_number code",
  )
  .option(
    "-p, --priority <priority:number>",
    "Priority of the issue (1-4, descending priority)",
  )
  .option(
    "--estimate <estimate:number>",
    "Points estimate of the issue",
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
    { collect: true },
  )
  .option(
    "--add-label <label:string>",
    "Add an issue label without replacing existing labels. May be repeated.",
    { collect: true },
  )
  .option(
    "--remove-label <label:string>",
    "Remove an issue label without replacing other labels. May be repeated.",
    { collect: true },
  )
  .option(
    "--team <team:string>",
    "Move the issue to this team (UUID or key)",
  )
  .option(
    "--project <project:string>",
    "Project to assign the issue to (UUID, slug ID, or name)",
  )
  .option(
    "-s, --state <state:string>",
    "Workflow state for the issue (by name or type)",
  )
  .option(
    "--milestone <milestone:string>",
    "Project milestone (UUID, or name when --project is set or the issue already has a project)",
  )
  .option(
    "--cycle <cycle:string>",
    "Cycle name, number, 'active'/'now', 'next', 'previous', or a relative offset like +1 (use --cycle=-1 for negatives). Use --clear-cycle to remove the issue from its cycle",
  )
  .option(
    "--clear-cycle",
    "Remove the issue from its cycle",
  )
  .option("-t, --title <title:string>", "Title of the issue")
  .option(
    "--base-file <path:string>",
    "Original JSON read saved before deciding this replacement",
  )
  .option(
    "--unprotected",
    "Explicitly replace without comparing original values; domain checks still apply",
  )
  .option(
    "--expect-field <field:string>",
    "Require another API field to remain equal to the original read (repeatable)",
    { collect: true },
  )
  .option(
    "-j, --json",
    "Output a JSON write result; the resulting issue is in data.issue",
  )
  .action(async (options, issueIdArg) => {
    try {
      const result = await updateIssue(options, issueIdArg)
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

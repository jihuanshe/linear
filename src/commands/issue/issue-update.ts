import { Command } from "@cliffy/command"
import { gql } from "../../__codegen__/gql.ts"
import type { IssueUpdateInput } from "../../__codegen__/graphql.ts"
import { getGraphQLClient } from "../../utils/graphql.ts"
import { getTeamKeyFromIssueIdentifier } from "../../utils/issue-identifier.ts"
import {
  getCycleIdByNameOrNumber,
  getIssueId,
  getIssueIdentifier,
  getIssueLabelIdByNameForTeam,
  getIssueProjectId,
  getProjectIdByName,
  getTeamIdByKey,
  getWorkflowStates,
  isLinearUuid,
  lookupUserId,
  resolveMilestoneId,
  resolveWorkflowState,
  workflowStateNotFoundError,
} from "../../utils/linear.ts"
import {
  CliError,
  handleError,
  NotFoundError,
  ValidationError,
} from "../../utils/errors.ts"

export const updateCommand = new Command()
  .name("update")
  .description("Update a linear issue")
  .arguments("[issueId:string]")
  .option(
    "-a, --assignee <assignee:string>",
    "Assign the issue to 'self' or someone (by username or name)",
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
    "Description of the issue",
  )
  .option(
    "--description-file <path:string>",
    "Read description from a file (preferred for markdown content)",
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
    "Team associated with the issue (if not your default team)",
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
  .option("-j, --json", "Output the update result as JSON")
  .action(
    async (
      {
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
        json,
      },
      issueIdArg,
    ) => {
      try {
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
        if (description && descriptionFile) {
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
        if (descriptionFile) {
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

        // Get the issue ID - either from argument or infer from current context
        const issueId = await getIssueIdentifier(issueIdArg)
        if (!issueId) {
          throw new ValidationError(
            "Could not determine issue ID",
            {
              suggestion:
                "Please provide an issue ID like 'ENG-123' or run from a branch with an issue ID.",
            },
          )
        }

        const { Spinner } = await import("@std/cli/unstable-spinner")
        const { shouldShowSpinner } = await import("../../utils/hyperlink.ts")
        const spinner = shouldShowSpinner() && !json ? new Spinner() : null
        spinner?.start()

        // Extract team from issue ID if not provided
        let teamKey = team
        if (!teamKey) {
          teamKey = getTeamKeyFromIssueIdentifier(issueId)
        }
        if (!teamKey) {
          throw new ValidationError(
            "Could not determine team key from issue ID",
          )
        }

        // Resolve a team ID only when the mutation moves teams or cycle lookup
        // requires it. Team-scoped state and label lookups use the key directly.
        let teamId: string | undefined
        if (team != null || cycle != null) {
          teamId = await getTeamIdByKey(teamKey)
          if (!teamId) {
            throw new NotFoundError("Team", teamKey)
          }
        }

        let stateId: string | undefined
        if (state != null) {
          const states = await getWorkflowStates(teamKey)
          const workflowState = resolveWorkflowState(states, state)
          if (!workflowState) {
            spinner?.stop()
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
            const labelId = await getIssueLabelIdByNameForTeam(label, teamKey)
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

        let projectMilestoneId: string | undefined
        if (milestone != null) {
          if (isLinearUuid(milestone)) {
            projectMilestoneId = milestone
          } else {
            const milestoneProjectId = projectId ??
              await getIssueProjectId(issueId)
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

        spinner?.stop()
        if (!json) {
          console.log(`Updating issue ${issueId}`)
          console.log()
        }
        spinner?.start()

        const updateIssueMutation = gql(`
          mutation UpdateIssue($id: String!, $input: IssueUpdateInput!) {
            issueUpdate(id: $id, input: $input) {
              success
              issue { id, identifier, url, title }
            }
          }
        `)

        const client = getGraphQLClient()
        const data = await client.request(updateIssueMutation, {
          id: issueId,
          input,
        })

        if (!data.issueUpdate.success) {
          throw new CliError("Issue update failed")
        }

        const issue = data.issueUpdate.issue
        if (!issue) {
          throw new CliError("Issue update failed - no issue returned")
        }

        spinner?.stop()
        if (json) {
          console.log(JSON.stringify(data.issueUpdate, null, 2))
        } else {
          console.log(`✓ Updated issue ${issue.identifier}: ${issue.title}`)
          console.log(issue.url)
        }
      } catch (error) {
        handleError(error, "Failed to update issue")
      }
    },
  )

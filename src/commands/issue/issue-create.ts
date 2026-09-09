import type { IssueCreateInput } from "../../__codegen__/graphql.ts"
import {
  issueReplacementFields,
  type UpdateIssueOptions,
} from "./issue-update.ts"
import type { FieldReader } from "../../utils/replacement.ts"
import { resolveWriteTeam } from "../../utils/issue-read.ts"
import { writeResult } from "../../utils/write-result.ts"
import {
  assertMutationReceipt,
  assertMutationSuccess,
} from "../../utils/errors.ts"
import { requireProjectTeam } from "../../utils/project-teams.ts"
import { Command } from "@cliffy/command"
import { withUsageMetadata } from "../usage.ts"
import { withMarkdownHint } from "../../utils/markdown-help.ts"
import { Checkbox, Input, Select } from "../../utils/prompt.ts"
import { gql } from "../../__codegen__/gql.ts"
import { getOption } from "../../config.ts"
import { getGraphQLClient } from "../../utils/graphql.ts"
import { getEditor, openEditor } from "../../utils/editor.ts"
import { getPriorityDisplay } from "../../utils/display.ts"
import {
  fetchParentIssueData,
  getAllTeams,
  getCycleIdByNameOrNumber,
  getIssueId,
  getIssueIdentifier,
  getIssueLabelIdByNameForTeam,
  getIssueLabelOptionsByNameForTeam,
  getLabelsForTeam,
  getProjectIdByName,
  getProjectOptionsByName,
  getProjectsForTeam,
  getTeamIdByKey,
  getTeamKey,
  getWorkflowStates,
  isLinearUuid,
  lookupUserId,
  resolveMilestoneId,
  resolveWorkflowState,
  selectOption,
  type WorkflowState,
  workflowStateNotFoundError,
} from "../../utils/linear.ts"
import {
  handleError,
  NotFoundError,
  ValidationError,
} from "../../utils/errors.ts"

type IssueLabel = { id: string; name: string; color: string }
type ProjectOption = { id: string; name: string }
type IssueCreatePreloadedData = {
  states?: WorkflowState[]
  labels?: IssueLabel[]
  projects?: ProjectOption[]
}

type AdditionalField = {
  key: string
  label: string
  handler: (
    teamKey: string,
    teamId: string,
    preloaded?: IssueCreatePreloadedData,
  ) => Promise<string | number | string[] | undefined>
}

function getIssueCreateAssignSelfMode(): "always" | "auto" | "never" {
  return getOption("issue_create_assign_self") ?? "auto"
}

function shouldAskProjectDuringInteractiveCreate(): boolean {
  return getOption("issue_create_ask_project") === true
}

async function getLinearAutoAssignToSelf(): Promise<boolean> {
  const client = getGraphQLClient()
  const userSettingsQuery = gql(`
    query GetUserSettings {
      userSettings {
        autoAssignToSelf
      }
    }
  `)
  const result = await client.request(userSettingsQuery)
  return result.userSettings.autoAssignToSelf
}

async function shouldAssignSelfByDefaultForInteractiveCreate(): Promise<
  boolean
> {
  const mode = getIssueCreateAssignSelfMode()
  if (mode === "always") {
    return true
  }
  if (mode === "never") {
    return false
  }
  return await getLinearAutoAssignToSelf()
}

function shouldAssignSelfByDefaultForFlagCreate(): boolean {
  return getIssueCreateAssignSelfMode() === "always"
}

async function promptProjectSelection(
  teamKey: string,
  preloadedProjects?: ProjectOption[],
): Promise<string | undefined> {
  const projects = preloadedProjects ?? await getProjectsForTeam(teamKey)
  if (projects.length === 0) {
    return undefined
  }

  const noProjectValue = "__none__"
  const selectedProjectId = await Select.prompt({
    message: "Which project should this issue belong to?",
    search: true,
    searchLabel: "Search projects",
    options: [
      { name: "No project", value: noProjectValue },
      ...projects.map((project) => ({
        name: project.name,
        value: project.id,
      })),
    ],
    default: noProjectValue,
  })

  if (selectedProjectId === noProjectValue) {
    return undefined
  }

  return selectedProjectId
}

async function resolveProjectIdForCreate(
  project: string,
  interactive: boolean,
): Promise<string> {
  let projectId = await getProjectIdByName(project)
  if (projectId == null && interactive) {
    const projectIds = await getProjectOptionsByName(project)
    projectId = await selectOption("Project", project, projectIds)
  }
  if (projectId == null) {
    throw new NotFoundError("Project", project)
  }
  return projectId
}

async function resolveParentIssueForCreate(
  parentIdentifier?: string,
): Promise<{
  parentId?: string
  parentData: {
    title: string
    identifier: string
    projectId: string | null
  } | null
}> {
  let parentId: string | undefined
  let parentData: {
    title: string
    identifier: string
    projectId: string | null
  } | null = null

  if (parentIdentifier) {
    const parentIdentifierResolved = await getIssueIdentifier(parentIdentifier)
    if (!parentIdentifierResolved) {
      throw new ValidationError(
        `Could not resolve parent issue identifier: ${parentIdentifier}`,
      )
    }

    parentId = await getIssueId(parentIdentifierResolved)
    if (!parentId) {
      throw new NotFoundError("Parent issue", parentIdentifierResolved)
    }

    parentData = await fetchParentIssueData(parentId)
  }

  return { parentId, parentData }
}

const ADDITIONAL_FIELDS: AdditionalField[] = [
  {
    key: "workflow_state",
    label: "Workflow state",
    handler: async (
      _teamKey: string,
      teamId: string,
      preloaded?: IssueCreatePreloadedData,
    ) => {
      const states = preloaded?.states ?? await getWorkflowStates(teamId)
      if (states.length === 0) return undefined

      const defaultState = states.find((s) => s.type === "unstarted") ||
        states[0]
      return await Select.prompt({
        message: "Which workflow state should this issue be in?",
        options: states.map((state) => ({
          name: `${state.name} (${state.type})`,
          value: state.id,
        })),
        default: defaultState.id,
      })
    },
  },
  {
    key: "assignee",
    label: "Assignee",
    handler: async () => {
      const assignToSelf = await Select.prompt({
        message: "Assign this issue to yourself?",
        options: [
          { name: "No", value: false },
          { name: "Yes", value: true },
        ],
        default: false,
      })
      return assignToSelf ? await lookupUserId("self") : undefined
    },
  },
  {
    key: "priority",
    label: "Priority",
    handler: async () => {
      return await Select.prompt({
        message: "What priority should this issue have?",
        options: [
          { name: `${getPriorityDisplay(0)} No priority`, value: 0 },
          { name: `${getPriorityDisplay(1)} Urgent`, value: 1 },
          { name: `${getPriorityDisplay(2)} High`, value: 2 },
          { name: `${getPriorityDisplay(3)} Medium`, value: 3 },
          { name: `${getPriorityDisplay(4)} Low`, value: 4 },
        ],
        default: 0,
      })
    },
  },
  {
    key: "labels",
    label: "Labels",
    handler: async (
      teamKey: string,
      _teamId: string,
      preloaded?: IssueCreatePreloadedData,
    ) => {
      const labels = preloaded?.labels ?? await getLabelsForTeam(teamKey)
      if (labels.length === 0) return []

      return await Checkbox.prompt({
        message: "Select labels (use space to select, enter to confirm)",
        search: true,
        searchLabel: "Search labels",
        options: labels.map((label) => ({
          name: label.name,
          value: label.id,
        })),
      })
    },
  },
  {
    key: "estimate",
    label: "Estimate",
    handler: async () => {
      const estimate = await Input.prompt({
        message: "Estimate (leave blank for none)",
        default: "",
      })
      const parsed = parseInt(estimate)
      return isNaN(parsed) ? undefined : parsed
    },
  },
  {
    key: "project",
    label: "Project",
    handler: async (
      teamKey: string,
      _teamId: string,
      preloaded?: IssueCreatePreloadedData,
    ) => {
      return await promptProjectSelection(teamKey, preloaded?.projects)
    },
  },
]

async function promptAdditionalFields(
  teamKey: string,
  teamId: string,
  states: WorkflowState[],
  labels: IssueLabel[],
  includeProject: boolean,
  autoAssignToSelf: boolean,
): Promise<{
  assigneeId?: string
  priority?: number
  estimate?: number
  labelIds: string[]
  stateId?: string
  projectId?: string
}> {
  // Build options that display defaults in parentheses for workflow state and assignee
  let defaultStateName: string | null = null
  if (states.length > 0) {
    const defaultState = states.find((s) => s.type === "unstarted") ||
      states[0]
    defaultStateName = defaultState.name
  }
  const additionalFieldOptions = ADDITIONAL_FIELDS.filter((field) =>
    includeProject || field.key !== "project"
  ).map((field) => {
    let name = field.label
    if (field.key === "workflow_state" && defaultStateName) {
      name = `${field.label} (${defaultStateName})`
    } else if (field.key === "assignee") {
      name = `${field.label} (${autoAssignToSelf ? "self" : "unassigned"})`
    }
    return { name, value: field.key }
  })
  const selectedFields = await Checkbox.prompt({
    message: "Select additional fields to configure",
    options: additionalFieldOptions,
  })

  // Initialize default values
  let assigneeId: string | undefined
  let priority: number | undefined
  let estimate: number | undefined
  let labelIds: string[] = []
  let stateId: string | undefined
  let projectId: string | undefined

  // Set assignee default based on configuration
  if (autoAssignToSelf) {
    assigneeId = await lookupUserId("self")
  }

  // Process selected fields
  for (const fieldKey of selectedFields) {
    const field = ADDITIONAL_FIELDS.find((f) => f.key === fieldKey)
    if (field) {
      const projects = includeProject && fieldKey === "project"
        ? await getProjectsForTeam(teamKey)
        : undefined
      const value = await field.handler(teamKey, teamId, {
        states,
        labels,
        projects,
      })

      switch (fieldKey) {
        case "workflow_state":
          stateId = value as string | undefined
          break
        case "assignee":
          assigneeId = value as string | undefined
          break
        case "priority":
          priority = value === 0 ? undefined : (value as number)
          break
        case "labels":
          labelIds = (value as string[]) || []
          break
        case "estimate":
          estimate = value as number | undefined
          break
        case "project":
          projectId = value as string | undefined
          break
      }
    }
  }

  return {
    assigneeId,
    priority,
    estimate,
    labelIds,
    stateId,
    projectId,
  }
}

async function promptInteractiveIssueCreation(
  initialProjectId?: string,
  parentId?: string,
  parentData?: {
    title: string
    identifier: string
    projectId: string | null
  } | null,
): Promise<{
  title: string
  teamId: string
  teamKey: string
  assigneeId?: string
  priority?: number
  estimate?: number
  labelIds: string[]
  description?: string
  stateId?: string
  parentId?: string
  projectId?: string | null
}> {
  const autoAssignToSelfPromise =
    shouldAssignSelfByDefaultForInteractiveCreate()
  const teamResolutionPromise = (async () => {
    const defaultTeamKey = getTeamKey()
    if (defaultTeamKey) {
      const teamId = await getTeamIdByKey(defaultTeamKey)
      if (teamId) {
        return {
          teamId: teamId,
          teamKey: defaultTeamKey,
          needsTeamSelection: false,
        }
      }
    }
    return {
      teamId: null,
      teamKey: null,
      needsTeamSelection: true,
    }
  })()

  // If we have a parent issue, display its title
  if (parentData) {
    const parentTitle = `${parentData.identifier}: ${parentData.title}`
    console.log(`Creating sub-issue for: ${parentTitle}`)
    console.log()
  }

  const title = await Input.prompt({
    message: "What's the title of your issue?",
    minLength: 1,
  })

  // Await team resolution
  const teamResult = await teamResolutionPromise
  const autoAssignToSelf = await autoAssignToSelfPromise
  const askProject = shouldAskProjectDuringInteractiveCreate()
  let teamId: string
  let teamKey: string

  if (teamResult.needsTeamSelection) {
    // Need to prompt for team selection
    const teams = await getAllTeams()

    const selectedTeamId = await Select.prompt({
      message: "Which team should this issue belong to?",
      search: true,
      searchLabel: "Search teams",
      options: teams.map((team) => ({
        name: `${team.name} (${team.key})`,
        value: team.id,
      })),
    })

    const team = teams.find((t) => t.id === selectedTeamId)

    if (!team) {
      throw new NotFoundError("Team", selectedTeamId)
    }

    teamId = team.id
    teamKey = team.key
  } else {
    // Team was resolved in background
    teamId = teamResult.teamId!
    teamKey = teamResult.teamKey!
  }

  // Preload team-scoped data (do not await yet)
  const workflowStatesPromise = getWorkflowStates(teamId)
  const labelsPromise = getLabelsForTeam(teamKey)
  const projectsPromise = (askProject && !parentData && !initialProjectId)
    ? getProjectsForTeam(teamKey)
    : Promise.resolve(undefined)

  // Description prompt
  const editorName = await getEditor()
  const editorDisplayName = editorName ? editorName.split("/").pop() : null
  const promptMessage = editorDisplayName
    ? `Description [(e) to launch ${editorDisplayName}]`
    : "Description"

  const description = await Input.prompt({
    message: promptMessage,
    default: "",
  })

  let finalDescription: string | undefined
  if (description === "e" && editorDisplayName) {
    console.log(`Opening ${editorDisplayName}...`)
    finalDescription = await openEditor()
    if (finalDescription && finalDescription.length > 0) {
      console.log(
        `Description entered (${finalDescription.length} characters)`,
      )
    } else {
      console.log("No description entered")
      finalDescription = undefined
    }
  } else if (description === "e" && !editorDisplayName) {
    console.error(
      "No editor found. Please set EDITOR environment variable or configure git editor with: git config --global core.editor <editor>",
    )
    finalDescription = undefined
  } else if (description.trim().length > 0) {
    finalDescription = description.trim()
  }

  let projectId = initialProjectId
  const projects = await projectsPromise
  if (!parentData && !initialProjectId && askProject) {
    projectId = await promptProjectSelection(teamKey, projects)
  }

  // Now await the preloaded data and resolve default state
  const states = await workflowStatesPromise
  const labels = await labelsPromise
  let defaultState: WorkflowState | undefined
  if (states.length > 0) {
    defaultState = states.find((s) => s.type === "unstarted") || states[0]
  }

  // What's next? prompt
  const nextAction = await Select.prompt({
    message: "What's next?",
    options: [
      { name: "Submit issue", value: "submit" },
      { name: "Add more fields", value: "more_fields" },
    ],
    default: "submit",
  })

  // Initialize default values for additional fields
  let assigneeId: string | undefined
  let priority: number | undefined
  let estimate: number | undefined
  let labelIds: string[] = []
  let stateId: string | undefined

  // Set assignee default based on configuration
  if (autoAssignToSelf) {
    assigneeId = await lookupUserId("self")
  }

  // Set default state (resolved earlier)
  if (defaultState) {
    stateId = defaultState.id
  }

  if (nextAction === "more_fields") {
    const additionalFieldsResult = await promptAdditionalFields(
      teamKey,
      teamId,
      states,
      labels,
      !askProject && !parentData && !initialProjectId,
      autoAssignToSelf,
    )

    // Override defaults with user selections
    assigneeId = additionalFieldsResult.assigneeId
    priority = additionalFieldsResult.priority
    estimate = additionalFieldsResult.estimate
    labelIds = additionalFieldsResult.labelIds
    stateId = additionalFieldsResult.stateId
    projectId = additionalFieldsResult.projectId ?? projectId
  }

  return {
    title,
    teamId,
    teamKey,
    assigneeId,
    priority,
    estimate,
    labelIds,
    description: finalDescription,
    stateId,
    parentId,
    projectId: projectId ?? parentData?.projectId ?? null,
  }
}

export type CreateIssueOptions =
  & Pick<
    UpdateIssueOptions,
    | "assignee"
    | "dueDate"
    | "parent"
    | "priority"
    | "estimate"
    | "description"
    | "descriptionFile"
    | "label"
    | "team"
    | "project"
    | "state"
    | "milestone"
    | "cycle"
    | "title"
    | "beforeWrite"
  >
  & { useDefaultTemplate?: boolean; interactive?: boolean }

export async function prepareIssueCreate(options: CreateIssueOptions) {
  let {
    assignee,
    dueDate,
    useDefaultTemplate,
    parent: parentIdentifier,
    priority,
    estimate,
    description,
    descriptionFile,
    label: labels,
    team,
    project,
    state,
    milestone,
    cycle,
    interactive = false,
    title,
  } = options
  if (!title) {
    throw new ValidationError(
      "Title is required when not using interactive mode",
    )
  }
  if (description != null && descriptionFile != null) {
    throw new ValidationError(
      "Cannot specify both --description and --description-file",
    )
  }
  if (descriptionFile === "") {
    throw new ValidationError("Description file path cannot be empty")
  }
  const finalDescription = descriptionFile == null
    ? description
    : await Deno.readTextFile(descriptionFile)

  team = team ?? getTeamKey()
  if (!team) throw new ValidationError("Could not determine team")
  const teamReference = await resolveWriteTeam(team)
  team = teamReference.key
  const teamId = teamReference.id
  let stateId: string | undefined
  if (state != null) {
    const states = await getWorkflowStates(teamId)
    const workflowState = isLinearUuid(state)
      ? states.find((entry) => entry.id.toLowerCase() === state.toLowerCase())
      : resolveWorkflowState(states, state)
    if (!workflowState) {
      throw workflowStateNotFoundError(team, state, states)
    }
    stateId = workflowState.id
  }

  let assigneeId = undefined
  if (shouldAssignSelfByDefaultForFlagCreate()) {
    assigneeId = await lookupUserId("self")
  }

  if (assignee) {
    assigneeId = await lookupUserId(assignee)
    if (assigneeId == null) {
      throw new NotFoundError("User", assignee)
    }
  }

  const labelIds = []
  if (labels != null && labels.length > 0) {
    // sequential in case of questions
    for (const label of labels) {
      let labelId = await getIssueLabelIdByNameForTeam(label, teamId)
      if (!labelId && interactive) {
        const labelIds = await getIssueLabelOptionsByNameForTeam(
          label,
          team,
        )

        labelId = await selectOption("Issue label", label, labelIds)
      }
      if (!labelId) {
        throw new NotFoundError("Issue label", label)
      }
      labelIds.push(labelId)
    }
  }
  let projectId: string | undefined = undefined
  if (project !== undefined) {
    projectId = await resolveProjectIdForCreate(project, interactive)
  }

  let projectMilestoneId: string | undefined
  if (milestone != null) {
    if (isLinearUuid(milestone)) {
      projectMilestoneId = milestone
    } else {
      if (projectId == null) {
        throw new ValidationError(
          "--milestone requires --project to be set",
          {
            suggestion:
              "Use --project to specify which project the milestone belongs to, or pass a milestone UUID directly.",
          },
        )
      }
      projectMilestoneId = await resolveMilestoneId(
        milestone,
        projectId,
      )
    }
  }

  let cycleId: string | undefined
  if (cycle != null) {
    cycleId = await getCycleIdByNameOrNumber(cycle, teamId)
  }

  // Date validation done at graphql level

  const { parentId, parentData } = await resolveParentIssueForCreate(
    parentIdentifier,
  )

  const targetProjectId = projectId ?? parentData?.projectId
  if (targetProjectId != null) {
    await requireProjectTeam(targetProjectId, teamId, team)
  }

  const input: IssueCreateInput = {
    title,
    assigneeId,
    dueDate,
    parentId,
    priority,
    estimate,
    labelIds,
    teamId: teamId,
    projectId: projectId || parentData?.projectId,
    projectMilestoneId,
    cycleId,
    stateId,
    useDefaultTemplate,
    description: finalDescription,
  }
  return input
}

const createIssueMutation = gql(`
  mutation CreateIssue($input: IssueCreateInput!) {
    issueCreate(input: $input) {
      success
      issue { id identifier url team { key } }
    }
  }
`)

/** The single creation mutation used by interactive, flag and delivery paths. */
async function submitIssue(
  input: IssueCreateInput,
  beforeWrite?: () => Promise<void>,
) {
  await beforeWrite?.()
  const data = await getGraphQLClient().request(createIssueMutation, { input })
  assertMutationSuccess(data?.issueCreate, data)
  const issue = data.issueCreate.issue
  assertMutationReceipt(issue, data)
  return { ...data.issueCreate, issue }
}
export async function createIssue(options: CreateIssueOptions) {
  const input = await prepareIssueCreate(options)
  const fields = Object.entries(input).flatMap(([inputField, value]) => {
    const reader =
      (issueReplacementFields as Record<string, FieldReader>)[inputField]
    return reader == null || value === undefined ? [] : [{
      inputField,
      field: reader.field,
      desired: reader.normalize(value),
      verdict: "write" as const,
    }]
  })
  return writeResult(await submitIssue(input, options.beforeWrite), { fields })
}

export const createCommand = withUsageMetadata(new Command(), {
  writes: true,
  interactive: true,
})
  .name("create")
  .description(withMarkdownHint("Create a linear issue"))
  .option(
    "-a, --assignee <assignee:string>",
    "Assignee (user UUID, username, name, email, 'self', or '@me')",
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
    "Issue label associated with the issue. May be repeated.",
    { collect: true },
  )
  .option(
    "--team <team:string>",
    "Team associated with the issue (if not your default team)",
  )
  .option(
    "--project <project:string>",
    "Project for the issue (UUID, slug ID, or name)",
  )
  .option(
    "-s, --state <state:string>",
    "Workflow state for the issue (by name or type)",
  )
  .option(
    "--milestone <milestone:string>",
    "Project milestone (UUID, or name when --project is set)",
  )
  .option(
    "--cycle <cycle:string>",
    "Cycle name, number, 'active'/'now', 'next', 'previous', or a relative offset like +1 (use --cycle=-1 for negatives)",
  )
  .option(
    "--no-use-default-template",
    "Do not use default template for the issue",
  )
  .option("--no-interactive", "Disable interactive prompts")
  .option("-t, --title <title:string>", "Title of the issue")
  .option(
    "-j, --json",
    "Output {success, issue: {id, identifier, url, team}} as JSON (non-interactive only)",
  )
  .action(
    async (
      {
        assignee,
        dueDate,
        useDefaultTemplate,
        parent: parentIdentifier,
        priority,
        estimate,
        description,
        descriptionFile,
        label: labels,
        team,
        project,
        state,
        milestone,
        cycle,
        interactive,
        title,
        json,
      },
    ) => {
      interactive = interactive && Deno.stdout.isTerminal() && json !== true

      // Validate that description and descriptionFile are not both provided
      if (description != null && descriptionFile != null) {
        throw new ValidationError(
          "Cannot specify both --description and --description-file",
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

      // If no creation flags are provided beyond project/parent, use interactive mode.
      const onlyInteractiveSeedFlagsProvided = !title && !assignee &&
        !dueDate &&
        priority === undefined && estimate === undefined && !finalDescription &&
        (!labels || labels.length === 0) &&
        !team && !state && !milestone && !cycle

      if (onlyInteractiveSeedFlagsProvided && interactive) {
        try {
          const { parentId, parentData } = await resolveParentIssueForCreate(
            parentIdentifier,
          )
          const explicitProjectId = project == null
            ? undefined
            : await resolveProjectIdForCreate(project, interactive)

          const interactiveData = await promptInteractiveIssueCreation(
            explicitProjectId,
            parentId,
            parentData,
          )

          if (interactiveData.projectId != null) {
            await requireProjectTeam(
              interactiveData.projectId,
              interactiveData.teamId,
              interactiveData.teamKey,
            )
          }

          console.log(`Creating issue...`)
          console.log()

          const payload = await submitIssue({
            title: interactiveData.title,
            assigneeId: interactiveData.assigneeId,
            parentId: interactiveData.parentId,
            priority: interactiveData.priority,
            estimate: interactiveData.estimate,
            labelIds: interactiveData.labelIds,
            teamId: interactiveData.teamId,
            projectId: interactiveData.projectId,
            stateId: interactiveData.stateId,
            useDefaultTemplate,
            description: interactiveData.description,
          })
          const issue = payload.issue
          console.log(
            `✓ Created issue ${issue.identifier}: ${interactiveData.title}`,
          )
          console.log(issue.url)

          return
        } catch (error) {
          handleError(error, "Failed to create issue")
        }
      }

      try {
        const result = await createIssue({
          assignee,
          dueDate,
          useDefaultTemplate,
          parent: parentIdentifier,
          priority,
          estimate,
          description: finalDescription,
          label: labels,
          team,
          project,
          state,
          milestone,
          cycle,
          interactive,
          title,
        })
        if (json === true) console.log(JSON.stringify(result, null, 2))
        else {
          const issue = result.data.issue
          console.log("✓ Created issue " + issue.identifier + ": " + title)
          console.log(issue.url)
        }
      } catch (error) {
        handleError(error, "Failed to create issue")
      }
    },
  )

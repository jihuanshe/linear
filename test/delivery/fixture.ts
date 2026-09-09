import { join } from "@std/path"
import type { IssueFieldsFragment } from "../../src/__codegen__/graphql.ts"
import {
  type LoadedManifest,
  loadManifest,
} from "../../src/delivery/manifest.ts"
import {
  type MockGraphQLRequest,
  MockLinearServer,
} from "../utils/mock_linear_server.ts"
import { commonDenoArgs } from "../utils/test-helpers.ts"

export const WORKSPACE = {
  id: "00000000-0000-4000-8000-000000000001",
  urlKey: "testing",
}
export const TEAM = {
  id: "00000000-0000-4000-8000-000000000010",
  key: "ENG",
  name: "Engineering",
  activeCycle: null,
}
export const OTHER_TEAM = {
  id: "00000000-0000-4000-8000-000000000011",
  key: "OPS",
  name: "Operations",
  activeCycle: null,
}
export const PROJECT = {
  id: "00000000-0000-4000-8000-000000000020",
  name: "Release",
  slugId: "release",
}
export const USER = {
  id: "00000000-0000-4000-8000-000000000030",
  name: "Alex",
  displayName: "alex",
}
export const OTHER_USER = {
  id: "00000000-0000-4000-8000-000000000031",
  name: "Alex",
  displayName: "alex",
}
export const STATE = {
  id: "00000000-0000-4000-8000-000000000040",
  name: "Todo",
  type: "unstarted",
  color: "#123456",
}
export const STARTED = {
  id: "00000000-0000-4000-8000-000000000041",
  name: "In Progress",
  type: "started",
  color: "#123456",
}
export const LABEL = {
  id: "00000000-0000-4000-8000-000000000050",
  name: "Bug",
  color: "#123456",
}
export const OTHER_LABEL = {
  id: "00000000-0000-4000-8000-000000000051",
  name: "Feature",
  color: "#234567",
}
export const issueId = (number: number) =>
  `00000000-0000-4000-8000-${String(number).padStart(12, "0")}`
export const connection = <T>(nodes: T[] = []) => ({
  nodes,
  pageInfo: { hasNextPage: false, endCursor: null as string | null },
})

export function issue(
  number = 1001,
  values: Partial<IssueFieldsFragment> = {},
): IssueFieldsFragment {
  return {
    id: issueId(number),
    identifier: `ENG-${number}`,
    title: "Original title",
    description: "Original description",
    archivedAt: null,
    trashed: false,
    url: `https://linear.app/testing/issue/ENG-${number}`,
    branchName: `eng-${number}`,
    priority: 2,
    estimate: null,
    dueDate: null,
    state: STATE,
    assignee: null,
    project: null,
    projectMilestone: null,
    cycle: null,
    team: TEAM,
    labels: connection([LABEL]),
    parent: null,
    ...values,
  }
}
export const basis = (value: IssueFieldsFragment) => ({
  organization: WORKSPACE,
  issue: structuredClone(value),
})
export const update = (
  value: IssueFieldsFragment,
  set: Record<string, unknown> = { title: "Desired title" },
) => ({
  operation: "update",
  identifier: value.identifier,
  set,
  base: basis(value),
})
export const create = (title = "Created title", team = "ENG") => ({
  operation: "create",
  set: { title, team },
})
export const manifest = (issues: unknown[], workspace = WORKSPACE.urlKey) => ({
  schemaVersion: 2,
  workspace,
  issues,
})
export type Responses = NonNullable<
  ConstructorParameters<typeof MockLinearServer>[0]
>

export interface FixtureRelation {
  id: string
  type: string
  issueId: string
  relatedIssueId: string
}
export class DeliveryState {
  organization = { ...WORKSPACE }
  issues = new Map<string, IssueFieldsFragment>()
  aliases = new Map<string, string>()
  projects = new Map([[PROJECT.id, { ...PROJECT, teams: connection([TEAM]) }]])
  users = new Map([[USER.id, USER], [OTHER_USER.id, OTHER_USER]])
  comments = new Map<
    string,
    { id: string; issue: { id: string }; body: string }
  >()
  attachments = new Map<
    string,
    { id: string; issue: { id: string }; url: string; title: string }
  >()
  relations: FixtureRelation[] = []
  nextIssue = 2001
  constructor(initial: IssueFieldsFragment[]) {
    for (const value of initial) {
      this.issues.set(value.id, structuredClone(value))
    }
  }
  find(ref: unknown) {
    const text = String(ref)
    return this.issues.get(text) ??
      this.issues.get(this.aliases.get(text) ?? "") ??
      [...this.issues.values()].find((value) =>
        value.identifier.toLowerCase() === text.toLowerCase()
      )
  }
  patch(value: IssueFieldsFragment, input: Record<string, unknown>) {
    for (
      const field of [
        "title",
        "description",
        "priority",
        "estimate",
        "dueDate",
      ] as const
    ) {
      if (Object.hasOwn(input, field)) {
        Object.assign(value, { [field]: input[field] })
      }
    }
    if (Object.hasOwn(input, "stateId")) {
      value.state = input.stateId === STARTED.id ? STARTED : STATE
    }
    if (Object.hasOwn(input, "assigneeId")) {
      value.assignee = input.assigneeId === null
        ? null
        : this.users.get(String(input.assigneeId)) ?? null
    }
    if (Object.hasOwn(input, "projectId")) {
      value.project = input.projectId == null
        ? null
        : this.projects.get(String(input.projectId)) ?? null
    }
    if (Object.hasOwn(input, "teamId")) {
      value.team = input.teamId === OTHER_TEAM.id ? OTHER_TEAM : TEAM
    }
    if (Object.hasOwn(input, "parentId")) {
      const parent = this.find(input.parentId)
      value.parent = parent == null ? null : {
        id: parent.id,
        identifier: parent.identifier,
        title: parent.title,
        state: parent.state,
      }
    }
    if (Object.hasOwn(input, "cycleId")) {
      value.cycle = input.cycleId === null ? null : {
        id: String(input.cycleId),
        number: 4,
        name: "Cycle",
        isActive: true,
        isNext: false,
        isPrevious: false,
        isFuture: false,
        isPast: false,
      }
    }
    if (Object.hasOwn(input, "projectMilestoneId")) {
      value.projectMilestone = input.projectMilestoneId === null
        ? null
        : { id: String(input.projectMilestoneId), name: "Milestone" }
    }
    const allLabels = [LABEL, OTHER_LABEL]
    const { labelIds, addedLabelIds, removedLabelIds } = input
    if (Array.isArray(labelIds)) {
      value.labels = connection(
        allLabels.filter((label) => labelIds.includes(label.id)),
      )
    }
    if (Array.isArray(addedLabelIds)) {
      value.labels = connection([
        ...new Map([
          ...value.labels.nodes,
          ...allLabels.filter((label) => addedLabelIds.includes(label.id)),
        ].map((label) => [label.id, label])).values(),
      ])
    }
    if (Array.isArray(removedLabelIds)) {
      value.labels = connection(
        value.labels.nodes.filter((label) =>
          !removedLabelIds.includes(label.id)
        ),
      )
    }
    return value
  }
  newIssue(input: Record<string, unknown>) {
    const number = this.nextIssue++
    const team = input.teamId === OTHER_TEAM.id ? OTHER_TEAM : TEAM
    const value = this.patch(
      issue(number, {
        title: String(input.title),
        description: null,
        labels: connection(),
        team,
        identifier: `${team.key}-${number}`,
      }),
      input,
    )
    this.issues.set(value.id, value)
    return value
  }
  relationInventory(ref: unknown) {
    const target = this.find(ref)
    return {
      relations: connection(
        this.relations.filter((edge) => edge.issueId === target?.id).map((
          edge,
        ) => ({
          id: edge.id,
          type: edge.type,
          relatedIssue: this.find(edge.relatedIssueId),
        })),
      ),
      inverseRelations: connection(
        this.relations.filter((edge) => edge.relatedIssueId === target?.id).map(
          (edge) => ({
            id: edge.id,
            type: edge.type,
            issue: this.find(edge.issueId),
          }),
        ),
      ),
    }
  }
}

export async function fixture(options: {
  issues?: IssueFieldsFragment[]
  overrides?: (state: DeliveryState) => Responses
} = {}) {
  const dir = await Deno.makeTempDir()
  const path = join(dir, "delivery.json")
  const state = new DeliveryState(options.issues ?? [issue()])
  const readIssue = ({ variables }: MockGraphQLRequest) => ({
    data: {
      organization: state.organization,
      issue: state.find(variables.id) ?? null,
    },
  })
  const defaults: Responses = [
    {
      queryName: "GetDeliveryOrganization",
      response: () => ({ data: { organization: state.organization } }),
    },
    ...[
      "GetIssueForWrite",
      "GetIssueHeader",
      "GetIssueId",
      "GetParentIssueData",
      "GetIssueProjectId",
    ].map((queryName) => ({ queryName, response: readIssue })),
    {
      queryName: "GetWriteTeamByKey",
      response: ({ variables }) => ({
        data: {
          teams: connection(
            [TEAM, OTHER_TEAM].filter((team) =>
              team.key.toLowerCase() === String(variables.key).toLowerCase()
            ),
          ),
        },
      }),
    },
    {
      queryName: "GetWriteTeamById",
      response: ({ variables }) => ({
        data: {
          team: [TEAM, OTHER_TEAM].find((team) => team.id === variables.id) ??
            null,
        },
      }),
    },
    {
      queryName: "GetWorkflowStates",
      response: {
        data: {
          team: {
            states: connection([{ ...STATE, position: 0 }, {
              ...STARTED,
              position: 1,
            }]),
          },
        },
      },
    },
    {
      queryName: "LookupUserById",
      response: ({ variables }) => ({
        data: {
          users: connection(
            state.users.has(String(variables.id))
              ? [state.users.get(String(variables.id))]
              : [],
          ),
        },
      }),
    },
    {
      queryName: "LookupUser",
      response: ({ variables }) => ({
        data: {
          users: connection(
            [...state.users.values()].filter((user) =>
              user.name.toLowerCase() === String(variables.input).toLowerCase()
            ).slice(0, 1),
          ),
        },
      }),
    },
    { queryName: "GetViewerId", response: { data: { viewer: USER } } },
    {
      queryName: "GetIssueLabelIdByNameForTeam",
      response: ({ variables }) => ({
        data: {
          issueLabels: connection(
            [LABEL, OTHER_LABEL].filter((label) =>
              label.name.toLowerCase() === String(variables.name).toLowerCase()
            ),
          ),
        },
      }),
    },
    {
      queryName: "GetIssueLabelForWrite",
      response: ({ variables }) => ({
        data: {
          issueLabel:
            [LABEL, OTHER_LABEL].some((label) => label.id === variables.id)
              ? { id: variables.id, isGroup: false, team: TEAM }
              : null,
        },
      }),
    },
    {
      queryName: "GetProjectIdByName",
      response: ({ variables }) => ({
        data: {
          projects: connection(
            [...state.projects.values()].filter((project) =>
              project.name === variables.name
            ),
          ),
        },
      }),
    },
    {
      queryName: "GetProjectIdBySlugId",
      response: ({ variables }) => ({
        data: {
          projects: connection(
            [...state.projects.values()].filter((project) =>
              project.slugId === variables.slugId
            ),
          ),
        },
      }),
    },
    {
      queryName: "ProjectTeams",
      response: ({ variables }) => ({
        data: { project: state.projects.get(String(variables.id)) ?? null },
      }),
    },
    {
      queryName: "GetExistingIssueRelations",
      response: ({ variables }) => ({
        data: { issue: state.relationInventory(variables.issueId) },
      }),
    },
    {
      queryName: "UpdateIssue",
      response: ({ variables }) => ({
        data: {
          issueUpdate: {
            success: true,
            issue: state.patch(
              state.find(variables.id)!,
              variables.input as Record<string, unknown>,
            ),
          },
        },
      }),
    },
    {
      queryName: "CreateIssue",
      response: ({ variables }) => ({
        data: {
          issueCreate: {
            success: true,
            issue: state.newIssue(variables.input as Record<string, unknown>),
          },
        },
      }),
    },
    {
      queryName: "AddComment",
      response: ({ variables }) => {
        const input = variables.input as { issueId: string; body: string }
        const value = {
          id: `comment-${state.comments.size + 1}`,
          issue: { id: input.issueId },
          body: input.body,
        }
        state.comments.set(value.id, value)
        return { data: { commentCreate: { success: true, comment: value } } }
      },
    },
    ...["AttachmentLinkURL", "AttachmentCreate"].map((queryName) => ({
      queryName,
      response: ({ variables }: MockGraphQLRequest) => {
        const input = (variables.input ?? variables) as {
          issueId: string
          url: string
          title?: string
        }
        const value = {
          id: `attachment-${state.attachments.size + 1}`,
          issue: { id: input.issueId },
          url: input.url,
          title: input.title ?? "Attachment",
        }
        state.attachments.set(value.id, value)
        return {
          data: {
            [
              queryName === "AttachmentCreate"
                ? "attachmentCreate"
                : "attachmentLinkURL"
            ]: { success: true, attachment: value },
          },
        }
      },
    })),
    {
      queryName: "CreateIssueRelation",
      response: ({ variables }) => {
        const input = variables.input as Omit<FixtureRelation, "id">
        const value = { id: `relation-${state.relations.length + 1}`, ...input }
        state.relations.push(value)
        return {
          data: {
            issueRelationCreate: {
              success: true,
              issueRelation: { id: value.id },
            },
          },
        }
      },
    },
    {
      queryName: "FileUpload",
      response: () => ({
        data: {
          fileUpload: {
            success: true,
            uploadFile: {
              assetUrl: `https://uploads.linear.app/file-${
                server.uploadRequests.length + 1
              }`,
              uploadUrl: server.getUploadUrl(),
              headers: [{
                key: "x-upload-proof",
                value: "fixture-upload-secret",
              }],
            },
          },
        },
      }),
    },
    {
      queryName: "GetDeliveryCommentReceipt",
      response: ({ variables }) => ({
        data: { comment: state.comments.get(String(variables.id)) ?? null },
      }),
    },
    {
      queryName: "GetDeliveryAttachmentReceipt",
      response: ({ variables }) => ({
        data: {
          attachment: state.attachments.get(String(variables.id)) ?? null,
        },
      }),
    },
    {
      queryName: "GetDeliveryRelationReceipt",
      response: ({ variables }) => {
        const value = state.relations.find((edge) => edge.id === variables.id)
        return {
          data: {
            issueRelation: value == null ? null : {
              id: value.id,
              issue: { id: value.issueId },
              relatedIssue: { id: value.relatedIssueId },
            },
          },
        }
      },
    },
  ]
  const server = new MockLinearServer([
    ...(options.overrides?.(state) ?? []),
    ...defaults,
  ])
  await server.start()
  Deno.env.set("LINEAR_GRAPHQL_ENDPOINT", server.getEndpoint())
  Deno.env.set("LINEAR_API_KEY", "test-token")
  return {
    dir,
    path,
    state,
    server,
    async write(value: unknown) {
      await Deno.writeTextFile(path, JSON.stringify(value))
      return path
    },
    async load(value: unknown): Promise<LoadedManifest> {
      await Deno.writeTextFile(path, JSON.stringify(value))
      return await loadManifest(path)
    },
    mutations() {
      return server.graphqlRequests.filter((request) =>
        /\bmutation\s/.test(request.query)
      )
    },
    queries(name: string) {
      return server.graphqlRequests.filter((request) =>
        request.query.includes(`query ${name}(`) ||
        request.query.includes(`query ${name} {`)
      )
    },
    async cli(mode: "plan" | "apply", extra: string[] = []) {
      const result = await new Deno.Command(Deno.execPath(), {
        args: [
          "run",
          ...commonDenoArgs,
          "src/main.ts",
          "issue",
          mode,
          "--file",
          path,
          ...(mode === "apply"
            ? ["--confirm-workspace", WORKSPACE.urlKey]
            : []),
          "--json",
          ...extra,
        ],
        env: {
          LINEAR_GRAPHQL_ENDPOINT: server.getEndpoint(),
          LINEAR_API_KEY: "test-token",
          NO_COLOR: "1",
        },
        stdin: "null",
        stdout: "piped",
        stderr: "piped",
      }).output()
      const stdout = new TextDecoder().decode(result.stdout)
      const stderr = new TextDecoder().decode(result.stderr)
      return { ...result, stdout, stderr, json: () => JSON.parse(stdout) }
    },
    async cleanup() {
      await server.stop()
      Deno.env.delete("LINEAR_GRAPHQL_ENDPOINT")
      Deno.env.delete("LINEAR_API_KEY")
      await Deno.remove(dir, { recursive: true })
    },
  }
}

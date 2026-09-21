import { assertEquals } from "@std/assert"
import {
  formatIssueContextLines,
  type IssueContextInput,
  issueContextTraces,
  summarizeIssueContext,
} from "../../src/utils/issue-context.ts"

const viewer = { id: "user-viewer", name: "viewer", displayName: "Viewer" }
const other = { id: "user-other", name: "other", displayName: "Other Person" }

function contextInput(
  overrides: Partial<IssueContextInput["issue"]> = {},
): IssueContextInput {
  return {
    viewer: { id: viewer.id },
    issue: {
      identifier: "ENG-123",
      assignee: viewer,
      parent: { identifier: "ENG-100", title: "Epic", state: { name: "Todo" } },
      children: {
        nodes: [
          { identifier: "ENG-124", title: "A", state: { name: "Done" } },
          { identifier: "ENG-125", title: "B", state: { name: "Todo" } },
          { identifier: "ENG-126", title: "C", state: { name: "Todo" } },
        ],
        pageInfo: { hasNextPage: true },
      },
      relations: {
        nodes: [
          {
            type: "blocks",
            relatedIssue: { identifier: "ENG-200", title: "R" },
          },
          { type: "duplicate", relatedIssue: null },
        ],
        pageInfo: { hasNextPage: false },
      },
      inverseRelations: {
        nodes: [
          { type: "duplicate", issue: { identifier: "ENG-300", title: "D" } },
          { type: "related", issue: { identifier: "ENG-301", title: "S" } },
        ],
        pageInfo: { hasNextPage: false },
      },
      attachments: { nodes: [{}, {}], pageInfo: { hasNextPage: true } },
      comments: {
        nodes: [
          {
            createdAt: "2026-09-01T10:00:00.000Z",
            resolvedAt: null,
            user: viewer,
            parent: null,
          },
          {
            createdAt: "2026-09-03T10:00:00.000Z",
            resolvedAt: null,
            user: other,
            parent: null,
          },
          {
            createdAt: "2026-09-02T10:00:00.000Z",
            resolvedAt: "2026-09-02T11:00:00.000Z",
            user: null,
            externalUser: { name: "ext", displayName: "External" },
            parent: null,
          },
          {
            createdAt: "2026-09-02T12:00:00.000Z",
            resolvedAt: null,
            user: other,
            parent: { id: "comment-1" },
          },
        ],
        pageInfo: { hasNextPage: false },
      },
      history: {
        nodes: [
          {
            createdAt: "2026-09-04T10:00:00.000Z",
            actor: viewer,
            fromState: { name: "Todo" },
            toState: { name: "In Progress" },
          },
          {
            createdAt: "2026-09-03T10:00:00.000Z",
            actor: other,
            fromState: { name: "Triage" },
            toState: { name: "Todo" },
            fromAssignee: null,
            toAssignee: viewer,
          },
          {
            createdAt: "2026-09-02T10:00:00.000Z",
            actor: null,
            botActor: { name: "GitHub", userDisplayName: "other" },
            fromProject: { name: "Old" },
            toProject: { name: "New" },
          },
          {
            createdAt: "2026-09-01T10:00:00.000Z",
            actor: other,
            fromState: null,
            toState: null,
          },
        ],
        pageInfo: { hasNextPage: true },
      },
      ...overrides,
    },
  }
}

Deno.test("summarizeIssueContext separates the current account from others", () => {
  const summary = summarizeIssueContext(contextInput())
  assertEquals(summary.viewerId, viewer.id)
  assertEquals(summary.assignee, { id: viewer.id, name: "Viewer" })
  assertEquals(summary.viewerIsAssignee, true)
  assertEquals(summary.parent, {
    identifier: "ENG-100",
    title: "Epic",
    state: "Todo",
  })
  assertEquals(summary.subIssues, {
    fetched: true,
    count: 3,
    complete: false,
    byState: { Done: 1, Todo: 2 },
    items: [
      { identifier: "ENG-124", state: "Done" },
      { identifier: "ENG-125", state: "Todo" },
      { identifier: "ENG-126", state: "Todo" },
    ],
  })
  assertEquals(summary.relations, {
    fetched: true,
    complete: true,
    items: [
      { kind: "blocks", identifier: "ENG-200", title: "R" },
      { kind: "duplicated by", identifier: "ENG-300", title: "D" },
      { kind: "related", identifier: "ENG-301", title: "S" },
    ],
  })
  assertEquals(summary.attachments, {
    fetched: true,
    count: 2,
    complete: false,
  })
  assertEquals(summary.comments, {
    fetched: true,
    count: 4,
    complete: true,
    unresolvedThreads: 2,
    byOtherAccounts: 3,
    latestByOtherAccount: {
      author: "Other Person",
      createdAt: "2026-09-03T10:00:00.000Z",
    },
  })
  assertEquals(summary.history, {
    fetched: true,
    entries: 4,
    complete: false,
    changesByOtherAccounts: [
      {
        createdAt: "2026-09-03T10:00:00.000Z",
        actor: "Other Person",
        changes: ["state Triage -> Todo", "assignee - -> Viewer"],
      },
      {
        createdAt: "2026-09-02T10:00:00.000Z",
        actor: "GitHub [user: other]",
        changes: ["project Old -> New"],
      },
    ],
  })
  assertEquals(issueContextTraces(summary), [
    "sub-issues",
    "a parent issue",
    "relations",
    "state or ownership changes by other accounts",
    "comments by other accounts",
  ])
})

Deno.test("summarizeIssueContext reports collections a read did not include", () => {
  const summary = summarizeIssueContext({
    viewer: null,
    issue: { identifier: "ENG-1", assignee: other },
  })
  assertEquals(summary.viewerIsAssignee, null)
  assertEquals(summary.subIssues.fetched, false)
  assertEquals(summary.relations.fetched, false)
  assertEquals(summary.attachments.fetched, false)
  assertEquals(summary.comments.fetched, false)
  assertEquals(summary.history.fetched, false)
  assertEquals(issueContextTraces(summary), [])
  assertEquals(formatIssueContextLines(summary), [
    "- Assignee: @Other Person",
    "- Parent: none",
    "- Sub-issues: not fetched",
    "- Relations: not fetched",
    "- Attachments: not fetched | Comments: not fetched",
    "- Changes by other accounts: history not fetched",
  ])

  const unassigned = summarizeIssueContext({
    viewer: { id: viewer.id },
    issue: { identifier: "ENG-1", assignee: null },
  })
  assertEquals(unassigned.viewerIsAssignee, false)
  assertEquals(formatIssueContextLines(unassigned)[0], "- Assignee: Unassigned")
})

Deno.test("formatIssueContextLines marks incomplete counts and other accounts", () => {
  assertEquals(formatIssueContextLines(summarizeIssueContext(contextInput())), [
    "- Assignee: @Viewer (the current account)",
    "- Parent: ENG-100 Epic [Todo]",
    "- Sub-issues: 3+ (Done 1, Todo 2): ENG-124, ENG-125, ENG-126",
    "- Relations: blocks ENG-200; duplicated by ENG-300; related ENG-301",
    "- Attachments: 2+ | Comments: 4 (2 unresolved threads; 3 by other accounts, latest @Other Person 2026-09-03 10:00)",
    "- Changes by other accounts (latest 4 history entries; older ones exist, see issue history):",
    "  - 2026-09-03 10:00 @Other Person: state Triage -> Todo; assignee - -> Viewer",
    "  - 2026-09-02 10:00 @GitHub [user: other]: project Old -> New",
  ])

  const quiet = summarizeIssueContext(contextInput({
    assignee: other,
    parent: null,
    children: { nodes: [], pageInfo: { hasNextPage: false } },
    relations: { nodes: [], pageInfo: { hasNextPage: false } },
    inverseRelations: { nodes: [], pageInfo: { hasNextPage: false } },
    attachments: { nodes: [], pageInfo: { hasNextPage: false } },
    comments: { nodes: [], pageInfo: { hasNextPage: false } },
    history: {
      nodes: [{
        createdAt: "2026-09-04T10:00:00.000Z",
        actor: viewer,
        fromState: { name: "Todo" },
        toState: { name: "Canceled" },
      }],
      pageInfo: { hasNextPage: false },
    },
  }))
  assertEquals(issueContextTraces(quiet), [])
  assertEquals(formatIssueContextLines(quiet), [
    "- Assignee: @Other Person (not the current account)",
    "- Parent / Sub-issues / Relations: none",
    "- Attachments: 0 | Comments: 0 (0 unresolved threads; none by other accounts)",
    "- Changes by other accounts: none (all 1 history entries)",
  ])
})

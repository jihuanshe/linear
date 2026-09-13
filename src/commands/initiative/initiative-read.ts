import { gql } from "../../__codegen__/gql.ts"
import { getGraphQLClient } from "../../utils/graphql.ts"
import { NotFoundError, ValidationError } from "../../utils/errors.ts"

const ReadInitiative = gql(`
  query ReadInitiative(
    $id: ID!
    $includeContent: Boolean!
    $projectsAfter: String
    $documentsAfter: String
  ) {
    organization { id urlKey }
    initiatives(first: 2, filter: { id: { eq: $id } }, includeArchived: true) {
      nodes {
        id slugId name description content @include(if: $includeContent) status targetDate health color icon url archivedAt
        createdAt updatedAt trashed
        owner { id name displayName }
        projects(first: 50, after: $projectsAfter) {
          nodes { id slugId name description @include(if: $includeContent) url status { name type } }
          pageInfo { hasNextPage endCursor }
        }
        documents(first: 50, after: $documentsAfter, includeArchived: false) @include(if: $includeContent) {
          nodes { id slugId title url }
          pageInfo { hasNextPage endCursor }
        }
      }
      pageInfo { hasNextPage endCursor }
    }
  }
`)

export async function readInitiative(
  client: ReturnType<typeof getGraphQLClient>,
  id: string,
  options: { includeContent?: boolean } = {},
) {
  const result = await client.request(ReadInitiative, {
    id,
    includeContent: options.includeContent === true,
    projectsAfter: null,
    documentsAfter: null,
  })
  const { nodes, pageInfo } = result.initiatives
  if (nodes.length > 1 || pageInfo.hasNextPage) {
    throw new ValidationError(`Initiative reference is ambiguous: ${id}`)
  }
  const initiative = nodes[0]
  if (!initiative || initiative.id !== id) {
    throw new NotFoundError("Initiative", id)
  }
  const initialProjects = {
    ...(initiative.projects ?? {}),
    nodes: initiative.projects?.nodes ?? [],
    ...(initiative.projects &&
        Object.prototype.hasOwnProperty.call(initiative.projects, "pageInfo")
      ? { pageInfo: initiative.projects.pageInfo }
      : {}),
  }
  const projects = [...initialProjects.nodes]
  const documents = initiative.documents == null
    ? null
    : [...initiative.documents.nodes]
  let projectsPageInfo = initialProjects.pageInfo ?? {
    hasNextPage: false,
    endCursor: null,
  }
  let documentsPageInfo = initiative.documents?.pageInfo ?? {
    hasNextPage: false,
    endCursor: null,
  }
  let projectsAfter: string | null = null
  let documentsAfter: string | null = null
  let projectsComplete = !projectsPageInfo.hasNextPage
  let documentsComplete = !documentsPageInfo.hasNextPage
  while (projectsPageInfo.hasNextPage || documentsPageInfo?.hasNextPage) {
    projectsAfter = !projectsComplete && projectsPageInfo.hasNextPage
      ? projectsPageInfo.endCursor
      : null
    documentsAfter = !documentsComplete && documentsPageInfo?.hasNextPage
      ? documentsPageInfo.endCursor
      : null
    if (projectsAfter == null && projectsPageInfo.hasNextPage) {
      throw new ValidationError(
        "Initiative projects pagination returned no cursor",
      )
    }
    if (documentsAfter == null && documentsPageInfo?.hasNextPage) {
      throw new ValidationError(
        "Initiative documents pagination returned no cursor",
      )
    }
    const page = await client.request(ReadInitiative, {
      id,
      includeContent: options.includeContent === true,
      projectsAfter,
      documentsAfter,
    })
    const pageInitiative = page.initiatives.nodes[0]
    if (!pageInitiative || pageInitiative.id !== id) {
      throw new ValidationError(`Initiative pagination changed target: ${id}`)
    }
    if (!projectsComplete) projects.push(...pageInitiative.projects.nodes)
    if (!documentsComplete && documents && pageInitiative.documents) {
      documents.push(...pageInitiative.documents.nodes)
    }
    if (!projectsComplete) {
      projectsPageInfo = pageInitiative.projects.pageInfo
      projectsComplete = !projectsPageInfo.hasNextPage
    }
    if (!documentsComplete) {
      documentsPageInfo = pageInitiative.documents?.pageInfo ?? {
        hasNextPage: false,
        endCursor: null,
      }
      documentsComplete = !documentsPageInfo.hasNextPage
    }
  }
  return {
    organization: result.organization,
    initiative: {
      ...initiative,
      projects: {
        ...initialProjects,
        nodes: projects,
        ...(Object.prototype.hasOwnProperty.call(initialProjects, "pageInfo")
          ? { pageInfo: projectsPageInfo }
          : {}),
      },
      ...(documents && initiative.documents
        ? {
          documents: {
            ...initiative.documents,
            nodes: documents,
            pageInfo: documentsPageInfo!,
          },
        }
        : {}),
    },
  }
}

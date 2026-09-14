import { ValidationError } from "./errors.ts"

/**
 * Validate the identity returned by a read used as a write basis.
 *
 * This checks the two identities the client can observe: the target object and
 * the workspace returned by Linear. It is not a lock or a server-side CAS.
 */
export function assertReadIdentity(
  object: { id?: unknown } | null | undefined,
  targetId: string,
  organization: { id?: unknown } | null | undefined,
  workspaceId: string,
  objectName: string,
): asserts object is { id: string } {
  if (
    typeof object?.id !== "string" ||
    object.id.toLowerCase() !== targetId.toLowerCase()
  ) {
    throw new ValidationError(
      `${objectName} read resolved to a different stable identity`,
    )
  }
  assertReadOrganization(organization, objectName)
  if (organization.id.toLowerCase() !== workspaceId.toLowerCase()) {
    throw new ValidationError(
      `${objectName} read resolved to a different workspace`,
    )
  }
}

export function assertReadOrganization(
  organization: { id?: unknown } | null | undefined,
  objectName: string,
): asserts organization is { id: string } {
  if (typeof organization?.id !== "string" || organization.id === "") {
    throw new ValidationError(
      `${objectName} read returned no workspace identity`,
    )
  }
}

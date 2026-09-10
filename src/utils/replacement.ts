import { CliError, ValidationError } from "./errors.ts"

/** Native GraphQL read shape: { organization: { id, urlKey }, issue: {...} }. */
export type ReadBasis = Record<string, unknown>
export type Comparable = string | number | boolean | null | string[]

export interface FieldReader {
  /** The API response field name, also used by --expect-field. */
  field: string
  read(object: Record<string, unknown>): Comparable
  normalize(value: unknown): Comparable
}

export interface ReplacementFieldPlan {
  field: string
  inputField: string
  base?: Comparable
  remote: Comparable
  desired: Comparable
  verdict: "write" | "idempotent" | "conflict"
}

export class ConflictError extends CliError {
  readonly fields: ReplacementFieldPlan[]
  readonly dependencies: string[]

  constructor(fields: ReplacementFieldPlan[], dependencies: string[] = []) {
    const changed = [
      ...fields.filter((field) => field.verdict === "conflict").map((field) =>
        field.field
      ),
      ...dependencies,
    ]
    super(`Original values changed: ${[...new Set(changed)].join(", ")}`, {
      suggestion:
        "Read the current object and reconsider the change; do not refresh the original file merely to bypass this conflict.",
      details: { fields, dependencies },
    })
    this.name = "ConflictError"
    this.fields = fields
    this.dependencies = dependencies
  }
}

export function asRecord(
  value: unknown,
  label: string,
): Record<string, unknown> {
  if (value == null || typeof value !== "object" || Array.isArray(value)) {
    throw new ValidationError(`${label} must be an object`)
  }
  return value as Record<string, unknown>
}

export async function loadBasisFile(path: string): Promise<ReadBasis> {
  if (path === "") {
    throw new ValidationError("Original read file cannot be empty")
  }
  try {
    return asRecord(JSON.parse(await Deno.readTextFile(path)), "Original read")
  } catch (error) {
    if (error instanceof ValidationError) throw error
    throw new ValidationError(`Cannot read original JSON: ${path}`, {
      suggestion: error instanceof Error ? error.message : String(error),
    })
  }
}

function required(object: Record<string, unknown>, key: string): unknown {
  if (!Object.hasOwn(object, key) || object[key] === undefined) {
    throw new ValidationError(`Read is missing field ${key}`, {
      suggestion:
        "Save a complete read for the fields being replaced or checked; missing fields are not null values.",
    })
  }
  return object[key]
}

function scalar(value: unknown, field: string): Comparable {
  if (
    value === null || typeof value === "string" || typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  ) return value
  throw new ValidationError(`Field ${field} must contain a scalar or null`)
}

/** API scalar values compare exactly, including Markdown and explicit null. */
export function scalarField(field: string): FieldReader {
  return {
    field,
    read: (object) => scalar(required(object, field), field),
    normalize: (value) => scalar(value, field),
  }
}

function id(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new ValidationError(`${label} must contain a stable object ID`)
  }
  // UUID casing is representation, not identity; no names or slugs are folded.
  return /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value)
    ? value.toLowerCase()
    : value
}

export function referenceField(field: string): FieldReader {
  return {
    field,
    read(object) {
      const value = required(object, field)
      if (value === null) return null
      return id(required(asRecord(value, field), "id"), `${field}.id`)
    },
    normalize: (value) => value === null ? null : id(value, field),
  }
}

function idSet(value: unknown, label: string): string[] {
  if (!Array.isArray(value)) {
    throw new ValidationError(`${label} must contain an array of stable IDs`)
  }
  return [...new Set(value.map((entry) => id(entry, label)))].sort()
}

/** Only explicitly declared ID sets use order-independent comparison. */
export function connectionField(field: string): FieldReader {
  return {
    field,
    read(object) {
      const connection = asRecord(required(object, field), field)
      const pageInfo = asRecord(
        required(connection, "pageInfo"),
        `${field}.pageInfo`,
      )
      if (required(pageInfo, "hasNextPage") !== false) {
        throw new ValidationError(
          `Read does not contain the complete ${field} set`,
        )
      }
      const nodes = required(connection, "nodes")
      if (!Array.isArray(nodes)) {
        throw new ValidationError(`${field}.nodes must be an array`)
      }
      return idSet(
        nodes.map((node) => required(asRecord(node, field), "id")),
        field,
      )
    },
    normalize: (value) => idSet(value, field),
  }
}

function equal(a: Comparable, b: Comparable): boolean {
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length &&
      a.every((value, index) => value === b[index])
  }
  return a === b
}

function identity(read: ReadBasis, objectKey: string) {
  const organization = asRecord(required(read, "organization"), "organization")
  const organizationId = id(required(organization, "id"), "organization.id")
  const urlKey = required(organization, "urlKey")
  if (typeof urlKey !== "string" || urlKey.length === 0) {
    throw new ValidationError("organization.urlKey must be present in the read")
  }
  const object = asRecord(required(read, objectKey), objectKey)
  return {
    organizationId,
    objectId: id(required(object, "id"), `${objectKey}.id`),
    object,
  }
}

/**
 * One final observed-value check shared by existing replacement operations.
 * Call after resolving inputs, immediately before the actual mutation. This
 * is not server CAS: a concurrent write after this read remains possible.
 * The caller owns its typed GraphQL document and any domain-specific guards.
 */
export function prepareReplacement<T extends Record<string, unknown>>(options: {
  objectKey: string
  targetId: string
  original?: ReadBasis
  current: ReadBasis
  desired: T
  fields: Record<string, FieldReader>
  unprotected?: boolean
  expectFields?: string[]
}): { input: Partial<T>; fields: ReplacementFieldPlan[] } {
  const { original, current, desired, fields, objectKey, expectFields = [] } =
    options
  validateReplacementOptions(options)
  const remote = identity(current, objectKey)
  const targetId = id(options.targetId, "target")
  if (remote.objectId !== targetId) {
    throw new ValidationError("Current read resolved to a different object")
  }
  if (remote.object.archivedAt != null || remote.object.trashed === true) {
    throw new ValidationError(
      "Cannot replace fields on an archived or trashed object",
    )
  }
  const base = original == null ? undefined : identity(original, objectKey)
  if (
    base != null &&
    (base.objectId !== targetId ||
      base.organizationId !== remote.organizationId)
  ) {
    throw new ValidationError(
      "Original read belongs to a different object or workspace",
    )
  }

  const dependencies: string[] = []
  for (const field of new Set(expectFields)) {
    const reader = Object.values(fields).find((reader) =>
      reader.field === field
    )
    if (reader == null) {
      throw new ValidationError(`Unsupported dependency field: ${field}`)
    }
    if (!equal(reader.read(base!.object), reader.read(remote.object))) {
      dependencies.push(field)
    }
  }

  const input: Partial<T> = {}
  const plans: ReplacementFieldPlan[] = []
  for (const [inputField, value] of Object.entries(desired)) {
    if (value === undefined) continue
    const reader = fields[inputField]
    if (reader == null) {
      throw new ValidationError(`Unsupported replacement field: ${inputField}`)
    }
    const target = reader.normalize(value)
    const observed = reader.read(remote.object)
    // Require the original field even for no-op: a partial/malformed basis
    // must not accidentally claim it protected a value the caller never read.
    const previous = base == null ? undefined : reader.read(base.object)
    const verdict = equal(target, observed)
      ? "idempotent"
      : options.unprotected ||
          (previous !== undefined && equal(previous, observed))
      ? "write"
      : "conflict"
    plans.push({
      field: reader.field,
      inputField,
      ...(previous === undefined ? {} : { base: previous }),
      desired: target,
      remote: observed,
      verdict,
    })
    if (verdict === "write") input[inputField as keyof T] = value as T[keyof T]
  }
  if (
    dependencies.length > 0 || plans.some((plan) => plan.verdict === "conflict")
  ) {
    throw new ConflictError(plans, dependencies)
  }
  return { input, fields: plans }
}

export function validateReplacementOptions(options: {
  original?: ReadBasis
  unprotected?: boolean
  expectFields?: string[]
}): void {
  if (options.expectFields?.some((field) => !field.trim())) {
    throw new ValidationError("--expect-field cannot be empty")
  }
  if (options.unprotected && options.original != null) {
    throw new ValidationError(
      "Use either --base-file or --unprotected, not both",
    )
  }
  if (options.original == null && !options.unprotected) {
    throw new ValidationError("Replacement requires the original read", {
      suggestion:
        "Save a read before deciding the change and pass --base-file; use --unprotected only for an explicitly unconditional replacement.",
    })
  }
  if ((options.expectFields?.length ?? 0) > 0 && options.original == null) {
    throw new ValidationError("--expect-field requires the original read")
  }
}

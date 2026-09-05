import { guideSources } from "./content.ts"

/** Guide frontmatter owns guide identity and command relationships. */
export interface GuideMetadata {
  name: string
  description: string
  commands: string[]
}

export interface Guide {
  metadata: GuideMetadata
  /** Markdown body with the frontmatter block removed. */
  body: string
}

const SCALAR_KEYS = ["name", "description"] as const
const LIST_KEYS = ["commands"] as const

type ScalarKey = typeof SCALAR_KEYS[number]
type ListKey = typeof LIST_KEYS[number]

function isScalarKey(key: string): key is ScalarKey {
  return (SCALAR_KEYS as readonly string[]).includes(key)
}

function isListKey(key: string): key is ListKey {
  return (LIST_KEYS as readonly string[]).includes(key)
}

export function parseGuide(source: string, origin: string): Guide {
  if (!source.startsWith("---\n")) {
    throw new Error(`Guide ${origin} must start with a frontmatter block`)
  }
  const end = source.indexOf("\n---\n", 4)
  if (end === -1) {
    throw new Error(`Guide ${origin} has an unterminated frontmatter block`)
  }
  const frontmatter = source.slice(4, end + 1)
  const body = source.slice(end + 5).replace(/^\n+/, "")

  const scalars: Partial<Record<ScalarKey, string>> = {}
  const lists: Partial<Record<ListKey, string[]>> = {}
  let currentList: string[] | null = null

  for (const line of frontmatter.split("\n")) {
    if (line.trim() === "") continue
    const itemMatch = line.match(/^ {2}- (.+)$/)
    if (itemMatch) {
      if (currentList == null) {
        throw new Error(
          `Guide ${origin} frontmatter has a list item outside a list: ${line}`,
        )
      }
      currentList.push(itemMatch[1].trim())
      continue
    }
    const keyMatch = line.match(/^([A-Za-z]+):(.*)$/)
    if (!keyMatch) {
      throw new Error(
        `Guide ${origin} frontmatter line not recognized: ${line}`,
      )
    }
    const key = keyMatch[1]
    const rest = keyMatch[2].trim()
    if (isScalarKey(key)) {
      if (rest === "") {
        throw new Error(`Guide ${origin} frontmatter ${key} must be a scalar`)
      }
      scalars[key] = rest
      currentList = null
    } else if (isListKey(key)) {
      if (rest !== "") {
        throw new Error(`Guide ${origin} frontmatter ${key} must be a list`)
      }
      currentList = []
      lists[key] = currentList
    } else {
      throw new Error(`Guide ${origin} frontmatter has unknown key: ${key}`)
    }
  }

  for (const key of SCALAR_KEYS) {
    if (scalars[key] == null) {
      throw new Error(`Guide ${origin} frontmatter is missing ${key}`)
    }
  }
  for (const key of LIST_KEYS) {
    if (lists[key] == null || lists[key].length === 0) {
      throw new Error(`Guide ${origin} frontmatter needs a non-empty ${key}`)
    }
  }

  return {
    metadata: {
      name: scalars.name as string,
      description: scalars.description as string,
      commands: lists.commands as string[],
    },
    body,
  }
}

function buildGuides(): Guide[] {
  const guides: Guide[] = []
  for (const [name, source] of Object.entries(guideSources)) {
    const guide = parseGuide(source, name)
    if (guide.metadata.name !== name) {
      throw new Error(
        `Guide ${name} declares frontmatter name ${guide.metadata.name}; the manifest key and frontmatter must agree`,
      )
    }
    guides.push(guide)
  }
  return guides
}

const guides = buildGuides()

/** Every embedded guide, in manifest display order. */
export function listGuides(): Guide[] {
  return guides
}

export function getGuide(name: string): Guide | undefined {
  return guides.find((guide) => guide.metadata.name === name)
}

/**
 * Command-to-guide relationships are derived from guide frontmatter alone; no
 * command registers its own guide list. `path` accepts a canonical Cliffy
 * path such as "linear issue update". A guide relates when it names that
 * command exactly or names a command underneath it, so a domain path
 * aggregates its subtree without a second registry. The root path returns
 * nothing: root navigation already points at `linear guide`.
 */
export function guidesForCommandPath(path: string): GuideMetadata[] {
  const normalized = path.replace(/^linear ?/, "")
  if (normalized === "") return []
  return guides
    .filter((guide) =>
      guide.metadata.commands.some((command) =>
        command === normalized || command.startsWith(`${normalized} `)
      )
    )
    .map((guide) => guide.metadata)
}

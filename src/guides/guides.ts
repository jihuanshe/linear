import { guideSources } from "./content.ts"

/**
 * Guide frontmatter is the single owner of guide identity and of
 * command-to-guide relationships; command registration never maintains a
 * second registry (design: docs/agent-interface-architecture.md, "元数据").
 * The parser below accepts exactly the schema these first-party guides use —
 * scalar `name`/`title`/`description` plus list `keywords`/`commands`/
 * `seeAlso` — and fails loudly on anything else instead of pulling a YAML
 * dependency into the binary for a corpus this repository controls.
 */
export interface GuideMetadata {
  name: string
  title: string
  description: string
  keywords: string[]
  commands: string[]
  seeAlso: string[]
}

export interface Guide {
  metadata: GuideMetadata
  /** Markdown body with the frontmatter block removed. */
  body: string
}

const SCALAR_KEYS = ["name", "title", "description"] as const
const LIST_KEYS = ["keywords", "commands", "seeAlso"] as const

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
      title: scalars.title as string,
      description: scalars.description as string,
      keywords: lists.keywords as string[],
      commands: lists.commands as string[],
      seeAlso: lists.seeAlso as string[],
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

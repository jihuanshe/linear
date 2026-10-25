import { unified } from "unified"
import remarkParse from "remark-parse"
import remarkGfm from "remark-gfm"
import { visit } from "unist-util-visit"

const parser = unified().use(remarkParse).use(remarkGfm)

/** Percent-encode non-ASCII URL text the way Linear stores link targets. */
function encodeNonAscii(url: string): string {
  try {
    return url.replace(/\P{ASCII}+/gu, (text) => encodeURI(text))
  } catch {
    // Unpaired Unicode surrogates remain literal URL content.
    return url
  }
}

const BARE_DOMAIN = /^(?:[a-z0-9-]+\.)+[a-z]{2,}(?:[/?#]\S*)?$/i

/**
 * Linear links bare domains on save: `notes.example.com` reads back as
 * `[notes.example.com](<http://notes.example.com>)`. Only a read-back link
 * whose sole text is a dotted host name (optionally with a path) and whose
 * target is that text behind `http://` can stand for that text.
 */
function autoLinkText(node: MdNode): string | undefined {
  if (node.type !== "link" || node.title != null) return undefined
  if (typeof node.url !== "string" || !node.url.startsWith("http://")) {
    return undefined
  }
  const [text, ...rest] = node.children ?? []
  return rest.length === 0 && text?.type === "text" &&
      typeof text.value === "string" && BARE_DOMAIN.test(text.value) &&
      encodeNonAscii(node.url.slice(7)) === encodeNonAscii(text.value)
    ? text.value
    : undefined
}

interface MdNode {
  type: string
  children?: MdNode[]
  [key: string]: unknown
}

/** Text as one token per character; other nodes stay whole. */
function tokens(children: MdNode[]): (string | MdNode)[] {
  return children.flatMap((child): (string | MdNode)[] =>
    child.type === "text" && typeof child.value === "string"
      ? [...child.value]
      : [child]
  )
}

/**
 * The written text must hold the whole domain or URL, not part of a longer
 * one: `notes.[example.com](http://example.com)` is not an auto-link of
 * `notes.example.com`, nor is a link that stops before `?tab=history`.
 */
function bareTextBoundary(
  w: (string | MdNode)[],
  start: number,
  length: number,
): boolean {
  const before = w[start - 1]
  const after = w[start + length]
  const next = w[start + length + 1]
  if (typeof before === "string" && /[\w.@/:-]/.test(before)) return false
  if (typeof after !== "string") return true
  if (/[\w/@-]/.test(after)) return false
  // A query, fragment, port or further label continues the URL.
  if (next == null) return true
  if (typeof next !== "string") return !/[?#:]/.test(after)
  if (after === "?" || after === "#") return !/\S/.test(next)
  if (after === ":") return !/\d/.test(next)
  return !(after === "." && /[\w%]/.test(next))
}

/**
 * Structural equality where a read-back auto-link may stand for the same
 * bare text in the written Markdown. A link written explicitly must still
 * read back as a link, so a lost link stays different.
 */
function sameNode(written: MdNode, actual: MdNode): boolean {
  const { children: writtenChildren, ...writtenProps } = written
  const { children: actualChildren, ...actualProps } = actual
  if (JSON.stringify(writtenProps) !== JSON.stringify(actualProps)) {
    return false
  }
  if (writtenChildren == null || actualChildren == null) {
    return writtenChildren == null && actualChildren == null
  }
  const w = tokens(writtenChildren)
  const a = tokens(actualChildren)
  let i = 0
  let j = 0
  while (i < w.length && j < a.length) {
    const left = w[i]
    const right = a[j]
    if (typeof right === "string") {
      if (left !== right) return false
      i++
      j++
      continue
    }
    if (typeof left !== "string" && sameNode(left, right)) {
      i++
      j++
      continue
    }
    const text = autoLinkText(right)
    const chars = text == null ? [] : [...text]
    if (
      text == null || chars.some((char, offset) => w[i + offset] !== char) ||
      !bareTextBoundary(w, i, chars.length)
    ) return false
    i += chars.length
    j++
  }
  return i === w.length && j === a.length
}

function comparableMarkdown(markdown: string): MdNode {
  const tree = parser.parse(markdown)
  visit(tree, (node) => {
    delete node.position
    // Linear joins adjacent unordered lists split by different bullet markers.
    // Merge parsed siblings, not source text: rewriting '* ---' as '- ---'
    // would turn a list item into a top-level thematic break.
    if ("children" in node) {
      for (let index = 1; index < node.children.length;) {
        const previous = node.children[index - 1]
        const current = node.children[index]
        if (
          previous.type === "list" && !previous.ordered &&
          current.type === "list" && !current.ordered
        ) {
          previous.children.push(...current.children)
          previous.spread ||= current.spread
          node.children.splice(index, 1)
        } else {
          index++
        }
      }
    }
    if (
      node.type === "link" || node.type === "image" ||
      node.type === "definition"
    ) {
      node.url = encodeNonAscii(node.url)
    }
    // Linear rewrites blank separators between single-paragraph list items.
    if (
      node.type === "list" &&
      node.children.every((item) =>
        item.children.length === 1 && item.children[0].type === "paragraph"
      )
    ) {
      node.spread = false
      for (const item of node.children) item.spread = false
    }
  })
  return tree as unknown as MdNode
}

/**
 * How Markdown read back after a write matches what was sent: `exact` bytes,
 * `normalized` when it differs only by the rewrites Linear applies on save
 * (bullet markers, `(<url>)` link destinations, percent-encoded URLs, blank
 * lines between list items, trailing whitespace and auto-linked bare
 * domains), or `different`. Original-value guards stay exact.
 */
export function compareMarkdown(
  expected: string,
  actual: string,
): "exact" | "normalized" | "different" {
  if (expected === actual) return "exact"
  return sameNode(comparableMarkdown(expected), comparableMarkdown(actual))
    ? "normalized"
    : "different"
}

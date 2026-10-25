/**
 * How Linear rewrites the issue descriptions it stores. Comment bodies are
 * stored verbatim (observed on Kadoraba).
 *
 * Only rewrites observed on Kadoraba are modeled; each rule names its
 * observation. Text the rules do not cover is stored unchanged, so a live case
 * exercising new Markdown may still find the fake drifting.
 */

/** Observed: "\uFEFF \r\nAlpha  \r\n\tBeta\n \t" is stored as "Alpha  \n\tBeta". */
function trimWhitespace(text: string): string {
  return text
    .replace(/^\uFEFF/, "")
    .replace(/\r\n?/g, "\n")
    .replace(/^(?:[ \t]*\n)+/, "")
    .replace(/\s+$/, "")
}

/** Observed: "(https://example.com/反馈)" is stored as "(<https://example.com/%E5%8F%8D%E9%A6%88>)". */
function rewriteLinks(line: string): string {
  return line.replace(/\]\(([^)<>\s]+)\)/g, (_, url: string) => {
    const encoded = url.replace(
      /[^\p{ASCII}]/gu,
      (char) => encodeURIComponent(char),
    )
    return `](<${encoded}>)`
  })
}

const BARE_HOST =
  /(^|\s)((?:[a-z0-9-]+\.)+(?:com|cn|net|org|io))(?=$|[\s,;:!?)]|\.(?:$|\s))/g
const LINK_OR_AUTOLINK = /^(?:!?\[[^\]]*\]\([^)]*\)|<[^>\s]*>)/

/** Split text into prose and protected ranges: code spans and links. */
function proseRanges(text: string): { prose: boolean; text: string }[] {
  const parts: { prose: boolean; text: string }[] = []
  let prose = ""
  let index = 0
  const protect = (end: number) => {
    if (prose) parts.push({ prose: true, text: prose })
    parts.push({ prose: false, text: text.slice(index, end) })
    prose = ""
    index = end
  }
  while (index < text.length) {
    if (text[index] === "`") {
      const run = /^`+/.exec(text.slice(index))![0]
      // A code span closes at the next backtick run of the same length.
      const closing = new RegExp(`(?<!\`)${run}(?!\`)`, "g")
      closing.lastIndex = index + run.length
      const close = closing.exec(text)
      if (close != null) {
        protect(close.index + run.length)
        continue
      }
      prose += run
      index += run.length
      continue
    }
    const link = LINK_OR_AUTOLINK.exec(text.slice(index))
    if (link != null) {
      protect(index + link[0].length)
      continue
    }
    prose += text[index]
    index++
  }
  if (prose) parts.push({ prose: true, text: prose })
  return parts
}

/**
 * Observed (jihuanshe workspace): a bare "notes.jihuanshe.com" is stored as
 * "[notes.jihuanshe.com](<http://notes.jihuanshe.com>)". Modeled only for
 * whitespace-delimited host names on a few common top-level domains in prose:
 * indented code lines, code spans (also across lines) and existing links stay
 * unchanged.
 */
function linkBareDomains(lines: string[]): string[] {
  const code = lines.map((line) => /^(?: {4}|\t)/.test(line))
  const text = lines.map((line, i) => code[i] ? "" : line).join("\n")
  const linked = proseRanges(text).map((part) =>
    part.prose
      ? part.text.replace(
        BARE_HOST,
        (_, before: string, host: string) =>
          `${before}[${host}](<http://${host}>)`,
      )
      : part.text
  ).join("").split("\n")
  return lines.map((line, i) => code[i] ? line : linked[i])
}

const BULLET = /^(\s*)([-+*]) (.*)$/

/**
 * Observed: "- a\n\n+ b" (two lists, since the marker changes) is stored as
 * "* a\n\n\n* b": bullets become "*", and adjacent lists stay apart by an
 * extra blank line.
 */
function rewriteLists(lines: string[]): string[] {
  const out: string[] = []
  let lastMarker: string | undefined
  for (const line of lines) {
    const bullet = BULLET.exec(line)
    if (bullet == null) {
      if (line.trim() !== "") lastMarker = undefined
      out.push(line)
      continue
    }
    const [, indent, marker, rest] = bullet
    if (indent === "" && lastMarker != null && marker !== lastMarker) {
      while (out.length > 0 && out.at(-1)!.trim() === "") out.pop()
      out.push("", "")
    }
    if (indent === "") lastMarker = marker
    out.push(`${indent}* ${rest}`)
  }
  return out
}

export function normalizeLinearMarkdown(text: string): string {
  const lines = trimWhitespace(text).split("\n")
  const out: string[] = []
  let block: string[] = []
  let fenced = false
  const flush = () => {
    out.push(...linkBareDomains(rewriteLists(block).map(rewriteLinks)))
    block = []
  }
  for (const line of lines) {
    if (/^\s*(```|~~~)/.test(line)) {
      if (!fenced) flush()
      fenced = !fenced
      out.push(line)
      continue
    }
    if (fenced) out.push(line)
    else block.push(line)
  }
  flush()
  return out.join("\n")
}

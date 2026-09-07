/** Shared API Markdown guidance for commands that submit rich bodies. */
export function withMarkdownHint(description: string): string {
  return `${description}\n\nFor API Markdown bodies, use a bare Linear URL to create a mention, not
\`@name\`, \`@[Name](id)\`, or \`[Name](url)\`. Get a person's canonical \`url\` from
\`linear team members <TEAM> --json\` or \`linear user list --json\`.
Run \`linear guide markdown\` for mentions and collapsible sections.`
}

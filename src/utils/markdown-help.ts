/** Shared API Markdown guidance for commands that submit rich bodies. */
export function withMarkdownHint(description: string): string {
  return `${description}\n\nFor API Markdown bodies, prefer a bare Linear URL for mentions.
Named profile links can also mention people; \`@name\` handling varies by body.
Get a person's canonical \`url\` from
\`linear team members <TEAM> --json\` or \`linear user list --json\`.
Run \`linear guide markdown\` for mentions, collapsible sections and rewrite risks.`
}

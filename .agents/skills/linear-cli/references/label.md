# label

> Manage Linear issue labels

## Usage

```
Usage:   linear label

Description:

  Manage Linear issue labels

Options:

  -h, --help           - Show this help.
  --workspace  <slug>  - Target workspace (uses credentials)

Commands:

  list                - List issue labels
  create              - Create a new issue label
  delete  <nameOrId>  - Delete an issue label
  usage               - Show usage for linear label
```

## Subcommands

### create

> Create a new issue label

```
Usage:   linear label create

Writes: true
Interactive: true

Description:

  Create a new issue label

Options:

  -h, --help                        - Show this help.
  --workspace        <slug>         - Target workspace (uses credentials)
  -n, --name         <name>         - Label name (required)
  -c, --color        <color>        - Color hex code (e.g., #EB5757)
  -d, --description  <description>  - Label description
  -t, --team         <teamKey>      - Team key for team-specific label (omit for workspace label)
  -i, --interactive                 - Interactive mode (default if no flags provided)
```

### delete

> Delete an issue label

```
Usage:   linear label delete <nameOrId>

Writes: true
Interactive: true
Confirmation required unless: --force

Description:

  Delete an issue label

Options:

  -h, --help              - Show this help.
  --workspace  <slug>     - Target workspace (uses credentials)
  -t, --team   <teamKey>  - Team key to disambiguate labels with same name
  -f, --force             - Skip confirmation prompt
```

### list

> List issue labels

```
Usage:   linear label list

Description:

  List issue labels

Options:

  -h, --help                     - Show this help.
  --workspace         <slug>     - Target workspace (uses credentials)
  --team              <teamKey>  - Show labels available to a team, including workspace-level labels
  --workspace-labels             - Show only workspace-level labels (not team-specific)
  --all                          - Show all labels (both workspace and team)
  -j, --json                     - Output as JSON
```

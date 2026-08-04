# initiative-update

> Manage initiative status updates (timeline posts)

## Usage

```
Usage:   linear initiative-update

Description:

  Manage initiative status updates (timeline posts)

Options:

  -h, --help           - Show this help.
  --workspace  <slug>  - Target workspace (uses credentials)

Commands:

  create, c    <initiativeId>  - Create a new status update for an initiative
  list, l, ls  <initiativeId>  - List status updates for an initiative
  usage                        - Show usage for linear initiative-update
```

## Subcommands

### create

> Create a new status update for an initiative

```
Usage:   linear initiative-update create <initiativeId>

Writes: true
Interactive: true

Description:

  Create a new status update for an initiative

Options:

  -h, --help                   - Show this help.
  --workspace        <slug>    - Target workspace (uses credentials)
  --body             <body>    - Update content (markdown)
  --body-file        <path>    - Read content from file
  --health           <health>  - Health status (onTrack, atRisk, offTrack)
  -i, --interactive            - Interactive mode with prompts
```

### list

> List status updates for an initiative

```
Usage:   linear initiative-update list <initiativeId>

Description:

  List status updates for an initiative

Options:

  -h, --help            - Show this help.
  --workspace  <slug>   - Target workspace (uses credentials)
  -j, --json            - Output as JSON
  --limit      <limit>  - Maximum results (positive integer)   (Default: 10)
```

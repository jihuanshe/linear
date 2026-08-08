# auth

> Manage Linear authentication

## Usage

```
Usage:   linear auth

Description:

  Manage Linear authentication

Options:

  -h, --help           - Show this help.
  --workspace  <slug>  - Target workspace (uses credentials)

Commands:

  login                 - Add a workspace credential
  logout   [workspace]  - Remove a workspace credential
  list                  - List configured workspaces
  default  [workspace]  - Set the default workspace
  token                 - Print the configured API token
  whoami                - Print information about the authenticated user
  migrate               - Migrate plaintext credentials to system keyring
  usage                 - Show usage for linear auth
```

## Subcommands

### default

> Set the default workspace

```
Usage:   linear auth default [workspace]

Writes: true
Interactive: true
Related guides: core

Description:

  Set the default workspace

Options:

  -h, --help           - Show this help.
  --workspace  <slug>  - Target workspace (uses credentials)
```

### list

> List configured workspaces

```
Usage:   linear auth list

Description:

  List configured workspaces

Options:

  -h, --help           - Show this help.
  --workspace  <slug>  - Target workspace (uses credentials)
```

### login

> Add a workspace credential

```
Usage:   linear auth login

Writes: true
Interactive: true
Related guides: core

Description:

  Add a workspace credential

Options:

  -h, --help           - Show this help.
  --workspace  <slug>  - Target workspace (uses credentials)
  -k, --key    <key>   - API key (prompted if not provided)
  --plaintext          - Store API key in credentials file instead of system keyring
```

### logout

> Remove a workspace credential

```
Usage:   linear auth logout [workspace]

Writes: true
Interactive: true
Confirmation required unless: --force

Description:

  Remove a workspace credential

Options:

  -h, --help           - Show this help.
  --workspace  <slug>  - Target workspace (uses credentials)
  -f, --force          - Skip confirmation prompt
```

### migrate

> Migrate plaintext credentials to system keyring

```
Usage:   linear auth migrate

Writes: true

Description:

  Migrate plaintext credentials to system keyring

Options:

  -h, --help           - Show this help.
  --workspace  <slug>  - Target workspace (uses credentials)
```

### token

> Print the configured API token

```
Usage:   linear auth token

Related guides: graphql

Description:

  Print the configured API token

Options:

  -h, --help           - Show this help.
  --workspace  <slug>  - Target workspace (uses credentials)
```

### whoami

> Print information about the authenticated user

```
Usage:   linear auth whoami

Related guides: core

Description:

  Print information about the authenticated user

Options:

  -h, --help           - Show this help.
  --workspace  <slug>  - Target workspace (uses credentials)
  -j, --json           - Output as JSON
```

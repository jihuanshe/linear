# Deno permission policy and change procedure

This CLI uses `--allow-all` for simplicity. Linear issues can contain images and attachments from arbitrary external domains, making fine-grained `--allow-net` restrictions impractical.

## Permission surfaces

| Surface                           | Purpose                                                 |
| --------------------------------- | ------------------------------------------------------- |
| `deno.json`                       | Development, installation, test, and codegen tasks      |
| `.agents/resume`                  | Checkout-local `linear` source wrapper                  |
| `.github/workflows/ship-main.yml` | Release compilation                                     |
| `test/`                           | Child Deno processes used by command and snapshot tests |

Before changing permissions, locate every active flag instead of relying only on this table:

```bash
rg -n --glob '!deno.lock' -- '--allow-|--deny-' \
  deno.json .agents .github test
```

Update every entry point that executes the affected code path, then run `deno task verify-source`.

## Why `--allow-all`?

The CLI needs network access to download attachments and images from Linear comments. Since these can be hosted on any domain (e.g., user-uploaded images, external file hosts), maintaining an allow-list is not feasible.

The CLI also requires:

- File system access for config and temp files
- Environment variables for API keys and editor settings
- Subprocess execution for git, editors, and pagers
- System info for hostname

Using `--allow-all` avoids permission errors when Linear content references external resources.

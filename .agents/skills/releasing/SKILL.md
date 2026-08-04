---
name: releasing
description: Verifies and ships the current main branch through the repository's rolling GitHub Release workflow. Use when asked to release, publish, or ship this CLI.
---

# Main Release

Use this procedure only after the user explicitly asks to ship, publish, or release the CLI.

## Release contract

- Keep `deno.json` at `0.0.0-dev` in source control.
- `.github/workflows/ship-main.yml` derives `0.0.<commit timestamp>-g<short commit>` from the pushed commit.
- A successful `main` push creates the tag and GitHub Release automatically.
- Do not manually bump versions, create release tags, or push tags.
- Do not create npm, JSR, Homebrew, or cargo-dist releases.

## Prepare

1. Confirm the checkout is `main`, `origin` is `https://github.com/jihuanshe/linear`, and all intended changes are understood.
2. Update `CHANGELOG.md` only when the cumulative downstream summary changed. Do not add an entry for each rolling build.
3. Check the effective commit identity before the first commit:

   ```bash
   git config --show-origin --get user.name
   git config --show-origin --get user.email
   ```

4. Commit every intended change. Keep unrelated concerns in separate commits.
5. Fetch `origin/main`. Rebase when it is ahead; stop and ask the user before resolving substantive conflicts.
6. Run the complete local release gate against the final commit:

   ```bash
   deno task verify-release
   ```

   If it updates generated Skill files, commit them and rerun `deno task verify-release`. Do not push until it passes with a clean worktree.

## Push

Push `main`, then wait for the exact run created by that push:

```bash
sha="$(git rev-parse HEAD)"
git push origin main
run_id=""
for _ in {1..12}; do
  run_id="$(
    gh run list --workflow ship-main.yml --branch main --limit 20 \
      --json databaseId,headSha \
      --jq ".[] | select(.headSha == \"$sha\") | .databaseId" | head -n 1
  )"
  [[ -n "$run_id" ]] && break
  sleep 5
done
test -n "$run_id"
gh run watch "$run_id" --exit-status
```

If the push is rejected because `origin/main` advanced, fetch, rebase, rerun `deno task verify-release`, and push again. Ask before resolving substantive conflicts.

## CI release workflow

`Ship main` runs these stages:

1. In parallel, run the Linux Keyring integration test and build all five targets.
2. For each target, produce one install archive, one standalone self-update binary, and their SHA-256 sidecars.
3. Merge the artifacts; require 10 distributables and 10 checksum sidecars; generate `sha256.sum`.
4. Create or resume a draft Release, attest the binary assets, then publish it as latest.

The Release job must not run unless Keyring integration and every target build succeed.

## Post-release validation

Derive the expected version from the pushed commit and inspect that exact Release:

```bash
timestamp="$(git show -s --format=%ct HEAD)"
version="0.0.${timestamp}-g$(git rev-parse HEAD | cut -c1-7)"
gh release view "$version" \
  --json tagName,targetCommitish,isDraft,isPrerelease,url,assets
test "$(gh api repos/jihuanshe/linear/releases/latest --jq .tag_name)" = "$version"
```

Require the Release to target the pushed commit, be published, non-prerelease, and latest. It must contain 21 files: 10 distributables, 10 checksum sidecars, and `sha256.sum`.

When mise is available, verify that the public installation resolves to the expected version:

```bash
actual="$(mise x "github:jihuanshe/linear[minimum_release_age=0s]@latest" -- linear --version)"
test "$actual" = "linear $version"
```

`minimum_release_age=0s` bypasses mise's default 24-hour release age for this tool only.

## Failure handling

- A failed local source check, CI keyring integration check, or build must not produce a published Release. Fix forward with a new `main` commit.
- A canceled stale run may leave an invisible draft. Do not rerun it after `main` advances; clean it up later if needed.
- `concurrency.cancel-in-progress` keeps only the newest overlapping `main` run active. Completed historical Releases remain immutable and downloadable.
- If GitHub rejects write permissions, attestations, or Release creation, report the repository setting that blocked it instead of switching to a personal token or private runner.

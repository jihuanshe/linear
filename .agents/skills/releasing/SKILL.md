---
name: releasing
description: Verifies and publishes the current main branch through the repository's rolling GitHub Release workflow. Use when asked to release, publish, or ship this CLI.
---

# Main Release

Use this procedure only after the user explicitly asks to ship, publish, or release the CLI.

## Release contract

- Keep `deno.json` at `0.0.0-dev` in source control.
- `.github/workflows/ship-main.yml` derives `0.0.<commit timestamp>-g<short commit>` from the pushed commit.
- Each `main` update enters a serialized release queue. A successful run creates the tag and GitHub Release automatically.
- Release runs do not cancel one already in progress, and the queue retains up to 100 waiting runs.
- Do not manually bump versions, create release tags, or push tags.
- Do not create npm, JSR, Homebrew, or cargo-dist releases.

## Prepare

1. Confirm the checkout is `main`, `origin` is `https://github.com/jihuanshe/linear`, and all intended changes are understood.
2. Check the effective commit identity before the first commit:

   ```bash
   git config --show-origin --get user.name
   git config --show-origin --get user.email
   ```

3. Commit every intended change. Keep unrelated concerns in separate commits.
4. Fetch `origin/main`. Rebase when it is ahead; stop and ask the user before resolving substantive conflicts.
5. Run the complete local release gate against the final commit:

   ```bash
   deno task verify-release
   ```

   Do not push until it passes with a clean worktree.

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

`Publish Linear CLI rolling release` runs these stages:

1. In parallel, run the Linux Keyring integration test and build all five targets.
2. For each target, produce one install archive, one standalone self-update binary, and their SHA-256 sidecars.
3. Merge the artifacts; require 10 distributables and 10 checksum sidecars; generate `sha256.sum`.
4. Create or resume a draft Release, attest the binary assets, then publish it. Mark it latest only while its commit is still the current `main` head, so an older queued run cannot move latest backward.
5. After the GitHub Release succeeds, record one completed Linear Release from the exact `before..HEAD` push range, and require its ID and URL to be non-empty and its version to match the GitHub Release version.

The GitHub Release job must not run unless Keyring integration and every target build succeed. The Linear Release job must not run unless the GitHub Release job succeeds.

## Post-release validation

Derive the expected version from the pushed commit and inspect that exact Release:

```bash
timestamp="$(git show -s --format=%ct HEAD)"
version="0.0.${timestamp}-g$(git rev-parse HEAD | cut -c1-7)"
gh release view "$version" \
  --json tagName,targetCommitish,isDraft,isPrerelease,url,assets
git fetch origin main
if [[ "$(git rev-parse origin/main)" == "$(git rev-parse HEAD)" ]]; then
  test "$(gh api repos/jihuanshe/linear/releases/latest --jq .tag_name)" = "$version"
fi
```

Require the Release to target the pushed commit, be published, and be non-prerelease. If the pushed commit is still current `main`, also require it to be latest. It must contain 21 files: 10 distributables, 10 checksum sidecars, and `sha256.sum`.

When mise is available, verify that the public installation resolves to the expected version:

```bash
actual="$(mise x "github:jihuanshe/linear[minimum_release_age=0s]@$version" -- linear --version)"
test "$actual" = "linear $version"
```

`minimum_release_age=0s` bypasses mise's default 24-hour release age for this tool only.

## Failure handling

- A failed local source check, CI keyring integration check, or build must not produce a published Release. Fix forward with a new `main` commit.
- A canceled run is not a published release and may leave an invisible draft. Do not rerun it after `main` advances; clean it up later if needed.
- The fixed concurrency group serializes release runs and retains up to 100 pending `main` updates. Completed historical Releases remain immutable and downloadable.
- If GitHub rejects write permissions, attestations, or Release creation, report the repository setting that blocked it instead of switching to a personal token or private runner.

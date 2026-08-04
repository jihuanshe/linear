---
name: releasing
description: Verifies and ships the current main branch through the repository's rolling GitHub Release workflow. Use when asked to release, publish, or ship this CLI.
---

# Release Workflow

Ship the current `main` commit. This repository does not manually bump CLI versions or push release tags.

## Contract

- Keep `deno.json` at `0.0.0-dev` in source control.
- `.github/workflows/ship-main.yml` derives `0.0.<commit timestamp>-g<short commit>` from the pushed commit.
- A successful `main` push creates the tag and GitHub Release automatically.
- Do not manually bump versions, create release tags, or push tags.
- Do not create npm, JSR, Homebrew, or cargo-dist releases.

## Before Push

1. Confirm the checkout is on `main`, the remote is `jihuanshe/linear`, and inspect all committed and uncommitted changes.
2. Fetch `origin/main`. If it is ahead, rebase before pushing; stop for substantive conflicts.
3. Keep the downstream change summary in `CHANGELOG.md` accurate. Do not create a numbered changelog entry for every rolling build.
4. Run the local release gate:

   ```bash
   deno task verify
   ```

5. Commit every intended change using the repository's effective Git identity. Split unrelated concerns into reviewable commits.

## Push And Verify

Push only when the user has explicitly asked to ship or release:

```bash
git push origin main
```

Then inspect the `Ship main` workflow:

```bash
gh run list --workflow ship-main.yml --branch main --limit 1
gh run watch <run-id> --exit-status
```

After it succeeds, verify the release points to the pushed commit and exposes all five platform archives plus checksums:

```bash
gh release view --json tagName,targetCommitish,isDraft,isPrerelease,url,assets
```

The release must be published, non-prerelease, and marked latest. Test the public installation path when mise is available:

```bash
mise x "github:jihuanshe/linear[minimum_release_age=0s]@latest" -- linear --version
```

The tool-scoped `minimum_release_age=0s` is required because mise otherwise hides GitHub releases for 24 hours, which conflicts with immediate rolling `main` releases.

## Failure Handling

- A failed source check or build must not produce a published Release. Fix forward with a new `main` commit.
- A canceled stale run may leave an invisible draft. Do not rerun it after `main` advances; clean it up later if needed.
- `concurrency.cancel-in-progress` keeps only the newest overlapping `main` run active. Completed historical Releases remain immutable and downloadable.
- If GitHub rejects write permissions, attestations, or Release creation, report the repository setting that blocked it instead of switching to a personal token or private runner.

#!/bin/sh
set -eu
if [ "$#" -ne 3 ]; then
  echo "Usage: sh recipes/github-autolink.sh OWNER/REPO TEAM_KEY WORKSPACE_URL_KEY" >&2
  exit 2
fi
repo=$1
team=$2
workspace=$3
case "$team" in ''|*[!A-Z0-9]*) echo "TEAM_KEY must contain uppercase letters or digits" >&2; exit 2;; esac
case "$workspace" in ''|*[!a-zA-Z0-9_-]*) echo "Invalid workspace URL key" >&2; exit 2;; esac
printf 'Adding %s- autolink in %s for workspace %s\n' "$team" "$repo" "$workspace" >&2
exec gh api --method POST "repos/$repo/autolinks" -f "key_prefix=$team-" -f "url_template=https://linear.app/$workspace/issue/$team-<num>"

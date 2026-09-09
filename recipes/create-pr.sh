#!/bin/sh
set -eu
if [ "$#" -lt 3 ]; then
  echo "Usage: sh recipes/create-pr.sh ISSUE OWNER/REPO BODY_FILE [gh pr create options...]" >&2
  exit 2
fi
issue=$1
repo=$2
body_file=$3
shift 3
[ -f "$body_file" ] || { echo "Body file does not exist: $body_file" >&2; exit 2; }
linear_bin=${LINEAR_BIN:-linear}
title=$("$linear_bin" issue title "$issue")
url=$("$linear_bin" issue url "$issue")
printf 'Issue: %s\nCreating PR in %s with body file %s\n' "$url" "$repo" "$body_file" >&2
exec gh pr create --repo "$repo" --title "$issue $title" --body-file "$body_file" "$@"

#!/usr/bin/env bash

# Usage: bash install.sh [--strict] [--min-version 0.0.<timestamp>-g<commit>]
# LINEAR_MIN_VERSION can raise the built-in minimum. Default failures warn and
# return 0 so optional Orb tools do not interrupt the rest of setup.

export LC_ALL=C
exec 3>&2
strict=0
stage=arguments
work=''
staging=''
profile_work=''
profile=''
lock=''
profile_changed=0
binary_changed=0
profile_previous=0
binary_previous=0
committed=0
for argument in "$@"; do
  [[ "$argument" != --strict ]] || strict=1
done

rollback() {
  ((committed == 0)) || return 0
  if ((binary_changed)); then
    if ((binary_previous)); then
      if [[ ! "$HOME/.local/bin/linear" -ef "$staging/previous" ]]; then
        mv -f "$staging/previous" "$HOME/.local/bin/linear" || return 1
      fi
    else
      rm -f "$HOME/.local/bin/linear" || return 1
    fi
    binary_changed=0
  fi
  if ((profile_changed)); then
    if ((profile_previous)); then
      if [[ ! "$profile" -ef "$profile_work/previous" ]]; then
        mv -f "$profile_work/previous" "$profile" || return 1
      fi
    else
      rm -f "$profile" || return 1
    fi
    profile_changed=0
  fi
}

cleanup() {
  # Keep recovery files and the lock if restoring either destination fails.
  rollback || return 1
  [[ -z "$work" ]] || rm -rf "$work"
  [[ -z "$staging" ]] || rm -rf "$staging"
  [[ -z "$profile_work" ]] || rm -rf "$profile_work"
  [[ -z "$lock" ]] || rmdir "$lock"
}

fail() {
  trap '' HUP INT TERM
  ((committed == 0)) || exit 0
  rollback >/dev/null 2>&1 || stage=rollback
  printf 'WARN: Linear CLI %s failed; continuing setup\n' "$stage" >&3
  exit "$strict"
}

trap 'cleanup >/dev/null 2>&1' EXIT
trap fail HUP INT TERM

valid_version() {
  [[ "$1" =~ ^0\.0\.(0|[1-9][0-9]*)-g[0-9a-f]{7}$ ]]
}

at_least() {
  local actual="${1#0.0.}" required="${2#0.0.}"
  actual="${actual%-g*}"
  required="${required%-g*}"
  if ((${#actual} != ${#required})); then
    ((${#actual} > ${#required}))
  else
    [[ "$actual" > "$required" || ( "$actual" == "$required" && ! "$1" < "$2" ) ]]
  fi
}

download() {
  curl -q --fail --silent --show-error --location \
    --proto '=https' --proto-redir '=https' \
    --connect-timeout 10 --max-time 120 \
    --retry 2 --retry-delay 1 --retry-max-time 180 "$@"
}

install_linear() {
  local floor=0.0.1794558300-g5800a29
  local minimum="${LINEAR_MIN_VERSION-$floor}"
  while (($#)); do
    case "$1" in
      --strict) ;;
      --min-version)
        (($# >= 2)) || return 1
        minimum="$2"
        shift
        ;;
      *) return 1 ;;
    esac
    shift
  done
  valid_version "$minimum" && at_least "$minimum" "$floor" || return 1
  [[ -n "${HOME-}" && -d "$HOME" ]] || return 1

  stage=platform
  local platform target
  platform="$(uname -s):$(uname -m)" || return 1
  case "$platform" in
    Linux:x86_64) target=x86_64-unknown-linux-gnu ;;
    Linux:aarch64|Linux:arm64) target=aarch64-unknown-linux-gnu ;;
    Darwin:arm64) target=aarch64-apple-darwin ;;
    *) return 1 ;;
  esac

  stage=latest
  local base=https://github.com/jihuanshe/linear/releases url tag asset
  url="$(download --output /dev/null --write-out '%{url_effective}' "$base/latest")" || return 1
  [[ "$url" == "$base/tag/"* ]] || return 1
  tag="${url#"$base/tag/"}"
  valid_version "$tag" || return 1
  stage=minimum-version
  at_least "$tag" "$minimum" || return 1
  asset="linear-$target.tar.xz"
  work="$(mktemp -d)" || return 1

  stage=archive-download
  download --output "$work/$asset" "$base/download/$tag/$asset" || return 1
  stage=checksum-download
  download --output "$work/checksum" "$base/download/$tag/$asset.sha256" || return 1
  stage=checksum
  local digest actual
  digest="$(awk -v asset="$asset" '
    NR != 1 || length($1) != 64 || $1 ~ /[^0-9a-fA-F]/ ||
      substr($0, 65, 2) !~ /^ [ *]$/ || substr($0, 67) != asset { exit 1 }
    { print $1 }
    END { if (NR != 1) exit 1 }
  ' "$work/checksum")" || return 1
  if command -v sha256sum >/dev/null; then
    actual="$(sha256sum "$work/$asset")" || return 1
  else
    actual="$(shasum -a 256 "$work/$asset")" || return 1
  fi
  actual="${actual%% *}"
  [[ "$(printf '%s' "$digest" | tr A-F a-f)" == "$actual" ]] || return 1

  stage=unpack
  # Stream just the selected member into a regular file; archive paths,
  # permissions and links cannot choose the installation destination.
  tar -xJOf "$work/$asset" linear > "$work/linear" || return 1
  [[ -s "$work/linear" ]] || return 1
  chmod 0755 "$work/linear" || return 1
  stage=version
  actual="$("$work/linear" --version)" || return 1
  [[ "$actual" == "linear $tag" ]] || return 1

  stage=lock
  local bin="$HOME/.local/bin"
  mkdir -p "$bin" || return 1
  mkdir "$bin/.linear-install.lock" || return 1
  lock="$bin/.linear-install.lock"

  stage=path
  local candidate line
  profile="$HOME/.bash_profile"
  line='export PATH="$HOME/.local/bin:$PATH" # jihuanshe/linear install.sh'
  for candidate in .bash_profile .bash_login .profile; do
    if [[ -f "$HOME/$candidate" && -r "$HOME/$candidate" ]]; then
      profile="$HOME/$candidate"
      break
    fi
  done
  # Follow dotfile symlinks so managed dotfiles keep their existing ownership.
  local link hops=0
  while [[ -L "$profile" ]]; do
    ((hops++))
    ((hops <= 40)) || return 1
    link="$(readlink "$profile")" || return 1
    case "$link" in
      /*) profile="$link" ;;
      *) profile="${profile%/*}/$link" ;;
    esac
  done
  profile_work="$(mktemp -d "${profile%/*}/.linear-profile.XXXXXXXX")" || return 1
  if [[ -e "$profile" ]]; then
    ln "$profile" "$profile_work/previous" || return 1
    profile_previous=1
    cp -p "$profile" "$profile_work/next" || return 1
    awk -v line="$line" '$0 != line { print }' "$profile" > "$profile_work/next" || return 1
  else
    : > "$profile_work/next" || return 1
  fi
  printf '%s\n' "$line" >> "$profile_work/next" || return 1

  stage=publish
  [[ ! -d "$bin/linear" ]] || return 1
  staging="$(mktemp -d "$bin/.linear-install.XXXXXXXX")" || return 1
  cp "$work/linear" "$staging/linear" || return 1
  chmod 0755 "$staging/linear" || return 1
  if [[ -e "$bin/linear" || -L "$bin/linear" ]]; then
    ln "$bin/linear" "$staging/previous" || return 1
    binary_previous=1
  fi
  stage=path
  profile_changed=1
  mv -f "$profile_work/next" "$profile" || return 1
  stage=publish
  binary_changed=1
  mv -f "$staging/linear" "$bin/linear" || return 1

  stage=login
  local directory
  for directory in "$PWD" "$HOME"; do
    (cd "$directory" && "$BASH" -lc '
      [[ "$(command -v linear)" == "$HOME/.local/bin/linear" ]] &&
      [[ "$(linear --version)" == "linear $1" ]]
    ' linear-install "$tag") || return 1
  done
  committed=1
}

if install_linear "$@" >/dev/null 2>&1; then
  exit 0
fi
fail

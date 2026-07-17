#!/usr/bin/env bash
# sharp — synchronize versions, commit a changelog release, and create its tag.
#
#   scripts/release.sh minor --dry-run   # inspect v0.3.0 without changing files
#   scripts/release.sh patch             # create local release commit + tag
#   scripts/release.sh major --push      # create release, then push commit + tag
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

usage() {
  echo "usage: scripts/release.sh <major|minor|patch> [--dry-run] [--push]"
}

if [[ $# -lt 1 ]]; then
  usage
  exit 1
fi

BUMP="$1"
shift

case "$BUMP" in
  major|minor|patch) ;;
  *)
    echo "error: bump must be major, minor, or patch"
    usage
    exit 1
    ;;
esac

DRY_RUN=false
PUSH=false
while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run) DRY_RUN=true ;;
    --push) PUSH=true ;;
    *)
      echo "error: unknown option '$1'"
      usage
      exit 1
      ;;
  esac
  shift
done

if [[ "$DRY_RUN" == true && "$PUSH" == true ]]; then
  echo "error: --dry-run and --push cannot be used together"
  exit 1
fi

for bin in git perl sed; do
  command -v "$bin" >/dev/null || {
    echo "error: '$bin' is required (install it first)"
    exit 1
  }
done

CURRENT="$(sed -n 's/^  "version": "\([0-9][0-9]*\.[0-9][0-9]*\.[0-9][0-9]*\)",$/\1/p' web/package.json)"
if [[ -z "$CURRENT" ]]; then
  echo "error: could not read canonical version from web/package.json"
  exit 1
fi

OLD_IFS="$IFS"
IFS=.
set -- $CURRENT
IFS="$OLD_IFS"
MAJOR="$1"
MINOR="$2"
PATCH="$3"

case "$BUMP" in
  major)
    MAJOR=$((MAJOR + 1))
    MINOR=0
    PATCH=0
    ;;
  minor)
    MINOR=$((MINOR + 1))
    PATCH=0
    ;;
  patch)
    PATCH=$((PATCH + 1))
    ;;
esac

NEXT="$MAJOR.$MINOR.$PATCH"
CHANGELOG="web/src/content/changelog/$NEXT.md"

if [[ ! -f "$CHANGELOG" ]]; then
  echo "error: missing changelog entry $CHANGELOG"
  echo "follow docs/RELEASE.md to write release notes and choose a release name"
  exit 1
fi

NAME="$(sed -n 's/^name: \(.*\)$/\1/p' "$CHANGELOG" | sed -n '1p')"
if [[ -z "$NAME" ]]; then
  echo "error: missing 'name' in $CHANGELOG frontmatter"
  exit 1
fi

MANIFESTS=(
  web/package.json
  landing/package.json
  desktop/src-tauri/tauri.conf.json
  server/Cargo.toml
  desktop/src-tauri/Cargo.toml
)

echo "==> release plan"
echo "    version: $CURRENT -> $NEXT ($BUMP)"
echo "    name: $NAME"
echo "    changelog: $CHANGELOG"
echo "    manifests:"
for file in "${MANIFESTS[@]}"; do
  echo "      $file"
done
echo "    commit: chore(release): v$NEXT — $NAME"
echo "    tag: v$NEXT"
if [[ "$PUSH" == true ]]; then
  echo "    push: git push --follow-tags"
else
  echo "    push: no"
fi

if [[ "$DRY_RUN" == true ]]; then
  echo "==> dry run complete; no files changed"
  exit 0
fi

if ! git diff --cached --quiet; then
  echo "error: index already contains staged changes; unstage them before releasing"
  exit 1
fi

if git rev-parse "v$NEXT" >/dev/null 2>&1; then
  echo "error: tag v$NEXT already exists"
  exit 1
fi

echo "==> updating version manifests"
NEXT_VERSION="$NEXT" perl -0pi -e '
  s/^  "version": "[0-9]+\.[0-9]+\.[0-9]+",$/  "version": "$ENV{NEXT_VERSION}",/m
    or die "version field not found in JSON manifest\n"
' web/package.json landing/package.json desktop/src-tauri/tauri.conf.json

NEXT_VERSION="$NEXT" perl -0pi -e '
  s/\A(\[package\][\s\S]*?^version = )"[0-9]+\.[0-9]+\.[0-9]+"/$1"$ENV{NEXT_VERSION}"/m
    or die "top package version not found in Cargo manifest\n"
' server/Cargo.toml desktop/src-tauri/Cargo.toml

echo "==> staging release files"
git add -- "${MANIFESTS[@]}" "$CHANGELOG"

echo "==> creating release commit"
git commit -m "chore(release): v$NEXT — $NAME"

echo "==> tagging v$NEXT"
git tag "v$NEXT"

if [[ "$PUSH" == true ]]; then
  echo "==> pushing release commit and tag"
  git push --follow-tags
fi

echo "==> release v$NEXT complete"

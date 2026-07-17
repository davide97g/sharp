# Releasing sharp

Releases are prepared locally by an AI assistant and finalized by `scripts/release.sh`. The canonical current version is `web/package.json`. The script synchronizes every other manifest, creates the release commit, and tags it. CI publishes when a `v*` tag is pushed.

## Release names

Names evolve across a major line:

- **Major:** choose a new, fun noun codename, such as `Otter`.
- **Minor:** prepend one increasingly absurd adjective to the current name, such as `Otter` becoming `Turbo Otter`, then `Quantum Turbo Otter`.
- **Patch:** keep the current minor name and append a short suffix joke, such as `Turbo Otter (Now With Fewer Bugs)`.

Always read every existing `web/src/content/changelog/*.md` entry before choosing a name. A new major starts a new noun; a minor preserves the full existing name and prepends exactly one adjective; a patch preserves the name and adds one parenthesized joke.

## AI release workflow

1. Find the latest tag and inspect all changes since it:

   ```bash
   git describe --tags --abbrev=0
   git log "$(git describe --tags --abbrev=0)"..HEAD
   git log --oneline "$(git describe --tags --abbrev=0)"..HEAD
   ```

2. Read the full commit messages and diffs needed to understand user impact. Categorize conventional commits into `Added`, `Changed`, `Fixed`, and `Removed`. Write release notes for users, not raw commit subjects. Skip internal-only detail unless it affects operators.
3. Choose the bump:
   - `major` for incompatible changes or a new major product line.
   - `minor` for backward-compatible features.
   - `patch` for backward-compatible fixes only.
4. Read the current version from `web/package.json`, compute the next semantic version, and read all prior changelog names.
5. Create `web/src/content/changelog/<next-version>.md` with exactly this shape:

   ```markdown
   ---
   version: 0.3.0
   name: Quantum Turbo Otter
   date: 2026-07-17
   ---

   ### Added
   - User-facing description

   ### Fixed
   - User-facing description
   ```

   Use only relevant `Added`, `Changed`, `Fixed`, and `Removed` sections. Keep bullets concise and specific.
6. Validate without changing the tree:

   ```bash
   bash scripts/release.sh <major|minor|patch> --dry-run
   ```

7. Review the printed version, name, files, commit, and tag. Then cut the local release:

   ```bash
   bash scripts/release.sh <major|minor|patch>
   ```

   If pushing was explicitly requested, add `--push` to that release command instead:

   ```bash
   bash scripts/release.sh <major|minor|patch> --push
   ```

   `--push` creates the local release, then runs `git push --follow-tags`. Never use `--push` without user approval, and do not run both release commands.

The script stages only the five version manifests and the selected changelog entry. It never uses `git add -A`, so unrelated work remains unstaged.

## Version manifests

`scripts/release.sh` synchronizes these five fields:

- `web/package.json`
- `landing/package.json`
- `desktop/src-tauri/tauri.conf.json`
- top `[package]` version in `server/Cargo.toml`
- top `[package]` version in `desktop/src-tauri/Cargo.toml`

Example Codex invocation:

```bash
codex exec "follow docs/RELEASE.md, cut a minor release"
```

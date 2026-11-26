---
name: scramjet-browser-commit-hygiene
description: Inspect and protect Git boundaries before branch, staging, commit, history rewrite, push, merge from upstream, or PR work in scramjet-browser, Stellite's fork of Scramjet. Use for reviewing dirty trees, keeping fork work apart from upstream history, porting fork work across upstream versions, or preparing any Git mutation. Commit completed changes frequently under standing authorization. Pushing, rewriting history and changing branches need separate authorization.
---

# Keep scramjet-browser history clean

Load this skill before any Git mutation beyond read-only inspection.

## Inspect first

Run in the scramjet-browser Git root (`scramjet-browser/`):

```sh
git status --short --branch
git remote -v
git worktree list
git diff --stat
git diff --cached --stat
git diff --cached
```

Classify pre-existing work and current-task changes. Several branches are checked out in other worktrees; never commit in, switch, reset or remove another worktree. Never stage unrelated files or discard another session's work.

Split mixed dirty trees. One commit is one product change: core rewriting, the client, the controller, runway tests and a release bump each go alone.

## Commit authorization and cadence

Commit your own completed feature or fix slices frequently after their relevant checks pass: the touched package's build, and the runway suite or `pnpm test:e2e:realm` for a change in what a proxied page sees. This is standing authorization from the owner: do not ask before routine commits and do not defer all commits to the end of a long task.

Commit only your own changes. Authorization to commit never authorizes pushing, creating or switching branches, publishing, amending, or rewriting history. Each needs separate authorization unless the session already provides it.

## Remotes and branches

| Remote | Address | Use |
| --- | --- | --- |
| `forgejo` | `https://browserports.dev/BrowserPorts/scramjet-browser.git` | Forgejo, the fork. The only push target. |
| `origin` | `https://github.com/mercuryworkshop/scramjet` | Scramjet itself, the upstream. Fetch only. |

- `main` is the fork's branch and carries Stellite's work on top of upstream `main`. Stellite builds its Scramjet from it.
- `v3-port` carries the fork's work ported onto upstream's v3, based on current `origin/main`. Port a `main` fix there as its own commit when asked.
- `hardened-mode`, `names` and the other Forgejo branches are topic branches. Push one only when asked.
- Never push to `origin`, and never open a pull request against `MercuryWorkshop/scramjet` from here. The `Merge remote-tracking branch 'cursor/main'` commit came from the retired Cursor remote; if a `cursor` remote or any `origin.cursor.com` URL reappears, never push to it.
- Bring upstream in with a merge of `origin/main` into the fork branch, as its own commit with nothing else in it. Do not rebase `main`: Stellite releases pin its commits.
- Upstream's own commits come in through the merge exactly as they are, whatever their messages carry. Never rewrite them and never strip lines from them.
- This repository is public. Forgejo pushes it to the read-only mirror at `github.com/BrowserPorts/scramjet-browser`. Reach GitHub only through that mirror: never push to GitHub directly.

## Staging

Inspect every untracked path. Never stage:

- `node_modules/`, `dist/`, `output/playwright/`
- rewriter output: `packages/core/rewriter/target/`, `packages/core/rewriter/wasm/out/`, `packages/core/rewriter/*.js`, `packages/core/README.md`
- runway output: `packages/runway/coverage/`, `packages/runway/output/`, `packages/runway/runway-output/`, `packages/runway/release/`
- anything else under `.agent/`, which holds local diagnostic runs; only this skill and its two discovery links are tracked there, and only with `git add -f -- <exact path>`
- `AGENTS.md`, `CLAUDE.md`, `FERROCHROME_MERGE.md`, which `.git/info/exclude` keeps local

The local pre-commit hook runs `pnpm format`, which the root `package.json` does not define, so it prints `Command "format" not found` and the commit still goes through. Format touched files with Prettier yourself before staging. `pnpm-lock.yaml` changes only with a dependency change.

Stage exact paths, then rerun status and inspect the complete staged diff. Unstage a prohibited path with `git restore --staged -- <path>`; do not discard its working copy.

## Commit messages

Use Conventional Commits. Upstream writes its subjects as `[area] summary`, so a typed subject also marks a commit as the fork's:

```text
<type>(<scope>): <imperative technical summary>
```

- Keep the subject at or below 72 characters.
- Describe product behavior and technical rationale only.
- Use the configured human author and committer.
- No AI or model attribution of any kind: no `Co-Authored-By` naming Claude or Anthropic, no `noreply@anthropic.com`, no `Claude-Session` line, no generated-by line. The rule covers the fork's own commits. Nothing on the server checks it, so the agent making the commit is responsible for keeping it out.
- No sessions, prompts, task or rule numbers, agents, waves, worktrees, workflows, checkpoints, plans, transcripts, or process narration.

Scan the exact proposed message before committing:

```sh
rg -ni 'co-authored-by:.*(claude|anthropic|ai)|claude-session|assisted-by|generated(-by| with)|task ?#|rule ?#|#[0-9]|iter-|wave|refuter|worktree|workflow|goal-mode|checkpoint|transcript'
```

No matches are permitted.

## Pushing

- Push only to `forgejo`, and only when authorized. `git remote get-url --push forgejo` must print the Forgejo URL. Never push to `origin`, to Cursor's origin (`origin.cursor.com`), or to GitHub.
- Push one branch with an explicit refspec: `git push forgejo main:main`. Never `--force`, `--all`, `--mirror`, or a bare `git push`.
- Before every push, scan the whole outgoing range, including commits already ahead of the remote and those an upstream merge brings, and stop if anything matches:

```sh
git log --format='%H%n%B' forgejo/main..HEAD | rg -ni 'co-authored-by:.*(claude|anthropic)|noreply@anthropic\.com|claude-session|generated(-by| with)'
```

- Stop on any match and look at it. A match in a fork commit is fixed before the push. A match in upstream's own commit, one an upstream merge brought in (`git merge-base --is-ancestor <hash> origin/main` succeeds), goes out exactly as it is: never rewrite it and never strip lines from it.
- If Forgejo refuses a push, report why. Do not rewrite history to get around it.

## Safeguards

- Never use `--no-verify`.
- Never amend a pushed commit, force-push, or rewrite shared history without explicit approval.
- Use `codex/<topic>` only when a branch is requested.
- Reinspect `git show --stat --oneline --decorate HEAD` and status after every commit.

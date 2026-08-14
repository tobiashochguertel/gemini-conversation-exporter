#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.12"
# dependencies = []
# ///
"""
Pre-push hook: validate conventional commit messages of commits being pushed.

Git feeds ref-update lines on stdin (one per line):
    <local-ref> <local-sha> <remote-ref> <remote-sha>

For each ref where local-sha is not all zeros, this script validates the
commit messages of every commit in the range <remote-sha>..<local-sha>
against the conventional commit format. Merge commits are skipped.

Exit code 0 = all commits valid, push allowed.
Exit code 1 = one or more commits have invalid messages, push blocked.

Usage (called by hk pre-push hook):
    uv run --script scripts/check-push-commits.py
"""

import re
import subprocess
import sys

# Conventional commit types allowed by hk's check-conventional-commit util
ALLOWED_TYPES = (
    "build", "chore", "ci", "docs", "feat", "fix",
    "perf", "refactor", "revert", "style", "test",
)

# Pattern: <type>(<optional scope>): <description>
# Also allows fixup!/squash!/amend! prefixes (auto-squash commits)
CONVENTIONAL_RE = re.compile(
    r"^(?:fixup! |squash! |amend! )?"
    rf"(?:{'|'.join(ALLOWED_TYPES)})"  # type
    r"(?:\([^)]+\))?"                  # optional scope
    r"!?"                              # optional breaking-change marker
    r": .+"                            # colon + description
)

ZERO_SHA_RE = re.compile(r"^0+$")


def run_git(*args: str) -> str:
    """Run a git command and return stdout (empty string on failure)."""
    result = subprocess.run(
        ["git", *args],
        capture_output=True,
        text=True,
        timeout=30,
    )
    return result.stdout.strip()


def is_merge_commit(sha: str) -> bool:
    """Check if a commit is a merge commit (more than one parent)."""
    parents = run_git("rev-list", "--parents", "-n", "1", sha)
    if not parents:
        return False
    # Output: <sha> <parent1> [<parent2> ...]
    # More than 2 tokens = more than 1 parent = merge commit
    return len(parents.split()) > 2


def get_commit_message(sha: str) -> str:
    """Get the full commit message (subject + body) for a commit."""
    return run_git("log", "-1", "--format=%B", sha)


def get_commits_in_range(from_sha: str, to_sha: str) -> list[str]:
    """Get all commit SHAs in the range from_sha..to_sha."""
    output = run_git("rev-list", f"{from_sha}..{to_sha}")
    if not output:
        return []
    return output.splitlines()


def get_commits_for_new_branch(local_sha: str) -> list[str]:
    """Get commits for a new branch push (no remote counterpart).

    Excludes commits already reachable from any existing remote ref.
    """
    output = run_git(
        "rev-list", local_sha, "--not", "--branches", "--remotes",
    )
    if not output:
        return []
    return output.splitlines()


def validate_commit_message(sha: str, message: str) -> bool:
    """Check if a commit message follows conventional commit format.

    Only the first line (subject) is validated. The body is ignored.
    """
    subject = message.strip().splitlines()[0] if message.strip() else ""
    if not subject:
        return False
    return bool(CONVENTIONAL_RE.match(subject))


def main() -> int:
    # Read ref-update lines from stdin (git pre-push protocol)
    stdin_data = sys.stdin.read().strip()
    if not stdin_data:
        # No refs to push — nothing to validate
        return 0

    failed_commits: list[tuple[str, str]] = []

    for line in stdin_data.splitlines():
        line = line.strip()
        if not line:
            continue

        parts = line.split()
        if len(parts) < 4:
            continue

        local_ref, local_sha, remote_ref, remote_sha = parts[0], parts[1], parts[2], parts[3]

        # Skip branch deletions (all-zero local sha)
        if ZERO_SHA_RE.match(local_sha):
            continue

        # Determine commit range
        if ZERO_SHA_RE.match(remote_sha):
            # New branch: validate commits not on any existing remote ref
            commits = get_commits_for_new_branch(local_sha)
        else:
            # Update: validate commits in remote_sha..local_sha
            commits = get_commits_in_range(remote_sha, local_sha)

        for sha in commits:
            # Skip merge commits — they don't need conventional format
            if is_merge_commit(sha):
                continue

            message = get_commit_message(sha)
            if not validate_commit_message(sha, message):
                subject = message.strip().splitlines()[0] if message.strip() else "(empty)"
                failed_commits.append((sha[:8], subject))

    if failed_commits:
        print("Push rejected: invalid conventional commit messages:", file=sys.stderr)
        print(file=sys.stderr)
        for sha, subject in failed_commits:
            print(f"  {sha}: {subject}", file=sys.stderr)
        print(file=sys.stderr)
        print(
            f"Expected format: <type>(<scope>): <description>", file=sys.stderr,
        )
        print(
            f"Allowed types: {', '.join(ALLOWED_TYPES)}", file=sys.stderr,
        )
        print(file=sys.stderr)
        print("Fix with: git rebase -i <base>", file=sys.stderr)
        return 1

    return 0


if __name__ == "__main__":
    sys.exit(main())

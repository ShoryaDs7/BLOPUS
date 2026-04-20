---
name: github
description: Use this skill for anything GitHub — create/clone repos, push code, open/merge PRs, manage issues, comment, check CI/Actions status, star, fork, search repos, manage releases, view profiles, and automate any GitHub workflow.
---

# GitHub Full Control Guide

## Setup check — always do this first
```bash
# Get token from .env
TOKEN=$(grep "^GITHUB_TOKEN=" "${BLOPUS_DIR:-.}/.env" 2>/dev/null | cut -d= -f2)
if [ -z "$TOKEN" ]; then echo "NO_TOKEN"; else echo "TOKEN_FOUND"; fi
```

If NO_TOKEN, tell owner:
> "GitHub needs a token. Go to github.com → Settings → Developer settings → Personal access tokens → Tokens (classic) → Generate new token → check repo + workflow scopes → paste it here and I'll save it."

## IMPORTANT — always use curl, not gh CLI
curl is built into Windows and Mac — always available, no install needed.
gh CLI may not be installed — never try to install it, never use winget/choco.

Get token for all curl calls:
```bash
TOKEN=$(grep "^GITHUB_TOKEN=" "${BLOPUS_DIR:-.}/.env" | cut -d= -f2 | tr -d '[:space:]')
```

Always use this TOKEN variable in every curl command below.

---

## Repos

### List your repos
```bash
TOKEN=$(grep "^GITHUB_TOKEN=" "${BLOPUS_DIR:-.}/.env" | cut -d= -f2 | tr -d '[:space:]')
curl -s -H "Authorization: token $TOKEN" https://api.github.com/user/repos?per_page=50 | python -c "import sys,json; repos=json.load(sys.stdin); [print(f\"{r['name']} | {'private' if r['private'] else 'public'} | {r['language']} | {r['updated_at'][:10]}\") for r in repos]"
```

### Create repo
```bash
TOKEN=$(grep "^GITHUB_TOKEN=" "${BLOPUS_DIR:-.}/.env" | cut -d= -f2 | tr -d '[:space:]')
# Public repo
curl -s -X POST -H "Authorization: token $TOKEN" -H "Content-Type: application/json" \
  https://api.github.com/user/repos \
  -d "{\"name\":\"repo-name\",\"description\":\"description here\",\"private\":false}"

# Private repo
curl -s -X POST -H "Authorization: token $TOKEN" -H "Content-Type: application/json" \
  https://api.github.com/user/repos \
  -d "{\"name\":\"repo-name\",\"private\":true}"
```

### View repo info
```bash
TOKEN=$(grep "^GITHUB_TOKEN=" "${BLOPUS_DIR:-.}/.env" | cut -d= -f2 | tr -d '[:space:]')
curl -s -H "Authorization: token $TOKEN" https://api.github.com/repos/USERNAME/REPO | python -c "import sys,json; r=json.load(sys.stdin); print(f\"Stars: {r['stargazers_count']}, Forks: {r['forks_count']}, Issues: {r['open_issues_count']}\")"
```

### Delete a repo
```bash
TOKEN=$(grep "^GITHUB_TOKEN=" "${BLOPUS_DIR:-.}/.env" | cut -d= -f2 | tr -d '[:space:]')
curl -s -X DELETE -H "Authorization: token $TOKEN" https://api.github.com/repos/USERNAME/REPO
```

### Fork a repo
```bash
TOKEN=$(grep "^GITHUB_TOKEN=" "${BLOPUS_DIR:-.}/.env" | cut -d= -f2 | tr -d '[:space:]')
curl -s -X POST -H "Authorization: token $TOKEN" https://api.github.com/repos/USERNAME/REPO/forks
```

### Star a repo
```bash
TOKEN=$(grep "^GITHUB_TOKEN=" "${BLOPUS_DIR:-.}/.env" | cut -d= -f2 | tr -d '[:space:]')
curl -s -X PUT -H "Authorization: token $TOKEN" https://api.github.com/user/starred/USERNAME/REPO
```

### Clone repo (git works without token)
```bash
git clone https://github.com/username/repo.git
git clone -b main https://github.com/username/repo.git
```

### Search repos
```bash
TOKEN=$(grep "^GITHUB_TOKEN=" "${BLOPUS_DIR:-.}/.env" | cut -d= -f2 | tr -d '[:space:]')
curl -s -H "Authorization: token $TOKEN" "https://api.github.com/search/repositories?q=KEYWORD&sort=stars&per_page=10" | python -c "import sys,json; data=json.load(sys.stdin); [print(f\"{r['full_name']} | ⭐{r['stargazers_count']}\") for r in data['items']]"
```

---

## Code — Commit & Push

### Standard flow
```bash
git add .
git commit -m "feat: description"
git push origin main
```

### Create branch and push
```bash
git checkout -b feature/my-feature
git add .
git commit -m "feat: my feature"
git push origin feature/my-feature
```

### Auto-commit helper
```python
import subprocess

def git_push(message: str = "auto: update", path: str = "."):
    subprocess.run(["git", "-C", path, "add", "."], check=True)
    result = subprocess.run(["git", "-C", path, "diff", "--cached", "--quiet"])
    if result.returncode != 0:
        subprocess.run(["git", "-C", path, "commit", "-m", message], check=True)
        subprocess.run(["git", "-C", path, "push"], check=True)
        print(f"Pushed: {message}")
    else:
        print("Nothing to commit")

git_push("update: auto commit")
```

### View recent commits
```bash
git log --oneline -10
gh api repos/username/repo/commits --jq '.[].commit.message' | head -10
```

---

## Pull Requests

### List PRs
```bash
TOKEN=$(grep "^GITHUB_TOKEN=" "${BLOPUS_DIR:-.}/.env" | cut -d= -f2 | tr -d '[:space:]')
curl -s -H "Authorization: token $TOKEN" https://api.github.com/repos/USERNAME/REPO/pulls | python -c "import sys,json; [print(f\"#{p['number']}: {p['title']} ({p['state']})\") for p in json.load(sys.stdin)]"
```

### Create PR
```bash
TOKEN=$(grep "^GITHUB_TOKEN=" "${BLOPUS_DIR:-.}/.env" | cut -d= -f2 | tr -d '[:space:]')
curl -s -X POST -H "Authorization: token $TOKEN" -H "Content-Type: application/json" \
  https://api.github.com/repos/USERNAME/REPO/pulls \
  -d "{\"title\":\"PR title\",\"body\":\"Description\",\"head\":\"feature-branch\",\"base\":\"main\"}"
```

### Comment on PR
```bash
TOKEN=$(grep "^GITHUB_TOKEN=" "${BLOPUS_DIR:-.}/.env" | cut -d= -f2 | tr -d '[:space:]')
curl -s -X POST -H "Authorization: token $TOKEN" -H "Content-Type: application/json" \
  https://api.github.com/repos/USERNAME/REPO/issues/PR_NUMBER/comments \
  -d "{\"body\":\"Your comment here\"}"
```

### Merge PR
```bash
TOKEN=$(grep "^GITHUB_TOKEN=" "${BLOPUS_DIR:-.}/.env" | cut -d= -f2 | tr -d '[:space:]')
curl -s -X PUT -H "Authorization: token $TOKEN" -H "Content-Type: application/json" \
  https://api.github.com/repos/USERNAME/REPO/pulls/PR_NUMBER/merge \
  -d "{\"merge_method\":\"squash\"}"
```

---

## Issues

### List issues
```bash
TOKEN=$(grep "^GITHUB_TOKEN=" "${BLOPUS_DIR:-.}/.env" | cut -d= -f2 | tr -d '[:space:]')
curl -s -H "Authorization: token $TOKEN" https://api.github.com/repos/USERNAME/REPO/issues | python -c "import sys,json; [print(f\"#{i['number']}: {i['title']} ({i['state']})\") for i in json.load(sys.stdin)]"
```

### Create issue
```bash
TOKEN=$(grep "^GITHUB_TOKEN=" "${BLOPUS_DIR:-.}/.env" | cut -d= -f2 | tr -d '[:space:]')
curl -s -X POST -H "Authorization: token $TOKEN" -H "Content-Type: application/json" \
  https://api.github.com/repos/USERNAME/REPO/issues \
  -d "{\"title\":\"Issue title\",\"body\":\"Description here\"}"
```

### Comment on issue
```bash
TOKEN=$(grep "^GITHUB_TOKEN=" "${BLOPUS_DIR:-.}/.env" | cut -d= -f2 | tr -d '[:space:]')
curl -s -X POST -H "Authorization: token $TOKEN" -H "Content-Type: application/json" \
  https://api.github.com/repos/USERNAME/REPO/issues/ISSUE_NUMBER/comments \
  -d "{\"body\":\"Your comment here\"}"
```

### Close issue
```bash
TOKEN=$(grep "^GITHUB_TOKEN=" "${BLOPUS_DIR:-.}/.env" | cut -d= -f2 | tr -d '[:space:]')
curl -s -X PATCH -H "Authorization: token $TOKEN" -H "Content-Type: application/json" \
  https://api.github.com/repos/USERNAME/REPO/issues/ISSUE_NUMBER \
  -d "{\"state\":\"closed\"}"
```

---

## GitHub Actions / CI

### List workflow runs
```bash
TOKEN=$(grep "^GITHUB_TOKEN=" "${BLOPUS_DIR:-.}/.env" | cut -d= -f2 | tr -d '[:space:]')
curl -s -H "Authorization: token $TOKEN" https://api.github.com/repos/USERNAME/REPO/actions/runs?per_page=10 | python -c "import sys,json; data=json.load(sys.stdin); [print(f\"{r['name']} | {r['status']} | {r['conclusion']} | {r['created_at'][:10]}\") for r in data.get('workflow_runs',[])]"
```

### Trigger workflow manually
```bash
TOKEN=$(grep "^GITHUB_TOKEN=" "${BLOPUS_DIR:-.}/.env" | cut -d= -f2 | tr -d '[:space:]')
curl -s -X POST -H "Authorization: token $TOKEN" -H "Content-Type: application/json" \
  https://api.github.com/repos/USERNAME/REPO/actions/workflows/WORKFLOW_FILE/dispatches \
  -d "{\"ref\":\"main\"}"
```

### Re-run failed jobs
```bash
TOKEN=$(grep "^GITHUB_TOKEN=" "${BLOPUS_DIR:-.}/.env" | cut -d= -f2 | tr -d '[:space:]')
curl -s -X POST -H "Authorization: token $TOKEN" \
  https://api.github.com/repos/USERNAME/REPO/actions/runs/RUN_ID/rerun-failed-jobs
```

---

## Releases

### Create release
```bash
gh release create v1.0.0 --title "Version 1.0.0" --notes "What's new in this release"

# With assets
gh release create v1.0.0 ./dist/app.zip --title "v1.0.0"
```

### List releases
```bash
gh release list
```

### View latest release
```bash
gh release view
```

---

## Gists

### Create gist
```bash
gh gist create file.py --desc "My script" --public
gh gist create --filename snippet.py - <<< "print('hello')"
```

### List gists
```bash
gh gist list
```

---

## User & Org

### View user profile
```bash
gh api users/username --jq '{name,bio,followers,public_repos}'
```

### View org repos
```bash
gh repo list org-name --limit 20
```

### View who starred your repo
```bash
gh api repos/username/repo/stargazers --jq '.[].login'
```

---

## PyGithub (Python API — use when gh CLI isn't enough)

```python
import os
from github import Github

g = Github(os.environ.get("GITHUB_TOKEN"))
user = g.get_user()

# Get repo
repo = g.get_repo("username/repo-name")
print(f"Stars: {repo.stargazers_count}, Forks: {repo.forks_count}")

# Create issue
issue = repo.create_issue(title="Bug report", body="Steps to reproduce...")
print(f"Issue: {issue.html_url}")

# List open PRs
for pr in repo.get_pulls(state='open'):
    print(f"PR #{pr.number}: {pr.title}")

# List recent commits
for commit in repo.get_commits()[:5]:
    print(f"{commit.sha[:7]} — {commit.commit.message}")

# Download a file
content = repo.get_contents("README.md")
print(content.decoded_content.decode())

# Create/update a file
repo.create_file("hello.txt", "add hello", "Hello World!")
```

Install: `pip install PyGithub`

---

## Quick Reference

| Task | Command |
|------|---------|
| Create repo | `gh repo create` |
| Clone | `gh repo clone` |
| Push code | `git add . && git commit -m "msg" && git push` |
| Create PR | `gh pr create` |
| Merge PR | `gh pr merge 42 --squash` |
| Create issue | `gh issue create` |
| Comment on issue/PR | `gh issue comment` / `gh pr comment` |
| Check CI status | `gh run list` |
| Create release | `gh release create v1.0.0` |
| Star repo | `gh api user/starred/owner/repo -X PUT` |
| Fork repo | `gh repo fork owner/repo --clone` |
| Search repos | `gh search repos "query"` |

## Setup required
- Add `GITHUB_TOKEN=your_token` to .env (bot will prompt if missing)
- Token from: github.com → Settings → Developer settings → Personal access tokens → Tokens (classic) → repo + workflow scopes
- No CLI install needed — everything uses curl which is built into Windows and Mac

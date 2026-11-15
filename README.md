# Mini Git Forge

[![make.fun competition](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/amirbeh1/git-forge-bounty/rank.svg)](https://make.fun/bounty/github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/amirbeh1/git-forge-bounty/reward.svg)](https://make.fun/bounty/github-core-clone-01)

Entry for the make.fun bounty [Build a GitHub-compatible git forge](https://make.fun/bounty/github-core-clone-01).

A tiny, dependency-free Git server (Git Smart HTTP protocol) in Node.js 22. Supports `git clone`, `git fetch` and `git push`. Repositories are stored as bare repos in `./repos`.

## Requirements
- Node.js >= 22
- `git` installed and on `PATH` (used for pack negotiation in `--stateless-rpc` mode)

## Run
```bash
node main.js                 # listens on http://localhost:3000
PORT=8080 node main.js       # custom port
REPOS_DIR=/data/repos node main.js
PUSH_TOKEN=secret node main.js   # optional: require a password for push
```

## Use
```bash
# Create a repo by pushing to it (repos are auto-created on first push)
mkdir demo && cd demo && git init -b main
echo hello > README && git add . && git commit -m "first"
git remote add origin http://localhost:3000/alice/demo.git
git push -u origin main          # if PUSH_TOKEN is set, use any username and the token as password

# Clone it elsewhere
git clone http://localhost:3000/alice/demo.git
```
URLs look like `/<name>.git` or `/<owner>/<name>.git`.

## Implemented endpoints
| Method | Path | Purpose |
|---|---|---|
| GET | `/<repo>.git/info/refs?service=git-upload-pack` | ref advertisement (clone/fetch) |
| GET | `/<repo>.git/info/refs?service=git-receive-pack` | ref advertisement (push) |
| POST | `/<repo>.git/git-upload-pack` | send packfile to client |
| POST | `/<repo>.git/git-receive-pack` | receive packfile from client |

## Simplifications
- No UI, users, or permissions; only an optional single push token.
- No "dumb" HTTP protocol, no SSH.
- Protocol v0/v1 and v2 are supported by forwarding `Git-Protocol` to git.

## License
MIT

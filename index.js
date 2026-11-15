#!/usr/bin/env node
/**
 * Minimal GitHub-compatible Git forge (Smart HTTP protocol) — Node.js 22, zero dependencies.
 *
 * Design: the HTTP layer, routing, repo storage and security checks are written here.
 * The binary-heavy parts of the protocol (ref advertisement, pack negotiation,
 * pack generation/unpacking) are delegated to the system `git` binary running in
 * `--stateless-rpc` mode — exactly what `git http-backend` does internally.
 * This keeps the server tiny while being fully compatible with real git clients.
 *
 * Endpoints (the Smart HTTP subset needed for clone / fetch / push):
 *   GET  /<repo>.git/info/refs?service=git-upload-pack     -> ref advertisement (clone/fetch)
 *   GET  /<repo>.git/info/refs?service=git-receive-pack    -> ref advertisement (push)
 *   POST /<repo>.git/git-upload-pack                       -> send pack to client (clone/fetch)
 *   POST /<repo>.git/git-receive-pack                      -> receive pack from client (push)
 *
 * Config via env: PORT (default 3000), REPOS_DIR (default ./repos),
 *                 PUSH_TOKEN (optional; if set, pushes require HTTP Basic auth with this password).
 */
'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const { spawn, spawnSync } = require('node:child_process');

const PORT = Number(process.env.PORT) || 3000;
const REPOS_DIR = path.resolve(process.env.REPOS_DIR || './repos');
const PUSH_TOKEN = process.env.PUSH_TOKEN || '';

fs.mkdirSync(REPOS_DIR, { recursive: true });

// Matches: /<name>.git/<endpoint>  or  /<owner>/<name>.git/<endpoint>
const ROUTE = /^\/([\w.-]+(?:\/[\w.-]+)?)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/;

/** Encode a string as a git pkt-line (4 hex digits of length, then payload). */
function pktLine(str) {
  return Buffer.from((Buffer.byteLength(str) + 4).toString(16).padStart(4, '0') + str);
}
const FLUSH = Buffer.from('0000');

/** Resolve a repo name to a directory, refusing path traversal. */
function repoPath(name) {
  if (name.split('/').some((p) => p === '.' || p === '..' || p.startsWith('.'))) return null;
  const full = path.resolve(REPOS_DIR, name + '.git');
  return full.startsWith(REPOS_DIR + path.sep) ? full : null;
}

/** Create a bare repository (default branch: main). */
function initBareRepo(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const r = spawnSync('git', ['init', '--bare', '--initial-branch=main', dir], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error('git init failed: ' + r.stderr);
}

function send(res, status, body, headers = {}) {
  res.writeHead(status, { 'Cache-Control': 'no-cache', ...headers });
  res.end(body);
}

/** Optional HTTP Basic auth check for write operations. */
function authorized(req) {
  if (!PUSH_TOKEN) return true;
  const h = req.headers.authorization || '';
  if (!h.startsWith('Basic ')) return false;
  const pass = Buffer.from(h.slice(6), 'base64').toString().split(':').slice(1).join(':');
  return pass === PUSH_TOKEN;
}

function challenge(res) {
  send(res, 401, 'Authentication required\n', { 'WWW-Authenticate': 'Basic realm="git"' });
}

/** Environment for the git subprocess; forwards protocol v2 negotiation header. */
function gitEnv(req) {
  const env = { ...process.env };
  if (req.headers['git-protocol']) env.GIT_PROTOCOL = req.headers['git-protocol'];
  return env;
}

const isV2 = (req) => /version=2/.test(req.headers['git-protocol'] || '');

/** GET /info/refs — advertise refs. */
function handleInfoRefs(req, res, dir, service, url) {
  const isPush = service === 'git-receive-pack';
  if (isPush && !authorized(req)) return challenge(res);

  if (!fs.existsSync(dir)) {
    if (!isPush) return send(res, 404, 'Repository not found\n');
    initBareRepo(dir); // pushing to a new repo creates it (like a "forge" would)
    console.log('created repo', path.relative(REPOS_DIR, dir));
  }

  res.writeHead(200, {
    'Content-Type': `application/x-${service}-advertisement`,
    'Cache-Control': 'no-cache',
  });
  // Protocol v0/v1 prefixes the advertisement with "# service=..." + flush. v2 does not.
  if (!isV2(req)) {
    res.write(pktLine(`# service=${service}\n`));
    res.write(FLUSH);
  }
  const git = spawn('git', [service.slice(4), '--stateless-rpc', '--advertise-refs', dir], { env: gitEnv(req) });
  git.stdout.pipe(res);
  git.stderr.on('data', (d) => console.error('[git]', d.toString().trim()));
  git.on('error', () => res.destroy());
}

/** POST /git-upload-pack | /git-receive-pack — stateless RPC. */
function handleRpc(req, res, dir, service) {
  if (service === 'git-receive-pack' && !authorized(req)) return challenge(res);
  if (!fs.existsSync(dir)) return send(res, 404, 'Repository not found\n');
  if (req.headers['content-type'] !== `application/x-${service}-request`) {
    return send(res, 415, 'Unsupported media type\n');
  }

  res.writeHead(200, {
    'Content-Type': `application/x-${service}-result`,
    'Cache-Control': 'no-cache',
  });
  const git = spawn('git', [service.slice(4), '--stateless-rpc', dir], { env: gitEnv(req) });
  git.stderr.on('data', (d) => console.error('[git]', d.toString().trim()));
  git.on('error', () => res.destroy());

  // Git clients gzip large request bodies (e.g. many "have" lines on fetch).
  const body = req.headers['content-encoding'] === 'gzip' ? req.pipe(zlib.createGunzip()) : req;
  body.on('error', () => git.kill());
  body.pipe(git.stdin);
  git.stdout.pipe(res);
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const m = ROUTE.exec(url.pathname);
  if (!m) return send(res, 404, 'Not found\n');

  const [, name, endpoint] = m;
  const dir = repoPath(name);
  if (!dir) return send(res, 400, 'Bad repository name\n');
  console.log(req.method, req.url);

  try {
    if (endpoint === 'info/refs' && req.method === 'GET') {
      const service = url.searchParams.get('service');
      if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
        return send(res, 403, 'Only smart HTTP is supported\n'); // no "dumb" protocol
      }
      return handleInfoRefs(req, res, dir, service, url);
    }
    if (endpoint !== 'info/refs' && req.method === 'POST') return handleRpc(req, res, dir, endpoint);
    return send(res, 405, 'Method not allowed\n');
  } catch (err) {
    console.error(err);
    if (!res.headersSent) send(res, 500, 'Internal error\n');
    else res.destroy();
  }
});

server.listen(PORT, () => {
  console.log(`Git forge listening on http://localhost:${PORT}  (repos: ${REPOS_DIR})`);
});

// rest.ts — the REST v3 surface under /api/v3: repositories, contents, labels, issues, comments,
// pull requests, branches, commits and refs, in GitHub's shapes. Every handler answers through
// the shared store, so git pushes, GraphQL mutations and MCP calls are all visible here.

import {
  Forge,
  type Issue,
  type Pull,
  type Repo,
  ZERO_OID,
  commitFiles,
  filesAtCommit,
  flattenTree,
  parseCommit,
  parseTree,
  refCommit,
} from './forge.ts';
import { ServiceError, addComment, branchTip, createIssue, createPull, pullFiles, squashMerge } from './service.ts';

export interface RestRequest {
  method: string;
  /** Path segments after /api/v3, already URL-decoded. */
  segments: string[];
  query: URLSearchParams;
  rawBody: Buffer;
  origin: string;
}

export interface RestResponse {
  status: number;
  json?: unknown;
  headers?: Record<string, string>;
}

const ok = (status: number, json: unknown, headers?: Record<string, string>): RestResponse => ({ status, json, headers });
const fail = (status: number, message: string): RestResponse => ({ status, json: { message } });

// ---------------------------------------------------------------------------
// JSON views

export function repoView(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    node_id: `R_${repo.id}`,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    private: repo.isPrivate,
    owner: { login: repo.owner, id: 1000, type: 'User' },
    description: repo.description,
    default_branch: repo.defaultBranch,
    created_at: repo.createdAt,
    updated_at: repo.createdAt,
    html_url: `https://github.com/${repo.owner}/${repo.name}`,
  };
}

export function issueView(repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    node_id: `I_${issue.id}`,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => {
      const label = repo.labels.get(name);
      return { id: label?.id ?? 0, name, color: label?.color ?? 'ededed' };
    }),
    user: { login: issue.author, id: 1000, type: 'User' },
    comments: (repo.comments.get(issue.number) ?? []).length,
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    html_url: `https://github.com/${repo.owner}/${repo.name}/issues/${issue.number}`,
  };
}

export function pullView(forge: Forge, repo: Repo, pull: Pull): Record<string, unknown> {
  return {
    id: pull.id,
    node_id: `PR_${pull.id}`,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    head: { ref: pull.headRef, sha: branchTip(forge, repo, pull.headRef), label: `${repo.owner}:${pull.headRef}` },
    base: { ref: pull.baseRef, sha: branchTip(forge, repo, pull.baseRef), label: `${repo.owner}:${pull.baseRef}` },
    user: { login: pull.author, id: 1000, type: 'User' },
    created_at: pull.createdAt,
    updated_at: pull.updatedAt,
    html_url: `https://github.com/${repo.owner}/${repo.name}/pull/${pull.number}`,
  };
}

export function commentView(comment: { id: number; body: string; author: string; createdAt: string; updatedAt: string }): Record<string, unknown> {
  return {
    id: comment.id,
    body: comment.body,
    user: { login: comment.author, id: 1000, type: 'User' },
    created_at: comment.createdAt,
    updated_at: comment.updatedAt,
  };
}

// ---------------------------------------------------------------------------
// body parsing

export function parseJsonBody(req: RestRequest): Record<string, unknown> {
  const text = req.rawBody.toString('utf8').trim();
  if (text === '') return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new ServiceError(400, 'Problems parsing JSON');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new ServiceError(400, 'Problems parsing JSON');
  return parsed as Record<string, unknown>;
}

function stringField(body: Record<string, unknown>, name: string): string {
  const value = body[name];
  return typeof value === 'string' ? value : '';
}

function pageParams(query: URLSearchParams): { page: number; perPage: number } {
  const perPage = Math.max(1, Math.min(100, parseInt(query.get('per_page') ?? '30', 10) || 30));
  const page = Math.max(1, parseInt(query.get('page') ?? '1', 10) || 1);
  return { page, perPage };
}

function paginate<T>(req: RestRequest, items: T[], path: string): RestResponse {
  const { page, perPage } = pageParams(req.query);
  const start = (page - 1) * perPage;
  const slice = items.slice(start, start + perPage);
  const headers: Record<string, string> = {};
  if (start + perPage < items.length) {
    const next = new URLSearchParams(req.query);
    next.set('page', String(page + 1));
    next.set('per_page', String(perPage));
    const last = new URLSearchParams(req.query);
    last.set('page', String(Math.ceil(items.length / perPage)));
    last.set('per_page', String(perPage));
    headers.link = `<${req.origin}${path}?${next.toString()}>; rel="next", <${req.origin}${path}?${last.toString()}>; rel="last"`;
  }
  return ok(200, slice, headers);
}

// ---------------------------------------------------------------------------
// the router

export function handleRest(forge: Forge, ownerLogin: string, req: RestRequest): RestResponse {
  try {
    return route(forge, ownerLogin, req);
  } catch (error) {
    if (error instanceof ServiceError) return fail(error.status, error.message);
    throw error;
  }
}

function route(forge: Forge, ownerLogin: string, req: RestRequest): RestResponse {
  const seg = req.segments;
  const method = req.method;

  if (seg.length === 0) {
    if (method !== 'GET') return fail(404, 'Not Found');
    return ok(200, { current_user_url: '/api/v3/user', current_user_repositories_url: '/api/v3/user/repos' }, { 'x-oauth-scopes': 'repo, read:org, write:org' });
  }
  if (seg.length === 1 && seg[0] === 'meta') {
    if (method !== 'GET') return fail(404, 'Not Found');
    return ok(200, { installed_version: '1.0.0-forge', verifiable_password_authentication: false });
  }
  if (seg.length === 1 && seg[0] === 'user') {
    if (method !== 'GET') return fail(404, 'Not Found');
    return ok(200, { login: ownerLogin, id: 1000, type: 'User', name: ownerLogin });
  }
  if (seg[0] === 'user' && seg[1] === 'repos' && seg.length === 2) {
    if (method === 'GET') {
      const views = forge.listRepos(ownerLogin).map(repoView);
      return paginate(req, views, '/api/v3/user/repos');
    }
    if (method === 'POST') {
      const body = parseJsonBody(req);
      const name = stringField(body, 'name');
      if (name === '') return fail(422, 'Validation Failed: name is required');
      if (forge.getRepo(ownerLogin, name) !== undefined) return fail(422, `Validation Failed: name already exists on this account`);
      const repo = forge.createRepo(ownerLogin, name, body.private === true, stringField(body, 'description'));
      return ok(201, repoView(repo));
    }
    return fail(404, 'Not Found');
  }
  if (seg[0] === 'users' && seg.length === 3 && seg[2] === 'repos' && method === 'GET') {
    const views = forge.listRepos(seg[1] as string).map(repoView);
    return paginate(req, views, `/api/v3/users/${seg[1]}/repos`);
  }
  if (seg[0] === 'repos' && seg.length >= 3) {
    const owner = seg[1] as string;
    const name = seg[2] as string;
    const repo = forge.getRepo(owner, name);
    if (seg.length === 3) {
      if (repo === undefined) return fail(404, 'Not Found');
      if (method === 'GET') return ok(200, repoView(repo));
      if (method === 'PATCH') {
        const body = parseJsonBody(req);
        if (typeof body.description === 'string') repo.description = body.description;
        if (typeof body.name === 'string' && body.name !== '' && body.name !== repo.name) {
          forge.repos.delete(forge.repoKey(repo.owner, repo.name));
          repo.name = body.name;
          forge.repos.set(forge.repoKey(repo.owner, repo.name), repo);
        }
        if (typeof body.private === 'boolean') repo.isPrivate = body.private;
        return ok(200, repoView(repo));
      }
      if (method === 'DELETE') {
        forge.deleteRepo(owner, name);
        return { status: 204 };
      }
      return fail(404, 'Not Found');
    }
    if (repo === undefined) return fail(404, 'Not Found');
    return routeRepo(forge, ownerLogin, req, repo, seg.slice(3));
  }
  return fail(404, 'Not Found');
}

function routeRepo(forge: Forge, ownerLogin: string, req: RestRequest, repo: Repo, seg: string[]): RestResponse {
  const method = req.method;

  // ----- contents
  if (seg[0] === 'contents') {
    const path = seg.slice(1).join('/');
    return contentsRoute(forge, req, repo, path);
  }

  // ----- labels
  if (seg[0] === 'labels' && seg.length === 1) {
    if (method === 'GET') return ok(200, [...repo.labels.values()].map((label) => ({ id: label.id, name: label.name, color: label.color })));
    if (method === 'POST') {
      const body = parseJsonBody(req);
      const name = stringField(body, 'name');
      if (name === '') return fail(422, 'Validation Failed: name is required');
      if (repo.labels.has(name)) return fail(422, 'Validation Failed: label already exists');
      const label = { id: forge.nextLabelId(), name, color: stringField(body, 'color') || 'ededed' };
      repo.labels.set(name, label);
      return ok(201, { id: label.id, name: label.name, color: label.color });
    }
    return fail(404, 'Not Found');
  }

  // ----- issues
  if (seg[0] === 'issues') {
    if (seg.length === 1) {
      if (method === 'POST') {
        const body = parseJsonBody(req);
        const title = stringField(body, 'title');
        if (title === '') return fail(422, 'Validation Failed: title is required');
        const labels = Array.isArray(body.labels) ? body.labels.filter((x): x is string => typeof x === 'string') : [];
        const issue = createIssue(forge, repo, title, stringField(body, 'body'), labels, ownerLogin);
        return ok(201, issueView(repo, issue));
      }
      if (method === 'GET') {
        let issues = [...repo.issues.values()];
        const state = req.query.get('state') ?? 'open';
        if (state === 'open') issues = issues.filter((issue) => issue.state === 'open');
        else if (state === 'closed') issues = issues.filter((issue) => issue.state === 'closed');
        const direction = req.query.get('direction') ?? 'desc';
        issues.sort((a, b) => (direction === 'asc' ? a.number - b.number : b.number - a.number));
        return paginate(req, issues.map((issue) => issueView(repo, issue)), `/api/v3/repos/${repo.owner}/${repo.name}/issues`);
      }
      return fail(404, 'Not Found');
    }
    const number = parseInt(seg[1] as string, 10);
    const issue = repo.issues.get(number);
    if (seg.length === 2) {
      if (issue === undefined) return fail(404, 'Not Found');
      if (method === 'GET') return ok(200, issueView(repo, issue));
      if (method === 'PATCH') {
        const body = parseJsonBody(req);
        if (typeof body.title === 'string') issue.title = body.title;
        if (typeof body.body === 'string') issue.body = body.body;
        if (body.state === 'open' || body.state === 'closed') issue.state = body.state;
        if (Array.isArray(body.labels)) {
          const labels = body.labels.filter((x): x is string => typeof x === 'string');
          for (const label of labels) if (!repo.labels.has(label)) return fail(422, `Validation Failed: label '${label}' does not exist`);
          issue.labels = labels;
        }
        return ok(200, issueView(repo, issue));
      }
      return fail(404, 'Not Found');
    }
    if (seg.length === 3 && seg[2] === 'comments') {
      if (issue === undefined && repo.pulls.get(number) === undefined) return fail(404, 'Not Found');
      if (method === 'POST') {
        const body = parseJsonBody(req);
        const comment = addComment(forge, repo, number, stringField(body, 'body'), ownerLogin);
        return ok(201, commentView(comment));
      }
      if (method === 'GET') {
        const comments = (repo.comments.get(number) ?? []).map(commentView);
        return paginate(req, comments, `/api/v3/repos/${repo.owner}/${repo.name}/issues/${number}/comments`);
      }
      return fail(404, 'Not Found');
    }
    return fail(404, 'Not Found');
  }

  // ----- pulls
  if (seg[0] === 'pulls') {
    if (seg.length === 1) {
      if (method === 'POST') {
        const body = parseJsonBody(req);
        const pull = createPull(forge, repo, stringField(body, 'title'), stringField(body, 'body'), stringField(body, 'head'), stringField(body, 'base'), ownerLogin);
        return ok(201, pullView(forge, repo, pull));
      }
      if (method === 'GET') {
        let pulls = [...repo.pulls.values()];
        const state = req.query.get('state') ?? 'open';
        if (state === 'open') pulls = pulls.filter((pull) => pull.state === 'open');
        else if (state === 'closed') pulls = pulls.filter((pull) => pull.state === 'closed');
        pulls.sort((a, b) => b.number - a.number);
        return paginate(req, pulls.map((pull) => pullView(forge, repo, pull)), `/api/v3/repos/${repo.owner}/${repo.name}/pulls`);
      }
      return fail(404, 'Not Found');
    }
    const number = parseInt(seg[1] as string, 10);
    const pull = repo.pulls.get(number);
    if (seg.length === 2) {
      if (pull === undefined) return fail(404, 'Not Found');
      if (method === 'GET') return ok(200, pullView(forge, repo, pull));
      if (method === 'PATCH') {
        const body = parseJsonBody(req);
        if (typeof body.title === 'string') pull.title = body.title;
        if (typeof body.body === 'string') pull.body = body.body;
        if (body.state === 'open' || body.state === 'closed') pull.state = body.state;
        return ok(200, pullView(forge, repo, pull));
      }
      return fail(404, 'Not Found');
    }
    if (seg.length === 3 && seg[2] === 'files' && method === 'GET') {
      if (pull === undefined) return fail(404, 'Not Found');
      const files = pullFiles(forge, repo, pull).map((file) => ({
        filename: file.filename,
        status: file.status,
        additions: file.additions,
        deletions: file.deletions,
        changes: file.changes,
        sha: '',
      }));
      return paginate(req, files, `/api/v3/repos/${repo.owner}/${repo.name}/pulls/${number}/files`);
    }
    if (seg.length === 3 && seg[2] === 'merge' && (method === 'PUT' || method === 'POST')) {
      if (pull === undefined) return fail(404, 'Not Found');
      parseJsonBody(req);
      const sha = squashMerge(forge, repo, pull);
      return ok(200, { sha, merged: true, message: 'Pull Request successfully merged' });
    }
    return fail(404, 'Not Found');
  }

  // ----- branches
  if (seg[0] === 'branches') {
    if (seg.length === 1 && method === 'GET') {
      const branches = [...repo.refs.keys()]
        .filter((ref) => ref.startsWith('refs/heads/'))
        .map((ref) => ({ name: ref.slice('refs/heads/'.length), commit: { sha: refCommit(forge, repo, ref) ?? ZERO_OID } }));
      return paginate(req, branches, `/api/v3/repos/${repo.owner}/${repo.name}/branches`);
    }
    if (seg.length >= 2 && method === 'GET') {
      const branch = seg.slice(1).join('/');
      const tip = refCommit(forge, repo, `refs/heads/${branch}`);
      if (tip === undefined) return fail(404, 'Not Found');
      return ok(200, { name: branch, commit: { sha: tip } });
    }
    return fail(404, 'Not Found');
  }

  // ----- commits
  if (seg[0] === 'commits') {
    if (seg.length === 1 && method === 'GET') {
      const ref = req.query.get('sha') ?? repo.defaultBranch;
      const tip = refCommit(forge, repo, `refs/heads/${ref}`) ?? (forge.getObject(ref)?.type === 'commit' ? ref : undefined);
      if (tip === undefined) return ok(200, []);
      const commits: Record<string, unknown>[] = [];
      const seen = new Set<string>();
      const queue = [tip];
      while (queue.length > 0 && commits.length < 1000) {
        const oid = queue.shift() as string;
        if (seen.has(oid)) continue;
        seen.add(oid);
        const object = forge.getObject(oid);
        if (object === undefined || object.type !== 'commit') continue;
        const view = parseCommit(object.data);
        commits.push({ sha: oid, commit: { message: view.message, author: { name: view.author }, committer: { name: view.committer }, tree: { sha: view.tree } }, parents: view.parents.map((parent) => ({ sha: parent })) });
        for (const parent of view.parents) queue.push(parent);
      }
      return paginate(req, commits, `/api/v3/repos/${repo.owner}/${repo.name}/commits`);
    }
    if (seg.length === 2 && method === 'GET') {
      const oid = seg[1] as string;
      const object = forge.getObject(oid);
      if (object === undefined || object.type !== 'commit') return fail(404, 'Not Found');
      const view = parseCommit(object.data);
      return ok(200, { sha: oid, commit: { message: view.message, author: { name: view.author }, committer: { name: view.committer }, tree: { sha: view.tree } }, parents: view.parents.map((parent) => ({ sha: parent })) });
    }
    return fail(404, 'Not Found');
  }

  // ----- git refs
  if (seg[0] === 'git' && seg[1] === 'refs') {
    if (seg.length === 2 && method === 'POST') {
      const body = parseJsonBody(req);
      const ref = stringField(body, 'ref');
      const sha = stringField(body, 'sha');
      if (!ref.startsWith('refs/') || forge.getObject(sha)?.type !== 'commit') return fail(422, 'Validation Failed: invalid ref or sha');
      repo.refs.set(ref, sha);
      return ok(201, { ref, object: { sha, type: 'commit' } });
    }
    if (seg.length >= 3 && method === 'GET') {
      const ref = `refs/${seg.slice(2).join('/')}`;
      const oid = repo.refs.get(ref);
      if (oid === undefined) return fail(404, 'Not Found');
      return ok(200, { ref, object: { sha: oid, type: forge.getObject(oid)?.type ?? 'commit' } });
    }
    return fail(404, 'Not Found');
  }

  return fail(404, 'Not Found');
}

// ---------------------------------------------------------------------------
// contents

function contentsRoute(forge: Forge, req: RestRequest, repo: Repo, path: string): RestResponse {
  const method = req.method;
  const refParam = req.query.get('ref');
  const branchTipOf = (branch: string): string | undefined => refCommit(forge, repo, `refs/heads/${branch}`);

  if (method === 'GET') {
    let commit: string | undefined;
    if (refParam !== null && refParam !== '') {
      commit = branchTipOf(refParam) ?? (forge.getObject(refParam)?.type === 'commit' ? refParam : undefined);
    } else {
      commit = branchTipOf(repo.defaultBranch);
    }
    if (commit === undefined) return fail(404, 'Not Found');
    const tree = parseCommit(forge.getObject(commit)?.data as Buffer).tree;
    if (path === '') {
      return ok(200, dirListing(forge, tree, ''));
    }
    // Walk to the target.
    const parts = path.split('/');
    let currentTree = tree;
    for (let i = 0; i < parts.length; i += 1) {
      const entries = parseTree(forge.getObject(currentTree)?.data ?? Buffer.alloc(0));
      const entry = entries.find((candidate) => candidate.name === parts[i]);
      if (entry === undefined) return fail(404, 'Not Found');
      const isLast = i === parts.length - 1;
      if (!isLast) {
        if (entry.mode !== '40000' && entry.mode !== '040000') return fail(404, 'Not Found');
        currentTree = entry.oid;
        continue;
      }
      if (entry.mode === '40000' || entry.mode === '040000') {
        return ok(200, dirListing(forge, entry.oid, path));
      }
      const blob = forge.getObject(entry.oid);
      if (blob === undefined) return fail(404, 'Not Found');
      return ok(200, {
        type: 'file',
        encoding: 'base64',
        content: blob.data.toString('base64'),
        name: entry.name,
        path,
        sha: entry.oid,
        size: blob.data.length,
      });
    }
    return fail(404, 'Not Found');
  }

  if (method === 'PUT') {
    const body = parseJsonBody(req);
    if (path === '') return fail(422, 'Validation Failed: path is required');
    const message = stringField(body, 'message') || 'update file';
    const contentBase64 = stringField(body, 'content');
    const branch = stringField(body, 'branch') || repo.defaultBranch;
    const tip = branchTipOf(branch);
    const files = filesAtCommit(forge, tip);
    const existing = files.get(path);
    const givenSha = typeof body.sha === 'string' ? body.sha : undefined;
    if (existing !== undefined) {
      if (givenSha === undefined) return fail(422, 'Validation Failed: sha is required when updating a file');
      if (givenSha !== existing.oid) return fail(409, 'Conflict: the sha does not match the current file');
    }
    const blobOid = forge.storeBlob(Buffer.from(contentBase64, 'base64'));
    files.set(path, { mode: '100644', oid: blobOid });
    const commit = commitFiles(forge, files, tip === undefined ? [] : [tip], message);
    repo.refs.set(`refs/heads/${branch}`, commit);
    const status = existing === undefined ? 201 : 200;
    return ok(status, {
      content: { type: 'file', encoding: 'base64', name: path.split('/').pop(), path, sha: blobOid, size: Buffer.from(contentBase64, 'base64').length },
      commit: { sha: commit, message },
    });
  }

  if (method === 'DELETE') {
    const body = parseJsonBody(req);
    if (path === '') return fail(422, 'Validation Failed: path is required');
    const message = stringField(body, 'message') || 'delete file';
    const branch = stringField(body, 'branch') || repo.defaultBranch;
    const tip = branchTipOf(branch);
    if (tip === undefined) return fail(404, 'Not Found');
    const files = filesAtCommit(forge, tip);
    const existing = files.get(path);
    if (existing === undefined) return fail(404, 'Not Found');
    const givenSha = typeof body.sha === 'string' ? body.sha : undefined;
    if (givenSha !== undefined && givenSha !== existing.oid) return fail(409, 'Conflict: the sha does not match the current file');
    files.delete(path);
    const commit = commitFiles(forge, files, [tip], message);
    repo.refs.set(`refs/heads/${branch}`, commit);
    return ok(200, { content: null, commit: { sha: commit, message } });
  }

  return fail(404, 'Not Found');
}

function dirListing(forge: Forge, treeOid: string, basePath: string): Record<string, unknown>[] {
  const object = forge.getObject(treeOid);
  if (object === undefined || object.type !== 'tree') return [];
  return parseTree(object.data).map((entry) => {
    const isDir = entry.mode === '40000' || entry.mode === '040000';
    const entryPath = basePath === '' ? entry.name : `${basePath}/${entry.name}`;
    const size = isDir ? 0 : (forge.getObject(entry.oid)?.data.length ?? 0);
    return { type: isDir ? 'dir' : 'file', name: entry.name, path: entryPath, sha: entry.oid, size };
  });
}

export { flattenTree };

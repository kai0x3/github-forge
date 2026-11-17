// service.ts — the operations every surface shares: creating issues and pull requests, commenting
// and the squash merge. REST, GraphQL and MCP all call these, so an object created on one surface
// is the same object on the others, with the same id.

import {
  type Forge,
  type Issue,
  type Pull,
  type Repo,
  commitFiles,
  diffFileMaps,
  filesAtCommit,
  isAncestor,
  mergeBase,
  mergeFileMaps,
  nextTimestamp,
  refCommit,
  resolveRef,
  type FileChange,
} from './forge.ts';

export class ServiceError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export function createIssue(forge: Forge, repo: Repo, title: string, body: string, labels: string[], author: string): Issue {
  for (const label of labels) {
    if (!repo.labels.has(label)) throw new ServiceError(422, `Validation Failed: label '${label}' does not exist`);
  }
  const stamp = nextTimestamp();
  const issue: Issue = {
    id: forge.nextIssueId(),
    number: repo.nextNumber,
    title,
    body,
    state: 'open',
    labels: [...labels],
    author,
    createdSec: stamp.sec,
    createdAt: stamp.iso,
    updatedAt: stamp.iso,
  };
  repo.nextNumber += 1;
  repo.issues.set(issue.number, issue);
  return issue;
}

export function addComment(forge: Forge, repo: Repo, number: number, body: string, author: string): { id: number; body: string } {
  const stamp = nextTimestamp();
  const comment = { id: forge.nextCommentId(), body, author, createdAt: stamp.iso, updatedAt: stamp.iso };
  const list = repo.comments.get(number) ?? [];
  list.push(comment);
  repo.comments.set(number, list);
  return comment;
}

/** The branch name a head/base argument names: "feature" or "owner:feature" both mean the branch. */
export function branchNameOf(ref: string): string {
  const colon = ref.indexOf(':');
  return colon >= 0 ? ref.slice(colon + 1) : ref;
}

export function createPull(forge: Forge, repo: Repo, title: string, body: string, head: string, base: string, author: string): Pull {
  const headRef = branchNameOf(head);
  const baseRef = branchNameOf(base);
  if (resolveRef(forge, repo, `refs/heads/${headRef}`) === undefined) {
    throw new ServiceError(422, `Validation Failed: head ref '${head}' does not name a branch`);
  }
  if (resolveRef(forge, repo, `refs/heads/${baseRef}`) === undefined) {
    throw new ServiceError(422, `Validation Failed: base ref '${base}' does not name a branch`);
  }
  const stamp = nextTimestamp();
  const pull: Pull = {
    id: forge.nextIssueId(),
    number: repo.nextNumber,
    title,
    body,
    state: 'open',
    headRef,
    baseRef,
    merged: false,
    mergedAt: null,
    mergeCommitSha: null,
    author,
    createdSec: stamp.sec,
    createdAt: stamp.iso,
    updatedAt: stamp.iso,
  };
  repo.nextNumber += 1;
  repo.pulls.set(pull.number, pull);
  return pull;
}

/** The three-way view of a pull request: merge base, head files, base files. */
export function pullMergeView(forge: Forge, repo: Repo, pull: Pull): { base: string | null; headTip: string; baseTip: string } {
  const headTip = resolveRef(forge, repo, `refs/heads/${pull.headRef}`);
  const baseTip = resolveRef(forge, repo, `refs/heads/${pull.baseRef}`);
  if (headTip === undefined || baseTip === undefined) return { base: null, headTip: headTip ?? '', baseTip: baseTip ?? '' };
  return { base: mergeBase(forge, baseTip, headTip), headTip, baseTip };
}

export function pullIsConflicted(forge: Forge, repo: Repo, pull: Pull): boolean {
  if (pull.state !== 'open') return false;
  const { base, headTip, baseTip } = pullMergeView(forge, repo, pull);
  if (base === null || headTip === '' || baseTip === '') return true;
  if (isAncestor(forge, headTip, baseTip)) return false; // already up to date
  const outcome = mergeFileMaps(filesAtCommit(forge, base), filesAtCommit(forge, baseTip), filesAtCommit(forge, headTip));
  return outcome.conflict;
}

export function pullFiles(forge: Forge, repo: Repo, pull: Pull): FileChange[] {
  const { base, headTip } = pullMergeView(forge, repo, pull);
  if (base === null || headTip === '') return [];
  return diffFileMaps(forge, filesAtCommit(forge, base), filesAtCommit(forge, headTip));
}

/**
 * Squash-merge a pull request onto its base branch: one commit whose tree is the three-way merge
 * of the merge base, the base tip and the head tip, with the base tip as its only parent.
 * Throws ServiceError 405 when the merge conflicts, 404/422 for the other refusal shapes.
 */
export function squashMerge(forge: Forge, repo: Repo, pull: Pull): string {
  if (pull.state !== 'open') throw new ServiceError(405, 'Pull Request is not mergeable');
  const { base, headTip, baseTip } = pullMergeView(forge, repo, pull);
  if (base === null || headTip === '' || baseTip === '') throw new ServiceError(405, 'Pull Request is not mergeable');
  let mergedFiles;
  if (isAncestor(forge, headTip, baseTip)) {
    mergedFiles = filesAtCommit(forge, baseTip);
  } else {
    const outcome = mergeFileMaps(filesAtCommit(forge, base), filesAtCommit(forge, baseTip), filesAtCommit(forge, headTip));
    if (outcome.conflict) throw new ServiceError(405, 'Pull Request is not mergeable: merge conflict');
    mergedFiles = outcome.files;
  }
  const message = `${pull.title} (#${pull.number})\n\n${pull.body}`;
  const sha = commitFiles(forge, mergedFiles, [baseTip], message);
  repo.refs.set(`refs/heads/${pull.baseRef}`, sha);
  const stamp = nextTimestamp();
  pull.state = 'closed';
  pull.merged = true;
  pull.mergedAt = stamp.iso;
  pull.mergeCommitSha = sha;
  pull.updatedAt = stamp.iso;
  return sha;
}

/** The tip commit of a branch (through tags), for the head/base sha fields. */
export function branchTip(forge: Forge, repo: Repo, branch: string): string {
  return refCommit(forge, repo, `refs/heads/${branch}`) ?? resolveRef(forge, repo, branch) ?? '';
}

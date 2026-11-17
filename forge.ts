// forge.ts — the forge's core: an in-memory store shared by every surface (git smart HTTP, REST,
// GraphQL and MCP), plus the git object model (blobs, trees, commits, tags), packfile reading and
// writing, ancestry walks and the three-way tree merge the squash merge is built on.
//
// Everything lives in Maps in this process: repositories keyed by "owner/name", objects keyed by
// their SHA-1. No filesystem, no subprocess, no git binary — the object formats are implemented
// here from the protocol's own rules.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

export const ZERO_OID = '0'.repeat(40);
/** The login the trial's bearer token owns; repositories created through the API belong to it. */
export const OWNER_LOGIN = 'adaiversen';
export const OWNER_ID = 1000;

export type GitObjectType = 'blob' | 'tree' | 'commit' | 'tag';

export interface GitObject {
  type: GitObjectType;
  data: Buffer;
}

export function hashObject(type: GitObjectType, data: Buffer): string {
  const header = Buffer.from(`${type} ${data.length}\0`, 'utf8');
  return createHash('sha1').update(header).update(data).digest('hex');
}

export function isOid(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{40}$/.test(value);
}

// ---------------------------------------------------------------------------
// timestamps: deterministic, from a monotonic counter (never the wall clock),
// so two runs of the same trial leave byte-identical exports.

const EPOCH_SEC = 1_700_000_000;
let clockSeq = 0;

export function nextTimestamp(): { sec: number; iso: string } {
  clockSeq += 1;
  const sec = EPOCH_SEC + clockSeq;
  return { sec, iso: new Date(sec * 1000).toISOString() };
}

// ---------------------------------------------------------------------------
// the store

export interface Label {
  id: number;
  name: string;
  color: string;
}

export interface Issue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  author: string;
  createdSec: number;
  createdAt: string;
  updatedAt: string;
}

export interface Pull {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  headRef: string;
  baseRef: string;
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  author: string;
  createdSec: number;
  createdAt: string;
  updatedAt: string;
}

export interface Comment {
  id: number;
  body: string;
  author: string;
  createdAt: string;
  updatedAt: string;
}

export interface Repo {
  id: number;
  owner: string;
  name: string;
  isPrivate: boolean;
  description: string;
  defaultBranch: string;
  refs: Map<string, string>;
  labels: Map<string, Label>;
  issues: Map<number, Issue>;
  pulls: Map<number, Pull>;
  comments: Map<number, Comment[]>;
  nextNumber: number;
  createdAt: string;
}

export class Forge {
  readonly objects = new Map<string, GitObject>();
  readonly repos = new Map<string, Repo>();
  private repoSeq = 0;
  private issueSeq = 0;
  private commentSeq = 0;
  private labelSeq = 0;

  repoKey(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(this.repoKey(owner, name));
  }

  createRepo(owner: string, name: string, isPrivate: boolean, description: string): Repo {
    this.repoSeq += 1;
    const repo: Repo = {
      id: this.repoSeq,
      owner,
      name,
      isPrivate,
      description,
      defaultBranch: 'main',
      refs: new Map(),
      labels: new Map(),
      issues: new Map(),
      pulls: new Map(),
      comments: new Map(),
      nextNumber: 1,
      createdAt: nextTimestamp().iso,
    };
    this.repos.set(this.repoKey(owner, name), repo);
    return repo;
  }

  deleteRepo(owner: string, name: string): boolean {
    return this.repos.delete(this.repoKey(owner, name));
  }

  listRepos(owner: string): Repo[] {
    const out: Repo[] = [];
    for (const repo of this.repos.values()) if (repo.owner === owner) out.push(repo);
    out.sort((a, b) => a.id - b.id);
    return out;
  }

  nextIssueId(): number {
    this.issueSeq += 1;
    return this.issueSeq;
  }

  nextCommentId(): number {
    this.commentSeq += 1;
    return this.commentSeq;
  }

  nextLabelId(): number {
    this.labelSeq += 1;
    return this.labelSeq;
  }

  // ------------------------------------------------------------- objects

  storeObject(type: GitObjectType, data: Buffer): string {
    const oid = hashObject(type, data);
    if (!this.objects.has(oid)) this.objects.set(oid, { type, data });
    return oid;
  }

  getObject(oid: string): GitObject | undefined {
    return this.objects.get(oid);
  }

  storeBlob(content: Buffer): string {
    return this.storeObject('blob', content);
  }
}

// ---------------------------------------------------------------------------
// trees

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    if (space < 0) break;
    const mode = data.subarray(offset, space).toString('utf8');
    const nul = data.indexOf(0, space + 1);
    if (nul < 0) break;
    const name = data.subarray(space + 1, nul).toString('utf8');
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    offset = nul + 21;
  }
  return entries;
}

/** Git's tree order: entries sort by name, directories as if the name ended in '/'. */
function treeSortKey(entry: TreeEntry): string {
  return entry.mode === '40000' || entry.mode === '040000' ? `${entry.name}/` : entry.name;
}

export function buildTree(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => (treeSortKey(a) < treeSortKey(b) ? -1 : treeSortKey(a) > treeSortKey(b) ? 1 : 0));
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

/** Flatten a tree (recursively) into path -> {mode, oid}. */
export function flattenTree(forge: Forge, treeOid: string, prefix = '', out = new Map<string, { mode: string; oid: string }>()): Map<string, { mode: string; oid: string }> {
  const object = forge.getObject(treeOid);
  if (object === undefined || object.type !== 'tree') return out;
  for (const entry of parseTree(object.data)) {
    const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.mode === '40000' || entry.mode === '040000') flattenTree(forge, entry.oid, path, out);
    else out.set(path, { mode: entry.mode, oid: entry.oid });
  }
  return out;
}

/** Build (and store) nested trees from a flattened path map; returns the root tree oid. */
export function unflattenTree(forge: Forge, files: ReadonlyMap<string, { mode: string; oid: string }>): string {
  interface Dir {
    files: Map<string, { mode: string; oid: string }>;
    dirs: Map<string, Dir>;
  }
  const root: Dir = { files: new Map(), dirs: new Map() };
  for (const [path, file] of files) {
    const parts = path.split('/');
    let dir = root;
    for (let i = 0; i < parts.length - 1; i += 1) {
      const part = parts[i] as string;
      let next = dir.dirs.get(part);
      if (next === undefined) {
        next = { files: new Map(), dirs: new Map() };
        dir.dirs.set(part, next);
      }
      dir = next;
    }
    dir.files.set(parts[parts.length - 1] as string, file);
  }
  const build = (dir: Dir): string => {
    const entries: TreeEntry[] = [];
    for (const [name, file] of dir.files) entries.push({ mode: file.mode, name, oid: file.oid });
    for (const [name, sub] of dir.dirs) entries.push({ mode: '40000', name, oid: build(sub) });
    return forge.storeObject('tree', buildTree(entries));
  };
  return build(root);
}

// ---------------------------------------------------------------------------
// commits

export interface CommitView {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

export function parseCommit(data: Buffer): CommitView {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const header = split < 0 ? text : text.slice(0, split);
  const message = split < 0 ? '' : text.slice(split + 2);
  let tree = ZERO_OID;
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of header.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) author = line.slice(7);
    else if (line.startsWith('committer ')) committer = line.slice(10);
  }
  return { tree, parents, author, committer, message };
}

const FORGE_IDENTITY = 'Forge <forge@make.fun>';

export function buildCommitData(tree: string, parents: readonly string[], message: string, sec: number): Buffer {
  const stamp = `${FORGE_IDENTITY} ${sec} +0000`;
  let text = `tree ${tree}\n`;
  for (const parent of parents) text += `parent ${parent}\n`;
  text += `author ${stamp}\ncommitter ${stamp}\n\n${message}`;
  return Buffer.from(text, 'utf8');
}

/** Create a commit on top of a flattened file map and store every object it needs. */
export function commitFiles(forge: Forge, files: ReadonlyMap<string, { mode: string; oid: string }>, parents: readonly string[], message: string): string {
  const tree = unflattenTree(forge, files);
  const data = buildCommitData(tree, parents, message, nextTimestamp().sec);
  return forge.storeObject('commit', data);
}

// ---------------------------------------------------------------------------
// ancestry and reachability

export function commitParents(forge: Forge, oid: string): string[] {
  const object = forge.getObject(oid);
  if (object === undefined || object.type !== 'commit') return [];
  return parseCommit(object.data).parents;
}

/** True when `ancestor` is reachable from `descendant` by walking parents (or equal). */
export function isAncestor(forge: Forge, ancestor: string, descendant: string): boolean {
  if (ancestor === descendant) return true;
  const seen = new Set<string>();
  const queue = [descendant];
  while (queue.length > 0) {
    const current = queue.pop() as string;
    if (current === ancestor) return true;
    if (seen.has(current)) continue;
    seen.add(current);
    for (const parent of commitParents(forge, current)) queue.push(parent);
  }
  return false;
}

/** All commits reachable from `tip`, with their generation distance from it (BFS). */
export function commitDistances(forge: Forge, tips: readonly string[]): Map<string, number> {
  const distance = new Map<string, number>();
  let frontier = [...tips];
  for (const tip of frontier) if (!distance.has(tip)) distance.set(tip, 0);
  let depth = 0;
  while (frontier.length > 0) {
    const next: string[] = [];
    for (const commit of frontier) {
      for (const parent of commitParents(forge, commit)) {
        if (!distance.has(parent)) {
          distance.set(parent, depth + 1);
          next.push(parent);
        }
      }
    }
    frontier = next;
    depth += 1;
  }
  return distance;
}

/**
 * Every object (commit, tree, blob, tag) reachable from the given commit set. When `limit` is
 * given, the parent walk stays inside it: commits outside the limit contribute nothing, which is
 * what a shallow fetch (and a shallow client's have-set) means.
 */
export function reachableObjects(forge: Forge, commits: ReadonlySet<string>, limit?: ReadonlySet<string>): Set<string> {
  const out = new Set<string>();
  const stack: string[] = [];
  const pushTree = (treeOid: string): void => {
    if (out.has(treeOid)) return;
    const object = forge.getObject(treeOid);
    if (object === undefined || object.type !== 'tree') return;
    out.add(treeOid);
    for (const entry of parseTree(object.data)) {
      if (entry.mode === '40000' || entry.mode === '040000') pushTree(entry.oid);
      else out.add(entry.oid);
    }
  };
  for (const commit of commits) stack.push(commit);
  const seenCommits = new Set<string>();
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    if (seenCommits.has(oid)) continue;
    seenCommits.add(oid);
    if (limit !== undefined && !limit.has(oid)) continue;
    const object = forge.getObject(oid);
    if (object === undefined || object.type !== 'commit') continue;
    out.add(oid);
    const view = parseCommit(object.data);
    pushTree(view.tree);
    for (const parent of view.parents) stack.push(parent);
  }
  return out;
}

/** A merge base of two commits: a common ancestor with the greatest generation depth. */
export function mergeBase(forge: Forge, a: string, b: string): string | null {
  const fromA = commitDistances(forge, [a]);
  const fromB = commitDistances(forge, [b]);
  let best: string | null = null;
  let bestScore = Number.POSITIVE_INFINITY;
  for (const [commit, distA] of fromA) {
    const distB = fromB.get(commit);
    if (distB === undefined) continue;
    const score = distA + distB;
    if (score < bestScore) {
      bestScore = score;
      best = commit;
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// three-way merge of flattened trees (the squash merge and the mergeability probe)

export interface MergeOutcome {
  conflict: boolean;
  files: Map<string, { mode: string; oid: string }>;
}

export function mergeFileMaps(
  base: ReadonlyMap<string, { mode: string; oid: string }>,
  ours: ReadonlyMap<string, { mode: string; oid: string }>,
  theirs: ReadonlyMap<string, { mode: string; oid: string }>,
): MergeOutcome {
  const files = new Map<string, { mode: string; oid: string }>();
  const paths = new Set<string>([...base.keys(), ...ours.keys(), ...theirs.keys()]);
  let conflict = false;
  const same = (x: { mode: string; oid: string } | undefined, y: { mode: string; oid: string } | undefined): boolean =>
    (x === undefined && y === undefined) || (x !== undefined && y !== undefined && x.oid === y.oid && x.mode === y.mode);
  for (const path of paths) {
    const b = base.get(path);
    const o = ours.get(path);
    const t = theirs.get(path);
    if (same(o, t)) {
      if (o !== undefined) files.set(path, o);
    } else if (same(b, o)) {
      if (t !== undefined) files.set(path, t);
    } else if (same(b, t)) {
      if (o !== undefined) files.set(path, o);
    } else {
      conflict = true;
    }
  }
  return { conflict, files };
}

/** The flattened file map at a commit (empty map for a missing/unborn commit). */
export function filesAtCommit(forge: Forge, commitOid: string | undefined): Map<string, { mode: string; oid: string }> {
  if (commitOid === undefined || commitOid === ZERO_OID) return new Map();
  const object = forge.getObject(commitOid);
  if (object === undefined || object.type !== 'commit') return new Map();
  return flattenTree(forge, parseCommit(object.data).tree);
}

/** The diff between two commits' file maps, GitHub "files" style. */
export interface FileChange {
  filename: string;
  status: 'added' | 'modified' | 'removed' | 'renamed';
  additions: number;
  deletions: number;
  changes: number;
}

function countLines(data: Buffer): number {
  if (data.length === 0) return 0;
  let lines = 0;
  for (const byte of data) if (byte === 0x0a) lines += 1;
  return data[data.length - 1] === 0x0a ? lines : lines + 1;
}

/** A simple line-level diff count: lines only in the new blob are additions, only in the old deletions. */
export function diffFileMaps(
  forge: Forge,
  from: ReadonlyMap<string, { mode: string; oid: string }>,
  to: ReadonlyMap<string, { mode: string; oid: string }>,
): FileChange[] {
  const changes: FileChange[] = [];
  const paths = new Set<string>([...from.keys(), ...to.keys()]);
  for (const path of [...paths].sort()) {
    const before = from.get(path);
    const after = to.get(path);
    if (before !== undefined && after !== undefined && before.oid === after.oid) continue;
    const oldLines = before === undefined ? [] : (forge.getObject(before.oid)?.data.toString('utf8') ?? '').split('\n');
    const newLines = after === undefined ? [] : (forge.getObject(after.oid)?.data.toString('utf8') ?? '').split('\n');
    let additions = 0;
    let deletions = 0;
    if (before === undefined) additions = countLines(forge.getObject(after?.oid ?? '')?.data ?? Buffer.alloc(0));
    else if (after === undefined) deletions = countLines(forge.getObject(before.oid)?.data ?? Buffer.alloc(0));
    else {
      // Multiset difference of lines: good enough for the counts the API reports.
      const remaining = new Map<string, number>();
      for (const line of oldLines) remaining.set(line, (remaining.get(line) ?? 0) + 1);
      for (const line of newLines) {
        const count = remaining.get(line) ?? 0;
        if (count > 0) remaining.set(line, count - 1);
        else additions += 1;
      }
      for (const count of remaining.values()) deletions += count;
      if (additions === 0 && deletions === 0) additions = 1;
    }
    changes.push({
      filename: path,
      status: before === undefined ? 'added' : after === undefined ? 'removed' : 'modified',
      additions,
      deletions,
      changes: additions + deletions,
    });
  }
  return changes;
}

// ---------------------------------------------------------------------------
// packfiles

const TYPE_CODES: Record<GitObjectType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPES: Record<number, GitObjectType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

/** Write a version-2 pack holding the given objects, plain (no deltas). */
export function writePack(forge: Forge, oids: readonly string[]): Buffer {
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(oids.length, 8);
  parts.push(header);
  for (const oid of oids) {
    const object = forge.getObject(oid);
    if (object === undefined) continue;
    const code = TYPE_CODES[object.type];
    const size = object.data.length;
    const bytes: number[] = [];
    let first = (code << 4) | (size & 0x0f);
    let rest = Math.floor(size / 16);
    if (rest > 0) first |= 0x80;
    bytes.push(first);
    while (rest > 0) {
      let byte = rest & 0x7f;
      rest = Math.floor(rest / 128);
      if (rest > 0) byte |= 0x80;
      bytes.push(byte);
    }
    parts.push(Buffer.from(bytes));
    parts.push(deflateSync(object.data));
  }
  const body = Buffer.concat(parts);
  const trailer = createHash('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
}

function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let offset = 0;
  const readSize = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const byte = delta[offset] as number;
      offset += 1;
      value += (byte & 0x7f) * 2 ** shift;
      shift += 7;
      if ((byte & 0x80) === 0) break;
    }
    return value;
  };
  const sourceSize = readSize();
  if (sourceSize !== base.length) throw new Error('delta base size mismatch');
  const targetSize = readSize();
  const out = Buffer.alloc(targetSize);
  let written = 0;
  while (offset < delta.length) {
    const op = delta[offset] as number;
    offset += 1;
    if (op & 0x80) {
      let copyOffset = 0;
      let copySize = 0;
      let shift = 0;
      for (let bit = 0; bit < 4; bit += 1) {
        if (op & (1 << bit)) copyOffset += (delta[offset++] as number) * 2 ** shift;
        shift += 8;
      }
      shift = 0;
      for (let bit = 4; bit < 7; bit += 1) {
        if (op & (1 << bit)) copySize += (delta[offset++] as number) * 2 ** shift;
        shift += 8;
      }
      if (copySize === 0) copySize = 0x10000;
      base.copy(out, written, copyOffset, copyOffset + copySize);
      written += copySize;
    } else if (op !== 0) {
      const literal = op & 0x7f;
      delta.copy(out, written, offset, offset + literal);
      offset += literal;
      written += literal;
    } else {
      throw new Error('delta opcode 0');
    }
  }
  if (written !== targetSize) throw new Error('delta size mismatch');
  return out;
}

/**
 * Read a packfile into the store, resolving OFS_DELTA and REF_DELTA against the pack itself and
 * the objects the store already holds (a thin pack's bases). Returns the object ids it stored.
 */
export function readPackInto(forge: Forge, pack: Buffer): string[] {
  if (pack.length < 32 || pack.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('not a packfile');
  const count = pack.readUInt32BE(8);
  interface Raw {
    offset: number;
    typeCode: number;
    data: Buffer;
    baseOid?: string;
    baseOffset?: number;
  }
  const raws: Raw[] = [];
  let offset = 12;
  for (let i = 0; i < count; i += 1) {
    const start = offset;
    let byte = pack[offset] as number;
    offset += 1;
    const typeCode = (byte >> 4) & 0x07;
    let size = byte & 0x0f;
    let shift = 4;
    while (byte & 0x80) {
      byte = pack[offset] as number;
      offset += 1;
      size += (byte & 0x7f) * 2 ** shift;
      shift += 7;
    }
    let baseOid: string | undefined;
    let baseOffset: number | undefined;
    if (typeCode === 6) {
      byte = pack[offset] as number;
      offset += 1;
      let value = byte & 0x7f;
      while (byte & 0x80) {
        byte = pack[offset] as number;
        offset += 1;
        value = (value + 1) * 128 + (byte & 0x7f);
      }
      baseOffset = start - value;
    } else if (typeCode === 7) {
      baseOid = pack.subarray(offset, offset + 20).toString('hex');
      offset += 20;
    }
    const inflated = inflateSync(pack.subarray(offset), { info: true }) as unknown as { buffer: Buffer; engine: { bytesWritten: number } };
    offset += inflated.engine.bytesWritten;
    if (inflated.buffer.length !== size) throw new Error('pack object size mismatch');
    raws.push({ offset: start, typeCode, data: inflated.buffer, baseOid, baseOffset });
  }
  const byOffset = new Map<number, Raw>();
  for (const raw of raws) byOffset.set(raw.offset, raw);
  const resolved = new Map<number, { type: GitObjectType; oid: string }>();
  const stored: string[] = [];
  const resolve = (raw: Raw): { type: GitObjectType; oid: string } => {
    const cached = resolved.get(raw.offset);
    if (cached !== undefined) return cached;
    let result: { type: GitObjectType; oid: string };
    if (raw.typeCode === 6 || raw.typeCode === 7) {
      let baseType: GitObjectType;
      let baseData: Buffer;
      if (raw.typeCode === 6) {
        const baseRaw = byOffset.get(raw.baseOffset as number);
        if (baseRaw === undefined) throw new Error('ofs-delta base missing');
        const baseResolved = resolve(baseRaw);
        baseType = baseResolved.type;
        baseData = forge.getObject(baseResolved.oid)?.data as Buffer;
      } else {
        const base = forge.getObject(raw.baseOid as string);
        if (base === undefined) throw new Error('ref-delta base missing');
        baseType = base.type;
        baseData = base.data;
      }
      const data = applyDelta(baseData, raw.data);
      result = { type: baseType, oid: forge.storeObject(baseType, data) };
    } else {
      const type = CODE_TYPES[raw.typeCode];
      if (type === undefined) throw new Error(`unknown pack type ${raw.typeCode}`);
      result = { type, oid: forge.storeObject(type, raw.data) };
    }
    resolved.set(raw.offset, result);
    stored.push(result.oid);
    return result;
  };
  for (const raw of raws) resolve(raw);
  return stored;
}

// ---------------------------------------------------------------------------
// refs helpers

/** The oid a ref name points at, resolving annotated tags to their target when peeled. */
export function peelToCommit(forge: Forge, oid: string): string {
  let current = oid;
  for (let guard = 0; guard < 16; guard += 1) {
    const object = forge.getObject(current);
    if (object === undefined || object.type !== 'tag') return current;
    const match = /^object ([0-9a-f]{40})$/m.exec(object.data.toString('utf8'));
    if (match === null) return current;
    current = match[1] as string;
  }
  return current;
}

/** The commit oid a ref points at (through tags), or undefined when the ref is unknown. */
export function refCommit(forge: Forge, repo: Repo, refName: string): string | undefined {
  const oid = repo.refs.get(refName);
  if (oid === undefined) return undefined;
  return peelToCommit(forge, oid);
}

/** Resolve a branch name, full ref, or raw commit id to a commit oid. */
export function resolveRef(forge: Forge, repo: Repo, ref: string): string | undefined {
  if (repo.refs.has(ref)) return refCommit(forge, repo, ref);
  const branchRef = `refs/heads/${ref}`;
  if (repo.refs.has(branchRef)) return refCommit(forge, repo, branchRef);
  if (isOid(ref) && forge.getObject(ref)?.type === 'commit') return ref;
  return undefined;
}

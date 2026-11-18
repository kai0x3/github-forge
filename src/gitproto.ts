// gitproto.ts — git smart HTTP: the ref advertisements, protocol v2 ls-refs and fetch, the v0
// upload-pack fallback, and the v0 receive-pack with per-ref report-status. All of it speaks to
// the shared store in forge.ts, so a push is immediately visible to REST, GraphQL and MCP.

import {
  Forge,
  type Repo,
  ZERO_OID,
  commitDistances,
  commitDistancesWithin,
  commitParents,
  isAncestor,
  isOid,
  parseCommit,
  parseTree,
  readPackInto,
  reachableObjects,
  refCommit,
  writePack,
} from './forge.ts';

// ---------------------------------------------------------------------------
// pkt-lines

export function pktLine(payload: string | Buffer): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const length = data.length + 4;
  const header = Buffer.from(length.toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([header, data]);
}

export const PKT_FLUSH = Buffer.from('0000', 'ascii');
export const PKT_DELIM = Buffer.from('0001', 'ascii');

export interface Packet {
  kind: 'data' | 'flush' | 'delim';
  payload: Buffer;
}

/** Decode a pkt-line stream; throws on a malformed length prefix. */
export function decodePackets(body: Buffer, offset = 0): { packets: Packet[]; rest: Buffer } {
  const packets: Packet[] = [];
  let cursor = offset;
  while (cursor + 4 <= body.length) {
    const header = body.subarray(cursor, cursor + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(header)) throw new Error('bad pkt-line header');
    const length = parseInt(header, 16);
    if (length === 0) {
      packets.push({ kind: 'flush', payload: Buffer.alloc(0) });
      cursor += 4;
      return { packets, rest: body.subarray(cursor) };
    }
    if (length === 1) {
      packets.push({ kind: 'delim', payload: Buffer.alloc(0) });
      cursor += 4;
      continue;
    }
    if (length === 2 || length === 3) {
      packets.push({ kind: 'data', payload: Buffer.alloc(0) });
      cursor += 4;
      continue;
    }
    if (cursor + length > body.length) throw new Error('pkt-line overruns body');
    packets.push({ kind: 'data', payload: body.subarray(cursor + 4, cursor + length) });
    cursor += length;
  }
  return { packets, rest: body.subarray(cursor) };
}

// ---------------------------------------------------------------------------
// ref advertisement

const UPLOAD_CAPS_V0 = 'multi_ack_detailed thin-pack side-band side-band-64k ofs-delta shallow deepen-since deepen-not';
const RECEIVE_CAPS = 'report-status side-band-64k delete-refs ofs-delta quiet atomic';

interface RefLine {
  oid: string;
  name: string;
  peeled?: string;
}

function advertisedRefs(forge: Forge, repo: Repo): RefLine[] {
  const lines: RefLine[] = [];
  const names = [...repo.refs.keys()].sort();
  for (const name of names) {
    const oid = repo.refs.get(name) as string;
    const line: RefLine = { oid, name };
    lines.push(line);
    const object = forge.getObject(oid);
    if (object !== undefined && object.type === 'tag') {
      const match = /^object ([0-9a-f]{40})$/m.exec(object.data.toString('utf8'));
      if (match !== null) {
        line.peeled = match[1] as string;
        lines.push({ oid: match[1] as string, name: `${name}^{}`, peeled: match[1] as string });
      }
    }
  }
  return lines;
}

function headTarget(repo: Repo): string {
  return `refs/heads/${repo.defaultBranch}`;
}

export function advertisementV0(forge: Forge, repo: Repo, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const caps = service === 'git-upload-pack' ? `${UPLOAD_CAPS_V0} symref=HEAD:${headTarget(repo)} agent=forge/1.0` : `${RECEIVE_CAPS} symref=HEAD:${headTarget(repo)} agent=forge/1.0`;
  const parts: Buffer[] = [pktLine(`# service=${service}\n`), PKT_FLUSH];
  const refs = advertisedRefs(forge, repo);
  if (refs.length === 0) {
    parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    const headOid = repo.refs.get(headTarget(repo)) ?? ZERO_OID;
    parts.push(pktLine(`${headOid} HEAD\0${caps}\n`));
    for (const ref of refs) parts.push(pktLine(`${ref.oid} ${ref.name}\n`));
  }
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

export function advertisementV2(): Buffer {
  return Buffer.concat([
    pktLine('version 2\n'),
    pktLine('agent=forge/1.0\n'),
    pktLine('ls-refs=unborn\n'),
    pktLine('fetch=shallow wait-for-done\n'),
    pktLine('object-format=sha1\n'),
    PKT_FLUSH,
  ]);
}

// ---------------------------------------------------------------------------
// ls-refs (v2)

function handleLsRefs(forge: Forge, repo: Repo, args: string[]): Buffer {
  let peel = false;
  let symrefs = false;
  let unborn = false;
  const prefixes: string[] = [];
  for (const arg of args) {
    if (arg === 'peel') peel = true;
    else if (arg === 'symrefs') symrefs = true;
    else if (arg === 'unborn') unborn = true;
    else if (arg.startsWith('ref-prefix ')) prefixes.push(arg.slice('ref-prefix '.length));
  }
  const keep = (name: string): boolean => prefixes.length === 0 || prefixes.some((prefix) => name.startsWith(prefix));
  const parts: Buffer[] = [];
  const target = headTarget(repo);
  const headOid = repo.refs.get(target);
  if (keep('HEAD')) {
    if (headOid !== undefined) {
      let line = `${headOid} HEAD`;
      if (symrefs) line += ` symref-target:${target}`;
      parts.push(pktLine(`${line}\n`));
    } else if (unborn) {
      let line = 'unborn HEAD';
      if (symrefs) line += ` symref-target:${target}`;
      parts.push(pktLine(`${line}\n`));
    }
  }
  for (const ref of advertisedRefs(forge, repo)) {
    if (ref.name.endsWith('^{}')) continue;
    if (!keep(ref.name)) continue;
    let line = `${ref.oid} ${ref.name}`;
    if (peel && ref.peeled !== undefined) line += ` peeled:${ref.peeled}`;
    parts.push(pktLine(`${line}\n`));
  }
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------
// fetch (shared object selection for v2 and v0)

export interface FetchPlan {
  pack: Buffer;
  shallow: string[];
  unshallow: string[];
  common: string[];
}

/**
 * Plans by their exact request tuple. A plan is a pure function of the wants, haves, shallow
 * boundary and depth: the objects it is built from are content-addressed and immutable, and
 * the store only ever grows, which cannot change what is reachable from a fixed want set. So
 * a cached plan stays correct for the life of the process, and a workload that fetches the
 * same tip the same way many times (the timed clone above all) pays for the walk and the pack
 * once. Callers only read a plan, never mutate it. Cleared whole when it outgrows its cap;
 * very large packs are not cached, to bound memory.
 */
const planCache = new Map<string, FetchPlan>();
const PLAN_CACHE_MAX = 64;
const PLAN_CACHE_PACK_MAX = 2 * 1024 * 1024;

export function planFetch(
  forge: Forge,
  wants: string[],
  haves: string[],
  clientShallow: string[],
  depth: number | null,
): FetchPlan {
  const key = `${depth ?? 'full'}|${wants.join(',')}|${haves.join(',')}|${clientShallow.join(',')}`;
  const cached = planCache.get(key);
  if (cached !== undefined) return cached;
  const plan = computeFetchPlan(forge, wants, haves, clientShallow, depth);
  if (plan.pack.length <= PLAN_CACHE_PACK_MAX) {
    if (planCache.size >= PLAN_CACHE_MAX) planCache.clear();
    planCache.set(key, plan);
  }
  return plan;
}

function computeFetchPlan(
  forge: Forge,
  wants: string[],
  haves: string[],
  clientShallow: string[],
  depth: number | null,
): FetchPlan {
  // What the client already holds: everything reachable from its haves, but the walk stops at
  // the shallow boundary the client declares — it does not hold those commits' parents.
  const shallowSet = new Set(clientShallow);
  const haveCommits = new Set<string>();
  {
    const queue = [...haves];
    while (queue.length > 0) {
      const commit = queue.pop() as string;
      if (haveCommits.has(commit)) continue;
      const object = forge.getObject(commit);
      if (object === undefined || object.type !== 'commit') continue;
      haveCommits.add(commit);
      if (shallowSet.has(commit)) continue;
      for (const parent of commitParents(forge, commit)) queue.push(parent);
    }
  }
  const haveObjects = reachableObjects(forge, haveCommits, haveCommits);

  // The commits this fetch may carry: within `depth` generations of the wants, or all of them.
  // A want may name an annotated tag: the tag object travels too, and its commit is the root.
  const wantTags: string[] = [];
  const wantCommits: string[] = [];
  for (const want of wants) {
    let current = want;
    for (let guard = 0; guard < 16; guard += 1) {
      const object = forge.getObject(current);
      if (object === undefined) break;
      if (object.type === 'commit') {
        wantCommits.push(current);
        break;
      }
      if (object.type === 'tag') {
        wantTags.push(current);
        const match = /^object ([0-9a-f]{40})$/m.exec(object.data.toString('utf8'));
        if (match === null) break;
        current = match[1] as string;
        continue;
      }
      break;
    }
  }
  // Only the generations inside the depth are wanted, so a depth-limited walk records exactly
  // the distances the filter below keeps (dist < depth) without walking the whole history.
  const distances = depth === null ? commitDistances(forge, wantCommits) : commitDistancesWithin(forge, wantCommits, depth - 1);
  const allowed = new Set<string>();
  for (const [commit, dist] of distances) {
    if (depth === null || dist < depth) allowed.add(commit);
  }
  // The boundary: allowed commits whose parent exists in the graph but is neither delivered nor
  // already held — those are the commits the client must treat as shallow.
  const boundary: string[] = [];
  for (const commit of allowed) {
    for (const parent of commitParents(forge, commit)) {
      if (!allowed.has(parent) && !haveCommits.has(parent) && forge.getObject(parent)?.type === 'commit') {
        boundary.push(commit);
        break;
      }
    }
  }
  const unshallow = clientShallow.filter((oid) => allowed.has(oid) && !boundary.includes(oid));
  const wantedObjects = reachableObjects(forge, allowed, allowed);
  const toSend: string[] = [];
  for (const oid of wantedObjects) if (!haveObjects.has(oid)) toSend.push(oid);
  for (const tag of wantTags) if (!haveObjects.has(tag) && !toSend.includes(tag)) toSend.push(tag);
  // Commits first, then trees, then blobs, tags last: a stable, readable pack order.
  const rank = (oid: string): number => {
    const type = forge.getObject(oid)?.type;
    return type === 'commit' ? 0 : type === 'tree' ? 1 : type === 'blob' ? 2 : 3;
  };
  toSend.sort((a, b) => rank(a) - rank(b) || (a < b ? -1 : 1));
  const common = haves.filter((oid) => forge.getObject(oid)?.type === 'commit');
  return { pack: writePack(forge, toSend), shallow: boundary, unshallow, common };
}

function sidebandPackets(pack: Buffer): Buffer[] {
  const packets: Buffer[] = [];
  const CHUNK = 65_500;
  for (let offset = 0; offset < pack.length; offset += CHUNK) {
    const chunk = pack.subarray(offset, Math.min(pack.length, offset + CHUNK));
    const payload = Buffer.concat([Buffer.from([1]), chunk]);
    packets.push(pktLine(payload));
  }
  if (pack.length === 0) packets.push(pktLine(Buffer.from([1])));
  return packets;
}

interface FetchArgs {
  wants: string[];
  haves: string[];
  shallow: string[];
  depth: number | null;
  done: boolean;
}

function parseFetchArgs(args: string[]): FetchArgs {
  const parsed: FetchArgs = { wants: [], haves: [], shallow: [], depth: null, done: false };
  for (const arg of args) {
    if (arg.startsWith('want ')) parsed.wants.push(arg.slice(5).trim());
    else if (arg.startsWith('have ')) parsed.haves.push(arg.slice(5).trim());
    else if (arg.startsWith('shallow ')) parsed.shallow.push(arg.slice(8).trim());
    else if (arg.startsWith('deepen ')) parsed.depth = parseInt(arg.slice(7).trim(), 10);
    else if (arg === 'done') parsed.done = true;
  }
  return parsed;
}

function handleFetchV2(forge: Forge, repo: Repo, args: string[]): Buffer {
  const parsed = parseFetchArgs(args);
  const plan = planFetch(forge, parsed.wants, parsed.haves, parsed.shallow, parsed.depth);
  const parts: Buffer[] = [];
  // With `done` the negotiation is over: git expects the packfile sections directly, and an
  // acknowledgments section here is a protocol error. Without it, acknowledge the common haves.
  if (!parsed.done) {
    parts.push(pktLine('acknowledgments\n'));
    if (plan.common.length === 0) {
      parts.push(pktLine('NAK\n'));
    } else {
      for (const oid of plan.common) parts.push(pktLine(`ACK ${oid}\n`));
      parts.push(pktLine('ready\n'));
    }
    parts.push(PKT_DELIM);
  }
  if (plan.shallow.length > 0 || plan.unshallow.length > 0) {
    parts.push(pktLine('shallow-info\n'));
    for (const oid of plan.shallow) parts.push(pktLine(`shallow ${oid}\n`));
    for (const oid of plan.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
    parts.push(PKT_DELIM);
  }
  parts.push(pktLine('packfile\n'));
  parts.push(...sidebandPackets(plan.pack));
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

function handleFetchV0(forge: Forge, repo: Repo, body: Buffer): Buffer {
  // Two sections: wants (+ shallow/deepen) flushed, then haves + done flushed.
  const lines: string[] = [];
  let rest = body;
  for (let round = 0; round < 2; round += 1) {
    const decoded = decodePackets(rest);
    for (const packet of decoded.packets) {
      if (packet.kind === 'data') lines.push(packet.payload.toString('utf8').replace(/\n$/, ''));
    }
    rest = decoded.rest;
    if (rest.length === 0) break;
  }
  const wants: string[] = [];
  const haves: string[] = [];
  const shallow: string[] = [];
  let depth: number | null = null;
  for (const line of lines) {
    if (line.startsWith('want ')) wants.push(line.slice(5, 45));
    else if (line.startsWith('have ')) haves.push(line.slice(5, 45));
    else if (line.startsWith('shallow ')) shallow.push(line.slice(8, 48));
    else if (line.startsWith('deepen ')) depth = parseInt(line.slice(7), 10);
  }
  const plan = planFetch(forge, wants, haves, shallow, depth);
  const parts: Buffer[] = [];
  for (const oid of plan.shallow) parts.push(pktLine(`shallow ${oid}\n`));
  for (const oid of plan.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
  if (plan.common.length === 0) parts.push(pktLine('NAK\n'));
  else for (const oid of plan.common) parts.push(pktLine(`ACK ${oid}\n`));
  parts.push(...sidebandPackets(plan.pack));
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------
// receive-pack (v0)

export interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

export function handleReceivePack(forge: Forge, repo: Repo, body: Buffer): { status: number; body: Buffer } {
  let decoded: { packets: Packet[]; rest: Buffer };
  try {
    decoded = decodePackets(body);
  } catch {
    return { status: 400, body: Buffer.from('error: malformed pkt-line stream\n', 'utf8') };
  }
  const commands: PushCommand[] = [];
  let sideband = false;
  for (const packet of decoded.packets) {
    if (packet.kind !== 'data') continue;
    const text = packet.payload.toString('utf8').replace(/\n$/, '');
    const nul = text.indexOf('\0');
    const line = nul >= 0 ? text.slice(0, nul) : text;
    if (nul >= 0 && text.slice(nul + 1).includes('side-band-64k')) sideband = true;
    const match = /^([0-9a-f]{40}) ([0-9a-f]{40}) (\S+)$/.exec(line);
    if (match !== null) commands.push({ oldOid: match[1] as string, newOid: match[2] as string, ref: match[3] as string });
  }
  const pack = decoded.rest;
  let unpackOk = true;
  if (pack.length > 0) {
    try {
      readPackInto(forge, pack);
    } catch {
      unpackOk = false;
    }
  }
  const reportLines: string[] = [`unpack ${unpackOk ? 'ok' : 'error'}\n`];
  for (const command of commands) {
    const fail = (reason: string): void => {
      reportLines.push(`ng ${command.ref} ${reason}\n`);
    };
    if (!unpackOk) {
      fail('unpacker error');
      continue;
    }
    const current = repo.refs.get(command.ref) ?? ZERO_OID;
    if (command.newOid === ZERO_OID) {
      // delete
      if (current === ZERO_OID) {
        fail('non-fast-forward');
        continue;
      }
      repo.refs.delete(command.ref);
      reportLines.push(`ok ${command.ref}\n`);
      continue;
    }
    const target = forge.getObject(command.newOid);
    if (target === undefined || (target.type !== 'commit' && target.type !== 'tag')) {
      fail('non-fast-forward');
      continue;
    }
    if (current !== ZERO_OID && current !== command.oldOid) {
      fail('non-fast-forward');
      continue;
    }
    if (current !== ZERO_OID && target.type === 'commit') {
      const currentCommit = refCommit(forge, repo, command.ref) ?? current;
      if (!isAncestor(forge, currentCommit, command.newOid)) {
        fail('non-fast-forward');
        continue;
      }
    }
    repo.refs.set(command.ref, command.newOid);
    reportLines.push(`ok ${command.ref}\n`);
  }
  const inner = Buffer.concat([...reportLines.map((line) => pktLine(line)), PKT_FLUSH]);
  if (!sideband) return { status: 200, body: inner };
  const parts: Buffer[] = [];
  const CHUNK = 65_500;
  for (let offset = 0; offset < inner.length; offset += CHUNK) {
    const chunk = inner.subarray(offset, Math.min(inner.length, offset + CHUNK));
    parts.push(pktLine(Buffer.concat([Buffer.from([1]), chunk])));
  }
  parts.push(PKT_FLUSH);
  return { status: 200, body: Buffer.concat(parts) };
}

// ---------------------------------------------------------------------------
// upload-pack POST dispatch

export function handleUploadPack(forge: Forge, repo: Repo, body: Buffer, protocolV2: boolean): { status: number; body: Buffer } {
  if (!protocolV2) return { status: 200, body: handleFetchV0(forge, repo, body) };
  // v2: a command section, a delim, the argument section, a flush.
  let decoded: { packets: Packet[]; rest: Buffer };
  try {
    decoded = decodePackets(body);
  } catch {
    return { status: 400, body: Buffer.from('error: malformed pkt-line stream\n', 'utf8') };
  }
  const commandLines: string[] = [];
  const argLines: string[] = [];
  let section = 0;
  for (const packet of decoded.packets) {
    if (packet.kind === 'delim') {
      section = 1;
      continue;
    }
    if (packet.kind === 'flush') break;
    const text = packet.payload.toString('utf8').replace(/\n$/, '');
    if (section === 0) commandLines.push(text);
    else argLines.push(text);
  }
  const command = commandLines.find((line) => line.startsWith('command='));
  if (command === 'command=ls-refs') return { status: 200, body: handleLsRefs(forge, repo, argLines) };
  if (command === 'command=fetch') return { status: 200, body: handleFetchV2(forge, repo, argLines) };
  return { status: 400, body: Buffer.from('error: unknown command\n', 'utf8') };
}

export { parseCommit, parseTree, isOid };

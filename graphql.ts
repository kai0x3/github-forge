// graphql.ts — the GraphQL v4 surface at /api/graphql: a small hand-written parser and executor
// covering the documents gh and github-mcp-server send — viewer, repository, issues connections
// with cursor pagination, pull requests, the createIssue / closeIssue / createPullRequest /
// mergePullRequest / addComment mutations, node(id:) and the __type introspection the probes use.
// It executes against the same store as REST, so ids and objects agree across surfaces.

import type { Forge, Issue, Pull, Repo } from './forge.ts';
import { ServiceError, addComment, branchTip, createIssue, createPull, pullFiles, pullIsConflicted, squashMerge } from './service.ts';

// ---------------------------------------------------------------------------
// global ids: opaque, stable, decodable by this server only.

export function globalId(type: string, key: string): string {
  return Buffer.from(`${type}:${key}`, 'utf8').toString('base64');
}

export function decodeGlobalId(id: string): { type: string; key: string } | null {
  try {
    const text = Buffer.from(id, 'base64').toString('utf8');
    const colon = text.indexOf(':');
    if (colon < 0) return null;
    return { type: text.slice(0, colon), key: text.slice(colon + 1) };
  } catch {
    return null;
  }
}

const repoGlobalId = (repo: Repo): string => globalId('Repository', String(repo.id));
const issueGlobalId = (repo: Repo, issue: Issue): string => globalId('Issue', `${repo.id}:${issue.number}`);
const pullGlobalId = (repo: Repo, pull: Pull): string => globalId('PullRequest', `${repo.id}:${pull.number}`);
const commentGlobalId = (id: number): string => globalId('IssueComment', String(id));

// ---------------------------------------------------------------------------
// tokenizer + parser

type Token = { kind: 'name' | 'string' | 'int' | 'float' | 'punct' | 'spread'; value: string };

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < source.length) {
    const ch = source[i] as string;
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',') {
      i += 1;
      continue;
    }
    if (ch === '#') {
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    if (source.startsWith('...', i)) {
      tokens.push({ kind: 'spread', value: '...' });
      i += 3;
      continue;
    }
    if ('!$():=@[]{}|'.includes(ch)) {
      tokens.push({ kind: 'punct', value: ch });
      i += 1;
      continue;
    }
    if (ch === '"') {
      if (source.startsWith('"""', i)) {
        const end = source.indexOf('"""', i + 3);
        tokens.push({ kind: 'string', value: source.slice(i + 3, end < 0 ? source.length : end) });
        i = end < 0 ? source.length : end + 3;
        continue;
      }
      let value = '';
      i += 1;
      while (i < source.length && source[i] !== '"') {
        if (source[i] === '\\' && i + 1 < source.length) {
          const esc = source[i + 1] as string;
          value += esc === 'n' ? '\n' : esc === 't' ? '\t' : esc === 'r' ? '\r' : esc;
          i += 2;
        } else {
          value += source[i];
          i += 1;
        }
      }
      i += 1;
      tokens.push({ kind: 'string', value });
      continue;
    }
    if (/[0-9-]/.test(ch)) {
      let j = i;
      while (j < source.length && /[0-9.eE+-]/.test(source[j] as string)) j += 1;
      const raw = source.slice(i, j);
      tokens.push({ kind: raw.includes('.') || raw.includes('e') || raw.includes('E') ? 'float' : 'int', value: raw });
      i = j;
      continue;
    }
    if (/[_A-Za-z]/.test(ch)) {
      let j = i;
      while (j < source.length && /[_0-9A-Za-z]/.test(source[j] as string)) j += 1;
      tokens.push({ kind: 'name', value: source.slice(i, j) });
      i = j;
      continue;
    }
    i += 1;
  }
  return tokens;
}

type Value =
  | { kind: 'var'; name: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'bool'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; items: Value[] }
  | { kind: 'object'; fields: Map<string, Value> };

interface FieldNode {
  name: string;
  alias?: string;
  args: Map<string, Value>;
  selections: FieldNode[];
  fragmentSpread?: string;
  inlineType?: string;
}

interface Operation {
  type: 'query' | 'mutation';
  name?: string;
  selections: FieldNode[];
}

interface Document {
  operations: Operation[];
  fragments: Map<string, { typeCondition: string; selections: FieldNode[] }>;
}

class Parser {
  private tokens: Token[];
  private pos = 0;

  constructor(source: string) {
    this.tokens = tokenize(source);
  }

  private peek(): Token | undefined {
    return this.tokens[this.pos];
  }

  private next(): Token {
    const token = this.tokens[this.pos] as Token;
    this.pos += 1;
    return token;
  }

  private expect(value: string): void {
    const token = this.next();
    if (token === undefined || token.value !== value) throw new Error(`expected '${value}'`);
  }

  parseDocument(): Document {
    const operations: Operation[] = [];
    const fragments = new Map<string, { typeCondition: string; selections: FieldNode[] }>();
    while (this.pos < this.tokens.length) {
      const token = this.peek() as Token;
      if (token.value === '{') {
        operations.push({ type: 'query', selections: this.parseSelectionSet() });
      } else if (token.kind === 'name' && (token.value === 'query' || token.value === 'mutation')) {
        const type = this.next().value as 'query' | 'mutation';
        let name: string | undefined;
        if (this.peek()?.kind === 'name') name = this.next().value;
        if (this.peek()?.value === '(') this.skipParens();
        // directives
        while (this.peek()?.value === '@') {
          this.next();
          this.next();
          if (this.peek()?.value === '(') this.skipParens();
        }
        operations.push({ type, name, selections: this.parseSelectionSet() });
      } else if (token.kind === 'name' && token.value === 'fragment') {
        this.next();
        const fragName = this.next().value;
        this.expect('on');
        const typeCondition = this.next().value;
        const selections = this.parseSelectionSet();
        fragments.set(fragName, { typeCondition, selections });
      } else {
        this.next();
      }
    }
    return { operations, fragments };
  }

  private skipParens(): void {
    let depth = 0;
    do {
      const token = this.next();
      if (token === undefined) break;
      if (token.value === '(') depth += 1;
      else if (token.value === ')') depth -= 1;
    } while (depth > 0);
  }

  private parseSelectionSet(): FieldNode[] {
    this.expect('{');
    const fields: FieldNode[] = [];
    while (this.peek() !== undefined && this.peek()?.value !== '}') {
      fields.push(this.parseField());
    }
    this.expect('}');
    return fields;
  }

  private parseField(): FieldNode {
    const token = this.peek() as Token;
    if (token.kind === 'spread') {
      this.next();
      const next = this.peek() as Token;
      if (next.kind === 'name' && next.value === 'on') {
        this.next();
        const type = this.next().value;
        return { name: '', args: new Map(), selections: this.parseSelectionSet(), inlineType: type };
      }
      return { name: '', args: new Map(), selections: [], fragmentSpread: this.next().value };
    }
    let name = this.next().value;
    let alias: string | undefined;
    if (this.peek()?.value === ':') {
      this.next();
      alias = name;
      name = this.next().value;
    }
    const args = new Map<string, Value>();
    if (this.peek()?.value === '(') {
      this.next();
      while (this.peek()?.value !== ')') {
        const argName = this.next().value;
        this.expect(':');
        args.set(argName, this.parseValue());
      }
      this.next();
    }
    while (this.peek()?.value === '@') {
      this.next();
      this.next();
      if (this.peek()?.value === '(') this.skipParens();
    }
    let selections: FieldNode[] = [];
    if (this.peek()?.value === '{') selections = this.parseSelectionSet();
    return { name, alias, args, selections };
  }

  private parseValue(): Value {
    const token = this.next();
    if (token.kind === 'punct' && token.value === '$') return { kind: 'var', name: this.next().value };
    if (token.kind === 'string') return { kind: 'string', value: token.value };
    if (token.kind === 'int') return { kind: 'int', value: parseInt(token.value, 10) };
    if (token.kind === 'float') return { kind: 'float', value: parseFloat(token.value) };
    if (token.kind === 'punct' && token.value === '[') {
      const items: Value[] = [];
      while (this.peek()?.value !== ']') items.push(this.parseValue());
      this.next();
      return { kind: 'list', items };
    }
    if (token.kind === 'punct' && token.value === '{') {
      const fields = new Map<string, Value>();
      while (this.peek()?.value !== '}') {
        const fieldName = this.next().value;
        this.expect(':');
        fields.set(fieldName, this.parseValue());
      }
      this.next();
      return { kind: 'object', fields };
    }
    if (token.kind === 'name') {
      if (token.value === 'true') return { kind: 'bool', value: true };
      if (token.value === 'false') return { kind: 'bool', value: false };
      if (token.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: token.value };
    }
    return { kind: 'null' };
  }
}

function resolveValue(value: Value, variables: Record<string, unknown>): unknown {
  switch (value.kind) {
    case 'var':
      return variables[value.name];
    case 'string':
    case 'int':
    case 'float':
    case 'bool':
    case 'enum':
      return value.value;
    case 'null':
      return null;
    case 'list':
      return value.items.map((item) => resolveValue(item, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const [key, item] of value.fields) out[key] = resolveValue(item, variables);
      return out;
    }
  }
}

// ---------------------------------------------------------------------------
// schema tables (for introspection and unknown-field validation)

const TYPE_FIELDS: Record<string, string[]> = {
  Query: ['viewer', 'repository', 'node', 'rateLimit', '__type', '__schema', '__typename'],
  Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment', '__typename'],
  User: ['login', 'id', 'name', '__typename'],
  Repository: [
    'id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission',
    'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'description', 'isPrivate',
    'url', 'createdAt', '__typename',
  ],
  Issue: ['id', 'databaseId', 'number', 'title', 'state', 'body', 'author', 'labels', 'comments', 'createdAt', 'updatedAt', 'url', '__typename'],
  PullRequest: [
    'id', 'databaseId', 'number', 'title', 'body', 'state', 'merged', 'mergeable', 'headRefName',
    'baseRefName', 'headRef', 'baseRef', 'files', 'author', 'createdAt', 'updatedAt', 'url', '__typename',
  ],
  Ref: ['name', 'target', 'prefix', '__typename'],
  Label: ['id', 'name', 'color', '__typename'],
  IssueComment: ['id', 'body', 'author', 'createdAt', '__typename'],
  IssueConnection: ['nodes', 'edges', 'pageInfo', 'totalCount', '__typename'],
  PullRequestConnection: ['nodes', 'edges', 'pageInfo', 'totalCount', '__typename'],
  PullRequestFileConnection: ['nodes', 'edges', 'pageInfo', 'totalCount', '__typename'],
  PullRequestChangedFile: ['path', 'additions', 'deletions', 'changeType', '__typename'],
  PageInfo: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor', '__typename'],
  CreateIssuePayload: ['issue', 'clientMutationId', '__typename'],
  CloseIssuePayload: ['issue', 'clientMutationId', '__typename'],
  CreatePullRequestPayload: ['pullRequest', 'clientMutationId', '__typename'],
  MergePullRequestPayload: ['pullRequest', 'clientMutationId', '__typename'],
  AddCommentPayload: ['commentEdge', 'clientMutationId', 'subject', '__typename'],
  IssueEdge: ['node', 'cursor', '__typename'],
  CommentEdge: ['node', 'cursor', '__typename'],
};

const ENUM_VALUES: Record<string, string[]> = {
  SearchType: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION'],
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  RepositoryPermission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
};

// ---------------------------------------------------------------------------
// execution

interface Ctx {
  forge: Forge;
  ownerLogin: string;
  variables: Record<string, unknown>;
  errors: { message: string }[];
  fragments: Map<string, { typeCondition: string; selections: FieldNode[] }>;
}

type Node =
  | { type: 'User'; login: string }
  | { type: 'Repository'; repo: Repo }
  | { type: 'Issue'; repo: Repo; issue: Issue }
  | { type: 'PullRequest'; repo: Repo; pull: Pull }
  | { type: 'Ref'; name: string }
  | { type: 'TypeInfo'; name: string }
  | { type: 'FieldInfo'; name: string }
  | { type: 'EnumInfo'; name: string }
  | { type: 'Connection'; kind: 'issues' | 'pulls' | 'files'; items: unknown[]; total: number }
  | { type: 'PageInfo'; hasNextPage: boolean; endCursor: string | null }
  | { type: 'Payload'; mutation: string; value: unknown }
  | { type: 'CommentEdge'; comment: { id: number; body: string } }
  | { type: 'IssueComment'; comment: { id: number; body: string } }
  | { type: 'ChangedFile'; path: string; additions: number; deletions: number };

function cursorOf(index: number): string {
  return Buffer.from(`cursor:${index}`, 'utf8').toString('base64');
}

function indexOfCursor(after: unknown): number {
  if (typeof after !== 'string' || after === '') return -1;
  try {
    const text = Buffer.from(after, 'base64').toString('utf8');
    const match = /^cursor:(\d+)$/.exec(text);
    return match === null ? -1 : parseInt(match[1] as string, 10);
  } catch {
    return -1;
  }
}

function executeSelections(ctx: Ctx, typeName: string, node: unknown, selections: FieldNode[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const field of selections) {
    if (field.fragmentSpread !== undefined) {
      const fragment = ctx.fragments.get(field.fragmentSpread);
      if (fragment !== undefined) Object.assign(out, executeSelections(ctx, typeName, node, fragment.selections));
      continue;
    }
    if (field.inlineType !== undefined) {
      if (field.inlineType === typeName) Object.assign(out, executeSelections(ctx, typeName, node, field.selections));
      continue;
    }
    const key = field.alias ?? field.name;
    out[key] = executeField(ctx, typeName, node, field);
  }
  return out;
}

function argsOf(ctx: Ctx, field: FieldNode): Record<string, unknown> {
  const args: Record<string, unknown> = {};
  for (const [name, value] of field.args) args[name] = resolveValue(value, ctx.variables);
  return args;
}

function unknownField(ctx: Ctx, typeName: string, field: FieldNode): null {
  ctx.errors.push({ message: `Field '${field.name}' doesn't exist on type '${typeName}'` });
  return null;
}

function executeField(ctx: Ctx, typeName: string, node: unknown, field: FieldNode): unknown {
  const forge = ctx.forge;
  const args = argsOf(ctx, field);
  const name = field.name;
  if (name === '__typename') return typeName;
  if (name === '__type') {
    const typeNameArg = typeof args.name === 'string' ? args.name : '';
    return executeSelections(ctx, 'TypeInfo', { type: 'TypeInfo', name: typeNameArg } satisfies Node, field.selections);
  }
  if (name === '__schema') return { types: [], queryType: { name: 'Query' }, mutationType: { name: 'Mutation' } };

  const known = TYPE_FIELDS[typeName];
  if (known !== undefined && !known.includes(name)) return unknownField(ctx, typeName, field);

  // Mutation payloads share one node shape under five type names.
  if (typeof node === 'object' && node !== null && (node as { type?: string }).type === 'Payload') {
    return executePayloadField(ctx, node as { mutation: string; value: unknown }, name, field);
  }

  switch (typeName) {
    case 'Query': {
      if (name === 'viewer') return executeSelections(ctx, 'User', { type: 'User', login: ctx.ownerLogin } satisfies Node, field.selections);
      if (name === 'repository') {
        const repo = forge.getRepo(String(args.owner ?? ''), String(args.name ?? ''));
        if (repo === undefined) return null;
        return executeSelections(ctx, 'Repository', { type: 'Repository', repo } satisfies Node, field.selections);
      }
      if (name === 'node') {
        const target = nodeByGlobalId(ctx, String(args.id ?? ''));
        if (target === null) return null;
        return executeSelections(ctx, target.type, target, field.selections);
      }
      if (name === 'rateLimit') return { limit: 5000, cost: 1, remaining: 4999 };
      return unknownField(ctx, typeName, field);
    }
    case 'Mutation':
      return executeMutation(ctx, name, args, field);
    case 'User': {
      const user = node as { login: string };
      if (name === 'login') return user.login;
      if (name === 'id') return globalId('User', user.login);
      if (name === 'name') return user.login;
      return unknownField(ctx, typeName, field);
    }
    case 'TypeInfo': {
      const info = node as { name: string };
      if (name === 'name') return info.name;
      if (name === 'kind') return ENUM_VALUES[info.name] !== undefined ? 'ENUM' : 'OBJECT';
      if (name === 'fields') {
        const fields = TYPE_FIELDS[info.name] ?? [];
        return fields.filter((f) => f !== '__typename').map((f) => executeSelections(ctx, 'FieldInfo', { type: 'FieldInfo', name: f } satisfies Node, field.selections));
      }
      if (name === 'enumValues') {
        const values = ENUM_VALUES[info.name] ?? [];
        return values.map((v) => executeSelections(ctx, 'EnumInfo', { type: 'EnumInfo', name: v } satisfies Node, field.selections));
      }
      return null;
    }
    case 'FieldInfo':
    case 'EnumInfo': {
      if (name === 'name') return (node as { name: string }).name;
      if (name === 'description') return null;
      if (name === 'isDeprecated') return false;
      if (name === 'deprecationReason') return null;
      return null;
    }
    case 'Repository':
      return executeRepositoryField(ctx, node as { repo: Repo }, name, args, field);
    case 'Issue': {
      const { repo, issue } = node as { repo: Repo; issue: Issue };
      switch (name) {
        case 'id': return issueGlobalId(repo, issue);
        case 'databaseId': return issue.id;
        case 'number': return issue.number;
        case 'title': return issue.title;
        case 'body': return issue.body;
        case 'state': return issue.state.toUpperCase();
        case 'createdAt': return issue.createdAt;
        case 'updatedAt': return issue.updatedAt;
        case 'url': return `https://github.com/${repo.owner}/${repo.name}/issues/${issue.number}`;
        default: return unknownField(ctx, typeName, field);
      }
    }
    case 'PullRequest': {
      const { repo, pull } = node as { repo: Repo; pull: Pull };
      switch (name) {
        case 'id': return pullGlobalId(repo, pull);
        case 'databaseId': return pull.id;
        case 'number': return pull.number;
        case 'title': return pull.title;
        case 'body': return pull.body;
        case 'state': return pull.merged ? 'MERGED' : pull.state.toUpperCase();
        case 'merged': return pull.merged;
        case 'mergeable': return pull.state !== 'open' ? 'UNKNOWN' : pullIsConflicted(forge, repo, pull) ? 'CONFLICTING' : 'MERGEABLE';
        case 'headRefName': return pull.headRef;
        case 'baseRefName': return pull.baseRef;
        case 'createdAt': return pull.createdAt;
        case 'updatedAt': return pull.updatedAt;
        case 'files': {
          const files = pullFiles(forge, repo, pull).map((file) => ({ type: 'ChangedFile', path: file.filename, additions: file.additions, deletions: file.deletions }) as Node);
          return executeConnection(ctx, 'files', files, args, field);
        }
        default: return unknownField(ctx, typeName, field);
      }
    }
    case 'Ref': {
      if (name === 'name') return (node as { name: string }).name;
      return null;
    }
    case 'PageInfo': {
      const info = node as { hasNextPage: boolean; endCursor: string | null };
      if (name === 'hasNextPage') return info.hasNextPage;
      if (name === 'hasPreviousPage') return false;
      if (name === 'endCursor') return info.endCursor;
      if (name === 'startCursor') return info.endCursor;
      return null;
    }
    case 'Payload':
      return executePayloadField(ctx, node as { mutation: string; value: unknown }, name, field);
    case 'CommentEdge': {
      const edge = node as { comment: { id: number; body: string } };
      if (name === 'node') return executeSelections(ctx, 'IssueComment', { type: 'IssueComment', comment: edge.comment } satisfies Node, field.selections);
      if (name === 'cursor') return cursorOf(0);
      return null;
    }
    case 'IssueComment': {
      const comment = (node as { comment: { id: number; body: string } }).comment;
      if (name === 'id') return commentGlobalId(comment.id);
      if (name === 'body') return comment.body;
      return null;
    }
    case 'ChangedFile': {
      const file = node as { path: string; additions: number; deletions: number };
      if (name === 'path') return file.path;
      if (name === 'additions') return file.additions;
      if (name === 'deletions') return file.deletions;
      if (name === 'changeType') return 'MODIFIED';
      return null;
    }
    default:
      return unknownField(ctx, typeName, field);
  }
}

function executePayloadField(ctx: Ctx, payload: { mutation: string; value: unknown }, name: string, field: FieldNode): unknown {
  if (name === 'clientMutationId') return null;
  const value = payload.value;
  if (typeof value !== 'object' || value === null) return null;
  if (name === 'issue' && 'issue' in value) {
    const v = value as { repo: Repo; issue: Issue };
    return executeSelections(ctx, 'Issue', { type: 'Issue', repo: v.repo, issue: v.issue } satisfies Node, field.selections);
  }
  if (name === 'pullRequest' && 'pull' in value) {
    const v = value as { repo: Repo; pull: Pull };
    return executeSelections(ctx, 'PullRequest', { type: 'PullRequest', repo: v.repo, pull: v.pull } satisfies Node, field.selections);
  }
  if (name === 'commentEdge' && 'comment' in value) {
    const v = value as { comment: { id: number; body: string } };
    return executeSelections(ctx, 'CommentEdge', { type: 'CommentEdge', comment: v.comment } satisfies Node, field.selections);
  }
  return null;
}

function executeRepositoryField(ctx: Ctx, node: { repo: Repo }, name: string, args: Record<string, unknown>, field: FieldNode): unknown {
  const forge = ctx.forge;
  const repo = node.repo;
  switch (name) {
    case 'id': return repoGlobalId(repo);
    case 'databaseId': return repo.id;
    case 'name': return repo.name;
    case 'nameWithOwner': return `${repo.owner}/${repo.name}`;
    case 'description': return repo.description;
    case 'isPrivate': return repo.isPrivate;
    case 'viewerPermission': return 'ADMIN';
    case 'hasIssuesEnabled': return true;
    case 'createdAt': return repo.createdAt;
    case 'owner': return executeSelections(ctx, 'User', { type: 'User', login: repo.owner } satisfies Node, field.selections);
    case 'defaultBranchRef': return executeSelections(ctx, 'Ref', { type: 'Ref', name: repo.defaultBranch } satisfies Node, field.selections);
    case 'issue': {
      const issue = repo.issues.get(typeof args.number === 'number' ? args.number : -1);
      if (issue === undefined) return null;
      return executeSelections(ctx, 'Issue', { type: 'Issue', repo, issue } satisfies Node, field.selections);
    }
    case 'issues': {
      let issues = [...repo.issues.values()];
      const states = Array.isArray(args.states) ? (args.states as unknown[]).map((s) => String(s).toLowerCase()) : null;
      if (states !== null) issues = issues.filter((issue) => states.includes(issue.state));
      const orderBy = (args.orderBy ?? null) as { field?: string; direction?: string } | null;
      const direction = orderBy?.direction === 'ASC' ? 'asc' : 'desc';
      issues.sort((a, b) => (direction === 'asc' ? a.number - b.number : b.number - a.number));
      const nodes = issues.map((issue) => ({ type: 'Issue', repo, issue }) as Node);
      return executeConnection(ctx, 'issues', nodes, args, field);
    }
    case 'pullRequests': {
      let pulls = [...repo.pulls.values()];
      const states = Array.isArray(args.states) ? (args.states as unknown[]).map((s) => String(s).toLowerCase()) : null;
      if (states !== null) pulls = pulls.filter((pull) => states.includes(pull.merged ? 'merged' : pull.state));
      pulls.sort((a, b) => b.number - a.number);
      const nodes = pulls.map((pull) => ({ type: 'PullRequest', repo, pull }) as Node);
      return executeConnection(ctx, 'pulls', nodes, args, field);
    }
    case 'pullRequest': {
      const pull = repo.pulls.get(typeof args.number === 'number' ? args.number : -1);
      if (pull === undefined) return null;
      return executeSelections(ctx, 'PullRequest', { type: 'PullRequest', repo, pull } satisfies Node, field.selections);
    }
    default:
      return unknownField(ctx, 'Repository', field);
  }
}

function executeConnection(ctx: Ctx, kind: 'issues' | 'pulls' | 'files', items: Node[], args: Record<string, unknown>, field: FieldNode): Record<string, unknown> {
  const first = typeof args.first === 'number' ? args.first : items.length;
  const startIndex = indexOfCursor(args.after) + 1;
  const slice = items.slice(startIndex, startIndex + Math.max(0, first));
  const hasNextPage = startIndex + slice.length < items.length;
  const endCursor = slice.length > 0 ? cursorOf(startIndex + slice.length - 1) : null;
  const typeName = kind === 'issues' ? 'IssueConnection' : kind === 'pulls' ? 'PullRequestConnection' : 'PullRequestFileConnection';
  const itemType = kind === 'issues' ? 'Issue' : kind === 'pulls' ? 'PullRequest' : 'ChangedFile';
  const out: Record<string, unknown> = {};
  for (const selection of field.selections) {
    const key = selection.alias ?? selection.name;
    if (selection.name === 'nodes') {
      out[key] = slice.map((item) => executeSelections(ctx, itemType, item, selection.selections));
    } else if (selection.name === 'pageInfo') {
      out[key] = executeSelections(ctx, 'PageInfo', { type: 'PageInfo', hasNextPage, endCursor } satisfies Node, selection.selections);
    } else if (selection.name === 'totalCount') {
      out[key] = items.length;
    } else if (selection.name === 'edges') {
      out[key] = slice.map((item, i) => ({ node: executeSelections(ctx, itemType, item, selection.selections.find((s) => s.name === 'node')?.selections ?? []), cursor: cursorOf(startIndex + i) }));
    } else {
      out[key] = null;
    }
  }
  return out;
}

function repoByGlobalId(ctx: Ctx, id: unknown): Repo | null {
  if (typeof id !== 'string') return null;
  const decoded = decodeGlobalId(id);
  if (decoded !== null && decoded.type === 'Repository') {
    for (const repo of ctx.forge.repos.values()) if (repo.id === parseInt(decoded.key, 10)) return repo;
    return null;
  }
  const numeric = parseInt(id, 10);
  if (!Number.isNaN(numeric)) {
    for (const repo of ctx.forge.repos.values()) if (repo.id === numeric) return repo;
  }
  return null;
}

function nodeByGlobalId(ctx: Ctx, id: string): Node | null {
  const decoded = decodeGlobalId(id);
  if (decoded === null) return null;
  if (decoded.type === 'Repository') {
    const repo = repoByGlobalId(ctx, id);
    return repo === null ? null : ({ type: 'Repository', repo } as Node);
  }
  if (decoded.type === 'Issue' || decoded.type === 'PullRequest') {
    const [repoId, number] = decoded.key.split(':').map((part) => parseInt(part, 10));
    for (const repo of ctx.forge.repos.values()) {
      if (repo.id !== repoId) continue;
      if (decoded.type === 'Issue') {
        const issue = repo.issues.get(number as number);
        if (issue !== undefined) return { type: 'Issue', repo, issue } as Node;
      } else {
        const pull = repo.pulls.get(number as number);
        if (pull !== undefined) return { type: 'PullRequest', repo, pull } as Node;
      }
    }
    return null;
  }
  return null;
}

function executeMutation(ctx: Ctx, name: string, args: Record<string, unknown>, field: FieldNode): unknown {
  const forge = ctx.forge;
  const input = (args.input ?? {}) as Record<string, unknown>;
  const payloadType: Record<string, string> = {
    createIssue: 'CreateIssuePayload',
    closeIssue: 'CloseIssuePayload',
    createPullRequest: 'CreatePullRequestPayload',
    mergePullRequest: 'MergePullRequestPayload',
    addComment: 'AddCommentPayload',
  };
  const typeName = payloadType[name];
  if (typeName === undefined) return unknownField(ctx, 'Mutation', field);
  try {
    if (name === 'createIssue') {
      const repo = repoByGlobalId(ctx, input.repositoryId);
      if (repo === null) throw new ServiceError(404, 'repository not found');
      const labels = Array.isArray(input.labelIds) ? [] : [];
      void labels;
      const issue = createIssue(forge, repo, String(input.title ?? ''), String(input.body ?? ''), [], ctx.ownerLogin);
      return executeSelections(ctx, typeName, { type: 'Payload', mutation: name, value: { repo, issue } } satisfies Node, field.selections);
    }
    if (name === 'closeIssue') {
      const target = nodeByGlobalId(ctx, String(input.issueId ?? ''));
      if (target === null || target.type !== 'Issue') throw new ServiceError(404, 'issue not found');
      target.issue.state = 'closed';
      return executeSelections(ctx, typeName, { type: 'Payload', mutation: name, value: { repo: target.repo, issue: target.issue } } satisfies Node, field.selections);
    }
    if (name === 'createPullRequest') {
      const repo = repoByGlobalId(ctx, input.repositoryId);
      if (repo === null) throw new ServiceError(404, 'repository not found');
      const pull = createPull(forge, repo, String(input.title ?? ''), String(input.body ?? ''), String(input.headRefName ?? ''), String(input.baseRefName ?? ''), ctx.ownerLogin);
      return executeSelections(ctx, typeName, { type: 'Payload', mutation: name, value: { repo, pull } } satisfies Node, field.selections);
    }
    if (name === 'mergePullRequest') {
      const target = nodeByGlobalId(ctx, String(input.pullRequestId ?? ''));
      if (target === null || target.type !== 'PullRequest') throw new ServiceError(404, 'pull request not found');
      squashMerge(forge, target.repo, target.pull);
      return executeSelections(ctx, typeName, { type: 'Payload', mutation: name, value: { repo: target.repo, pull: target.pull } } satisfies Node, field.selections);
    }
    if (name === 'addComment') {
      const target = nodeByGlobalId(ctx, String(input.subjectId ?? ''));
      if (target === null || (target.type !== 'Issue' && target.type !== 'PullRequest')) throw new ServiceError(404, 'subject not found');
      const number = target.type === 'Issue' ? target.issue.number : target.pull.number;
      const comment = addComment(forge, target.repo, number, String(input.body ?? ''), ctx.ownerLogin);
      return executeSelections(ctx, typeName, { type: 'Payload', mutation: name, value: { comment } } satisfies Node, field.selections);
    }
  } catch (error) {
    if (error instanceof ServiceError) {
      ctx.errors.push({ message: error.message });
      return null;
    }
    throw error;
  }
  return null;
}

// ---------------------------------------------------------------------------
// entry point

export interface GraphQLResult {
  data?: Record<string, unknown>;
  errors?: { message: string }[];
}

export function executeGraphQL(forge: Forge, ownerLogin: string, body: unknown): GraphQLResult | GraphQLResult[] {
  if (Array.isArray(body)) return body.map((operation) => runOperation(forge, ownerLogin, operation));
  return runOperation(forge, ownerLogin, body);
}

function runOperation(forge: Forge, ownerLogin: string, body: unknown): GraphQLResult {
  if (typeof body !== 'object' || body === null) return { errors: [{ message: 'invalid request body' }] };
  const request = body as { query?: unknown; variables?: unknown; operationName?: unknown };
  if (typeof request.query !== 'string') return { errors: [{ message: 'query is required' }] };
  const variables = (typeof request.variables === 'object' && request.variables !== null ? request.variables : {}) as Record<string, unknown>;
  let document: Document;
  try {
    document = new Parser(request.query).parseDocument();
  } catch (error) {
    return { errors: [{ message: error instanceof Error ? error.message : 'parse error' }] };
  }
  const operations = document.operations;
  let operation = operations[0];
  if (typeof request.operationName === 'string') {
    operation = operations.find((op) => op.name === request.operationName) ?? operation;
  }
  if (operation === undefined) return { errors: [{ message: 'no operation in document' }] };
  const ctx: Ctx = { forge, ownerLogin, variables, errors: [], fragments: document.fragments };
  const rootType = operation.type === 'mutation' ? 'Mutation' : 'Query';
  const data = executeSelections(ctx, rootType, null, operation.selections);
  const result: GraphQLResult = { data };
  if (ctx.errors.length > 0) result.errors = ctx.errors;
  return result;
}

export { branchTip };

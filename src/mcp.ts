// mcp.ts — the MCP endpoint at /mcp: JSON-RPC 2.0 over Streamable HTTP. It speaks the modern
// 2026-07-28 revision (server/discover, no handshake) and the legacy initialize handshake, offers
// the six forge tools over the same store REST serves, and keeps tools/list byte-identical by
// building it once, here, as a constant.

import type { Forge, Repo } from './forge.ts';
import { issueView, pullView, repoView } from './rest.ts';
import { ServiceError, createIssue, createPull, squashMerge } from './service.ts';

const SERVER_INFO = { name: 'forge-mcp', version: '1.0.0' };
const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26'];

interface ToolDef {
  name: string;
  description: string;
  properties: Record<string, { type: string; description: string }>;
  required: string[];
}

const TOOL_DEFS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository owned by the authenticated user.',
    properties: {
      name: { type: 'string', description: 'The repository name.' },
      description: { type: 'string', description: 'A short description of the repository.' },
      private: { type: 'boolean', description: 'Whether the repository is private.' },
    },
    required: ['name'],
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    properties: {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
    },
    required: ['owner', 'repo'],
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    properties: {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
      title: { type: 'string', description: 'The issue title.' },
      body: { type: 'string', description: 'The issue body.' },
    },
    required: ['owner', 'repo', 'title'],
  },
  {
    name: 'list_issues',
    description: 'List the issues of a repository, optionally filtered by state.',
    properties: {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
      state: { type: 'string', description: 'Filter by state: open, closed or all.' },
    },
    required: ['owner', 'repo'],
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request from a head branch to a base branch.',
    properties: {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
      title: { type: 'string', description: 'The pull request title.' },
      body: { type: 'string', description: 'The pull request body.' },
      head: { type: 'string', description: 'The head branch name.' },
      base: { type: 'string', description: 'The base branch name.' },
    },
    required: ['owner', 'repo', 'title', 'head', 'base'],
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request by number (squash).',
    properties: {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
      pull_number: { type: 'number', description: 'The pull request number.' },
    },
    required: ['owner', 'repo', 'pull_number'],
  },
];

/** The tools/list result, built once: two calls answer byte for byte the same. */
const TOOLS_LIST_RESULT = {
  tools: TOOL_DEFS.map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: { type: 'object', properties: tool.properties, required: tool.required },
  })),
};

export interface McpResponse {
  status: number;
  json?: unknown;
}

function rpcResult(id: unknown, result: unknown): McpResponse {
  return { status: 200, json: { jsonrpc: '2.0', id: id ?? null, result } };
}

function rpcError(id: unknown, code: number, message: string, status = 200): McpResponse {
  return { status, json: { jsonrpc: '2.0', id: id ?? null, error: { code, message } } };
}

function toolResult(value: unknown): Record<string, unknown> {
  return {
    content: [{ type: 'text', text: JSON.stringify(value) }],
    structuredContent: value as Record<string, unknown>,
    isError: false,
  };
}

function toolError(message: string): Record<string, unknown> {
  return { content: [{ type: 'text', text: message }], isError: true };
}

function repoArg(forge: Forge, args: Record<string, unknown>): Repo {
  const owner = typeof args.owner === 'string' ? args.owner : '';
  const name = typeof args.repo === 'string' ? args.repo : typeof args.repository === 'string' ? args.repository : '';
  const repo = forge.getRepo(owner, name);
  if (repo === undefined) throw new ServiceError(404, `repository ${owner}/${name} not found`);
  return repo;
}

function callTool(forge: Forge, ownerLogin: string, name: string, args: Record<string, unknown>): Record<string, unknown> {
  const def = TOOL_DEFS.find((tool) => tool.name === name);
  if (def === undefined) throw new McpInvalidParams(`unknown tool: ${name}`);
  for (const required of def.required) {
    if (args[required] === undefined || args[required] === null || args[required] === '') {
      return toolError(`missing required argument: ${required}`);
    }
  }
  try {
    switch (name) {
      case 'create_repo': {
        const repoName = String(args.name);
        if (forge.getRepo(ownerLogin, repoName) !== undefined) return toolError(`repository ${repoName} already exists`);
        const repo = forge.createRepo(ownerLogin, repoName, args.private === true, typeof args.description === 'string' ? args.description : '');
        return toolResult(repoView(repo));
      }
      case 'get_repo': {
        return toolResult(repoView(repoArg(forge, args)));
      }
      case 'create_issue': {
        const repo = repoArg(forge, args);
        const labels = Array.isArray(args.labels) ? args.labels.filter((x): x is string => typeof x === 'string') : [];
        const issue = createIssue(forge, repo, String(args.title), typeof args.body === 'string' ? args.body : '', labels, ownerLogin);
        return toolResult(issueView(repo, issue));
      }
      case 'list_issues': {
        const repo = repoArg(forge, args);
        let issues = [...repo.issues.values()];
        const state = typeof args.state === 'string' ? args.state : 'open';
        if (state === 'open') issues = issues.filter((issue) => issue.state === 'open');
        else if (state === 'closed') issues = issues.filter((issue) => issue.state === 'closed');
        issues.sort((a, b) => b.number - a.number);
        return toolResult({ issues: issues.map((issue) => issueView(repo, issue)) });
      }
      case 'create_pull_request': {
        const repo = repoArg(forge, args);
        const pull = createPull(forge, repo, String(args.title), typeof args.body === 'string' ? args.body : '', String(args.head), String(args.base), ownerLogin);
        return toolResult(pullView(forge, repo, pull));
      }
      case 'merge_pull_request': {
        const repo = repoArg(forge, args);
        const number = typeof args.pull_number === 'number' ? args.pull_number : parseInt(String(args.pull_number ?? ''), 10);
        const pull = repo.pulls.get(number);
        if (pull === undefined) return toolError(`pull request ${number} not found`);
        const sha = squashMerge(forge, repo, pull);
        return toolResult({ ...pullView(forge, repo, pull), sha, merged: true });
      }
      default:
        throw new McpInvalidParams(`unknown tool: ${name}`);
    }
  } catch (error) {
    if (error instanceof ServiceError) return toolError(error.message);
    throw error;
  }
}

class McpInvalidParams extends Error {}

/** Handle one HTTP POST to /mcp. `rawBody` is the exact request text. */
export function handleMcp(forge: Forge, ownerLogin: string, rawBody: string): McpResponse {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return rpcError(null, -32700, 'Parse error', 400);
  }
  if (Array.isArray(parsed)) {
    const answers = parsed.map((entry) => handleOne(forge, ownerLogin, entry));
    const first = answers.find((answer) => answer !== null);
    if (first === undefined || first === null) return { status: 202 };
    return { status: 200, json: answers.filter((answer) => answer !== null).map((answer) => (answer as McpResponse).json) };
  }
  const answer = handleOne(forge, ownerLogin, parsed);
  if (answer === null) return { status: 202 };
  return answer;
}

/** One JSON-RPC message; null for a notification (answered 202 with no body). */
function handleOne(forge: Forge, ownerLogin: string, message: unknown): McpResponse | null {
  if (typeof message !== 'object' || message === null) return rpcError(null, -32600, 'Invalid Request');
  const request = message as { id?: unknown; method?: unknown; params?: unknown };
  const isNotification = request.id === undefined;
  const method = typeof request.method === 'string' ? request.method : '';
  const params = (typeof request.params === 'object' && request.params !== null ? request.params : {}) as Record<string, unknown>;

  switch (method) {
    case 'server/discover':
      return rpcResult(request.id, {
        resultType: 'complete',
        supportedVersions: SUPPORTED_VERSIONS,
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
        _meta: { 'io.modelcontextprotocol/serverInfo': SERVER_INFO },
      });
    case 'initialize': {
      const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : '2025-11-25';
      const negotiated = SUPPORTED_VERSIONS.includes(requested) ? requested : '2025-11-25';
      return rpcResult(request.id, {
        protocolVersion: negotiated,
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
      });
    }
    case 'ping':
      return rpcResult(request.id, {});
    case 'tools/list':
      return rpcResult(request.id, TOOLS_LIST_RESULT);
    case 'tools/call': {
      const toolName = typeof params.name === 'string' ? params.name : '';
      const args = (typeof params.arguments === 'object' && params.arguments !== null ? params.arguments : {}) as Record<string, unknown>;
      try {
        return rpcResult(request.id, callTool(forge, ownerLogin, toolName, args));
      } catch (error) {
        if (error instanceof McpInvalidParams) return rpcError(request.id, -32602, error.message);
        throw error;
      }
    }
    default:
      if (isNotification) return null;
      return rpcError(request.id, -32601, `Method not found: ${method}`);
  }
}

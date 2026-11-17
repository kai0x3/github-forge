// app.ts — the forge's HTTP server: one process serving git smart HTTP, the REST v3 API,
// GraphQL and MCP from the shared in-memory store in src/forge.ts. main.ts owns the trial
// lifecycle (bind, register, wait for done); this file owns the wire.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Forge, OWNER_LOGIN } from './src/forge.ts';
import { advertisementV0, advertisementV2, handleReceivePack, handleUploadPack } from './src/gitproto.ts';
import { handleRest, type RestRequest } from './src/rest.ts';
import { executeGraphQL } from './src/graphql.ts';
import { handleMcp } from './src/mcp.ts';

const JSON_TYPE = 'application/json; charset=utf-8';
const MAX_BODY_BYTES = 128 * 1024 * 1024;

let requestSeq = 0;

function nextRequestId(): string {
  requestSeq += 1;
  return `forge-${requestSeq.toString(36)}-${Date.now().toString(36)}`;
}

function sendJson(res: ServerResponse, status: number, body: unknown, extra: Record<string, string> = {}): void {
  const text = body === undefined ? '' : `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'x-github-request-id': nextRequestId(),
    ...(text === '' ? {} : { 'content-length': Buffer.byteLength(text) }),
    ...extra,
  });
  res.end(text);
}

function sendBytes(res: ServerResponse, status: number, body: Buffer, contentType: string): void {
  res.writeHead(status, { 'content-type': contentType, 'content-length': body.length, 'cache-control': 'no-cache' });
  res.end(body);
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buffer = chunk as Buffer;
    total += buffer.length;
    if (total > MAX_BODY_BYTES) throw new Error('request body too large');
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

function isAuthorized(req: IncomingMessage, token: string): boolean {
  if (token === '') return true;
  const header = req.headers.authorization;
  return header === `Bearer ${token}`;
}

export function createApp(): Server {
  const forge = new Forge();
  const token = process.env.MAKEFUN_SHOP_TOKEN ?? '';

  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void handle(forge, token, req, res).catch((error: unknown) => {
      if (!res.headersSent) sendJson(res, 500, { message: `internal error: ${error instanceof Error ? error.message : String(error)}` });
      else res.end();
    });
  });
}

async function handle(forge: Forge, token: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://entry');
  const path = url.pathname;
  const method = req.method ?? 'GET';

  // The env's boot probe: no auth, always the same answer.
  if (method === 'GET' && path === '/healthz') {
    sendJson(res, 200, { ok: true });
    return;
  }

  // ----- git smart HTTP at /{owner}/{repo}.git/...
  const gitMatch = /^\/([^/]+)\/([^/]+)\.git(\/.*)?$/.exec(path);
  if (gitMatch !== null) {
    if (!isAuthorized(req, token)) {
      sendJson(res, 401, { message: 'Bad credentials' });
      return;
    }
    const owner = decodeURIComponent(gitMatch[1] as string);
    const name = decodeURIComponent(gitMatch[2] as string);
    const repo = forge.getRepo(owner, name);
    const sub = gitMatch[3] ?? '';
    if (sub === '/info/refs' && method === 'GET') {
      if (repo === undefined) {
        sendJson(res, 404, { message: 'Not Found' });
        return;
      }
      const service = url.searchParams.get('service');
      if (service === 'git-upload-pack') {
        const protocol = req.headers['git-protocol'] ?? '';
        if (String(protocol).includes('version=2')) {
          sendBytes(res, 200, advertisementV2(), 'application/x-git-upload-pack-advertisement');
        } else {
          sendBytes(res, 200, advertisementV0(forge, repo, 'git-upload-pack'), 'application/x-git-upload-pack-advertisement');
        }
        return;
      }
      if (service === 'git-receive-pack') {
        sendBytes(res, 200, advertisementV0(forge, repo, 'git-receive-pack'), 'application/x-git-receive-pack-advertisement');
        return;
      }
      sendJson(res, 400, { message: 'unknown service' });
      return;
    }
    if (sub === '/git-upload-pack' && method === 'POST') {
      if (repo === undefined) {
        sendJson(res, 404, { message: 'Not Found' });
        return;
      }
      const body = await readBody(req);
      const protocol = req.headers['git-protocol'] ?? '';
      const v2 = String(protocol).includes('version=2');
      const result = handleUploadPack(forge, repo, body, v2);
      sendBytes(res, result.status, result.body, 'application/x-git-upload-pack-result');
      return;
    }
    if (sub === '/git-receive-pack' && method === 'POST') {
      if (repo === undefined) {
        sendJson(res, 404, { message: 'Not Found' });
        return;
      }
      const body = await readBody(req);
      const result = handleReceivePack(forge, repo, body);
      sendBytes(res, result.status, result.body, 'application/x-git-receive-pack-result');
      return;
    }
    sendJson(res, 404, { message: 'Not Found' });
    return;
  }

  // ----- GraphQL
  if (path === '/api/graphql') {
    if (!isAuthorized(req, token)) {
      sendJson(res, 401, { message: 'Bad credentials' });
      return;
    }
    if (method !== 'POST') {
      sendJson(res, 404, { message: 'Not Found' });
      return;
    }
    const body = await readBody(req);
    let parsed: unknown;
    try {
      parsed = JSON.parse(body.toString('utf8'));
    } catch {
      sendJson(res, 400, { errors: [{ message: 'Problems parsing JSON' }] });
      return;
    }
    const result = executeGraphQL(forge, OWNER_LOGIN, parsed);
    sendJson(res, 200, result);
    return;
  }

  // ----- MCP
  if (path === '/mcp') {
    if (!isAuthorized(req, token)) {
      sendJson(res, 401, { message: 'Bad credentials' });
      return;
    }
    if (method !== 'POST') {
      sendJson(res, 404, { message: 'Not Found' });
      return;
    }
    const body = await readBody(req);
    const result = handleMcp(forge, OWNER_LOGIN, body.toString('utf8'));
    if (result.json === undefined) {
      res.writeHead(result.status, { 'x-github-request-id': nextRequestId() });
      res.end();
      return;
    }
    sendJson(res, result.status, result.json);
    return;
  }

  // ----- REST v3
  if (path === '/api/v3' || path.startsWith('/api/v3/')) {
    if (!isAuthorized(req, token)) {
      sendJson(res, 401, { message: 'Bad credentials' });
      return;
    }
    const body = method === 'GET' ? Buffer.alloc(0) : await readBody(req);
    const segments = path
      .replace(/^\/api\/v3\/?/, '')
      .split('/')
      .filter((segment) => segment !== '')
      .map((segment) => decodeURIComponent(segment));
    const host = req.headers.host ?? '127.0.0.1';
    const restRequest: RestRequest = { method, segments, query: url.searchParams, rawBody: body, origin: `http://${host}` };
    const result = handleRest(forge, OWNER_LOGIN, restRequest);
    if (result.status === 204) {
      res.writeHead(204, { 'x-github-request-id': nextRequestId(), ...(result.headers ?? {}) });
      res.end();
      return;
    }
    sendJson(res, result.status, result.json, result.headers ?? {});
    return;
  }

  sendJson(res, 404, { message: 'Not Found' });
}

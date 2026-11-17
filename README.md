# Aurora Forge — a GitHub-compatible git forge in one process

A standalone forge built for the make.fun **github-core-clone-01** bounty. One Node process
serves four surfaces from a single in-memory store, with no UI, no database, no outside service
and no git binary — the git object model and the pack protocol are implemented in `src/forge.ts`
and `src/gitproto.ts`.

## Surfaces

- **Git smart HTTP** at `/{owner}/{repo}.git` — upload-pack protocol v2 (capability
  advertisement, `ls-refs`, fetch with shallow/deepen and side-band-64k packfiles), the v0
  fallback framing, and receive-pack v0 with `report-status`, `side-band-64k` and `delete-refs`.
  Pushes are fast-forward only; a refused ref answers `ng <ref> non-fast-forward` and a mixed
  push applies the refs that do fast-forward.
- **REST v3** under `/api/v3` — repositories (create/list with `Link` pagination, get, patch,
  delete), contents (PUT/DELETE with sha semantics: 201 create, 200 update, 409 stale sha),
  labels, issues (with label validation), comments, branches, commits, git refs, and pull
  requests with a real squash merge onto the default branch (405 on conflict).
- **GraphQL** at `/api/graphql` — viewer, repository, issue/pull-request connections with
  cursor pagination and state filtering, the `createIssue` / `closeIssue` / `createPullRequest` /
  `mergePullRequest` / `addComment` mutations, `node(id:)` with opaque global ids, batched
  operations, and the `__type` introspection surface (Issue, PullRequest, Repository,
  SearchType).
- **MCP** at `/mcp` — JSON-RPC 2.0 over Streamable HTTP: `server/discover` (2026-07-28) plus
  the legacy `initialize` handshake, and six tools (`create_repo`, `get_repo`, `create_issue`,
  `list_issues`, `create_pull_request`, `merge_pull_request`) acting on the same store as REST.

## Running

```sh
npm start   # node --experimental-strip-types main.ts
```

The process binds an ephemeral port, POSTs `{"port": N}` to `$MAKEFUN_ENV_URL/register`, serves
until the suite answers `{"done": true}` on `$MAKEFUN_ENV_URL/done`, and exits 0. Requests carry
`Authorization: Bearer <$MAKEFUN_SHOP_TOKEN>`; a missing or wrong token is a 401, and a
repository under another owner is a 404.

## Layout

- `main.ts` — the entry ↔ env lifecycle (bind, register, wait for done).
- `app.ts` — HTTP routing and auth for the four surfaces.
- `src/forge.ts` — the shared store, git object model, packfile read/write, ancestry, three-way merge.
- `src/gitproto.ts` — smart HTTP: advertisements, ls-refs, fetch planning, receive-pack.
- `src/rest.ts` — the REST v3 routes and JSON views.
- `src/graphql.ts` — the GraphQL parser/executor and introspection schema.
- `src/mcp.ts` — the MCP endpoint and its tools.
- `src/service.ts` — operations shared by REST, GraphQL and MCP (issues, pulls, squash merge).

## License

MIT

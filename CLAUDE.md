# typesafe-mcp

A Next.js (App Router) MCP server that exposes the TypeSafe AI System One API as tools. It runs on
Vercel and is used from Claude as a custom connector. The README covers setup, deployment and client
configuration; this file is what you need to work on the code.

## Commands

```bash
npm run dev          # local server, endpoint at /api/mcp
npm test             # vitest; TypeSafe is faked, no network
npm run lint
npm run type-check
npm run build
npm run smoke        # real MCP client against a running server; makes real TypeSafe requests
```

Run test, lint, type-check and build before calling a change done. `npm run smoke` needs a server
running and `TYPESAFE_API_KEY` in its environment. It takes `MCP_AUTH_TOKEN` and `MCP_URL` from the
environment or `.env.local`; without `MCP_URL` it targets `http://localhost:3000/api/mcp`.

## Layout

- `src/app/api/mcp/route.ts`: the endpoint. Checks the token, then hands the request to `mcp-handler`.
- `src/lib/auth.ts`: token check (`Authorization: Bearer` or `X-API-Key`), constant-time, fails closed.
- `src/lib/questions.ts`: zod schemas for the tool inputs. Their descriptions are what the calling
  model reads, so treat them as prompts.
- `src/lib/systemOne.ts`: the TypeSafe client (`@typesafe-ai/sdk`), the batch runner and error text.
- `src/lib/tools.ts`: tool registration, tool descriptions and the time budget of a call.
- `src/app/api/mcp/route.test.ts`: end-to-end tests through a real MCP client, in process.
- `scripts/smoke.mjs`: live check against a running server.

## Conventions

- Match the style of the author's other project, `../sofos-web`: tabs, single quotes, semicolons,
  `@/` imports from `src`, small functions, comments that say why and not what.
- Tests sit next to the code as `*.test.ts`.
- Errors a caller can fix are returned as tool errors (`isError`), never thrown.

## Decisions worth knowing

- **Static token, not OAuth.** The server is for one person. Claude sends the token through the
  connector's "Request headers", which is a beta feature not every account has.
- **The official SDK does the HTTP work**, including retries on 408/429/5xx (2 retries) and a 10 second
  timeout per attempt. Don't add a second retry layer.
- **`state`, `instructions` and criteria values have no type in the published JSON Schema.** TypeSafe
  accepts text, an object or an array there; that is validated in a zod refinement instead, which keeps
  the tool definitions small. Tool definitions are loaded into every conversation.
- **Batch answers are compact** (no legend, probabilities only on request) because the legend repeats
  the caller's own criteria for every item.
- **Question objects are strict.** An unknown key is an error rather than being dropped, because a
  dropped key (noul criteria written as `yes`/`no`, say) changes the answer without anyone noticing.
- **The first state of a batch is sent alone**, so a malformed question, a missing API key or a failed
  connection fails once instead of 100 times. A busy or slow API (408, 429, 5xx, a timeout) doesn't
  stop the batch, since a single heavy state can time out on its own.
- **Every tool call has a 50 second budget** and the route a 60 second `maxDuration`, to stay inside
  the tool call timeouts of MCP clients. The SDK waits out a `Retry-After` of up to a minute, so even a
  single ask needs the budget. Leftover batch states are returned as errors to resend. A call also
  stops when the client disconnects, through the request's signal (`ctx.mcpReq.signal`).
- **Results are returned as JSON text only**, without `structuredContent`, to avoid sending every
  payload twice.

## Status (2026-10-10)

Deployed to Vercel (Hobby plan); every push to `main` deploys to production. Tests, lint, type-check
and build pass, and `npm run smoke` passes against `next dev`, `next start` and production with the
live TypeSafe API.

Next steps:

1. Add the connector in Claude and check that the dialog offers "Request headers".
2. If it doesn't, add OAuth. What Claude needs is in
   https://claude.com/docs/connectors/building/authentication: a `401` whose `WWW-Authenticate` points
   at protected resource metadata, an authorization server with PKCE (S256) and either dynamic client
   registration or Client ID Metadata Documents, and the redirect URI
   `https://claude.ai/api/mcp/auth_callback`. `mcp-handler` ships `withMcpAuth` and
   `protectedResourceHandler` for the resource-server side. One option is a GitHub login limited to a
   single account, as sofos-web does with `ALLOWED_GITHUB_USER_ID`.

## References

- TypeSafe docs index: https://docs.typesafe.ai/llms.txt (append `.md` to a page path for Markdown)
- TypeSafe agent skill: https://github.com/typesafe-ai/skills/blob/main/skills/typesafe-ai/SKILL.md. The
  tool and parameter descriptions take their advice on designing questions and reading answers from it.
- mcp-handler: https://github.com/vercel/mcp-handler
- Vercel MCP guide: https://vercel.com/docs/mcp/deploy-mcp-servers-to-vercel

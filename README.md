# typesafe-mcp

MCP server for the TypeSafe AI System One API.

It lets an MCP client such as Claude ask [TypeSafe](https://docs.typesafe.ai)'s Jev model typed questions
(yes/no, choice, score) about content and get probabilities back. It is a Next.js app meant to run on
Vercel, and it is not an official TypeSafe project.

## Tools

| Tool | What it does |
| --- | --- |
| `typesafe_ask` | Asks one or more questions about one state and returns the full answers. |
| `typesafe_ask_batch` | Asks the same questions about up to 100 states and returns compact answers in input order. |
| `typesafe_list_models` | Lists the models the API key can use. |

A question is one of three types, as in the [TypeSafe API](https://docs.typesafe.ai/api):

```json
{
  "state": { "ticket": { "body": "I was charged twice. Please refund me today." } },
  "questions": {
    "is_billing": { "type": "noul", "instructions": "Is `ticket.body` about billing?" },
    "team": {
      "type": "choice",
      "instructions": "Which team should handle `ticket`?",
      "criteria": { "billing": "Payments and refunds", "technical": "Bugs and outages", "other": null }
    },
    "urgency": {
      "type": "score",
      "instructions": "How urgent is `ticket`?",
      "criteria": ["Can wait", "Within a few days", "Needs it today"]
    }
  }
}
```

## Configuration

| Variable | Required | Purpose |
| --- | --- | --- |
| `TYPESAFE_API_KEY` | yes | TypeSafe API key, from https://console.typesafe.ai/keys. Stays on the server. |
| `MCP_AUTH_TOKEN` | yes | Secret that clients must send, at least 32 characters. Generate one with `openssl rand -hex 32`. |
| `TYPESAFE_DEFAULT_MODEL` | no | Model used when a call doesn't name one. Defaults to `jev-latest`. |

## Run it locally

```bash
npm install
cp .env.local.template .env.local   # then fill in the two values
npm run dev                         # http://localhost:3000/api/mcp
npm run smoke                       # calls the running server through a real MCP client
```

`npm run smoke` makes real TypeSafe requests. To check a deployed server instead:

```bash
MCP_URL=https://<your-domain>/api/mcp MCP_AUTH_TOKEN=<token> npm run smoke
```

Other scripts: `npm test`, `npm run lint`, `npm run type-check`, `npm run build`.

## Deploy to Vercel

1. Import the repository in Vercel. It is detected as a Next.js project and needs no settings.
2. Add `TYPESAFE_API_KEY` and `MCP_AUTH_TOKEN` as environment variables for Production.
3. Deploy, then open the production domain: it answers `typesafe-mcp is running`.
4. Run the smoke command above against `https://<your-domain>/api/mcp`.

Give clients the production domain. Preview deployment URLs may sit behind Vercel's Deployment
Protection, which MCP clients can't get through.

## Connect a client

The endpoint is `https://<your-domain>/api/mcp` (Streamable HTTP). Every request needs the token, as
either `Authorization: Bearer <token>` or `X-API-Key: <token>`.

**Claude (web, desktop and mobile).** Go to Customize > Connectors > Add custom connector, enter the
URL, choose **No sign-in** under Authentication, and under **Request headers** add `authorization` with
the value `Bearer <token>` (or `x-api-key` with the bare token). Request headers are a beta feature that
not every account has yet. If the section is missing from the dialog, Claude can't send the token and
this server will refuse it; it would need OAuth, which is not implemented here.

**Claude Code.**

```bash
claude mcp add --transport http typesafe https://<your-domain>/api/mcp \
  --header "Authorization: Bearer <token>"
```

**Other clients.** Any client that speaks Streamable HTTP and can send a custom header works.

## Behavior and limits

- A request without a valid token gets `401` before it reaches the MCP handler. If `MCP_AUTH_TOKEN` is
  unset or shorter than 32 characters, every request gets `503`.
- A problem with a call (invalid arguments, a TypeSafe error) comes back as a tool error that says what
  to fix.
- Every call stops asking TypeSafe after 50 seconds, to answer within the route's 60 second limit, and
  as soon as the client disconnects. A call that runs out of time comes back with an error and can be
  sent again.
- `typesafe_ask_batch` sends the first state alone, then up to 8 at a time. If the first state fails in
  a way the rest would too (TypeSafe rejects the request, the connection fails, or the server has no
  API key), the call fails without sending the rest. When time runs out, the states left over come
  back with an error and can be sent again.
- The TypeSafe SDK retries rate limits and server errors twice with backoff.
- Vercel caps a request or response body at 4.5 MB.

## Security

- The token is the only thing protecting your TypeSafe credits. Keep it out of URLs and out of git.
- To rotate it, change `MCP_AUTH_TOKEN` in Vercel, redeploy, and update the header in each client.
- Use a TypeSafe key created for this server, so it can be revoked on its own.

## License

MIT

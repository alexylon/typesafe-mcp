export const dynamic = 'force-static';

// Public on purpose: it only shows that the deployment is up.
export function GET(): Response {
	return new Response('typesafe-mcp is running. MCP clients connect to /api/mcp.\n', {
		headers: { 'Content-Type': 'text/plain; charset=utf-8' },
	});
}

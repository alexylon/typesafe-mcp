import { createMcpHandler } from 'mcp-handler';
import { denyUnlessAuthorized } from '@/lib/auth';
import { registerTools, SERVER_INSTRUCTIONS } from '@/lib/tools';
import packageJson from '../../../../package.json';

// Every tool call stops after 50 seconds, so this limit is never reached in normal use.
export const maxDuration = 60;

const mcp = createMcpHandler(registerTools, {
	serverInfo: { name: packageJson.name, version: packageJson.version },
	instructions: SERVER_INSTRUCTIONS,
});

// The token is checked before the MCP handler runs, so without it not even the
// tool list is visible.
async function handler(req: Request): Promise<Response> {
	return denyUnlessAuthorized(req) ?? mcp(req);
}

export { handler as GET, handler as POST };

// Calls a running server through a real MCP client, which makes real TypeSafe
// requests and uses a few hundred tokens.
//
//   npm run smoke                                         a local `npm run dev`
//   MCP_URL=https://<host>/api/mcp MCP_AUTH_TOKEN=<token> npm run smoke
//
// MCP_AUTH_TOKEN is read from .env.local when it isn't in the environment.
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

const url = process.env.MCP_URL ?? 'http://localhost:3000/api/mcp';
const token = process.env.MCP_AUTH_TOKEN;

if (!token) {
	console.error('Set MCP_AUTH_TOKEN to the token the server expects.');
	process.exit(2);
}

const ticket = {
	subject: 'Charged twice for October',
	body: 'I was charged twice for my subscription this month. Please refund the duplicate today.',
};

const questions = {
	is_billing: { type: 'noul', instructions: 'Is `ticket.body` about a billing or payment problem?' },
	team: {
		type: 'choice',
		instructions: 'Which team should handle `ticket`?',
		criteria: {
			billing: 'Payments, invoices, refunds, duplicate charges',
			technical: 'Bugs, outages, integrations, login problems',
			other: 'None of the above fits',
		},
	},
};

let failures = 0;

function check(label, passed, detail = '') {
	console.log(`${passed ? 'PASS' : 'FAIL'}  ${label}${detail ? `  ${detail}` : ''}`);
	if (!passed) failures++;
}

async function callTool(client, name, args) {
	const result = await client.callTool({ name, arguments: args });
	const text = result.content[0].text;

	if (result.isError) throw new Error(text);

	return JSON.parse(text);
}

const unauthenticated = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
check('a request without the token is refused', unauthenticated.status === 401, `HTTP ${unauthenticated.status}`);

const client = new Client({ name: 'typesafe-mcp-smoke', version: '0' });

try {
	await client.connect(new StreamableHTTPClientTransport(new URL(url), {
		requestInit: { headers: { Authorization: `Bearer ${token}` } },
	}));

	const { tools } = await client.listTools();
	check('the server lists its tools', tools.length === 3, tools.map(tool => tool.name).join(', '));

	const single = await callTool(client, 'typesafe_ask', { state: { ticket }, questions });
	check(
		'typesafe_ask routes a billing ticket to billing',
		single.answers.team.choice === 'billing' && single.answers.is_billing.noul > 0.5,
		`team=${single.answers.team.choice} is_billing=${single.answers.is_billing.noul} model=${single.model}`,
	);

	const batch = await callTool(client, 'typesafe_ask_batch', {
		states: [{ ticket }, { ticket: { subject: 'Login loop', body: 'The app logs me out every time I open it.' } }],
		questions,
	});
	const teams = batch.results.map(item => item.answers?.team.choice);
	check(
		'typesafe_ask_batch answers each state in order',
		batch.failed === 0 && teams[0] === 'billing' && teams[1] === 'technical',
		`teams=${teams.join(', ')}`,
	);

	const { models } = await callTool(client, 'typesafe_list_models', {});
	check('typesafe_list_models returns models', models.length > 0, models.map(model => model.name).join(', '));
} catch (error) {
	check('the server answers MCP requests', false, error instanceof Error ? error.message : String(error));
} finally {
	await client.close();
}

process.exit(failures === 0 ? 0 : 1);

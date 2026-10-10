import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { APITimeoutError, TypeSafeClient } from '@typesafe-ai/sdk';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { POST } from '@/app/api/mcp/route';
import { TIME_BUDGET_MS } from '@/lib/tools';

// These tests call the route through a real MCP client. Only the TypeSafe API is
// faked, by replacing the fetch the TypeSafe SDK uses. A few tests also shorten
// waits that would be too long for a test.

const URL = 'https://example.test/api/mcp';
const TOKEN = 't'.repeat(64);

const QUESTIONS = {
	urgent: { type: 'noul', instructions: 'Is it urgent?' },
	team: { type: 'choice', instructions: 'Which team?', criteria: { billing: null, other: null } },
	tone: { type: 'score', instructions: 'How angry?', criteria: ['Calm', 'Angry'] },
};

const ANSWERS = {
	urgent: { type: 'noul', noul: 0.9 },
	team: { type: 'choice', choice: 'billing', confidence: 0.8, probabilities: { billing: 0.9, other: 0.1 } },
	tone: { type: 'score', score: 0.2, confidence: 0.7, legend: { 0: 'Calm', 1: 'Angry' }, probabilities: { 0: 0.8, 1: 0.2 } },
};

const MODELS = [{ name: 'jev-latest', description: 'The latest Jev', release_date: '2026-09-10T00:00:00Z' }];

interface ApiCall {
	url: string;
	authorization: string | null;
	body: { state: unknown; model: string; questions: unknown };
}

let apiCalls: ApiCall[];
let inFlight: number;
let maxInFlight: number;

// Answers every question after a short pause, so later states can finish before
// earlier ones. Some states simulate trouble: "reject" gets a validation error,
// "busy" a 408, "limited" a 429 with a one-minute Retry-After, "unreachable" a
// connection failure and "slow" a long pause.
async function fakeTypeSafe(url: string, init: RequestInit): Promise<Response> {
	if (url.endsWith('/v1/models')) return Response.json({ models: MODELS });

	const body = JSON.parse(String(init.body));

	apiCalls.push({ url, authorization: new Headers(init.headers).get('authorization'), body });

	if (body.state === 'unreachable') throw new TypeError('fetch failed');

	maxInFlight = Math.max(maxInFlight, ++inFlight);
	await new Promise(resolve => setTimeout(resolve, pause(body.state)));
	inFlight--;

	if (body.state === 'reject') return Response.json({ detail: 'state is not acceptable' }, { status: 422 });

	if (body.state === 'busy') {
		// Lets the SDK retry without waiting, to keep the tests fast.
		return Response.json({ detail: 'Request timed out' }, { status: 408, headers: { 'retry-after-ms': '0' } });
	}

	if (body.state === 'limited') return Response.json({ detail: 'Too many requests' }, { status: 429, headers: { 'retry-after': '60' } });

	return Response.json({ model: 'jev-test', answers: ANSWERS, usage: { input_tokens: 10, output_tokens: 2 } });
}

function pause(state: unknown): number {
	if (state === 'slow') return 50;

	return apiCalls.length % 3 === 0 ? 1 : 8;
}

async function connect(token = TOKEN, post = POST): Promise<Client> {
	const client = new Client({ name: 'route-test', version: '0' });

	await client.connect(new StreamableHTTPClientTransport(new globalThis.URL(URL), {
		requestInit: { headers: { Authorization: `Bearer ${token}` } },
		fetch: (url, init) => post(new Request(url, init)),
	}));

	return client;
}

async function call(name: string, args: Record<string, unknown>, post = POST) {
	const client = await connect(TOKEN, post);
	const result = await client.callTool({ name, arguments: args });
	const [block] = result.content as { type: string; text: string }[];

	return { isError: result.isError === true, text: block.text };
}

function descriptionsIn(schema: unknown): string[] {
	if (typeof schema !== 'object' || schema === null) return [];

	return Object.entries(schema).flatMap(([key, value]) =>
		key === 'description' && typeof value === 'string' ? [value] : descriptionsIn(value));
}

function shortenTimeBudget(ms: number): void {
	const timeout = AbortSignal.timeout.bind(AbortSignal);

	vi.spyOn(AbortSignal, 'timeout').mockImplementation(delay => timeout(delay === TIME_BUDGET_MS ? ms : delay));
}

beforeEach(() => {
	apiCalls = [];
	inFlight = 0;
	maxInFlight = 0;
	vi.stubEnv('MCP_AUTH_TOKEN', TOKEN);
	vi.stubEnv('TYPESAFE_API_KEY', 'typesafe-test-key');
	vi.stubGlobal('fetch', fakeTypeSafe);
});

afterEach(() => {
	vi.unstubAllEnvs();
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

describe('access', () => {
	it('refuses a request without the token before it reaches MCP or TypeSafe', async () => {
		const response = await POST(new Request(URL, { method: 'POST', body: '{}' }));

		expect(response.status).toBe(401);
		await expect(connect('wrong-token')).rejects.toThrow();
		expect(apiCalls).toHaveLength(0);
	});

	it('lists the tools for a client with the token', async () => {
		const { tools } = await (await connect()).listTools();

		expect(tools.map(tool => tool.name)).toEqual(['typesafe_ask', 'typesafe_ask_batch', 'typesafe_list_models']);
	});
});

describe('tool definitions', () => {
	it('keeps every description short enough for claude.ai to show in full', async () => {
		const { tools } = await (await connect()).listTools();
		const descriptions = tools.flatMap(tool => [tool.description ?? '', ...descriptionsIn(tool.inputSchema)]);

		expect(descriptions.length).toBeGreaterThan(10);
		for (const description of descriptions) expect(description.length).toBeLessThan(2048);
	});

	it('states the question and option counts that the server checks', async () => {
		const { tools } = await (await connect()).listTools();
		const askTool = tools.find(tool => tool.name === 'typesafe_ask');

		expect(askTool?.inputSchema).toMatchObject({
			properties: {
				questions: {
					minProperties: 1,
					additionalProperties: {
						oneOf: expect.arrayContaining([
							expect.objectContaining({
								properties: expect.objectContaining({
									type: expect.objectContaining({ const: 'choice' }),
									criteria: expect.objectContaining({ minProperties: 2, maxProperties: 255 }),
								}),
							}),
						]),
					},
				},
			},
		});
	});
});

describe('typesafe_ask', () => {
	it('sends the state and questions to TypeSafe with the server key and returns the full answers', async () => {
		const { isError, text } = await call('typesafe_ask', { state: { ticket: 'Charged twice' }, questions: QUESTIONS });

		expect(isError).toBe(false);
		expect(JSON.parse(text)).toEqual({
			model: 'jev-test',
			answers: ANSWERS,
			usage: { input_tokens: 10, output_tokens: 2 },
		});
		expect(apiCalls).toHaveLength(1);
		expect(apiCalls[0].url).toBe('https://api.typesafe.ai/v1/systemone');
		expect(apiCalls[0].authorization).toBe('Bearer typesafe-test-key');
		expect(apiCalls[0].body).toEqual({ state: { ticket: 'Charged twice' }, questions: QUESTIONS, model: 'jev-latest' });
	});

	it('passes a chosen model on', async () => {
		await call('typesafe_ask', { state: 'text', questions: QUESTIONS, model: 'jev-preview' });

		expect(apiCalls[0].body.model).toBe('jev-preview');
	});

	it('reports what is wrong with the arguments without calling TypeSafe', async () => {
		const { isError, text } = await call('typesafe_ask', {
			state: 'text',
			questions: { tone: { type: 'score', instructions: 'How angry?', criteria: ['Calm'] } },
		});

		expect(isError).toBe(true);
		expect(text).toContain('questions.tone.criteria');
		expect(apiCalls).toHaveLength(0);
	});

	it('refuses a missing, null, "null" or wrongly typed state without calling TypeSafe', async () => {
		const missing = await call('typesafe_ask', { questions: QUESTIONS });
		const nothing = await call('typesafe_ask', { state: null, questions: QUESTIONS });
		const nullText = await call('typesafe_ask', { state: 'null', questions: QUESTIONS });
		const number = await call('typesafe_ask', { state: 42, questions: QUESTIONS });

		expect(missing).toEqual({ isError: true, text: expect.stringContaining('state: Required') });
		expect(nothing).toEqual({ isError: true, text: expect.stringContaining('state: Must not be empty or null') });
		expect(nullText).toEqual({ isError: true, text: expect.stringContaining('state: Must not be empty or null') });
		expect(number).toEqual({ isError: true, text: expect.stringContaining('state: Must be text, an object or an array') });
		expect(apiCalls).toHaveLength(0);
	});

	it('refuses an empty state without calling TypeSafe', async () => {
		const { isError, text } = await call('typesafe_ask', { state: '', questions: QUESTIONS });

		expect(isError).toBe(true);
		expect(text).toContain('Must not be empty');
		expect(apiCalls).toHaveLength(0);
	});

	it('returns the error TypeSafe gives', async () => {
		const { isError, text } = await call('typesafe_ask', { state: 'reject', questions: QUESTIONS });

		expect(isError).toBe(true);
		expect(text).toBe('TypeSafe answered HTTP 422 state is not acceptable');
	});

	it('gives up when TypeSafe does not answer within the time budget', async () => {
		shortenTimeBudget(20);
		const { isError, text } = await call('typesafe_ask', { state: 'limited', questions: QUESTIONS });

		expect(isError).toBe(true);
		expect(text).toBe('Not answered within the time budget; send it again');
	});
});

describe('typesafe_ask_batch', () => {
	it('answers every state, in input order, a few at a time and in compact form', async () => {
		const states = Array.from({ length: 30 }, (_, index) => `item ${index}`);
		const { isError, text } = await call('typesafe_ask_batch', { states, questions: QUESTIONS });
		const batch = JSON.parse(text);

		expect(isError).toBe(false);
		expect(batch.model).toBe('jev-test');
		expect(batch.failed).toBe(0);
		expect(batch.usage).toEqual({ input_tokens: 300, output_tokens: 60 });
		expect(batch.results.map((item: { index: number }) => item.index)).toEqual(states.map((_, index) => index));
		expect(batch.results[7].answers).toEqual({
			urgent: { noul: 0.9 },
			team: { choice: 'billing', confidence: 0.8 },
			tone: { score: 0.2, confidence: 0.7 },
		});
		expect(apiCalls.map(apiCall => apiCall.body.state).sort()).toEqual([...states].sort());
		expect(maxInFlight).toBeGreaterThan(1);
		expect(maxInFlight).toBeLessThanOrEqual(8);
	});

	it('adds the probabilities on request', async () => {
		const { text } = await call('typesafe_ask_batch', {
			states: ['one'],
			questions: QUESTIONS,
			include_probabilities: true,
		});

		expect(JSON.parse(text).results[0].answers.team).toEqual({
			choice: 'billing',
			confidence: 0.8,
			probabilities: { billing: 0.9, other: 0.1 },
		});
	});

	it('reports a state that fails in its place and still answers the others', async () => {
		const { isError, text } = await call('typesafe_ask_batch', { states: ['a', 'reject', 'c'], questions: QUESTIONS });
		const batch = JSON.parse(text);

		expect(isError).toBe(false);
		expect(batch.failed).toBe(1);
		expect(batch.results[1]).toEqual({ index: 1, error: 'TypeSafe answered HTTP 422 state is not acceptable' });
		expect(batch.results[0].answers).toBeDefined();
		expect(batch.results[2].answers).toBeDefined();
	});

	it('reports an empty state in its place without sending it', async () => {
		const { isError, text } = await call('typesafe_ask_batch', {
			states: ['', 'b', { ticket: { body: ' ' } }, 'd'],
			questions: QUESTIONS,
		});
		const batch = JSON.parse(text);
		const empty = 'The state is empty; send it again with the content to judge';

		expect(isError).toBe(false);
		expect(batch.failed).toBe(2);
		expect(batch.results[0]).toEqual({ index: 0, error: empty });
		expect(batch.results[2]).toEqual({ index: 2, error: empty });
		expect(apiCalls.map(apiCall => apiCall.body.state)).toEqual(['b', 'd']);
	});

	it('treats a null or "null" item as empty, but sends "null" inside an item', async () => {
		const { isError, text } = await call('typesafe_ask_batch', {
			states: [null, 'b', 'null', { value: 'null' }],
			questions: QUESTIONS,
		});
		const batch = JSON.parse(text);

		expect(isError).toBe(false);
		expect(batch.failed).toBe(2);
		expect(batch.results[0].error).toContain('The state is empty');
		expect(batch.results[2].error).toContain('The state is empty');
		expect(apiCalls.map(apiCall => apiCall.body.state)).toEqual(['b', { value: 'null' }]);
	});

	it('refuses a batch with an item of the wrong type', async () => {
		const { isError, text } = await call('typesafe_ask_batch', { states: ['a', 5], questions: QUESTIONS });

		expect(isError).toBe(true);
		expect(text).toContain('states.1: Must be text, an object, an array or null');
		expect(apiCalls).toHaveLength(0);
	});

	it('refuses a batch in which every state is empty', async () => {
		const { isError, text } = await call('typesafe_ask_batch', { states: ['', { ticket: '' }], questions: QUESTIONS });

		expect(isError).toBe(true);
		expect(text).toContain('Every state is empty');
		expect(apiCalls).toHaveLength(0);
	});

	it('says that missing states or questions are required', async () => {
		const noStates = await call('typesafe_ask_batch', { questions: QUESTIONS });
		const noQuestions = await call('typesafe_ask_batch', { states: ['a'] });

		expect(noStates).toEqual({ isError: true, text: expect.stringContaining('states: Required') });
		expect(noQuestions).toEqual({ isError: true, text: expect.stringContaining('questions: Required') });
		expect(apiCalls).toHaveLength(0);
	});

	it('answers an empty list of states with a single message', async () => {
		const { isError, text } = await call('typesafe_ask_batch', { states: [], questions: QUESTIONS });

		expect(isError).toBe(true);
		expect(text).toContain('Send at least one state');
		expect(text).not.toContain('Every state is empty');
	});

	it('stops after the first state when TypeSafe rejects it', async () => {
		const { isError, text } = await call('typesafe_ask_batch', { states: ['reject', 'b', 'c'], questions: QUESTIONS });

		expect(isError).toBe(true);
		expect(text).toBe('TypeSafe answered HTTP 422 state is not acceptable');
		expect(apiCalls).toHaveLength(1);
	});

	it('goes on after the first state when TypeSafe is only busy', async () => {
		const { isError, text } = await call('typesafe_ask_batch', { states: ['busy', 'b'], questions: QUESTIONS });
		const batch = JSON.parse(text);

		expect(isError).toBe(false);
		expect(batch.results[0]).toEqual({ index: 0, error: 'TypeSafe answered HTTP 408 Request timed out' });
		expect(batch.results[1].answers).toBeDefined();
		expect(apiCalls.map(apiCall => apiCall.body.state)).toEqual(['busy', 'busy', 'busy', 'b']);
	});

	it('goes on after the first state when TypeSafe times out', async () => {
		// A real SDK timeout takes 10 seconds per attempt, so the test raises the error directly.
		vi.spyOn(TypeSafeClient.prototype, 'systemOne').mockRejectedValueOnce(new APITimeoutError(10_000));
		const { isError, text } = await call('typesafe_ask_batch', { states: ['a', 'b'], questions: QUESTIONS });
		const batch = JSON.parse(text);

		expect(isError).toBe(false);
		expect(batch.results[0]).toEqual({ index: 0, error: 'Request timed out after 10000ms.' });
		expect(batch.results[1].answers).toBeDefined();
	});

	// Takes over a second: the SDK waits before each of its two retries.
	it('stops after the first state when the connection to TypeSafe fails', async () => {
		const { isError, text } = await call('typesafe_ask_batch', { states: ['unreachable', 'b'], questions: QUESTIONS });

		expect(isError).toBe(true);
		expect(text).toBe('Connection error: fetch failed');
		expect(apiCalls.map(apiCall => apiCall.body.state)).toEqual(['unreachable', 'unreachable', 'unreachable']);
	});

	it('stops after the first state when the server has no TypeSafe API key', async () => {
		vi.stubEnv('TYPESAFE_API_KEY', '');
		// A fresh copy of the route, without the TypeSafe client the other tests created.
		vi.resetModules();
		const route = await import('@/app/api/mcp/route');
		const { isError, text } = await call('typesafe_ask_batch', { states: ['a', 'b'], questions: QUESTIONS }, route.POST);

		expect(isError).toBe(true);
		expect(text).toContain('No API key was provided');
		expect(apiCalls).toHaveLength(0);
	});

	it('stops asking TypeSafe when the client goes away', async () => {
		const client = await connect();
		const states = ['first', ...Array.from({ length: 99 }, () => 'slow')];

		client.callTool({ name: 'typesafe_ask_batch', arguments: { states, questions: QUESTIONS } }).catch(() => {});
		// The first state, then a slow one for each of the 8 workers.
		await vi.waitFor(() => expect(apiCalls).toHaveLength(9), { interval: 1 });
		await client.close();
		// Long enough for the slow states to end and, if asking went on, the next ones to start.
		await new Promise(resolve => setTimeout(resolve, 100));

		expect(apiCalls).toHaveLength(9);
	});

	it('reports the states it had no time for', async () => {
		shortenTimeBudget(30);
		const { isError, text } = await call('typesafe_ask_batch', { states: ['first', 'slow', 'slow'], questions: QUESTIONS });
		const batch = JSON.parse(text);

		expect(isError).toBe(false);
		expect(batch.results[0].answers).toBeDefined();
		expect(batch.results.slice(1)).toEqual([
			{ index: 1, error: 'Not answered within the time budget; send it again' },
			{ index: 2, error: 'Not answered within the time budget; send it again' },
		]);
	});

	it('refuses more states than the limit', async () => {
		const { isError, text } = await call('typesafe_ask_batch', {
			states: Array.from({ length: 101 }, () => 'x'),
			questions: QUESTIONS,
		});

		expect(isError).toBe(true);
		expect(text).toContain('Send at most 100 states');
		expect(apiCalls).toHaveLength(0);
	});
});

describe('typesafe_list_models', () => {
	it('lists the models and names the default', async () => {
		const { isError, text } = await call('typesafe_list_models', {});

		expect(isError).toBe(false);
		expect(JSON.parse(text)).toEqual({ models: MODELS, default_model: 'jev-latest' });
	});
});

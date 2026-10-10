import { afterEach, describe, expect, it, vi } from 'vitest';
import { checkAuth, denyUnlessAuthorized } from '@/lib/auth';

const TOKEN = 'a'.repeat(64);

function request(headers: Record<string, string> = {}): Request {
	return new Request('https://example.test/api/mcp', { method: 'POST', headers });
}

afterEach(() => vi.unstubAllEnvs());

describe('checkAuth', () => {
	it('accepts the token as a bearer token or an API key header', () => {
		vi.stubEnv('MCP_AUTH_TOKEN', TOKEN);

		expect(checkAuth(request({ Authorization: `Bearer ${TOKEN}` }))).toBe('ok');
		expect(checkAuth(request({ authorization: `bearer ${TOKEN}` }))).toBe('ok');
		expect(checkAuth(request({ 'X-API-Key': TOKEN }))).toBe('ok');
	});

	it('refuses a missing, wrong or partial token', () => {
		vi.stubEnv('MCP_AUTH_TOKEN', TOKEN);

		expect(checkAuth(request())).toBe('unauthorized');
		expect(checkAuth(request({ Authorization: 'Bearer ' }))).toBe('unauthorized');
		expect(checkAuth(request({ Authorization: `Bearer ${'b'.repeat(64)}` }))).toBe('unauthorized');
		expect(checkAuth(request({ Authorization: `Bearer ${TOKEN.slice(1)}` }))).toBe('unauthorized');
		expect(checkAuth(request({ Authorization: `Bearer ${TOKEN}x` }))).toBe('unauthorized');
		// The Authorization header needs the "Bearer " prefix.
		expect(checkAuth(request({ Authorization: TOKEN }))).toBe('unauthorized');
	});

	it('lets nobody in when the server has no token or a short one', () => {
		vi.stubEnv('MCP_AUTH_TOKEN', '');
		expect(checkAuth(request({ Authorization: 'Bearer ' }))).toBe('misconfigured');
		expect(checkAuth(request({ 'X-API-Key': '' }))).toBe('misconfigured');

		vi.stubEnv('MCP_AUTH_TOKEN', 'short-token');
		expect(checkAuth(request({ Authorization: 'Bearer short-token' }))).toBe('misconfigured');
	});
});

describe('denyUnlessAuthorized', () => {
	it('answers 401 for a bad token, 503 for a server without one, and nothing for a good token', () => {
		vi.stubEnv('MCP_AUTH_TOKEN', TOKEN);
		expect(denyUnlessAuthorized(request())?.status).toBe(401);
		expect(denyUnlessAuthorized(request({ Authorization: `Bearer ${TOKEN}` }))).toBeUndefined();

		vi.stubEnv('MCP_AUTH_TOKEN', '');
		expect(denyUnlessAuthorized(request({ Authorization: `Bearer ${TOKEN}` }))?.status).toBe(503);
	});
});

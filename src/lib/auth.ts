import { createHash, timingSafeEqual } from 'node:crypto';

// The token is all that protects the TypeSafe credits, so one short enough to guess is refused.
export const MIN_TOKEN_LENGTH = 32;

export type AuthResult = 'ok' | 'unauthorized' | 'misconfigured';

export function checkAuth(req: Request): AuthResult {
	const expected = process.env.MCP_AUTH_TOKEN?.trim();

	if (!expected || expected.length < MIN_TOKEN_LENGTH) return 'misconfigured';

	const presented = presentedToken(req);

	return presented && sameToken(presented, expected) ? 'ok' : 'unauthorized';
}

export function denyUnlessAuthorized(req: Request): Response | undefined {
	switch (checkAuth(req)) {
		case 'ok':
			return undefined;
		case 'misconfigured':
			return Response.json(
				{ error: `MCP_AUTH_TOKEN is not set on the server or is shorter than ${MIN_TOKEN_LENGTH} characters` },
				{ status: 503 },
			);
		case 'unauthorized':
			return Response.json(
				{ error: 'Missing or invalid token' },
				{ status: 401, headers: { 'WWW-Authenticate': 'Bearer' } },
			);
	}
}

function presentedToken(req: Request): string | undefined {
	const bearer = req.headers.get('authorization')?.match(/^Bearer\s+(.+)$/i)?.[1];

	return (bearer ?? req.headers.get('x-api-key'))?.trim() || undefined;
}

// Hashing gives both sides the length timingSafeEqual requires, so the
// comparison takes the same time whatever the caller sent.
function sameToken(presented: string, expected: string): boolean {
	return timingSafeEqual(sha256(presented), sha256(expected));
}

function sha256(value: string): Buffer {
	return createHash('sha256').update(value).digest();
}

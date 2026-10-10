import {
	APIError,
	APITimeoutError,
	APIUserAbortError,
	TypeSafeClient,
	TypeSafeError,
	type EntryType,
	type Questions,
	type SystemOneResult,
	type Usage,
} from '@typesafe-ai/sdk';

export const MAX_BATCH_STATES = 100;

const BATCH_CONCURRENCY = 8;
const OUT_OF_TIME = 'Not answered within the time budget; send it again';

type Answer = SystemOneResult<Questions>['answers'][string];

export type CompactAnswer =
	| { noul: number }
	| { choice: string; confidence: number; probabilities?: Record<string, number> }
	| { score: number; confidence: number; probabilities?: Record<string, number> };

export type BatchItem =
	| { index: number; answers: Record<string, CompactAnswer> }
	| { index: number; error: string };

export interface BatchResult {
	model: string | undefined;
	results: BatchItem[];
	failed: number;
	usage: Usage;
}

let client: TypeSafeClient | undefined;

// Created on first use, so a missing API key fails the tool call and not the build.
function typesafe(): TypeSafeClient {
	return (client ??= new TypeSafeClient());
}

export function ask(state: EntryType, questions: Questions, model?: string, signal?: AbortSignal) {
	return typesafe().systemOne({ state, questions, model }, { signal });
}

export function listModels(signal?: AbortSignal) {
	return typesafe().models.list({ signal });
}

// Asks the same questions about every state, a few states at a time. One state
// failing doesn't stop the others; its error is reported in its place. Once the
// signal fires, the states not answered yet are reported as out of time.
export async function askBatch(
	states: EntryType[],
	questions: Questions,
	options: { model?: string; includeProbabilities?: boolean; signal: AbortSignal },
): Promise<BatchResult> {
	const { signal } = options;
	const results: BatchItem[] = new Array(states.length);
	const usage = { input_tokens: 0, output_tokens: 0 };
	let model: string | undefined;

	async function answer(index: number, first = false): Promise<void> {
		try {
			const result = await ask(states[index], questions, options.model, signal);

			model = result.model;
			usage.input_tokens += result.usage.input_tokens;
			usage.output_tokens += result.usage.output_tokens;
			results[index] = { index, answers: compactAnswers(result.answers, options.includeProbabilities) };
		} catch (error) {
			if (first && wouldRepeat(error)) throw error;

			results[index] = { index, error: describeError(error) };
		}
	}

	// The first state goes alone, so a problem every state would hit, such as a
	// malformed question or a missing API key, fails once instead of 100 times.
	await answer(0, true);

	let next = 1;

	async function worker(): Promise<void> {
		while (next < states.length) {
			const index = next++;

			if (signal.aborted) results[index] = { index, error: OUT_OF_TIME };
			else await answer(index);
		}
	}

	await Promise.all(Array.from({ length: BATCH_CONCURRENCY }, worker));

	return { model, results, failed: results.filter(item => 'error' in item).length, usage };
}

// Whether the other states would most likely fail the same way: TypeSafe
// rejected the request, couldn't be reached even after retries, or the client
// couldn't be set up, for example without an API key. Not a timeout, which one
// large state can cause, nor an abort, which means time ran out or the client left.
function wouldRepeat(error: unknown): boolean {
	if (error instanceof APIError) return isRejection(error.status);
	if (error instanceof APITimeoutError || error instanceof APIUserAbortError) return false;

	return error instanceof TypeSafeError;
}

// A status that says the request itself is wrong. 408 and 429 only say that
// TypeSafe is busy, and the SDK retries them like a 5xx.
function isRejection(status: number): boolean {
	return status >= 400 && status < 500 && status !== 408 && status !== 429;
}

// Batch items share the questions, so the score legend, which only repeats the
// levels, is dropped, and probabilities are kept only on request.
function compactAnswers(
	answers: Record<string, Answer>,
	includeProbabilities = false,
): Record<string, CompactAnswer> {
	return Object.fromEntries(
		Object.entries(answers).map(([name, answer]): [string, CompactAnswer] => {
			if (answer.type === 'noul') return [name, { noul: answer.noul }];

			const probabilities = includeProbabilities ? { probabilities: { ...answer.probabilities } } : {};

			return answer.type === 'choice'
				? [name, { choice: answer.choice, confidence: answer.confidence, ...probabilities }]
				: [name, { score: answer.score, confidence: answer.confidence, ...probabilities }];
		}),
	);
}

// The message goes back to the calling model, so it has to say what to fix.
export function describeError(error: unknown): string {
	// An APIError message starts with the status, such as "422 questions.x.criteria: ...".
	if (error instanceof APIError) return `TypeSafe answered HTTP ${error.message}`;
	// The time budget ran out, or the client left and won't read this anyway.
	if (error instanceof APIUserAbortError) return OUT_OF_TIME;
	if (error instanceof TypeSafeError) return error.message;

	console.error('Unexpected error:', error);

	return 'Unexpected server error';
}

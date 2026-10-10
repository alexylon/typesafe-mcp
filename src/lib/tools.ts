import type { CallToolResult, McpServer } from '@modelcontextprotocol/server';
import type { EntryType, Questions } from '@typesafe-ai/sdk';
import { z } from 'zod';
import { modelSchema, questionsSchema, stateSchema } from '@/lib/questions';
import { ask, askBatch, describeError, listModels, MAX_BATCH_STATES } from '@/lib/systemOne';

export const SERVER_INSTRUCTIONS
	= 'TypeSafe answers typed questions (yes/no, choice, score) about content you supply and returns '
	+ 'probabilities. It does not write text or explain its reasoning. Use it for judgments that need common '
	+ 'sense or an understanding of language, and do the rest yourself: exact rules, lookups, arithmetic and '
	+ 'how the answers combine. typesafe_ask takes one piece of content; typesafe_ask_batch asks the same '
	+ 'questions about a list of items.';

const ASK_DESCRIPTION = `Ask TypeSafe's Jev model typed questions about a piece of content and get probabilities back instead of generated text. Use it to classify, route, check a yes/no condition, grade against a rubric, score relevance, or check a claim against its evidence.

Put everything the questions need in \`state\`. Ask the independent questions about the same state in one call, even ones that only matter in some cases, though each costs tokens. They are answered in parallel and can't see each other's answers, so state any premise in the question itself ("If this is a billing issue, ...") and ignore the answers whose premise doesn't hold. Make a second call only for questions that need an earlier answer, for example to choose the next options or gather more evidence.

Keep each question to one narrow judgment: split independent dimensions into separate questions, but don't split a judgment about how two things relate. Narrow doesn't mean literal or one sentence: interpreting something in context or choosing the next action is one judgment.

Pick the question type by what the answer means:
- noul: whether a condition holds. Returns \`noul\`, the probability of yes from 0 to 1. A value near 0.5 means yes and no are about equally likely, not a medium amount. Ask one noul per label when several labels may apply, and one per rule when breaking any single rule matters.
- choice: which one of the options you define applies. Returns \`choice\`, a probability for each option and \`confidence\`. The probabilities only compare the options with each other.
- score: rates one dimension against ordered levels you describe. Returns \`score\`, a probability-weighted level index that can fall between two levels, and \`confidence\`.

The answers are judgments, not facts. \`confidence\` says how concentrated the probabilities are, not that the answer is right or safe to act on; several fitting options also lower it, which is fine when any of them would do. How sure an answer must be depends on what's at stake: check the uncertain ones that matter yourself, or flag them to the user. When an answer looks wrong, first make sure the state held the evidence and the question said what you meant.`;

const ASK_BATCH_DESCRIPTION = `Ask the same questions about many states in one call, for example to classify or score a list of items. Each state is judged on its own, exactly as typesafe_ask would judge it, so scores from the same question can rank the items. Takes up to ${MAX_BATCH_STATES} states; split a longer list across calls.

Results come back in input order as {index, answers} or {index, error}. Answers are compact: \`noul\`, or \`choice\` or \`score\` with \`confidence\`. Set \`include_probabilities\` to also get the probability of every option or level.

If the first state fails in a way that every state would, for example because a question is malformed, nothing else is sent and the call fails with that error. A state that isn't answered within the time budget comes back with an error and can be sent again.`;

const LIST_MODELS_DESCRIPTION
	= 'List the TypeSafe models this server can use, with their descriptions and release dates. Pass one of '
	+ 'the names as `model` to the other tools.';

// Asking has no side effects beyond the tokens it uses, so every tool is safe to repeat.
const READ_ONLY = { readOnlyHint: true, idempotentHint: true, openWorldHint: true };

// Leaves time to answer within the route's 60 second limit. Even a single
// typesafe_ask needs it, since the SDK waits out a Retry-After of up to a minute.
export const TIME_BUDGET_MS = 50_000;

export function registerTools(server: McpServer): void {
	server.registerTool(
		'typesafe_ask',
		{
			title: 'Ask TypeSafe',
			description: ASK_DESCRIPTION,
			inputSchema: z.strictObject({
				state: stateSchema,
				questions: questionsSchema,
				model: modelSchema,
			}),
			annotations: READ_ONLY,
		},
		({ state, questions, model }, ctx) =>
			respond(ctx.mcpReq.signal, signal => ask(state as EntryType, questions as Questions, model, signal)),
	);

	server.registerTool(
		'typesafe_ask_batch',
		{
			title: 'Ask TypeSafe about many items',
			description: ASK_BATCH_DESCRIPTION,
			inputSchema: z.strictObject({
				states: z
					.array(stateSchema)
					.min(1)
					.max(MAX_BATCH_STATES)
					.describe('The items to judge. Each one is a complete state for the questions.'),
				questions: questionsSchema,
				model: modelSchema,
				include_probabilities: z
					.boolean()
					.optional()
					.describe('Also return the probability of every option or level. Off by default to keep the result small.'),
			}),
			annotations: READ_ONLY,
		},
		({ states, questions, model, include_probabilities }, ctx) =>
			respond(ctx.mcpReq.signal, signal =>
				askBatch(states as EntryType[], questions as Questions, {
					model,
					includeProbabilities: include_probabilities,
					signal,
				}),
			),
	);

	server.registerTool(
		'typesafe_list_models',
		{
			title: 'List TypeSafe models',
			description: LIST_MODELS_DESCRIPTION,
			annotations: READ_ONLY,
		},
		ctx => respond(ctx.mcpReq.signal, async signal => ({ models: await listModels(signal) })),
	);
}

// Failures are returned as tool errors rather than thrown, so the calling model
// can read them and fix its request. `run` gets a signal that fires when time
// runs out or the client leaves, so no credits go on answers nobody reads.
async function respond(
	clientSignal: AbortSignal,
	run: (signal: AbortSignal) => Promise<unknown>,
): Promise<CallToolResult> {
	const signal = AbortSignal.any([clientSignal, AbortSignal.timeout(TIME_BUDGET_MS)]);

	try {
		return { content: [{ type: 'text', text: JSON.stringify(await run(signal)) }] };
	} catch (error) {
		return { content: [{ type: 'text', text: describeError(error) }], isError: true };
	}
}

import type { CallToolResult, McpServer } from '@modelcontextprotocol/server';
import type { EntryType, Questions } from '@typesafe-ai/sdk';
import { z } from 'zod';
import { batchStateSchema, isEmptyState, modelSchema, questionsSchema, stateSchema } from '@/lib/questions';
import { ask, askBatch, describeError, listModels, MAX_BATCH_STATES } from '@/lib/systemOne';

// Leaves time to answer within the route's 60 second limit. Even a single
// typesafe_ask needs it, since the SDK waits out a Retry-After of up to a minute.
export const TIME_BUDGET_MS = 50_000;

export const SERVER_INSTRUCTIONS
	= 'TypeSafe answers typed questions (yes/no, choice, score) about content you supply and returns '
	+ 'probabilities. It does not write text or explain its reasoning. Use it for judgments that need common '
	+ 'sense or an understanding of language, and do the rest yourself: exact rules, lookups, arithmetic and '
	+ 'how the answers combine. typesafe_ask takes one piece of content; typesafe_ask_batch asks the same '
	+ 'questions about a list of items.';

// A summary in case a client drops the descriptions inside the input schema,
// where each question type is explained in full.
const QUESTION_TYPES = 'Question types: noul, a yes/no question that returns the probability of yes; choice, which '
	+ 'picks one of the options you define; and score, a position on ordered levels you describe. The input '
	+ 'schema says more about each.';

const TIES = 'Repeat calls can give slightly different numbers, so treat close values as ties.';

// claude.ai cuts a tool description off at 2,048 characters, so what each
// question type means is described in the input schema instead.
const ASK_DESCRIPTION = `Ask TypeSafe's Jev model typed questions about a piece of content and get probabilities back instead of generated text. Use it to classify, route, check a yes/no condition, grade against a rubric, score relevance, or check a claim against its evidence. ${QUESTION_TYPES}

Put everything the questions need in \`state\`. Ask the independent questions about the same state in one call, even ones that only matter in some cases, though each costs tokens. They are answered in parallel and can't see each other's answers, so state any premise in the question itself ("If this is a billing issue, ...") and ignore the answers whose premise doesn't hold. Make a second call only for questions that need an earlier answer, for example to choose the next options or gather more evidence.

Keep each question to one narrow judgment: split independent dimensions into separate questions, but don't split a judgment about how two things relate. Narrow doesn't mean literal or one sentence: interpreting something in context or choosing the next action is one judgment.

The answers are judgments, not facts. ${TIES} Several fitting options lower \`confidence\`, which is fine when any of them would do. How sure an answer must be depends on what's at stake: check the uncertain ones that matter yourself, or flag them to the user. When an answer looks wrong, first make sure the state held the evidence and the question said what you meant.`;

const ASK_BATCH_DESCRIPTION = `Ask the same questions about many states in one call, for example to classify or score a list of items. Each state is judged on its own, exactly as typesafe_ask would judge it, so scores from the same question can rank the items. ${TIES} ${QUESTION_TYPES} typesafe_ask's description explains how to write the questions. Takes up to ${MAX_BATCH_STATES} states; split a longer list across calls. Each state goes to TypeSafe as its own request with all the questions, so a batch costs about as much as that many single calls.

Results come back in input order as {index, answers} or {index, error}. Answers are compact: \`noul\`, or \`choice\` or \`score\` with \`confidence\`. Set \`include_probabilities\` to also get the probability of every option or level.

If the first state fails in a way that every state would, for example because a question is malformed, nothing else is sent and the call fails with that error. A call stops after ${TIME_BUDGET_MS / 1000} seconds; a state not answered by then comes back with an error and can be sent again.`;

const LIST_MODELS_DESCRIPTION
	= 'List the TypeSafe models this server can use, with their descriptions and release dates, and '
	+ '`default_model`, the one used when `model` is left out. Pass one of the names as `model` to the other tools.';

// Asking has no side effects beyond the tokens it uses, so every tool is safe to repeat.
const READ_ONLY = { readOnlyHint: true, idempotentHint: true, openWorldHint: true };

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
					.array(batchStateSchema)
					.min(1, { error: 'Send at least one state', abort: true })
					.max(MAX_BATCH_STATES, `Send at most ${MAX_BATCH_STATES} states; split a longer list across calls`)
					.refine(states => !states.every(isEmptyState), 'Every state is empty; there is nothing to judge')
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
		ctx => respond(ctx.mcpReq.signal, signal => listModels(signal)),
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

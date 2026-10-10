import { z } from 'zod';

// Limits from the TypeSafe API reference.
export const MAX_CHOICE_OPTIONS = 255;
export const MAX_SCORE_LEVELS = 10;

const isEntry = (value: unknown): boolean =>
	typeof value === 'string' || (typeof value === 'object' && value !== null);

// True when there is something to judge at any depth. `{ ticket: '' }` has
// nothing, but a blank field next to filled ones is normal data.
export function hasContent(value: unknown): boolean {
	if (typeof value === 'string') return value.trim() !== '';
	if (typeof value === 'object' && value !== null) return Object.values(value).some(hasContent);

	return typeof value === 'number' || typeof value === 'boolean';
}

// TypeSafe takes text, an object or an array wherever it takes content. That is
// checked here and left out of the schema clients load, where it would repeat
// for every field.
const entry = z.unknown().refine(isEntry, { message: 'Must be text, an object or an array', abort: true });

// TypeSafe answers an empty state or question with a plausible-looking
// probability, which would hide the mistake that left it empty.
const filledEntry = entry.refine(hasContent, 'Must not be empty');

const optionDescription = z
	.unknown()
	.refine(value => value === null || isEntry(value), 'Must be text, an object, an array or null');

const STATE_DESCRIPTION
	= 'The content to judge: plain text, or an object or array; not empty. When it has several parts, give '
	+ 'each a named field, such as a ticket next to the policy that applies to it. Include everything the '
	+ 'questions need, such as who is involved, how they relate and current facts like today\'s date: the '
	+ 'model sees nothing else. Work out dates, sums and exact comparisons yourself, include the results and '
	+ 'point the question at them.';

export const stateSchema = filledEntry.describe(STATE_DESCRIPTION);

// An empty item in a batch is reported in its own slot rather than failing the
// whole call, so it is let through here.
export const batchStateSchema = entry.describe(STATE_DESCRIPTION);

// Clients see this once per question type, so advice for every question goes in
// the `questions` description instead.
const instructions = filledEntry.describe(
	'The question to answer about the state. Point at a part of the state by its path in backticks, '
	+ 'such as `ticket.messages[0].text`.',
);

// An unknown key is an error, not silently dropped: criteria written as `yes`
// and `no`, for example, would otherwise vanish without anyone noticing.
const noul = z
	.strictObject({
		type: z.literal('noul'),
		instructions,
		criteria: z
			.strictObject({ true: entry.optional(), false: entry.optional() })
			.optional()
			.describe('Optional descriptions of what a yes and a no mean.'),
	})
	.describe(
		'A yes/no question; noul is TypeSafe\'s name for it. Returns `noul`, the probability of yes from 0 '
		+ 'to 1. Near 0.5 means yes and no are about equally likely, not a medium amount. When the state '
		+ 'doesn\'t say, it leans toward no, so if that matters use a choice with a "not stated" option. Ask '
		+ 'one noul per label when several labels may apply, and one per rule when breaking any single rule '
		+ 'matters.',
	);

const choice = z
	.strictObject({
		type: z.literal('choice'),
		instructions,
		criteria: z
			.record(z.string(), optionDescription, {
				error: 'Choice criteria must be an object of option names and descriptions',
			})
			.refine(options => Object.keys(options).length >= 2, 'A choice needs at least 2 options')
			.refine(
				options => Object.keys(options).length <= MAX_CHOICE_OPTIONS,
				`A choice takes at most ${MAX_CHOICE_OPTIONS} options`,
			)
			.refine(options => Object.keys(options).every(name => name.trim() !== ''), 'An option name must not be empty')
			// The checks above don't appear in the schema clients load, so the counts are added to it.
			.meta({ minProperties: 2, maxProperties: MAX_CHOICE_OPTIONS })
			.describe(
				'The options. Each key is an option and its value describes it, or is null when the name says '
				+ 'enough. Add an option such as "other" when none may fit; when it is useful on its own to know '
				+ 'whether any fits, ask that as a separate noul.',
			),
	})
	.describe(
		'Picks which one of the options you define applies. Returns `choice` and a probability for each '
		+ 'option, which only compares the options with each other, and `confidence`: how concentrated the '
		+ 'probabilities are, not proof that the answer is right or safe to act on.',
	);

const score = z
	.strictObject({
		type: z.literal('score'),
		instructions,
		criteria: z
			.array(filledEntry, { error: 'Score criteria must be a list of level descriptions, lowest first' })
			.min(2, 'A score needs at least 2 levels')
			.max(MAX_SCORE_LEVELS, `A score takes at most ${MAX_SCORE_LEVELS} levels`)
			.describe(
				'Level descriptions in order, lowest first. The score is a level index starting at 0. '
				+ 'Describe each level as a concrete situation that makes sense on its own.',
			),
	})
	.describe(
		'Rates one dimension against ordered levels you describe. Returns `score`, a probability-weighted '
		+ 'level index that can fall between two levels, and `confidence`: how concentrated the probabilities '
		+ 'are, not proof that the answer is right or safe to act on.',
	);

export const questionsSchema = z
	.record(z.string(), z.discriminatedUnion('type', [noul, choice, score]))
	.refine(questions => Object.keys(questions).length > 0, 'Ask at least one question')
	.meta({ minProperties: 1 })
	.describe(
		'Questions keyed by a name you choose; each answer comes back under the same name. The model '
		+ 'never sees the names, so the instructions and criteria must carry the whole meaning: the judgment '
		+ 'goes in the instructions, its possible answers in the criteria. Both are text, or objects or '
		+ 'arrays when definitions, contrasts, exclusions or examples make them clearer.',
	);

export const modelSchema = z
	.string()
	.optional()
	.describe('Model name. Leave it out to use the server default; typesafe_list_models shows the options.');

import { z } from 'zod';

// Limits from the TypeSafe API reference.
export const MAX_CHOICE_OPTIONS = 255;
export const MAX_SCORE_LEVELS = 10;

const isEntry = (value: unknown): boolean =>
	typeof value === 'string' || (typeof value === 'object' && value !== null);

// TypeSafe takes text, an object or an array wherever it takes content. That is
// checked here and left out of the schema clients load, where it would repeat
// for every field.
const entry = z.unknown().refine(isEntry, 'Must be text, an object or an array');

const optionDescription = z
	.unknown()
	.refine(value => value === null || isEntry(value), 'Must be text, an object, an array or null');

export const stateSchema = entry.describe(
	'The content to judge: plain text, or an object or array. When it has several parts, give each a named '
	+ 'field, such as a ticket next to the policy that applies to it. Include everything the questions need, '
	+ 'such as who is involved, how they relate and current facts like today\'s date: the model sees nothing else.',
);

// Clients see this once per question type, so advice for every question goes in
// the `questions` description instead.
const instructions = entry.describe(
	'The question to answer about the state. Point at a part of the state by its path in backticks, '
	+ 'such as `ticket.messages[0].text`.',
);

// An unknown key is an error, not silently dropped: criteria written as `yes`
// and `no`, for example, would otherwise vanish without anyone noticing.
const noul = z.strictObject({
	type: z.literal('noul'),
	instructions,
	criteria: z
		.strictObject({ true: entry.optional(), false: entry.optional() })
		.optional()
		.describe('Optional descriptions of what a yes and a no mean.'),
});

const choice = z.strictObject({
	type: z.literal('choice'),
	instructions,
	criteria: z
		.record(z.string(), optionDescription)
		.refine(options => Object.keys(options).length >= 2, 'A choice needs at least 2 options')
		.refine(
			options => Object.keys(options).length <= MAX_CHOICE_OPTIONS,
			`A choice takes at most ${MAX_CHOICE_OPTIONS} options`,
		)
		.describe(
			'The options. Each key is an option and its value describes it, or is null when the name says '
			+ 'enough. Add an option such as "other" when none may fit; when it is useful on its own to know '
			+ 'whether any fits, ask that as a separate noul.',
		),
});

const score = z.strictObject({
	type: z.literal('score'),
	instructions,
	criteria: z
		.array(entry)
		.min(2)
		.max(MAX_SCORE_LEVELS)
		.describe(
			'Level descriptions in order, lowest first. The score is a level index starting at 0. '
			+ 'Describe each level as a concrete situation that makes sense on its own.',
		),
});

export const questionsSchema = z
	.record(z.string(), z.discriminatedUnion('type', [noul, choice, score]))
	.refine(questions => Object.keys(questions).length > 0, 'Ask at least one question')
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

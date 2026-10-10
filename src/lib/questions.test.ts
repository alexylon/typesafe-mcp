import { describe, expect, it } from 'vitest';
import { MAX_CHOICE_OPTIONS, questionsSchema, stateSchema } from '@/lib/questions';

const accepts = (questions: unknown) => questionsSchema.safeParse(questions).success;

describe('questionsSchema', () => {
	it('accepts the three question types', () => {
		expect(accepts({
			urgent: { type: 'noul', instructions: 'Is it urgent?' },
			explained: { type: 'noul', instructions: 'Is it urgent?', criteria: { true: 'Time-sensitive' } },
			team: { type: 'choice', instructions: 'Which team?', criteria: { billing: 'Payments', other: null } },
			tone: { type: 'score', instructions: { question: 'How angry?' }, criteria: ['Calm', 'Angry'] },
		})).toBe(true);
	});

	it('refuses no questions at all', () => {
		expect(accepts({})).toBe(false);
	});

	it('refuses a question without instructions or with an unknown type', () => {
		expect(accepts({ q: { type: 'noul' } })).toBe(false);
		expect(accepts({ q: { type: 'noul', instructions: '' } })).toBe(false);
		expect(accepts({ q: { type: 'noul', instructions: {} } })).toBe(false);
		expect(accepts({ q: { type: 'noul', instructions: 42 } })).toBe(false);
		expect(accepts({ q: { type: 'ranking', instructions: 'Which is best?' } })).toBe(false);
	});

	it('holds a score to between 2 and 10 levels', () => {
		const withLevels = (count: number) => ({
			q: { type: 'score', instructions: 'How much?', criteria: Array.from({ length: count }, (_, i) => `Level ${i}`) },
		});

		expect(accepts(withLevels(1))).toBe(false);
		expect(accepts(withLevels(2))).toBe(true);
		expect(accepts(withLevels(10))).toBe(true);
		expect(accepts(withLevels(11))).toBe(false);
	});

	it('refuses an empty option name', () => {
		expect(accepts({ q: { type: 'choice', instructions: 'Which one?', criteria: { '': null, other: null } } })).toBe(false);
		expect(accepts({ q: { type: 'choice', instructions: 'Which one?', criteria: { '  ': null, other: null } } })).toBe(false);
	});

	it('explains criteria that are missing, the wrong type or the wrong size', () => {
		const messages = (questions: unknown) => questionsSchema.safeParse(questions).error?.issues.map(issue => issue.message);
		const levels = (count: number) => Array.from({ length: count }, (_, i) => `Level ${i}`);

		expect(messages({ q: { type: 'choice', instructions: 'Which one?' } }))
			.toEqual(['Choice criteria must be an object of option names and descriptions']);
		expect(messages({ q: { type: 'choice', instructions: 'Which one?', criteria: ['refund', 'exchange'] } }))
			.toEqual(['Choice criteria must be an object of option names and descriptions']);
		expect(messages({ q: { type: 'score', instructions: 'How much?' } }))
			.toEqual(['Score criteria must be a list of level descriptions, lowest first']);
		expect(messages({ q: { type: 'score', instructions: 'How much?', criteria: levels(1) } }))
			.toEqual(['A score needs at least 2 levels']);
		expect(messages({ q: { type: 'score', instructions: 'How much?', criteria: levels(11) } }))
			.toEqual(['A score takes at most 10 levels']);
	});

	it('says that missing instructions are required', () => {
		expect(questionsSchema.safeParse({ q: { type: 'noul' } }).error?.issues.map(issue => issue.message)).toEqual(['Required']);
	});

	it('takes the word "null" as written inside a question', () => {
		expect(accepts({ q: { type: 'score', instructions: 'How many values are set?', criteria: ['null', 'some', 'all'] } })).toBe(true);
	});

	it('refuses an empty score level', () => {
		expect(accepts({ q: { type: 'score', instructions: 'How much?', criteria: ['', 'High'] } })).toBe(false);
	});

	it('holds a choice to between 2 and 255 options', () => {
		const withOptions = (count: number) => ({
			q: {
				type: 'choice',
				instructions: 'Which one?',
				criteria: Object.fromEntries(Array.from({ length: count }, (_, i) => [`option-${i}`, null])),
			},
		});

		expect(accepts(withOptions(1))).toBe(false);
		expect(accepts(withOptions(2))).toBe(true);
		expect(accepts(withOptions(MAX_CHOICE_OPTIONS))).toBe(true);
		expect(accepts(withOptions(MAX_CHOICE_OPTIONS + 1))).toBe(false);
	});

	it('refuses a key it does not know instead of dropping it', () => {
		expect(accepts({ q: { type: 'noul', instructions: 'Is it urgent?', criteria: { yes: 'Time-sensitive' } } })).toBe(false);
		expect(accepts({ q: { type: 'noul', instructions: 'Is it urgent?', criterion: { true: 'Time-sensitive' } } })).toBe(false);
	});
});

describe('stateSchema', () => {
	it('takes text, an object or an array, and nothing else', () => {
		for (const state of ['some text', { ticket: { body: 'text' } }, ['a', 'b']]) {
			expect(stateSchema.safeParse(state).success).toBe(true);
		}

		for (const state of [42, true, null, undefined]) {
			expect(stateSchema.safeParse(state).success).toBe(false);
		}
	});

	it('refuses a state with nothing in it, at any depth', () => {
		for (const state of ['', '   ', {}, [], { ticket: '' }, { ticket: { body: ' ' } }, ['  '], [null]]) {
			expect(stateSchema.safeParse(state).success).toBe(false);
		}

		expect(stateSchema.safeParse({ amount: 0 }).success).toBe(true);
	});

	it('refuses a state that is just the text "null", but not "null" inside one', () => {
		expect(stateSchema.safeParse('null').success).toBe(false);
		expect(stateSchema.safeParse(' null ').success).toBe(false);
		expect(stateSchema.safeParse({ expression: 'null' }).success).toBe(true);
	});
});

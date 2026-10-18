/**
 * QuizAsk — the graded `quiz` tool.
 *
 * Ported from the legacy `quiz` pi-extension (extensions/quiz.ts): options-only
 * single/multi select with an automatic "I don't know" row, instant grading,
 * plus the new staged flow — the answer locks in first, THEN a confidence
 * picker (1 Sure / 2 Pretty sure / 3 Guessed, skippable) and an optional note
 * run, so confidence can never contaminate correctness.
 *
 * UI runs over the shared.ts bridge (`ui()`); without a handler (headless /
 * --print) every stage resolves aborted and the tool returns `quiz dismissed`.
 */
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import { Type } from "@earendil-works/pi-ai";
import { EXT, TOOL, ui, type QuizResult } from "../shared.ts";

// Shared UI mutex (legacy port). `ui()` dialogs show in the TUI's one overlay
// slot, so every popup-style tool (quiz here, ask_user in Teach) must
// serialize against the others, not just itself. Stashed on globalThis so
// separate extension modules share one lock without importing each other.
const SHARED_UI_LOCK_KEY = "__piSharedUiLock";

function getSharedUiLock(): { withLock<T>(fn: () => T | Promise<T>): Promise<T> } {
	const g = globalThis as Record<string, unknown>;
	let lock = g[SHARED_UI_LOCK_KEY] as { withLock<T>(fn: () => T | Promise<T>): Promise<T> } | undefined;
	if (!lock) {
		let chain: Promise<unknown> = Promise.resolve();
		lock = {
			withLock<T>(fn: () => T | Promise<T>): Promise<T> {
				const prev = chain;
				let release: () => void;
				chain = new Promise<void>((r) => {
					release = r;
				});
				return prev.then(fn).finally(() => release!());
			},
		};
		g[SHARED_UI_LOCK_KEY] = lock;
	}
	return lock;
}

const sharedUiLock = getSharedUiLock();

function errorResult(message: string) {
	return { output: [{ type: "text" as const, text: message }], isError: true };
}

/** Exact-set comparison, order-insensitive (legacy isCorrect port). */
function sameSet(a: number[], b: number[]): boolean {
	if (a.length !== b.length) return false;
	const sa = [...a].sort((x, y) => x - y);
	const sb = [...b].sort((x, y) => x - y);
	return sa.every((v, i) => v === sb[i]);
}

const QuizParams = Type.Object({
	question: Type.String({ description: "The single quiz question to ask. Exactly one question per call." }),
	mode: Type.Optional(
		Type.Union([Type.Literal("choice"), Type.Literal("free")], {
			description:
				'"choice" (default): multiple-choice. "free": the user types the answer in his own words and YOU grade its quality in the next message — use free whenever distractors would leak the answer or the skill is producing/deriving rather than recognizing.',
		}),
	),
	options: Type.Optional(
		Type.Array(Type.String(), {
			minItems: 2,
			description:
				"choice mode only: the answer options, shown in the order given (indexes are 0-based). Two or more. Do NOT add an 'I don't know' option — it is appended automatically and reported as dontKnow.",
		}),
	),
	correct: Type.Optional(
		Type.Array(Type.Number(), {
			minItems: 1,
			description:
				"choice mode only: 0-based index(es) into `options` marking the correct answer(s). Single-select: exactly one index. Multi-select: every correct index — graded as an exact set match (every correct option and no incorrect one).",
		}),
	),
	multiple: Type.Optional(
		Type.Boolean({ description: "choice mode only: set true when more than one option is correct and the user must select all of them." }),
	),
	explanation: Type.String({
		description:
			"REQUIRED. Why the correct answer is correct (choice mode), or what a complete correct answer covers (free mode). Shown to the user only AFTER answering (never leaked before), and returned in the result for the log.",
	}),
});

const quizTool = defineTool({
	name: TOOL.quiz,
	description:
		"Ask the user a graded quiz. Choice mode: multiple-choice / multi-select, instantly graded (user reasons FIRST in a text panel, then locks an answer from options + an automatic 'I don't know' row, then picks confidence 1 Sure / 2 Pretty sure / 3 Guessed). Free mode (mode='free'): the user types the answer in his own words; YOU grade its quality in the next message against the explanation. The result is a JSON object: {question, mode, reasoning, selected, freeAnswer?, correctIndices, correct, dontKnow, confidence, explanation}. " +
		"Interpret the grade x confidence matrix: wrong + Sure (1) = high-priority misconception — stop and correct directly; right + Guessed (3) = unconfirmed — re-probe from another angle; right + Pretty sure (2) = confirm why it is right; right + Sure (1) = floor confirmed — build on it; dontKnow = genuine gap, teach as new. Free mode: correct is null — judge freeAnswer against the explanation and say what was missing/wrong. " +
		"A non-empty reasoning (or freeAnswer) is the user's mental model in his own words — mine it: form a concrete hypothesis and write the next question to discriminate that hypothesis from the truth; if it asks a question, answer it before quizzing again. " +
		"Craft distractors as diagnostic probes (specific believable misconceptions, unambiguously wrong, similar in length/precision so the answer cannot be picked by shape). Keep options unshuffled — vary the correct position yourself. Prefer free mode whenever options would leak the answer. " +
		"You may batch several quiz calls (plus background subagent dispatches) in ONE round: the dialogs queue one after another with no model delay between them, and prep runs underneath. After a quiz, mirror it with md_log(kind='quiz', content=<this result JSON>, options=<the same options array if any>).",
	parameters: QuizParams,
	replay: "safe",

	async execute(args) {
		const free = args.mode === "free";
		const multiple = !free && args.multiple === true;
		const mode: QuizResult["mode"] = free ? "free" : multiple ? "multiple" : "single";

		// -- validation --------------------------------------------------------
		if (free) {
			if (args.options !== undefined || args.correct !== undefined) {
				return errorResult("quiz free mode takes no options/correct — you grade the typed answer yourself");
			}
		} else if (args.options === undefined || args.correct === undefined) {
			return errorResult("quiz choice mode requires options and correct");
		}
		const options = (args.options ?? []).map((o) => o.trim());
		if (!free) {
			if (options.some((o) => o.length === 0)) {
				return errorResult("quiz requires non-empty option labels");
			}
			if (new Set(options).size !== options.length) {
				return errorResult("quiz options must be unique");
			}
		}

		const correctIndices = [...new Set(args.correct ?? [])]
			.filter((i) => Number.isInteger(i) && i >= 0 && i < options.length)
			.sort((a, b) => a - b);
		if (!free) {
			if (correctIndices.length !== new Set(args.correct ?? []).size) {
				return errorResult(
					`quiz correct indexes must be integers in [0, ${options.length - 1}] (0-based, into options)`,
				);
			}
			if (!multiple && correctIndices.length !== 1) {
				return errorResult("quiz single-select needs exactly one correct index; use multiple:true for multi-select");
			}
			if (multiple && correctIndices.length < 1) {
				return errorResult("quiz multi-select needs at least one correct index");
			}
		}

		// ONE dialog holds everything: question + choices (choice mode) + the
		// reasoning editor side by side, then the confidence strip in the same
		// buffer. The dialogs still serialize against ask_user via the mutex.
		return sharedUiLock.withLock(async () => {
			const answer = await ui({
				kind: "quiz",
				question: args.question,
				free,
				...(free ? {} : { options, multiple }),
			});
			if ("aborted" in answer) {
				// Dismissed, or no UI handler attached (headless).
				return errorResult("quiz dismissed");
			}

			const { quiz, reasoning, confidence } = answer;
			const dontKnow = "dontKnow" in quiz;
			const selected = "selected" in quiz ? quiz.selected : [];
			const freeAnswer = "freeAnswer" in quiz ? quiz.freeAnswer : undefined;

			const result: QuizResult = {
				question: args.question,
				mode,
				reasoning,
				selected,
				...(free ? { freeAnswer } : {}),
				correctIndices,
				correct: free ? null : !dontKnow && sameSet(selected, correctIndices),
				dontKnow,
				confidence,
				explanation: args.explanation,
			};
			return { output: [{ type: "text" as const, text: JSON.stringify(result) }], details: result };
		});
	},
});

export const QuizAsk = defineExtension({ name: EXT.quizAsk, tools: [quizTool] });

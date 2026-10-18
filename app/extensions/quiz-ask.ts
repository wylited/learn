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
import { EXT, TOOL, ui, type Confidence, type QuizResult } from "../shared.ts";

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
	options: Type.Array(Type.String(), {
		minItems: 2,
		description:
			"The answer options, shown in the order given (indexes are 0-based). Two or more. Do NOT add an 'I don't know' option — it is appended automatically and reported as dontKnow.",
	}),
	correct: Type.Array(Type.Number(), {
		minItems: 1,
		description:
			"0-based index(es) into `options` marking the correct answer(s). Single-select: exactly one index. Multi-select: every correct index — graded as an exact set match (every correct option and no incorrect one).",
	}),
	multiple: Type.Optional(
		Type.Boolean({ description: "Set true when more than one option is correct and the user must select all of them." }),
	),
	explanation: Type.String({
		description:
			"REQUIRED. Why the correct answer is correct. Shown to the user only AFTER answering (never leaked before), and returned in the result for the log.",
	}),
});

const quizTool = defineTool({
	name: TOOL.quiz,
	description:
		"Ask the user a GRADED multiple-choice or multi-select question, then instantly grade it. The user first locks in an answer (options + an automatic 'I don't know' row), then picks a confidence (1 Sure / 2 Pretty sure / 3 Guessed, skippable), then may attach a free-text note. The result is a JSON object: {question, mode, selected, correctIndices, correct, dontKnow, confidence, note, explanation}. " +
		"Interpret the grade x confidence matrix: wrong + Sure (1) = high-priority misconception — stop and correct directly; right + Guessed (3) = unconfirmed — re-probe from another angle; right + Pretty sure (2) = confirm why it is right; right + Sure (1) = floor confirmed — build on it; dontKnow = genuine gap, teach as new. " +
		"A non-empty note is the user's mental model in his own words — mine it: form a concrete hypothesis and write the next question to discriminate that hypothesis from the truth; if the note asks a question, answer it before quizzing again. " +
		"Craft distractors as diagnostic probes (specific believable misconceptions, unambiguously wrong, similar in length/precision so the answer cannot be picked by shape). Keep options unshuffled — vary the correct position yourself. After a quiz, mirror it with md_log(kind='quiz', content=<this result JSON>, options=<the same options array>).",
	parameters: QuizParams,
	replay: "safe",

	async execute(args) {
		const multiple = args.multiple === true;
		const mode: QuizResult["mode"] = multiple ? "multiple" : "single";

		const options = args.options.map((o) => o.trim());
		if (options.some((o) => o.length === 0)) {
			return errorResult("quiz requires non-empty option labels");
		}
		if (new Set(options).size !== options.length) {
			return errorResult("quiz options must be unique");
		}

		const correctIndices = [...new Set(args.correct)]
			.filter((i) => Number.isInteger(i) && i >= 0 && i < options.length)
			.sort((a, b) => a - b);
		if (correctIndices.length !== new Set(args.correct).size) {
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

		return sharedUiLock.withLock(async () => {
			const answer = await ui({
				kind: "quiz-answer",
				question: args.question,
				options,
				multiple,
			});
			if (!("selected" in answer) && !("dontKnow" in answer)) {
				// Dismissed, or no UI handler attached (headless).
				return errorResult("quiz dismissed");
			}

			const dontKnow = "dontKnow" in answer;
			const selected = dontKnow
				? []
				: [...new Set("selected" in answer ? answer.selected : [])]
						.filter((i) => Number.isInteger(i) && i >= 0 && i < options.length)
						.sort((a, b) => a - b);

			// Stages two and three run only for a real answer; "I don't know"
			// skips them (DECIDED: dontKnow records no confidence, no note).
			let confidence: Confidence | null = null;
			let note = "";
			if (!dontKnow) {
				const confidenceResponse = await ui({ kind: "quiz-confidence", question: args.question });
				if ("confidence" in confidenceResponse) confidence = confidenceResponse.confidence;
				const noteResponse = await ui({ kind: "quiz-note", question: args.question });
				if ("note" in noteResponse) note = noteResponse.note.trim();
			}

			const result: QuizResult = {
				question: args.question,
				mode,
				selected,
				correctIndices,
				correct: !dontKnow && sameSet(selected, correctIndices),
				dontKnow,
				confidence,
				note,
				explanation: args.explanation,
			};
			return { output: [{ type: "text" as const, text: JSON.stringify(result) }], details: result };
		});
	},
});

export const QuizAsk = defineExtension({ name: EXT.quizAsk, tools: [quizTool] });

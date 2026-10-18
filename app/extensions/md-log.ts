/**
 * MdLog — the `md_log` tool: append-only mirror of the lesson into a markdown
 * file meant to be read rendered (Obsidian): LaTeX, code, and `![[viz-…]]`
 * embeds all render natively.
 *
 * Ported from the legacy md-log pi-extension (extensions/md-log.ts): same
 * Obsidian callout block formats for questions and quiz answers. The legacy
 * event-driven mirroring is dropped — the teacher calls `md_log` explicitly
 * after each exchange (DECIDED in the build notes).
 *
 * Every appended batch ends with an invisible marker `<!-- md-log:<id> -->`
 * (id = the durable tool call id). The file is never regenerated; a replayed
 * call after a crash sees its own marker already present and skips, so
 * recovery never double-appends.
 */
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import { Type } from "@earendil-works/pi-ai";
import * as fs from "node:fs";
import * as path from "node:path";
import { EXT, TOOL, type QuizResult } from "../shared.ts";

// --- Log target -------------------------------------------------------------

let cachedRoot: string | null = null;

function repoRoot(): string {
	if (process.env.LEARN_REPO_ROOT) return process.env.LEARN_REPO_ROOT;
	if (cachedRoot) return cachedRoot;
	let dir = import.meta.dirname;
	for (;;) {
		if (fs.existsSync(path.join(dir, "skills")) && fs.existsSync(path.join(dir, "agents"))) {
			cachedRoot = dir;
			return dir;
		}
		const parent = path.dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	return process.cwd();
}

/** `/md-log <path>` target override; `null` falls back to the default file. */
let logPathOverride: string | null = null;

export function setLogPath(file: string | null): void {
	logPathOverride = file;
}

export function getLogPath(): string {
	return logPathOverride ?? path.join(repoRoot(), "learn-log.md");
}

// --- Legacy block formats (Obsidian callouts) --------------------------------

function callout(type: string, title: string, bodyLines: string[]): string {
	const lines = [`> [!${type}] ${title}`];
	for (const line of bodyLines) {
		lines.push(line.length === 0 ? ">" : `> ${line}`);
	}
	return lines.join("\n");
}

function questionCallout(label: string, question: string, options: string[]): string {
	const body = question.split("\n");
	if (options.length > 0) {
		body.push("");
		options.forEach((label2, i) => body.push(`${i + 1}. ${label2}`));
	}
	return callout("question", label, body);
}

const CONFIDENCE_LABEL: Record<number, string> = {
	1: "1 · Sure",
	2: "2 · Pretty sure",
	3: "3 · Guessed",
};

function optionRef(index: number, labels: string[] | undefined): string {
	const label = labels?.[index];
	return label != null ? `${index + 1}. ${label}` : `${index + 1}`;
}

function answerCalloutQuiz(result: QuizResult, labels: string[] | undefined): string {
	// "I don't know" is neither correct nor incorrect — a distinct signal, so
	// it never renders as a red ✗ (legacy port).
	const type = result.dontKnow ? "question" : result.correct ? "success" : "failure";
	const title = result.dontKnow
		? "Quiz — I don't know"
		: result.correct
			? "Quiz — correct ✓"
			: "Quiz — incorrect ✗";

	const body: string[] = [];
	body.push(
		result.dontKnow
			? "Your answer: I don't know"
			: `Your answer: ${result.selected.map((i) => optionRef(i, labels)).join(", ") || "(none)"}`,
	);
	body.push(`Correct answer: ${result.correctIndices.map((i) => optionRef(i, labels)).join(", ")}`);
	body.push(`Confidence: ${result.confidence != null ? CONFIDENCE_LABEL[result.confidence] : "—"}`);

	if (result.note) {
		body.push("");
		const noteLines = result.note.split("\n");
		body.push(`Note: ${noteLines[0]}`);
		for (let i = 1; i < noteLines.length; i++) body.push(noteLines[i]);
	}

	if (result.explanation) {
		body.push("");
		body.push(...result.explanation.split("\n"));
	}
	return callout(type, title, body);
}

/** Quiz blocks: pass the quiz tool's JSON result as `content`. */
function isQuizResult(value: unknown): value is QuizResult {
	if (typeof value !== "object" || value === null) return false;
	const v = value as Record<string, unknown>;
	return (
		typeof v.question === "string" &&
		Array.isArray(v.selected) &&
		Array.isArray(v.correctIndices) &&
		typeof v.correct === "boolean" &&
		typeof v.dontKnow === "boolean"
	);
}

function quizBlock(content: string, labels: string[] | undefined): string {
	try {
		const parsed: unknown = JSON.parse(content);
		if (isQuizResult(parsed)) {
			return questionCallout("Quiz", parsed.question, labels ?? []) + "\n\n" + answerCalloutQuiz(parsed, labels);
		}
	} catch {
		// Not JSON — fall through and log the text verbatim.
	}
	return content.trim();
}

// --- Tool --------------------------------------------------------------------

const LogKinds = Type.Union([Type.Literal("q&a"), Type.Literal("quiz"), Type.Literal("note"), Type.Literal("viz")]);

const MdLogParams = Type.Object({
	content: Type.String({
		description:
			"The block body as markdown. For kind='quiz': pass the quiz tool's JSON result verbatim (the block is formatted for you). For kind='q&a': the user's prompt and your answer prose. For kind='viz': the embed, e.g. ![[viz-half-adder-<ts>.svg|500]].",
	}),
	kind: Type.Optional(LogKinds),
	options: Type.Optional(
		Type.Array(Type.String(), {
			description: "For kind='quiz' only: the option labels in the same order you passed to the quiz tool, so the log renders readable answers.",
		}),
	),
});

function clock(): string {
	const now = new Date();
	const pad = (n: number) => String(n).padStart(2, "0");
	return `${pad(now.getHours())}:${pad(now.getMinutes())}`;
}

const mdLogTool = defineTool({
	name: TOOL.log,
	description:
		"Append a block to the lesson log (learn-log.md at the repo root; meant to be read rendered, e.g. Obsidian). " +
		"Call it as the lesson progresses: kind='q&a' after each meaningful exchange (the user's prompt + your answer prose), " +
		"kind='quiz' right after every quiz result (content = the quiz tool's JSON result verbatim, options = the same options array you passed), " +
		"kind='viz' for each published visual embed, kind='note' for asides. Append-only: never rewrite or restate earlier blocks — log each thing once.",
	parameters: MdLogParams,
	replay: "safe",

	async execute(args, api) {
		const kind = args.kind ?? "note";
		const file = getLogPath();
		const markerId = api.callId;

		const body = kind === "quiz" ? quizBlock(args.content, args.options) : args.content.trim();
		if (body.length === 0) return { output: [{ type: "text" as const, text: "md_log skipped: empty content" }] };

		const block = `## [${clock()}] ${kind}\n\n${body}`;
		try {
			const current = fs.existsSync(file) ? fs.readFileSync(file, "utf-8") : "";
			const marker = `<!-- md-log:${markerId} -->`;
			if (current.includes(marker)) {
				// Replay of an already-committed call: keep the file as-is.
				return {
					output: [{ type: "text" as const, text: `already logged (${kind})` }],
					details: { file, kind, id: markerId, duplicate: true },
				};
			}
			const base = current.replace(/\s+$/, "");
			const prefix = base.length > 0 ? "\n\n" : "";
			fs.mkdirSync(path.dirname(file), { recursive: true });
			fs.writeFileSync(file, base + prefix + block + "\n" + marker + "\n", "utf-8");
		} catch (e) {
			return { output: [{ type: "text" as const, text: `md_log failed: ${(e as Error).message}` }], isError: true };
		}
		return {
			output: [{ type: "text" as const, text: `logged ${kind} → ${file}` }],
			details: { file, kind, id: markerId },
		};
	},
});

export const MdLog = defineExtension({ name: EXT.mdlog, tools: [mdLogTool] });

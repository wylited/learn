/**
 * pi-tui overlay dialogs for the quiz flow: answer → confidence → note.
 *
 * Ported from the legacy `quiz` pi-extension (extensions/quiz.ts): the same
 * option-list layout, the visually separated dim "I don't know" row, the note
 * editor, and the width-keyed render cache — rendered as TuiMainScreen overlays
 * instead of `ctx.ui.custom` surfaces.
 */
import {
	Editor,
	type EditorTheme,
	Key,
	matchesKey,
	truncateToWidth,
	wrapTextWithAnsi,
	foregroundAnsi,
	indexedColor,
	styleTextWithAnsi,
	type Component,
	type OverlayHandle,
	type OverlayOptions,
	type TUI,
} from "@earendil-works/pi-tui";
import type { Confidence, UiRequest, UiResponse } from "../shared.ts";

// ---------------------------------------------------------------------------
// Color palette. The old coding-agent Theme object does not exist in pi-tui;
// dialogs carry a minimal 256-color palette that renders on any terminal.
// ---------------------------------------------------------------------------

type Role = "accent" | "success" | "error" | "warning" | "muted" | "dim" | "text";

const ansi = (index: number) => foregroundAnsi(indexedColor(index), "256color");
const COLORS: Record<Exclude<Role, "text">, string> = {
	accent: ansi(39), // cyan
	success: ansi(2), // green
	error: ansi(1), // red
	warning: ansi(3), // yellow
	muted: ansi(245), // light gray
	dim: ansi(243), // gray
};

export const theme = {
	fg(role: Role, text: string): string {
		return role === "text" ? text : styleTextWithAnsi(text, COLORS[role], undefined, {});
	},
};

export function createEditorTheme(): EditorTheme {
	return {
		borderColor: (s) => theme.fg("accent", s),
		selectList: {
			selectedPrefix: (t) => theme.fg("accent", t),
			selectedText: (t) => theme.fg("accent", t),
			description: (t) => theme.fg("muted", t),
			scrollInfo: (t) => theme.fg("dim", t),
			noMatch: (t) => theme.fg("warning", t),
		},
	};
}

export function addWrapped(lines: string[], text: string, width: number, indent = ""): void {
	const contentWidth = Math.max(1, width - indent.length);
	for (const line of wrapTextWithAnsi(text, contentWidth)) {
		lines.push(truncateToWidth(`${indent}${line}`, width));
	}
}

export const DIALOG_OPTIONS: OverlayOptions = { width: "72%", minWidth: 40, anchor: "center" };

/** Show `component` as an overlay; resolve when the dialog calls `done`. */
export function showOverlayDialog<T>(
	tui: TUI,
	make: (done: (value: T) => void) => Component,
	options: OverlayOptions = DIALOG_OPTIONS,
): Promise<T> {
	return new Promise<T>((resolve) => {
		let handle: OverlayHandle | undefined;
		let settled = false;
		const component = make((value) => {
			if (settled) return;
			settled = true;
			handle?.hide();
			resolve(value);
		});
		handle = tui.showOverlay(component, options);
	});
}

/** Base for dialogs: bordered header + width-keyed render cache (see legacy quiz.ts). */
export abstract class Dialog implements Component {
	protected cachedLines: string[] | undefined;
	protected cachedWidth = -1;
	protected readonly tui: TUI;

	constructor(tui: TUI) {
		this.tui = tui;
	}

	protected refresh(): void {
		this.cachedLines = undefined;
		this.tui.requestRender();
	}

	abstract render(width: number): string[];
	abstract handleInput(data: string): void;

	invalidate(): void {
		this.cachedLines = undefined;
	}
}

// ---------------------------------------------------------------------------
// quiz-answer: option list + "I don't know" (+ Submit when multiple)
// ---------------------------------------------------------------------------

const DONT_KNOW_LABEL = "I don't know";

type QuizAnswerRequest = Extract<UiRequest, { kind: "quiz-answer" }>;

class QuizAnswerDialog extends Dialog {
	private cursor = 0;
	private readonly selected = new Set<number>();
	private dontKnowChosen = false;
	private readonly req: QuizAnswerRequest;
	private readonly done: (r: UiResponse) => void;

	constructor(tui: TUI, req: QuizAnswerRequest, done: (r: UiResponse) => void) {
		super(tui);
		this.req = req;
		this.done = done;
	}

	/** nav index of the "I don't know" row (after the real options) */
	private get dontKnowNav(): number {
		return this.req.options.length;
	}
	/** nav index of the Submit row (multiple only) */
	private get submitNav(): number {
		return this.req.options.length + 1;
	}

	private toggleDontKnow(): void {
		this.dontKnowChosen = !this.dontKnowChosen;
		if (this.dontKnowChosen) this.selected.clear();
	}

	private toggleOption(index: number): void {
		this.dontKnowChosen = false;
		if (this.selected.has(index)) this.selected.delete(index);
		else this.selected.add(index);
	}

	private submit(): void {
		if (this.dontKnowChosen) this.done({ dontKnow: true });
		else if (this.selected.size > 0) {
			this.done({ selected: [...this.selected].sort((a, b) => a - b) });
		}
	}

	handleInput(data: string): void {
		if (matchesKey(data, Key.up)) {
			this.cursor = Math.max(0, this.cursor - 1);
			this.refresh();
			return;
		}
		if (matchesKey(data, Key.down)) {
			const max = this.req.multiple ? this.submitNav : this.dontKnowNav;
			this.cursor = Math.min(max, this.cursor + 1);
			this.refresh();
			return;
		}
		if (matchesKey(data, Key.enter)) {
			if (!this.req.multiple) {
				if (this.cursor === this.dontKnowNav) this.done({ dontKnow: true });
				else this.done({ selected: [this.cursor] });
				return;
			}
			if (this.cursor === this.submitNav) this.submit();
			else if (this.cursor === this.dontKnowNav) this.toggleDontKnow();
			else this.toggleOption(this.cursor);
			this.refresh();
			return;
		}
		if (this.req.multiple && matchesKey(data, Key.space)) {
			if (this.cursor === this.submitNav) return;
			if (this.cursor === this.dontKnowNav) this.toggleDontKnow();
			else this.toggleOption(this.cursor);
			this.refresh();
			return;
		}
		if (matchesKey(data, Key.escape)) this.done({ aborted: true });
	}

	render(width: number): string[] {
		// Cache keyed on width: pi-tui re-renders on resize without invalidate().
		if (this.cachedLines && this.cachedWidth === width) return this.cachedLines;

		const lines: string[] = [];
		const add = (text: string) => lines.push(truncateToWidth(text, width));
		add(theme.fg("accent", "─".repeat(width)));
		addWrapped(lines, theme.fg("text", this.req.question), width, " ");
		if (this.req.hint) {
			lines.push("");
			addWrapped(lines, theme.fg("muted", this.req.hint), width, " ");
		}
		lines.push("");

		for (let i = 0; i < this.req.options.length; i++) {
			const focused = i === this.cursor;
			const prefix = focused ? theme.fg("accent", "> ") : "  ";
			let label = `${i + 1}. ${this.req.options[i]}`;
			if (this.req.multiple) label = `${this.selected.has(i) ? "[x]" : "[ ]"} ${label}`;
			const styled = focused
				? theme.fg("accent", label)
				: theme.fg(this.req.multiple && this.selected.has(i) ? "success" : "text", label);
			add(`${prefix}${styled}`);
		}

		// "I don't know" row — visually separated and dimmed (legacy port).
		lines.push("");
		const dkFocused = this.cursor === this.dontKnowNav;
		const dkPrefix = dkFocused ? theme.fg("accent", "> ") : "  ";
		let dkLabel = DONT_KNOW_LABEL;
		if (this.req.multiple) dkLabel = `${this.dontKnowChosen ? "[x]" : "[ ]"} ${dkLabel}`;
		const dkStyled = dkFocused
			? theme.fg("accent", dkLabel)
			: theme.fg(this.req.multiple && this.dontKnowChosen ? "warning" : "dim", dkLabel);
		add(`${dkPrefix}${dkStyled}`);

		if (this.req.multiple) {
			const picked = this.dontKnowChosen ? 1 : this.selected.size;
			const label = picked > 0 ? `✓ Submit (${picked} selected)` : "○ Submit";
			const focused = this.cursor === this.submitNav;
			const styled = focused
				? theme.fg("accent", label)
				: theme.fg(picked > 0 ? "success" : "dim", label);
			add(`${focused ? theme.fg("accent", "> ") : "  "}${styled}`);
		}

		lines.push("");
		if (this.req.multiple && this.selected.size === 0 && !this.dontKnowChosen) {
			add(theme.fg("warning", " Select at least one answer before submitting."));
		}
		add(
			this.req.multiple
				? theme.fg("dim", " ↑↓ navigate • Space toggle • Enter submit • Esc cancel")
				: theme.fg("dim", " ↑↓ navigate • Enter answer • Esc cancel"),
		);
		add(theme.fg("accent", "─".repeat(width)));

		this.cachedLines = lines;
		this.cachedWidth = width;
		return lines;
	}
}

// ---------------------------------------------------------------------------
// quiz-confidence: 1 Sure · 2 Pretty sure · 3 Guessed (Esc skips)
// ---------------------------------------------------------------------------

const CONFIDENCE_ROWS: { key: "1" | "2" | "3"; label: string; value: Confidence }[] = [
	{ key: "1", label: "1 · Sure", value: 1 },
	{ key: "2", label: "2 · Pretty sure", value: 2 },
	{ key: "3", label: "3 · Guessed", value: 3 },
];

class QuizConfidenceDialog extends Dialog {
	private cursor = 0;
	private readonly req: Extract<UiRequest, { kind: "quiz-confidence" }>;
	private readonly done: (r: UiResponse) => void;

	constructor(tui: TUI, req: Extract<UiRequest, { kind: "quiz-confidence" }>, done: (r: UiResponse) => void) {
		super(tui);
		this.req = req;
		this.done = done;
	}

	handleInput(data: string): void {
		for (const row of CONFIDENCE_ROWS) {
			if (matchesKey(data, row.key)) {
				this.done({ confidence: row.value });
				return;
			}
		}
		if (matchesKey(data, Key.up)) {
			this.cursor = Math.max(0, this.cursor - 1);
			this.refresh();
			return;
		}
		if (matchesKey(data, Key.down)) {
			this.cursor = Math.min(CONFIDENCE_ROWS.length - 1, this.cursor + 1);
			this.refresh();
			return;
		}
		if (matchesKey(data, Key.enter)) {
			this.done({ confidence: CONFIDENCE_ROWS[this.cursor].value });
			return;
		}
		if (matchesKey(data, Key.escape)) this.done({ skipped: true });
	}

	render(width: number): string[] {
		if (this.cachedLines && this.cachedWidth === width) return this.cachedLines;

		const lines: string[] = [];
		const add = (text: string) => lines.push(truncateToWidth(text, width));
		add(theme.fg("accent", "─".repeat(width)));
		addWrapped(lines, styleTextWithAnsi("How sure were you?", undefined, undefined, { bold: true }), width, " ");
		lines.push("");
		addWrapped(lines, theme.fg("muted", this.req.question), width, " ");
		lines.push("");
		CONFIDENCE_ROWS.forEach((row, i) => {
			const focused = i === this.cursor;
			const styled = focused ? theme.fg("accent", row.label) : theme.fg("text", row.label);
			add(`${focused ? theme.fg("accent", "> ") : "  "}${styled}`);
		});
		lines.push("");
		add(theme.fg("dim", " 1/2/3 to answer • Esc to skip"));
		add(theme.fg("accent", "─".repeat(width)));

		this.cachedLines = lines;
		this.cachedWidth = width;
		return lines;
	}
}

// ---------------------------------------------------------------------------
// quiz-note: free-text note editor (Enter confirms, Esc skips)
// ---------------------------------------------------------------------------

class QuizNoteDialog extends Dialog {
	private readonly editor: Editor;
	private readonly done: (r: UiResponse) => void;

	constructor(tui: TUI, done: (r: UiResponse) => void) {
		super(tui);
		this.done = done;
		// disableSubmit: the editor's own submit path would clear the buffer;
		// Enter is intercepted here instead (legacy port).
		this.editor = new Editor(tui, createEditorTheme());
		this.editor.focused = true;
		this.editor.disableSubmit = true;
	}

	handleInput(data: string): void {
		if (matchesKey(data, Key.enter)) {
			this.done({ note: this.editor.getText() });
			return;
		}
		if (matchesKey(data, Key.escape)) {
			this.done({ skipped: true });
			return;
		}
		this.editor.handleInput(data);
		this.tui.requestRender();
	}

	render(width: number): string[] {
		const lines: string[] = [];
		const add = (text: string) => lines.push(truncateToWidth(text, width));
		add(theme.fg("accent", "─".repeat(width)));
		addWrapped(lines, theme.fg("muted", " notes for yourself (optional)"), width, " ");
		lines.push("");
		for (const line of this.editor.render(width)) lines.push(line);
		lines.push("");
		add(theme.fg("dim", " Type note • Ctrl+J newline • Enter confirm • Esc skip"));
		add(theme.fg("accent", "─".repeat(width)));
		return lines;
	}

	invalidate(): void {
		super.invalidate();
		this.editor.invalidate();
	}
}

// ---------------------------------------------------------------------------
// Entry point used by the TUI's UiHandler
// ---------------------------------------------------------------------------

/** Show the quiz dialog for `request` as an overlay on `tui` (TUI bridge contract). */
export async function show(request: UiRequest, tui: TUI): Promise<UiResponse> {
	switch (request.kind) {
		case "quiz-answer":
			return showOverlayDialog(tui, (done) => new QuizAnswerDialog(tui, request, done));
		case "quiz-confidence":
			return showOverlayDialog(tui, (done) => new QuizConfidenceDialog(tui, request, done));
		case "quiz-note":
			return showOverlayDialog(tui, (done) => new QuizNoteDialog(tui, done));
		default:
			return { aborted: true };
	}
}

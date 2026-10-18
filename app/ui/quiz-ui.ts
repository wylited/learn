/**
 * Quiz dialogs over the shared.ts UI bridge. ONE buffer per quiz: question,
 * the choices (or just the editor in free mode), and the reasoning editor are
 * visible and usable simultaneously; the confidence strip appears in the same
 * dialog after the answer locks. Esc during answering dismisses the quiz.
 */
import {
	Editor,
	type EditorTheme,
	Key,
	matchesKey,
	truncateToWidth,
	wrapTextWithAnsi,
	styleTextWithAnsi,
	foregroundAnsi,
	indexedColor,
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

// ---------------------------------------------------------------------------
// Dialog plumbing
// ---------------------------------------------------------------------------

/**
 * Bottom-anchored FULL-WIDTH sheet, ABOVE the input dock: pi-tui overlays
 * composite onto the lines behind them ("without replacing it"), so any
 * narrower width leaves transcript/tool text visible in the flanking columns
 * and the quiz becomes unreadable. 100% width + an 8-row bottom margin means
 * the dialog owns its rows completely and never covers the dock (editor +
 * status + hints live in those 8 rows).
 */
export const DIALOG_OPTIONS: OverlayOptions = {
	width: "100%",
	minWidth: 52,
	anchor: "bottom-center",
	margin: { bottom: 8 },
};

/** Show `component` as an overlay; resolve when the dialog calls `done`. */
export function showOverlayDialog<T>(
	tui: TUI,
	make: (done: (value: T) => void) => Component,
	options: OverlayOptions = DIALOG_OPTIONS,
): Promise<T> {
	const { promise, resolve } = Promise.withResolvers<T>();
	let handle: OverlayHandle | undefined;
	let settled = false;
	const component = make((value) => {
		if (settled) return;
		settled = true;
		handle?.hide();
		resolve(value);
	});
	handle = tui.showOverlay(component, options);
	return promise;
}

/** Base for dialogs: width-keyed render cache (see legacy quiz.ts). */
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

const CONFIDENCE_ROWS: { key: "1" | "2" | "3"; label: string }[] = [
	{ key: "1", label: "1 · Sure" },
	{ key: "2", label: "2 · Pretty sure" },
	{ key: "3", label: "3 · Guessed" },
];

const DONT_KNOW_LABEL = "I don't know";

// ---------------------------------------------------------------------------
// quiz — the whole interaction in one buffer
// ---------------------------------------------------------------------------

type QuizRequest = Extract<UiRequest, { kind: "quiz" }>;

class QuizDialog extends Dialog {
	private cursor = 0;
	private readonly selected = new Set<number>();
	private dontKnowChosen = false;
	/** null = answering; otherwise the confidence strip is up and 1/2/3 closes. */
	private confidencePhase = false;
	private readonly editor: Editor;
	private readonly req: QuizRequest;
	private readonly done: (r: UiResponse) => void;

	constructor(tui: TUI, req: QuizRequest, done: (r: UiResponse) => void) {
		super(tui);
		this.req = req;
		this.done = done;
		// disableSubmit: the editor's own submit path would clear the buffer;
		// Enter is intercepted here instead (legacy port).
		this.editor = new Editor(tui, createEditorTheme());
		this.editor.focused = true;
		this.editor.disableSubmit = true;
	}

	/** nav index of the "I don't know" row (choice mode; after real options) */
	private get dontKnowNav(): number {
		return this.req.options?.length ?? 0;
	}
	/** nav index of the Submit row (multiple only) */
	private get submitNav(): number {
		return this.dontKnowNav + 1;
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

	private resolve(reasoning: string): void {
		if (this.req.free) {
			const freeAnswer = this.editor.getText().trim();
			this.done({
				quiz: freeAnswer === "" ? { dontKnow: true } : { freeAnswer },
				reasoning,
				confidence: null,
			});
			return;
		}
		if (this.dontKnowChosen) {
			this.done({ quiz: { dontKnow: true }, reasoning, confidence: null });
		} else if (this.selected.size > 0) {
			this.done({
				quiz: { selected: [...this.selected].sort((a, b) => a - b) },
				reasoning,
				confidence: null,
			});
		}
		// Nothing selected: stay in the dialog (the hint line says so).
	}

	/** The answer just locked: switch to the in-dialog confidence strip. */
	private lockAnswer(): void {
		this.confidencePhase = true;
		this.refresh();
	}

	handleInput(data: string): void {
		// -- confidence phase: the strip owns 1/2/3 and Esc -------------------
		if (this.confidencePhase) {
			for (const row of CONFIDENCE_ROWS) {
				if (matchesKey(data, row.key)) {
					this.done({
						quiz: this.req.free
							? { freeAnswer: this.editor.getText().trim() }
							: this.dontKnowChosen
								? { dontKnow: true }
								: { selected: [...this.selected].sort((a, b) => a - b) },
						reasoning: this.editor.getText().trim(),
						confidence: (Number(row.key) as Confidence) ?? null,
					});
					return;
				}
			}
			if (matchesKey(data, Key.escape)) {
				this.resolve(this.editor.getText().trim());
				return;
			}
			// Any other key (typing) still lands in the reasoning editor.
			this.editor.handleInput(data);
			this.refresh();
			return;
		}

		// -- answering phase ---------------------------------------------------
		if (matchesKey(data, Key.escape)) {
			this.done({ aborted: true });
			return;
		}

		if (!this.req.free) {
			const max = this.req.multiple === true ? this.submitNav : this.dontKnowNav;
			if (matchesKey(data, Key.up)) {
				this.cursor = Math.max(0, this.cursor - 1);
				this.refresh();
				return;
			}
			if (matchesKey(data, Key.down)) {
				this.cursor = Math.min(max, this.cursor + 1);
				this.refresh();
				return;
			}
			if (this.req.multiple === true && matchesKey(data, Key.space)) {
				if (this.cursor === this.submitNav) return;
				if (this.cursor === this.dontKnowNav) this.toggleDontKnow();
				else this.toggleOption(this.cursor);
				this.refresh();
				return;
			}
			if (matchesKey(data, Key.enter)) {
				if (this.req.multiple === true) {
					if (this.cursor === this.submitNav) {
						if (this.selected.size > 0 || this.dontKnowChosen) this.lockAnswer();
						else this.refresh();
					} else if (this.cursor === this.dontKnowNav) {
						this.toggleDontKnow();
						this.refresh();
					} else {
						this.toggleOption(this.cursor);
						this.refresh();
					}
					return;
				}
				// single-select: Enter anywhere locks the row under the cursor
				if (this.cursor === this.dontKnowNav) this.dontKnowChosen = true;
				else {
					this.dontKnowChosen = false;
					this.selected.clear();
					this.selected.add(this.cursor);
				}
				this.lockAnswer();
				return;
			}
		} else if (matchesKey(data, Key.enter)) {
			// free mode: Enter submits answer + reasoning together
			this.lockAnswer();
			return;
		}

		// Everything else types into the reasoning editor — visible the whole time.
		this.editor.handleInput(data);
		this.refresh();
	}

	render(width: number): string[] {
		// Cache keyed on width: pi-tui re-renders on resize without invalidate().
		if (this.cachedLines && this.cachedWidth === width) return this.cachedLines;

		const lines: string[] = [];
		const add = (text: string) => lines.push(truncateToWidth(text, width));
		add(theme.fg("accent", "─".repeat(width)));
		addWrapped(lines, styleTextWithAnsi(this.req.question, undefined, undefined, { bold: true }), width, " ");
		if (this.req.hint) {
			addWrapped(lines, theme.fg("muted", this.req.hint), width, " ");
		}
		lines.push("");

		if (this.confidencePhase) {
			addWrapped(lines, styleTextWithAnsi("How sure were you?", undefined, undefined, { bold: true }), width, " ");
			lines.push("");
			CONFIDENCE_ROWS.forEach((row) => {
				add(`  ${theme.fg("accent", row.label)}`);
			});
			lines.push("");
			add(theme.fg("dim", " 1/2/3 to answer • Esc to skip confidence • keep typing reasoning below"));
			lines.push("");
			for (const line of this.editor.render(width)) lines.push(line);
		} else {
			if (!this.req.free) {
				const options = this.req.options ?? [];
				for (let i = 0; i < options.length; i++) {
					const focused = i === this.cursor;
					const prefix = focused ? theme.fg("accent", "> ") : "  ";
					let label = `${i + 1}. ${options[i]}`;
					if (this.req.multiple === true) label = `${this.selected.has(i) ? "[x]" : "[ ]"} ${label}`;
					const styled = focused
						? theme.fg("accent", label)
						: theme.fg(this.req.multiple === true && this.selected.has(i) ? "success" : "text", label);
					add(`${prefix}${styled}`);
				}

				// "I don't know" row — visually separated and dimmed (legacy port).
				lines.push("");
				const dkFocused = this.cursor === this.dontKnowNav;
				const dkPrefix = dkFocused ? theme.fg("accent", "> ") : "  ";
				let dkLabel = DONT_KNOW_LABEL;
				if (this.req.multiple === true) dkLabel = `${this.dontKnowChosen ? "[x]" : "[ ]"} ${dkLabel}`;
				const dkStyled = dkFocused
					? theme.fg("accent", dkLabel)
					: theme.fg(this.req.multiple === true && this.dontKnowChosen ? "warning" : "dim", dkLabel);
				add(`${dkPrefix}${dkStyled}`);

				if (this.req.multiple === true) {
					const picked = this.dontKnowChosen ? 1 : this.selected.size;
					const label = picked > 0 ? `✓ Submit (${picked} selected)` : "○ Submit";
					const focused = this.cursor === this.submitNav;
					const styled = focused ? theme.fg("accent", label) : theme.fg(picked > 0 ? "success" : "dim", label);
					add(`${focused ? theme.fg("accent", "> ") : "  "}${styled}`);
				}
				lines.push("");
			}

			addWrapped(lines, theme.fg("muted", "Reasoning — your thinking, in your own words (optional)"), width, " ");
			for (const line of this.editor.render(width)) lines.push(line);

			lines.push("");
			if (this.req.free) {
				add(theme.fg("dim", " Type your answer • Ctrl+J newline • Enter submit • Esc cancel"));
			} else if (this.req.multiple === true) {
				add(theme.fg("dim", " ↑↓ navigate • Space toggle • Enter submit row → confidence • type to reason • Esc cancel"));
			} else {
				add(theme.fg("dim", " ↑↓ navigate • Enter answer → confidence • type to reason • Esc cancel"));
			}
		}
		add(theme.fg("accent", "─".repeat(width)));

		this.cachedLines = lines;
		this.cachedWidth = width;
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
		case "quiz":
			return showOverlayDialog(tui, (done) => new QuizDialog(tui, request, done));
		default:
			return { aborted: true };
	}
}

// -- small helpers -----------------------------------------------------------

export function addWrapped(lines: string[], text: string, width: number, indent = ""): void {
	const contentWidth = Math.max(1, width - indent.length);
	for (const line of wrapTextWithAnsi(text, contentWidth)) {
		lines.push(truncateToWidth(`${indent}${line}`, width));
	}
}

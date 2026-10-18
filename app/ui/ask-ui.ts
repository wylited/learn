/**
 * pi-tui overlay dialog for `ask_user`-style questions: option list (single or
 * multi) with an optional free-text fallback when `allowText` is set.
 *
 * Ported from the legacy `ask-user-question` pi-extension: same bordered
 * layout, numbered options with descriptions, "Submit" row for multi-select,
 * and an inline editor for custom answers.
 */
import { Editor, Key, matchesKey, truncateToWidth, type TUI } from "@earendil-works/pi-tui";
import type { UiRequest, UiResponse } from "../shared.ts";
import { addWrapped, createEditorTheme, Dialog, showOverlayDialog, theme } from "./quiz-ui.ts";

type AskRequest = Extract<UiRequest, { kind: "ask" }>;

const TYPE_INSTEAD_LABEL = "Type instead";

class AskDialog extends Dialog {
	private cursor = 0;
	private readonly selected = new Set<number>();
	private editMode: boolean;
	private readonly editor: Editor;
	private readonly req: AskRequest;
	private readonly done: (r: UiResponse) => void;

	constructor(tui: TUI, req: AskRequest, done: (r: UiResponse) => void) {
		super(tui);
		this.req = req;
		this.done = done;
		this.editMode = req.options.length === 0;
		this.editor = new Editor(tui, createEditorTheme());
		this.editor.focused = this.editMode;
		this.editor.disableSubmit = true;
	}

	/** nav index of the "Type instead" row (allowText only, after the options) */
	private get typeInsteadNav(): number {
		return this.req.options.length;
	}
	/** nav index of the Submit row (multi only, last) */
	private get submitNav(): number {
		return this.req.options.length + (this.req.allowText ? 1 : 0);
	}

	private toggleOption(index: number): void {
		if (this.selected.has(index)) this.selected.delete(index);
		else this.selected.add(index);
	}

	private setEditMode(on: boolean): void {
		this.editMode = on;
		this.editor.focused = on;
		this.refresh();
	}

	private submitFreeText(): void {
		const text = this.editor.getText().trim();
		// With no options there is nothing to fall back to — accept even empty
		// (legacy text mode: "User submitted an empty response").
		if (text.length > 0 || this.req.options.length === 0) this.done({ freeText: text });
	}

	handleInput(data: string): void {
		if (this.editMode) {
			if (matchesKey(data, Key.enter)) {
				this.submitFreeText();
				return;
			}
			if (matchesKey(data, Key.escape)) {
				if (this.req.options.length === 0) this.done({ aborted: true });
				else this.setEditMode(false);
				return;
			}
			this.editor.handleInput(data);
			this.tui.requestRender();
			return;
		}

		if (matchesKey(data, Key.up)) {
			this.cursor = Math.max(0, this.cursor - 1);
			this.refresh();
			return;
		}
		if (matchesKey(data, Key.down)) {
			this.cursor = Math.min(this.submitNav, this.cursor + 1);
			this.refresh();
			return;
		}

		const onTypeInstead = this.req.allowText === true && this.cursor === this.typeInsteadNav;
		const onSubmit = this.req.multi === true && this.cursor === this.submitNav;

		if (matchesKey(data, Key.space) && this.req.multi === true) {
			if (onSubmit) return;
			if (onTypeInstead) this.setEditMode(true);
			else this.toggleOption(this.cursor);
			this.refresh();
			return;
		}

		if (matchesKey(data, Key.enter)) {
			if (onSubmit) {
				if (this.selected.size > 0) {
					this.done({ indexes: [...this.selected].sort((a, b) => a - b) });
				}
				return;
			}
			if (onTypeInstead) {
				this.setEditMode(true);
				return;
			}
			if (this.req.multi === true) this.toggleOption(this.cursor);
			else this.done({ indexes: [this.cursor] });
			this.refresh();
			return;
		}

		if (matchesKey(data, Key.escape)) {
			// allowText: Esc never aborts — it switches to the free-text editor.
			if (this.req.allowText === true) this.setEditMode(true);
			else this.done({ aborted: true });
		}
	}

	render(width: number): string[] {
		if (this.cachedLines && this.cachedWidth === width && !this.editMode) return this.cachedLines;

		const lines: string[] = [];
		const add = (text: string) => lines.push(truncateToWidth(text, width));
		add(theme.fg("accent", "─".repeat(width)));
		if (this.req.header) {
			addWrapped(lines, theme.fg("accent", this.req.header), width, " ");
			lines.push("");
		}
		addWrapped(lines, theme.fg("text", this.req.question), width, " ");
		lines.push("");

		for (let i = 0; i < this.req.options.length; i++) {
			const option = this.req.options[i];
			const focused = i === this.cursor;
			const prefix = focused ? theme.fg("accent", "> ") : "  ";
			let label = `${i + 1}. ${option.label}`;
			if (this.req.multi === true) label = `${this.selected.has(i) ? "[x]" : "[ ]"} ${label}`;
			const styled = focused
				? theme.fg("accent", label)
				: theme.fg(this.req.multi === true && this.selected.has(i) ? "success" : "text", label);
			add(`${prefix}${styled}`);
			if (option.description) {
				addWrapped(lines, theme.fg("muted", option.description), width, "     ");
			}
		}

		if (this.req.allowText === true) {
			const focused = this.cursor === this.typeInsteadNav;
			const label = `${TYPE_INSTEAD_LABEL}${this.editor.getText().trim() ? ` — ${this.editor.getText().trim()}` : ""}`;
			const styled = focused ? theme.fg("accent", label) : theme.fg("dim", label);
			add(`${focused ? theme.fg("accent", "> ") : "  "}${styled}`);
		}

		if (this.req.multi === true) {
			const label =
				this.selected.size > 0 ? `✓ Submit (${this.selected.size} selected)` : "○ Submit";
			const focused = this.cursor === this.submitNav;
			const styled = focused
				? theme.fg("accent", label)
				: theme.fg(this.selected.size > 0 ? "success" : "dim", label);
			add(`${focused ? theme.fg("accent", "> ") : "  "}${styled}`);
		}

		if (this.editMode) {
			lines.push("");
			add(theme.fg("muted", " Write your custom answer:"));
			for (const line of this.editor.render(Math.max(1, width - 2))) add(` ${line}`);
			lines.push("");
			add(theme.fg("dim", " Enter to submit • Esc to go back"));
		} else {
			lines.push("");
			if (this.req.multi === true && this.selected.size === 0) {
				add(theme.fg("warning", " Select at least one answer before submitting."));
			}
			add(theme.fg("dim", " ↑↓ navigate • Enter select • Esc cancel"));
		}

		add(theme.fg("accent", "─".repeat(width)));

		if (!this.editMode) {
			this.cachedLines = lines;
			this.cachedWidth = width;
		} else {
			this.cachedLines = undefined;
		}
		return lines;
	}

	invalidate(): void {
		super.invalidate();
		this.editor.invalidate();
	}
}

/** Show the ask dialog for `request` as an overlay on `tui` (TUI bridge contract). */
export async function show(request: UiRequest, tui: TUI): Promise<UiResponse> {
	if (request.kind !== "ask") return { aborted: true };
	return showOverlayDialog(tui, (done) => new AskDialog(tui, request, done));
}

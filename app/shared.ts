/**
 * Cross-module contracts for the learn app. Every module imports from here;
 * nothing imports between siblings except through these types.
 */

// ---------------------------------------------------------------------------
// UI bridge: extensions run inside the harness (no TUI access). The TUI
// installs a handler at startup; extensions call `ui()`. Without a handler
// (tests, --print mode) every request resolves `{ aborted: true }`.
// ---------------------------------------------------------------------------

export type Confidence = 1 | 2 | 3; // 1 Sure · 2 Pretty sure · 3 Guessed

export type UiRequest =
	| {
			/** Single-buffer quiz: question + choices + reasoning editor in ONE dialog. */
			kind: "quiz";
			question: string;
			free: boolean; // no options — the editor answer is graded by the teacher
			options?: string[]; // choice mode
			multiple?: boolean; // choice mode
			hint?: string;
	  }
	| {
			kind: "ask";
			header?: string;
			question: string;
			options: { label: string; description?: string }[];
			multi?: boolean;
			allowText?: boolean; // Esc/empty → free-text entry instead of abort
	  };

export type QuizAnswer =
	| { selected: number[] } // choice modes: chosen option indexes
	| { dontKnow: true } // "I don't know" row / blank free answer
	| { freeAnswer: string }; // free mode: typed answer ("" = blank)

export type UiResponse =
	| {
			quiz: QuizAnswer;
			reasoning: string; // typed in the same buffer ("" when untouched)
			confidence: Confidence | null; // picked in the same buffer; null = skipped
	  }
	| { indexes: number[] } // ask: picked options
	| { freeText: string } // ask: typed answer
	| { aborted: true }; // dialog dismissed / no UI attached
export type UiHandler = (request: UiRequest) => Promise<UiResponse>;

let handler: UiHandler | null = null;

export function setUiHandler(next: UiHandler | null): void {
	handler = next;
}

// DI boundary: extensions never import the TUI; they await `ui()` and treat
// `{ aborted: true }` (no handler attached, or dialog dismissed) as bail-out.
export async function ui(request: UiRequest): Promise<UiResponse> {
	if (!handler) return { aborted: true };
	return handler(request);
}


// ---------------------------------------------------------------------------
// Quiz tool result — shared by the quiz extension (producer) and md-log
// (recorder). The teacher sees this exact object as the tool result.
// ---------------------------------------------------------------------------

export type QuizResult = {
	question: string;
	mode: "single" | "multiple" | "free";
	/** Typed BEFORE answering (choice modes); "" when skipped. The learner's own words. */
	reasoning: string;
	selected: number[]; // choice modes: locked-in option indexes
	freeAnswer?: string; // free mode: the typed answer ("" = blank submission)
	correctIndices: number[]; // choice modes; empty for free
	correct: boolean | null; // null in free mode — the teacher judges the text
	dontKnow: boolean;
	confidence: Confidence | null; // null = stage skipped
	explanation: string;
};

// ---------------------------------------------------------------------------
// Extension / tool names. The registry installs these export names.
// ---------------------------------------------------------------------------

export const EXT = {
	teach: "Teach",
	quizAsk: "QuizAsk",
	subagents: "Subagents",
	web: "WebTools",
	typst: "TypstTools",
	mermaid: "MermaidTools",
	mdlog: "MdLog",
} as const;

export const TOOL = {
	webSearch: "web_search",
	webFetch: "web_fetch",
	subagent: "subagent",
	quiz: "quiz",
	askUser: "ask_user",
	log: "md_log",
	writeTypst: "write_typst",
	editTypst: "edit_typst",
	renderTypst: "render_typst",
	writeMermaid: "write_mermaid",
	editMermaid: "edit_mermaid",
	renderMermaid: "render_mermaid",
} as const;

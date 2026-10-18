/**
 * tui — the learn app's terminal UI: a main-screen transcript (user lines,
 * assistant markdown, compact tool lines, inline images) followed by the task
 * panel, queued steers, notices, the input editor, and a status footer.
 *
 * Built on pi-tui's TuiMainScreen + ProcessTerminal (the terminal's own
 * scrollback carries the transcript), driven by runtime's
 * DurableView/DurableController. The quiz/ask dialogs (ui/quiz-ui.ts,
 * ui/ask-ui.ts) are attached here through shared.ts's setUiHandler.
 */

import { readFile } from "node:fs/promises";
import type { AssistantMessage, ToolResultMessage, Usage, UserMessage } from "@earendil-works/pi-ai";
import type {
	ConversationId,
	EntryRecord,
	InboxState,
	LiveState,
	TaskGraph,
	TaskGraphNode,
	UsageState,
} from "@earendil-works/pi-durable";
import {
	Container,
	type Component,
	Editor,
	type EditorTheme,
	Image,
	type ImageTheme,
	type MarkdownTheme,
	Markdown,
	matchesKey,
	ProcessTerminal,
	type SelectItem,
	SelectList,
	type SelectListTheme,
	Text,
	TruncatedText,
	TuiMainScreen,
	type TUI,
	VStack,
} from "@earendil-works/pi-tui";
import { setUiHandler, type UiRequest, type UiResponse } from "../shared.ts";
import { agentOf, type DurableController, type DurableView, type DurableViewSource } from "../runtime.ts";

const ANSI = {
	bold: (t: string) => `\x1b[1m${t}\x1b[22m`,
	dim: (t: string) => `\x1b[2m${t}\x1b[22m`,
	italic: (t: string) => `\x1b[3m${t}\x1b[23m`,
	underline: (t: string) => `\x1b[4m${t}\x1b[24m`,
	cyan: (t: string) => `\x1b[36m${t}\x1b[39m`,
	yellow: (t: string) => `\x1b[33m${t}\x1b[39m`,
	red: (t: string) => `\x1b[31m${t}\x1b[39m`,
	accent: (t: string) => `\x1b[35m${t}\x1b[39m`,
};

const markdownTheme: MarkdownTheme = {
	heading: ANSI.bold,
	link: ANSI.underline,
	linkUrl: ANSI.dim,
	code: ANSI.cyan,
	codeBlock: ANSI.cyan,
	codeBlockBorder: ANSI.dim,
	quote: (t) => t,
	quoteBorder: ANSI.dim,
	hr: ANSI.dim,
	listBullet: ANSI.bold,
	bold: ANSI.bold,
	italic: ANSI.italic,
	strikethrough: (t) => `\x1b[9m${t}\x1b[29m`,
	underline: ANSI.underline,
};

const imageTheme: ImageTheme = { fallbackColor: ANSI.dim };

const selectTheme: SelectListTheme = {
	selectedPrefix: ANSI.accent,
	selectedText: ANSI.bold,
	description: ANSI.dim,
	scrollInfo: ANSI.dim,
	noMatch: ANSI.dim,
};

const editorTheme: EditorTheme = { borderColor: ANSI.dim, selectList: selectTheme };

function clip(text: string, max: number): string {
	const single = text.replace(/\s+/g, " ").trim();
	return single.length > max ? `${single.slice(0, max)}…` : single;
}

/** One tool call in the transcript: a status line, plus its output when expanded (ctrl+o) or failed. */
class ToolLine implements Component {
	readonly #name: string;
	readonly #statusText = new Text();
	readonly #outputText = new Text();
	#expanded = false;
	#isError = false;

	constructor(name: string, args?: unknown) {
		this.#name = name;
		const record = (args ?? {}) as Record<string, unknown>;
		const parts: string[] = [];
		for (const [key, value] of Object.entries(record)) {
			if (parts.length >= 3) break;
			parts.push(`${key}=${clip(typeof value === "string" ? value : JSON.stringify(value) ?? "", 40)}`);
		}
		const preview = parts.length === 0 ? "" : ` ${parts.join(" ")}`;
		this.#statusText.setText(ANSI.cyan(`● ${name}${preview}`), 1);
	}

	setGlobalExpand(expanded: boolean): void {
		this.#expanded = expanded;
	}

	markRunning(output: string | undefined): void {
		this.#isError = false;
		this.#statusText.setText(ANSI.cyan(`● ${this.#name}`), 1);
		this.#outputText.setText(output === undefined || output === "" ? "" : ANSI.dim(clip(output, 160)), 2);
	}

	markDone(output: string, isError: boolean): void {
		this.#isError = isError;
		this.#statusText.setText(isError ? ANSI.red(`✗ ${this.#name}`) : ANSI.dim(`✓ ${this.#name}`), 1);
		this.#outputText.setText(output === "" ? "" : (isError ? ANSI.red : ANSI.dim)(clip(output, this.#expanded ? 3000 : 160)), 2);
	}

	invalidate(): void {
		this.#statusText.invalidate();
		this.#outputText.invalidate();
	}

	render(width: number): string[] {
		const lines = this.#statusText.render(width);
		if (this.#expanded || this.#isError) lines.push(...this.#outputText.render(width));
		return lines;
	}
}

function userText(content: UserMessage["content"]): string {
	if (typeof content === "string") return content;
	return content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join(" ");
}

function assistantText(message: AssistantMessage): string {
	return message.content
		.flatMap((block) => (block.type === "text" ? [block.text] : ([] as string[])))
		.join("")
		.trim();
}

function describeTask(node: TaskGraphNode): string {
	const state = node.state;
	const status =
		state.status === "waiting"
			? `waiting on ${state.on.join(", ")}`
			: state.status === "completing"
				? `completing (${state.outcome})`
				: `${state.status} ${state.phase}`;
	const flags = [node.background ? "background" : "", node.abortRequested ? "aborting" : ""].filter(Boolean);
	const owned = node.conversations.length > 0 ? ` → conversation ${node.conversations.join(", ")}` : "";
	return `${node.kind} #${node.id}: ${status}${flags.length > 0 ? ` [${flags.join(", ")}]` : ""}${owned}`;
}

function totalUsage(state: UsageState): Usage {
	const total: Usage = {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
	for (const usage of [...Object.values(state.models), ...Object.values(state.tools)]) {
		total.input += usage.input;
		total.output += usage.output;
		total.cacheRead += usage.cacheRead;
		total.cacheWrite += usage.cacheWrite;
		total.cost.total += usage.cost.total;
	}
	return total;
}

function formatTokens(tokens: number): string {
	if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
	if (tokens >= 1000) return `${Math.round(tokens / 1000)}k`;
	return String(tokens);
}

/** Context size from the newest successful answer after the newest compaction; unknown before one. */
function contextTokens(entries: readonly EntryRecord[]): number | undefined {
	const compacted = Math.max(0, ...entries.filter((entry) => entry.kind === "pi.compaction").map((entry) => entry.id));
	for (const entry of [...entries].reverse()) {
		const message = entry.model?.[0];
		if (entry.id < compacted || entry.kind !== "pi.assistant" || message?.role !== "assistant") continue;
		if (message.stopReason === "aborted" || message.stopReason === "error") continue;
		const usage = message.usage;
		return usage.totalTokens || usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
	}
	return undefined;
}

/** Connect the quiz/ask dialogs (Builder C modules) to extensions via shared.ts's ui(). */
export async function attachDialogs(tui: TUI): Promise<string | undefined> {
	try {
		const [quiz, ask] = await Promise.all([import("./quiz-ui.ts"), import("./ask-ui.ts")]);
		const route = async (request: UiRequest): Promise<UiResponse> =>
			request.kind === "ask" ? ask.show(request, tui) : quiz.show(request, tui);
		setUiHandler(route);
		return undefined;
	} catch (error) {
		setUiHandler(null);
		return `dialogs unavailable (${(error as Error).message}); quiz/ask tools will see "aborted"`;
	}
}

export async function runTui(source: DurableViewSource, controller: DurableController): Promise<void> {
	const tui = new TuiMainScreen(new ProcessTerminal());
	let exit = (): void => {};
	const exited = new Promise<void>((resolve) => {
		exit = resolve;
	});
	let lastCtrlC = 0;

	const chat = new Container();
	const tasks = new Container();
	const queue = new Container();
	const notices = new Container();
	const status = new Text();
	const hints = new Text();
	const editor = new Editor(tui, editorTheme, { paddingX: 1 });

	// -- transcript state -----------------------------------------------------
	const toolLines = new Map<string, ToolLine>();
	let renderedEntryIds: number[] = [];
	let streaming: Markdown | undefined;
	let expandedTools = false;

	const toolLine = (name: string, callId: string, args?: unknown): ToolLine => {
		const existing = toolLines.get(callId);
		if (existing !== undefined) return existing;
		const line = new ToolLine(name, args);
		toolLines.set(callId, line);
		chat.addChild(line);
		return line;
	};

	const renderImages = async (
		content: readonly { type: string; text?: string; data?: string; mimeType?: string }[],
		details: unknown,
	): Promise<void> => {
		for (const block of content) {
			if (block.type === "image" && block.data !== undefined) {
				chat.addChild(new Image(block.data, block.mimeType ?? "image/png", imageTheme, { maxWidthCells: 80 }));
			}
		}
		const viz = (details as { viz?: { pngPath?: string } } | undefined)?.viz?.pngPath;
		if (viz !== undefined) {
			try {
				const bytes = await readFile(viz);
				chat.addChild(new Image(bytes.toString("base64"), "image/png", imageTheme, { maxWidthCells: 80 }));
			} catch {
				// The published PNG vanished; the transcript keeps the tool line only.
			}
		}
		tui.requestRender();
	};

	const addEntry = (entry: EntryRecord): void => {
		const message = entry.model?.[0];
		if (entry.kind === "pi.user" && message?.role === "user") {
			const text = userText(message.content);
			// Background-subagent hand-off injected by the delivery loop, not
			// the learner: render as an accent-tagged block, and inline the
			// published PNG when the answer carries one.
			const injected = /^\[([\w-]+) (finished|failed) — background result\]\n?/.exec(text);
			if (injected !== null) {
				const body = text.slice(injected[0].length).replace(/\n\[end of background result\]\s*$/, "");
				chat.addChild(new Text(ANSI.accent(`● ${injected[1]} ${injected[2]} (background)`), 1, 0));
				if (body.trim() !== "") chat.addChild(new Markdown(body, 1, 1, markdownTheme));
				const png = /\bpath:\s*(\S+\.png)\b/.exec(body);
				if (png !== null) {
					void readFile(png[1])
						.then((bytes) => {
							chat.addChild(new Image(bytes.toString("base64"), "image/png", imageTheme, { maxWidthCells: 80 }));
							tui.requestRender();
						})
						.catch(() => undefined);
				}
			} else {
				chat.addChild(new Text(`${ANSI.bold("▸ ")}${text}`, 1, 0));
			}
		} else if (entry.kind === "pi.assistant" && message?.role === "assistant") {
			const text = assistantText(message);
			// Finalize the streaming block in place: a second Markdown would
			// duplicate the message after mid-round tool entries.
			if (streaming !== undefined) {
				streaming.setText(text);
			} else if (text) {
				chat.addChild(new Markdown(text, 1, 1, markdownTheme));
			}
			streaming = undefined;
			const ran = message.stopReason === "toolUse";
			for (const content of message.content) {
				if (content.type !== "toolCall") continue;
				const line = toolLine(content.name, content.id, content.arguments);
				if (!ran) line.markDone("Not run: the answer was interrupted.", true);
			}
		} else if (entry.kind === "pi.tool-result" && message?.role === "toolResult") {
			const result = message as ToolResultMessage;
			const output = result.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n");
			toolLine(result.toolName, result.toolCallId).markDone(output, result.isError);
			void renderImages(result.content, result.details);
		} else if (entry.kind === "pi.compaction") {
			chat.addChild(new Text(ANSI.dim("— earlier context summarized —"), 1, 0));
		} else if (entry.kind === "pi.reset") {
			chat.addChild(new Text(ANSI.dim("[new context]"), 1, 0));
		}
	};

	const rebuild = (entries: readonly EntryRecord[]): void => {
		chat.clear();
		toolLines.clear();
		renderedEntryIds = [];
		streaming = undefined;
		for (const entry of entries) {
			addEntry(entry);
			renderedEntryIds.push(entry.id);
		}
	};

	const syncTranscript = (entries: readonly EntryRecord[]): void => {
		// Compactions and resets replace the head of the active transcript.
		if (renderedEntryIds.some((id, index) => entries[index]?.id !== id)) rebuild(entries);
		for (const entry of entries.slice(renderedEntryIds.length)) {
			addEntry(entry);
			renderedEntryIds.push(entry.id);
		}
	};

	const syncStreaming = (message: AssistantMessage | undefined): void => {
		if (message === undefined) {
			// A partial without its entry was dropped, e.g. by a retry: re-render from entries.
			if (streaming !== undefined) rebuild(source.current().conversation.entries);
			return;
		}
		const text = assistantText(message);
		if (streaming === undefined) {
			streaming = new Markdown(text, 1, 1, markdownTheme);
			chat.addChild(streaming);
		} else streaming.setText(text);
		for (const content of message.content) {
			if (content.type !== "toolCall") continue;
			toolLine(content.name, content.id, content.arguments);
		}
	};

	const syncLiveTools = (live: LiveState): void => {
		for (const slot of live.tools ?? []) {
			if (slot.status === "pending") continue;
			toolLine(slot.name, slot.callId).markRunning(slot.output);
		}
	};

	// -- dock panels ----------------------------------------------------------
	const syncTasks = (graph: TaskGraph | undefined): void => {
		tasks.clear();
		if (graph === undefined) return;
		const nodes = Object.values(graph.tasks);
		if (nodes.length === 0) return;
		const owned = new Set(nodes.flatMap((node) => node.conversations));
		const lines: string[] = [ANSI.accent(`Tasks (${nodes.length} live, /tasks to hide)`)];
		const children = (node: TaskGraphNode) =>
			nodes.filter(
				(candidate) =>
					candidate.owner === node.id ||
					(candidate.owner === undefined && node.conversations.includes(candidate.conversationId)),
			);
		const visit = (node: TaskGraphNode, depth: number): void => {
			lines.push(`${"  ".repeat(depth + 1)}${describeTask(node)}`);
			for (const child of children(node)) visit(child, depth + 1);
		};
		for (const node of nodes) {
			if (node.owner === undefined && !owned.has(node.conversationId)) visit(node, 0);
		}
		for (const line of lines) tasks.addChild(new TruncatedText(ANSI.dim(line), 1, 0));
	};

	const syncQueue = (inbox: InboxState): void => {
		queue.clear();
		for (const item of inbox.items) {
			const text =
				item.mode === "write" ? `<${String(item.entry.kind)}>` : userText(item.content as UserMessage["content"]);
			queue.addChild(new TruncatedText(ANSI.dim(`[${item.mode}] ${clip(text, 120)}`), 1, 0));
		}
	};

	const syncNotices = (view: DurableView): void => {
		notices.clear();
		for (const item of view.notices.slice(-4)) {
			const color = item.level === "error" ? ANSI.red : item.level === "warning" ? ANSI.yellow : ANSI.dim;
			notices.addChild(new TruncatedText(color(item.message), 1, 0));
		}
	};

	const syncStatus = (live: LiveState, view: DurableView): void => {
		const generation = live.generation;
		const compaction = live.compactions?.[0];
		const runningTool = live.tools?.find((slot) => slot.status === "running");
		let text = "";
		if (generation?.retry !== undefined) text = `Retrying (attempt ${generation.attempt + 1}): ${generation.retry.error}`;
		else if (generation?.deferred !== undefined) text = "Waiting for deferred response...";
		else if (compaction !== undefined) {
			text = compaction.retry
				? `Retrying ${compaction.reason} compaction (attempt ${compaction.attempt + 1})...`
				: `Compacting (${compaction.reason})...`;
		} else if (runningTool !== undefined) text = `Running ${runningTool.name}... (esc to abort)`;
		else if (live.run !== undefined) text = "Working... (esc to abort)";
		status.setText(text ? ANSI.yellow(text) : "");
		const agent = agentOf(view.conversation);
		const usage = totalUsage((view.conversation.docs["pi.usage"] ?? { models: {}, tools: {} }) as UsageState);
		const model = agent.model === undefined ? "no model" : `${agent.model.provider}/${agent.model.modelId}`;
		const shown = view.conversations.find((candidate) => candidate.id === view.conversation.conversation.id);
		const label = shown?.label ?? `conversation ${view.conversation.conversation.id}`;
		const contextWindow =
			view.models.find(
				(candidate) => candidate.provider === agent.model?.provider && candidate.modelId === agent.model?.modelId,
			)?.contextWindow ?? 0;
		const stats: string[] = [model];
		if (usage.cost.total > 0) stats.push(`$${usage.cost.total.toFixed(3)}`);
		if (contextWindow > 0) {
			const tokens = contextTokens(view.conversation.entries);
			stats.push(
				tokens === undefined
					? `?/${formatTokens(contextWindow)}`
					: `${((tokens / contextWindow) * 100).toFixed(1)}%/${formatTokens(contextWindow)}`,
			);
		}
		hints.setText(
			`${ANSI.accent(label)}${ANSI.dim(` · ${stats.join(" · ")} · ${view.session.cwd}`)}\n${ANSI.dim(
				"enter submit · esc abort · ctrl+o expand tools · /model /agents /tasks /quit · ctrl+c twice or ctrl+d exit",
			)}`,
		);
	};

	const apply = (view: DurableView): void => {
		const live = (view.conversation.docs["pi.live"] ?? {}) as LiveState;
		syncTranscript(view.conversation.entries);
		syncStreaming(live.generation?.message as AssistantMessage | undefined);
		syncLiveTools(live);
		syncTasks(view.tasks);
		syncQueue((view.conversation.docs["pi.inbox"] ?? { items: [] }) as InboxState);
		syncNotices(view);
		syncStatus(live, view);
		tui.requestRender();
	};

	// -- overlays ---------------------------------------------------------------
	const selectFrom = (title: string, items: SelectItem[], onPick: (value: string) => void): void => {
		const list = new SelectList(items, 12, selectTheme);
		const box = new VStack([
			{ component: new Text(ANSI.bold(title), 1, 0) },
			{ component: list, grow: 0 },
		]);
		const handle = tui.showOverlay(box, { width: "72%", minWidth: 40, anchor: "center" });
		list.onSelect = (item) => {
			handle.hide();
			onPick(item.value);
		};
		list.onCancel = () => handle.hide();
	};

	const selectModel = (): void => {
		const snapshot = source.current();
		const current = agentOf(snapshot.conversation).model;
		const items: SelectItem[] = [...snapshot.models]
			.sort((left, right) => {
				const isCurrent = (model: { provider: string; modelId: string }) =>
					model.provider === current?.provider && model.modelId === current.modelId;
				return Number(isCurrent(right)) - Number(isCurrent(left));
			})
			.map((model) => ({
				value: `${model.provider}/${model.modelId}`,
				label: model.modelId,
				description: model.provider,
			}));
		selectFrom("Select model:", items, (value) => {
			const separator = value.indexOf("/");
			void controller.setModel({ provider: value.slice(0, separator), modelId: value.slice(separator + 1) });
		});
	};

	const selectConversation = (): void => {
		const snapshot = source.current();
		const items: SelectItem[] = [...snapshot.conversations].reverse().map((candidate) => ({
			value: String(candidate.id),
			label: candidate.label,
			description: `${candidate.id === snapshot.conversation.conversation.id ? "(shown) " : ""}${candidate.title ?? ""}`,
		}));
		selectFrom("Switch to:", items, (value) => void controller.switchConversation(Number(value) as ConversationId));
	};

	// -- input ------------------------------------------------------------------
	editor.onSubmit = (raw: string) => {
		const text = raw.trim();
		if (!text) return;
		if (text === "/quit" || text === "/exit") {
			exit();
			return;
		}
		if (text === "/model") return selectModel();
		if (text.startsWith("/model ")) {
			const spec = text.slice("/model ".length).trim();
			const known = source.current().models.find((model) => `${model.provider}/${model.modelId}` === spec);
			if (known === undefined) {
				chat.addChild(new Text(ANSI.red(`Unknown model: ${spec} (pick from /model)`), 1, 0));
				tui.requestRender();
				return;
			}
			void controller.setModel({ provider: known.provider, modelId: known.modelId });
			return;
		}
		if (text === "/tasks") return void controller.toggleTasks();
		if (text === "/agents") return selectConversation();
		void controller.submit(text, "steer");
	};

	// Escape aborts, ctrl+o expands tool output, ctrl+c twice / ctrl+d exits —
	// only while the editor holds focus; overlays (dialogs, selectors) keep their keys.
	tui.addInputListener((data) => {
		if (tui.hasOverlay() || tui.getFocusedComponent() !== editor) return undefined;
		if (matchesKey(data, "escape")) {
			void controller.abort();
			return { consume: true };
		}
		if (matchesKey(data, "ctrl+o")) {
			expandedTools = !expandedTools;
			for (const line of toolLines.values()) line.setGlobalExpand(expandedTools);
			tui.requestRender();
			return { consume: true };
		}
		if (matchesKey(data, "ctrl+d")) {
			exit();
			return { consume: true };
		}
		if (matchesKey(data, "ctrl+c")) {
			const now = Date.now();
			if (now - lastCtrlC < 2000) exit();
			else {
				lastCtrlC = now;
				status.setText(ANSI.yellow("Press ctrl+c again to exit (work resumes with --continue)"));
				tui.requestRender();
			}
			return { consume: true };
		}
		return undefined;
	});

	for (const component of [chat, tasks, queue, notices, editor, status, hints] as Component[]) tui.addChild(component);
	tui.setFocus(editor);

	const unsubscribe = source.subscribe(() => apply(source.current()));
	const dialogWarning = await attachDialogs(tui);
	tui.start();
	if (dialogWarning !== undefined) chat.addChild(new Text(ANSI.yellow(dialogWarning), 1, 0));
	apply(source.current());
	try {
		await exited;
	} finally {
		unsubscribe();
		setUiHandler(null);
		tui.stop();
	}
}

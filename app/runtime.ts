/**
 * runtime — wires storage + models + extensions into a durable Harness and
 * exposes a plain-value view (transcript, conversations, tasks, notices) plus
 * a controller (submit/steer/follow-up, abort, compact, model, task panel).
 * Ported from pi's experimental/vacation/runtime.ts; sessions come from
 * ./sessions.ts and models from ./models.ts.
 *
 * Extension wiring is the single integration point below: loadLearnExtensions
 * imports the Builder A/B/C modules by the names in shared.EXT. Tests pass
 * their own (or zero) extensions to openRuntime instead.
 */

import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { AttachedReplicatedState } from "@earendil-works/chord";
import {
	clampThinkingLevel,
	getSupportedThinkingLevels,
	type ModelThinkingLevel,
	type Models,
} from "@earendil-works/pi-ai";
import {
	type AgentState,
	type Conversation,
	type ConversationId,
	type ConversationView,
	createRegistry,
	type Cursor,
	type EntryRecord,
	type Extension,
	Harness,
	type ModelRef,
	ROOT_CONVERSATION_ID,
	type Submission,
	type TaskGraph,
} from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { startDeliveryLoop } from "./extensions/subagents.ts";
import { EXT } from "./shared.ts";
import type { SessionLocation } from "./sessions.ts";
const context = BACKGROUND_CONTEXT;

export interface ModelSummary extends ModelRef {
	readonly name: string;
	readonly contextWindow: number;
}

export interface Notice {
	readonly id: number;
	readonly level: "info" | "warning" | "error";
	readonly message: string;
}

/** A conversation the user can switch to: the main one, or a subagent's. */
export interface ConversationSummary {
	readonly id: ConversationId;
	readonly label: string;
	/** The first user message, for a subagent its task. */
	readonly title?: string;
}

/** Everything the TUI renders. Plain values; no Harness objects cross this boundary. */
export interface DurableView {
	readonly session: { readonly id: string; readonly directory: string; readonly cwd: string };
	/** The conversation shown and talked to. */
	readonly conversation: ConversationView;
	readonly conversations: readonly ConversationSummary[];
	readonly models: readonly ModelSummary[];
	readonly notices: readonly Notice[];
	/** The live task graph while the task panel is open. */
	readonly tasks?: TaskGraph;
}

export interface DurableViewSource {
	current(): DurableView;
	subscribe(listener: () => void): () => void;
}

/** What the TUI may ask for. */
export interface DurableController {
	/** Prompt when idle; otherwise steer or queue a follow-up. */
	submit(text: string, whenBusy: "steer" | "followUp"): Promise<void>;
	compact(instructions: string | undefined): Promise<void>;
	abort(): Promise<void>;
	cycleThinking(): Promise<void>;
	setModel(model: ModelRef): Promise<void>;
	toggleTasks(): Promise<void>;
	/** Show and talk to another conversation. */
	switchConversation(id: ConversationId): Promise<void>;
}

export interface OpenRuntimeOptions {
	readonly location: SessionLocation;
	readonly models: Models;
	/** Selected by the root conversation, in order. */
	readonly rootExtensions: readonly Extension[];
	/** Installed for subagents to select (their tool extensions); not selected by the root. */
	readonly registryExtensions?: readonly Extension[];
	readonly initialModel?: ModelRef;
	readonly initialThinkingLevel?: ModelThinkingLevel;
}

export interface OpenRuntimeResult {
	readonly view: DurableViewSource;
	readonly controller: DurableController;
	/** Resolves when the root conversation and its subagent subtree have no live work. */
	waitForIdle(): Promise<void>;
	close(): Promise<void>;
}

export interface LearnExtensions {
	/** Selected by the root (teacher) conversation, in order. */
	root: Extension[];
	/** Installed for subagent children to select; not selected by the root. */
	registry: Extension[];
}

/**
 * The learn app's extensions. Root conversation: Teach, QuizAsk, Subagents,
 * MdLog. Installed for children: WebTools (researcher), TypstTools and
 * MermaidTools (makers). THE integration surface for the extension modules —
 * file paths and export names are pinned by shared.EXT.
 */
export async function loadLearnExtensions(): Promise<LearnExtensions> {
	const [teach, quizAsk, subagents, mdLog, web, typst, mermaid] = await Promise.all([
		import("./extensions/teach.ts"),
		import("./extensions/quiz-ask.ts"),
		import("./extensions/subagents.ts"),
		import("./extensions/md-log.ts"),
		import("./extensions/web.ts"),
		import("./extensions/typst-tools.ts"),
		import("./extensions/mermaid-tools.ts"),
	]);
	return {
		root: [teach[EXT.teach], quizAsk[EXT.quizAsk], subagents[EXT.subagents], mdLog[EXT.mdlog]],
		registry: [web[EXT.web], typst[EXT.typst], mermaid[EXT.mermaid]],
	};
}

/** The agent document of a view; absent while the conversation has none. */
export function agentOf(view: ConversationView): AgentState {
	return (view.docs["pi.agent"] ?? {}) as AgentState;
}

/** The text of a user entry, as a one-line title. */
function titleOf(entry: EntryRecord | undefined): { title?: string } {
	const message = entry?.model?.[0];
	if (message?.role !== "user") return {};
	const text =
		typeof message.content === "string"
			? message.content
			: message.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join(" ");
	return { title: text.replace(/\s+/g, " ").trim() };
}

/** A subagent's task: the oldest user message of its conversation. The main conversation needs no title. */
async function firstInput(harness: Harness, id: ConversationId): Promise<{ title?: string }> {
	if (id === ROOT_CONVERSATION_ID) return {};
	const conversation = await harness.conversation(id, context);
	if (conversation === undefined) return {};
	let first: EntryRecord | undefined;
	let cursor: Cursor | undefined;
	do {
		const page = await conversation.entries({}, 256, cursor, context);
		first = page.items.findLast((entry) => entry.kind === "pi.user") ?? first;
		cursor = page.next;
	} while (cursor !== undefined);
	return titleOf(first);
}

export async function openRuntime(options: OpenRuntimeOptions): Promise<OpenRuntimeResult> {
	const { location, models } = options;
	const registry = createRegistry();
	for (const extension of options.rootExtensions) registry.install(extension);
	for (const extension of options.registryExtensions ?? []) registry.install(extension);

	let harness: Harness | undefined;
	try {
		const pendingReports: unknown[] = [];
		let report: (error: unknown) => void = (error) => pendingReports.push(error);
		harness = await Harness.open(
			await openNodeSqliteStorage(location.database),
			{
				models,
				registry,
				settings: {
					toolExecution: "parallel",
					stream: { timeoutMs: 120_000 },
					retry: { maxRetries: 3 },
					compaction: { reserveTokens: 16384, keepRecentTokens: 20000, backgroundTokens: 32768 },
				},
				env: ({ cwd }) => new NodeExecutionEnv({ cwd: cwd ?? location.cwd }),
				onReport: (error) => report(error),
			},
			context,
		);
		const root = await harness.root(context, {
			agent: {
				extensions: [...options.rootExtensions],
				...(options.initialModel === undefined ? {} : { model: options.initialModel }),
				...(options.initialThinkingLevel === undefined ? {} : { thinkingLevel: options.initialThinkingLevel }),
			},
		});
		const label = (id: ConversationId): string => (id === root.id ? "main" : `subagent ${id}`);
		const opened = harness;
		const summaries: ConversationSummary[] = [];

		// Background subagent delivery: settled children inject their answers
		// into the parent as follow-up messages (idempotently, crash-safe).
		startDeliveryLoop(harness, context);
		let cursor: Cursor | undefined;
		do {
			const page = await opened.commit((tx) => tx.scanConversations({}, 256, cursor), context);
			for (const { id } of page.items) summaries.push({ id, label: label(id), ...(await firstInput(opened, id)) });
			cursor = page.next;
		} while (cursor !== undefined);
		let current: Conversation = root;
		let conversation: AttachedReplicatedState<ConversationView> = await root.viewState(context);
		const modelSummaries = (): ModelSummary[] =>
			models
				.getModels()
				.map((model) => ({
					provider: model.provider,
					modelId: model.id,
					name: model.name,
					contextWindow: model.contextWindow,
				}));

		let state: DurableView = {
			session: { id: location.id, directory: location.directory, cwd: location.cwd },
			conversation: conversation.value,
			conversations: summaries,
			models: modelSummaries(),
			notices: [],
		};
		const listeners = new Set<() => void>();
		let notifying = false;
		// Commit listeners and Chord frames call this on the Session line; rendering runs afterwards, once per burst.
		const update = (patch: Partial<DurableView>): void => {
			state = { ...state, ...patch };
			if (notifying) return;
			notifying = true;
			setImmediate(() => {
				notifying = false;
				for (const listener of listeners) listener();
			});
		};
		let nextNotice = 1;
		const notice = (level: Notice["level"], message: string): void => {
			update({ notices: [...state.notices, { id: nextNotice++, level, message }].slice(-20) });
		};
		const fail = (error: unknown): void => notice("error", error instanceof Error ? error.message : String(error));
		report = (error) => notice("warning", error instanceof Error ? error.message : String(error));
		for (const error of pendingReports) report(error);
		let unsubscribe = conversation.subscribe((value) => update({ conversation: value }));
		// Subagents appear as their conversations are created. A commit listener only records; it calls no Session API.
		const unsubscribeCommits = opened.subscribeCommits((publication) => {
			let conversations = state.conversations;
			for (const change of publication.changes) {
				if (change.type === "conversation") {
					conversations = [...conversations, { id: change.value.id, label: label(change.value.id) }];
				} else if (change.type === "entry" && change.value.kind === "pi.user") {
					const id = change.value.conversationId;
					conversations = conversations.map((summary) =>
						summary.id === id && summary.title === undefined ? { ...summary, ...titleOf(change.value) } : summary,
					);
				}
			}
			if (conversations !== state.conversations) update({ conversations });
		});

		let tasks: AttachedReplicatedState<TaskGraph> | undefined;
		let unsubscribeTasks = (): void => {};
		const closeTasks = (): void => {
			unsubscribeTasks();
			tasks?.dispose();
			tasks = undefined;
		};

		let queue = Promise.resolve();
		// One at a time, so toggles, switches, and key presses apply in order.
		const command = (operation: () => Promise<void>): Promise<void> => {
			queue = queue.then(operation).catch(fail);
			return queue;
		};
		const watchAnswer = (submission: Submission): void => {
			void submission.wait(context).then((settled) => {
				if (settled.status === "unanswered" && settled.reason !== "aborted") {
					notice(
						"error",
						`No answer: ${settled.reason}${settled.detail === undefined ? "" : ` ${JSON.stringify(settled.detail)}`}`,
					);
				}
			}, fail);
		};
		const agentModel = () => {
			const ref = agentOf(state.conversation).model;
			const model = ref === undefined ? undefined : models.getModel(ref.provider, ref.modelId);
			if (model === undefined)
				throw new Error(ref === undefined ? "No model selected" : "Current model is unavailable");
			return model;
		};
		const controller: DurableController = {
			submit: (text, whenBusy) =>
				command(async () => watchAnswer(await current.submit({ type: "input", content: text, whenBusy }, context))),
			compact: (instructions) =>
				command(async () => {
					const id = await current.compact(instructions, context);
					void opened.waitForTask(id, context).then(async (receipt) => {
						const outcome = receipt.state.outcome;
						if (outcome.status === "completed") {
							const { entryId, submissionId } = outcome.result;
							const status =
								submissionId === undefined
									? undefined
									: (await (await opened.submission(submissionId, context))?.status(context))?.status;
							notice(
								"info",
								entryId !== undefined || status === "done"
									? "Compacted."
									: status === "queued"
										? "Compaction summary queued; it is placed at the next turn boundary."
										: status === "unanswered"
											? "Compaction summary dropped: the context changed under it."
											: "Nothing to compact: the context fits in the recent window that is kept verbatim.",
							);
						} else if (outcome.status === "aborted") notice("info", "Compaction aborted.");
						else notice("error", `Compaction ${outcome.status}: ${outcome.error?.message ?? outcome.reason ?? ""}`);
					}, fail);
				}),
			// Not queued: it waits until the conversation is idle.
			abort: () => current.abort(context).catch(fail),
			cycleThinking: () =>
				command(async () => {
					const model = agentModel();
					if (!model.reasoning) throw new Error("Current model does not support thinking");
					const levels = getSupportedThinkingLevels(model);
					const level = agentOf(state.conversation).thinkingLevel ?? "off";
					const next = levels[(levels.indexOf(level) + 1) % levels.length] ?? "off";
					await current.configure({ thinkingLevel: next }, context);
				}),
			setModel: (ref) =>
				command(async () => {
					const model = models.getModel(ref.provider, ref.modelId);
					if (model === undefined) throw new Error(`Unknown model: ${ref.provider}/${ref.modelId}`);
					const thinking: ModelThinkingLevel = agentOf(state.conversation).thinkingLevel ?? "off";
					await current.configure({ model: ref, thinkingLevel: clampThinkingLevel(model, thinking) }, context);
				}),
			toggleTasks: () =>
				command(async () => {
					if (tasks !== undefined) {
						closeTasks();
						update({ tasks: undefined });
						return;
					}
					const graph = await opened.taskGraph(context);
					tasks = graph;
					unsubscribeTasks = graph.subscribe((value) => update({ tasks: value }));
				}),
			switchConversation: (id) =>
				command(async () => {
					const next = await opened.conversation(id, context);
					if (next === undefined) throw new Error(`Conversation ${id} does not exist`);
					const nextState = await next.viewState(context);
					unsubscribe();
					conversation.dispose();
					current = next;
					conversation = nextState;
					unsubscribe = nextState.subscribe((value) => update({ conversation: value }));
				}),
		};

		const saved = agentOf(state.conversation).model;
		if (saved === undefined && options.initialModel === undefined) {
			notice("warning", "No model configured; select one with /model.");
		} else if (
			saved !== undefined &&
			models.getModel(saved.provider, saved.modelId) === undefined &&
			(saved.provider !== options.initialModel?.provider || saved.modelId !== options.initialModel?.modelId)
		) {
			notice("warning", `Saved model is unavailable: ${saved.provider}/${saved.modelId}`);
		}
		// The task panel starts open; /tasks hides it.
		await controller.toggleTasks();
		// Recovered work from an interrupted turn continues now.
		opened.resume();

		let closing: Promise<void> | undefined;
		return {
			view: {
				current: () => state,
				subscribe: (listener) => {
					listeners.add(listener);
					return () => listeners.delete(listener);
				},
			},
			controller,
			waitForIdle: () => root.waitForIdle(context),
			close() {
				closing ??= (async () => {
					unsubscribe();
					unsubscribeCommits();
					conversation.dispose();
					closeTasks();
					try {
						// Close writes no outcome: a running turn resumes with --continue.
						await opened.close(context);
					} finally {
						await location.release();
					}
				})();
				return closing;
			},
		};
	} catch (error) {
		await harness?.close(context).catch(() => {});
		await location.release().catch(() => {});
		throw error;
	}
}

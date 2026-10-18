/**
 * Subagents: one `subagent` tool delegating a self-contained task to a
 * specialist child conversation (researcher / typst-maker / mermaid-maker).
 *
 * Durability follows pi's foreground-subagent pattern: the child conversation
 * is owned by this tool call's task, so a crash-recovery rerun (replay: safe)
 * finds the existing child instead of creating another, and the stable
 * requestId brings back the submission it already made. Aborting the parent
 * aborts the child; the call settles only when the child is done. Children get
 * exactly one tool extension, their agent's instructions, and their pinned
 * model — never the subagent/quiz tools.
 */
import type { Context } from "@earendil-works/chord";
import { Type } from "@earendil-works/pi-ai";
import type { AssistantMessage, ModelThinkingLevel } from "@earendil-works/pi-ai";
import {
	AssistantEntry,
	type AgentChange,
	type Cursor,
	type EntryId,
	type EntryRecord,
	type Extension,
	type Harness,
	type ModelRef,
	configure,
	defineExtension,
	defineTool,
	type ToolExecutionApi,
} from "@earendil-works/pi-durable";
import { loadAgentSpec } from "../content.ts";
import { EXT, TOOL } from "../shared.ts";
import { WebTools } from "./web.ts";
import { TypstTools } from "./typst-tools.ts";
import { MermaidTools } from "./mermaid-tools.ts";

const AGENT_NAMES = ["researcher", "typst-maker", "mermaid-maker"] as const;
type AgentName = (typeof AGENT_NAMES)[number];

/** Static registry: which single extension each child conversation runs. */
const AGENT_EXTENSIONS: Record<AgentName, Extension> = {
	researcher: WebTools,
	"typst-maker": TypstTools,
	"mermaid-maker": MermaidTools,
};

/** Thinking levels pi-ai accepts; anything else from an agent file falls back to medium. */
const THINKING_LEVELS: Record<string, true> = {
	off: true,
	minimal: true,
	low: true,
	medium: true,
	high: true,
	xhigh: true,
	max: true,
};

type Viz = { filename?: string; path?: string };

type ChildDetails = {
	conversationId: string;
	agent: AgentName;
	viz?: Viz;
};

const subagent = defineTool({
	name: TOOL.subagent,
	description:
		"Delegate a self-contained task to a specialist subagent: researcher (web research, cited brief), typst-maker (precise Typst diagrams → PNG+SVG), mermaid-maker (simple structural diagrams → PNG). The subagent shares NO conversation context — the prompt must carry everything it needs. Batch independent calls in one round: they run in parallel. Use await=\"background\" to dispatch and keep going: the answer arrives later as a bracketed follow-up message, so the learner never waits.",
	parameters: Type.Object({
		name: Type.Union(AGENT_NAMES.map((name) => Type.Literal(name)), {
			description: "Which specialist to run",
		}),
		prompt: Type.String({ description: "Fully self-contained task or brief for the specialist" }),
		await: Type.Union([Type.Literal("result"), Type.Literal("background")], {
			description:
				'"result" (default) blocks this round until the answer is back. "background" returns at once and the answer is delivered as a follow-up message when the specialist finishes.',
			default: "result",
		}),
	}),
	// The visualize skill spells this call `subagent(agent=…, task=…)`; accept both
	// spellings. The result is still validated against `parameters`.
	prepareArguments: (args: unknown) => {
		const record = (typeof args === "object" && args !== null ? args : {}) as Record<string, unknown>;
		const name = typeof record.name === "string" ? record.name : record.agent;
		const prompt = typeof record.prompt === "string" ? record.prompt : record.task;
		const mode = record.await === "background" ? "background" : "result";
		return { name, prompt, await: mode } as { name: AgentName; prompt: string; await: "result" | "background" };
	},
	replay: "safe",
	async execute(args, api, callContext) {
		const spec = loadAgentSpec(args.name);
		const childExtension = AGENT_EXTENSIONS[args.name];
		// Credential-gated model pin: a provider installed without a usable
		// credential would fail every child generation instantly ("Provider is
		// not configured"), so fall back to the parent model and say so.
		const pin = spec?.model ?? null;
		let modelPin: ModelRef | undefined;
		if (pin !== null) {
			if (api.models.getModel(pin.provider, pin.modelId) === undefined) {
				api.output(`${args.name}: unknown model pin ${pin.provider}/${pin.modelId}; using the parent model\n`);
			} else if ((await api.models.checkAuth(pin.provider)) === undefined) {
				api.output(`${args.name}: no ${pin.provider} credentials; using the parent model\n`);
			} else {
				modelPin = pin;
			}
		}

 		const childId = await api.commit(async (tx) => {
			// Ownership records the child: a rerun of this call finds it instead of
			// creating another.
			const existing = (await tx.scanConversations({ ownerTaskId: api.taskId }, 1)).items[0];
			if (existing !== undefined) return existing.id;
			// Starts as a copy of this conversation's agent; configured down to
			// exactly one extension, its instructions, and its model pin.
			const created = await tx.createConversation({ ownership: { kind: "task", taskId: api.taskId } });
			const pinnedThinking = spec?.thinking ?? null;
			const thinkingLevel: ModelThinkingLevel =
				pinnedThinking !== null && THINKING_LEVELS[pinnedThinking] === true ? pinnedThinking : "medium";
			const change: AgentChange = {
				extensions: [childExtension],
				instructions: spec?.system ?? "",
				thinkingLevel,
				// Undefined (unpinned or unauthenticated) inherits the parent model.
				model: modelPin,
			};
			await configure(tx, created.id, change);
			return created.id;
		}, callContext);

		// A UI watching the parent can attach to the child through these details.
		await api.details({ conversationId: childId, agent: args.name }, callContext);

		const handle = await api.conversation(childId, callContext);
		if (handle === undefined) throw new Error(`subagent: child conversation ${childId} is unavailable`);

		if (args.await === "background") {
			// Admit the child's work, then return at once. The delivery loop
			// (startDeliveryLoop) watches for the settled submission and injects
			// the answer into this conversation as a follow-up message,
			// exactly-once by request ID — across crashes, too: the loop's
			// reads all come from the durable record.
			await handle.submit(
				{ type: "input", content: args.prompt, requestId: `subagent:${api.taskId}` },
				callContext,
			);
			return {
				output: [
					{
						type: "text",
						text: `Delegated to ${args.name} in the background (conversation ${childId}). Keep going — the answer arrives later as a "[${args.name} finished]" follow-up message. Do not wait for it.`,
					},
				],
				details: { conversationId: childId, agent: args.name } satisfies ChildDetails,
			};
		}

		// Blocking path: settle this round with the child's answer. The
		// requestId makes a rerun get back the submission it made before the
		// crash instead of asking the child again.
		const settled = await (
			await handle.submit(
				{ type: "input", content: args.prompt, requestId: `subagent:${api.taskId}` },
				callContext,
			)
		).wait(callContext);
		if (settled.status !== "done" || settled.type !== "input") {
			const reason = settled.status === "unanswered" ? `: ${settled.reason}` : "";
			throw new Error(`subagent ${args.name} failed (${settled.status}${reason})`);
		}
		const answer = await answerText(api, settled.answer, callContext);
		const viz = parseViz(answer);
		const details: ChildDetails = { conversationId: childId, agent: args.name };
		if (viz !== undefined) details.viz = viz;
		// Publish the final details (with viz) so the live slot and the UI see them.
		await api.details(details, callContext);
		return { output: [{ type: "text", text: answer }], details };
	},
});

// ---------------------------------------------------------------------------
// Background delivery: children dispatched with await="background" settle on
// their own schedule, durably. A process-lifetime loop polls the session for
// settled child submissions whose parent has not been handed the answer yet,
// and submits it there under a request ID that makes the hand-off
// exactly-once — including after a crash-and-resume.
// ---------------------------------------------------------------------------

const DELIVERY_POLL_MS = 1000;

type ReadyDelivery = { parentId: number; childId: number; label: string; content: string };

function resultRequestId(childId: number): string {
	return `subagent-result:${childId}`;
}

/** Tool-call agent name of a `pi.tool` task's assistant entry, for the label. */
function toolCallName(entry: EntryRecord | undefined, callId: string | undefined): string | undefined {
	const message = entry?.model?.[0] as { content?: unknown } | undefined;
	if (!Array.isArray(message?.content) || callId === undefined) return undefined;
	for (const block of message.content as unknown[]) {
		const record = block as { type?: string; id?: string; arguments?: Record<string, unknown> };
		if (record?.type === "toolCall" && record.id === callId) {
			const args = record.arguments ?? {};
			return typeof args.name === "string" ? args.name : typeof args.agent === "string" ? args.agent : undefined;
		}
	}
	return undefined;
}

/** One scan: child conversations with a settled answer their parent never received. */
async function findPendingDeliveries(harness: Harness, context: Context): Promise<ReadyDelivery[]> {
	return harness.commit(async (tx) => {
		const ready: ReadyDelivery[] = [];
		const children: { id: number; parentId: number; taskId: number }[] = [];
		let cursor: Cursor | undefined;
		do {
			const page = await tx.scanConversations({}, 256, cursor);
			for (const record of page.items) {
				if (record.owner === undefined) continue;
				children.push({ id: record.id, parentId: record.owner.conversationId, taskId: record.owner.taskId });
			}
			cursor = page.next;
		} while (cursor !== undefined);
		for (const child of children) {
			const input = await tx.submissionByRequest(child.id, `subagent:${child.taskId}`);
			if (input?.type !== "input") continue;
			if (input.status !== "done" && input.status !== "unanswered") continue;
			if ((await tx.submissionByRequest(child.parentId, resultRequestId(child.id))) !== undefined) continue;
			const task = await tx.task(child.taskId);
			const toolInput = task?.input as { assistant?: number; callId?: string } | undefined;
			const callEntry = toolInput?.assistant === undefined ? undefined : await tx.entry(toolInput.assistant);
			const label = toolCallName(callEntry, toolInput?.callId) ?? "subagent";
			if (input.status === "unanswered") {
				ready.push({
					parentId: child.parentId,
					childId: child.id,
					label,
					content: `[${label} failed — background result]\nThe background task could not finish (${input.reason}). Re-dispatch it if its work still matters.\n[end of background result]`,
				});
				continue;
			}
			const entry = await tx.entry(input.answer);
			const message = entry?.model?.[0] as AssistantMessage | undefined;
			const text = (message?.content ?? []).flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");
			ready.push({
				parentId: child.parentId,
				childId: child.id,
				label,
				content: `[${label} finished — background result]\n${text}\n[end of background result]`,
			});
		}
		return ready;
	}, context);
}

let deliveryLoopStarted = false;

/** Start the session-lifetime background delivery loop. Idempotent per process. */
export function startDeliveryLoop(harness: Harness, context: Context): void {
	if (deliveryLoopStarted) return;
	deliveryLoopStarted = true;
	void (async () => {
		for (;;) {
			const { promise: tick, resolve: next } = Promise.withResolvers<void>();
			setTimeout(next, DELIVERY_POLL_MS);
			await tick;
			try {
				for (const ready of await findPendingDeliveries(harness, context)) {
					const parent = await harness.conversation(ready.parentId, context);
					if (parent === undefined) continue;
					await parent.submit(
						{ type: "input", content: ready.content, requestId: resultRequestId(ready.childId) },
						context,
					);
				}
			} catch {
				// Transient (line busy, closing); retried next tick.
			}
		}
	})();
}

/** Final assistant text of the child's answer entry. */
async function answerText(
	api: ToolExecutionApi,
	answer: EntryId,
	callContext: Context,
): Promise<string> {
	const entry = await api.commit((tx) => tx.entry(AssistantEntry, answer), callContext);
	// EntryRecord.model is a mixed message list; a settled input's answer is an
	// assistant message (pi's own subagent example reads it exactly this way).
	const message = entry?.model?.[0] as AssistantMessage | undefined;
	if (message === undefined) return "";
	return message.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("");
}


/** `filename:` / `path:` lines of a trailing RESULT: block, for UI previews. */
function parseViz(text: string): Viz | undefined {
	const lines = text.split("\n");
	const start = lines.findIndex((line) => /^\s*RESULT:/.test(line));
	if (start === -1) return undefined;
	const viz: Viz = {};
	for (const line of lines.slice(start + 1)) {
		const filename = line.match(/^\s*filename:\s*(\S+)/);
		if (filename !== null) viz.filename = filename[1];
		const path = line.match(/^\s*path:\s*(\S+)/);
		if (path !== null) viz.path = path[1];
	}
	return viz.filename !== undefined || viz.path !== undefined ? viz : undefined;
}

export const Subagents = defineExtension({
	name: EXT.subagents,
	tools: [subagent],
});

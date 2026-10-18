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
	type EntryId,
	type Extension,
	LiveDoc,
	type LiveState,
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
		"Delegate a self-contained task to a specialist subagent and get its answer back: researcher (web research, cited brief), typst-maker (precise Typst diagrams → PNG+SVG), mermaid-maker (simple structural diagrams → PNG). The subagent shares NO conversation context — the prompt must carry everything it needs. Batch independent subagent calls in one round: they run in parallel.",
	parameters: Type.Object({
		name: Type.Union(AGENT_NAMES.map((name) => Type.Literal(name)), {
			description: "Which specialist to run",
		}),
		prompt: Type.String({ description: "Fully self-contained task or brief for the specialist" }),
	}),
	// The visualize skill spells this call `subagent(agent=…, task=…)`; accept both
	// spellings. The result is still validated against `parameters`.
	prepareArguments: (args: unknown) => {
		const record = (typeof args === "object" && args !== null ? args : {}) as Record<string, unknown>;
		const name = typeof record.name === "string" ? record.name : record.agent;
		const prompt = typeof record.prompt === "string" ? record.prompt : record.task;
		return { name, prompt } as { name: AgentName; prompt: string };
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

		// Live progress: forward the child's streamed text into this call's output
		// at most once a second, so the learner sees work under the tool line.
		const watch = await api.watchDoc(LiveDoc, childId, callContext);
		let forwarded = 0;
		let lastForwardAt = 0;
		if (watch !== undefined) {
			watch.start(async (state) => {
				const now = Date.now();
				if (now - lastForwardAt < 1000) return;
				const text = liveText(state);
				if (text === undefined || text.length <= forwarded) return;
				lastForwardAt = now;
				forwarded = text.length;
				const tail = text.slice(-200).replace(/\s+/g, " ").trim();
				api.output(`${args.name}: ${tail}\n`);
			});
		}

		try {
			// The requestId makes a rerun get back the submission it made before
			// the crash instead of asking the child again.
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
		} finally {
			if (watch !== undefined) await watch.stop();
		}
	},
});

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

/** Text streamed so far in the child's in-flight response, if any. */
function liveText(state: Readonly<LiveState> | null): string | undefined {
	const message: unknown = state?.generation?.message;
	if (typeof message !== "object" || message === null || !("content" in message)) return undefined;
	const content: unknown = message.content;
	if (!Array.isArray(content)) return undefined;
	let text = "";
	for (const block of content) {
		if (
			typeof block === "object" &&
			block !== null &&
			"type" in block &&
			block.type === "text" &&
			"text" in block &&
			typeof block.text === "string"
		) {
			text += block.text;
		}
	}
	return text;
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

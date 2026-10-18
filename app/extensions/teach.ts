/**
 * Teach: loads the repo's teaching skill as the root conversation's system
 * sections and appends the runtime addendum (confidence-quiz interpretation,
 * note mining, tool-name mapping). Also registers `ask_user` — the preference
 * question tool with no right answer.
 */
import { Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool, section } from "@earendil-works/pi-durable";
import { loadSkill } from "../content.ts";
import { EXT, TOOL, ui } from "../shared.ts";

const SHARED_UI_LOCK_KEY = "__piSharedUiLock";

/**
 * The one overlay slot's cross-tool mutex, shared with QuizAsk by key: whoever
 * creates it first installs the promise chain on globalThis; every ask/quiz
 * dialog serializes through it even under parallel tool execution.
 */
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

const TEACH_ADDENDUM = `
## Runtime addendum — tools and the confidence quiz

### Tool names in this runtime

- The \`researcher\` subagent of the skills below is the \`subagent\` tool: \`subagent(name="researcher", prompt="<self-contained task>")\`. Likewise \`subagent(name="typst-maker" | "mermaid-maker", prompt="<brief>")\`. A subagent sees nothing else of this conversation — put everything it needs in \`prompt\`.
- **Batch independent \`subagent\` calls in one tool round** — they then run in parallel (researcher scoping + maker drawing at once). Sequential rounds run one call at a time. This is the default when a visual is likely: fire researcher AND the maker together, never one-then-the-other.
- **Write the teaching prose FIRST, then fire the tool calls in the same message** — your text streams to the learner while the subagents work underneath. A message that only calls tools leaves him staring at silence; a message that teaches, then delegates, keeps the lesson moving during the wait.
- \`ask_user_question\` in the skills is the \`ask_user\` tool here — same role: preferences and direction, never a gradable fact.
- After every teaching exchange (plan presented, node established, quiz answered, visual embedded), call \`md_log\` with the matching \`kind\` (\`q&a\`, \`quiz\`, \`viz\`) so the lesson file mirrors the session verbatim.

### Reading quiz results — grade × confidence

Every quiz result carries \`confidence\` (1 Sure · 2 Pretty sure · 3 Guessed; null = he skipped the stage) and \`note\` (his own words, "" when none) alongside \`correct\` and \`dontKnow\`. Read the pair BEFORE choosing the next move:

| result | meaning | your move |
|---|---|---|
| correct + 1 Sure | floor confirmed | acknowledge in ≤1 sentence, then jump difficulty up sharply |
| correct + 2 Pretty sure | right, not yet owned | confirm *why* it is right — one-line reason check before building on it |
| correct + 3 Guessed | lucky, not knowledge | explain properly as if new; re-probe from another angle before trusting it |
| wrong + 1 Sure | active misconception — highest priority | stop building. Surface the conflict directly, correct it at its root, re-quiz later |
| wrong + 2 Pretty sure | standard error | correct + name the distinction that caused it |
| wrong + 3 Guessed | shaky guess | gentle full re-teach of this node |
| dontKnow | ceiling found | teach as brand new; narrow scope to pin the edge |

All-correct at one level is never "done" — escalate until something breaks.

### Mining the note

A non-empty \`note\` is his mental model in his own words; it outranks the bare grade:

- **Confusion or reason stated** ("is it because XOR drops the carry?"): form ONE concrete hypothesis ("he thinks X because Y"), answer it in prose first, then quiz the *reason* — a question that discriminates his hypothesis from the truth. Never re-ask the same fact.
- **Meta feedback** ("too fast", "too many terms"): adjust how you teach next — pace, step size, vocabulary — before teaching more content.
- **Related topic outside the plan**: queue it as a follow-up; offer it when the current node closes. Do not chase it mid-node.
`;

const VISUALIZE_ADDENDUM = `
Runtime note: dispatch makers with \`subagent(name="typst-maker" | "mermaid-maker", prompt="<brief>")\` — the skill's \`agent=\`/\`task=\` spellings name this tool's \`name\`/\`prompt\` parameters. \`svg-maker\` is retired in this app; route its use cases to typst-maker.
`;

const askUser = defineTool({
	name: TOOL.askUser,
	description:
		"Ask the learner a preference or direction question with options — only for questions with NO right answer (goal, pace, what he wants next). For gradable questions use quiz.",
	parameters: Type.Object({
		header: Type.Optional(Type.String({ description: "Short header shown above the question" })),
		question: Type.String({ description: "The question to ask" }),
		options: Type.Array(
			Type.Object({
				label: Type.String({ description: "Option label" }),
				description: Type.Optional(Type.String({ description: "One-line clarification under the label" })),
			}),
			{ minItems: 2, description: "The options to choose from" },
		),
		multi: Type.Optional(Type.Boolean({ description: "Allow selecting several options" })),
		allowText: Type.Optional(Type.Boolean({ description: "Also let him type his own answer instead" })),
	}),
	replay: "safe",
	async execute(args) {
		const response = await getSharedUiLock().withLock(() =>
			ui({
				kind: "ask",
				header: args.header,
				question: args.question,
				options: args.options,
				multi: args.multi,
				allowText: args.allowText,
			}),
		);
		if ("aborted" in response) {
			return { output: [{ type: "text", text: "user dismissed; ask differently or move on" }] };
		}
		if ("indexes" in response) {
			const picked = response.indexes
				.map((index) => args.options[index]?.label)
				.filter((label) => typeof label === "string");
			return {
				output: [
					{
						type: "text",
						text:
							picked.length > 0
								? `He chose: ${picked.join(", ")}`
								: "He selected none of the options",
					},
				],
			};
		}
		if ("freeText" in response) {
			return { output: [{ type: "text", text: `He answered in his own words: ${response.freeText}` }] };
		}
		return { output: [{ type: "text", text: "user dismissed; ask differently or move on" }] };
	},
});

export const Teach = defineExtension({
	name: EXT.teach,
	sections: [
		section("teach", () => loadSkill("skills/teach/SKILL.md") + "\n" + TEACH_ADDENDUM),
		section("visualize", () => loadSkill("skills/visualize/SKILL.md") + "\n" + VISUALIZE_ADDENDUM),
	],
	tools: [askUser],
});

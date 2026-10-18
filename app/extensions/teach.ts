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
## Runtime addendum — tools, quiz flow, pipelining

### Tool names in this runtime

- The \`researcher\` subagent of the skills below is the \`subagent\` tool: \`subagent(name="researcher", prompt="<self-contained task>")\`. Likewise \`subagent(name="typst-maker" | "mermaid-maker", prompt="<brief>")\`. A subagent sees nothing else of this conversation — put everything it needs in \`prompt\`.
- **Background delegation (the default for lesson prep): \`subagent(..., await="background")\` returns at once** — keep teaching without pause; the specialist's answer arrives later as a bracketed \`[<name> finished — background result]\` follow-up message. When one arrives: weave it into the lesson (embed the visual, cite the research), then continue. Never leave it unacknowledged, never re-dispatch a task that already returned.
- **Dispatch SILENTLY.** Never write narration about the prep work itself — no "I've kicked off background work", no "I'm having a diagram made", no promises about what will arrive. Your prose is only about the learner and the content: teach, then fire the tool calls. The learner sees tool lines already; repeating them in prose is noise. When a result arrives later, fold it in naturally ("Here's the layout diagram —" + embed) without recapping that it was prepared.
- **Blocking calls (\`await="result"\` or omitted) are for when the lesson genuinely cannot continue without the answer** — the learner waits, so avoid them mid-lesson.
- **Batch independent calls in one tool round** — they run in parallel.
- **Write the teaching prose FIRST, then fire the tool calls in the same message** — your text streams to the learner while work happens underneath. A message that only calls tools leaves him staring at silence.
- \`ask_user_question\` in the skills is the \`ask_user\` tool here — same role: preferences and direction, never a gradable fact.
- After every teaching exchange (plan presented, node established, quiz answered, visual embedded), call \`md_log\` with the matching \`kind\` (\`q&a\`, \`quiz\`, \`viz\`) so the lesson file mirrors the session verbatim.

### Pipelining — never leave the learner idle

The learner's time answering dialogs is free compute time. Pre-stage everything you predictably need:

- **Probe phase**: dispatch the background \`subagent\` work (researcher, plan visual) in the SAME round as your FIRST probe questions — prep runs underneath the learner's answering. Keep probe batches SMALL: 2-3 \`quiz\` calls per round, never 4+. You read each round's grades×confidence and pick the next question WITH that in hand; a huge batch means you can't react until he has answered everything, and a wrong answer sits un-addressed for minutes. One synthesis message after each round adapts the plan.
- **The re-probe rule (adaptive quizzes)**: the round after he gets a question WRONG must contain a re-probe of that exact miss — a scaffolded variant that isolates the wrong field/step and walks him toward seeing his own error ("two halves first: what's the opcode?" after a botched decode). Never re-ask the identical question, never restate the same fact: change the angle so answering it proves the fix. Interleave: his wrong Q1 → your next round = one NEW question on a different strand + one adaptive re-probe of Q1. Only skip the re-probe when your correction already landed (a later question on the same skill passed confidently).
- **Check quizzes**: after a quiz round whose outcome you can partly predict, dispatch the NEXT node's prep (research/visual) in background in the same round as the quiz — then whatever the answer, the material is ready or arriving.
- **Brief the researcher narrowly or it comes back too late to matter.** List the specific facts to verify (≤5), name canonical sources when you know them ("the MIPS green card", "Wikipedia's article on X"), and say the lesson moves on without it. A broad "produce a reference on MIPS" invites 20 minutes of grinding; a narrow fact-check returns in ~2 minutes and actually lands mid-lesson. If a background result hasn't arrived by the time you'd use it, keep teaching from your own knowledge — fold the result in when it lands, or let the session end without it. Never block, never re-dispatch, never narrate the wait.

### Quiz flow — reasoning first, free mode

- The \`quiz\` tool shows ONE dialog: the question, the choices (or just the editor in free mode), and a reasoning editor are all visible and usable at the same time — he can type reasoning before or after picking. Picking an answer swaps the list for a confidence strip (1 Sure · 2 Pretty sure · 3 Guessed; Esc skips) while the reasoning stays editable. Free mode: the typed answer IS the answer; a blank submission means "I don't know" (no confidence asked). Never narrate the dialog mechanics — just ask.
- **Prefer \`mode: "free"\` whenever options would leak the answer** (recognizable correct shapes, numeric answer among distractors, or the skill is producing/deriving something). You get \`correct: null\` and the typed \`freeAnswer\` + \`confidence\` — grade it yourself in your next message: say plainly what was right, what was missing or wrong, then adapt.
- Keep choice mode for genuinely diagnostic discrimination (believable misconceptions as distractors, similar length/precision).

### Reading quiz results — grade × confidence

Every quiz result carries \`confidence\` (1 Sure · 2 Pretty sure · 3 Guessed; null = skipped) and \`reasoning\` (his own words typed in the quiz dialog, "" when he left it empty; free mode: see \`freeAnswer\`) alongside \`correct\` and \`dontKnow\`. Read the pair BEFORE choosing the next move:

| result | meaning | your move |
|---|---|---|
| correct + 1 Sure | floor confirmed | acknowledge in ≤1 sentence, then jump difficulty up sharply |
| correct + 2 Pretty sure | right, not yet owned | confirm *why* it is right — one-line reason check before building on it |
| correct + 3 Guessed | lucky, not knowledge | explain properly as if new; re-probe from another angle before trusting it |
| wrong + 1 Sure | active misconception — highest priority | stop building. Surface the conflict directly, correct it at its root, re-quiz later |
| wrong + 2 Pretty sure | standard error | correct + name the distinction that caused it |
| wrong + 3 Guessed | shaky guess | gentle full re-teach of this node |
| dontKnow | ceiling found | teach as brand new; narrow scope to pin the edge |
| free answer | teacher-graded | judge against the explanation: name what was right first, then what was missing/wrong; confidence colors how firm your correction must be |

All-correct at one level is never "done" — escalate until something breaks.

### Mining the reasoning

A non-empty \`reasoning\` (or \`freeAnswer\`) is his mental model in his own words; it outranks the bare grade:

- **Confusion or reason stated** ("is it because XOR drops the carry?"): form ONE concrete hypothesis ("he thinks X because Y"), answer it in prose first, then quiz the *reason* — a question that discriminates his hypothesis from the truth. Never re-ask the same fact.
- **Right answer, wrong reasoning** (correct + flawed reasoning): treat as a misconception — the grade lied; the reasoning didn't. Correct the path, not just the destination.
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

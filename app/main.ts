#!/usr/bin/env node
/**
 * learn — durable tutoring CLI on the pi-durable harness.
 *
 *   learn [--continue] [--model provider/modelId] [--print "question"] [topic...]
 *
 * `--print` runs one headless turn (no TUI; quiz/ask dialogs see "aborted").
 * LEARN_NO_EXTENSIONS=1 boots the bare runtime (no teach extensions) for
 * tests; LEARN_FAUX_REPLY="..." scripts the faux provider's answer.
 */

import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { createLearnModels, defaultModel, fauxHandle, requireCredentials, resolveModel } from "./models.ts";
import type { LearnExtensions } from "./runtime.ts";
import { loadLearnExtensions, openRuntime, type OpenRuntimeResult } from "./runtime.ts";
import { selectSession } from "./sessions.ts";
import { runTui } from "./ui/tui.ts";

interface Args {
	continueSession: boolean;
	modelSpec: string | undefined;
	print: string | undefined;
	debug: boolean;
	topic: string[];
}

const USAGE = `usage: learn [--continue] [--model provider/modelId] [--print "question"] [-d] [topic...]

  --continue, -c      resume the newest session for this directory
  --model spec        e.g. commandcode/deepseek/deepseek-v4.1-flash
  --print question    one headless turn: print the answer and exit
  -d, --debug         show the background task panel (also: /tasks)
  topic               opening prompt, e.g. learn "half-adders"

env: LEARN_MODEL (default model override), provider API keys (ZAI_API_KEY, ...),
     ~/.pi/agent/auth.json and ~/.omp/agent/agent.db are read for credentials.`;

function parseArgs(argv: readonly string[]): Args {
	const args: Args = { continueSession: false, modelSpec: undefined, print: undefined, debug: false, topic: [] };
	for (let index = 0; index < argv.length; index++) {
		const arg = argv[index] as string;
		if (arg === "--continue" || arg === "-c") args.continueSession = true;
		else if (arg === "--model") args.modelSpec = argv[++index];
		else if (arg === "--print") args.print = argv[++index];
		else if (arg === "--debug" || arg === "-d") args.debug = true;
		else if (arg === "--help" || arg === "-h") {
			console.log(USAGE);
			process.exit(0);
		} else if (arg.startsWith("--")) throw new Error(`Unknown argument: ${arg} (${USAGE})`);
		else args.topic.push(arg);
	}
	if (args.modelSpec === "") throw new Error(`--model needs a "provider/modelId" value`);
	if (args.print === "") throw new Error("--print needs a question");
	return args;
}

/** The text of the newest committed assistant entry. */
function lastAnswer(runtime: OpenRuntimeResult): string {
	const entries = runtime.view.current().conversation.entries;
	for (const entry of [...entries].reverse()) {
		const message = entry.model?.[0];
		if (entry.kind !== "pi.assistant" || message?.role !== "assistant") continue;
		const text = (message as AssistantMessage).content
			.flatMap((block) => (block.type === "text" ? [block.text] : ([] as string[])))
			.join("")
			.trim();
		if (text) return text;
		if ((message as AssistantMessage).errorMessage) return (message as AssistantMessage).errorMessage as string;
	}
	return "";
}

async function main(): Promise<void> {
	const args = parseArgs(process.argv.slice(2));
	const location = await selectSession(process.cwd(), args.continueSession);
	const models = createLearnModels();
	const initial =
		args.modelSpec !== undefined ? resolveModel(models, args.modelSpec) : await defaultModel(models);
	if (args.modelSpec !== undefined) await requireCredentials(models, initial.ref.provider);
	const faux = initial.ref.provider === "faux" ? fauxHandle(models) : undefined;
	// Every faux turn answers with the scripted reply when one is given.
	const scriptFaux = (): void => {
		const reply = process.env.LEARN_FAUX_REPLY;
		if (faux !== undefined && reply !== undefined) faux.appendResponses([fauxAssistantMessage(reply)]);
	};

	let extensions: LearnExtensions = { root: [], registry: [] };
	if (process.env.LEARN_NO_EXTENSIONS !== "1") extensions = await loadLearnExtensions();

	const runtime = await openRuntime({
		location,
		models,
		rootExtensions: extensions.root,
		registryExtensions: extensions.registry,
		initialModel: initial.ref,
		debugTasks: args.debug,
	});
	// With LEARN_FAUX_REPLY set, every faux turn (topic, --print, or typed in
	// the TUI) answers with the scripted reply — the affordance for headless tests.
	const controller =
		faux === undefined
			? runtime.controller
			: {
					...runtime.controller,
					submit: (text: string, whenBusy: "steer" | "followUp") => {
						scriptFaux();
						return runtime.controller.submit(text, whenBusy);
					},
				};
	try {
		if (args.print !== undefined) {
			await controller.submit(args.print, "steer");
			await runtime.waitForIdle();
			const answer = lastAnswer(runtime);
			console.log(answer || "(no answer)");
			// One-shot mode: provider keep-alive sockets can otherwise hold the
			// process open for minutes after the answer is committed.
			process.exit(0);
		} else {
			if (args.topic.length > 0) await controller.submit(args.topic.join(" "), "steer");
			await runTui(runtime.view, controller);
		}
	} finally {
		await runtime.close();
	}
}


try {
	await main();
} catch (error) {
	console.error(error instanceof Error ? error.message : String(error));
	process.exit(1);
}

/**
 * commandcode — Command Code Provider API (commandcode.ai) as a pi-ai
 * provider. The catalog comes from /provider/v1/models; per the service's
 * `supported_endpoints`, Claude models answer on the Anthropic wire, models
 * advertising /responses use the OpenAI Responses wire, everything else uses
 * OpenAI Chat Completions — one provider, mixed wires, selected per model.
 *
 * Credentials: a stored api_key credential (auth.json `commandcode` entry)
 * or COMMAND_CODE_API_KEY (`user_…`). Keys are Command Code subscription
 * credentials; DeepSeek platform keys do not work here and vice versa.
 */
import type { Model } from "@earendil-works/pi-ai";
import { createProvider, type Provider } from "@earendil-works/pi-ai/models";
import { stream as ocStream, streamSimple as ocStreamSimple } from "@earendil-works/pi-ai/api/openai-completions";
import { stream as orStream, streamSimple as orStreamSimple } from "@earendil-works/pi-ai/api/openai-responses";
import { stream as amStream, streamSimple as amStreamSimple } from "@earendil-works/pi-ai/api/anthropic-messages";

const BASE = "https://api.commandcode.ai/provider/v1";

/** Catalog entry shape of /provider/v1/models (defensively parsed). */
type CatalogModel = {
	id?: unknown;
	name?: unknown;
	supported_endpoints?: unknown;
	reasoning?: unknown;
	input?: unknown;
	context_window?: unknown;
	max_output_tokens?: unknown;
};

/** DeepSeek-family wire quirks, mirroring pi-ai's own deepseek provider. */
const DEEPSEEK_COMPAT = {
	supportsStore: false,
	supportsDeveloperRole: false,
	maxTokensField: "max_tokens",
	requiresReasoningContentOnAssistantMessages: true,
	thinkingFormat: "deepseek",
	supportsStrictMode: true,
} as NonNullable<Model<"openai-completions">["compat"]>;

type Wire = "openai-completions" | "openai-responses" | "anthropic-messages";

function chatModel(raw: CatalogModel): Model<Wire> {
	const id = typeof raw.id === "string" ? raw.id : "";
	const endpoints = Array.isArray(raw.supported_endpoints) ? (raw.supported_endpoints as string[]) : [];
	const api: Wire = endpoints.includes("/chat/completions")
		? "openai-completions"
		: endpoints.includes("/responses")
			? "openai-responses"
			: "anthropic-messages";
	const hasImage = Array.isArray(raw.input) && (raw.input as string[]).some((m) => m === "image");
	return {
		type: "chat",
		id,
		name: typeof raw.name === "string" ? raw.name : id,
		api,
		baseUrl: BASE,
		provider: "commandcode",
		reasoning: raw.reasoning === true,
		input: hasImage ? ["text", "image"] : ["text"],
		contextWindow: typeof raw.context_window === "number" ? raw.context_window : 131_072,
		maxTokens: typeof raw.max_output_tokens === "number" ? raw.max_output_tokens : 32_768,
		// The Provider API catalog carries no prices; pi-ai's cost calculator
		// requires the object to exist, so unknown prices read as zero.
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		...(id.startsWith("deepseek/") ? { compat: DEEPSEEK_COMPAT } : {}),
	} as Model<Wire>;
}

/** Offline baseline so the pinned model resolves without a catalog round-trip. */
const BASELINE: CatalogModel[] = [
	{ id: "deepseek/deepseek-v4.1-flash", name: "DeepSeek V4.1 Flash", supported_endpoints: ["/chat/completions", "/responses"], reasoning: true, context_window: 1_000_000 },
	{ id: "deepseek/deepseek-v4.1-flash-fast", name: "DeepSeek V4.1 Flash Fast", supported_endpoints: ["/chat/completions", "/responses"], reasoning: true, context_window: 1_000_000 },
	{ id: "deepseek/deepseek-v4-flash", name: "DeepSeek V4 Flash", supported_endpoints: ["/chat/completions", "/responses"], reasoning: true },
	{ id: "deepseek/deepseek-v4-pro", name: "DeepSeek V4 Pro", supported_endpoints: ["/chat/completions", "/responses"], reasoning: true },
];

export function commandCodeProvider(): Provider<"openai-completions" | "openai-responses" | "anthropic-messages"> {
	return createProvider({
		id: "commandcode",
		name: "Command Code",
		baseUrl: BASE,
		auth: {
			apiKey: {
				name: "Command Code API key",
				resolve: async ({ credential, ctx, signal }) => {
					signal.throwIfAborted();
					if (credential?.type === "api_key" && credential.key) {
						return { auth: { apiKey: credential.key }, source: "stored credential" };
					}
					const value = await ctx.env("COMMAND_CODE_API_KEY");
					if (value) return { auth: { apiKey: value }, source: "COMMAND_CODE_API_KEY" };
					return undefined;
				},
			},
		},
		models: BASELINE.map(chatModel),
		fetchModels: async (context) => {
			if (!context.allowNetwork) return [];
			const key = context.credential?.type === "api_key" ? context.credential.key : undefined;
			const headers: Record<string, string> = key === undefined ? {} : { Authorization: `Bearer ${key}` };
			const res = await fetch(`${BASE}/models`, { headers, signal: context.signal });
			if (!res.ok) throw new Error(`commandcode catalog fetch failed (${res.status})`);
			const json = (await res.json()) as { data?: CatalogModel[] } | CatalogModel[];
			const list = Array.isArray(json) ? json : (json.data ?? []);
			return list.filter((m) => typeof m?.id === "string" && m.id !== "").map(chatModel);
		},
		api: {
			"openai-completions": { stream: ocStream, streamSimple: ocStreamSimple },
			"openai-responses": { stream: orStream, streamSimple: orStreamSimple },
			"anthropic-messages": { stream: amStream, streamSimple: amStreamSimple },
		},
	});
}

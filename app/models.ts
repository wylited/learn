/**
 * models — provider registry and credential resolution for the learn app.
 *
 * Providers come from pi-ai's built-in factories (static model catalogs). A
 * credential is resolved per provider in priority order:
 *   1. env API key (ZAI_API_KEY, ANTHROPIC_API_KEY, OPENROUTER_API_KEY,
 *      OPENAI_API_KEY, OPENCODE_API_KEY)
 *   2. ~/.pi/agent/auth.json — pi's own credential file; `api_key` entries
 *      carry `{type:"api_key", key}`, `oauth` entries carry
 *      `{type:"oauth", refresh, access, expires}` (both are pi-ai Credential
 *      shapes as-is)
 *   3. ~/.omp/agent/agent.db `auth_credentials` rows (omp's login store);
 *      only `api_key` rows with a `key` field and a known provider id map
 *
 * The default model is LEARN_MODEL ("provider/modelId"), else pi's
 * ~/.pi/agent/settings.json defaultProvider/defaultModel, else zai/glm-5.3-flash.
 */

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Credential, CredentialInfo, CredentialStore } from "@earendil-works/pi-ai";
import {
	createModels,
	fauxProvider,
	type FauxProviderHandle,
	type Model,
	type Models,
	type MutableModels,
} from "@earendil-works/pi-ai";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { deepseekProvider } from "@earendil-works/pi-ai/providers/deepseek";
import { githubCopilotProvider } from "@earendil-works/pi-ai/providers/github-copilot";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { opencodeProvider } from "@earendil-works/pi-ai/providers/opencode";
import { openrouterProvider } from "@earendil-works/pi-ai/providers/openrouter";
import { zaiProvider } from "@earendil-works/pi-ai/providers/zai";

/** Env API key per provider id; the first source a credential may come from. */
const ENV_KEYS: Readonly<Record<string, string>> = {
	zai: "ZAI_API_KEY",
	anthropic: "ANTHROPIC_API_KEY",
	openrouter: "OPENROUTER_API_KEY",
	openai: "OPENAI_API_KEY",
	opencode: "OPENCODE_API_KEY",
	deepseek: "DEEPSEEK_API_KEY",
};


const AUTH_JSON = join(homedir(), ".pi", "agent", "auth.json");
const AGENT_DB = join(homedir(), ".omp", "agent", "agent.db");
const PI_SETTINGS = join(homedir(), ".pi", "agent", "settings.json");

/** Every provider id the registry installs, in install order. */
const PROVIDER_IDS = ["zai", "anthropic", "openrouter", "openai", "github-copilot", "opencode", "deepseek", "faux"];

/** One read-only credential per provider plus in-memory writes (login flows unused here). */
class LearnCredentialStore implements CredentialStore {
	#overrides = new Map<string, Credential | undefined>();

	async read(providerId: string): Promise<Credential | undefined> {
		if (this.#overrides.has(providerId)) return this.#overrides.get(providerId);
		const envKey = ENV_KEYS[providerId];
		if (envKey !== undefined && process.env[envKey]) return { type: "api_key", key: process.env[envKey] };
		return (await fileCredentials())[providerId];
	}

	async list(): Promise<readonly CredentialInfo[]> {
		const file = await fileCredentials();
		const ids = new Set<string>([...Object.keys(file), ...this.#overrides.keys()]);
		for (const [id, key] of Object.entries(ENV_KEYS)) if (process.env[key]) ids.add(id);
		const info: CredentialInfo[] = [];
		for (const providerId of ids) {
			const credential = await this.read(providerId);
			info.push({ providerId, type: credential?.type ?? "api_key" });
		}
		return info;
	}

	async modify(
		providerId: string,
		fn: (current: Credential | undefined) => Promise<Credential | undefined>,
	): Promise<Credential | undefined> {
		const next = await fn(this.#overrides.get(providerId) ?? (await this.read(providerId)));
		this.#overrides.set(providerId, next);
		return next;
	}

	async delete(providerId: string): Promise<void> {
		this.#overrides.set(providerId, undefined);
	}
}

let cachedFileCredentials: Promise<Record<string, Credential>> | undefined;

/** Credentials from ~/.pi/agent/auth.json then ~/.omp/agent/agent.db; earlier ids win. */
function fileCredentials(): Promise<Record<string, Credential>> {
	cachedFileCredentials ??= (async () => {
		const credentials: Record<string, Credential> = {};
		let json: unknown;
		try {
			json = JSON.parse(await readFile(AUTH_JSON, "utf8"));
		} catch {
			json = undefined;
		}
		if (json !== null && typeof json === "object") {
			for (const [id, entry] of Object.entries(json as Record<string, unknown>)) {
				const credential = asCredential(entry);
				if (credential !== undefined) credentials[id] = credential;
			}
		}
		// omp's store: api_key logins only (provider ids it shares with pi-ai, e.g. zai).
		try {
			const db = new DatabaseSync(AGENT_DB, { readOnly: true });
			try {
				const rows = db
					.prepare("SELECT provider, data FROM auth_credentials WHERE disabled_cause IS NULL")
					.all() as { provider: string; data: string }[];
				for (const row of rows) {
					if (credentials[row.provider] !== undefined) continue;
					let parsed: unknown;
					try {
						parsed = JSON.parse(row.data);
					} catch {
						continue;
					}
					const credential = asCredential(parsed);
					if (credential?.type === "api_key" && credential.key) credentials[row.provider] = credential;
				}
			} finally {
				db.close();
			}
		} catch {
			// No omp store on this machine; env and auth.json already applied.
		}
		return credentials;
	})();
	return cachedFileCredentials;
}

/** A pi-ai Credential shape, or undefined: api_key entries need a `key`, oauth entries need refresh+access. */
function asCredential(entry: unknown): Credential | undefined {
	if (entry === null || typeof entry !== "object") return undefined;
	const candidate = entry as Record<string, unknown>;
	if (candidate.type === "api_key" && typeof candidate.key === "string" && candidate.key) {
		return { type: "api_key", key: candidate.key };
	}
	if (
		candidate.type === "oauth" &&
		typeof candidate.refresh === "string" &&
		typeof candidate.access === "string" &&
		typeof candidate.expires === "number"
	) {
		return { type: "oauth", refresh: candidate.refresh, access: candidate.access, expires: candidate.expires };
	}
	return undefined;
}

/** The faux handle of the provider a createLearnModels() call registered, for scripted test responses. */
const fauxHandles = new WeakMap<object, FauxProviderHandle>();

/**
 * The app's model registry: every built-in provider above plus `faux` for
 * tests (no auth), credentials from env → auth.json → agent.db.
 */
export function createLearnModels(): MutableModels {
	const models = createModels({ credentials: new LearnCredentialStore() });
	models.setProvider(zaiProvider());
	models.setProvider(anthropicProvider());
	models.setProvider(openrouterProvider());
	models.setProvider(openaiProvider());
	models.setProvider(githubCopilotProvider());
	models.setProvider(opencodeProvider());
	models.setProvider(deepseekProvider());
	const faux = fauxProvider();
	fauxHandles.set(faux.provider, faux);
	models.setProvider(faux.provider);
	return models;
}

/** The faux provider handle behind `models`, to queue scripted responses in tests. */
export function fauxHandle(models: Models): FauxProviderHandle | undefined {
	const provider = models.getProvider("faux");
	return provider === undefined ? undefined : fauxHandles.get(provider);
}

export interface ResolvedModel {
	ref: { provider: string; modelId: string };
	model: Model;
}

/** `"provider/modelId"` (modelId may itself contain slashes, e.g. openrouter's `z-ai/glm-5.3`). */
export function resolveModel(models: Models, spec: string): ResolvedModel {
	const separator = spec.indexOf("/");
	if (separator <= 0 || separator === spec.length - 1) {
		throw new Error(`Model spec must be "provider/modelId": ${spec}`);
	}
	const provider = spec.slice(0, separator);
	const modelId = spec.slice(separator + 1);
	const model = models.getModel(provider, modelId);
	if (model === undefined) {
		const known = models
			.getProviders()
			.map((entry) => entry.id)
			.join(", ");
		throw new Error(`Unknown model ${spec} (providers: ${known})`);
	}
	return { ref: { provider, modelId }, model };
}

/** Throws listing every credential source tried unless `provider` is usable (faux and keyless aside). */
export async function requireCredentials(models: Models, provider: string): Promise<void> {
	if (provider === "faux" || (await models.checkAuth(provider)) !== undefined) return;
	throw new Error(noCredentialsMessage(provider));
}

/** The model a new session starts with; throws listing every source tried when unconfigured. */
export async function defaultModel(models: Models): Promise<ResolvedModel> {
	if (process.env.LEARN_MODEL) {
		const resolved = resolveModel(models, process.env.LEARN_MODEL);
		await requireCredentials(models, resolved.ref.provider);
		return resolved;
	}
	let provider = "zai";
	let modelId = "glm-5.3-flash";
	try {
		const settings = JSON.parse(await readFile(PI_SETTINGS, "utf8")) as {
			defaultProvider?: unknown;
			defaultModel?: unknown;
		};
		if (typeof settings.defaultProvider === "string" && typeof settings.defaultModel === "string") {
			provider = settings.defaultProvider;
			modelId = settings.defaultModel;
		}
	} catch {
		// No pi settings; keep the built-in default.
	}
	const resolved = resolveModel(models, `${provider}/${modelId}`);
	await requireCredentials(models, provider);
	return resolved;
}

function noCredentialsMessage(provider: string): string {
	const envKey = ENV_KEYS[provider] ?? `${provider.toUpperCase().replace(/-/g, "_")}_API_KEY`;
	return [
		`No credentials for ${provider}. Tried:`,
		`  - env ${envKey} (others: ${Object.values(ENV_KEYS).join(", ")})`,
		`  - ${AUTH_JSON}`,
		`  - ${AGENT_DB}`,
		"Set LEARN_MODEL=provider/modelId to pick another provider.",
	].join("\n");
}

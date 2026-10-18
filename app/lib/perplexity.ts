/**
 * Perplexity web search via the site's own SSE ask endpoint.
 *
 * Auth: LEARN_PERPLEXITY_TOKEN env, else the `perplexity` session token omp
 * stored in ~/.omp/agent/agent.db (auth_credentials.data.access). Without a
 * token requests go anonymous, which usually hits a quota wall — surfaced as a
 * clear error telling the user how to authenticate.
 */
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";

export type PerplexitySource = {
	title: string;
	url: string;
	snippet?: string;
	date?: string;
};

export type PerplexityResult = {
	answer: string;
	sources: PerplexitySource[];
};

const ASK_URL = "https://www.perplexity.ai/rest/sse/perplexity_ask";
const APP_UA = "Perplexity/641 CFNetwork/1568 Darwin/25.2.0";
const BROWSER_UA =
	"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36";

/** One parsed SSE snapshot; fields are read only after typeof checks. */
type Snapshot = Record<string, unknown>;

let cachedToken: string | null | undefined;

/** Session token from env or omp's agent.db; null → anonymous mode. */
export async function perplexityToken(): Promise<string | null> {
	if (cachedToken !== undefined) return cachedToken;
	cachedToken = process.env.LEARN_PERPLEXITY_TOKEN || readOmpToken();
	return cachedToken;
}

function readOmpToken(): string | null {
	try {
		// node:sqlite is optional for callers that never search: load lazily.
		const sqlite = require("node:sqlite") as { DatabaseSync: typeof DatabaseSync };
		const db = new sqlite.DatabaseSync(join(homedir(), ".omp", "agent", "agent.db"), { readOnly: true });
		try {
			const row = db
				.prepare(
					"SELECT data FROM auth_credentials WHERE provider = 'perplexity' AND disabled_cause IS NULL",
				)
				.get() as { data: string } | undefined;
			if (row === undefined) return null;
			const parsed: unknown = JSON.parse(row.data);
			const access = typeof parsed === "object" && parsed !== null && "access" in parsed ? parsed.access : undefined;
			return typeof access === "string" && access.length > 0 ? access : null;
		} finally {
			db.close();
		}
	} catch {
		return null;
	}
}

export class PerplexityError extends Error {
	readonly status?: number;

	constructor(message: string, status?: number) {
		super(message);
		this.name = "PerplexityError";
		this.status = status;
	}
}

/**
 * Ask Perplexity one question; returns the cited answer plus its sources.
 * Transport drops before a response are retried exactly once (omp #5315).
 */
export async function perplexitySearch(
	query: string,
	options?: { timeoutMs?: number },
): Promise<PerplexityResult> {
	const timeoutMs = options?.timeoutMs ?? 30_000;
	try {
		return await askOnce(query, timeoutMs);
	} catch (error) {
		// Only transport-level failures (no HTTP status) get the single retry.
		if (error instanceof PerplexityError && error.status === undefined) {
			return await askOnce(query, timeoutMs);
		}
		throw error;
	}
}

async function askOnce(query: string, timeoutMs: number): Promise<PerplexityResult> {
	const token = await perplexityToken();
	const uuid = randomUUID();
	const anonymous = token === null;
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	try {
		let response: Response;
		try {
			response = await fetch(ASK_URL, {
				method: "POST",
				signal: controller.signal,
				headers: headers(token, uuid),
				body: JSON.stringify(body(query, uuid, anonymous)),
			});
		} catch (error) {
			throw new PerplexityError(`perplexity: transport failed (${String(error)})`);
		}
		if (response.status === 401 && token !== null) {
			throw new PerplexityError("perplexity session expired; re-login in omp", 401);
		}
		if (response.status === 401 || response.status === 403) {
			throw new PerplexityError(
				"perplexity rejected the request (quota wall). Run `/login perplexity` inside omp or set LEARN_PERPLEXITY_TOKEN.",
				response.status,
			);
		}
		if (!response.ok) {
			throw new PerplexityError(`perplexity: HTTP ${response.status}`, response.status);
		}
		const state = parseSse(await response.text());
		const answer = extractAnswer(state);
		const sources = extractSources(state);
		if (anonymous && sources.length === 0) {
			throw new PerplexityError(
				"perplexity anonymous quota reached: no sources returned. Run `/login perplexity` inside omp or set LEARN_PERPLEXITY_TOKEN.",
			);
		}
		return { answer, sources };
	} catch (error) {
		// Mid-stream drop or abort: no status attached, so the outer retry can run.
		if (error instanceof PerplexityError) throw error;
		throw new PerplexityError(`perplexity: stream failed (${String(error)})`);
	} finally {
		clearTimeout(timer);
	}
}

function headers(token: string | null, uuid: string): Record<string, string> {
	const base: Record<string, string> = {
		"Content-Type": "application/json",
		Accept: "text/event-stream",
		Origin: "https://www.perplexity.ai",
		Referer: "https://www.perplexity.ai",
		"X-Request-ID": uuid,
	};
	if (token !== null) {
		base["User-Agent"] = APP_UA;
		base.Cookie = `__Secure-next-auth.session-token=${token}`;
		base["X-App-ApiClient"] = "default";
		base["X-App-ApiVersion"] = "2.18";
		base["X-Perplexity-Reason"] = "submit";
	} else {
		base["User-Agent"] = BROWSER_UA;
	}
	return base;
}

function body(query: string, uuid: string, anonymous: boolean): Record<string, unknown> {
	const params: Record<string, unknown> = {
		query_str: query,
		search_focus: "internet",
		mode: "copilot",
		model_preference: "experimental",
		sources: ["web"],
		attachments: [],
		frontend_uuid: uuid,
		frontend_context_uuid: uuid,
		version: "2.18",
		language: "en-US",
		timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
		search_recency_filter: null,
		is_incognito: true,
		use_schematized_api: true,
		skip_search_enabled: false,
		always_search_override: true,
		prompt_source: "user",
		source: "default",
		local_search_enabled: false,
		should_ask_for_mcp_tool_confirmation: false,
		supports_tool_approval_modal: false,
		force_enable_browser_agent: false,
		is_local_browser_available: false,
		is_local_browser_allowed: false,
	};
	if (anonymous) params.send_back_text_in_streaming_api = true;
	return { query_str: query, params };
}

// ─── SSE snapshot merge ─────────────────────────────────────────────────────

/** `unknown` → readable record, or undefined for non-objects. Single cast point. */
function asRecord(value: unknown): Snapshot | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	return value as Snapshot;
}

/**
 * Each `data: ` line is a full JSON snapshot of the answer so far. Merge them:
 * top-level fields replace, `blocks` merge by `intended_usage` (markdown
 * chunks splice in at `chunk_starting_offset ?? 0`), `sources_list` sticks
 * once set. Stops at `final: true` / `status: "COMPLETED"`.
 */
export function parseSse(text: string): Snapshot {
	let state: Snapshot = {};
	for (const line of text.split("\n")) {
		if (!line.startsWith("data:")) continue;
		const payload = line.slice(5).trim();
		if (payload.length === 0 || payload === "[DONE]") continue;
		let event: unknown;
		try {
			event = JSON.parse(payload);
		} catch {
			continue;
		}
		const snapshot = asRecord(event);
		if (snapshot === undefined) continue;
		const errorCode = snapshot.error_code;
		if (typeof errorCode === "string" && errorCode.length > 0) {
			throw new PerplexityError(`perplexity error: ${errorCode}`);
		}
		state = mergeSnapshot(state, snapshot);
		if (state.final === true || state.status === "COMPLETED") break;
	}
	return state;
}

function mergeSnapshot(state: Snapshot, incoming: Snapshot): Snapshot {
	const merged: Snapshot = { ...state };
	for (const [key, value] of Object.entries(incoming)) {
		if (key === "blocks" && Array.isArray(value) && Array.isArray(state.blocks)) {
			merged.blocks = mergeBlocks(state.blocks as Snapshot[], value as Snapshot[]);
		} else if (value !== undefined && value !== null) {
			merged[key] = value;
		}
	}
	return merged;
}

function markdownBlockOf(block: Snapshot): Snapshot | undefined {
	return asRecord(block.markdown_block);
}

function mergeBlocks(existing: Snapshot[], incoming: Snapshot[]): Snapshot[] {
	const merged = existing.slice();
	for (const block of incoming) {
		const usage = block.intended_usage;
		const index =
			typeof usage === "string"
				? merged.findIndex((candidate) => candidate.intended_usage === usage)
				: -1;
		if (index === -1) {
			merged.push(block);
			continue;
		}
		const prev = merged[index];
		const block2: Snapshot = { ...prev, ...block };
		const prevMarkdown = markdownBlockOf(prev);
		const nextMarkdown = markdownBlockOf(block);
		if (prevMarkdown !== undefined && nextMarkdown !== undefined) {
			const prevChunks = Array.isArray(prevMarkdown.chunks) ? prevMarkdown.chunks.slice() : [];
			const nextChunks = Array.isArray(nextMarkdown.chunks) ? nextMarkdown.chunks : [];
			const offset =
				typeof nextMarkdown.chunk_starting_offset === "number" ? nextMarkdown.chunk_starting_offset : 0;
			prevChunks.splice(Math.max(0, offset), nextChunks.length, ...nextChunks);
			block2.markdown_block = { ...prevMarkdown, ...nextMarkdown, chunks: prevChunks };
		}
		merged[index] = block2;
	}
	return merged;
}

function extractAnswer(state: Snapshot): string {
	const blocks = Array.isArray(state.blocks) ? (state.blocks as Snapshot[]) : [];
	for (const block of blocks) {
		const usage = block.intended_usage;
		if (typeof usage !== "string" || !(usage.includes("markdown") || usage.includes("ask_text"))) continue;
		const markdown = markdownBlockOf(block);
		const chunks = markdown !== undefined && Array.isArray(markdown.chunks) ? markdown.chunks : [];
		if (chunks.length > 0) {
			return chunks.map((chunk) => (typeof chunk === "string" ? chunk : "")).join("");
		}
	}
	for (const key of ["answer", "text"] as const) {
		const value = state[key];
		if (typeof value === "string" && value.length > 0) return value;
	}
	return "";
}

function extractSources(state: Snapshot): PerplexitySource[] {
	const blocks = Array.isArray(state.blocks) ? (state.blocks as Snapshot[]) : [];
	const seen = new Set<string>();
	const sources: PerplexitySource[] = [];
	const push = (candidate: PerplexitySource): void => {
		if (candidate.url.length === 0 || seen.has(candidate.url)) return;
		seen.add(candidate.url);
		sources.push(candidate);
	};
	for (const block of blocks) {
		if (block.intended_usage !== "web_results") continue;
		const webResultBlock = asRecord(block.web_result_block);
		const webResults = webResultBlock !== undefined ? webResultBlock.web_results : undefined;
		if (!Array.isArray(webResults)) continue;
		for (const item of webResults) {
			const record = asRecord(item);
			if (record === undefined || typeof record.url !== "string") continue;
			push({
				title: typeof record.name === "string" ? record.name : record.url,
				url: record.url,
				snippet: typeof record.snippet === "string" ? record.snippet : undefined,
				date: typeof record.timestamp === "string" ? record.timestamp : undefined,
			});
		}
	}
	if (Array.isArray(state.sources_list)) {
		for (const item of state.sources_list) {
			const record = asRecord(item);
			if (record === undefined || typeof record.url !== "string") continue;
			push({
				title: typeof record.title === "string" ? record.title : record.url,
				url: record.url,
				snippet: typeof record.snippet === "string" ? record.snippet : undefined,
				date: typeof record.date === "string" ? record.date : undefined,
			});
		}
	}
	return sources;
}

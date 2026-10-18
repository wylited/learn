/**
 * WebTools: `web_search` (Perplexity-backed, cited) and `web_fetch` (plain
 * GET, HTML stripped to text). Both cache to ~/.pi/agent/learn-web-cache with
 * a 24 h TTL and are safe to rerun after a crash.
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import { perplexitySearch } from "../lib/perplexity.ts";
import { EXT, TOOL } from "../shared.ts";

const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_BYTES = 2 * 1024 * 1024;
const MAX_CHARS = 40_000;
const TIMEOUT_MS = 30_000;

let cacheDir: string | null = null;

function cachePath(key: string): string {
	if (cacheDir === null) {
		cacheDir = join(homedir(), ".pi", "agent", "learn-web-cache");
		mkdirSync(cacheDir, { recursive: true });
	}
	return join(cacheDir, `${createHash("sha256").update(key).digest("hex")}.json`);
}

function cacheGet(key: string): string | null {
	try {
		const entry = JSON.parse(readFileSync(cachePath(key), "utf8")) as { ts?: unknown; result?: unknown };
		if (
			typeof entry.ts === "number" &&
			Date.now() - entry.ts < CACHE_TTL_MS &&
			typeof entry.result === "string"
		) {
			return entry.result;
		}
	} catch {
		// Missing or corrupt cache entry: treat as a miss.
	}
	return null;
}

function cacheSet(key: string, result: string): void {
	try {
		writeFileSync(cachePath(key), JSON.stringify({ ts: Date.now(), result }));
	} catch {
		// Cache write failures never fail the tool.
	}
}

function textResult(text: string, isError = false) {
	return isError
		? ({ output: [{ type: "text", text }], isError: true } as const)
		: ({ output: [{ type: "text", text }] } as const);
}

const webSearch = defineTool({
	name: TOOL.webSearch,
	description:
		"Search the web. Returns a concise, cited answer synthesized from live sources, followed by the source list. Use for current facts, versions, docs, anything you are unsure about.",
	parameters: Type.Object({
		query: Type.String({ description: "The search query" }),
	}),
	replay: "safe",
	async execute(args) {
		const cacheKey = `search:${args.query}`;
		const cached = cacheGet(cacheKey);
		if (cached !== null) return textResult(cached);
		try {
			const { answer, sources } = await perplexitySearch(args.query, { timeoutMs: TIMEOUT_MS });
			const lines = sources.map((source) => `- [${source.title}](${source.url})`);
			const sourceBlock = lines.length > 0 ? `\n\nSources:\n${lines.join("\n")}` : "\n\nSources: none";
			const text = answer.trim() + sourceBlock;
			cacheSet(cacheKey, text);
			return textResult(text);
		} catch (error) {
			return textResult(error instanceof Error ? error.message : String(error), true);
		}
	},
});

/** Read a response body as text, stopping at MAX_BYTES. */
async function readCapped(response: Response): Promise<{ text: string; bytes: number; truncated: boolean }> {
	const reader = response.body?.getReader();
	if (reader === undefined) {
		const text = await response.text();
		return { text, bytes: text.length, truncated: text.length > MAX_BYTES };
	}
	const decoder = new TextDecoder();
	let text = "";
	let bytes = 0;
	let truncated = false;
	for (;;) {
		const { done, value } = await reader.read();
		if (done === true) break;
		bytes += value.byteLength;
		text += decoder.decode(value, { stream: true });
		if (bytes >= MAX_BYTES) {
			truncated = true;
			await reader.cancel();
			break;
		}
	}
	return { text, bytes, truncated };
}

/** Strip an HTML document down to readable plain text. */
function htmlToText(html: string): string {
	return (
		html
			.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
			.replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
			.replace(/<!--[\s\S]*?-->/g, " ")
			.replace(/<\/(p|div|li|h[1-6]|tr|section|article|blockquote|pre)>/gi, "\n")
			.replace(/<br\s*\/?>/gi, "\n")
			.replace(/<[^>]+>/g, " ")
			.replace(/&nbsp;/gi, " ")
			.replace(/&amp;/gi, "&")
			.replace(/&lt;/gi, "<")
			.replace(/&gt;/gi, ">")
			.replace(/&quot;/gi, '"')
			.replace(/&#0?39;/g, "'")
			.replace(/[ \t]+/g, " ")
			.replace(/\n[ \t]+/g, "\n")
			.replace(/\n{3,}/g, "\n\n")
			.trim()
			.slice(0, MAX_CHARS)
	);
}

const webFetch = defineTool({
	name: TOOL.webFetch,
	description:
		"Fetch a URL and return its content as plain text (HTML stripped to text, capped at ~40k chars). Use to read a page a web_search source pointed at.",
	parameters: Type.Object({
		url: Type.String({ description: "Absolute http(s) URL to fetch" }),
	}),
	replay: "safe",
	async execute(args) {
		const noCache = /[?&]nocache(=|&|$|\?)/.test(args.url);
		const cacheKey = `fetch:${args.url}`;
		if (!noCache) {
			const cached = cacheGet(cacheKey);
			if (cached !== null) return textResult(cached);
		}
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
		try {
			const response = await fetch(args.url, { signal: controller.signal, redirect: "follow" });
			if (!response.ok) return textResult(`fetch failed: HTTP ${response.status} for ${args.url}`, true);
			const contentType = response.headers.get("content-type") ?? "";
			const { text, bytes, truncated } = await readCapped(response);
			const capNote = truncated ? `\n[truncated at ${MAX_BYTES} bytes]` : "";
			if (contentType.includes("html")) {
				const page = htmlToText(text);
				if (page.length === 0) return textResult(`empty or unreadable HTML page: ${args.url}`, true);
				const out = `${page}\n[url: ${args.url}]${capNote}`;
				if (!noCache) cacheSet(cacheKey, out);
				return textResult(out);
			}
			if (/^text\/|json|xml/i.test(contentType) || contentType === "") {
				const out = text.slice(0, MAX_CHARS) + (text.length > MAX_CHARS ? "\n[truncated]" : "") + capNote;
				if (!noCache) cacheSet(cacheKey, out);
				return textResult(out);
			}
			return textResult(`${args.url}: binary content (${contentType}, ${bytes} bytes) — not fetched as text`, true);
		} catch (error) {
			// undici hides the real reason (DNS, TLS, reset) in `cause`; surface it.
			const cause = error instanceof Error && error.cause instanceof Error ? ` (${error.cause.message})` : "";
			const message = error instanceof Error ? error.message + cause : String(error);
			return textResult(`fetch failed: ${message} (${args.url})`, true);
		} finally {
			clearTimeout(timer);
		}
	},
});

export const WebTools = defineExtension({
	name: EXT.web,
	tools: [webSearch, webFetch],
});

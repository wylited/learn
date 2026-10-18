/**
 * Repo content access: the app lives in `app/` inside the learn repo and reads
 * the shared `skills/` and `agents/` markdown files. Reads are cached in-module.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { ModelRef } from "@earendil-works/pi-durable";

export type AgentSpec = {
	name: string;
	model: ModelRef | null; // null → inherit the parent conversation's model
	thinking: string | null;
	system: string; // file body with frontmatter stripped
};

let cachedRoot: string | null = null;
const fileCache = new Map<string, string>();
const agentCache = new Map<string, AgentSpec | null>();

export function repoRoot(): string {
	if (cachedRoot !== null) return cachedRoot;
	cachedRoot = process.env.LEARN_REPO_ROOT ?? resolve(import.meta.dirname, "..");
	return cachedRoot;
}

/** Read a repo file once; null when missing. */
export function loadFile(relPath: string): string | null {
	const cached = fileCache.get(relPath);
	if (cached !== undefined) return cached;
	try {
		const text = readFileSync(resolve(repoRoot(), relPath), "utf8");
		fileCache.set(relPath, text);
		return text;
	} catch {
		fileCache.set(relPath, "");
		return null;
	}
}

/** Body of a skill file (e.g. "skills/teach/SKILL.md"), frontmatter stripped. */
export function loadSkill(relPath: string): string {
	return stripFrontmatter(loadFile(relPath) ?? "");
}

/** Parse `agents/<name>.md` into `{ model, thinking, system }`. Null when absent. */
export function loadAgentSpec(name: string): AgentSpec | null {
	if (agentCache.has(name)) return agentCache.get(name) ?? null;
	const text = loadFile(`agents/${name}.md`);
	if (text === null) {
		agentCache.set(name, null);
		return null;
	}
	const fm = frontmatter(text);
	const spec: AgentSpec = {
		name,
		model: parseModelPin(fm.model),
		thinking: fm.thinking ?? null,
		system: stripFrontmatter(text).trim(),
	};
	agentCache.set(name, spec);
	return spec;
}

/** Strip leading YAML frontmatter (--- … ---) from a markdown file. */
function stripFrontmatter(text: string): string {
	if (!text.startsWith("---")) return text;
	const end = text.indexOf("\n---", 3);
	if (end === -1) return text;
	const after = text.indexOf("\n", end + 4);
	return after === -1 ? "" : text.slice(after + 1).replace(/^\n+/, "");
}


function frontmatter(text: string): Record<string, string> {
	const out: Record<string, string> = {};
	if (!text.startsWith("---")) return out;
	const end = text.indexOf("\n---", 3);
	if (end === -1) return out;
	for (const line of text.slice(4, end).split("\n")) {
		const idx = line.indexOf(":");
		if (idx > 0) out[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
	}
	return out;
}

/** "openrouter/z-ai/glm-5.3" → { provider: "openrouter", modelId: "z-ai/glm-5.3" }. */
function parseModelPin(value: string | undefined): ModelRef | null {
	if (!value) return null;
	const slash = value.indexOf("/");
	if (slash <= 0 || slash === value.length - 1) return null;
	return { provider: value.slice(0, slash), modelId: value.slice(slash + 1) };
}

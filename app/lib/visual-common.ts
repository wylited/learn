/**
 * Shared helpers for the typst/mermaid authoring loops (typst-tools.ts,
 * mermaid-tools.ts): a subprocess runner, a per-conversation staging dir
 * under the OS temp dir, an exact-match editor (pi-edit semantics), and
 * publishing a chosen render into <cwd>/viz with a unique filename.
 *
 * Ported from extensions/visual-tools/tools/_common.ts (legacy pi extension).
 * Only the PUBLISHED files ever land inside the vault (viz/); previews stay
 * in the staging dir so crash recovery reruns are pure idempotent rewrites.
 */

import { execFile } from "node:child_process"
import { createHash } from "node:crypto"
import { copyFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"

// rsvg-convert lives under MacPorts (/opt/local/bin); magick/gs under
// /usr/local/bin; Homebrew under /opt/homebrew/bin; typst under ~/.cargo/bin.
// Augment PATH so a thin inherited PATH still resolves them.
export const EXTRA_PATH = [
	"/opt/local/bin",
	"/usr/local/bin",
	"/opt/homebrew/bin",
	join(homedir(), ".cargo", "bin"),
]

export const FILES_DIRNAME = "viz"

// Pinned typst diagram engines — the ONLY @preview packages write_typst
// accepts (see agents/typst-maker.md routing table).
export const TYPST_PINS: Readonly<Record<string, string>> = {
	fletcher: "0.5.8",
	cetz: "0.5.2",
	lilaq: "0.6.0",
	zap: "0.6.0",
	curryst: "0.6.0",
}

export function pinsList(): string {
	return Object.entries(TYPST_PINS)
		.map(([pkg, ver]) => `@preview/${pkg}:${ver}`)
		.join(", ")
}

/** Resolve the typst binary: TYPST_BIN, then ~/.cargo/bin/typst, then PATH. */
export function resolveTypstBin(): string {
	if (process.env.TYPST_BIN && existsSync(process.env.TYPST_BIN)) return process.env.TYPST_BIN
	const cargo = join(homedir(), ".cargo", "bin", "typst")
	if (existsSync(cargo)) return cargo
	return "typst"
}

export interface RunResult {
	ok: boolean
	exit: number | null
	stdout: string
	stderr: string
	timedOut: boolean
}

export function run(
	cmd: string,
	args: string[],
	opts: { cwd?: string; timeoutMs?: number; env?: Record<string, string> } = {},
): Promise<RunResult> {
	const augmentedPath = [...EXTRA_PATH, process.env.PATH ?? ""].join(":")
	const { promise, resolve: resolveRun } = Promise.withResolvers<RunResult>()
	execFile(
		cmd,
		args,
		{
			cwd: opts.cwd,
			timeout: opts.timeoutMs ?? 120_000,
			maxBuffer: 32 * 1024 * 1024,
			windowsHide: true,
			env: { ...process.env, ...(opts.env ?? {}), PATH: augmentedPath },
		},
		(err, stdout, stderr) => {
			const e = err as (NodeJS.ErrnoException & { killed?: boolean }) | null
			const exit = e ? (typeof e.code === "number" ? e.code : null) : 0
			resolveRun({
				ok: !e,
				exit,
				stdout: stdout?.toString() ?? "",
				stderr: stderr?.toString() ?? "",
				timedOut: Boolean(e?.killed),
			})
		},
	)
	return promise
}

export interface Session {
	workDir: string
	bodyPath: string
}

/**
 * Per-conversation staging dir under the OS temp dir, keyed by
 * sha1(conversationId) — survives in-memory state, so a crash-recovered
 * rerun finds the same source file. Created lazily.
 */
export function stagingDir(conversationId: string | number): string {
	// ConversationId is numeric in the harness; hash inputs must be strings.
	const hash = createHash("sha1").update(String(conversationId)).digest("hex")
	const dir = join(tmpdir(), `pi-learn-${hash}`)
	mkdirSync(dir, { recursive: true })
	return dir
}

/** Write the full source to the session's managed file, creating the work dir. */
export function writeBody(conversationId: string, bodyFileName: string, source: string): Session {
	const workDir = stagingDir(conversationId)
	const bodyPath = join(workDir, bodyFileName)
	writeFileSync(bodyPath, source, "utf8")
	return { workDir, bodyPath }
}

/**
 * Exact-match single replacement on the current source, matching pi's built-in
 * edit: old_text must appear exactly once. Returns the updated content and the
 * match offset, or throws a precise error.
 */
export function applyEdit(current: string, oldText: string, newText: string): { updated: string; index: number } {
	if (oldText === "") throw new Error("`old_text` must be non-empty.")
	if (oldText === newText) throw new Error("`old_text` and `new_text` are identical.")
	const first = current.indexOf(oldText)
	if (first === -1) {
		throw new Error("`old_text` not found in the current source — match it exactly.")
	}
	const second = current.indexOf(oldText, first + 1)
	if (second !== -1) {
		let n = 0
		let i = current.indexOf(oldText)
		while (i !== -1) {
			n++
			i = current.indexOf(oldText, i + oldText.length)
		}
		throw new Error(`\`old_text\` appears ${n} times — add surrounding context to make it unique.`)
	}
	const updated = current.slice(0, first) + newText + current.slice(first + oldText.length)
	return { updated, index: first }
}

/** A small numbered window of `content` around char offset `index`. */
export function snippetAround(content: string, index: number, contextLines = 3): string {
	const before = content.slice(0, index)
	const hitLine = before.split("\n").length - 1
	const lines = content.split("\n")
	const start = Math.max(0, hitLine - contextLines)
	const end = Math.min(lines.length - 1, hitLine + contextLines)
	const width = String(end + 1).length
	const out: string[] = []
	for (let i = start; i <= end; i++) out.push(`${String(i + 1).padStart(width)}  ${lines[i]}`)
	return out.join("\n")
}

/**
 * Copy a rendered file into <cwd>/viz with a unique, slugified name:
 * viz-<slug>-<timestamp>.<ext>. Pass the same `ts` to publish a matched
 * pair (e.g. the .png and .svg of one typst render).
 */
export function publish(
	srcPath: string,
	slug: string,
	ext: string,
	ts = Date.now(),
): { filename: string; path: string } {
	const filesDir = join(process.cwd(), FILES_DIRNAME)
	mkdirSync(filesDir, { recursive: true })
	const clean =
		slug
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/^-+|-+$/g, "") || "viz"
	const filename = `viz-${clean}-${ts}.${ext}`
	const dest = join(filesDir, filename)
	copyFileSync(srcPath, dest)
	return { filename, path: dest }
}

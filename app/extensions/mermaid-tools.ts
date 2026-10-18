/**
 * Mermaid authoring loop for the mermaid-maker subagent — three tools that
 * share one conversation-scoped source file in a staging dir under the OS
 * temp dir:
 *
 *   write_mermaid   — write the full Mermaid source to the session's file
 *   edit_mermaid    — exact-match old_text→new_text on that file (pi-edit semantics)
 *   render_mermaid  — render to PNG, returned inline; with `save_as`, also
 *                     publish it into <cwd>/viz
 *
 * Ported from extensions/visual-tools/tools/mermaid_tools.ts (legacy pi
 * extension) onto pi-durable defineTool/defineExtension; behavior unchanged.
 * Rendering shells out to the app-bundled @mermaid-js/mermaid-cli (`mmdc`)
 * with a puppeteer config pointing at puppeteer's own Chromium download, or
 * a system Chrome. Without any browser, render_mermaid degrades to a clear
 * error naming the typst-maker (fletcher) as the substitute.
 */

import { defineExtension, defineTool } from "@earendil-works/pi-durable"
import { Type } from "@earendil-works/pi-ai"
import { createRequire } from "node:module"
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { EXT, TOOL } from "../shared.ts"
import { applyEdit, publish, run, snippetAround, stagingDir, writeBody } from "../lib/visual-common.ts"

const MMDC_BIN = join(dirname(fileURLToPath(import.meta.url)), "..", "node_modules", ".bin", "mmdc")
const GROUP_FILE = "diagram.mmd"
const RENDER_TIMEOUT_MS = 120_000

const CHROME_CANDIDATES = [
	"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
	"/Applications/Chromium.app/Contents/MacOS/Chromium",
	"/run/current-system/sw/bin/chromium", // nixos
]

/** mmdc failure texts that mean "no browser available", not "bad diagram". */
const BROWSER_MISSING_RE =
	/could not (find|download) chrome|failed to launch the browser|browserType\.launch|executable doesn'?t exist|no usable sandbox|couldn'?t find puppeteer/i

/**
 * Prefer puppeteer's own Chromium (bundled with @mermaid-js/mermaid-cli),
 * then a system Chrome. puppeteer is a transitive dependency that may be
 * absent from a pruned install, so it is resolved lazily — a static import
 * would both fail such installs at load time and slow app startup.
 */
async function findChrome(): Promise<string | undefined> {
	try {
		const req = createRequire(import.meta.url)
		const puppeteer = req("puppeteer") as { executablePath(): Promise<string> }
		const exe = await puppeteer.executablePath()
		if (typeof exe === "string" && existsSync(exe)) return exe
	} catch {
		// no bundled chromium — fall through to system candidates
	}
	for (const c of CHROME_CANDIDATES) if (existsSync(c)) return c
	return undefined
}

const UNAVAILABLE_TEXT =
	"Mermaid rendering is UNAVAILABLE on this machine — mmdc found no Chrome/Chromium to render with.\n" +
	'Tell the caller to use the typst-maker instead (`subagent(agent="typst-maker", ...)` — fletcher handles node/flow diagrams), or give up on the visual.'

const writeMermaid = defineTool({
	name: TOOL.writeMermaid,
	description:
		"Write the FULL Mermaid source to this session's managed file (your first " +
		"draft or a complete rewrite). You do NOT name the file — edit_mermaid and " +
		"render_mermaid act on the same one.\n\n" +
		"`source` is a complete Mermaid diagram, e.g. a `graph TD` / `graph LR` " +
		"flow, `sequenceDiagram`, `stateDiagram-v2`, `erDiagram`, `classDiagram`, " +
		"`mindmap`, or `timeline`. Writing does NOT render — call render_mermaid " +
		"when ready. For a small fix, prefer edit_mermaid over rewriting.",
	parameters: Type.Object({
		source: Type.String({
			description: "The complete Mermaid diagram source (starts with the diagram type, e.g. `graph TD`).",
		}),
	}),
	replay: "safe",
	async execute(args, api) {
		const source = (args.source ?? "").trim()
		if (!source) throw new Error("`write_mermaid` requires a non-empty `source`.")
		const { bodyPath } = writeBody(api.conversationId, GROUP_FILE, source + "\n")
		const lines = source.split("\n").length
		return {
			output: [
				{
					type: "text" as const,
					text: `Wrote ${lines}-line Mermaid source.\nCall render_mermaid to render it, or edit_mermaid to tweak it.`,
				},
			],
			details: { ok: true, path: bodyPath, lines },
		}
	},
})

const editMermaid = defineTool({
	name: TOOL.editMermaid,
	description:
		"Make a single exact-match replacement in this session's Mermaid source — " +
		"the same contract as pi's built-in edit, locked to the one managed file. " +
		"`old_text` must appear EXACTLY ONCE (include surrounding context for " +
		"uniqueness); on 0 or >1 matches the call fails and nothing changes. Call " +
		"write_mermaid first. Editing does NOT render.",
	parameters: Type.Object({
		old_text: Type.String({ description: "Exact substring of the current source to replace (must match once)." }),
		new_text: Type.String({ description: "Replacement text for `old_text`." }),
	}),
	replay: "safe",
	async execute(args, api) {
		const bodyPath = join(stagingDir(api.conversationId), GROUP_FILE)
		if (!existsSync(bodyPath)) {
			throw new Error("edit_mermaid: no source yet — call write_mermaid first.")
		}
		const current = readFileSync(bodyPath, "utf8")
		const { updated, index } = applyEdit(current, String(args.old_text ?? ""), String(args.new_text ?? ""))
		writeFileSync(bodyPath, updated, "utf8")
		return {
			output: [
				{
					type: "text" as const,
					text: "Applied edit. Updated region:\n```\n" + snippetAround(updated, index) + "\n```\nCall render_mermaid to see it.",
				},
			],
			details: { ok: true, path: bodyPath },
		}
	},
})

const renderMermaid = defineTool({
	name: TOOL.renderMermaid,
	description:
		"Render the CURRENT session Mermaid source to a PNG and return it inline so " +
		"you can SEE the diagram and iterate. You do NOT pass the source here — it " +
		"comes from the managed file; call write_mermaid first.\n\n" +
		"Iterate freely with no `save_as` (preview only). When the diagram is " +
		"correct and clean, call once more with `save_as` set to a short kebab-case " +
		"topic slug: that publishes the PNG into <cwd>/viz with a unique " +
		"filename and returns the filename to embed. On a render error this returns " +
		"the error text instead of an image — fix with edit_mermaid and re-render.",
	parameters: Type.Object({
		save_as: Type.Optional(
			Type.String({
				description:
					"Short kebab-case topic slug (e.g. 'internet-packets'). When set, the " +
					"rendered PNG is published to <cwd>/viz as viz-<slug>-<timestamp>.png " +
					"and the filename is returned. Omit for a preview-only render.",
			}),
		),
	}),
	replay: "safe",
	async execute(args, api) {
		const workDir = stagingDir(api.conversationId)
		const bodyPath = join(workDir, GROUP_FILE)
		if (!existsSync(bodyPath)) {
			throw new Error("render_mermaid: no source yet — call write_mermaid first.")
		}

		const chrome = await findChrome()
		const cfgPath = join(workDir, "puppeteer.json")
		writeFileSync(
			cfgPath,
			JSON.stringify(chrome ? { executablePath: chrome, args: ["--no-sandbox"] } : { args: ["--no-sandbox"] }),
			"utf8",
		)

		const outPath = join(workDir, `render-${Date.now()}.png`)
		const res = await run(MMDC_BIN, ["-i", bodyPath, "-o", outPath, "-p", cfgPath, "-s", "2", "-b", "white"], {
			cwd: workDir,
			timeoutMs: RENDER_TIMEOUT_MS,
		})

		if (res.ok && existsSync(outPath)) {
			const data = readFileSync(outPath).toString("base64")
			const image = { type: "image" as const, data, mimeType: "image/png" }

			if (args.save_as) {
				const { filename, path } = publish(outPath, String(args.save_as), "png")
				return {
					output: [
						{
							type: "text" as const,
							text: `Published to viz/.\nfilename: ${filename}\npath: ${path}\n\nLOOK at the diagram below to confirm it is correct before returning it.`,
						},
						image,
					],
					details: { ok: true, path, filename },
				}
			}

			return {
				output: [
					{
						type: "text" as const,
						text: "Preview render (not yet saved). LOOK: are arrows/relationships correct, labels right, nothing cramped? Fix with edit_mermaid, or re-render with `save_as` to publish.",
					},
					image,
				],
				details: { ok: true, path: outPath },
			}
		}

		const detail = (res.stderr || res.stdout || "unknown error").trim()
		const text = res.timedOut
			? `mmdc timed out after ${RENDER_TIMEOUT_MS / 1000}s (slow browser launch or very large diagram) — call render_mermaid once more; if it times out again, report failure and suggest the typst-maker.`
			: BROWSER_MISSING_RE.test(detail)
				? UNAVAILABLE_TEXT
				: `Mermaid render FAILED — no image produced. Fix the source with edit_mermaid and call render_mermaid again.\n\nError:\n${detail.slice(-2000)}`
		return {
			output: [{ type: "text" as const, text }],
			details: { ok: false, path: bodyPath },
		}
	},
})

export const MermaidTools = defineExtension({
	name: EXT.mermaid,
	tools: [writeMermaid, editMermaid, renderMermaid],
})

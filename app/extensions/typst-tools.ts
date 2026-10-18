/**
 * Typst authoring loop for the typst-maker subagent — three tools that share
 * one conversation-scoped source file in a staging dir under the OS temp dir:
 *
 *   write_typst   — write the full Typst source (pinned engine import required)
 *   edit_typst    — exact-match old_text→new_text on that file (pi-edit semantics)
 *   render_typst  — compile PNG (inline, for inspection) + SVG; with `save_as`,
 *                   publish both into <cwd>/viz
 *
 * Ported from the legacy mermaid trio (extensions/visual-tools/tools/
 * mermaid_tools.ts) onto pi-durable defineTool/defineExtension. All state
 * lives on disk keyed by conversation id, so a crash-recovered rerun
 * (replay: "safe") is a pure idempotent recompile.
 */

import { defineExtension, defineTool } from "@earendil-works/pi-durable"
import { Type } from "@earendil-works/pi-ai"
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { EXT, TOOL } from "../shared.ts"
import {
	applyEdit,
	pinsList,
	publish,
	resolveTypstBin,
	run,
	snippetAround,
	stagingDir,
	writeBody,
	TYPST_PINS,
} from "../lib/visual-common.ts"

const GROUP_FILE = "diagram.typ"
const COMPILE_TIMEOUT_MS = 60_000

/** Every `@preview/<pkg>:<ver>` in the source must be exactly one pinned engine. */
function validatePins(source: string): void {
	const matches = [...source.matchAll(/@preview\/([a-zA-Z0-9_-]+):([^\s"')]+)/g)]
	if (matches.length === 0) {
		throw new Error(
			`No \`@preview\` engine import found. Import exactly ONE pinned engine:\n${pinsList()}\n` +
				"(node graphs → fletcher, geometry → cetz, plots → lilaq, circuits → zap, proof trees → curryst).",
		)
	}
	const firstPkg = matches[0][1]
	if (matches.some((m) => m[1] !== firstPkg)) {
		throw new Error(
			`Exactly ONE engine import is allowed; found ${matches.map((m) => `@preview/${m[1]}`).join(", ")}.`,
		)
	}
	for (const [, pkg, ver] of matches) {
		if (TYPST_PINS[pkg] !== ver) {
			throw new Error(
				`\`@preview/${pkg}:${ver}\` is not a pinned version. The pinned set is:\n${pinsList()}`,
			)
		}
	}
}

/**
 * One typst compile into the staging dir. A multi-page document refuses a
 * plain output name, so on failure retry with the `{p}` page template and
 * keep page 1. Returns the produced file path, or the trimmed error text.
 */
async function compileTypst(
	bin: string,
	workDir: string,
	outBase: string,
	format: "png" | "svg",
	extraArgs: string[] = [],
): Promise<{ path?: string; error?: string }> {
	const compile = async (outName: string) =>
		await run(
			bin,
			["compile", "--diagnostic-format", "short", "--format", format, ...extraArgs, GROUP_FILE, outName],
			{ cwd: workDir, timeoutMs: COMPILE_TIMEOUT_MS },
		)

	const plain = join(workDir, `${outBase}.${format}`)
	const first = await compile(`${outBase}.${format}`)
	if (first.ok && existsSync(plain)) return { path: plain }

	const page1 = join(workDir, `${outBase}-1.${format}`)
	const retry = await compile(`${outBase}-{p}.${format}`)
	if (retry.ok && existsSync(page1)) return { path: page1 }

	const failed = !first.ok ? first : retry
	const detail = (failed.stderr || failed.stdout || "unknown error").trim()
	return { error: (failed.timedOut ? "typst timed out.\n\n" : "") + detail.slice(0, 2000) }
}

const writeTypst = defineTool({
	name: TOOL.writeTypst,
	description:
		"Write the FULL standalone Typst source to this conversation's managed file " +
		"(your first draft or a complete rewrite). You do NOT name the file — edit_typst " +
		"and render_typst act on the same one.\n\n" +
		"`source` must be complete Typst with an auto-sized page (`set page(width: auto, " +
		"height: auto, margin: 14pt)`) and exactly ONE pinned engine import " +
		"(@preview/fletcher:0.5.8, cetz:0.5.2, lilaq:0.6.0, zap:0.6.0, or curryst:0.6.0). " +
		"Writing does NOT render — call render_typst when ready. For a small fix, prefer " +
		"edit_typst over rewriting.",
	parameters: Type.Object({
		source: Type.String({
			description: "The complete standalone Typst document (auto-sized page + one pinned engine import).",
		}),
	}),
	replay: "safe",
	async execute(args, api) {
		const source = (args.source ?? "").trim()
		if (!source) throw new Error("`write_typst` requires a non-empty `source`.")
		validatePins(source)
		const { bodyPath } = writeBody(api.conversationId, GROUP_FILE, source + "\n")
		const lines = source.split("\n").length
		return {
			output: [
				{
					type: "text" as const,
					text: `Wrote ${lines}-line Typst source.\nCall render_typst to compile and see it, or edit_typst to tweak it.`,
				},
			],
			details: { ok: true, path: bodyPath, lines },
		}
	},
})

const editTypst = defineTool({
	name: TOOL.editTypst,
	description:
		"Make a single exact-match replacement in this conversation's Typst source — " +
		"the same contract as pi's built-in edit, locked to the one managed file. " +
		"`old_text` must appear EXACTLY ONCE (include surrounding context for " +
		"uniqueness); on 0 or >1 matches the call fails and nothing changes. Call " +
		"write_typst first. Editing does NOT render.",
	parameters: Type.Object({
		old_text: Type.String({ description: "Exact substring of the current source to replace (must match once)." }),
		new_text: Type.String({ description: "Replacement text for `old_text`." }),
	}),
	replay: "safe",
	async execute(args, api) {
		const bodyPath = join(stagingDir(api.conversationId), GROUP_FILE)
		if (!existsSync(bodyPath)) {
			throw new Error("edit_typst: no source yet — call write_typst first.")
		}
		const current = readFileSync(bodyPath, "utf8")
		const { updated, index } = applyEdit(current, String(args.old_text ?? ""), String(args.new_text ?? ""))
		writeFileSync(bodyPath, updated, "utf8")
		return {
			output: [
				{
					type: "text" as const,
					text: "Applied edit. Updated region:\n```\n" + snippetAround(updated, index) + "\n```\nCall render_typst to see it.",
				},
			],
			details: { ok: true, path: bodyPath },
		}
	},
})

const renderTypst = defineTool({
	name: TOOL.renderTypst,
	description:
		"Compile the CURRENT session Typst source to PNG and SVG and get the PNG " +
		"back inline so you can SEE the diagram and iterate. You do NOT pass the " +
		"source here — it comes from the managed file; call write_typst first.\n\n" +
		"Iterate freely with no `save_as` (preview only). When the diagram is " +
		"correct and clean, call once more with `save_as` set to a short kebab-case " +
		"topic slug: that publishes viz-<slug>-<timestamp>.png AND .svg into " +
		"<cwd>/viz and returns the filename to embed. On a compile error this " +
		"returns the error text instead of an image — fix with edit_typst and re-render.",
	parameters: Type.Object({
		save_as: Type.Optional(
			Type.String({
				description:
					"Short kebab-case topic slug (e.g. 'half-adder'). When set, the render is " +
					"published to <cwd>/viz as viz-<slug>-<timestamp>.png + .svg and the " +
					"PNG filename is returned. Omit for a preview-only render.",
			}),
		),
	}),
	replay: "safe",
	async execute(args, api) {
		const workDir = stagingDir(api.conversationId)
		const bodyPath = join(workDir, GROUP_FILE)
		if (!existsSync(bodyPath)) {
			throw new Error("render_typst: no source yet — call write_typst first.")
		}
		const bin = resolveTypstBin()

		// Independent outputs — compile both formats concurrently so the render
		// loop's wall time is max(png, svg), not their sum.
		const [png, svg] = await Promise.all([
			compileTypst(bin, workDir, "preview", "png", ["--ppi", "144"]),
			compileTypst(bin, workDir, "diagram", "svg"),
		])
		if (!png.path) {
			return {
				output: [
					{
						type: "text" as const,
						text: `Typst compile FAILED — no image produced. Fix the source with edit_typst (or rewrite with write_typst) and call render_typst again.\n\nError:\n${png.error ?? "unknown error"}`,
					},
				],
				details: { ok: false, path: bodyPath },
			}
		}
		if (!svg.path) {
			return {
				output: [
					{
						type: "text" as const,
						text: `Typst SVG compile FAILED (PNG succeeded). Fix the source with edit_typst and call render_typst again.\n\nError:\n${svg.error ?? "unknown error"}`,
					},
				],
				details: { ok: false, path: bodyPath },
			}
		}

		const data = readFileSync(png.path).toString("base64")
		const image = { type: "image" as const, data, mimeType: "image/png" }

		if (args.save_as) {
			const slug = String(args.save_as)
			const ts = Date.now()
			const pngPub = publish(png.path, slug, "png", ts)
			const svgPub = publish(svg.path, slug, "svg", ts)
			return {
				output: [
					{
						type: "text" as const,
						text:
							`Published to viz/.\nfilename: ${pngPub.filename}\npath: ${pngPub.path}\nsvg: ${svgPub.path}\n\n` +
							"LOOK at the diagram below to confirm it is correct before returning it.",
					},
					image,
				],
				details: {
					ok: true,
					path: pngPub.path,
					filename: pngPub.filename,
					pngPath: pngPub.path,
					svgPath: svgPub.path,
				},
			}
		}

		return {
			output: [
				{
					type: "text" as const,
					text: "Preview render (not yet saved). LOOK: are labels clear of lines, nothing clipped or cramped, geometry true to the brief? Fix with edit_typst, or re-render with `save_as` to publish.",
				},
				image,
			],
			details: { ok: true, path: png.path, pngPath: png.path, svgPath: svg.path },
		}
	},
})

export const TypstTools = defineExtension({
	name: EXT.typst,
	tools: [writeTypst, editTypst, renderTypst],
})

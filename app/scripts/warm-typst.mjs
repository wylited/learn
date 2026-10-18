#!/usr/bin/env node
/**
 * Pre-cache the pinned typst diagram packages (see lib/visual-common.ts
 * TYPST_PINS) by compiling a tiny diagram with each — typst downloads any
 * missing @preview package into its cache on first use. Run once after
 * install: `npm run warm`. Already-cached pins are skipped.
 */

import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import { TYPST_PINS, pinsList, resolveTypstBin, run } from "../lib/visual-common.ts"

const SETUP = "#set page(width: auto, height: auto, margin: 10pt)\n"

const v = (pkg) => `@preview/${pkg}:${TYPST_PINS[pkg]}`

// Minimal-but-real use of each engine (not just a bare import) so a broken
// pin surfaces here, during setup, not mid-lesson.
const SOURCES = {
	fletcher: `#import "${v("fletcher")}" as fletcher: diagram, node, edge
${SETUP}#diagram(
	node-stroke: 0.7pt, node-inset: 5pt, edge-stroke: 0.7pt, label-sep: 5pt,
	node((0, 0), [Start]),
	edge("->"),
	node((1, 0), [End]),
)`,
	cetz: `#import "${v("cetz")}"
${SETUP}#cetz.canvas(length: 1cm, {
	import cetz.draw
	draw.line((0, 0), (2, 1))
})`,
	lilaq: `#import "${v("lilaq")}" as lq
${SETUP}#show: lq.layout
#lq.plot((0, 1), (0, 1))`,
	zap: `#import "${v("zap")}"
${SETUP}#zap.circuit({
	import zap: *
	node("B", (0, 0))
	resistor("r1", "B", (rel: (0, 4)))
})`,
	curryst: `#import "${v("curryst")}": rule, prooftree
${SETUP}#prooftree(
	rule([$B$], [$A$], name: [$arrow.r$]),
)`,
}

const cacheRoot = process.env.XDG_CACHE_HOME
	? join(process.env.XDG_CACHE_HOME, "typst")
	: process.platform === "darwin"
		? join(homedir(), "Library", "Caches", "typst")
		: join(homedir(), ".cache", "typst")

const bin = resolveTypstBin()
const failures = []

// WARM_FORCE=1 re-compiles even when the pin is already cached (snippet validation).
const force = process.env.WARM_FORCE === "1"

for (const pkg of Object.keys(TYPST_PINS)) {
	const ver = TYPST_PINS[pkg]
	const cached = join(cacheRoot, "packages", "preview", pkg, ver)
	if (!force && existsSync(cached)) {
		console.log(`${pkg}:${ver}  already cached`)
		continue
	}

	const dir = mkdtempSync(join(tmpdir(), `warm-${pkg}-`))
	const src = join(dir, "warm.typ")
	const out = join(dir, "warm.svg")
	writeFileSync(src, SOURCES[pkg], "utf8")

	const t0 = Date.now()
	let res = await run(bin, ["compile", "--diagnostic-format", "short", "--format", "svg", src, out], {
		cwd: dir,
		timeoutMs: 180_000,
	})
	let used = "snippet"

	if (!res.ok || !existsSync(out)) {
		// The cache is still populated by a bare import (package downloads and
		// evaluates even if the minimal-use snippet is off); report the drift.
		const bare = join(dir, "bare.typ")
		writeFileSync(bare, `#import "${v(pkg)}"\n`, "utf8")
		const bareOut = join(dir, "bare.svg")
		const res2 = await run(bin, ["compile", "--diagnostic-format", "short", "--format", "svg", bare, bareOut], {
			cwd: dir,
			timeoutMs: 180_000,
		})
		if (res2.ok && existsSync(bareOut)) {
			console.log(`${pkg}:${ver}  cached via bare import (snippet FAILED — check the warm source):\n${(res.stderr || res.stdout).trim().slice(0, 600)}`)
		} else {
			failures.push(pkg)
			console.log(`${pkg}:${ver}  FAILED:\n${(res2.stderr || res2.stdout || res.stderr).trim().slice(0, 800)}`)
		}
		used = res2.ok ? "bare" : "error"
	} else {
		console.log(`${pkg}:${ver}  cached (${used}, ${Date.now() - t0} ms)`)
	}

	rmSync(dir, { recursive: true, force: true })
}

console.log(`\ncache: ${join(cacheRoot, "packages", "preview")}`)
if (failures.length > 0) {
	console.error(`warm-typst: failed for ${failures.join(", ")} — pinned set: ${pinsList()}`)
	process.exit(1)
}

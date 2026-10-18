/**
 * sessions — one directory per session under
 * ~/.pi/agent/learn-sessions/<sha256(cwd).slice(0,24)>/<ts13>-<uuid>/session.sqlite,
 * guarded by a proper-lockfile lock that a crashed process leaves stale after
 * 10 s. Ported from pi's experimental/vacation/sessions.ts.
 */

import { createHash, randomUUID } from "node:crypto";
import { mkdir, readdir, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import lockfile from "proper-lockfile";

/** One session directory holding `session.sqlite`, locked by this process. */
export interface SessionLocation {
	id: string;
	directory: string;
	database: string;
	cwd: string;
	created: boolean;
	release(): Promise<void>;
}

const SESSION_NAME = /^\d{13}-[0-9a-f-]{36}$/u;

/** The per-cwd session root of `cwd` (realpath'd), created on demand. */
export async function sessionsRoot(cwdInput: string): Promise<{ cwd: string; root: string }> {
	const cwd = await realpath(resolve(cwdInput));
	const root = join(
		homedir(),
		".pi",
		"agent",
		"learn-sessions",
		createHash("sha256").update(cwd).digest("hex").slice(0, 24),
	);
	await mkdir(root, { recursive: true });
	return { cwd, root };
}

/** Session directory names under `root`, newest first (names sort by creation time). */
export async function listSessions(cwd: string): Promise<{ cwd: string; root: string; sessions: string[] }> {
	const { cwd: real, root } = await sessionsRoot(cwd);
	const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
	const sessions = entries
		.filter((entry) => entry.isDirectory() && SESSION_NAME.test(entry.name))
		.map((entry) => entry.name)
		.sort()
		.reverse();
	return { cwd: real, root, sessions };
}

/** The newest session directory for `cwd`, or undefined. */
export async function latestSession(cwd: string): Promise<string | undefined> {
	return (await listSessions(cwd)).sessions[0];
}

async function lock(directory: string): Promise<() => Promise<void>> {
	try {
		// A lock left by a crashed process goes stale after 10 s; wait that long before giving up.
		return await lockfile.lock(directory, {
			realpath: false,
			retries: { retries: 12, minTimeout: 1000, maxTimeout: 1000 },
		});
	} catch (error) {
		throw new Error(`Session is already open in another process: ${directory}`, { cause: error });
	}
}

/** A new session for `cwd`. */
export async function createSession(cwd: string): Promise<SessionLocation> {
	const { cwd: real, root } = await sessionsRoot(cwd);
	const directory = join(root, `${String(Date.now()).padStart(13, "0")}-${randomUUID()}`);
	await mkdir(directory);
	const release = await lock(directory);
	return { id: basename(directory), directory, database: join(directory, "session.sqlite"), cwd: real, created: true, release };
}

/** The newest existing session for `cwd`; throws when there is none. */
export async function resumeSession(cwd: string): Promise<SessionLocation> {
	const newest = await latestSession(cwd);
	if (newest === undefined) throw new Error(`No learn session exists for ${await realpath(resolve(cwd))}`);
	const { cwd: real, root } = await sessionsRoot(cwd);
	const directory = join(root, newest);
	const release = await lock(directory);
	return { id: basename(directory), directory, database: join(directory, "session.sqlite"), cwd: real, created: false, release };
}

/** A new session for `cwd`, or its newest one with `continueSession`. */
export async function selectSession(cwd: string, continueSession: boolean): Promise<SessionLocation> {
	return continueSession ? await resumeSession(cwd) : await createSession(cwd);
}

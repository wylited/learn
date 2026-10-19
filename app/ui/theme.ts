/**
 * App color theme — role-based palettes for dark and light terminals.
 *
 * Detection: LEARN_THEME=light|dark wins; otherwise the terminal's reported
 * background (OSC 11 via pi-tui's queryTerminalColors) decides by luminance;
 * no reply → dark. Live switches arrive via TUI scheme notifications
 * (kitty's CSI ?2031) — see runTui.
 *
 * Palettes use 256-color indices so they survive SSH and non-truecolor
 * terminals. The light palette swaps the dark palette's bright ANSI colors
 * (yellow-on-white is unreadable) for darker shades of the same hue.
 */
import { foregroundAnsi, indexedColor, styleTextWithAnsi } from "@earendil-works/pi-tui";
import type { RgbColor } from "@earendil-works/pi-tui";

export type ThemeRole = "accent" | "success" | "error" | "warning" | "muted" | "dim" | "text";
export type ThemeScheme = "dark" | "light";

const DARK: Record<Exclude<ThemeRole, "text">, number> = {
	accent: 39, // cyan
	success: 2, // green
	error: 1, // red
	warning: 3, // yellow
	muted: 245, // light gray
	dim: 243, // gray
};

const LIGHT: Record<Exclude<ThemeRole, "text">, number> = {
	accent: 25, // deep blue
	success: 22, // dark green
	error: 124, // dark red
	warning: 94, // dark amber — bright yellow is invisible on white
	muted: 241, // mid gray
	dim: 243, // gray
};

let scheme: ThemeScheme = "dark";

export function setThemeScheme(next: ThemeScheme): void {
	scheme = next;
}

export function getThemeScheme(): ThemeScheme {
	return scheme;
}

export const theme = {
	fg(role: ThemeRole, text: string): string {
		if (role === "text") return text;
		const index = (scheme === "light" ? LIGHT : DARK)[role];
		return styleTextWithAnsi(text, foregroundAnsi(indexedColor(index), "256color"), undefined, {});
	},
};

/** Relative luminance (Rec.709, sRGB-linearized) → dark|light. */
export function schemeFromBackground(background: RgbColor | undefined): ThemeScheme {
	if (background === undefined) return "dark";
	const linear = (channel: number): number => {
		const s = channel / 255;
		return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
	};
	const luminance = 0.2126 * linear(background.r) + 0.7152 * linear(background.g) + 0.0722 * linear(background.b);
	return luminance > 0.5 ? "light" : "dark";
}

/** LEARN_THEME env override, else null (auto-detect). */
export function themeEnvOverride(env: NodeJS.ProcessEnv): ThemeScheme | null {
	const value = env.LEARN_THEME?.trim().toLowerCase();
	if (value === "light" || value === "dark") return value;
	if (value !== undefined && value !== "" && value !== "auto") {
		console.error(`LEARN_THEME: unknown value "${value}" (use light, dark, or auto)`);
	}
	return null;
}

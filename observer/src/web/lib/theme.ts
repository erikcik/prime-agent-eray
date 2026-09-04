import { Store } from "../state/store.ts";

export type ThemePref = "light" | "dark" | "system";

const KEY = "prime-observer.theme";
const THEME_COLOR: Record<"light" | "dark", string> = { light: "#ffffff", dark: "#0f0f0f" };

function readPref(): ThemePref {
	try {
		const v = localStorage.getItem(KEY);
		return v === "light" || v === "dark" ? v : "system";
	} catch {
		return "system";
	}
}

export const themeStore = new Store<ThemePref>(readPref());

function systemDark(): boolean {
	return typeof matchMedia === "function" && matchMedia("(prefers-color-scheme: dark)").matches;
}

export function resolvedTheme(pref: ThemePref = themeStore.get()): "light" | "dark" {
	if (pref === "system") return systemDark() ? "dark" : "light";
	return pref;
}

function apply(pref: ThemePref): void {
	const root = document.documentElement;
	if (pref === "system") delete root.dataset.theme;
	else root.dataset.theme = pref;
	const meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]:not([media])');
	if (meta) meta.content = THEME_COLOR[resolvedTheme(pref)];
}

export function setTheme(pref: ThemePref): void {
	themeStore.set(pref);
	try {
		if (pref === "system") localStorage.removeItem(KEY);
		else localStorage.setItem(KEY, pref);
	} catch {
		// storage unavailable; the choice still applies for this page
	}
	apply(pref);
}

/** Apply the stored preference before first render and track OS changes while on "system". */
export function initTheme(): void {
	apply(themeStore.get());
	if (typeof matchMedia !== "function") return;
	matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
		if (themeStore.get() === "system") apply("system");
	});
}

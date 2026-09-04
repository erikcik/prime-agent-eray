import { Monitor, Moon, Sun } from "lucide-react";
import { type ThemePref, setTheme, themeStore } from "../lib/theme.ts";
import { useStore } from "../state/store.ts";

const OPTIONS: Array<[ThemePref, typeof Sun, string]> = [
	["light", Sun, "Light"],
	["system", Monitor, "Match system"],
	["dark", Moon, "Dark"],
];

export function ThemeToggle() {
	const pref = useStore(themeStore);
	return (
		<div className="seg seg--icons" role="radiogroup" aria-label="Color theme">
			{OPTIONS.map(([value, Icon, label]) => (
				<button key={value} type="button" role="radio" aria-checked={pref === value} aria-label={label} title={label} className={pref === value ? "is-active" : ""} onClick={() => setTheme(value)}>
					<Icon size={12} />
				</button>
			))}
		</div>
	);
}

export function shortId(id: string | undefined, n = 8): string {
	if (!id) return "—";
	return id.length > n ? id.slice(0, n) : id;
}

export function timeAgo(iso: string | undefined, now = Date.now()): string {
	if (!iso) return "—";
	const t = new Date(iso).getTime();
	if (Number.isNaN(t)) return "—";
	const s = Math.max(0, Math.round((now - t) / 1000));
	if (s < 45) return `${s}s ago`;
	const m = Math.round(s / 60);
	if (m < 60) return `${m}m ago`;
	const h = Math.round(m / 60);
	if (h < 48) return `${h}h ago`;
	const d = Math.round(h / 24);
	return `${d}d ago`;
}

export function clock(iso: string | number | undefined): string {
	if (iso === undefined) return "—";
	const d = new Date(iso);
	if (Number.isNaN(d.getTime())) return "—";
	return d.toLocaleTimeString(undefined, { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

export function dateTime(iso: string | number | undefined): string {
	if (iso === undefined) return "—";
	const d = new Date(iso);
	if (Number.isNaN(d.getTime())) return "—";
	return `${d.toISOString().slice(0, 10)} ${clock(iso)}`;
}

export function tokens(n: number | undefined): string {
	if (n === undefined || Number.isNaN(n)) return "—";
	if (n < 1000) return String(n);
	if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
	return `${(n / 1_000_000).toFixed(2)}M`;
}

export function usd(n: number | undefined): string {
	if (n === undefined || Number.isNaN(n)) return "—";
	if (n === 0) return "$0";
	if (n < 0.01) return `$${n.toFixed(4)}`;
	return `$${n.toFixed(2)}`;
}

export function duration(ms: number | undefined): string {
	if (ms === undefined) return "—";
	const s = Math.round(ms / 1000);
	if (s < 60) return `${s}s`;
	const m = Math.floor(s / 60);
	return `${m}m ${s % 60}s`;
}

export function basename(path: string | undefined): string {
	if (!path) return "";
	return path.split("/").filter(Boolean).pop() ?? path;
}

export function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content
			.map((p) => (p && typeof p === "object" && (p as { type?: string }).type === "text" ? String((p as { text?: unknown }).text ?? "") : ""))
			.join("");
	}
	return "";
}

export function modelShort(model: string | undefined): string {
	if (!model) return "—";
	const idx = model.indexOf("/");
	return idx === -1 ? model : model.slice(idx + 1);
}

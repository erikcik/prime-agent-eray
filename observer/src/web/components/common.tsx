import { Copy } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import type { AgentStatus } from "../../shared/fleet.ts";
import { shortId, timeAgo } from "../lib/format.ts";

export function Eyebrow({ children, ink }: { children: ReactNode; ink?: boolean }) {
	return <div className={`eyebrow${ink ? " eyebrow--ink" : ""}`}>{children}</div>;
}

export function StatusDot({ status }: { status: AgentStatus | string }) {
	return <span className={`dot dot--${status}`} title={status} />;
}

export function StatusPill({ status, label }: { status: AgentStatus | string; label?: string }) {
	const live = status === "running" || status === "needs_input" || status === "queued" || status === "recovering";
	const fail = status === "failed";
	return (
		<span className={`pill ${live ? "pill--live" : fail ? "pill--fail" : status === "idle" ? "" : "pill--ghost"}`}>
			<StatusDot status={status} />
			{(label ?? status).replace("_", " ")}
		</span>
	);
}

export function MonoId({ id, n = 8, copy = true }: { id: string | undefined; n?: number; copy?: boolean }) {
	const [copied, setCopied] = useState(false);
	if (!id) return <span className="mono muted">—</span>;
	return (
		<span
			className="mono monoid"
			title={id}
			onClick={
				copy
					? (e) => {
							e.stopPropagation();
							void navigator.clipboard?.writeText(id).then(() => {
								setCopied(true);
								setTimeout(() => setCopied(false), 900);
							});
						}
					: undefined
			}
		>
			{shortId(id, n)}
			{copy && <Copy size={10} className="monoid__icon" />}
			{copied && <span className="monoid__copied">copied</span>}
		</span>
	);
}

export function TimeAgo({ iso }: { iso: string | undefined }) {
	const [, tick] = useState(0);
	useEffect(() => {
		const t = setInterval(() => tick((n) => n + 1), 15_000);
		return () => clearInterval(t);
	}, []);
	return (
		<span className="mono muted" title={iso}>
			{timeAgo(iso)}
		</span>
	);
}

export function EmptyState({ title, children }: { title: string; children?: ReactNode }) {
	return (
		<div className="empty">
			<strong>{title}</strong>
			{children}
		</div>
	);
}

export function Card({ title, actions, children, className, faint }: { title?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string; faint?: boolean }) {
	return (
		<section className={`card${faint ? " card--faint" : ""}${className ? ` ${className}` : ""}`}>
			{(title || actions) && (
				<header className="card__head">
					<div className="row grow">{typeof title === "string" ? <Eyebrow ink>{title}</Eyebrow> : title}</div>
					{actions && <div className="row">{actions}</div>}
				</header>
			)}
			<div className="card__body">{children}</div>
		</section>
	);
}

export function ConfirmDialog({ title, body, confirmLabel = "Confirm", danger, onConfirm, onCancel }: { title: string; body: ReactNode; confirmLabel?: string; danger?: boolean; onConfirm: () => void; onCancel: () => void }) {
	return (
		<div className="modal" onClick={onCancel} role="presentation">
			<div className="modal__card" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
				<Eyebrow ink>{title}</Eyebrow>
				<div className="modal__body">{body}</div>
				<div className="row" style={{ justifyContent: "flex-end" }}>
					<button type="button" className="btn" onClick={onCancel}>
						Cancel
					</button>
					<button type="button" className={`btn ${danger ? "btn--accent" : "btn--primary"}`} onClick={onConfirm}>
						{confirmLabel}
					</button>
				</div>
			</div>
		</div>
	);
}

export function ErrorLine({ error }: { error: unknown }) {
	if (!error) return null;
	const msg = error instanceof Error ? error.message : String(error);
	return <div className="banner">{msg}</div>;
}

export function KV({ k, v, mono }: { k: string; v: ReactNode; mono?: boolean }) {
	return (
		<div className="kv">
			<span className="eyebrow">{k}</span>
			<span className={mono ? "mono small" : "small"}>{v ?? "—"}</span>
		</div>
	);
}

export function Json({ value }: { value: unknown }) {
	return <pre className="codeblock">{JSON.stringify(value, null, 2)}</pre>;
}

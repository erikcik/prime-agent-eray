import { useCallback, useEffect, useRef, useState } from "react";
import type { RewindPoint } from "../../shared/api.ts";
import { ApiError, api } from "../lib/api.ts";
import { clock } from "../lib/format.ts";
import { Eyebrow, ErrorLine } from "./common.tsx";

type Step = { kind: "pick" } | { kind: "how"; point: RewindPoint } | { kind: "busy"; point: RewindPoint; summarize: boolean };

const HOW_OPTIONS = [
	{ summarize: false, title: "Restore conversation", detail: "Go back to just before this message. The turns after it are kept as an abandoned branch." },
	{ summarize: true, title: "Restore and summarize what was abandoned", detail: "Same, plus the model writes a short note about the abandoned turns so the agent remembers them." },
] as const;

/**
 * Claude Code's rewind, for the web: Esc Esc (or the Rewind button) lists every user message on
 * the current branch; arrows move, Enter picks, Esc backs out. Picking one asks how to restore,
 * then moves the session there and offers the message text back into the composer.
 */
export function RewindDialog({ id, live, onClose, onDone }: { id: string; live: boolean; onClose: () => void; onDone: (result: { editorText?: string; summarized: boolean }) => void }) {
	const [points, setPoints] = useState<RewindPoint[]>();
	const [activeSessionId, setActiveSessionId] = useState<string>();
	const [selected, setSelected] = useState(0);
	const [how, setHow] = useState(0);
	const [step, setStep] = useState<Step>({ kind: "pick" });
	const [error, setError] = useState<unknown>();
	const [status, setStatus] = useState<string>();
	const listRef = useRef<HTMLDivElement>(null);

	useEffect(() => {
		let cancelled = false;
		(async () => {
			try {
				let liveId: string | undefined;
				if (!live) {
					setStatus("Session is idle — resuming it first…");
					liveId = (await api.resumeSession(id)).activeSessionId;
				}
				const res = await api.rewindPoints(id, liveId);
				if (cancelled) return;
				setActiveSessionId(res.activeSessionId);
				setPoints(res.points);
				setSelected(Math.max(0, res.points.length - 1));
				setStatus(undefined);
			} catch (e) {
				if (!cancelled) setError(e);
			}
		})();
		return () => {
			cancelled = true;
		};
	}, [id, live]);

	const run = useCallback(
		async (point: RewindPoint, summarize: boolean) => {
			setStep({ kind: "busy", point, summarize });
			setError(undefined);
			try {
				const res = await api.rewind(id, { entryId: point.entryId, summarize, activeSessionId });
				if (res.cancelled) {
					setError(new Error(res.aborted ? "Summarization was cancelled." : "The harness declined to navigate."));
					setStep({ kind: "how", point });
					return;
				}
				onDone({ editorText: res.editorText, summarized: res.summarized });
			} catch (e) {
				setError(e instanceof ApiError ? e : e);
				setStep({ kind: "how", point });
			}
		},
		[id, activeSessionId, onDone],
	);

	useEffect(() => {
		function onKey(e: KeyboardEvent) {
			if (step.kind === "busy") {
				if (e.key === "Escape") e.preventDefault();
				return;
			}
			const n = step.kind === "pick" ? (points?.length ?? 0) : HOW_OPTIONS.length;
			const move = (delta: number) => {
				e.preventDefault();
				if (n === 0) return;
				if (step.kind === "pick") setSelected((i) => (i + delta + n) % n);
				else setHow((i) => (i + delta + n) % n);
			};
			switch (e.key) {
				case "ArrowUp":
				case "k":
					move(-1);
					break;
				case "ArrowDown":
				case "j":
					move(1);
					break;
				case "Home":
					e.preventDefault();
					if (step.kind === "pick") setSelected(0);
					else setHow(0);
					break;
				case "End":
					e.preventDefault();
					if (step.kind === "pick") setSelected(Math.max(0, n - 1));
					else setHow(Math.max(0, n - 1));
					break;
				case "Enter":
					e.preventDefault();
					if (step.kind === "pick") {
						const p = points?.[selected];
						if (p) {
							setHow(0);
							setStep({ kind: "how", point: p });
						}
					} else {
						void run(step.point, HOW_OPTIONS[how]?.summarize ?? false);
					}
					break;
				case "Escape":
					e.preventDefault();
					e.stopPropagation();
					if (step.kind === "how") setStep({ kind: "pick" });
					else onClose();
					break;
				default:
					break;
			}
		}
		window.addEventListener("keydown", onKey, true);
		return () => window.removeEventListener("keydown", onKey, true);
	}, [step, points, selected, how, run, onClose]);

	useEffect(() => {
		listRef.current?.querySelector<HTMLElement>(".is-selected")?.scrollIntoView({ block: "nearest", behavior: "smooth" });
	}, [selected, step.kind]);

	return (
		<div className="modal" onClick={step.kind === "busy" ? undefined : onClose} role="presentation">
			<div className="modal__card rewind" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-label="Rewind">
				<div className="row">
					<Eyebrow ink>{step.kind === "pick" ? "Rewind to a message" : "How should it be restored?"}</Eyebrow>
					<span className="grow" />
					<span className="tiny muted">
						<span className="kbd">↑</span> <span className="kbd">↓</span> move · <span className="kbd">↵</span> select · <span className="kbd">esc</span> {step.kind === "how" ? "back" : "close"}
					</span>
				</div>
				<ErrorLine error={error} />
				{status && <div className="banner banner--info">{status}</div>}

				{step.kind === "pick" && points && points.length === 0 && (
					<div className="empty">
						<strong>Nothing to rewind to</strong>This branch has no user messages yet.
					</div>
				)}

				{step.kind === "pick" && points && points.length > 0 && (
					<div className="rewind__list" ref={listRef} role="listbox" aria-activedescendant={`rewind-${selected}`}>
						{points.map((p, i) => (
							<div key={p.entryId} id={`rewind-${i}`} role="option" aria-selected={i === selected} className={`rewind__item${i === selected ? " is-selected" : ""}`} onMouseEnter={() => setSelected(i)} onClick={() => setStep({ kind: "how", point: p })}>
								<span className="rewind__n mono">{i + 1}</span>
								<span className="rewind__text">{p.text}</span>
								<span className="rewind__time mono">{p.label ? `${p.label} · ` : ""}{p.timestamp ? clock(p.timestamp) : ""}</span>
							</div>
						))}
					</div>
				)}

				{(step.kind === "how" || step.kind === "busy") && (
					<>
						<div className="rewind__target">
							<span className="rewind__n mono">{step.point.index + 1}</span>
							<span className="rewind__text">{step.point.text}</span>
						</div>
						<div className="rewind__list" role="listbox">
							{HOW_OPTIONS.map((o, i) => (
								<div key={o.title} role="option" aria-selected={i === how} className={`rewind__item rewind__item--how${i === how ? " is-selected" : ""}`} onMouseEnter={() => step.kind === "how" && setHow(i)} onClick={() => step.kind === "how" && void run(step.point, o.summarize)}>
									<span className="rewind__n mono">{i + 1}</span>
									<span className="col" style={{ gap: 2 }}>
										<span>{o.title}</span>
										<span className="tiny muted">{o.detail}</span>
									</span>
								</div>
							))}
						</div>
						{step.kind === "busy" && <div className="banner banner--info">{step.summarize ? "Summarizing the abandoned branch, then rewinding… this is a model call and can take a minute." : "Rewinding…"}</div>}
					</>
				)}

				<div className="row" style={{ justifyContent: "flex-end" }}>
					{step.kind === "how" && (
						<button type="button" className="btn" onClick={() => setStep({ kind: "pick" })}>
							Back
						</button>
					)}
					<button type="button" className="btn" disabled={step.kind === "busy"} onClick={onClose}>
						{step.kind === "busy" ? "Working…" : "Cancel"}
					</button>
					{step.kind === "pick" && points && points.length > 0 && (
						<button type="button" className="btn btn--primary" onClick={() => setStep({ kind: "how", point: points[selected] ?? points[0]! })}>
							Choose
						</button>
					)}
					{step.kind === "how" && (
						<button type="button" className="btn btn--primary" onClick={() => void run(step.point, HOW_OPTIONS[how]?.summarize ?? false)}>
							{HOW_OPTIONS[how]?.title ?? "Restore"}
						</button>
					)}
				</div>
			</div>
		</div>
	);
}

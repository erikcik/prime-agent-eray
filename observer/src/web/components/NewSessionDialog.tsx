import { useEffect, useMemo, useState } from "react";
import type { ModelsResponse } from "../../shared/api.ts";
import { api } from "../lib/api.ts";
import { fleetStore } from "../state/app-state.ts";
import { useStore } from "../state/store.ts";
import { Eyebrow } from "./common.tsx";

const THINKING = ["", "off", "minimal", "low", "medium", "high", "xhigh", "max"];

export function NewSessionDialog({ onClose, onCreated }: { onClose: () => void; onCreated: (activeSessionId: string) => void }) {
	const fleet = useStore(fleetStore);
	const recentCwds = useMemo(() => {
		const set = new Set<string>();
		const walk = (l: typeof fleet extends undefined ? never : NonNullable<typeof fleet>["roots"]) => {
			for (const n of l) {
				if (n.cwd) set.add(n.cwd);
				walk(n.children);
			}
		};
		if (fleet) walk(fleet.roots);
		return [...set].slice(0, 12);
	}, [fleet]);
	const [cwd, setCwd] = useState(recentCwds[0] ?? "");
	const [models, setModels] = useState<ModelsResponse["models"]>([]);
	const [model, setModel] = useState("");
	const [thinking, setThinking] = useState("");
	const [name, setName] = useState("");
	const [goal, setGoal] = useState("");
	const [prompt, setPrompt] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | undefined>();

	useEffect(() => {
		void api
			.models()
			.then((r) => {
				setModels(r.models);
				if (!model && r.models[0]) setModel(`${r.models[0].provider}/${r.models[0].id}`);
			})
			.catch(() => undefined);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);

	async function submit(e: React.FormEvent) {
		e.preventDefault();
		setBusy(true);
		setError(undefined);
		try {
			const [provider, ...rest] = model.split("/");
			const id = rest.join("/");
			const res = await api.createSession({
				cwd: cwd.trim(),
				provider: provider || undefined,
				model: id || undefined,
				thinking: thinking || undefined,
				name: name.trim() || undefined,
				goal: goal.trim() || undefined,
				prompt: prompt.trim() || undefined,
			});
			onCreated(res.activeSessionId);
			onClose();
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setBusy(false);
		}
	}

	return (
		<div className="modal" onClick={onClose} role="presentation">
			<form className="modal__card" onClick={(e) => e.stopPropagation()} onSubmit={submit}>
				<Eyebrow ink>new session</Eyebrow>
				<div className="form-grid">
					<label className="field span2">
						<span>working directory</span>
						<input className="input input--mono" list="cwds" value={cwd} onChange={(e) => setCwd(e.target.value)} placeholder="/workspace/project" required />
						<datalist id="cwds">
							{recentCwds.map((c) => (
								<option key={c} value={c} />
							))}
						</datalist>
					</label>
					<label className="field">
						<span>model</span>
						<input className="input input--mono" list="models" value={model} onChange={(e) => setModel(e.target.value)} placeholder="provider/model-id" />
						<datalist id="models">
							{models.map((m) => (
								<option key={`${m.provider}/${m.id}`} value={`${m.provider}/${m.id}`}>
									{m.name ?? m.id}
								</option>
							))}
						</datalist>
					</label>
					<label className="field">
						<span>thinking</span>
						<select className="select" value={thinking} onChange={(e) => setThinking(e.target.value)}>
							{THINKING.map((t) => (
								<option key={t} value={t}>
									{t || "default"}
								</option>
							))}
						</select>
					</label>
					<label className="field">
						<span>name (optional)</span>
						<input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="release-notes" />
					</label>
					<label className="field">
						<span>persistent goal (optional)</span>
						<input className="input" value={goal} onChange={(e) => setGoal(e.target.value)} placeholder="Keep working until tests pass" />
					</label>
					<label className="field span2">
						<span>first prompt (optional)</span>
						<textarea className="textarea" value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder="What should the agent do first?" />
					</label>
				</div>
				{error && <div className="banner">{error}</div>}
				<div className="row" style={{ justifyContent: "flex-end" }}>
					<button type="button" className="btn" onClick={onClose}>
						Cancel
					</button>
					<button type="submit" className="btn btn--primary" disabled={busy || !cwd.trim()}>
						{busy ? "Creating…" : "Create session"}
					</button>
				</div>
			</form>
		</div>
	);
}

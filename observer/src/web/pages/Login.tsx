import { useState } from "react";
import { api } from "../lib/api.ts";
import { setToken } from "../lib/auth.ts";
import { ThemeToggle } from "../components/ThemeToggle.tsx";

export function LoginPage({ onAuthed }: { onAuthed: () => void }) {
	const [token, setTokenInput] = useState("");
	const [remember, setRemember] = useState(true);
	const [error, setError] = useState<string | undefined>();
	const [busy, setBusy] = useState(false);

	async function submit(e: React.FormEvent) {
		e.preventDefault();
		setBusy(true);
		setError(undefined);
		try {
			const health = await api.health(token.trim());
			await api.fleet(token.trim());
			setToken(token.trim(), remember);
			onAuthed();
			void health;
		} catch (err) {
			setError(err instanceof Error && err.message !== "unauthorized" ? err.message : "That token was not accepted.");
		} finally {
			setBusy(false);
		}
	}

	return (
		<div className="login">
			<form className="login__card" onSubmit={submit}>
				<div className="login__brand-row">
					<div className="mono login__brand">
						prime <span className="muted">·</span> observer
					</div>
					<ThemeToggle />
				</div>
				<h1 className="login__title">Sign in</h1>
				<p className="muted small">Paste the observer token (the value of PRIME_OBSERVER_TOKEN on the host running Prime Agent).</p>
				<label className="field">
					<span>Token</span>
					<input className="input input--mono" type="password" autoFocus value={token} onChange={(e) => setTokenInput(e.target.value)} autoComplete="off" />
				</label>
				<label className="row small">
					<input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} /> Remember on this device
				</label>
				{error && <div className="banner">{error}</div>}
				<button type="submit" className="btn btn--primary" disabled={busy || token.trim().length === 0}>
					{busy ? "Checking…" : "Continue"}
				</button>
			</form>
		</div>
	);
}

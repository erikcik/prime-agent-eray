import { useEffect, useState } from "react";
import { Navigate, Route, Routes, useNavigate } from "react-router-dom";
import { TopBar } from "./components/TopBar.tsx";
import { getToken, setToken } from "./lib/auth.ts";
import { api, setUnauthorizedHandler } from "./lib/api.ts";
import { BenchPage } from "./pages/bench/Bench.tsx";
import { CommsPage } from "./pages/Comms.tsx";
import { HarnessPage } from "./pages/Harness.tsx";
import { LineagePage } from "./pages/Lineage.tsx";
import { LoginPage } from "./pages/Login.tsx";
import { OpsPage } from "./pages/Ops.tsx";
import { SchedulesPage } from "./pages/Schedules.tsx";
import { SessionPage } from "./pages/Session.tsx";
import { SignalPage } from "./pages/Signal.tsx";
import { wireGlobalState } from "./state/app-state.ts";

export function App() {
	const navigate = useNavigate();
	const [authed, setAuthed] = useState(() => !!getToken());

	useEffect(() => {
		setUnauthorizedHandler(() => {
			setAuthed(false);
			navigate("/login", { replace: true });
		});
	}, [navigate]);

	useEffect(() => {
		if (authed) wireGlobalState();
	}, [authed]);

	// Loopback dev mode: the server accepts any bearer, so skip the login screen.
	useEffect(() => {
		if (authed) return;
		void api
			.health()
			.then((h) => {
				if (!h.authRequired) {
					setToken("local-insecure", false);
					setAuthed(true);
				}
			})
			.catch(() => undefined);
	}, [authed]);

	if (!authed) {
		return (
			<Routes>
				<Route path="*" element={<LoginPage onAuthed={() => setAuthed(true)} />} />
			</Routes>
		);
	}

	return (
		<div className="shell">
			<TopBar />
			<main className="shell__main">
				<Routes>
					<Route path="/" element={<Navigate to="/signal" replace />} />
					<Route path="/login" element={<Navigate to="/signal" replace />} />
					<Route path="/signal" element={<SignalPage />} />
					<Route path="/lineage" element={<LineagePage />} />
					<Route path="/sessions/:id" element={<SessionPage />} />
					<Route path="/comms" element={<CommsPage />} />
					<Route path="/harness/*" element={<HarnessPage />} />
					<Route path="/bench/*" element={<BenchPage />} />
					<Route path="/schedules" element={<SchedulesPage />} />
					<Route path="/ops" element={<OpsPage />} />
					<Route path="*" element={<div className="empty"><strong>Nothing here</strong>Unknown route.</div>} />
				</Routes>
			</main>
		</div>
	);
}

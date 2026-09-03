import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { App } from "./app.tsx";
import "./styles/tokens.css";
import "./styles/base.css";
import "./styles/components.css";

const root = document.getElementById("root");
if (!root) throw new Error("missing #root");
createRoot(root).render(
	<StrictMode>
		<BrowserRouter>
			<App />
		</BrowserRouter>
	</StrictMode>,
);

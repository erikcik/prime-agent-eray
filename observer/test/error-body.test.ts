// Regression: the RunPod proxy answers with its own HTML page while the observer is restarting
// (exit 87 after a Redeploy). The client used that body verbatim as the error message, so the
// whole interstitial — inline SVG logo included — was painted into the composer banner.

import { describe, expect, it } from "vitest";
import { __testing } from "../src/web/lib/api.ts";

const { describeErrorBody } = __testing;

// Trimmed from a real response seen on pod 7vdq4vlyte1lpe.
const RUNPOD_INTERSTITIAL = `<!DOCTYPE html><html><head><title>Waiting for service</title></head><body>
<a><svg viewBox="0 0 1000 200"><path d="M312.19 58.01C314.28 58.01 315.98 59.68 315.98 61.75V72.54C315.98 74.59 314.3 76.27 312.21 76.28L287 76.44C276.85 76.44 274.63 78.08 274.63 90.49V145.5" fill="white"/></svg></a>
<div class="spinner-wrap"><div class="spinner"></div></div>
<h1>Waiting for service to respond</h1>
<p>The service on this port is either still initializing or not running. Check the container logs for more details.</p>
<script>var t = 10; setInterval(function () { location.reload(); }, 1000);</script>
</body></html>`;

describe("describeErrorBody", () => {
	it("summarises the RunPod restart interstitial instead of echoing it", () => {
		const msg = describeErrorBody(RUNPOD_INTERSTITIAL, 502, "Bad Gateway");
		expect(msg).toBe("The observer is restarting — the RunPod proxy answered instead. Retry in a few seconds.");
		expect(msg).not.toContain("<svg");
		expect(msg).not.toContain("path d=");
		expect(msg.length).toBeLessThan(200);
	});

	it("prefers the unreachable hint over a page title for a 5xx", () => {
		const html = `<html><head><title>Gateway Timeout</title></head><body>${"x".repeat(5000)}</body></html>`;
		const msg = describeErrorBody(html, 504, "Gateway Timeout");
		expect(msg).toBe("Observer unreachable (504). It may be restarting; retry shortly.");
		expect(msg).not.toContain("xxxxx");
	});

	it("falls back to the page title for a non-5xx HTML body, never the body", () => {
		const html = `<html><head><title>Not Found</title></head><body>${"x".repeat(5000)}</body></html>`;
		const msg = describeErrorBody(html, 404, "Not Found");
		expect(msg).toContain("Not Found");
		expect(msg.length).toBeLessThan(200);
		expect(msg).not.toContain("xxxxx");
	});

	it("reports a plain unavailability for a bodyless 5xx", () => {
		expect(describeErrorBody("<html><body>nope</body></html>", 503, "Service Unavailable")).toContain("503");
	});

	it("passes a short plain-text body through unchanged", () => {
		expect(describeErrorBody("session is not live", 409, "Conflict")).toBe("session is not live");
	});

	it("truncates a huge non-HTML body rather than returning it", () => {
		const msg = describeErrorBody("y".repeat(9000), 500, "Internal Server Error");
		expect(msg.length).toBeLessThan(200);
	});
});

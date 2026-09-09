/**
 * Auto-follow scrolling for the transcript. Native `scrollIntoView({ behavior: "smooth" })` was
 * measured to be a no-op for long distances in Chrome and to stop short for short ones, so the
 * glide is driven by hand: an eased frame loop that re-reads the page bottom every frame, which
 * also keeps it continuous while a streaming reply keeps growing the page underneath it.
 */

const DURATION_MS = 380;
/** Beyond this many viewports away (e.g. first paint of a 200-message transcript) just jump. */
const JUMP_VIEWPORTS = 3;

let frame: number | undefined;

function bottom(): number {
	const d = document.documentElement;
	return Math.max(0, d.scrollHeight - window.innerHeight);
}

function reducedMotion(): boolean {
	return typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
}

export function cancelFollow(): void {
	if (frame !== undefined) cancelAnimationFrame(frame);
	frame = undefined;
}

/** Glide the window to the bottom of the page; coalesces with an animation already in flight. */
export function followToBottom(): void {
	cancelFollow();
	const start = window.scrollY;
	const distance = bottom() - start;
	if (distance <= 0) return;
	// Animation frames pause in a background tab, so a glide there would never arrive.
	if (reducedMotion() || document.visibilityState !== "visible" || distance > window.innerHeight * JUMP_VIEWPORTS) {
		window.scrollTo(0, bottom());
		return;
	}
	const t0 = performance.now();
	const step = (now: number) => {
		if (document.visibilityState !== "visible") {
			window.scrollTo(0, bottom());
			frame = undefined;
			return;
		}
		const t = Math.min(1, (now - t0) / DURATION_MS);
		const eased = 1 - (1 - t) ** 3;
		window.scrollTo(0, start + (bottom() - start) * eased);
		frame = t < 1 ? requestAnimationFrame(step) : undefined;
	};
	frame = requestAnimationFrame(step);
}

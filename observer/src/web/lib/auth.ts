const KEY = "prime-observer.token";

let memoryToken: string | undefined;

export function getToken(): string | undefined {
	if (memoryToken) return memoryToken;
	try {
		return localStorage.getItem(KEY) ?? undefined;
	} catch {
		return undefined;
	}
}

export function setToken(token: string, remember: boolean): void {
	memoryToken = token;
	try {
		if (remember) localStorage.setItem(KEY, token);
		else localStorage.removeItem(KEY);
	} catch {
		// storage unavailable
	}
}

export function clearToken(): void {
	memoryToken = undefined;
	try {
		localStorage.removeItem(KEY);
	} catch {
		// ignore
	}
}

export function encodeWsBearer(token: string): string {
	const bytes = new TextEncoder().encode(token);
	let bin = "";
	for (const b of bytes) bin += String.fromCharCode(b);
	return `bearer.${btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")}`;
}

import { useEffect, useState } from "react";
import { getToken } from "../lib/auth.ts";

/** An <img> cannot carry the bearer token, so fetch the bytes and show them from a blob URL. */
export function AuthImage({ path, alt, onOpen }: { path: string; alt: string; onOpen?: (url: string) => void }) {
	const [url, setUrl] = useState<string>();
	const [failed, setFailed] = useState(false);
	useEffect(() => {
		let revoked = false;
		let objectUrl: string | undefined;
		const token = getToken();
		fetch(path, { headers: token ? { authorization: `Bearer ${token}` } : {} })
			.then((r) => (r.ok ? r.blob() : Promise.reject(new Error(String(r.status)))))
			.then((b) => {
				if (revoked) return;
				objectUrl = URL.createObjectURL(b);
				setUrl(objectUrl);
			})
			.catch(() => setFailed(true));
		return () => {
			revoked = true;
			if (objectUrl) URL.revokeObjectURL(objectUrl);
		};
	}, [path]);
	if (failed) return <span className="tiny muted">image unavailable</span>;
	if (!url) return <span className="tiny muted">loading…</span>;
	return <img src={url} alt={alt} onClick={() => onOpen?.(url)} />;
}

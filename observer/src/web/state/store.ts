import { useSyncExternalStore } from "react";

/** Minimal external store: a value + listeners, consumable via useSyncExternalStore. */
export class Store<T> {
	private listeners = new Set<() => void>();
	constructor(private value: T) {}
	get(): T {
		return this.value;
	}
	set(next: T | ((prev: T) => T)): void {
		const v = typeof next === "function" ? (next as (p: T) => T)(this.value) : next;
		if (v === this.value) return;
		this.value = v;
		for (const l of [...this.listeners]) l();
	}
	subscribe = (l: () => void): (() => void) => {
		this.listeners.add(l);
		return () => this.listeners.delete(l);
	};
}

export function useStore<T>(store: Store<T>): T {
	return useSyncExternalStore(store.subscribe, () => store.get(), () => store.get());
}

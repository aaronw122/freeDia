import {
	type BoundFunctions,
	type queries,
	within,
} from "@testing-library/react";
import { act } from "react";
import {
	type MemoryWindowStore,
	memoryWindowStore,
	type WindowLayout,
} from "./layout";
import type { TimedRecord } from "./mock/fixtures";
import { MockChatClient, type MockClientOptions } from "./mock/mockClient";
import { mountChatWithStore } from "./mount";

export interface Harness {
	root: ShadowRoot;
	client: MockChatClient;
	store: MemoryWindowStore;
	ui: BoundFunctions<typeof queries>;
	play(run: TimedRecord[]): Promise<void>;
	act(fn: () => unknown): Promise<void>;
	unmount(): void;
}

const mounted: Harness[] = [];

export async function renderChat(
	options: MockClientOptions & { layout?: WindowLayout } = {},
): Promise<Harness> {
	const host = document.createElement("div");
	document.body.append(host);
	const root = host.attachShadow({ mode: "open" });
	const client = new MockChatClient(options);
	const store = memoryWindowStore(options.layout ?? null);
	let unmount = () => {};
	await act(async () => {
		unmount = mountChatWithStore(root, client, store);
	});
	const container = root.querySelector(".fd-root");
	if (!(container instanceof HTMLElement)) throw new Error("not mounted");
	const harness: Harness = {
		root,
		client,
		store,
		ui: within(container),
		async play(run) {
			await act(async () => client.play(run));
		},
		async act(fn) {
			await act(async () => {
				await fn();
			});
		},
		unmount() {
			act(() => unmount());
			host.remove();
		},
	};
	mounted.push(harness);
	return harness;
}

export function cleanupChats() {
	for (const harness of mounted.splice(0)) harness.unmount();
}

type PipApi = {
	requestWindow(options?: { width?: number; height?: number }): Promise<Window>;
};

type PipEntry = {
	trigger: string;
	userActivation: boolean | null;
	result?: string;
	hostMovedToPip?: boolean;
	closedAt?: number;
	hostBackInPage?: boolean;
};

type KeyEntry = {
	key: string;
	code: string;
	meta: boolean;
	ctrl: boolean;
	shift: boolean;
};

type SpikeState = {
	world: "isolated";
	hasPipApi: boolean;
	keys: KeyEntry[];
	pip: PipEntry[];
	clicks: number;
	commandsReceived: string[];
};

const isPipApi = (value: unknown): value is PipApi =>
	typeof value === "object" &&
	value !== null &&
	"requestWindow" in value &&
	typeof value.requestWindow === "function";

const pipApi = (): PipApi | undefined => {
	if (!("documentPictureInPicture" in window)) return undefined;
	const api = window.documentPictureInPicture;
	return isPipApi(api) ? api : undefined;
};

const isCommandMessage = (
	message: unknown,
): message is { type: "command"; command: string } =>
	typeof message === "object" &&
	message !== null &&
	"type" in message &&
	message.type === "command" &&
	"command" in message &&
	typeof message.command === "string";

export default defineContentScript({
	matches: ["http://*/*", "https://*/*"],
	runAt: "document_idle",
	main() {
		const state: SpikeState = {
			world: "isolated",
			hasPipApi: pipApi() !== undefined,
			keys: [],
			pip: [],
			clicks: 0,
			commandsReceived: [],
		};
		const report = () => {
			document.documentElement.setAttribute(
				"data-spike-cs",
				JSON.stringify(state),
			);
		};

		const host = document.createElement("div");
		host.id = "freedia-spike-host";
		const shadow = host.attachShadow({ mode: "open" });
		const openButton = document.createElement("button");
		openButton.id = "cs-open-pip";
		openButton.textContent = "content-script: open PiP";
		const countButton = document.createElement("button");
		countButton.id = "cs-count";
		countButton.textContent = "count";
		countButton.addEventListener("click", () => {
			state.clicks += 1;
			report();
		});
		shadow.append(openButton, countButton);
		document.body.append(host);

		const openPip = async (trigger: string) => {
			const entry: PipEntry = {
				trigger,
				userActivation: navigator.userActivation?.isActive ?? null,
			};
			state.pip.push(entry);
			try {
				const api = pipApi();
				if (!api) throw new Error("documentPictureInPicture missing");
				const pipWindow = await api.requestWindow({ width: 360, height: 480 });
				entry.result = "opened";
				pipWindow.document.title = "freeDia spike PiP";
				pipWindow.document.body.append(host);
				entry.hostMovedToPip = host.ownerDocument === pipWindow.document;
				pipWindow.addEventListener("pagehide", () => {
					entry.closedAt = Date.now();
					document.body.append(host);
					entry.hostBackInPage = host.ownerDocument === document;
					report();
				});
			} catch (error) {
				entry.result = `error: ${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`;
			}
			report();
		};

		openButton.addEventListener("click", () => openPip("cs-click"));

		window.addEventListener(
			"keydown",
			(event) => {
				state.keys.push({
					key: event.key,
					code: event.code,
					meta: event.metaKey,
					ctrl: event.ctrlKey,
					shift: event.shiftKey,
				});
				if (event.metaKey && !event.shiftKey && event.code === "KeyE") {
					event.preventDefault();
					event.stopImmediatePropagation();
					openPip("cs-keydown-cmd-e");
				}
				report();
			},
			true,
		);

		browser.runtime.onMessage.addListener((message: unknown) => {
			if (!isCommandMessage(message)) return;
			state.commandsReceived.push(message.command);
			report();
			openPip(`command:${message.command}`);
		});

		report();
	},
});

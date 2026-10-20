import type { ChatSummary } from "freedia/protocol";
import { type ReactNode, useEffect, useReducer, useState } from "react";
import type {
	ChatClient,
	ConnectionState,
	ModelInfo,
	ModelRef,
	PageReadability,
	Quote,
} from "../client/types";
import { Composer } from "./Composer";
import { InstallCard } from "./ErrorCard";
import { HistoryPanel, type HistoryState } from "./HistoryPanel";
import {
	BackIcon,
	CloseIcon,
	CollapseIcon,
	ExpandIcon,
	HistoryIcon,
	PlusIcon,
} from "./icons";
import type { ResizeEdge, WindowStore } from "./layout";
import { MessageList } from "./MessageList";
import { initialTranscript, isRunning, transcriptReducer } from "./transcript";
import { useWindowLayout } from "./useWindowLayout";

export const OPEN_EVENT = "freedia:open";

type Confirm = { kind: "close" } | { kind: "delete"; chat: ChatSummary } | null;

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function HeaderButton(props: {
	label: string;
	onClick(): void;
	children: ReactNode;
}) {
	return (
		<button
			type="button"
			aria-label={props.label}
			title={props.label}
			onClick={props.onClick}
			className="flex size-7 items-center justify-center rounded-lg text-neutral-500 hover:bg-neutral-100 hover:text-neutral-900"
		>
			{props.children}
		</button>
	);
}

function ConfirmDialog(props: {
	title: string;
	body: string;
	confirmLabel: string;
	cancelLabel: string;
	onConfirm(): void;
	onCancel(): void;
}) {
	return (
		<div className="absolute inset-0 z-20 flex items-center justify-center bg-white/60 p-6 backdrop-blur-[2px]">
			<div
				role="alertdialog"
				aria-modal="true"
				aria-labelledby="fd-confirm-title"
				aria-describedby="fd-confirm-body"
				className="w-full max-w-72 rounded-2xl border border-neutral-200 bg-white p-4 shadow-xl"
			>
				<h2 id="fd-confirm-title" className="font-semibold text-neutral-900">
					{props.title}
				</h2>
				<p id="fd-confirm-body" className="mt-1 text-sm text-neutral-600">
					{props.body}
				</p>
				<div className="mt-4 flex justify-end gap-2">
					<button
						type="button"
						onClick={props.onCancel}
						className="rounded-lg px-3 py-1.5 text-sm text-neutral-700 hover:bg-neutral-100"
					>
						{props.cancelLabel}
					</button>
					<button
						type="button"
						onClick={props.onConfirm}
						className="rounded-lg bg-red-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-red-700"
					>
						{props.confirmLabel}
					</button>
				</div>
			</div>
		</div>
	);
}

const RESIZE_HANDLES: { edge: ResizeEdge; className: string }[] = [
	{ edge: "nw", className: "top-0 left-0 cursor-nwse-resize" },
	{ edge: "ne", className: "top-0 right-0 cursor-nesw-resize" },
	{ edge: "sw", className: "bottom-0 left-0 cursor-nesw-resize" },
	{ edge: "se", className: "right-0 bottom-0 cursor-nwse-resize" },
];

export interface ChatAppProps {
	client: ChatClient;
	store: WindowStore;
	events: EventTarget;
}

export function ChatApp({ client, store, events }: ChatAppProps) {
	const [transcript, dispatch] = useReducer(
		transcriptReducer,
		client.currentChatId(),
		initialTranscript,
	);
	const [quotes, setQuotes] = useState<Quote[]>(() => client.quotes());
	const [readability, setReadability] = useState<PageReadability>(() =>
		client.pageReadability(),
	);
	const [connection, setConnection] = useState<ConnectionState>(() =>
		client.connection(),
	);
	const [models, setModels] = useState<ModelInfo[]>([]);
	const [model, setModel] = useState<ModelRef | null>(null);
	const [open, setOpen] = useState(true);
	const [history, setHistory] = useState<HistoryState | null>(null);
	const [confirm, setConfirm] = useState<Confirm>(null);
	const [focusSignal, setFocusSignal] = useState(1);
	const windowControls = useWindowLayout(store);
	const running = isRunning(transcript);
	const chatId = transcript.chatId;

	useEffect(() => {
		const unsubscribe = client.subscribe((event) => {
			dispatch({ type: "client", event });
			if (event.type === "quotes_changed") setQuotes(event.quotes);
			if (event.type === "page") setReadability(event.readability);
			if (event.type === "connection") setConnection(event.state);
		});
		dispatch({ type: "reset", chatId: client.currentChatId() });
		setQuotes(client.quotes());
		setReadability(client.pageReadability());
		setConnection(client.connection());
		return unsubscribe;
	}, [client]);

	useEffect(() => {
		const onOpen = () => {
			setOpen(true);
			setFocusSignal((value) => value + 1);
		};
		events.addEventListener(OPEN_EVENT, onOpen);
		return () => events.removeEventListener(OPEN_EVENT, onOpen);
	}, [events]);

	useEffect(() => {
		if (connection !== "connected") return;
		let live = true;
		client.listModels().then(
			(list) => live && setModels(list),
			() => live && setModels([]),
		);
		return () => {
			live = false;
		};
	}, [client, connection]);

	useEffect(() => {
		if (connection !== "connected" || !chatId) return;
		let live = true;
		client.currentModel().then(
			(current) => live && setModel(current),
			() => undefined,
		);
		return () => {
			live = false;
		};
	}, [client, connection, chatId]);

	const loadHistory = () => {
		setHistory({ status: "loading" });
		client.listChats().then(
			(chats) => setHistory({ status: "ready", chats }),
			(error) => setHistory({ status: "failed", message: errorText(error) }),
		);
	};

	const send = (text: string) => {
		dispatch({ type: "send", text });
		client
			.send(text)
			.catch((error) =>
				dispatch({ type: "send_failed", message: errorText(error) }),
			);
	};

	const newChat = () => {
		setHistory(null);
		client.newChat().then(
			(id) => {
				dispatch({ type: "reset", chatId: id });
				setFocusSignal((value) => value + 1);
			},
			() => undefined,
		);
	};

	const openChat = (id: string) => {
		setHistory(null);
		client.openChat(id).then(
			(messages) => dispatch({ type: "loaded", chatId: id, messages }),
			(error) =>
				dispatch({
					type: "failed",
					title: "Couldn't open this chat",
					message: errorText(error),
				}),
		);
	};

	const pickModel = (next: ModelRef) => {
		const previous = model;
		setModel(next);
		client.setModel(next).catch((error) => {
			setModel(previous);
			dispatch({
				type: "failed",
				title: "Couldn't switch models",
				message: errorText(error),
			});
		});
	};

	const close = () => {
		if (running) {
			setConfirm({ kind: "close" });
			return;
		}
		setOpen(false);
	};

	const confirmClose = () => {
		setConfirm(null);
		void client.abort().finally(() => setOpen(false));
	};

	const confirmDelete = (chat: ChatSummary) => {
		setConfirm(null);
		client
			.deleteChat(chat.chatId)
			.then(loadHistory, (error) =>
				setHistory({ status: "failed", message: errorText(error) }),
			);
	};

	if (!open) return null;

	const { rect, expanded } = windowControls;
	const helperMissing = connection === "helper_missing";
	return (
		<div
			role="dialog"
			aria-label="freeDia chat"
			style={{
				left: rect.x,
				top: rect.y,
				width: rect.width,
				height: rect.height,
			}}
			className="pointer-events-auto fixed z-[2147483647] flex flex-col overflow-hidden rounded-2xl border border-neutral-200/80 bg-white font-sans text-neutral-900 shadow-[0_12px_40px_-8px_rgba(0,0,0,0.25),0_2px_8px_rgba(0,0,0,0.08)]"
		>
			<header
				onPointerDown={windowControls.startDrag}
				className="flex h-11 shrink-0 cursor-grab touch-none items-center gap-0.5 px-2 select-none active:cursor-grabbing"
			>
				{history ? (
					<HeaderButton label="Back to chat" onClick={() => setHistory(null)}>
						<BackIcon />
					</HeaderButton>
				) : (
					<HeaderButton label="History" onClick={loadHistory}>
						<HistoryIcon />
					</HeaderButton>
				)}
				<div className="flex-1" />
				<HeaderButton label="New chat" onClick={newChat}>
					<PlusIcon />
				</HeaderButton>
				<HeaderButton
					label={expanded ? "Collapse" : "Expand"}
					onClick={windowControls.toggleExpanded}
				>
					{expanded ? <CollapseIcon /> : <ExpandIcon />}
				</HeaderButton>
				<HeaderButton label="Close" onClick={close}>
					<CloseIcon />
				</HeaderButton>
			</header>
			{helperMissing ? (
				<InstallCard />
			) : history ? (
				<HistoryPanel
					history={history}
					currentChatId={chatId}
					onOpen={openChat}
					onDelete={(chat) => setConfirm({ kind: "delete", chat })}
				/>
			) : (
				<>
					<MessageList state={transcript} />
					{connection === "connecting" && (
						<p role="status" className="px-4 pb-2 text-xs text-neutral-500">
							Connecting to freeDia's helper…
						</p>
					)}
					{readability === "unreadable" && (
						<p className="mx-3 mb-2 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-900">
							freeDia can't read this page yet. You can still ask, but the
							page's text won't be included.
						</p>
					)}
					<Composer
						placeholder={
							transcript.turns.length === 0
								? "Ask a question about this page"
								: "Ask another question"
						}
						running={running}
						disabled={connection !== "connected"}
						quotes={quotes}
						models={models}
						model={model}
						draft={transcript.draft}
						focusSignal={focusSignal}
						onSend={send}
						onStop={() => void client.abort()}
						onRemoveQuote={(id) => client.removeQuote(id)}
						onPickModel={pickModel}
					/>
				</>
			)}
			{RESIZE_HANDLES.map(({ edge, className }) => (
				<div
					key={edge}
					data-resize={edge}
					onPointerDown={(event) => windowControls.startResize(edge, event)}
					className={`absolute z-10 size-3 touch-none ${className}`}
				/>
			))}
			{confirm?.kind === "close" && (
				<ConfirmDialog
					title="Cancel this response?"
					body="freeDia is still responding. Closing the chat will cancel the response."
					confirmLabel="Cancel response"
					cancelLabel="Keep waiting"
					onConfirm={confirmClose}
					onCancel={() => setConfirm(null)}
				/>
			)}
			{confirm?.kind === "delete" && (
				<ConfirmDialog
					title="Delete this chat?"
					body={`"${confirm.chat.title}" will be permanently deleted.`}
					confirmLabel="Delete"
					cancelLabel="Cancel"
					onConfirm={() => confirmDelete(confirm.chat)}
					onCancel={() => setConfirm(null)}
				/>
			)}
		</div>
	);
}

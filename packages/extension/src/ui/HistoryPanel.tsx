import type { ChatSummary } from "freedia/protocol";
import { TrashIcon } from "./icons";

export type HistoryState =
	| { status: "loading" }
	| { status: "ready"; chats: ChatSummary[] }
	| { status: "failed"; message: string };

interface HistoryPanelProps {
	history: HistoryState;
	currentChatId: string;
	onOpen(chatId: string): void;
	onDelete(chat: ChatSummary): void;
}

const dateFormat = new Intl.DateTimeFormat(undefined, {
	month: "short",
	day: "numeric",
});
const timeFormat = new Intl.DateTimeFormat(undefined, {
	hour: "numeric",
	minute: "2-digit",
});

function when(updatedAt: string, now: Date): string {
	const date = new Date(updatedAt);
	if (Number.isNaN(date.getTime())) return "";
	return date.toDateString() === now.toDateString()
		? timeFormat.format(date)
		: dateFormat.format(date);
}

export function HistoryPanel(props: HistoryPanelProps) {
	const { history } = props;
	const now = new Date();
	return (
		<section
			aria-label="Recent chats"
			className="flex min-h-0 flex-1 flex-col overflow-y-auto px-2 py-2"
		>
			<h2 className="px-2 pb-1.5 text-xs font-medium text-neutral-500">
				Recent chats
			</h2>
			{history.status === "loading" && (
				<p role="status" className="px-2 text-sm text-neutral-500">
					Loading chats…
				</p>
			)}
			{history.status === "failed" && (
				<p role="alert" className="px-2 text-sm text-red-700">
					Couldn't load your chats. {history.message}
				</p>
			)}
			{history.status === "ready" && history.chats.length === 0 && (
				<p className="px-2 text-sm text-neutral-500">No chats yet.</p>
			)}
			{history.status === "ready" && history.chats.length > 0 && (
				<ul className="flex flex-col">
					{history.chats.map((chat) => (
						<li
							key={chat.chatId}
							className={`group flex items-center rounded-lg hover:bg-neutral-100 ${chat.chatId === props.currentChatId ? "bg-neutral-100" : ""}`}
						>
							<button
								type="button"
								onClick={() => props.onOpen(chat.chatId)}
								className="flex min-w-0 flex-1 items-baseline gap-2 px-2 py-2 text-left"
							>
								<span className="min-w-0 flex-1 truncate text-sm text-neutral-900">
									{chat.title}
								</span>
								<span className="shrink-0 text-xs text-neutral-400">
									{when(chat.updatedAt, now)}
								</span>
							</button>
							<button
								type="button"
								aria-label={`Delete ${chat.title}`}
								title="Delete"
								onClick={() => props.onDelete(chat)}
								className="mr-1 rounded-md p-1.5 text-neutral-400 opacity-0 group-hover:opacity-100 hover:bg-neutral-200 hover:text-neutral-700 focus:opacity-100"
							>
								<TrashIcon />
							</button>
						</li>
					))}
				</ul>
			)}
		</section>
	);
}

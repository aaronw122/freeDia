import { useLayoutEffect, useRef } from "react";
import { CopyButton } from "./CopyButton";
import { ErrorCard } from "./ErrorCard";
import { helperErrorView, promptErrorView, replyErrorView } from "./errors";
import { Markdown } from "./Markdown";
import {
	type AssistantTurn,
	assistantText,
	type RetryInfo,
	replyFailure,
	replyStopped,
	type TranscriptState,
} from "./transcript";

function Dots() {
	return (
		<span className="inline-flex gap-1" aria-hidden="true">
			<span className="fd-dot size-1.5 rounded-full bg-neutral-400" />
			<span className="fd-dot size-1.5 rounded-full bg-neutral-400" />
			<span className="fd-dot size-1.5 rounded-full bg-neutral-400" />
		</span>
	);
}

function retryText(retry: RetryInfo | null): string {
	if (!retry) return "Retrying…";
	const { title } = replyErrorView(retry.errorMessage, retry.provider);
	return `${title}. Retrying… (attempt ${retry.attempt} of ${retry.maxAttempts})`;
}

function Progress({ state }: { state: TranscriptState }) {
	const label = {
		idle: null,
		streaming: null,
		sending: null,
		starting: "Starting…",
		queued: "Waiting for another chat to finish…",
		thinking: "Thinking…",
		tool: state.tool,
		retrying: retryText(state.retry),
	}[state.phase];
	if (state.phase === "idle" || state.phase === "streaming") return null;
	return (
		<div
			role="status"
			aria-label={label ?? "Loading response"}
			className="flex items-center gap-2 px-1 text-sm text-neutral-500"
		>
			<Dots />
			{label && <span>{label}</span>}
		</div>
	);
}

function AssistantMessage({
	turn,
	streaming,
}: {
	turn: AssistantTurn;
	streaming: boolean;
}) {
	const text = assistantText(turn);
	const failure = replyFailure(turn);
	const stopped = replyStopped(turn);
	if (text.length === 0 && !failure && !stopped) return null;
	return (
		<article aria-label="Assistant message" className="group text-neutral-900">
			{text.length > 0 && <Markdown text={text} />}
			{failure && (
				<div className={text.length > 0 ? "mt-3" : ""}>
					<ErrorCard
						view={replyErrorView(failure.errorMessage, failure.provider)}
					/>
				</div>
			)}
			{stopped && (
				<p className="mt-1 text-xs text-neutral-500 italic">Stopped</p>
			)}
			{turn.done && !streaming && text.length > 0 && (
				<div className="mt-1 -ml-1.5 flex opacity-70 transition-opacity group-hover:opacity-100">
					<CopyButton label="Copy" text={() => text} />
				</div>
			)}
		</article>
	);
}

export function MessageList({ state }: { state: TranscriptState }) {
	const scroller = useRef<HTMLDivElement>(null);
	const pinned = useRef(true);
	const last = state.turns.at(-1);

	useLayoutEffect(() => {
		const element = scroller.current;
		if (element && pinned.current) element.scrollTop = element.scrollHeight;
	});

	const error = state.error;
	return (
		<div
			ref={scroller}
			onScroll={(event) => {
				const element = event.currentTarget;
				pinned.current =
					element.scrollHeight - element.scrollTop - element.clientHeight < 40;
			}}
			className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-4 py-3"
		>
			{state.turns.map((turn) =>
				turn.kind === "user" ? (
					<div
						key={turn.key}
						className="max-w-[85%] self-end rounded-2xl bg-neutral-100 px-3.5 py-2 whitespace-pre-wrap text-neutral-900"
					>
						{turn.text}
					</div>
				) : (
					<AssistantMessage
						key={turn.key}
						turn={turn}
						streaming={turn === last && state.phase !== "idle"}
					/>
				),
			)}
			<Progress state={state} />
			{error && (
				<ErrorCard
					view={
						error.source === "helper"
							? helperErrorView(error.error)
							: error.source === "prompt"
								? promptErrorView(error.message)
								: {
										title: error.title,
										fix: "Try again.",
										command: null,
										detail: error.message || null,
									}
					}
				/>
			)}
		</div>
	);
}

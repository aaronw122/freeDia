import { useEffect, useRef, useState } from "react";
import type { ModelInfo, ModelRef, Quote } from "../client/types";
import {
	ArrowUpIcon,
	ChevronIcon,
	CloseIcon,
	StopIcon,
	TextIcon,
} from "./icons";

interface ComposerProps {
	placeholder: string;
	running: boolean;
	disabled: boolean;
	quotes: Quote[];
	models: ModelInfo[];
	model: ModelRef | null;
	draft: { text: string; seq: number } | null;
	focusSignal: number;
	onSend(text: string): void;
	onStop(): void;
	onRemoveQuote(id: string): void;
	onPickModel(model: ModelRef): void;
}

function QuoteChip({ quote, onRemove }: { quote: Quote; onRemove(): void }) {
	return (
		<li
			title={quote.text}
			className="flex max-w-full items-center gap-1.5 rounded-lg border border-neutral-200 bg-white py-1 pr-1 pl-2 text-xs text-neutral-700 shadow-sm"
		>
			<span className="text-neutral-500">
				<TextIcon />
			</span>
			<span className="font-medium">Selected Text</span>
			<button
				type="button"
				aria-label="Remove Selected Text"
				onClick={onRemove}
				className="rounded p-0.5 text-neutral-400 hover:bg-neutral-100 hover:text-neutral-700"
			>
				<CloseIcon size={12} />
			</button>
		</li>
	);
}

function sameModel(a: ModelRef | null, b: ModelRef) {
	return a?.provider === b.provider && a.modelId === b.modelId;
}

function ModelPicker({
	models,
	model,
	disabled,
	onPick,
}: {
	models: ModelInfo[];
	model: ModelRef | null;
	disabled: boolean;
	onPick(model: ModelRef): void;
}) {
	const [open, setOpen] = useState(false);
	const current = models.find((entry) => sameModel(model, entry));
	const label = current?.name ?? model?.modelId ?? "Choose model";

	return (
		<div className="relative">
			<button
				type="button"
				aria-label={`Model: ${label}`}
				aria-haspopup="menu"
				aria-expanded={open}
				disabled={disabled || models.length === 0}
				onClick={() => setOpen((value) => !value)}
				className="flex max-w-44 items-center gap-1 rounded-lg px-2 py-1 text-xs text-neutral-600 hover:bg-neutral-100 disabled:opacity-50"
			>
				<span className="truncate">{label}</span>
				<ChevronIcon />
			</button>
			{open && (
				<div
					role="menu"
					aria-label="Models"
					className="absolute right-0 bottom-full z-10 mb-1 flex max-h-64 w-60 flex-col overflow-y-auto rounded-xl border border-neutral-200 bg-white p-1 shadow-lg"
				>
					{models.map((entry) => {
						const selected = sameModel(model, entry);
						return (
							<button
								type="button"
								key={`${entry.provider}/${entry.modelId}`}
								role="menuitemradio"
								aria-checked={selected}
								onClick={() => {
									setOpen(false);
									if (!selected) onPick(entry);
								}}
								className={`rounded-lg px-2.5 py-1.5 text-left text-sm hover:bg-neutral-100 ${selected ? "bg-neutral-100 font-medium" : ""}`}
							>
								<div className="truncate text-neutral-900">{entry.name}</div>
								<div className="truncate text-xs text-neutral-500">
									{entry.provider}
								</div>
							</button>
						);
					})}
				</div>
			)}
		</div>
	);
}

export function Composer(props: ComposerProps) {
	const [text, setText] = useState("");
	const input = useRef<HTMLTextAreaElement>(null);
	const canSend = !props.running && !props.disabled && text.trim().length > 0;

	useEffect(() => {
		if (props.draft) setText(props.draft.text);
	}, [props.draft]);

	useEffect(() => {
		if (props.focusSignal > 0 && !props.disabled) input.current?.focus();
	}, [props.focusSignal, props.disabled]);

	useEffect(() => {
		const element = input.current;
		if (!element) return;
		element.style.height = "auto";
		element.style.height = `${Math.min(element.scrollHeight, 160)}px`;
	});

	const submit = () => {
		if (!canSend) return;
		props.onSend(text.trim());
		setText("");
	};

	return (
		<form
			aria-label="Composer"
			onSubmit={(event) => {
				event.preventDefault();
				submit();
			}}
			className="m-3 mt-0 rounded-2xl border border-neutral-200 bg-white shadow-sm focus-within:border-neutral-300"
		>
			{props.quotes.length > 0 && (
				<ul
					aria-label="Attachments"
					className="flex flex-wrap gap-1.5 px-2.5 pt-2.5"
				>
					{props.quotes.map((quote) => (
						<QuoteChip
							key={quote.id}
							quote={quote}
							onRemove={() => props.onRemoveQuote(quote.id)}
						/>
					))}
				</ul>
			)}
			<textarea
				ref={input}
				rows={1}
				value={text}
				aria-label="Message"
				placeholder={props.placeholder}
				disabled={props.disabled}
				onChange={(event) => setText(event.target.value)}
				onKeyDown={(event) => {
					if (
						event.key === "Enter" &&
						!event.shiftKey &&
						!event.nativeEvent.isComposing
					) {
						event.preventDefault();
						submit();
					}
				}}
				className="block w-full resize-none bg-transparent px-3.5 pt-3 pb-1 text-sm text-neutral-900 outline-none placeholder:text-neutral-400"
			/>
			<div className="flex items-center justify-end gap-1 px-2 pb-2">
				<ModelPicker
					models={props.models}
					model={props.model}
					disabled={props.running || props.disabled}
					onPick={props.onPickModel}
				/>
				{props.running ? (
					<button
						type="button"
						aria-label="Stop"
						title="Stop"
						onClick={props.onStop}
						className="flex size-7 items-center justify-center rounded-full bg-neutral-900 text-white hover:bg-neutral-700"
					>
						<StopIcon />
					</button>
				) : (
					<button
						type="submit"
						aria-label="Send"
						title="Send (Enter)"
						disabled={!canSend}
						className="flex size-7 items-center justify-center rounded-full bg-neutral-900 text-white hover:bg-neutral-700 disabled:bg-neutral-200 disabled:text-neutral-400"
					>
						<ArrowUpIcon />
					</button>
				)}
			</div>
		</form>
	);
}

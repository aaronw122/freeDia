import { useEffect, useState } from "react";
import { CheckIcon, CopyIcon } from "./icons";

interface CopyButtonProps {
	label: string;
	text: () => string;
	className?: string;
}

export function CopyButton({ label, text, className = "" }: CopyButtonProps) {
	const [copied, setCopied] = useState(false);

	useEffect(() => {
		if (!copied) return;
		const timer = setTimeout(() => setCopied(false), 1500);
		return () => clearTimeout(timer);
	}, [copied]);

	return (
		<button
			type="button"
			aria-label={label}
			title={label}
			onClick={() => {
				void navigator.clipboard.writeText(text()).then(() => setCopied(true));
			}}
			className={`inline-flex items-center gap-1 rounded-md px-1.5 py-1 text-xs text-neutral-500 hover:bg-neutral-100 hover:text-neutral-800 ${className}`}
		>
			{copied ? <CheckIcon /> : <CopyIcon />}
			<span>{copied ? "Copied" : label}</span>
		</button>
	);
}

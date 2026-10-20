import { CopyButton } from "./CopyButton";
import { type ErrorView, INSTALL_COMMAND } from "./errors";
import { AlertIcon } from "./icons";

function CommandLine({ command }: { command: string }) {
	return (
		<div className="mt-2 flex items-center justify-between gap-2 rounded-lg border border-neutral-200 bg-white py-1 pr-1 pl-3">
			<code className="font-mono text-xs text-neutral-800">{command}</code>
			<CopyButton label="Copy command" text={() => command} />
		</div>
	);
}

export function ErrorCard({ view }: { view: ErrorView }) {
	return (
		<div
			role="alert"
			className="rounded-xl border border-red-200 bg-red-50/70 px-3 py-2.5 text-sm text-neutral-800"
		>
			<div className="flex items-start gap-2">
				<span className="mt-0.5 text-red-600">
					<AlertIcon />
				</span>
				<div className="min-w-0 flex-1">
					<p className="font-medium text-neutral-900">{view.title}</p>
					<p className="mt-0.5 text-neutral-700">{view.fix}</p>
					{view.command && <CommandLine command={view.command} />}
					{view.detail && (
						<details className="mt-2 text-xs text-neutral-500">
							<summary className="cursor-pointer select-none">Details</summary>
							<p className="mt-1 font-mono break-all whitespace-pre-wrap">
								{view.detail}
							</p>
						</details>
					)}
				</div>
			</div>
		</div>
	);
}

export function InstallCard() {
	return (
		<section
			aria-label="Install helper"
			className="m-4 rounded-2xl border border-neutral-200 bg-neutral-50 p-4 text-sm"
		>
			<h2 className="text-base font-semibold text-neutral-900">
				Install helper
			</h2>
			<p className="mt-1 text-neutral-700">
				freeDia needs a small helper app on your Mac to talk to your AI
				accounts. Run this in Terminal, then reopen the chat:
			</p>
			<CommandLine command={INSTALL_COMMAND} />
		</section>
	);
}

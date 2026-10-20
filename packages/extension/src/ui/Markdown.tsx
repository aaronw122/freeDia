import { type ComponentProps, memo, useRef } from "react";
import ReactMarkdown, { type ExtraProps } from "react-markdown";
import remarkGfm from "remark-gfm";
import { CopyButton } from "./CopyButton";
import { rehypeLowlight } from "./highlight";

function CodeBlock({ children }: ComponentProps<"pre"> & ExtraProps) {
	const ref = useRef<HTMLPreElement>(null);
	return (
		<div className="group relative overflow-hidden rounded-lg border border-neutral-200 bg-neutral-50">
			<div className="flex items-center justify-end border-b border-neutral-200 px-1 py-0.5">
				<CopyButton
					label="Copy code"
					text={() => ref.current?.textContent?.replace(/\n$/, "") ?? ""}
				/>
			</div>
			<pre ref={ref} className="overflow-x-auto px-3 py-2.5">
				{children}
			</pre>
		</div>
	);
}

function Link({ href, title, children }: ComponentProps<"a"> & ExtraProps) {
	return (
		<a href={href} title={title} target="_blank" rel="noreferrer noopener">
			{children}
		</a>
	);
}

const remarkPlugins = [remarkGfm];
const rehypePlugins = [rehypeLowlight];
const components = { pre: CodeBlock, a: Link };

export const Markdown = memo(function Markdown({ text }: { text: string }) {
	return (
		<div className="fd-md">
			<ReactMarkdown
				remarkPlugins={remarkPlugins}
				rehypePlugins={rehypePlugins}
				components={components}
			>
				{text}
			</ReactMarkdown>
		</div>
	);
});

import { type ComponentProps, memo, useRef } from "react";
import ReactMarkdown from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import remarkGfm from "remark-gfm";
import { CopyButton } from "./CopyButton";

function CodeBlock({ children }: ComponentProps<"pre">) {
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

function Link(props: ComponentProps<"a">) {
	return <a {...props} target="_blank" rel="noreferrer noopener" />;
}

const remarkPlugins = [remarkGfm];
const rehypePlugins = [
	[rehypeHighlight, { detect: true, ignoreMissing: true }],
] satisfies ComponentProps<typeof ReactMarkdown>["rehypePlugins"];
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

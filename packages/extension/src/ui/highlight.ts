import type { Element, ElementContent, Root } from "hast";
import { toText } from "hast-util-to-text";
import bash from "highlight.js/lib/languages/bash";
import css from "highlight.js/lib/languages/css";
import diff from "highlight.js/lib/languages/diff";
import go from "highlight.js/lib/languages/go";
import java from "highlight.js/lib/languages/java";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import markdown from "highlight.js/lib/languages/markdown";
import python from "highlight.js/lib/languages/python";
import rust from "highlight.js/lib/languages/rust";
import shell from "highlight.js/lib/languages/shell";
import sql from "highlight.js/lib/languages/sql";
import typescript from "highlight.js/lib/languages/typescript";
import xml from "highlight.js/lib/languages/xml";
import yaml from "highlight.js/lib/languages/yaml";
import { createLowlight } from "lowlight";
import { visit } from "unist-util-visit";

const lowlight = createLowlight({
	bash,
	css,
	diff,
	go,
	java,
	javascript,
	json,
	markdown,
	python,
	rust,
	shell,
	sql,
	typescript,
	xml,
	yaml,
});

lowlight.registerAlias({
	bash: ["sh", "zsh"],
	javascript: ["js", "jsx", "mjs", "cjs"],
	typescript: ["ts", "tsx", "mts"],
	xml: ["html", "svg"],
	yaml: ["yml"],
	markdown: ["md"],
	python: ["py"],
	rust: ["rs"],
	shell: ["console"],
});

function codeLanguage(node: Element): string | null {
	const className = node.properties.className;
	if (!Array.isArray(className)) return null;
	for (const name of className) {
		if (typeof name !== "string") continue;
		if (name === "no-highlight" || name === "nohighlight") return "";
		if (name.startsWith("language-")) return name.slice("language-".length);
	}
	return null;
}

export function rehypeLowlight() {
	return (tree: Root) => {
		visit(tree, "element", (node, _index, parent) => {
			if (node.tagName !== "code" || parent?.type !== "element") return;
			if (parent.tagName !== "pre") return;
			const language = codeLanguage(node);
			if (language === "") return;
			const text = toText(node, { whitespace: "pre" });
			const result =
				language && lowlight.registered(language)
					? lowlight.highlight(language, text)
					: lowlight.highlightAuto(text);
			const detected = result.data?.language;
			const classes = Array.isArray(node.properties.className)
				? node.properties.className
				: [];
			node.properties.className = [
				...classes,
				"hljs",
				...(detected && !language ? [`language-${detected}`] : []),
			];
			node.children = result.children.filter(
				(child): child is ElementContent => child.type !== "doctype",
			);
		});
	};
}

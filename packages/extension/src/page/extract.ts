import { Readability } from "@mozilla/readability";
import TurndownService from "turndown";
import type { PageReadability } from "../client/types";

export interface PageSnapshot {
	url: string;
	title: string;
	readability: PageReadability;
	markdown: string;
}

const READABILITY_MIN_SHARE = 0.2;

const UNREADABLE_HOSTS = [
	"youtube.com",
	"youtu.be",
	"docs.google.com",
	"slides.google.com",
	"sheets.google.com",
];

const HTML_CONTENT_TYPES: Record<string, true> = {
	"text/html": true,
	"application/xhtml+xml": true,
	"text/plain": true,
};

function isUnreadableLocation(doc: Document, url: URL): boolean {
	if (url.protocol !== "http:" && url.protocol !== "https:") {
		return true;
	}
	if (!HTML_CONTENT_TYPES[doc.contentType]) {
		return true;
	}
	const host = url.hostname.toLowerCase();
	return UNREADABLE_HOSTS.some(
		(blocked) => host === blocked || host.endsWith(`.${blocked}`),
	);
}

function visibleText(doc: Document): string {
	const body = doc.body;
	if (body === null) {
		return "";
	}
	return (body.innerText ?? body.textContent ?? "")
		.replace(/[ \t]+\n/g, "\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}

function readabilityMarkdown(doc: Document): {
	markdown: string;
	textLength: number;
} | null {
	const clone = doc.cloneNode(true) as Document;
	const article = new Readability(clone).parse();
	if (article === null || !article.content) {
		return null;
	}
	const turndown = new TurndownService({
		headingStyle: "atx",
		codeBlockStyle: "fenced",
		bulletListMarker: "-",
	});
	turndown.remove(["script", "style", "noscript", "template"]);
	return {
		markdown: turndown.turndown(article.content).trim(),
		textLength: (article.textContent ?? "").trim().length,
	};
}

export function extractPage(doc: Document, href: string): PageSnapshot {
	const url = new URL(href);
	const title = doc.title.trim();
	if (isUnreadableLocation(doc, url)) {
		return { url: href, title, readability: "unreadable", markdown: "" };
	}
	const text = visibleText(doc);
	const article = readabilityMarkdown(doc);
	const markdown =
		article !== null &&
		article.markdown !== "" &&
		article.textLength >= text.length * READABILITY_MIN_SHARE
			? article.markdown
			: text;
	if (markdown === "") {
		return { url: href, title, readability: "unreadable", markdown: "" };
	}
	return { url: href, title, readability: "readable", markdown };
}

export async function fingerprint(markdown: string): Promise<string> {
	const digest = await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(markdown),
	);
	return Array.from(new Uint8Array(digest), (byte) =>
		byte.toString(16).padStart(2, "0"),
	).join("");
}

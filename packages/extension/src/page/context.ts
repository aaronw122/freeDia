import { capQuotes, highlightWindow, layoutExcerpt } from "./excerpt";
import type { PageSnapshot } from "./extract";

export const QUIET_MS = 30 * 60 * 1000;

export const NO_PAGE_TEXT = "No page text is available for this page.";

export interface PageRecord {
	fingerprint: string | null;
	sentAt: number;
	fileKey: string;
}

export type ExcerptKind = "full" | "window" | "none";

export interface SendPlan {
	excerpt: ExcerptKind;
	putFile: boolean;
}

export interface PlanInput {
	record: PageRecord | null;
	fingerprint: string | null;
	hasQuotes: boolean;
	now: number;
	fileKey: string;
}

export function planSend(input: PlanInput): SendPlan {
	const { record, fingerprint, hasQuotes, now, fileKey } = input;
	if (fingerprint === null) {
		return { excerpt: "none", putFile: false };
	}
	if (record === null || record.fingerprint !== fingerprint) {
		return { excerpt: "full", putFile: true };
	}
	return {
		excerpt: hasQuotes ? "window" : "none",
		putFile: now - record.sentAt >= QUIET_MS || record.fileKey !== fileKey,
	};
}

export interface PromptInput {
	page: PageSnapshot;
	quotes: string[];
	question: string;
	excerpt: ExcerptKind;
	budget: number;
}

function blockquote(text: string): string {
	return text
		.split("\n")
		.map((line) => (line === "" ? ">" : `> ${line}`))
		.join("\n");
}

export function buildPrompt(input: PromptInput): string {
	const { page, quotes, question, excerpt, budget } = input;
	const sections = [`URL: ${page.url}\nTitle: ${page.title}`];
	const capped = capQuotes(quotes, budget);
	if (capped.length > 0) {
		sections.push(`## Selected text\n\n${capped.map(blockquote).join("\n\n")}`);
	}
	if (page.readability === "unreadable") {
		sections.push(NO_PAGE_TEXT);
	} else if (excerpt === "full") {
		sections.push(
			`## Page excerpt\n\n${layoutExcerpt(page.markdown, quotes, budget)}`,
		);
	} else if (excerpt === "window") {
		const window = highlightWindow(page.markdown, quotes, budget);
		if (window !== null) {
			sections.push(`## Page excerpt around the selected text\n\n${window}`);
		}
	}
	sections.push(`## Question\n\n${question}`);
	return sections.join("\n\n");
}

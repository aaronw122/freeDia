import { describe, expect, test } from "bun:test";
import {
	buildPrompt,
	NO_PAGE_TEXT,
	type PageRecord,
	planSend,
	QUIET_MS,
} from "./context";
import type { PageSnapshot } from "./extract";

const NOW = 1_000_000_000;
const CONNECTION = "conn-1";

function record(patch: Partial<PageRecord> = {}): PageRecord {
	return {
		fingerprint: "fp-a",
		sentAt: NOW - 60_000,
		fileKey: CONNECTION,
		...patch,
	};
}

describe("when to send what", () => {
	test("first message of the chat: full excerpt and the page file", () => {
		expect(
			planSend({
				record: null,
				fingerprint: "fp-a",
				hasQuotes: false,
				now: NOW,
				fileKey: CONNECTION,
			}),
		).toEqual({ excerpt: "full", putFile: true });
	});

	test("fingerprint changed: full excerpt and the page file", () => {
		expect(
			planSend({
				record: record(),
				fingerprint: "fp-b",
				hasQuotes: true,
				now: NOW,
				fileKey: CONNECTION,
			}),
		).toEqual({ excerpt: "full", putFile: true });
	});

	test("same page, new highlight: only the window, no file", () => {
		expect(
			planSend({
				record: record(),
				fingerprint: "fp-a",
				hasQuotes: true,
				now: NOW,
				fileKey: CONNECTION,
			}),
		).toEqual({ excerpt: "window", putFile: false });
	});

	test("same page after 30 quiet minutes: file only", () => {
		expect(
			planSend({
				record: record({ sentAt: NOW - QUIET_MS }),
				fingerprint: "fp-a",
				hasQuotes: false,
				now: NOW,
				fileKey: CONNECTION,
			}),
		).toEqual({ excerpt: "none", putFile: true });
		expect(
			planSend({
				record: record({ sentAt: NOW - QUIET_MS + 1 }),
				fingerprint: "fp-a",
				hasQuotes: false,
				now: NOW,
				fileKey: CONNECTION,
			}),
		).toEqual({ excerpt: "none", putFile: false });
	});

	test("same page after the extension reconnected: file only", () => {
		expect(
			planSend({
				record: record(),
				fingerprint: "fp-a",
				hasQuotes: false,
				now: NOW,
				fileKey: "conn-2",
			}),
		).toEqual({ excerpt: "none", putFile: true });
	});

	test("same page otherwise: nothing", () => {
		expect(
			planSend({
				record: record(),
				fingerprint: "fp-a",
				hasQuotes: false,
				now: NOW,
				fileKey: CONNECTION,
			}),
		).toEqual({ excerpt: "none", putFile: false });
	});

	test("an unreadable page sends neither excerpt nor file", () => {
		expect(
			planSend({
				record: null,
				fingerprint: null,
				hasQuotes: true,
				now: NOW,
				fileKey: CONNECTION,
			}),
		).toEqual({ excerpt: "none", putFile: false });
	});
});

const PAGE: PageSnapshot = {
	url: "https://example.com/article",
	title: "Example article",
	readability: "readable",
	markdown: "# Example\n\nFirst paragraph.\n\nSecond paragraph.",
};

describe("prompt text", () => {
	test("first message: URL, title, quotes, excerpt, then the question", () => {
		expect(
			buildPrompt({
				page: PAGE,
				quotes: ["First paragraph."],
				question: "What does it say?",
				excerpt: "full",
				budget: 8_000,
			}),
		).toBe(
			[
				"URL: https://example.com/article",
				"Title: Example article",
				"",
				"## Selected text",
				"",
				"> First paragraph.",
				"",
				"## Page excerpt",
				"",
				"# Example",
				"",
				"First paragraph.",
				"",
				"Second paragraph.",
				"",
				"## Question",
				"",
				"What does it say?",
			].join("\n"),
		);
	});

	test("follow-up on the same page: no excerpt, no quote section without quotes", () => {
		expect(
			buildPrompt({
				page: PAGE,
				quotes: [],
				question: "And then?",
				excerpt: "none",
				budget: 8_000,
			}),
		).toBe(
			"URL: https://example.com/article\nTitle: Example article\n\n## Question\n\nAnd then?",
		);
	});

	test("several quotes become separate blockquotes, multi-line kept", () => {
		const prompt = buildPrompt({
			page: PAGE,
			quotes: ["one\n\ntwo", "three"],
			question: "Q",
			excerpt: "none",
			budget: 8_000,
		});
		expect(prompt).toContain(
			"## Selected text\n\n> one\n>\n> two\n\n> three\n\n## Question",
		);
	});

	test("new highlight on the same long page sends only the window around it", () => {
		const markdown = Array.from(
			{ length: 300 },
			(_, i) => `Para ${i} ${"x ".repeat(40)}`,
		).join("\n\n");
		const prompt = buildPrompt({
			page: { ...PAGE, markdown },
			quotes: ["Para 150"],
			question: "Q",
			excerpt: "window",
			budget: 8_000,
		});
		expect(prompt).toContain("## Page excerpt around the selected text\n\n[…");
		expect(prompt).toContain("Para 150 ");
		expect(prompt).not.toContain("Para 0 ");
		expect(prompt).not.toContain("Para 299 ");
	});

	test("an unreadable page tells omp no page text is available", () => {
		const prompt = buildPrompt({
			page: { ...PAGE, readability: "unreadable", markdown: "" },
			quotes: ["quoted"],
			question: "Q",
			excerpt: "full",
			budget: 8_000,
		});
		expect(prompt).toBe(
			`URL: https://example.com/article\nTitle: Example article\n\n## Selected text\n\n> quoted\n\n${NO_PAGE_TEXT}\n\n## Question\n\nQ`,
		);
	});
});

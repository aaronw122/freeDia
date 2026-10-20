import { describe, expect, test } from "bun:test";
import {
	capQuotes,
	excerptBudgetChars,
	highlightWindow,
	layoutExcerpt,
	locateHighlights,
} from "./excerpt";

const PARAGRAPHS = Array.from(
	{ length: 400 },
	(_, i) => `Paragraph ${i} ${"word ".repeat(38).trim()} end${i}.`,
);
const PAGE = PARAGRAPHS.join("\n\n");
const BUDGET = 8_000;
const FILL = BUDGET * 0.05;
const MARKER = /\[… (\d+) characters omitted …\]/g;

function blocks(excerpt: string): string[] {
	return excerpt.split(/\n\n\[… \d+ characters omitted …\]\n\n/);
}

function paragraphNumbers(text: string): number[] {
	return [...text.matchAll(/Paragraph (\d+) /g)].map((m) => Number(m[1]));
}

function omitted(excerpt: string): number[] {
	return [...excerpt.matchAll(MARKER)].map((m) => Number(m[1]));
}

describe("excerpt budget", () => {
	test("is 10% of the context window at 4 chars per token, clamped to 2k-20k tokens", () => {
		expect(excerptBudgetChars(200_000)).toBe(80_000);
		expect(excerptBudgetChars(128_000)).toBe(51_200);
		expect(excerptBudgetChars(1_000_000)).toBe(80_000);
		expect(excerptBudgetChars(8_000)).toBe(8_000);
		expect(excerptBudgetChars(null)).toBe(8_000);
	});
});

describe("excerpt layout", () => {
	test("a page under budget is sent whole", () => {
		const page = PARAGRAPHS.slice(0, 10).join("\n\n");
		expect(layoutExcerpt(page, [], BUDGET)).toBe(page);
		expect(layoutExcerpt(page, ["Paragraph 3 word"], BUDGET)).toBe(page);
	});

	test("without a highlight keeps ~75% start and ~25% end with an omission marker", () => {
		const excerpt = layoutExcerpt(PAGE, [], BUDGET);
		const [start, end] = blocks(excerpt);
		expect(blocks(excerpt)).toHaveLength(2);
		expect(start?.startsWith("Paragraph 0 ")).toBe(true);
		expect(end?.endsWith("end399.")).toBe(true);
		expect(start?.length).toBeGreaterThan(BUDGET * 0.7);
		expect(start?.length).toBeLessThanOrEqual(BUDGET * 0.75 + FILL);
		expect(end?.length).toBeGreaterThan(BUDGET * 0.2);
		expect(end?.length).toBeLessThanOrEqual(BUDGET * 0.25);
		const [count] = omitted(excerpt);
		expect(count).toBe(PAGE.length - (start?.length ?? 0) - (end?.length ?? 0));
	});

	test("uses the whole budget, within 2%, cutting pieces only between words", () => {
		for (const quotes of [
			[],
			["Paragraph 200 word"],
			["Paragraph 0 word"],
			["end399."],
			["Paragraph 100 word", "Paragraph 300 word"],
			["Paragraph 200 word", "Paragraph 202 word"],
		]) {
			const pieces = blocks(layoutExcerpt(PAGE, quotes, BUDGET));
			const used = pieces.reduce((sum, piece) => sum + piece.length, 0);
			expect(used).toBeGreaterThanOrEqual(BUDGET * 0.98);
			expect(used).toBeLessThanOrEqual(BUDGET);
			for (const piece of pieces) {
				const at = PAGE.indexOf(piece);
				expect(at).toBeGreaterThanOrEqual(0);
				expect(PAGE[at - 1] ?? " ").toMatch(/\s/);
				expect(PAGE[at + piece.length] ?? " ").toMatch(/\s/);
			}
		}
	});

	test("one highlight gets ~15% start, ~80% window centered on it at paragraph boundaries, ~5% end", () => {
		const excerpt = layoutExcerpt(PAGE, ["Paragraph 200 word word"], BUDGET);
		const parts = blocks(excerpt);
		expect(parts).toHaveLength(3);
		const [start, window, end] = parts as [string, string, string];
		expect(start.startsWith("Paragraph 0 ")).toBe(true);
		expect(start.length).toBeLessThanOrEqual(BUDGET * 0.15 + FILL);
		expect(window.startsWith("Paragraph ")).toBe(true);
		expect(window).toMatch(/end\d+\.$/);
		expect(window.length).toBeGreaterThan(BUDGET * 0.7);
		expect(window.length).toBeLessThanOrEqual(BUDGET * 0.8);
		const numbers = paragraphNumbers(window);
		expect(numbers).toContain(200);
		const before = 200 - (numbers[0] ?? 0);
		const after = (numbers.at(-1) ?? 0) - 200;
		expect(Math.abs(before - after)).toBeLessThanOrEqual(2);
		expect(end.endsWith("end399.")).toBe(true);
		expect(end.length).toBeLessThanOrEqual(BUDGET * 0.05);
	});

	test("a highlight at the very top becomes one block from the top of the page plus the end", () => {
		const excerpt = layoutExcerpt(PAGE, ["Paragraph 0 word"], BUDGET);
		const parts = blocks(excerpt);
		expect(parts).toHaveLength(2);
		const [top, end] = parts as [string, string];
		expect(top.startsWith("Paragraph 0 ")).toBe(true);
		expect(top.length).toBeGreaterThan(BUDGET * 0.85);
		expect(end.endsWith("end399.")).toBe(true);
		expect(end.length).toBeLessThanOrEqual(BUDGET * 0.05);
	});

	test("a highlight at the very bottom takes everything before it after the start piece", () => {
		const excerpt = layoutExcerpt(PAGE, ["end399."], BUDGET);
		const parts = blocks(excerpt);
		expect(parts).toHaveLength(2);
		const [start, bottom] = parts as [string, string];
		expect(start.startsWith("Paragraph 0 ")).toBe(true);
		expect(start.length).toBeLessThanOrEqual(BUDGET * 0.15 + FILL);
		expect(bottom.endsWith("end399.")).toBe(true);
		expect(bottom.startsWith("Paragraph ")).toBe(true);
		expect(bottom.length).toBeGreaterThan(BUDGET * 0.75);
	});

	test("several highlights split the window share", () => {
		const excerpt = layoutExcerpt(
			PAGE,
			["Paragraph 100 word", "Paragraph 300 word"],
			BUDGET,
		);
		const parts = blocks(excerpt);
		expect(parts).toHaveLength(4);
		const [, first, second] = parts as [string, string, string, string];
		expect(paragraphNumbers(first)).toContain(100);
		expect(paragraphNumbers(second)).toContain(300);
		for (const window of [first, second]) {
			expect(window.length).toBeGreaterThan(BUDGET * 0.3);
			expect(window.length).toBeLessThanOrEqual(BUDGET * 0.4);
		}
	});

	test("overlapping highlight windows merge so nothing is sent twice", () => {
		const excerpt = layoutExcerpt(
			PAGE,
			["Paragraph 200 word", "Paragraph 202 word"],
			BUDGET,
		);
		expect(blocks(excerpt)).toHaveLength(3);
		const numbers = paragraphNumbers(excerpt);
		expect(new Set(numbers).size).toBe(numbers.length);
		expect(numbers).toContain(200);
		expect(numbers).toContain(202);
	});

	test("a highlight that is not on the page falls back to the no-highlight layout", () => {
		expect(layoutExcerpt(PAGE, ["text that is nowhere"], BUDGET)).toBe(
			layoutExcerpt(PAGE, [], BUDGET),
		);
	});

	test("never exceeds the budget by more than its markers", () => {
		for (const quotes of [
			[],
			["Paragraph 0 word"],
			["end399."],
			["Paragraph 50 word", "Paragraph 51 word", "Paragraph 390 word"],
		]) {
			const excerpt = layoutExcerpt(PAGE, quotes, BUDGET);
			const markerChars = omitted(excerpt).length * 40;
			expect(excerpt.length).toBeLessThanOrEqual(BUDGET + markerChars);
		}
	});
});

describe("highlight matching", () => {
	test("ignores markdown syntax, link targets, case and whitespace", () => {
		const markdown =
			'Intro.\n\nThe **quick** brown [fox](https://example.com/fox "Fox")\njumps over _the_ lazy dog.\n\nOutro.';
		const [span] = locateHighlights(markdown, [
			"the quick  brown fox\n jumps over the LAZY dog",
		]);
		expect(span).toBeDefined();
		expect(markdown.slice(span?.start, span?.end)).toBe(
			'The **quick** brown [fox](https://example.com/fox "Fox")\njumps over _the_ lazy dog',
		);
	});

	test("overlapping highlights merge into one span", () => {
		const spans = locateHighlights("alpha beta gamma delta", [
			"alpha beta gamma",
			"gamma delta",
		]);
		expect(spans).toEqual([{ start: 0, end: 22 }]);
	});
});

describe("highlight window (same page, new highlight)", () => {
	test("sends only the window around the highlight, without start or end pieces", () => {
		const window = highlightWindow(PAGE, ["Paragraph 200 word"], BUDGET);
		expect(window).not.toBeNull();
		const text = window ?? "";
		expect(text).toMatch(/^\[… \d+ characters omitted …\]\n\n/);
		expect(text).toMatch(/\n\n\[… \d+ characters omitted …\]$/);
		expect(omitted(text)).toHaveLength(2);
		const body = text.replace(MARKER, "").trim();
		expect(body.startsWith("Paragraph ")).toBe(true);
		expect(paragraphNumbers(text)).toContain(200);
		expect(paragraphNumbers(text)).not.toContain(0);
		expect(paragraphNumbers(text)).not.toContain(399);
		expect(body.length).toBeLessThanOrEqual(BUDGET * 0.8);
	});

	test("is null when the highlight isn't on the page or the page is under budget", () => {
		expect(highlightWindow(PAGE, ["nowhere to be found"], BUDGET)).toBeNull();
		expect(highlightWindow("short page", ["short"], BUDGET)).toBeNull();
	});
});

describe("quotes", () => {
	test("are sent in full under the budget", () => {
		expect(capQuotes(["one", "two"], 100)).toEqual(["one", "two"]);
	});

	test("are capped at the budget against select-all", () => {
		const [capped] = capQuotes(["x".repeat(150)], 100);
		expect(capped).toBe(`${"x".repeat(100)}\n[… 50 characters omitted …]`);
		expect(capQuotes(["x".repeat(100), "second"], 100)).toEqual([
			"x".repeat(100),
			"[… 6 characters omitted …]",
		]);
	});
});

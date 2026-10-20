import { describe, expect, test } from "bun:test";
import { extractPage, fingerprint } from "./extract";

function makeDocument(body: string, title = "Doc"): Document {
	const doc = document.implementation.createHTMLDocument();
	doc.title = title;
	doc.body.innerHTML = body;
	return doc;
}

const ARTICLE = `
<nav>Home · About · Contact</nav>
<article>
	<h1>Readable heading</h1>
	${Array.from({ length: 8 }, (_, i) => `<p>Paragraph ${i} has enough words to look like real article content, with <strong>bold</strong> text and a <a href="https://example.com/${i}">link</a>.</p>`).join("\n")}
</article>
<footer>Copyright footer</footer>`;

describe("page extraction", () => {
	test("uses Readability converted to markdown for an article", () => {
		const page = extractPage(
			makeDocument(ARTICLE, "Article"),
			"https://example.com/a",
		);
		expect(page.readability).toBe("readable");
		expect(page.title).toBe("Article");
		expect(page.markdown).toContain("Paragraph 3 has enough words");
		expect(page.markdown).toContain("**bold**");
		expect(page.markdown).toContain("[link](https://example.com/3)");
		expect(page.markdown).not.toContain("Copyright footer");
	});

	test("falls back to visible text when Readability keeps under ~20% of it", () => {
		const grid = Array.from(
			{ length: 200 },
			(_, i) => `<div><span>Spec ${i}</span><span>value ${i}</span></div>`,
		).join("");
		const page = extractPage(
			makeDocument(
				`<article><p>Short intro paragraph about the product that is long enough.</p></article>${grid}`,
			),
			"https://example.com/product",
		);
		expect(page.readability).toBe("readable");
		expect(page.markdown).toContain("Spec 150");
	});

	test("falls back to visible text when Readability finds nothing", () => {
		const page = extractPage(
			makeDocument("<div>Just a tiny bit of text</div>"),
			"https://example.com/tiny",
		);
		expect(page.readability).toBe("readable");
		expect(page.markdown).toContain("Just a tiny bit of text");
	});

	test("YouTube, Google Docs and empty pages are unreadable", () => {
		for (const url of [
			"https://www.youtube.com/watch?v=x",
			"https://docs.google.com/document/d/1",
		]) {
			const page = extractPage(makeDocument(ARTICLE), url);
			expect(page).toEqual({
				url,
				title: "Doc",
				readability: "unreadable",
				markdown: "",
			});
		}
		expect(
			extractPage(
				makeDocument("<canvas></canvas>"),
				"https://example.com/canvas",
			).readability,
		).toBe("unreadable");
	});

	test("non-web pages are unreadable", () => {
		expect(
			extractPage(makeDocument(ARTICLE), "chrome://newtab/").readability,
		).toBe("unreadable");
	});

	test("fingerprint is stable for identical markdown and changes with content", async () => {
		const a = await fingerprint("same text");
		expect(a).toMatch(/^[0-9a-f]{64}$/);
		expect(await fingerprint("same text")).toBe(a);
		expect(await fingerprint("other text")).not.toBe(a);
	});
});

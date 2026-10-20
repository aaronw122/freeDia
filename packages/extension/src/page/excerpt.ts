export const CHARS_PER_TOKEN = 4;
export const MIN_EXCERPT_TOKENS = 2_000;
export const MAX_EXCERPT_TOKENS = 20_000;

const HEAD_SHARE = 0.75;
const START_SHARE = 0.15;
const WINDOW_SHARE = 0.8;
const END_SHARE = 0.05;
const SNAP_REACH = 0.25;
const GROW_PASSES = 16;

interface Span {
	start: number;
	end: number;
}

export function omittedMarker(count: number): string {
	return `[… ${count} characters omitted …]`;
}

export function excerptBudgetChars(contextWindow: number | null): number {
	const tokens =
		contextWindow === null
			? MIN_EXCERPT_TOKENS
			: Math.min(
					MAX_EXCERPT_TOKENS,
					Math.max(MIN_EXCERPT_TOKENS, Math.floor(contextWindow * 0.1)),
				);
	return tokens * CHARS_PER_TOKEN;
}

interface Normalized {
	text: string;
	starts: number[];
	ends: number[];
}

const LINK_DESTINATION = /\]\((?:[^()\s]|\([^()]*\))*(?:\s+"[^"]*")?\)/g;
const WORD_CHAR = /[\p{L}\p{N}]/u;

function normalize(source: string, skipLinkDestinations: boolean): Normalized {
	const skipped: Span[] = [];
	if (skipLinkDestinations) {
		for (const match of source.matchAll(LINK_DESTINATION)) {
			skipped.push({
				start: match.index + 1,
				end: match.index + match[0].length,
			});
		}
	}
	let text = "";
	const starts: number[] = [];
	const ends: number[] = [];
	let skipIndex = 0;
	let index = 0;
	for (const char of source) {
		const at = index;
		index += char.length;
		while (skipIndex < skipped.length && (skipped[skipIndex]?.end ?? 0) <= at) {
			skipIndex++;
		}
		const skip = skipped[skipIndex];
		if (skip !== undefined && skip.start <= at) {
			continue;
		}
		if (!WORD_CHAR.test(char)) {
			continue;
		}
		for (const lower of char.toLowerCase()) {
			text += lower;
			for (let i = 0; i < lower.length; i++) {
				starts.push(at);
				ends.push(at + char.length);
			}
		}
	}
	return { text, starts, ends };
}

export function locateHighlights(markdown: string, quotes: string[]): Span[] {
	const page = normalize(markdown, true);
	const found: Span[] = [];
	for (const quote of quotes) {
		const needle = normalize(quote, false).text;
		if (needle === "") {
			continue;
		}
		const at = page.text.indexOf(needle);
		const start = page.starts[at];
		const end = page.ends[at + needle.length - 1];
		if (at < 0 || start === undefined || end === undefined) {
			continue;
		}
		found.push({ start, end });
	}
	return mergeSpans(found);
}

function mergeSpans(spans: Span[]): Span[] {
	const sorted = [...spans].sort((a, b) => a.start - b.start);
	const merged: Span[] = [];
	for (const span of sorted) {
		const last = merged.at(-1);
		if (last !== undefined && span.start <= last.end) {
			last.end = Math.max(last.end, span.end);
		} else {
			merged.push({ ...span });
		}
	}
	return merged;
}

function covered(spans: Span[]): number {
	return spans.reduce((sum, span) => sum + span.end - span.start, 0);
}

function windowAround(highlight: Span, share: number, length: number): Span {
	const width = highlight.end - highlight.start;
	let start: number;
	let end: number;
	if (width >= share) {
		const center = (highlight.start + highlight.end) / 2;
		start = center - share / 2;
		end = center + share / 2;
	} else {
		const pad = (share - width) / 2;
		start = highlight.start - pad;
		end = highlight.end + pad;
	}
	if (start < 0) {
		end -= start;
		start = 0;
	}
	if (end > length) {
		start -= end - length;
		end = length;
	}
	return { start: Math.max(0, Math.round(start)), end: Math.round(end) };
}

function grow(
	spans: Span[],
	isGrowable: (span: Span) => boolean,
	amount: number,
	length: number,
): Span[] {
	const grown = spans.map((span) => ({ ...span }));
	for (let i = 0; i < grown.length; i++) {
		const span = grown[i];
		if (span === undefined || !isGrowable(span)) {
			continue;
		}
		const leftRoom = span.start - (grown[i - 1]?.end ?? 0);
		const rightRoom = (grown[i + 1]?.start ?? length) - span.end;
		let left = Math.min(amount / 2, leftRoom);
		const right = Math.min(amount - left, rightRoom);
		left = Math.min(amount - right, leftRoom);
		span.start -= Math.floor(left);
		span.end += Math.floor(right);
	}
	return mergeSpans(grown);
}

function planSpans(
	length: number,
	budget: number,
	highlights: Span[],
	withEdges: boolean,
): Span[] {
	const windowBudget = budget * WINDOW_SHARE;
	const share = windowBudget / highlights.length;
	const windows = highlights.map((h) => windowAround(h, share, length));
	const edges: Span[] = withEdges
		? [
				{ start: 0, end: Math.floor(budget * START_SHARE) },
				{ start: length - Math.floor(budget * END_SHARE), end: length },
			]
		: [];
	const total = Math.floor(withEdges ? budget : windowBudget);
	const holdsHighlight = (span: Span) =>
		highlights.some((h) => h.start >= span.start && h.end <= span.end);
	let spans = mergeSpans([...edges, ...windows]);
	for (let pass = 0; pass < GROW_PASSES; pass++) {
		const leftover = total - covered(spans);
		const growable = spans.filter(holdsHighlight);
		if (leftover < 1 || growable.length === 0) {
			break;
		}
		const next = grow(spans, holdsHighlight, leftover / growable.length, length);
		if (covered(next) === covered(spans)) {
			break;
		}
		spans = next;
	}
	return spans;
}

function snapStart(text: string, pos: number, limit: number): number {
	if (pos <= 0) {
		return 0;
	}
	for (const separator of ["\n\n", "\n"]) {
		const at = text.indexOf(separator, Math.max(0, pos - separator.length));
		let candidate = at + separator.length;
		if (at >= 0 && candidate >= pos && candidate <= limit) {
			while (text[candidate] === "\n" && candidate < limit) {
				candidate++;
			}
			return candidate;
		}
	}
	const rest = text.slice(pos, limit).search(/\s/);
	return rest >= 0 ? pos + rest + 1 : pos;
}

function snapEnd(text: string, pos: number, limit: number): number {
	if (pos >= text.length) {
		return text.length;
	}
	for (const separator of ["\n\n", "\n"]) {
		const at = text.lastIndexOf(separator, pos);
		if (at >= 0 && at >= limit) {
			return at;
		}
	}
	for (let i = pos; i > limit; i--) {
		if (/\s/.test(text[i] ?? "")) {
			return i;
		}
	}
	return pos;
}

function snapSpans(text: string, spans: Span[], highlights: Span[]): Span[] {
	return spans.map((span) => {
		const inside = highlights.filter(
			(h) => h.start >= span.start && h.end <= span.end,
		);
		const reach = Math.floor((span.end - span.start) * SNAP_REACH);
		const startLimit = Math.min(
			span.start + reach,
			...inside.map((h) => h.start),
		);
		const endLimit = Math.max(span.end - reach, ...inside.map((h) => h.end));
		return {
			start: snapStart(text, span.start, startLimit),
			end: snapEnd(text, span.end, endLimit),
		};
	});
}

function render(text: string, spans: Span[]): string {
	const parts: string[] = [];
	let cursor = 0;
	for (const span of spans) {
		if (span.start > cursor) {
			parts.push(omittedMarker(span.start - cursor));
		}
		parts.push(text.slice(span.start, span.end).replace(/^\n+|\n+$/g, ""));
		cursor = span.end;
	}
	if (cursor < text.length) {
		parts.push(omittedMarker(text.length - cursor));
	}
	return parts.join("\n\n");
}

export function layoutExcerpt(
	markdown: string,
	quotes: string[],
	budget: number,
): string {
	if (markdown.length <= budget) {
		return markdown;
	}
	const highlights = locateHighlights(markdown, quotes);
	if (highlights.length === 0) {
		const head = Math.floor(budget * HEAD_SHARE);
		const tail = markdown.length - (budget - head);
		const spans = [
			{ start: 0, end: snapEnd(markdown, head, head - Math.floor(head * SNAP_REACH)) },
			{
				start: snapStart(
					markdown,
					tail,
					tail + Math.floor((budget - head) * SNAP_REACH),
				),
				end: markdown.length,
			},
		];
		return render(markdown, spans);
	}
	const spans = planSpans(markdown.length, budget, highlights, true);
	return render(markdown, snapSpans(markdown, spans, highlights));
}

export function highlightWindow(
	markdown: string,
	quotes: string[],
	budget: number,
): string | null {
	if (markdown.length <= budget) {
		return null;
	}
	const highlights = locateHighlights(markdown, quotes);
	if (highlights.length === 0) {
		return null;
	}
	const spans = planSpans(markdown.length, budget, highlights, false);
	return render(markdown, snapSpans(markdown, spans, highlights));
}

export function capQuotes(quotes: string[], budget: number): string[] {
	const capped: string[] = [];
	let remaining = budget;
	for (const quote of quotes) {
		if (remaining <= 0) {
			capped.push(omittedMarker(quote.length));
			continue;
		}
		if (quote.length <= remaining) {
			capped.push(quote);
			remaining -= quote.length;
			continue;
		}
		capped.push(
			`${quote.slice(0, remaining)}\n${omittedMarker(quote.length - remaining)}`,
		);
		remaining = 0;
	}
	return capped;
}

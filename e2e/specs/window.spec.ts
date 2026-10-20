import { ChatPage } from "../fixtures/chat";
import { expect, test } from "../fixtures/test";

test("ENSURE 8: drag, resize and expand persist across a reload", async ({
	freedia,
	site,
}) => {
	const chat = await ChatPage.open(
		freedia.requireContext(),
		site.url("/article"),
	);
	await chat.open();
	const start = await chat.dialog.boundingBox();
	if (start === null) throw new Error("chat window has no box");

	const { mouse } = chat.page;
	await mouse.move(start.x + start.width / 2, start.y + 20);
	await mouse.down();
	await mouse.move(start.x + start.width / 2 - 300, start.y + 140, {
		steps: 8,
	});
	await mouse.up();
	const moved = await chat.dialog.boundingBox();
	expect(moved?.x).toBeCloseTo(start.x - 300, 0);
	expect(moved?.y).toBeCloseTo(start.y + 120, 0);

	const corner = chat.dialog.locator('[data-resize="se"]');
	const handle = await corner.boundingBox();
	if (handle === null || moved === null) throw new Error("no resize handle");
	await mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
	await mouse.down();
	await mouse.move(
		handle.x + handle.width / 2 + 80,
		handle.y + handle.height / 2 - 60,
		{ steps: 8 },
	);
	await mouse.up();
	const resized = await chat.dialog.boundingBox();
	expect(resized?.width).toBeCloseTo(moved.width + 80, 0);
	expect(resized?.height).toBeCloseTo(moved.height - 60, 0);
	expect(resized?.x).toBeCloseTo(moved.x, 0);

	await chat.reload();
	await chat.open();
	await expect.poll(() => chat.dialog.boundingBox()).toEqual(resized);

	await chat.button("Expand").click();
	await expect(chat.button("Collapse")).toBeVisible();
	const expanded = await chat.dialog.boundingBox();
	expect(expanded?.height).toBeGreaterThan((resized?.height ?? 0) + 100);

	await chat.reload();
	await chat.open();
	await expect(chat.button("Collapse")).toBeVisible();
	await expect.poll(() => chat.dialog.boundingBox()).toEqual(expanded);

	await chat.button("Collapse").click();
	await expect.poll(() => chat.dialog.boundingBox()).toEqual(resized);
});

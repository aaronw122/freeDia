import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import type { Server } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type BrowserContext,
	chromium,
	expect,
	type Page,
	test,
} from "@playwright/test";
import { startHttpsFixture } from "./fixture-server";

const extensionPath = join(import.meta.dirname, "extension/.output/chrome-mv3");
const headless = process.env.SPIKE_HEADED !== "1";

let context: BrowserContext;
let server: Server;
let origin: string;

const readState = async (
	page: Page,
	attr: "data-spike-cs" | "data-spike-page",
) => JSON.parse((await page.locator("html").getAttribute(attr)) ?? "null");

const log = (label: string, value: unknown) =>
	console.log(`[S2] ${label}: ${JSON.stringify(value)}`);

test.beforeAll(async () => {
	({ server, origin } = await startHttpsFixture());
	context = await chromium.launchPersistentContext(
		mkdtempSync(join(tmpdir(), "freedia-s2-profile-")),
		{
			channel: "chromium",
			headless,
			ignoreHTTPSErrors: true,
			args: [
				`--disable-extensions-except=${extensionPath}`,
				`--load-extension=${extensionPath}`,
			],
		},
	);
	log("browserVersion", context.browser()?.version() ?? null);
	log("headless", headless);
});

test.afterAll(async () => {
	await context.close();
	server.close();
});

const serviceWorker = async () =>
	context.serviceWorkers()[0] ?? (await context.waitForEvent("serviceworker"));

const openFixture = async () => {
	const page = await context.newPage();
	await page.goto(`${origin}/`);
	await expect(page.locator("html")).toHaveAttribute(
		"data-spike-cs",
		/isolated/,
	);
	return page;
};

test("a: commands registered in manifest and visible to chrome.commands.getAll", async () => {
	const sw = await serviceWorker();
	const commands = await sw.evaluate(() => chrome.commands.getAll());
	log("commands.getAll", commands);
	const openChat = commands.find((c) => c.name === "open-chat");
	expect(openChat?.shortcut).toBeTruthy();
});

test("a: Playwright keyboard Meta+Shift+E does or does not fire chrome.commands", async () => {
	const page = await openFixture();
	await page.bringToFront();
	await page.keyboard.press("Meta+Shift+E");
	await page.waitForTimeout(1500);
	const sw = await serviceWorker();
	const stored = await sw.evaluate(() => chrome.storage.local.get("commands"));
	const cs = await readState(page, "data-spike-cs");
	const pageState = await readState(page, "data-spike-page");
	log("commands fired after Meta+Shift+E", stored.commands ?? []);
	log("content-script keys", cs.keys);
	log("page keys", pageState.keys);
	await page.close();
});

test("b: content-script keydown Meta+E reaches handler, preventDefault blocks page listener, opens PiP", async () => {
	const page = await openFixture();
	await page.keyboard.press("Meta+e");
	await page.waitForTimeout(1000);
	const cs = await readState(page, "data-spike-cs");
	const pageState = await readState(page, "data-spike-page");
	log("cs keys", cs.keys);
	log("cs pip", cs.pip);
	log("page keys", pageState.keys);
	log(
		"pages in context",
		context.pages().map((p) => p.url()),
	);
	expect(
		cs.keys.some(
			(k: { code: string; meta: boolean }) => k.code === "KeyE" && k.meta,
		),
	).toBe(true);
	await page.close();
});

test("d: PiP from content-script click (isolated world)", async () => {
	const page = await openFixture();
	await page.locator("#freedia-spike-host").locator("#cs-open-pip").click();
	await page.waitForTimeout(1000);
	const cs = await readState(page, "data-spike-cs");
	log("cs pip after click", cs.pip);
	log(
		"pages in context",
		context.pages().map((p) => p.url()),
	);
	await page.close();
});

test("d: PiP from page-world click", async () => {
	const page = await openFixture();
	await page.locator("#page-open-pip").click();
	await page.waitForTimeout(1000);
	const pageState = await readState(page, "data-spike-page");
	log("page pip after click", pageState.pip);
	await page.close();
});

test("d: PiP without user activation (page load timer) is rejected", async () => {
	const page = await context.newPage();
	await page.goto(`${origin}/?auto`);
	await page.waitForTimeout(1000);
	log(
		"page-world requestWindow without activation",
		(await readState(page, "data-spike-page")).pip,
	);
	await page.close();
});

const osKeystroke = (modifiers: string) => {
	try {
		return execFileSync("osascript", [
			"-e",
			'tell application "System Events" to set frontmost of process "Google Chrome for Testing" to true',
			"-e",
			"delay 0.5",
			"-e",
			'tell application "System Events" to set frontApp to name of first process whose frontmost is true',
			"-e",
			`if frontApp is "Google Chrome for Testing" then tell application "System Events" to keystroke "e" using {${modifiers}}`,
			"-e",
			"return frontApp",
		])
			.toString()
			.trim();
	} catch (error) {
		return `error: ${error instanceof Error ? error.message : String(error)}`;
	}
};

test("a+d: OS-level Cmd+Shift+E via osascript fires command; PiP from command message", async () => {
	test.skip(headless, "needs a real window focused by macOS");
	const page = await openFixture();
	await page.bringToFront();
	log("osascript", osKeystroke("command down, shift down"));
	await page.waitForTimeout(2000);
	const sw = await serviceWorker();
	log(
		"commands fired after OS keystroke",
		(await sw.evaluate(() => chrome.storage.local.get("commands"))).commands ??
			[],
	);
	const cs = await readState(page, "data-spike-cs");
	log("cs commandsReceived", cs.commandsReceived);
	log("cs pip", cs.pip);
	log("cs keys", cs.keys);
	await page.close();
});

test("b: OS-level Cmd+E via osascript reaches content-script keydown in Chromium", async () => {
	test.skip(headless, "needs a real window focused by macOS");
	const page = await openFixture();
	await page.bringToFront();
	await page.locator("#text").selectText();
	log("osascript", osKeystroke("command down"));
	await page.waitForTimeout(2000);
	const cs = await readState(page, "data-spike-cs");
	const pageState = await readState(page, "data-spike-page");
	log("cs keys", cs.keys);
	log("cs pip", cs.pip);
	log("page keys", pageState.keys);
	await page.close();
});

test("d: content-script PiP survives tab switch and new tab, closes on opener navigation", async () => {
	const page = await openFixture();
	const pipPromise = context
		.waitForEvent("page", { timeout: 5000 })
		.catch(() => null);
	await page.locator("#freedia-spike-host").locator("#cs-open-pip").click();
	const pipPage = await pipPromise;
	log("pip page url", pipPage?.url() ?? null);
	await page.waitForTimeout(500);
	log("cs pip after open", (await readState(page, "data-spike-cs")).pip);

	if (pipPage) {
		const hostInPip = await pipPage.evaluate(
			() => document.getElementById("freedia-spike-host") !== null,
		);
		log("spike host element now inside PiP document", hostInPip);
		await pipPage.locator("#freedia-spike-host").locator("#cs-count").click();
		log(
			"cs clicks after clicking button inside PiP",
			(await readState(page, "data-spike-cs")).clicks,
		);
	}

	const other = await context.newPage();
	await other.goto(`${origin}/?other`);
	await other.bringToFront();
	await other.waitForTimeout(1500);
	log("after switching to other tab: pip closed?", pipPage?.isClosed() ?? null);
	log("cs pip after tab switch", (await readState(page, "data-spike-cs")).pip);

	await page.bringToFront();
	await page.waitForTimeout(500);
	log("after switching back: pip closed?", pipPage?.isClosed() ?? null);

	await page.goto(`${origin}/?navigated`);
	await page.waitForTimeout(1500);
	log("after opener navigation: pip closed?", pipPage?.isClosed() ?? null);
	await other.close();
	await page.close();
});

test("d: second tab opening PiP while first tab's PiP is open", async () => {
	const first = await openFixture();
	const firstPip = context
		.waitForEvent("page", { timeout: 5000 })
		.catch(() => null);
	await first.locator("#freedia-spike-host").locator("#cs-open-pip").click();
	const firstPipPage = await firstPip;
	const second = await openFixture();
	await second.bringToFront();
	const secondPip = context
		.waitForEvent("page", { timeout: 5000 })
		.catch(() => null);
	await second.locator("#freedia-spike-host").locator("#cs-open-pip").click();
	const secondPipPage = await secondPip;
	await second.waitForTimeout(1000);
	log("first pip closed after second opened", firstPipPage?.isClosed() ?? null);
	log("second pip open", secondPipPage ? !secondPipPage.isClosed() : null);
	log("first cs pip", (await readState(first, "data-spike-cs")).pip);
	log("second cs pip", (await readState(second, "data-spike-cs")).pip);
	await first.close();
	await second.close();
});

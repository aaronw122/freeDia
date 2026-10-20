import { writeFileSync } from "node:fs";
import { test as base } from "@playwright/test";
import {
	createHome,
	FreediaBrowser,
	type FreediaHome,
	readLog,
	removeHome,
	waitForNoPi,
} from "./env";
import { type Site, startSite } from "./site";

interface Fixtures {
	helperEnv: Record<string, string>;
	home: FreediaHome;
	freedia: FreediaBrowser;
}

export const test = base.extend<Fixtures, { siteHost: string; site: Site }>({
	siteHost: ["127.0.0.1", { scope: "worker", option: true }],
	site: [
		async ({ siteHost }, use) => {
			const site = await startSite(siteHost);
			await use(site);
			await site.close();
		},
		{ scope: "worker" },
	],
	helperEnv: [{}, { option: true }],
	home: async ({ helperEnv }, use, testInfo) => {
		const home = createHome(helperEnv);
		await use(home);
		if (testInfo.status !== testInfo.expectedStatus) {
			await testInfo.attach("helper.log", {
				body: readLog(home),
				contentType: "text/plain",
			});
		}
		await waitForNoPi(home).catch(() => undefined);
		removeHome(home);
	},
	freedia: async ({ home }, use, testInfo) => {
		const browser = new FreediaBrowser(home);
		await browser.launch();
		await use(browser);
		if (testInfo.status !== testInfo.expectedStatus) {
			const traffic = await browser.traffic().catch((error) => String(error));
			const path = testInfo.outputPath("native-traffic.txt");
			writeFileSync(path, traffic);
			await testInfo.attach("native-traffic.txt", {
				path,
				contentType: "text/plain",
			});
		}
		await browser.dispose();
	},
});

export { expect } from "@playwright/test";

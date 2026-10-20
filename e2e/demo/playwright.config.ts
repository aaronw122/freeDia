import { defineConfig } from "@playwright/test";

export default defineConfig({
	testDir: ".",
	globalSetup: "../fixtures/global-setup.ts",
	outputDir: "../test-results/demo",
	workers: 1,
	timeout: 120_000,
	expect: { timeout: 15_000 },
	reporter: "list",
});

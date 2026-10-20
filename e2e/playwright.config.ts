import { defineConfig } from "@playwright/test";

export default defineConfig({
	testDir: "./specs",
	globalSetup: "./fixtures/global-setup.ts",
	fullyParallel: false,
	workers: 1,
	timeout: 120_000,
	expect: { timeout: 15_000 },
	reporter: process.env.CI ? "github" : "list",
	use: {
		trace: "retain-on-failure",
	},
});

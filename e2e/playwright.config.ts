import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
	testDir: "./specs",
	fullyParallel: false,
	workers: 1,
	reporter: process.env.CI ? "github" : "list",
	use: {
		trace: "retain-on-failure",
	},
	projects: [
		{
			name: "chromium",
			use: { ...devices["Desktop Chrome"], channel: "chromium" },
		},
	],
});

import { defineConfig } from "@playwright/test";

export default defineConfig({
	testDir: ".",
	testMatch: "*.spike.ts",
	fullyParallel: false,
	workers: 1,
	reporter: "list",
	timeout: 60_000,
});

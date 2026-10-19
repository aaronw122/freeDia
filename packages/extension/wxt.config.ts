import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "wxt";

export default defineConfig({
	srcDir: "src",
	modules: ["@wxt-dev/module-react"],
	manifest: {
		name: "freeDia",
		description: "Chat with your tab using your own AI subscriptions.",
		permissions: ["nativeMessaging"],
	},
	vite: () => ({
		plugins: [tailwindcss()],
	}),
});

import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "wxt";

export default defineConfig({
	srcDir: "src",
	modules: ["@wxt-dev/module-react"],
	manifest: {
		name: "freeDia",
		description: "Chat with your tab using your own AI subscriptions.",
		key: "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAvIIpmysyBfZC1jHT5CP2Yhh2+dVfmqaBSwssgUybJrhTls9kbA/JM3Q++BGZFnZf5HYm7+cbGXpGpkCs90DiChkA5gG+f6PXIHKon3Kzx9hhbjTMC955o2v+JVGHuBOvTSHCDOdSUzO6l32rbasc7PfNpAZhiBh4jnHsTeqVW1HoT182ODYxAAySMsdLEM10mC+QJU/SF8neHdskXpBjaIf6FQuMtipxSFdgEyJbpkz2dN4KkKycbfP4sSk5J5ZixZMTiyarMxaaDSF8eDMu+8g9V95iQQrKxegSSG0MpI18dxX/trK2QKyvc28NMfF2lBCIVocW1tYDJXkfiYS/5QIDAQAB",
		permissions: ["nativeMessaging", "storage", "scripting", "activeTab"],
		commands: {
			"open-chat": {
				suggested_key: { default: "Ctrl+Shift+E", mac: "Command+Shift+E" },
				description: "Open freeDia chat",
			},
		},
		web_accessible_resources: [
			{
				resources: ["chat-ui.js"],
				matches: ["http://*/*", "https://*/*"],
			},
		],
	},
	vite: () => ({
		plugins: [tailwindcss()],
	}),
});

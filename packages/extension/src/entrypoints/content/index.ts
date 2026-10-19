import "~/assets/tailwind.css";

export default defineContentScript({
	matches: ["http://*/*", "https://*/*"],
	cssInjectionMode: "ui",
	main() {},
});

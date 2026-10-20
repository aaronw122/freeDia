export default {
	srcDir: "src",
	manifest: {
		name: "freeDia spike S2",
		permissions: ["storage", "tabs"],
		commands: {
			"open-chat": {
				suggested_key: { default: "Ctrl+Shift+E", mac: "Command+Shift+E" },
				description: "Open freeDia chat",
			},
		},
	},
};

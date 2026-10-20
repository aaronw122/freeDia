const port = Number(process.env.PORT ?? 47801);

const page = `<!doctype html><meta charset="utf-8"><title>freeDia UA probe</title>
<pre id="out">probing…</pre>
<script>
(async () => {
	const uad = navigator.userAgentData;
	const result = {
		userAgent: navigator.userAgent,
		vendor: navigator.vendor,
		brands: uad ? uad.brands : null,
		mobile: uad ? uad.mobile : null,
		platform: uad ? uad.platform : null,
		highEntropy: uad ? await uad.getHighEntropyValues(["fullVersionList", "uaFullVersion", "platformVersion", "architecture", "model"]) : null,
		hasDocumentPictureInPicture: "documentPictureInPicture" in window,
		isSecureContext: window.isSecureContext,
		windowGlobals: Object.getOwnPropertyNames(window).sort(),
		chromeKeys: window.chrome ? Object.keys(window.chrome).sort() : null,
	};
	document.getElementById("out").textContent = JSON.stringify(result, null, 2);
	await fetch("/report" + location.search, { method: "POST", body: JSON.stringify(result) });
})();
</script>`;

Bun.serve({
	port,
	hostname: "127.0.0.1",
	async fetch(req) {
		const url = new URL(req.url);
		if (url.pathname === "/report") {
			const body = await req.text();
			const label = url.searchParams.get("from") ?? "unknown";
			await Bun.write(`${import.meta.dirname}/.ua-${label}.json`, body);
			console.log(`REPORT ${label} ${body.length} bytes`);
			return new Response("ok");
		}
		return new Response(page, { headers: { "content-type": "text/html" } });
	},
});

console.log(`listening on http://127.0.0.1:${port}/`);

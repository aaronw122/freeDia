import { buildAll, startFauxServer } from "./env";

export default async function globalSetup(): Promise<() => void> {
	if (process.env.FREEDIA_E2E_SKIP_BUILD !== "1") {
		buildAll();
	}
	const faux = await startFauxServer();
	return () => faux.kill();
}

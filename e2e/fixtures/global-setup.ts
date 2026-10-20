import { buildAll } from "./env";

export default function globalSetup(): void {
	if (process.env.FREEDIA_E2E_SKIP_BUILD !== "1") {
		buildAll();
	}
}

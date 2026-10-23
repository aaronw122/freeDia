import { bunAddOmp, OMP_VERSION } from "./install";
import { freediaPaths } from "./paths";

const home = process.argv[2];
if (home === undefined) throw new Error("HOME argument is required");
await bunAddOmp(
	freediaPaths(home),
	OMP_VERSION,
	process.execPath,
	() => undefined,
);

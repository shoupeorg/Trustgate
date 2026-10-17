// Copies the shared negotiation ledger from the site (lib/negotiation.ts) before each build.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const here = path.dirname(fileURLToPath(import.meta.url));
fs.copyFileSync(path.join(here, "../../lib/negotiation.ts"), path.join(here, "../src/negotiation.ts"));

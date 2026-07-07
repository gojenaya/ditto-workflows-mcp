// Local preferences, persisted per-user. Default variant resolution:
// config file (set via the set_default_variant tool) > DITTO_DEFAULT_VARIANT env.
//
// State lives in ~/.ditto-workflows-mcp/ (override with DITTO_DATA_DIR) — NOT
// next to this script: under `npx` the package sits in a throwaway cache dir,
// so anything written beside it would vanish between runs. A legacy
// .ditto-config.json next to the script (pre-0.6 clone installs) is still read.
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const DATA_DIR =
  process.env.DITTO_DATA_DIR || path.join(os.homedir(), ".ditto-workflows-mcp");
export const CONFIG_PATH = path.join(DATA_DIR, "config.json");
const LEGACY_CONFIG_PATH = path.join(__dirname, ".ditto-config.json");

function readConfig() {
  for (const p of [CONFIG_PATH, LEGACY_CONFIG_PATH]) {
    try {
      return JSON.parse(fs.readFileSync(p, "utf8"));
    } catch { /* try next */ }
  }
  return {};
}

export function getDefaultVariant() {
  return readConfig().defaultVariant || process.env.DITTO_DEFAULT_VARIANT || null;
}

export function setDefaultVariant(variantId) {
  const cfg = readConfig();
  cfg.defaultVariant = variantId;
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2) + "\n");
}

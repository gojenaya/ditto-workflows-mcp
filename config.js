// Local preferences, persisted to .ditto-config.json next to this script
// (gitignored — per-user, per-workspace). Default variant resolution:
// config file (set via the set_default_variant tool) > DITTO_DEFAULT_VARIANT env.
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = path.join(__dirname, ".ditto-config.json");

function readConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
  } catch {
    return {};
  }
}

export function getDefaultVariant() {
  return readConfig().defaultVariant || process.env.DITTO_DEFAULT_VARIANT || null;
}

export function setDefaultVariant(variantId) {
  const cfg = readConfig();
  cfg.defaultVariant = variantId;
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2) + "\n");
}

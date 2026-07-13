// Dotenv loading. Mirrors sdkv1/dotenv.go.
import { config } from "dotenv";

/**
 * Loads an env file into process.env (defaults to ".env"), like Go's NewEnv.
 * Missing files are ignored, matching godotenv.Load's best-effort behavior.
 */
export function loadEnv(path = ".env"): void {
  config({ path });
}

/** Reads an env var, warning (but not failing) when unset — like Go's getEnvVar. */
export function getEnvVar(key: string): string {
  const v = process.env[key];
  if (v === undefined) {
    console.log(`Environment variable not set ${key}`);
    return "";
  }
  return v;
}

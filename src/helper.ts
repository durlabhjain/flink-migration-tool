// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Resolves environment variable placeholders in config values
 * Supports ${VAR_NAME} syntax
 * Example: "${STARROCKS_HOST}" -> "starrocks.example.com"
 */
export function resolveEnvVars(value: string): string {
  return value.replace(/\$\{([^}]+)\}/g, (match, envVar) => {
    const envValue = process.env[envVar];
    if (envValue === undefined) {
      console.warn(`⚠️  Environment variable ${envVar} is not set, using placeholder: ${match}`);
      return match;
    }
    return envValue;
  });
}

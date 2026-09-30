/**
 * Production safety verification helpers.
 * Requirement 19: Tests must fail fast if they detect a production database/environment.
 * Strictly forbids running destructive tests against hosted production.
 */

export const KNOWN_TEST_HOSTS = new Set([
  '127.0.0.1',
  'localhost',
  'xe-test.supabase.co',
])

export class ProductionSafetyError extends Error {
  constructor(message: string) {
    super(`[PRODUCTION_SAFETY_VIOLATION] ${message}`)
    this.name = 'ProductionSafetyError'
  }
}

/**
 * Validates that the provided Supabase URL is safe for testing.
 * Rejects any non-local, non-mocked production domains.
 */
export function assertNotProductionUrl(url?: string | null): void {
  if (!url) return

  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new ProductionSafetyError(`Malformed URL cannot be verified for safety: "${url}"`)
  }

  // If pointing to hosted supabase.co, must be explicitly the isolated mock test host
  if (parsed.hostname.endsWith('.supabase.co')) {
    if (!KNOWN_TEST_HOSTS.has(parsed.hostname)) {
      throw new ProductionSafetyError(
        `Automated tests attempted to target hosted Supabase URL: "${url}". Tests are forbidden from communicating with live production.`
      )
    }
  }

  // Must not target live external production IP/host
  if (!KNOWN_TEST_HOSTS.has(parsed.hostname) && !parsed.hostname.endsWith('.local') && !parsed.hostname.endsWith('.test')) {
    throw new ProductionSafetyError(
      `Tests cannot run against untrusted external host: "${parsed.hostname}". Allowed hosts: ${Array.from(KNOWN_TEST_HOSTS).join(', ')}`
    )
  }
}

/**
 * Asserts that the test environment does not declare production mode.
 */
export function assertTestEnvironment(): void {
  const env = process.env.NODE_ENV
  if (env === 'production') {
    throw new ProductionSafetyError(
      'Automated test suite attempted to execute with NODE_ENV="production". This is strictly disallowed.'
    )
  }
}

/**
 * Verifies that a PostgreSQL database connection points to a local or ephemeral test database.
 */
export function assertLocalPostgres(connectionStringOrHost?: string): void {
  if (!connectionStringOrHost) return

  if (connectionStringOrHost.includes('@')) {
    try {
      const parsed = new URL(connectionStringOrHost)
      if (!KNOWN_TEST_HOSTS.has(parsed.hostname)) {
        throw new ProductionSafetyError(
          `Database connection targets non-local host: "${parsed.hostname}". Tests must only use embedded or local test instances.`
        )
      }
    } catch {
      // not a url, check plain string
    }
  }

  if (
    connectionStringOrHost.includes('supabase.com') ||
    connectionStringOrHost.includes('pooler.supabase.com') ||
    connectionStringOrHost.includes('aws.neon.tech')
  ) {
    throw new ProductionSafetyError(
      `Detected cloud production database provider in connection string. Refusing test execution.`
    )
  }
}

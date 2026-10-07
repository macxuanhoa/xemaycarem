import { describe, expect, it } from 'vitest'
import {
  assertLocalPostgres,
  assertNotProductionUrl,
  assertTestEnvironment,
  ProductionSafetyError,
} from '../helpers/db-safety'

/**
 * Requirement 19: Production Safety
 * Tests must fail fast if they detect a production database/environment.
 * Strictly forbids running destructive tests against hosted production.
 */

describe('Production Safety Safeguards', () => {
  it('allows safe local and simulated test hosts', () => {
    expect(() => assertNotProductionUrl('http://127.0.0.1:4174')).not.toThrow()
    expect(() => assertNotProductionUrl('http://localhost:54321')).not.toThrow()
    expect(() => assertNotProductionUrl('https://xe-test.supabase.co')).not.toThrow()
    expect(() => assertNotProductionUrl('http://app.local')).not.toThrow()
    expect(() => assertNotProductionUrl(null)).not.toThrow()
    expect(() => assertNotProductionUrl(undefined)).not.toThrow()
  })

  it('fails fast and throws when given a real or hosted production Supabase project URL', () => {
    const dangerousUrls = [
      'https://abcdefghijklm.supabase.co',
      'https://xe-prod.supabase.co',
      'https://carem-motor.supabase.co',
      'https://my-store.supabase.co',
    ]

    for (const url of dangerousUrls) {
      expect(() => assertNotProductionUrl(url)).toThrow(ProductionSafetyError)
    }
  })

  it('fails fast when given arbitrary untrusted external production domains', () => {
    const externalUrls = [
      'https://api.cuahangxemaycarem.com',
      'https://motorcycle-crm.internal.corp',
      'http://192.168.1.100:8000',
    ]

    for (const url of externalUrls) {
      expect(() => assertNotProductionUrl(url)).toThrow(ProductionSafetyError)
    }
  })

  it('throws on malformed URLs', () => {
    expect(() => assertNotProductionUrl('not-a-valid-url')).toThrow(ProductionSafetyError)
  })

  it('assertLocalPostgres rejects production cloud database connection strings', () => {
    expect(() =>
      assertLocalPostgres('postgresql://postgres.abc:pass@aws-0-ap-southeast-1.pooler.supabase.com:6543/postgres')
    ).toThrow(ProductionSafetyError)

    expect(() =>
      assertLocalPostgres('postgresql://user:pass@ep-cool-fog-12345.aws.neon.tech/neondb')
    ).toThrow(ProductionSafetyError)

    expect(() =>
      assertLocalPostgres('postgresql://postgres:secret@db.xyz.supabase.com:5432/postgres')
    ).toThrow(ProductionSafetyError)
  })

  it('assertLocalPostgres accepts local or embedded test database connections', () => {
    expect(() => assertLocalPostgres('postgresql://postgres:secret@127.0.0.1:5432/test_db')).not.toThrow()
    expect(() => assertLocalPostgres('postgresql://postgres:secret@localhost:5432/test_db')).not.toThrow()
    expect(() => assertLocalPostgres('postgresql://localhost:5432/test_db')).not.toThrow()
    expect(() => assertLocalPostgres(undefined)).not.toThrow()
  })

  it('rejects arbitrary external database URLs and plain hosts without swallowing the safety error', () => {
    for (const connection of [
      'postgresql://user:pass@database.example.com:5432/crm',
      'postgresql://user:pass@192.168.1.100:5432/crm',
      'database.example.com',
      '192.168.1.100',
      'xe-test.supabase.co',
      'not-a-url@host',
      'https://localhost/test_db',
      'postgresql://database.example.com:5432/crm',
    ]) {
      expect(() => assertLocalPostgres(connection)).toThrow(ProductionSafetyError)
    }
    expect(() => assertLocalPostgres('localhost')).not.toThrow()
    expect(() => assertLocalPostgres('127.0.0.1')).not.toThrow()
  })

  it('assertTestEnvironment detects and forbids running tests in NODE_ENV=production', () => {
    const originalEnv = process.env.NODE_ENV
    try {
      process.env.NODE_ENV = 'production'
      expect(() => assertTestEnvironment()).toThrow(ProductionSafetyError)
    } finally {
      process.env.NODE_ENV = originalEnv
    }
  })
})

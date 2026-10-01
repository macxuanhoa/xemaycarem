/**
 * Authentication and authorization test helpers for Xe Máy Cà Rem CRM.
 */

import { randomUUID } from 'node:crypto'
import type { Role } from '@/types'

export interface MockTokenOptions {
  userId?: string
  role?: string
  email?: string
  appRole?: Role
  expiresInSeconds?: number
}

/**
 * Creates a mock test JWT token without requiring external auth service.
 */
export function createMockJwt(options: MockTokenOptions = {}): string {
  const userId = options.userId ?? randomUUID()
  const exp = Math.floor(Date.now() / 1000) + (options.expiresInSeconds ?? 3600)

  const header = { alg: 'HS256', typ: 'JWT' }
  const payload = {
    sub: userId,
    aud: 'authenticated',
    role: options.role ?? 'authenticated',
    email: options.email ?? `${userId}@example.test`,
    app_metadata: {
      role: options.appRole ?? 'STAFF',
    },
    exp,
  }

  const encodedHeader = Buffer.from(JSON.stringify(header)).toString('base64url')
  const encodedPayload = Buffer.from(JSON.stringify(payload)).toString('base64url')

  return `${encodedHeader}.${encodedPayload}.mock-test-signature`
}

/**
 * Creates standard authorization header with mock JWT token.
 */
export function authHeader(tokenOrOptions: string | MockTokenOptions): { Authorization: string } {
  const token = typeof tokenOrOptions === 'string' ? tokenOrOptions : createMockJwt(tokenOrOptions)
  return { Authorization: `Bearer ${token}` }
}

import { afterEach, describe, expect, it, vi } from 'vitest'
import { dateValue, moneyValue, vehicleSchema } from '../src/features/vehicles/vehicleSchema'
import { csvCell } from '../src/lib/csv'
import { datePreset, daysInStock, money, today } from '../src/lib/format'
import { canFinance, canManage, canOperate, isOwner } from '../src/lib/permissions'
import type { Profile, Role } from '../src/types'

afterEach(() => vi.useRealTimers())

describe('VND and vehicle validation', () => {
  it('accepts exact VND and rejects fractional, negative, infinite and oversized amounts', () => {
    for (const valid of [0, 82_300_000, 1_000_000_000_000]) expect(moneyValue.safeParse(valid).success).toBe(true)
    for (const invalid of [-1, 0.1, NaN, Infinity, 1_000_000_000_001]) expect(moneyValue.safeParse(invalid).success).toBe(false)
  })
  it('rejects nonexistent calendar dates, not just malformed strings', () => {
    for (const valid of ['2024-02-29', '2026-09-30']) expect(dateValue.safeParse(valid).success).toBe(true)
    for (const invalid of ['2026-02-29', '2026-02-30', '2026-04-31', '2026-13-01', '30/09/2026', '']) expect(dateValue.safeParse(invalid).success).toBe(false)
  })
  it('validates operational creation with pending purchase cost and forbids SOLD assignment', () => {
    const vehicle = { brand: ' Honda ', model: 'SH 160', variant: '', license_plate: '', color: '', frame_number: '', engine_number: '', odometer: 0, purchase_date: '2026-09-30', asking_price: 90_000_000, supplier_name: '', supplier_phone: '', status: 'IN_STOCK', notes: '' }
    const result = vehicleSchema.parse(vehicle)
    expect(result.brand).toBe('Honda')
    expect(result.purchase_price).toBeUndefined()
    expect(vehicleSchema.safeParse({ ...vehicle, status: 'SOLD' }).success).toBe(false)
    expect(vehicleSchema.safeParse({ ...vehicle, model: '  ' }).success).toBe(false)
  })
})

describe('CSV safety', () => {
  it('quotes delimiters, line breaks and embedded quotes', () => {
    expect(csvCell('Xe, "A"\nDòng 2')).toBe('"Xe, ""A""\nDòng 2"')
    expect(csvCell(null)).toBe('""')
  })
  it('neutralizes spreadsheet formula prefixes including whitespace', () => {
    for (const value of ['=HYPERLINK("https://example.test")', '+SUM(A1:A2)', '-42', '@SUM(1)', '\t=1+1', '   +2']) expect(csvCell(value).startsWith('"\'')).toBe(true)
    expect(csvCell('Honda SH160')).toBe('"Honda SH160"')
  })
})

describe('Vietnam calendar boundaries', () => {
  it('uses the Vietnam date when UTC is still the previous day', () => {
    vi.useFakeTimers().setSystemTime(new Date('2026-09-30T18:30:00Z'))
    expect(today()).toBe('2026-10-01')
    expect(datePreset('today')).toEqual({ from: '2026-10-01', to: '2026-10-01' })
    expect(datePreset('yesterday')).toEqual({ from: '2026-09-30', to: '2026-09-30' })
    expect(datePreset('last-month')).toEqual({ from: '2026-09-01', to: '2026-09-30' })
    expect(datePreset('week')).toEqual({ from: '2026-09-28', to: '2026-10-01' })
    expect(daysInStock('2026-09-01')).toBe(30)
    expect(daysInStock('2026-10-02')).toBe(0)
  })
  it('handles previous-year and leap-month report boundaries', () => {
    vi.useFakeTimers().setSystemTime(new Date('2026-01-01T08:00:00Z'))
    expect(datePreset('last-month')).toEqual({ from: '2025-12-01', to: '2025-12-31' })
    vi.setSystemTime(new Date('2024-03-01T08:00:00Z'))
    expect(datePreset('last-month')).toEqual({ from: '2024-02-01', to: '2024-02-29' })
    expect(money(82_300_000)).toContain('82.300.000')
    expect(money(null)).toBe('—')
  })
})

describe('UI access helpers (database authorization is tested separately)', () => {
  const profile = (role: Role, financials = false, active = true): Profile => ({ id: 'test', full_name: 'Test', role, active, can_view_financials: financials })
  it('grants managers financial visibility only when explicitly enabled', () => {
    expect(canFinance(profile('OWNER'))).toBe(true)
    expect(canFinance(profile('MANAGER'))).toBe(false)
    expect(canFinance(profile('MANAGER', true))).toBe(true)
    expect(canFinance(profile('STAFF', true))).toBe(false)
    expect(canOperate(profile('STAFF'))).toBe(true)
    expect(canManage(profile('STAFF'))).toBe(false)
    expect(canOperate(profile('VIEWER'))).toBe(false)
    expect(isOwner(profile('MANAGER'))).toBe(false)
  })
  it('denies all permissions for disabled or absent profiles', () => {
    for (const check of [canFinance, canManage, canOperate, isOwner]) {
      expect(check(profile('OWNER', true, false))).toBe(false)
      expect(check(null)).toBe(false)
    }
  })
})

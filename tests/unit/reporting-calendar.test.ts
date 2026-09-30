import { afterEach, describe, expect, it, vi } from 'vitest'
import { dateLabel, datePreset, daysInStock, monthRange, today } from '@/lib/format'

afterEach(() => vi.useRealTimers())

describe('Reporting Calendar & Vietnam Timezone Boundaries (Asia/Ho_Chi_Minh)', () => {
  it('correctly reports local date when UTC is at 17:00 or later of previous day (+7h)', () => {
    // 2026-09-30 17:01 UTC is 2026-10-01 00:01 in Vietnam
    vi.useFakeTimers().setSystemTime(new Date('2026-09-30T17:01:00Z'))
    expect(today()).toBe('2026-10-01')
  })

  it('correctly reports local date when UTC is at 16:59 of same day (+7h)', () => {
    // 2026-09-30 16:59 UTC is 2026-09-30 23:59 in Vietnam
    vi.useFakeTimers().setSystemTime(new Date('2026-09-30T16:59:00Z'))
    expect(today()).toBe('2026-09-30')
  })

  it('calculates date presets accurately across New Year boundary (2026-01-01)', () => {
    vi.useFakeTimers().setSystemTime(new Date('2026-01-01T08:00:00Z'))
    expect(today()).toBe('2026-01-01')
    expect(datePreset('today')).toEqual({ from: '2026-01-01', to: '2026-01-01' })
    expect(datePreset('yesterday')).toEqual({ from: '2025-12-31', to: '2025-12-31' })
    expect(datePreset('last-month')).toEqual({ from: '2025-12-01', to: '2025-12-31' })
  })

  it('calculates last-month preset across February leap year (2024)', () => {
    vi.useFakeTimers().setSystemTime(new Date('2024-03-15T08:00:00Z'))
    expect(datePreset('last-month')).toEqual({ from: '2024-02-01', to: '2024-02-29' })
  })

  it('calculates last-month preset across February non-leap year (2025)', () => {
    vi.useFakeTimers().setSystemTime(new Date('2025-03-15T08:00:00Z'))
    expect(datePreset('last-month')).toEqual({ from: '2025-02-01', to: '2025-02-28' })
  })

  it('formats monthRange starting from the 1st of current Vietnam month', () => {
    vi.useFakeTimers().setSystemTime(new Date('2026-09-18T10:00:00Z'))
    expect(monthRange()).toEqual({ from: '2026-09-01', to: '2026-09-18' })
  })

  it('calculates days in stock accurately based on calendar days', () => {
    vi.useFakeTimers().setSystemTime(new Date('2026-09-30T10:00:00Z'))
    expect(daysInStock('2026-09-30')).toBe(0)
    expect(daysInStock('2026-09-29')).toBe(1)
    expect(daysInStock('2026-09-01')).toBe(29)
    // Future date should clamp to 0
    expect(daysInStock('2026-10-05')).toBe(0)
  })

  it('formats dateLabel with Vietnamese 2-digit format DD/MM/YYYY', () => {
    expect(dateLabel('2026-09-30')).toBe('30/09/2026')
    expect(dateLabel('2024-02-29')).toBe('29/02/2024')
    expect(dateLabel(null)).toBe('—')
    expect(dateLabel(undefined)).toBe('—')
    expect(dateLabel('')).toBe('—')
  })
})

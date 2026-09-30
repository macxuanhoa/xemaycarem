import { afterEach, describe, expect, it, vi } from 'vitest'
import { dateValue, moneyValue, vehicleSchema } from '@/features/vehicles/vehicleSchema'
import { paymentSchema, saleSchema } from '@/features/sales/saleSchema'
import { expenseSchema } from '@/features/expenses/ExpensePages'
import { csvCell } from '@/lib/csv'
import { datePreset, daysInStock, money, today } from '@/lib/format'
import { canFinance, canManage, canOperate, isOwner } from '@/lib/permissions'
import type { Profile, Role } from '@/types'

afterEach(() => vi.useRealTimers())

describe('VND and moneyValue validation', () => {
  it('accepts exact VND and valid monetary range [0, 1,000,000,000,000]', () => {
    for (const valid of [0, 1, 10_000, 82_300_000, 500_000_000, 1_000_000_000_000]) {
      const res = moneyValue.safeParse(valid)
      expect(res.success).toBe(true)
    }
  })

  it('rejects negative, fractional, infinite, NaN and oversized amounts', () => {
    for (const invalid of [-1, -100_000, 0.1, 0.5, 82_300_000.75, NaN, Infinity, -Infinity, 1_000_000_000_001, 9_999_999_999_999]) {
      const res = moneyValue.safeParse(invalid)
      expect(res.success).toBe(false)
    }
  })

  it('rejects non-numeric values passed to moneyValue', () => {
    for (const invalid of ['80000000', null, undefined, {}, [], true, '']) {
      const res = moneyValue.safeParse(invalid)
      expect(res.success).toBe(false)
    }
  })
})

describe('Calendar and dateValue validation', () => {
  it('accepts valid YYYY-MM-DD calendar dates', () => {
    for (const valid of ['2024-02-29', '2026-01-01', '2026-09-30', '2026-12-31']) {
      expect(dateValue.safeParse(valid).success).toBe(true)
    }
  })

  it('rejects nonexistent calendar dates (e.g. non-leap Feb 29, April 31)', () => {
    for (const invalid of ['2026-02-29', '2025-02-29', '2026-02-30', '2026-04-31', '2026-06-31', '2026-09-31', '2026-11-31']) {
      expect(dateValue.safeParse(invalid).success).toBe(false)
    }
  })

  it('rejects malformed, empty or inverted date strings', () => {
    for (const invalid of ['', '   ', '30/09/2026', '2026-9-30', '2026-13-01', '2026-00-10', '2026-05-00', 'not-a-date']) {
      expect(dateValue.safeParse(invalid).success).toBe(false)
    }
  })
})

describe('Vehicle form input validation (vehicleSchema)', () => {
  const baseVehicle = {
    brand: 'Honda',
    model: 'SH 160i',
    variant: 'ABS',
    license_plate: '29B1-123.45',
    year: 2024,
    color: 'Trắng',
    frame_number: 'RLH160-001',
    engine_number: 'KF160-001',
    odometer: 1500,
    purchase_date: '2026-09-30',
    purchase_price: 80_000_000,
    asking_price: 90_000_000,
    supplier_name: 'Nguyễn Văn A',
    supplier_phone: '0901234567',
    status: 'IN_STOCK' as const,
    notes: 'Xe đẹp',
  }

  it('validates a complete, valid vehicle object', () => {
    const parsed = vehicleSchema.parse(baseVehicle)
    expect(parsed.brand).toBe('Honda')
    expect(parsed.model).toBe('SH 160i')
    expect(parsed.purchase_price).toBe(80_000_000)
    expect(parsed.status).toBe('IN_STOCK')
  })

  it('trims whitespace on string fields automatically', () => {
    const input = {
      ...baseVehicle,
      brand: '   Yamaha   ',
      model: '   Exciter 155   ',
      license_plate: '  29B1-999.99  ',
      notes: '  Ghi chú có khoảng trắng  ',
    }
    const parsed = vehicleSchema.parse(input)
    expect(parsed.brand).toBe('Yamaha')
    expect(parsed.model).toBe('Exciter 155')
    expect(parsed.license_plate).toBe('29B1-999.99')
    expect(parsed.notes).toBe('Ghi chú có khoảng trắng')
  })

  it('supports operational creation with pending cost (purchase_price optional)', () => {
    const withoutCost = { ...baseVehicle, purchase_price: undefined }
    const parsed = vehicleSchema.parse(withoutCost)
    expect(parsed.purchase_price).toBeUndefined()
  })

  it('rejects empty or whitespace-only brand or model', () => {
    expect(vehicleSchema.safeParse({ ...baseVehicle, brand: '' }).success).toBe(false)
    expect(vehicleSchema.safeParse({ ...baseVehicle, brand: '   ' }).success).toBe(false)
    expect(vehicleSchema.safeParse({ ...baseVehicle, model: '' }).success).toBe(false)
    expect(vehicleSchema.safeParse({ ...baseVehicle, model: '   ' }).success).toBe(false)
  })

  it('forbids assigning status=SOLD directly on creation', () => {
    expect(vehicleSchema.safeParse({ ...baseVehicle, status: 'SOLD' }).success).toBe(false)
    expect(vehicleSchema.safeParse({ ...baseVehicle, status: 'UNKNOWN' }).success).toBe(false)
    expect(vehicleSchema.safeParse({ ...baseVehicle, status: 'RESERVED' }).success).toBe(true)
    expect(vehicleSchema.safeParse({ ...baseVehicle, status: 'CANCELLED' }).success).toBe(true)
  })

  it('rejects invalid year bounds (<1950 or far future)', () => {
    expect(vehicleSchema.safeParse({ ...baseVehicle, year: 1940 }).success).toBe(false)
    expect(vehicleSchema.safeParse({ ...baseVehicle, year: 2099 }).success).toBe(false)
    expect(vehicleSchema.safeParse({ ...baseVehicle, year: 2024 }).success).toBe(true)
  })

  it('rejects negative odometer or odometer exceeding 10,000,000 km', () => {
    expect(vehicleSchema.safeParse({ ...baseVehicle, odometer: -1 }).success).toBe(false)
    expect(vehicleSchema.safeParse({ ...baseVehicle, odometer: 10_000_001 }).success).toBe(false)
    expect(vehicleSchema.safeParse({ ...baseVehicle, odometer: 0 }).success).toBe(true)
    expect(vehicleSchema.safeParse({ ...baseVehicle, odometer: 99_999 }).success).toBe(true)
  })
})

describe('Sale form input validation (saleSchema)', () => {
  const baseSale = {
    customer_name: 'Trần Văn Khách',
    customer_phone: '0988776655',
    sale_price: 90_000_000,
    sale_date: '2026-09-30',
    initial_payment: 20_000_000,
    payment_method: 'CASH' as const,
    notes: 'Khách thanh toán trước một phần',
  }

  it('accepts valid sale input with initial payment less than or equal to sale price', () => {
    expect(saleSchema.safeParse(baseSale).success).toBe(true)
    // Full payment upfront is valid
    expect(saleSchema.safeParse({ ...baseSale, initial_payment: 90_000_000 }).success).toBe(true)
    // Zero initial payment is valid
    expect(saleSchema.safeParse({ ...baseSale, initial_payment: 0 }).success).toBe(true)
  })

  it('rejects initial payment greater than sale price', () => {
    const invalid = { ...baseSale, sale_price: 50_000_000, initial_payment: 50_000_001 }
    const result = saleSchema.safeParse(invalid)
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.issues.some((i) => i.path.includes('initial_payment'))).toBe(true)
    }
  })

  it('rejects missing or empty customer name', () => {
    expect(saleSchema.safeParse({ ...baseSale, customer_name: '' }).success).toBe(false)
    expect(saleSchema.safeParse({ ...baseSale, customer_name: '    ' }).success).toBe(false)
  })

  it('rejects invalid payment method enum', () => {
    expect(saleSchema.safeParse({ ...baseSale, payment_method: 'CRYPTO' }).success).toBe(false)
    expect(saleSchema.safeParse({ ...baseSale, payment_method: 'BANK_TRANSFER' }).success).toBe(true)
    expect(saleSchema.safeParse({ ...baseSale, payment_method: 'OTHER' }).success).toBe(true)
  })

  it('rejects negative initial payment or sale price', () => {
    expect(saleSchema.safeParse({ ...baseSale, initial_payment: -500_000 }).success).toBe(false)
    expect(saleSchema.safeParse({ ...baseSale, sale_price: -10_000_000 }).success).toBe(false)
  })
})

describe('Payment form input validation (paymentSchema)', () => {
  const basePayment = {
    amount: 15_000_000,
    payment_method: 'BANK_TRANSFER' as const,
    payment_date: '2026-09-30',
    reference: 'MB-12345678',
    notes: 'Thanh toán đợt 2',
  }

  it('accepts valid payment with positive amount', () => {
    expect(paymentSchema.safeParse(basePayment).success).toBe(true)
  })

  it('strictly rejects zero or negative payment amounts', () => {
    expect(paymentSchema.safeParse({ ...basePayment, amount: 0 }).success).toBe(false)
    expect(paymentSchema.safeParse({ ...basePayment, amount: -1 }).success).toBe(false)
    expect(paymentSchema.safeParse({ ...basePayment, amount: -10_000_000 }).success).toBe(false)
  })

  it('rejects fractional payment amounts', () => {
    expect(paymentSchema.safeParse({ ...basePayment, amount: 15_000_000.5 }).success).toBe(false)
  })

  it('rejects invalid payment date and invalid payment method', () => {
    expect(paymentSchema.safeParse({ ...basePayment, payment_date: 'invalid' }).success).toBe(false)
    expect(paymentSchema.safeParse({ ...basePayment, payment_method: 'INVALID' }).success).toBe(false)
  })
})

describe('Expense form input validation (expenseSchema)', () => {
  const baseExpense = {
    vehicle_id: '12345678-1234-1234-1234-123456789abc',
    type: 'REPAIR',
    description: 'Thay nhớt xe',
    amount: 150_000,
    expense_date: '2026-09-30',
  }

  it('accepts valid expense with positive amount and description', () => {
    expect(expenseSchema.safeParse(baseExpense).success).toBe(true)
  })

  it('rejects zero or negative expense amount', () => {
    expect(expenseSchema.safeParse({ ...baseExpense, amount: 0 }).success).toBe(false)
    expect(expenseSchema.safeParse({ ...baseExpense, amount: -50_000 }).success).toBe(false)
  })

  it('rejects empty or whitespace-only description', () => {
    expect(expenseSchema.safeParse({ ...baseExpense, description: '' }).success).toBe(false)
    expect(expenseSchema.safeParse({ ...baseExpense, description: '   ' }).success).toBe(false)
  })

  it('rejects empty expense type or invalid date', () => {
    expect(expenseSchema.safeParse({ ...baseExpense, type: '' }).success).toBe(false)
    expect(expenseSchema.safeParse({ ...baseExpense, expense_date: '2026-02-30' }).success).toBe(false)
  })
})

describe('CSV Safety and Cell Escaping', () => {
  it('quotes delimiters, line breaks and embedded quotes', () => {
    expect(csvCell('Xe, "A"\nDòng 2')).toBe('"Xe, ""A""\nDòng 2"')
    expect(csvCell(null)).toBe('""')
    expect(csvCell(undefined)).toBe('""')
  })

  it('neutralizes spreadsheet formula injection prefixes (=, +, -, @, tabs, spaces)', () => {
    for (const value of ['=HYPERLINK("https://example.test")', '+SUM(A1:A2)', '-42', '@SUM(1)', '\t=1+1', '   +2']) {
      expect(csvCell(value).startsWith('"\'')).toBe(true)
    }
    expect(csvCell('Honda SH160')).toBe('"Honda SH160"')
  })
})

describe('Vietnam calendar and date boundaries', () => {
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
  const profile = (role: Role, financials = false, active = true): Profile => ({
    id: 'test',
    full_name: 'Test',
    username: 'test',
    role,
    active,
    can_view_financials: financials,
    must_change_password: false,
  })

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

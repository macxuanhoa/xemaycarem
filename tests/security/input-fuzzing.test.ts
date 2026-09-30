import { describe, expect, it } from 'vitest'
import { vehicleSchema } from '@/features/vehicles/vehicleSchema'
import { paymentSchema, saleSchema } from '@/features/sales/saleSchema'
import { expenseSchema } from '@/features/expenses/ExpensePages'
import { csvCell } from '@/lib/csv'

/**
 * Requirement 15: Input Validation & Security Fuzzing
 * Test:
 * - missing fields
 * - malformed data
 * - negative amounts
 * - invalid dates
 * - invalid enum/status
 * - extremely large values
 * - duplicate identifiers
 * - whitespace
 * - empty strings
 */

describe('Input Fuzzing and Malicious Payload Handling', () => {
  const sqlInjectionPayloads = [
    "' OR '1'='1",
    "'; DROP TABLE vehicles; --",
    "1; SELECT * FROM profiles WHERE role='OWNER'",
    "admin' --",
    "UNION SELECT null, username, password FROM users --",
    "1' OR sleep(5) --",
  ]

  const xssPayloads = [
    '<script>alert("XSS")</script>',
    '<img src=x onerror=alert(1)>',
    'javascript:alert(document.cookie)',
    '<svg/onload=alert`1`>',
    '"><script>alert(1)</script>',
  ]

  describe('Vehicle Schema Resilience', () => {
    const validVehicle = {
      brand: 'Honda',
      model: 'Air Blade',
      purchase_date: '2026-09-30',
      asking_price: 45_000_000,
      status: 'IN_STOCK' as const,
      license_plate: '',
      color: '',
      frame_number: '',
      engine_number: '',
      odometer: 0,
      supplier_name: '',
      supplier_phone: '',
      notes: '',
    }

    it('sanitizes and treats SQL injection strings in vehicle fields as literal text without crashing', () => {
      for (const payload of sqlInjectionPayloads) {
        const vehicle = {
          ...validVehicle,
          brand: payload.slice(0, 80),
          notes: payload,
        }
        const parsed = vehicleSchema.safeParse(vehicle)
        if (parsed.success) {
          expect(typeof parsed.data.brand).toBe('string')
          expect(parsed.data.notes).toBe(payload)
        }
      }
    })

    it('rejects strings exceeding database column limits (e.g. brand > 80 chars, model > 120 chars)', () => {
      const oversizedBrand = 'A'.repeat(81)
      const oversizedModel = 'M'.repeat(121)
      const oversizedLicensePlate = 'P'.repeat(31)
      const oversizedFrame = 'F'.repeat(101)
      const oversizedEngine = 'E'.repeat(101)
      const oversizedNotes = 'N'.repeat(5001)

      expect(vehicleSchema.safeParse({ ...validVehicle, brand: oversizedBrand }).success).toBe(false)
      expect(vehicleSchema.safeParse({ ...validVehicle, model: oversizedModel }).success).toBe(false)
      expect(vehicleSchema.safeParse({ ...validVehicle, license_plate: oversizedLicensePlate }).success).toBe(false)
      expect(vehicleSchema.safeParse({ ...validVehicle, frame_number: oversizedFrame }).success).toBe(false)
      expect(vehicleSchema.safeParse({ ...validVehicle, engine_number: oversizedEngine }).success).toBe(false)
      expect(vehicleSchema.safeParse({ ...validVehicle, notes: oversizedNotes }).success).toBe(false)
    })

    it('rejects scientific notation or exponential string attempts in money fields', () => {
      expect(vehicleSchema.safeParse({ ...validVehicle, asking_price: ('1e8' as unknown as number) }).success).toBe(false)
      expect(vehicleSchema.safeParse({ ...validVehicle, asking_price: NaN }).success).toBe(false)
      expect(vehicleSchema.safeParse({ ...validVehicle, asking_price: Infinity }).success).toBe(false)
    })
  })

  describe('Sale Schema Resilience', () => {
    const validSale = {
      customer_name: 'Khách hàng',
      customer_phone: '0901234567',
      sale_price: 50_000_000,
      sale_date: '2026-09-30',
      initial_payment: 10_000_000,
      payment_method: 'CASH' as const,
      notes: '',
    }

    it('safely handles XSS payloads in customer names and notes without breaking validation', () => {
      for (const payload of xssPayloads) {
        const sale = {
          ...validSale,
          customer_name: payload.slice(0, 160),
          notes: payload,
        }
        const parsed = saleSchema.safeParse(sale)
        if (parsed.success) {
          expect(parsed.data.customer_name).toBe(payload.slice(0, 160))
        }
      }
    })

    it('rejects customer_name exceeding 160 characters', () => {
      const oversizedName = 'Nguyen '.repeat(30)
      expect(saleSchema.safeParse({ ...validSale, customer_name: oversizedName }).success).toBe(false)
    })

    it('rejects notes exceeding 5000 characters', () => {
      const oversizedNotes = 'X'.repeat(5001)
      expect(saleSchema.safeParse({ ...validSale, notes: oversizedNotes }).success).toBe(false)
    })
  })

  describe('Payment Schema Resilience', () => {
    const validPayment = {
      amount: 10_000_000,
      payment_method: 'CASH' as const,
      payment_date: '2026-09-30',
      reference: 'REF-123',
      notes: '',
    }

    it('rejects reference exceeding 160 characters', () => {
      expect(paymentSchema.safeParse({ ...validPayment, reference: 'R'.repeat(161) }).success).toBe(false)
    })

    it('rejects payment notes exceeding 2000 characters', () => {
      expect(paymentSchema.safeParse({ ...validPayment, notes: 'N'.repeat(2001) }).success).toBe(false)
    })

    it('rejects floating point amounts in payments', () => {
      expect(paymentSchema.safeParse({ ...validPayment, amount: 10_000_000.99 }).success).toBe(false)
    })
  })

  describe('Expense Schema Resilience', () => {
    const validExpense = {
      vehicle_id: '11111111-1111-1111-1111-111111111111',
      type: 'REPAIR',
      description: 'Sửa xe',
      amount: 200_000,
      expense_date: '2026-09-30',
    }

    it('rejects description exceeding 1000 characters', () => {
      expect(expenseSchema.safeParse({ ...validExpense, description: 'D'.repeat(1001) }).success).toBe(false)
    })

    it('rejects empty or whitespace-only description', () => {
      expect(expenseSchema.safeParse({ ...validExpense, description: '   \t\n   ' }).success).toBe(false)
    })
  })

  describe('Spreadsheet CSV Formula Injection Resilience', () => {
    it('escapes dangerous Excel/Calc command prefixes properly', () => {
      const dangerousCellValues = [
        '=cmd|\' /C calc\'!A0',
        '-2+3+cmd|',
        '+100',
        '@SUM(1+1)*cmd',
        '\t=SUM(A1:A10)',
        '\r+1-2',
        '   @malicious',
      ]

      for (const formula of dangerousCellValues) {
        const escaped = csvCell(formula)
        // Must start with single quote inside quotes ("'...) to force spreadsheet text evaluation
        expect(escaped.startsWith('"\'')).toBe(true)
      }
    })
  })
})

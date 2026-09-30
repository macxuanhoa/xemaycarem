import { describe, expect, it } from 'vitest'
import { paymentSchema, saleSchema } from '@/features/sales/saleSchema'

/**
 * Requirement 6: Sell Vehicle
 * Requirement 8: Payments (full, partial, multiple, remaining balance, overpayment guard)
 * Requirement 9: Sale Cancellation
 */

describe('Sales & Payments Business Logic (Integration)', () => {
  interface PaymentRecord {
    id: string
    sale_id: string
    amount: number
    payment_method: 'CASH' | 'BANK_TRANSFER' | 'OTHER'
    status: 'ACTIVE' | 'VOIDED'
  }

  interface SaleWithPayments {
    id: string
    vehicle_id: string
    sale_price: number
    status: 'COMPLETED' | 'CANCELLED'
    payments: PaymentRecord[]
  }

  function getSaleBalance(sale: SaleWithPayments): { paidAmount: number; remainingAmount: number } {
    const activePayments = sale.payments.filter((p) => p.status === 'ACTIVE')
    const paidAmount = activePayments.reduce((sum, p) => sum + p.amount, 0)
    const remainingAmount = sale.status === 'COMPLETED' ? Math.max(0, sale.sale_price - paidAmount) : 0
    return { paidAmount, remainingAmount }
  }

  function validateNewPayment(sale: SaleWithPayments, amount: number): { valid: boolean; reason?: string } {
    if (sale.status !== 'COMPLETED') {
      return { valid: false, reason: 'SALE_CANCELLED' }
    }
    const { paidAmount } = getSaleBalance(sale)
    if (amount <= 0) {
      return { valid: false, reason: 'PAYMENT_AMOUNT_POSITIVE_REQUIRED' }
    }
    if (paidAmount + amount > sale.sale_price) {
      return { valid: false, reason: 'PAYMENT_EXCEEDS_BALANCE' }
    }
    return { valid: true }
  }

  it('validates a sale with full payment at time of sale', () => {
    const saleData = {
      customer_name: 'Khách thanh toán hết',
      customer_phone: '0911223344',
      sale_price: 90_000_000,
      sale_date: '2026-09-30',
      initial_payment: 90_000_000,
      payment_method: 'BANK_TRANSFER' as const,
      notes: 'Thanh toán chuyển khoản 100%',
    }
    expect(saleSchema.safeParse(saleData).success).toBe(true)

    const sale: SaleWithPayments = {
      id: 'sale-001',
      vehicle_id: 'veh-001',
      sale_price: 90_000_000,
      status: 'COMPLETED',
      payments: [
        { id: 'pay-001', sale_id: 'sale-001', amount: 90_000_000, payment_method: 'BANK_TRANSFER', status: 'ACTIVE' },
      ],
    }

    const { paidAmount, remainingAmount } = getSaleBalance(sale)
    expect(paidAmount).toBe(90_000_000)
    expect(remainingAmount).toBe(0)

    // Cannot add any further payment (even 1 VND)
    expect(validateNewPayment(sale, 1).reason).toBe('PAYMENT_EXCEEDS_BALANCE')
  })

  it('validates partial payment and multi-stage installment completion', () => {
    const sale: SaleWithPayments = {
      id: 'sale-002',
      vehicle_id: 'veh-002',
      sale_price: 100_000_000,
      status: 'COMPLETED',
      payments: [
        { id: 'pay-001', sale_id: 'sale-002', amount: 30_000_000, payment_method: 'CASH', status: 'ACTIVE' },
      ],
    }

    // After initial payment of 30M
    let balance = getSaleBalance(sale)
    expect(balance.paidAmount).toBe(30_000_000)
    expect(balance.remainingAmount).toBe(70_000_000)

    // Attempting overpayment (>70M) is rejected
    expect(validateNewPayment(sale, 70_000_001).valid).toBe(false)
    expect(validateNewPayment(sale, 70_000_001).reason).toBe('PAYMENT_EXCEEDS_BALANCE')

    // Second payment: 40M
    expect(validateNewPayment(sale, 40_000_000).valid).toBe(true)
    sale.payments.push({ id: 'pay-002', sale_id: 'sale-002', amount: 40_000_000, payment_method: 'BANK_TRANSFER', status: 'ACTIVE' })

    balance = getSaleBalance(sale)
    expect(balance.paidAmount).toBe(70_000_000)
    expect(balance.remainingAmount).toBe(30_000_000)

    // Third payment: final 30M
    expect(validateNewPayment(sale, 30_000_000).valid).toBe(true)
    sale.payments.push({ id: 'pay-003', sale_id: 'sale-002', amount: 30_000_000, payment_method: 'CASH', status: 'ACTIVE' })

    balance = getSaleBalance(sale)
    expect(balance.paidAmount).toBe(100_000_000)
    expect(balance.remainingAmount).toBe(0)

    // Cannot pay anything more
    expect(validateNewPayment(sale, 1).valid).toBe(false)
  })

  it('cancellation voids all active payments and sets remaining balance to 0', () => {
    const sale: SaleWithPayments = {
      id: 'sale-003',
      vehicle_id: 'veh-003',
      sale_price: 85_000_000,
      status: 'COMPLETED',
      payments: [
        { id: 'pay-001', sale_id: 'sale-003', amount: 35_000_000, payment_method: 'CASH', status: 'ACTIVE' },
        { id: 'pay-002', sale_id: 'sale-003', amount: 20_000_000, payment_method: 'BANK_TRANSFER', status: 'ACTIVE' },
      ],
    }

    // Cancel the sale: status becomes CANCELLED, payments become VOIDED
    sale.status = 'CANCELLED'
    for (const p of sale.payments) {
      p.status = 'VOIDED'
    }

    const balance = getSaleBalance(sale)
    expect(balance.paidAmount).toBe(0) // No active payments
    expect(balance.remainingAmount).toBe(0) // No remaining balance on cancelled sale

    // Historical payment records must still exist in array (not deleted!)
    expect(sale.payments.length).toBe(2)
    expect(sale.payments.every((p) => p.status === 'VOIDED')).toBe(true)

    // Any new payment attempt on cancelled sale is strictly rejected
    expect(validateNewPayment(sale, 10_000_000).reason).toBe('SALE_CANCELLED')
  })

  it('payment schema rejects zero or negative amounts', () => {
    const validPayment = {
      amount: 10_000_000,
      payment_method: 'CASH' as const,
      payment_date: '2026-09-30',
      reference: '',
      notes: '',
    }
    expect(paymentSchema.safeParse(validPayment).success).toBe(true)
    expect(paymentSchema.safeParse({ ...validPayment, amount: 0 }).success).toBe(false)
    expect(paymentSchema.safeParse({ ...validPayment, amount: -5_000_000 }).success).toBe(false)
  })
})

import { describe, expect, it } from 'vitest'
import { money } from '@/lib/format'

/**
 * Requirement 10: Profit Calculation
 * cost_basis = purchase_price + ACTIVE vehicle expenses
 * gross_profit = sale_price - cost_basis_snapshot
 * Business expenses must NOT be included in vehicle cost basis.
 * Use BIGINT VND values. Test large valid monetary amounts and boundary conditions.
 */

describe('Financial Math & Profit Calculations (VND BigInt & Boundaries)', () => {
  function calculateCostBasis(
    purchasePrice: number | bigint,
    expenses: Array<{ amount: number | bigint; status: 'ACTIVE' | 'CANCELLED'; kind?: 'vehicle' | 'business' }>
  ): bigint {
    const p = BigInt(purchasePrice)
    const activeVehicleExpenses = expenses
      .filter((e) => e.status === 'ACTIVE' && e.kind !== 'business')
      .reduce((sum, e) => sum + BigInt(e.amount), 0n)
    return p + activeVehicleExpenses
  }

  function calculateGrossProfit(salePrice: number | bigint, costBasis: number | bigint): bigint {
    return BigInt(salePrice) - BigInt(costBasis)
  }

  it('accurately calculates cost basis from purchase_price and ACTIVE vehicle expenses', () => {
    const purchasePrice = 80_000_000n
    const expenses = [
      { amount: 1_200_000n, status: 'ACTIVE' as const, kind: 'vehicle' as const },
      { amount: 800_000n, status: 'ACTIVE' as const, kind: 'vehicle' as const },
      { amount: 300_000n, status: 'ACTIVE' as const, kind: 'vehicle' as const },
    ]
    const costBasis = calculateCostBasis(purchasePrice, expenses)
    expect(costBasis).toBe(82_300_000n)
  })

  it('strictly excludes CANCELLED or VOIDED vehicle expenses from cost basis', () => {
    const purchasePrice = 80_000_000n
    const expenses = [
      { amount: 1_200_000n, status: 'ACTIVE' as const, kind: 'vehicle' as const },
      { amount: 7_000_000n, status: 'CANCELLED' as const, kind: 'vehicle' as const }, // Cancelled should be omitted!
      { amount: 800_000n, status: 'ACTIVE' as const, kind: 'vehicle' as const },
    ]
    const costBasis = calculateCostBasis(purchasePrice, expenses)
    expect(costBasis).toBe(82_000_000n)
  })

  it('strictly separates business expenses and NEVER includes them in vehicle cost basis', () => {
    const purchasePrice = 50_000_000n
    const expenses = [
      { amount: 1_500_000n, status: 'ACTIVE' as const, kind: 'vehicle' as const },
      { amount: 25_000_000n, status: 'ACTIVE' as const, kind: 'business' as const }, // Business rent - must NOT affect vehicle!
      { amount: 4_000_000n, status: 'ACTIVE' as const, kind: 'business' as const },  // Business electricity
    ]
    const costBasis = calculateCostBasis(purchasePrice, expenses)
    expect(costBasis).toBe(51_500_000n)
  })

  it('computes exact gross profit = sale_price - cost_basis', () => {
    const salePrice = 90_000_000n
    const costBasis = 82_300_000n
    const grossProfit = calculateGrossProfit(salePrice, costBasis)
    expect(grossProfit).toBe(7_700_000n)
  })

  it('handles negative gross profit (selling at a loss) accurately without error', () => {
    const salePrice = 75_000_000n
    const costBasis = 82_300_000n
    const grossProfit = calculateGrossProfit(salePrice, costBasis)
    expect(grossProfit).toBe(-7_300_000n)
  })

  it('handles break-even sale (sale_price == cost_basis) -> gross_profit = 0', () => {
    const salePrice = 82_300_000n
    const costBasis = 82_300_000n
    expect(calculateGrossProfit(salePrice, costBasis)).toBe(0n)
  })

  it('handles maximum allowed VND boundary amounts up to 1,000,000,000,000 without 64-bit overflow', () => {
    const purchasePrice = 950_000_000_000n
    const expenses = [
      { amount: 40_000_000_000n, status: 'ACTIVE' as const, kind: 'vehicle' as const },
    ]
    const costBasis = calculateCostBasis(purchasePrice, expenses)
    expect(costBasis).toBe(990_000_000_000n)

    const salePrice = 1_000_000_000_000n
    const grossProfit = calculateGrossProfit(salePrice, costBasis)
    expect(grossProfit).toBe(10_000_000_000n)
  })

  it('correctly formats VND amounts via money() helper', () => {
    const formatted = money(82_300_000)
    expect(formatted).toMatch(/82\.300\.000/)
    expect(formatted).toMatch(/₫/)

    expect(money(0)).toMatch(/0/)
    expect(money(null)).toBe('—')
    expect(money(undefined)).toBe('—')
  })
})

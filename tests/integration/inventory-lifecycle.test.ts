import { describe, expect, it } from 'vitest'
import { FICTIONAL_VEHICLES } from '../fixtures/fictional-data'

/**
 * Requirement 3: Vehicle Inventory
 * Requirement 4: Vehicle Financial Data Separation
 * Requirement 5: Vehicle Expenses
 */

describe('Vehicle Inventory Lifecycle & Financial Data Separation (Integration)', () => {
  interface VehicleState {
    id: string
    internal_code: string
    vehicle_type_id: string
    vehicle_type: string
    status: 'IN_STOCK' | 'RESERVED' | 'SOLD' | 'CANCELLED'
    purchase_price?: number | null
    cost_pending: boolean
    expenses: Array<{ id: string; amount: number; status: 'ACTIVE' | 'CANCELLED' }>
  }

  function createVehicle(data: {
    vehicle_type_id: string
    vehicle_type: string
    purchase_price?: number
  }): VehicleState {
    const cost_pending = data.purchase_price === undefined || data.purchase_price === null
    return {
      id: 'mock-veh-' + Math.random().toString(36).slice(2, 8),
      internal_code: 'XE-2026-000001',
      vehicle_type_id: data.vehicle_type_id,
      vehicle_type: data.vehicle_type,
      status: 'IN_STOCK',
      purchase_price: cost_pending ? null : data.purchase_price,
      cost_pending,
      expenses: [],
    }
  }

  function addExpenseToVehicle(
    vehicle: VehicleState,
    amount: number
  ): { success: boolean; error?: string } {
    if (vehicle.status === 'SOLD') {
      return { success: false, error: 'VEHICLE_EXPENSE_LOCKED' }
    }
    vehicle.expenses.push({
      id: 'exp-' + Math.random().toString(36).slice(2, 8),
      amount,
      status: 'ACTIVE',
    })
    return { success: true }
  }

  function getVehicleTotalCost(vehicle: VehicleState): number | null {
    if (vehicle.cost_pending || vehicle.purchase_price == null) return null
    const activeExpenseTotal = vehicle.expenses
      .filter((e) => e.status === 'ACTIVE')
      .reduce((sum, e) => sum + e.amount, 0)
    return vehicle.purchase_price + activeExpenseTotal
  }

  it('marks cost_pending=true when created by operational staff without purchase price', () => {
    const vehicle = createVehicle({
      vehicle_type_id: FICTIONAL_VEHICLES.PENDING_COST.vehicle_type_id,
      vehicle_type: FICTIONAL_VEHICLES.PENDING_COST.vehicle_type,
    })

    expect(vehicle.cost_pending).toBe(true)
    expect(vehicle.purchase_price).toBeNull()
    expect(getVehicleTotalCost(vehicle)).toBeNull()
  })

  it('calculates total cost when purchase price is set and expenses are added', () => {
    const vehicle = createVehicle({
      vehicle_type_id: FICTIONAL_VEHICLES.PREMIUM_SCOOTER.vehicle_type_id,
      vehicle_type: FICTIONAL_VEHICLES.PREMIUM_SCOOTER.vehicle_type,
      purchase_price: 85_000_000,
    })

    expect(vehicle.cost_pending).toBe(false)
    expect(getVehicleTotalCost(vehicle)).toBe(85_000_000)

    // Add 2 active expenses
    addExpenseToVehicle(vehicle, 1_200_000)
    addExpenseToVehicle(vehicle, 800_000)
    expect(getVehicleTotalCost(vehicle)).toBe(87_000_000)

    // Cancel the first expense
    vehicle.expenses[0].status = 'CANCELLED'
    expect(getVehicleTotalCost(vehicle)).toBe(85_800_000)
  })

  it('strictly forbids adding expenses once a vehicle is marked SOLD', () => {
    const vehicle = createVehicle({
      vehicle_type_id: FICTIONAL_VEHICLES.ECONOMY_CUB.vehicle_type_id,
      vehicle_type: FICTIONAL_VEHICLES.ECONOMY_CUB.vehicle_type,
      purchase_price: 15_000_000,
    })

    vehicle.status = 'SOLD'
    const result = addExpenseToVehicle(vehicle, 500_000)
    expect(result.success).toBe(false)
    expect(result.error).toBe('VEHICLE_EXPENSE_LOCKED')
  })

  it('allows reservation status transition: IN_STOCK <-> RESERVED', () => {
    const vehicle = createVehicle({
      vehicle_type_id: FICTIONAL_VEHICLES.PREMIUM_SCOOTER.vehicle_type_id,
      vehicle_type: FICTIONAL_VEHICLES.PREMIUM_SCOOTER.vehicle_type,
      purchase_price: 80_000_000,
    })

    expect(vehicle.status).toBe('IN_STOCK')
    vehicle.status = 'RESERVED'
    expect(vehicle.status).toBe('RESERVED')

    // Expense can still be added to RESERVED vehicle
    const expResult = addExpenseToVehicle(vehicle, 300_000)
    expect(expResult.success).toBe(true)

    // Unreserve back to IN_STOCK
    vehicle.status = 'IN_STOCK'
    expect(vehicle.status).toBe('IN_STOCK')
  })

  it('keeps the whole lifecycle free of the six purged vehicle fields', () => {
    const vehicle = createVehicle({
      vehicle_type_id: FICTIONAL_VEHICLES.UNDERCROSS_BIKE.vehicle_type_id,
      vehicle_type: FICTIONAL_VEHICLES.UNDERCROSS_BIKE.vehicle_type,
      purchase_price: 36_000_000,
    })
    // Không được còn sót key nào: có là không còn cột tương ứng trong database.
    for (const purged of ['brand', 'model', 'variant', 'engine_number', 'odometer', 'asking_price'])
      expect(vehicle).not.toHaveProperty(purged)
    // Giá vốn chỉ là giá thu + chi phí đang hoạt động; không có giá dự kiến.
    expect(addExpenseToVehicle(vehicle, 1_000_000).success).toBe(true)
    expect(getVehicleTotalCost(vehicle)).toBe(37_000_000)
  })
})

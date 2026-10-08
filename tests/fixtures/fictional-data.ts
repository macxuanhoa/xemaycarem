/**
 * Fictional test fixtures for Xe Máy Cà Rem CRM automated testing.
 * IMPORTANT: NEVER use real customer or store data in automated test suites.
 * All phone numbers, identities, and financial records here are strictly fictional.
 */

export const FICTIONAL_PROFILES = {
  OWNER: {
    id: '11111111-1111-4111-8111-111111111111',
    full_name: 'Nguyễn Văn Chủ (Fictional Owner)',
    username: 'nguyenvan',
    role: 'OWNER' as const,
    active: true,
    can_view_financials: true,
    must_change_password: false,
    disabled_until: null,
    allowed_from: '00:00:00',
    allowed_until: '23:59:59',
    working_days: [1,2,3,4,5,6,7],
    deleted_at: null,
  },
  MANAGER_FINANCIAL: {
    id: '22222222-2222-4222-8222-222222222222',
    full_name: 'Trần Thị Quản Lý (Fictional Financial Manager)',
    username: 'tranthi',
    role: 'MANAGER' as const,
    active: true,
    can_view_financials: true,
    must_change_password: false,
    disabled_until: null,
    allowed_from: '00:00:00',
    allowed_until: '23:59:59',
    working_days: [1,2,3,4,5,6,7],
    deleted_at: null,
  },
  MANAGER_OPERATIONAL: {
    id: '33333333-3333-4333-8333-333333333333',
    full_name: 'Lê Văn Vận Hành (Fictional Ops Manager)',
    username: 'levan',
    role: 'MANAGER' as const,
    active: true,
    can_view_financials: false,
    must_change_password: false,
    disabled_until: null,
    allowed_from: '00:00:00',
    allowed_until: '23:59:59',
    working_days: [1,2,3,4,5,6,7],
    deleted_at: null,
  },
  STAFF: {
    id: '44444444-4444-4444-8444-444444444444',
    full_name: 'Phạm Văn Bán Hàng (Fictional Staff)',
    username: 'phamvan',
    role: 'STAFF' as const,
    active: true,
    can_view_financials: false,
    must_change_password: false,
    disabled_until: null,
    allowed_from: '00:00:00',
    allowed_until: '23:59:59',
    working_days: [1,2,3,4,5,6,7],
    deleted_at: null,
  },
  INACTIVE: {
    id: '99999999-9999-4999-8999-999999999999',
    full_name: 'Vũ Đã Nghỉ Việc (Fictional Inactive)',
    username: 'vuda',
    role: 'STAFF' as const,
    active: false,
    can_view_financials: false,
    must_change_password: false,
    disabled_until: null,
    allowed_from: '00:00:00',
    allowed_until: '23:59:59',
    working_days: [1,2,3,4,5,6,7],
    deleted_at: null,
  },
} as const

export const FICTIONAL_VEHICLES = {
  // Sau 08/10/2026 hồ sơ xe không còn Hãng / Dòng / Phiên bản / Số máy / Số km /
  // Giá bán dự kiến: xe được định danh bằng biển số · số khung và phân loại
  // bằng `vehicle_type_id` trỏ tới danh mục `vehicle_types`.
  // ID dưới đây chỉ là hằng số giả cho các test in-memory; test chạy trên DB
  // phải lấy id thật từ RPC `list_vehicle_types()` vì danh mục do cửa hàng sửa.
  PREMIUM_SCOOTER: {
    vehicle_type_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1',
    vehicle_type: 'Xe tay ga',
    year: 2024,
    color: 'Xám xi măng',
    frame_number: 'RLH160-FICTIONAL-001',
    license_plate: '29B1-999.88',
    purchase_date: '2026-09-01',
    purchase_price: 85_000_000,
    supplier_name: 'Anh Hùng Cầu Giấy (Fictional)',
    supplier_phone: '0900000001',
    status: 'IN_STOCK' as const,
    notes: 'Xe chạy lướt, bảo dưỡng chính hãng.',
  },
  ECONOMY_CUB: {
    vehicle_type_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2',
    vehicle_type: 'Xe số',
    year: 2023,
    color: 'Trắng',
    frame_number: 'RLH110-FICTIONAL-002',
    license_plate: '30E1-123.45',
    purchase_date: '2026-09-10',
    purchase_price: 12_000_000,
    supplier_name: 'Chị Lan Đống Đa (Fictional)',
    supplier_phone: '0900000002',
    status: 'IN_STOCK' as const,
    notes: 'Xe máy nguyên bản, còn đủ 2 gương.',
  },
  UNDERCROSS_BIKE: {
    vehicle_type_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3',
    vehicle_type: 'Xe côn tay',
    year: 2024,
    color: 'Xanh GP',
    frame_number: 'RLY155-FICTIONAL-003',
    license_plate: '29X1-567.89',
    purchase_date: '2026-09-15',
    purchase_price: 36_000_000,
    supplier_name: 'Cửa hàng Đức Trọng (Fictional)',
    supplier_phone: '0900000003',
    status: 'IN_STOCK' as const,
    notes: '',
  },
  PENDING_COST: {
    vehicle_type_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa4',
    vehicle_type: 'Xe tay ga',
    year: 2024,
    color: 'Đỏ đen',
    frame_number: 'RLH110-FICTIONAL-004',
    license_plate: '29C1-888.99',
    purchase_date: '2026-09-20',
    supplier_name: 'Nhân viên thu mua (Fictional)',
    supplier_phone: '0900000004',
    status: 'IN_STOCK' as const,
    notes: 'Chờ chủ cửa hàng duyệt giá nhập.',
  },
} as const

/**
 * Danh mục loại xe mặc định migration `20261008000300` cài sẵn.
 * `Chưa phân loại` là hàng đợi: xe cũ sau purge đều rơi vào đây cho tới khi
 * nhân viên sửa hồ sơ, và bộ tốc ký không bao giờ tự gán tên này.
 */
export const FICTIONAL_VEHICLE_TYPE_CATALOG = [
  'Xe số',
  'Xe tay ga',
  'Xe côn tay',
  'Xe điện',
  'Ga 50cc',
  'Chưa phân loại',
] as const

export const FICTIONAL_EXPENSES = {
  VEHICLE_REPAIR: {
    expense_type: 'REPAIR' as const,
    description: 'Bảo dưỡng định kỳ, thay dầu nhớt và bugi',
    amount: 650_000,
    expense_date: '2026-09-05',
  },
  VEHICLE_PAPERWORK: {
    expense_type: 'PAPERWORK' as const,
    description: 'Phí rút hồ sơ gốc và thủ tục sang tên',
    amount: 1_200_000,
    expense_date: '2026-09-08',
  },
  VEHICLE_PARTS: {
    expense_type: 'PARTS' as const,
    description: 'Thay lốp sau Michelin mới',
    amount: 1_450_000,
    expense_date: '2026-09-12',
  },
  BUSINESS_RENT: {
    category: 'RENT' as const,
    description: 'Tiền thuê mặt bằng cửa hàng tháng 09/2026',
    amount: 25_000_000,
    expense_date: '2026-09-01',
  },
  BUSINESS_ELECTRICITY: {
    category: 'ELECTRICITY' as const,
    description: 'Hóa đơn tiền điện sinh hoạt và chiếu sáng tháng 08/2026',
    amount: 3_800_000,
    expense_date: '2026-09-05',
  },
} as const

export const FICTIONAL_CUSTOMERS = {
  CUSTOMER_A: {
    name: 'Phạm Minh Tuấn (Fictional Customer)',
    phone: '0912345678',
  },
  CUSTOMER_B: {
    name: 'Đặng Mai Phương (Fictional Customer)',
    phone: '0987654321',
  },
} as const

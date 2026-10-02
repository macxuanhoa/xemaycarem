// Deterministic, permission-scoped evidence retrieval for the AI copilot.
// Every number and document excerpt below comes from an authorized read RPC executed
// with the caller's own JWT, so the copilot can never exceed the caller's RLS rights.
import { canFinance, canManage } from './contracts.ts'
import type { AccessProfile, Caller } from './contracts.ts'

export type CitationType = 'vehicle' | 'sale' | 'expense' | 'debt' | 'metric' | 'audit' | 'profile' | 'document' | 'settings'
export type Citation = { id: string; type: CitationType; label: string; detail: string | null; route: string }
export type Fact = { label: string; value: number | string; display: string; citation: string }
export type DocExcerpt = { id: string; title: string; section: string | null; excerpt: string }
export type CopilotEvidence = {
  coverage: 'data' | 'documents' | 'both' | 'none'
  period: string | null
  facts: Fact[]
  citations: Citation[]
  doc_excerpts: DocExcerpt[]
  answer_markdown: string
  suggestions: { label: string; route: string }[]
  insufficient: boolean
  warnings: string[]
}

/** Remove Vietnamese diacritics so keyword matching survives accent input variance. */
export const normalize = (value: string) =>
  value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/g, 'd').toLowerCase()

export const money = (value: number) => `${Math.round(value).toLocaleString('vi-VN')} ₫`
export const count = (value: number, unit: string) => `${Math.round(value)} ${unit}`

/**
 * Run an authorized read RPC through the caller's own JWT and unwrap the
 * `{ data, error }` envelope. A database error rejects so `safe()` can turn it
 * into a visible warning instead of a fabricated number.
 */
async function read<T>(context: RunContext, name: string, parameters: Record<string, unknown> = {}): Promise<T | null> {
  const response = await context.caller.rpc(name, parameters)
  if (response.error) throw new Error(`${name}: ${String(response.error)}`)
  return (response.data ?? null) as T | null
}

type Intent = {
  key: string
  pattern: RegExp
  label: string
  requires?: 'manage' | 'finance' | 'owner'
  run: (context: RunContext) => Promise<void>
}

type RunContext = {
  question: string
  caller: Caller
  profile: AccessProfile
  period: { from: string; to: string; label: string } | null
  addFact: (fact: Fact) => void
  addCitation: (citation: Omit<Citation, 'id'>) => string
  addSuggestion: (suggestion: { label: string; route: string }) => void
  warn: (message: string) => void
}

const allowed = (context: RunContext, requirement?: Intent['requires']) =>
  !requirement
  || (requirement === 'manage' && canManage(context.profile))
  || (requirement === 'finance' && canFinance(context.profile))
  || (requirement === 'owner' && context.profile.role === 'OWNER')

async function safe<T>(operation: () => Promise<T>, context: RunContext, failure: string): Promise<T | null> {
  try {
    return await operation()
  } catch {
    context.warn(failure)
    return null
  }
}

/**
 * Dashboard-derived metrics with the exact page that shows each figure.
 * `unit` is either the literal 'money' (formatted as Vietnamese dong) or the
 * counting noun used in the answer, e.g. 'xe'.
 */
async function metrics(context: RunContext, selects: [key: string, label: string, unit: string, route: string, requires?: Intent['requires']][]) {
  // Omit the range entirely when no period was detected: dashboard raises
  // INVALID_DATE_RANGE for explicit NULL bounds instead of using its defaults.
  const data = await safe(() => read<Record<string, unknown>>(
    context,
    'dashboard',
    context.period ? { p_from: context.period.from, p_to: context.period.to } : {},
  ), context, 'Không đọc được số liệu tổng quan.')
  if (!data || typeof data !== 'object') return
  for (const [key, label, unit, route, requires] of selects) {
    if (!allowed(context, requires)) {
      context.warn(`${label} cần quyền cao hơn.`)
      continue
    }
    // Financial columns are NULL for callers without the right, so skip instead of reading 0.
    const raw = data[key]
    if (raw === null || raw === undefined) continue
    const value = Number(raw)
    if (!Number.isFinite(value)) continue
    const citation = context.addCitation({ type: 'metric', label, detail: context.period?.label ?? 'Hiện tại', route })
    context.addFact({ label, value, display: unit === 'money' ? money(value) : count(value, unit), citation })
  }
}

const INTENTS: Intent[] = [
  {
    key: 'inventory',
    pattern: /(ton kho|con bao nhieu xe|dang co bao nhieu|so xe trong kho|inventory)/,
    label: 'Tồn kho',
    run: (context) => metrics(context, [
      ['in_stock', 'Xe đang tồn kho', 'xe', '/vehicles'],
      ['reserved', 'Xe đang giữ chỗ', 'xe', '/vehicles'],
      ['inventory_cost_pending', 'Xe chưa xác nhận giá mua', 'xe', '/vehicles'],
    ]),
  },
  {
    key: 'acquisitions',
    pattern: /(thu bao nhieu|thu vao|acquist|xe thu)/,
    label: 'Thu vào',
    run: (context) => metrics(context, [['acquisitions_count', 'Xe thu vào trong kỳ', 'xe', '/acquisitions']]),
  },
  {
    key: 'sales',
    pattern: /(ban bao nhieu|so xe ban|doanh so|sales count|ban duoc)/,
    label: 'Bán ra',
    run: (context) => metrics(context, [['sales_count', 'Xe bán trong kỳ', 'xe', '/sales', 'manage']]),
  },
  {
    key: 'revenue',
    pattern: /(doanh thu|thu duoc bao nhieu|revenue)/,
    label: 'Doanh thu',
    requires: 'manage',
    run: (context) => metrics(context, [['revenue', 'Doanh thu hoàn tất', 'money', '/', 'manage']]),
  },
  {
    key: 'profit',
    pattern: /(loi nhuan|lai bao nhieu|profit|hieu suat)/,
    label: 'Lợi nhuận',
    requires: 'finance',
    run: (context) => metrics(context, [['gross_profit', 'Lợi nhuận gộp', 'money', '/', 'finance']]),
  },
  {
    key: 'aging',
    pattern: /(ton lau|nhu yen|age|tren 60 ngay|lau nhat)/,
    label: 'Tồn kho lâu',
    run: async (context) => {
      await metrics(context, [['old_inventory_count', 'Xe tồn trên 60 ngày', 'xe', '/vehicles']])
      const data = await safe(() => read<Record<string, unknown>>(
        context,
        'dashboard',
        context.period ? { p_from: context.period.from, p_to: context.period.to } : {},
      ), context, 'Không đọc được danh sách xe tồn lâu.')
      const longest = Array.isArray(data?.longest_stock) ? data!.longest_stock as Record<string, unknown>[] : []
      for (const row of longest.slice(0, 5)) {
        if (!row?.id) continue
        const citation = context.addCitation({
          type: 'vehicle',
          label: [row.brand, row.model].filter(Boolean).join(' ') || 'Xe',
          detail: String(row.license_plate || row.frame_number || '') || null,
          route: `/vehicles/${row.id}`,
        })
        context.addFact({ label: `Tồn lâu nhất: ${[row.brand, row.model].filter(Boolean).join(' ')}`, value: Number(row.days_in_inventory ?? 0), display: count(Number(row.days_in_inventory ?? 0), 'ngày'), citation })
      }
    },
  },
  {
    key: 'receivables',
    pattern: /(cong no|no lai|chua thu| phai thu|debt|receivable|quyet toan no)/,
    label: 'Công nợ',
    run: async (context) => {
      const data = await safe(() => read<Record<string, unknown>>(context, 'list_receivables', { p_filters: { limit: 5 } }), context, 'Không đọc được công nợ.')
      if (!data) return
      const totalDebt = Number(data.total_receivable)
      if (Number.isFinite(totalDebt)) {
        const citation = context.addCitation({ type: 'debt', label: 'Tổng công nợ', detail: null, route: '/receivables' })
        context.addFact({ label: 'Tổng còn phải thu', value: totalDebt, display: money(totalDebt), citation })
      }
      const overdue = Number(data.total_overdue)
      if (Number.isFinite(overdue) && overdue > 0) {
        const citation = context.addCitation({ type: 'debt', label: 'Nợ quá hạn', detail: null, route: '/receivables' })
        context.addFact({ label: 'Nợ quá hạn', value: overdue, display: money(overdue), citation })
      }
      for (const row of (Array.isArray(data.items) ? data.items as Record<string, unknown>[] : []).slice(0, 5)) {
        if (!row?.id) continue
        const citation = context.addCitation({ type: 'sale', label: String(row.customer_name || 'Khách'), detail: String(row.license_plate || '') || null, route: `/sales/${row.id}` })
        context.addFact({ label: `Còn phải thu: ${row.customer_name || 'khách'}`, value: Number(row.remaining_amount ?? 0), display: money(Number(row.remaining_amount ?? 0)), citation })
      }
      context.addSuggestion({ label: 'Mở Sổ công nợ', route: '/receivables' })
    },
  },
  {
    key: 'expenses',
    pattern: /(chi phi|expense|sua xe|tien sua)/,
    label: 'Chi phí',
    requires: 'manage',
    run: async (context) => {
      const data = await safe(() => read<Record<string, unknown>>(context, 'list_expenses', { p_filters: { limit: 5 } }), context, 'Không đọc được chi phí.')
      if (!data) return
      const items = Array.isArray(data.items) ? data.items as Record<string, unknown>[] : []
      for (const row of items.slice(0, 5)) {
        const amount = Number(row.amount)
        if (!Number.isFinite(amount)) continue
        const vehicleId = row.vehicle_id ? `/vehicles/${row.vehicle_id}` : '/expenses'
        const citation = context.addCitation({ type: 'expense', label: String(row.description || 'Chi phí').slice(0, 80), detail: row.expense_date ? String(row.expense_date) : null, route: vehicleId })
        context.addFact({ label: String(row.description || 'Chi phí').slice(0, 60), value: amount, display: money(amount), citation })
      }
      if (items.length) context.addSuggestion({ label: 'Mở bảng chi phí', route: '/expenses' })
    },
  },
  {
    key: 'audit',
    pattern: /(lich su thao tac|audit|ai da sua|nhat ky)/,
    label: 'Lịch sử thao tác',
    requires: 'owner',
    run: async (context) => {
      const data = await safe(() => read<Record<string, unknown>>(context, 'list_audit', { p_filters: { limit: 5 } }), context, 'Không đọc được lịch sử thao tác.')
      if (!data) return
      const total = Number(data.total)
      if (Number.isFinite(total)) {
        const citation = context.addCitation({ type: 'audit', label: 'Lịch sử thao tác', detail: null, route: '/audit' })
        context.addFact({ label: 'Bản ghi audit', value: total, display: count(total, 'bản ghi'), citation })
      }
      context.addSuggestion({ label: 'Mở lịch sử thao tác', route: '/audit' })
    },
  },
  {
    key: 'team',
    pattern: /(nhan su|tai khoan|team|nv|ai trong nhom|mo ai)/,
    label: 'Nhân sự',
    requires: 'owner',
    run: async (context) => {
      const data = await safe(() => read<Record<string, unknown>[]>(context, 'list_profiles'), context, 'Không đọc được danh sách tài khoản.')
      const rows = Array.isArray(data) ? data : []
      if (!rows.length) return
      const active = rows.filter((row) => row.active === true).length
      const citation = context.addCitation({ type: 'profile', label: 'Danh sách tài khoản', detail: null, route: '/users' })
      context.addFact({ label: 'Tài khoản đang hoạt động', value: active, display: count(active, 'tài khoản'), citation })
      context.addFact({ label: 'Tổng số tài khoản', value: rows.length, display: count(rows.length, 'tài khoản'), citation })
      context.addSuggestion({ label: 'Mở trang Nhân sự', route: '/users' })
    },
  },
  {
    key: 'settings',
    pattern: /(cai dat|cua hang ten|store name|setting)/,
    label: 'Cài đặt cửa hàng',
    run: async (context) => {
      const data = await safe(() => read<Record<string, unknown>>(context, 'get_settings'), context, 'Không đọc được cài đặt.')
      if (!data) return
      const citation = context.addCitation({ type: 'settings', label: 'Cài đặt cửa hàng', detail: null, route: '/settings' })
      if (typeof data.store_name === 'string') context.addFact({ label: 'Tên cửa hàng', value: data.store_name, display: data.store_name, citation })
      if (typeof data.phone === 'string') context.addFact({ label: 'Điện thoại', value: data.phone, display: data.phone, citation })
      context.addSuggestion({ label: 'Mở Cài đặt', route: '/settings' })
    },
  },
]

/** Free-text vehicle lookup when the question names a plate, frame or model. */
async function vehicleLookup(context: RunContext) {
  const plate = context.question.match(/\b\d{3,6}[-\s]?[a-z]{1,3}[-\s]?\d{1,3}(?:\.\d{1,2})?\b/i)?.[0]
  const quoted = context.question.match(/["“](.+?)["”]/)?.[1]
  const search = (plate || quoted || '').trim()
  if (search.length < 2) return false
  const data = await safe(() => read<Record<string, unknown>>(context, 'list_vehicles', { p_filters: { search, limit: 5 } }), context, 'Không tìm được xe phù hợp.')
  const items = Array.isArray(data?.items) ? data!.items as Record<string, unknown>[] : []
  if (!items.length) return false
  for (const row of items.slice(0, 5)) {
    if (!row?.id) continue
    const citation = context.addCitation({ type: 'vehicle', label: [row.brand, row.model].filter(Boolean).join(' ') || 'Xe', detail: String(row.license_plate || row.frame_number || '') || null, route: `/vehicles/${row.id}` })
    context.addFact({ label: `Xe khớp "${search}": ${[row.brand, row.model].filter(Boolean).join(' ')}`, value: Number(row.asking_price ?? 0), display: row.asking_price ? money(Number(row.asking_price)) : 'chưa ra giá', citation })
  }
  context.addSuggestion({ label: 'Tìm trong kho', route: `/vehicles?q=${encodeURIComponent(search)}` })
  return true
}

/** `tháng 9`, `tháng này`, `2026-08` and explicit ranges become an Asia/Ho_Chi_Minh period. */
export function detectPeriod(question: string, today = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Ho_Chi_Minh', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(today)
  const year = Number(parts.find((part) => part.type === 'year')?.value)
  const currentMonth = Number(parts.find((part) => part.type === 'month')?.value)
  const explicit = normalize(question).match(/(?:thang|month)\s*([0-9]{1,2})|(20\d{2})-([0-9]{2})/)
  let month = currentMonth
  let labelYear = year
  if (explicit?.[3]) { month = Number(explicit[3]); labelYear = Number(explicit[2]) }
  else if (explicit?.[1]) month = Number(explicit[1])
  if (month < 1 || month > 12) return null
  const padded = String(month).padStart(2, '0')
  const lastDay = new Date(Date.UTC(labelYear, month, 0)).getUTCDate()
  const named = normalize(question).includes('thang nay') || normalize(question).includes('this month')
  return {
    from: `${labelYear}-${padded}-01`,
    to: named || month < currentMonth || (month === currentMonth && labelYear < year) ? `${labelYear}-${padded}-${String(month === currentMonth ? Number(parts.find((p) => p.type === 'day')?.value) : lastDay).padStart(2, '0')}` : `${labelYear}-${padded}-${lastDay}`,
    label: `Tháng ${padded}/${labelYear}`,
  }
}

export async function buildEvidence(question: string, caller: Caller, profile: AccessProfile, today = new Date()): Promise<CopilotEvidence> {
  const context: RunContext = {
    question,
    caller,
    profile,
    period: detectPeriod(question, today),
    addFact: () => {},
    addCitation: () => '',
    addSuggestion: () => {},
    warn: () => {},
  }
  const facts: Fact[] = []
  const citations: Citation[] = []
  const suggestions: { label: string; route: string }[] = []
  const warnings: string[] = []
  const seenSuggestions = new Set<string>()
  context.addFact = (fact) => { facts.push(fact) }
  context.addCitation = (citation) => {
    const existing = citations.find((item) => item.route === citation.route && item.label === citation.label)
    if (existing) return existing.id
    const id = `${citation.type.slice(0, 1)}${citations.length + 1}`
    citations.push({ ...citation, id })
    return id
  }
  context.addSuggestion = (suggestion) => {
    if (seenSuggestions.has(suggestion.route)) return
    seenSuggestions.add(suggestion.route)
    suggestions.push(suggestion)
  }
  context.warn = (message) => { if (!warnings.includes(message)) warnings.push(message) }

  const documents = await safe(() => read<Record<string, unknown>[]>(context, 'search_knowledge', { p_query: question, p_limit: 5 }), context, 'Không tra được tài liệu.')
  const docCitations: DocExcerpt[] = []
  for (const document of Array.isArray(documents) ? documents : []) {
    if (!document?.slug) continue
    const section = typeof document.section === 'string' ? document.section : null
    const id = context.addCitation({
      type: 'document',
      label: String(document.title || 'Tài liệu'),
      detail: section,
      route: `/docs/${document.slug}`,
    })
    docCitations.push({ id, title: String(document.title || 'Tài liệu'), excerpt: String(document.excerpt || ''), section })
  }

  const matched = INTENTS.filter((intent) => intent.pattern.test(normalize(question)))
  for (const intent of matched.slice(0, 4)) await intent.run(context)
  if (!matched.length) await vehicleLookup(context)

  const hasData = facts.length > 0
  const hasDocuments = docCitations.length > 0
  const lines: string[] = []
  if (hasData) {
    lines.push(context.period ? `Số liệu kỳ **${context.period.label}** (${context.period.from} → ${context.period.to}):` : 'Số liệu hiện tại của cửa hàng:')
    for (const fact of facts) lines.push(`- ${fact.label}: **${fact.display}**${fact.citation ? ` [${fact.citation}]` : ''}`)
  }
  if (hasDocuments) {
    lines.push(hasData ? 'Tài liệu liên quan:' : 'Không có số liệu khớp với câu hỏi; đây là các phần tài liệu liên quan:')
    for (const document of docCitations.slice(0, 3)) {
      lines.push(`- **${document.title}${document.section ? ` — ${document.section}` : ''}** [${document.id}]`)
    }
  }
  if (!hasData && !hasDocuments) {
    lines.push('Chưa tìm thấy dữ liệu hoặc tài liệu phù hợp với câu hỏi. Hãy thêm từ khóa như "tồn kho", "doanh thu", "công nợ", "chi phí" hoặc mô tả biển số/số khung cần tra.')
  }

  return {
    coverage: hasData && hasDocuments ? 'both' : hasData ? 'data' : hasDocuments ? 'documents' : 'none',
    period: context.period?.label ?? null,
    facts,
    citations,
    doc_excerpts: docCitations,
    answer_markdown: lines.join('\n'),
    suggestions,
    insufficient: !hasData && !hasDocuments,
    warnings,
  }
}

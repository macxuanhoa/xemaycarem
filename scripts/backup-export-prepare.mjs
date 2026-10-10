// Prepare a friendly, readable export without modifying the native, restorable backup set.
// Names all files and folders inside with human-readable Vietnamese names for the shop owner.
// Prints only private local artifact locations/counts, never customer/object data.
import { copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join, posix, relative, resolve, sep } from 'node:path'
import { BACKUP_DIR, SET_PREFIX, checkSetIntegrity, containedPath, sha256 } from './backup-lib.mjs'

const stamp = process.argv[2]
if (!/^\d{4}-?\d{2}-?\d{2}-\d{6}$/.test(stamp ?? '')) throw new Error('Invalid backup stamp')
const compactStamp = stamp.replaceAll('-', '')
const displayDate = `${compactStamp.slice(6, 8)}-${compactStamp.slice(4, 6)}-${compactStamp.slice(0, 4)}`
const displayTime = `${compactStamp.slice(8, 10)}h${compactStamp.slice(10, 12)}m${compactStamp.slice(12, 14)}s`
const exportName = `Cà Rem - Sao lưu dữ liệu và ảnh xe - ${displayDate} lúc ${displayTime}.zip`
const prefix = `${SET_PREFIX}${stamp}`
const backupRoot = resolve(BACKUP_DIR)
const manifestPath = containedPath(backupRoot, `${prefix}-MANIFEST.md`)
if (!checkSetIntegrity(manifestPath, backupRoot).ok) throw new Error('Native backup integrity failed')

// Parse table tuples from data.sql if available, for rich and intuitive folder naming
function parseTableRows(sql, tableName) {
  const rows = []
  const pattern = new RegExp(`INSERT INTO "?public"?\\."?${tableName}"?\\s*\\(([^)]+)\\)\\s*VALUES`, 'i')
  const match = pattern.exec(sql)
  if (!match) return rows

  const cols = match[1].split(',').map((c) => c.trim().replace(/^["']|["']$/g, ''))
  const valuesStart = match.index + match[0].length
  const semicolonIdx = sql.indexOf(';\n', valuesStart)
  const valuesStr = sql.slice(valuesStart, semicolonIdx !== -1 ? semicolonIdx : undefined)

  let i = 0
  while (i < valuesStr.length) {
    while (i < valuesStr.length && valuesStr[i] !== '(') i++
    if (i >= valuesStr.length) break
    i++ // Skip '('

    const vals = []
    let curr = ''
    let inQuote = false
    while (i < valuesStr.length) {
      const ch = valuesStr[i]
      if (ch === "'") {
        if (inQuote && valuesStr[i + 1] === "'") {
          curr += "'"
          i += 2
          continue
        }
        inQuote = !inQuote
        i++
        continue
      }
      if (!inQuote) {
        if (ch === ',') {
          vals.push(curr.trim().replace(/^'|'$/g, ''))
          curr = ''
          i++
          continue
        }
        if (ch === ')') {
          vals.push(curr.trim().replace(/^'|'$/g, ''))
          i++
          break
        }
      }
      curr += ch
      i++
    }

    if (vals.length) {
      const row = {}
      for (let c = 0; c < cols.length; c++) row[cols[c]] = vals[c] === 'NULL' ? null : vals[c]
      rows.push(row)
    }
  }
  return rows
}

// Clean and sanitize string for Windows/cross-platform path safety
function sanitizePathSegment(str, maxLen = 60) {
  if (!str) return ''
  const cleaned = str
    .replace(/[\\/:*?"<>|\0]/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^[\s.-]+|[\s.-]+$/g, '')
    .trim()
  return cleaned.length > maxLen ? cleaned.slice(0, maxLen).trim() : cleaned
}

// Extract business metadata if data.sql exists
const dataSqlPath = containedPath(backupRoot, `${prefix}-data.sql`)
let vehicleMap = new Map()
let acqMap = new Map()
let identityDocMap = new Map()

if (existsSync(dataSqlPath)) {
  try {
    const dataSql = readFileSync(dataSqlPath, 'utf8')
    for (const v of parseTableRows(dataSql, 'vehicles')) {
      if (v.id) vehicleMap.set(v.id, v)
    }
    for (const a of parseTableRows(dataSql, 'acquisitions')) {
      if (a.id) acqMap.set(a.id, a)
    }
    for (const doc of parseTableRows(dataSql, 'identity_documents')) {
      if (doc.id) identityDocMap.set(doc.id, doc)
    }
  } catch {
    // If parsing fails for any reason, continue with safe fallback numbering
  }
}

// Discover storage objects and buckets
const inventorySource = `${prefix}-storage-inventory.json`
const inventoryFile = containedPath(backupRoot, inventorySource)
let inventory = { version: 1, capturedAt: new Date().toISOString(), buckets: [], objects: [] }

if (existsSync(inventoryFile)) {
  try {
    const parsed = JSON.parse(readFileSync(inventoryFile, 'utf8'))
    if (Array.isArray(parsed.objects) && Array.isArray(parsed.buckets)) inventory = parsed
  } catch {
    // Fall back to scanning files directly
  }
}

// If inventory was missing, scan storage folder if it exists
const storageDir = containedPath(backupRoot, `${prefix}-storage`)
if (inventory.objects.length === 0 && existsSync(storageDir)) {
  const discovered = []
  const bucketsFound = new Set()
  function scanStorage(relDir, bucket) {
    const full = join(storageDir, relDir)
    for (const entry of readdirSync(full)) {
      const entryFull = join(full, entry)
      const entryRel = relDir ? `${relDir}/${entry}` : entry
      if (statSync(entryFull).isDirectory()) {
        if (!bucket) {
          bucketsFound.add(entry)
          scanStorage(entryRel, entry)
        } else {
          scanStorage(entryRel, bucket)
        }
      } else {
        const objectName = entryRel.slice(bucket.length + 1)
        discovered.push({
          bucket_id: bucket,
          name: objectName,
          bytes: statSync(entryFull).size,
          sha256: sha256(entryFull),
        })
      }
    }
  }
  scanStorage('', null)
  inventory.objects = discovered
  inventory.buckets = [...bucketsFound].map((id) => ({ id, name: id, public: false }))
}

// Collect all backup source files for this stamp
const sourcePaths = []
function collect(sourcePath) {
  const full = containedPath(backupRoot, sourcePath)
  const info = lstatSync(full)
  if (info.isSymbolicLink()) throw new Error('Export sources must not use symbolic links')
  if (info.isDirectory()) {
    for (const entry of readdirSync(full)) collect(`${sourcePath}/${entry}`)
  } else if (info.isFile()) sourcePaths.push(sourcePath)
  else throw new Error('Unsupported export source')
}
for (const entry of readdirSync(backupRoot)) if (entry.startsWith(`${prefix}-`)) collect(entry)
sourcePaths.sort() // Ordinal path order

// Core database files naming
const names = new Map([
  [`${prefix}-schema.sql`, '01 - Cấu trúc cơ sở dữ liệu.sql'],
  [`${prefix}-data.sql`, '02 - Dữ liệu cửa hàng.sql'],
  [`${prefix}-migration-history.txt`, '03 - Lịch sử cập nhật hệ thống.txt'],
  [`${prefix}-MANIFEST.md`, '05 - Thông tin và mã kiểm tra bản sao lưu gốc.md'],
])
if (existsSync(inventoryFile)) {
  names.set(inventorySource, '04 - Danh mục ảnh và đường dẫn khôi phục.json')
}

for (const [source] of names) {
  if (!sourcePaths.includes(source)) throw new Error(`Required export source missing: ${source}`)
}

// Index storage objects
const storageObjects = new Map()
for (const object of inventory.objects) {
  if (typeof object.bucket_id !== 'string' || typeof object.name !== 'string') throw new Error('Invalid Storage object path')
  const sourcePath = `${prefix}-storage/${object.bucket_id}/${object.name}`
  containedPath(backupRoot, sourcePath)
  if (storageObjects.has(sourcePath)) throw new Error('Duplicate Storage inventory entry')
  storageObjects.set(sourcePath, object)
}

const storedSources = sourcePaths.filter((source) => source.startsWith(`${prefix}-storage/`))
if (storedSources.length !== storageObjects.size || storedSources.some((source) => !storageObjects.has(source))) {
  throw new Error('Storage files and original inventory do not match')
}

// Group storage objects and generate intuitive human-readable Vietnamese labels
const buckets = [...new Set(inventory.objects.map((object) => object.bucket_id))].sort()
const otherBuckets = buckets.filter((bucket) => !['vehicle-images', 'identity-documents'].includes(bucket))

const groupNumbers = new Map()
for (const bucket of buckets) {
  const groups = [...new Set(inventory.objects.filter((object) => object.bucket_id === bucket).map((object) => posix.dirname(object.name)))].sort()
  groups.forEach((group, i) => groupNumbers.set(`${bucket}\0${group}`, i + 1))
}

const imageNumbers = new Map()
const groupLabels = []

for (const sourcePath of storedSources) {
  const object = storageObjects.get(sourcePath)
  const group = posix.dirname(object.name)
  const groupKey = `${object.bucket_id}\0${group}`
  const number = (imageNumbers.get(groupKey) ?? 0) + 1
  imageNumbers.set(groupKey, number)
  const groupNum = groupNumbers.get(groupKey)

  let bucketLabel = ''
  let groupLabel = ''
  let fileLabel = ''
  const ext = posix.extname(object.name)

  if (object.bucket_id === 'vehicle-images') {
    bucketLabel = 'Ảnh xe'
    const v = vehicleMap.get(group)
    let desc = `Xe ${String(groupNum).padStart(2, '0')}`
    if (v) {
      const parts = []
      const modelName = [v.brand, v.model].filter(Boolean).join(' ')
      if (modelName) parts.push(modelName)
      if (v.license_plate) parts.push(v.license_plate)
      if (v.internal_code) parts.push(`(${v.internal_code})`)
      if (parts.length) desc += ` - ${parts.join(' - ')}`
    }
    groupLabel = sanitizePathSegment(desc)
    fileLabel = `Ảnh ${String(number).padStart(2, '0')}${ext}`
  } else if (object.bucket_id === 'identity-documents') {
    bucketLabel = 'Ảnh giấy tờ'
    const acq = acqMap.get(group)
    const linkedVehicle = acq?.vehicle_id ? vehicleMap.get(acq.vehicle_id) : null
    let desc = `Hồ sơ ${String(groupNum).padStart(2, '0')}`

    // Find if this group matches any identity document
    let matchingDoc = null
    for (const [, doc] of identityDocMap) {
      if (doc.acquisition_id === group || doc.front_image_path?.startsWith(group) || doc.back_image_path?.startsWith(group)) {
        matchingDoc = doc
        break
      }
    }

    if (matchingDoc?.full_name) desc += ` - CCCD ${matchingDoc.full_name}`
    else if (linkedVehicle) {
      const vName = [linkedVehicle.brand, linkedVehicle.model].filter(Boolean).join(' ')
      desc += ` - Giấy tờ xe ${vName || linkedVehicle.internal_code || ''}`
    } else if (acq?.seller_name) desc += ` - ${acq.seller_name}`

    groupLabel = sanitizePathSegment(desc)

    // Check if image is front or back of ID card
    const isFront = matchingDoc?.front_image_path?.endsWith(posix.basename(object.name))
    const isBack = matchingDoc?.back_image_path?.endsWith(posix.basename(object.name))

    if (isFront) fileLabel = `Ảnh ${String(number).padStart(2, '0')} - Mặt trước CCCD${ext}`
    else if (isBack) fileLabel = `Ảnh ${String(number).padStart(2, '0')} - Mặt sau CCCD${ext}`
    else fileLabel = `Ảnh ${String(number).padStart(2, '0')}${ext}`
  } else {
    bucketLabel = `Tệp khác/Kho ${String(otherBuckets.indexOf(object.bucket_id) + 1).padStart(2, '0')}`
    groupLabel = `Nhóm ${String(groupNum).padStart(2, '0')}`
    fileLabel = `Tệp ${String(number).padStart(2, '0')}${ext}`
  }

  const archivePath = `${bucketLabel}/${groupLabel}/${fileLabel}`
  names.set(sourcePath, archivePath)
  if (number === 1) groupLabels.push({ archiveFolder: `${bucketLabel}/${groupLabel}`, bucket_id: object.bucket_id, sourceGroup: group })
}

let extraNumber = 0
for (const sourcePath of sourcePaths) {
  if (!names.has(sourcePath)) {
    names.set(sourcePath, `Tệp bổ sung/Tệp ${String(++extraNumber).padStart(2, '0')}${posix.extname(sourcePath)}`)
  }
}

// Stage files into temporary preview folder
const stagingRoot = mkdtempSync(join(backupRoot, 'export-preview-'))
const stagePath = join(stagingRoot, 'Nội dung bản sao lưu')
mkdirSync(stagePath)
const files = []
const expected = []
const usedNames = new Set()

function register(archivePath) {
  const key = archivePath.toLowerCase()
  if (usedNames.has(key)) throw new Error(`Duplicate friendly archive path: ${archivePath}`)
  usedNames.add(key)
  return containedPath(stagePath, archivePath)
}

function fingerprint(file, archivePath) {
  return { archivePath, bytes: statSync(file).size, SHA256: sha256(file).toUpperCase() }
}

for (const sourcePath of sourcePaths) {
  const archivePath = names.get(sourcePath)
  const source = containedPath(backupRoot, sourcePath)
  const target = register(archivePath)
  mkdirSync(join(target, '..'), { recursive: true })
  copyFileSync(source, target)
  const entry = fingerprint(target, archivePath)
  if (entry.bytes !== statSync(source).size || entry.SHA256 !== sha256(source).toUpperCase()) {
    throw new Error('Export copy changed source bytes')
  }
  const object = storageObjects.get(sourcePath)
  if (object && (object.bytes !== entry.bytes || String(object.sha256).toUpperCase() !== entry.SHA256)) {
    throw new Error('Export photo differs from original Storage inventory')
  }
  files.push({ sourcePath, ...entry, ...(object ? { bucket_id: object.bucket_id, name: object.name } : {}) })
  expected.push(entry)
}

// Readme and documentation files
const readmeName = 'ĐỌC TRƯỚC - Hướng dẫn bản sao lưu.txt'
const readmePath = register(readmeName)
writeFileSync(
  readmePath,
  `BẢN SAO LƯU DỮ LIỆU & HÌNH ẢNH — CÀ REM CRM
======================================================
Thời điểm chụp bản sao lưu: ${displayDate} lúc ${displayTime} (Giờ Việt Nam).
Mã sao lưu hệ thống: ${stamp}
Tổng cộng: ${files.length} tệp nguồn (${storageObjects.size} ảnh/tệp hình ảnh lưu trữ).
Toàn bộ dữ liệu được bảo toàn 100% nguyên gốc từng byte với mã băm SHA-256.

CẤU TRÚC VÀ Ý NGHĨA CÁC TỆP TRONG BẢN SAO LƯU:
------------------------------------------------------
1. "01 - Cấu trúc cơ sở dữ liệu.sql":
   - Chứa định nghĩa toàn bộ bảng dữ liệu, trường thông tin, quan hệ, khóa chính/ngoại và hàm xử lý của hệ thống Cà Rem.

2. "02 - Dữ liệu cửa hàng.sql":
   - Chứa toàn bộ dữ liệu thực tế của cửa hàng: kho xe, phiếu thu/chi, lịch sử mua bán, thông tin khách hàng, nhật ký hoạt động.

3. "03 - Lịch sử cập nhật hệ thống.txt":
   - Danh sách ghi nhận các bản nâng cấp cơ sở dữ liệu (migration ledger) đã được áp dụng.

4. "04 - Danh mục ảnh và đường dẫn khôi phục.json":
   - Bảng kê chi tiết từng ảnh kèm tên thư mục lưu trữ gốc (bucket_id và object name) trên máy chủ Supabase.

5. "05 - Thông tin và mã kiểm tra bản sao lưu gốc.md":
   - Báo cáo chi tiết số lượng dòng dữ liệu, số người dùng, số ảnh và bảng mã băm SHA-256 gốc của từng tệp.

6. "06 - Bảng đối chiếu tên tệp và mã kiểm tra.json":
   - Bản ánh xạ chi tiết giữa tên dễ đọc trong file ZIP này với đường dẫn tệp gốc trên máy chủ. Giúp công cụ khôi phục tự động định vị lại chính xác.

7. Thư mục "Ảnh xe":
   - Chứa hình ảnh các dòng xe trong cửa hàng, được phân loại rõ ràng theo từng xe (kèm mã xe, dòng xe và biển số xe).

8. Thư mục "Ảnh giấy tờ":
   - Chứa hình ảnh CCCD, giấy tờ mua bán, hồ sơ xe của khách hàng (được phân loại rõ ràng mặt trước, mặt sau).

HƯỚNG DẪN KHÔI PHỤC DỮ LIỆU KHI CẦN THIẾT:
------------------------------------------------------
Bước 1: Đối chiếu dung lượng (bytes) và mã SHA-256 trong tệp "06 - Bảng đối chiếu tên tệp và mã kiểm tra.json" để đảm bảo tính toàn vẹn.
Bước 2: Nạp cấu trúc bảng từ tệp "01 - Cấu trúc cơ sở dữ liệu.sql" vào hệ quản trị PostgreSQL mới.
Bước 3: Nạp dữ liệu cửa hàng từ tệp "02 - Dữ liệu cửa hàng.sql".
Bước 4: Sử dụng tệp "06 - Bảng đối chiếu tên tệp và mã kiểm tra.json" để tải lại từng ảnh lên đúng vị trí lưu trữ ban đầu (bucket và tên object gốc).
Bước 5: Kiểm tra số lượng xe trong kho, doanh số và ảnh trên giao diện Cà Rem CRM để xác nhận hoàn tất.

* LƯU Ý BẢO MẬT: Bản sao lưu này chứa thông tin kinh doanh, căn cước công dân và lịch sử giao dịch của cửa hàng. Vui lòng chỉ lưu trữ tại Google Drive hoặc thiết bị cá nhân có mật khẩu bảo vệ an toàn.
`,
  'utf8',
)
const readmeEntry = fingerprint(readmePath, readmeName)
expected.push(readmeEntry)

// Mapping file
const mappingName = '06 - Bảng đối chiếu tên tệp và mã kiểm tra.json'
const mappingPath = register(mappingName)
writeFileSync(
  mappingPath,
  JSON.stringify(
    {
      version: 2,
      description: 'Bảng đối chiếu tên dễ đọc với toàn bộ file/thư mục của bản sao lưu gốc. Dùng sourcePath để dựng lại bộ nguồn; dùng bucket_id/name gốc để phục hồi ảnh.',
      backupStamp: stamp,
      capturedAt: inventory.capturedAt,
      sourceFiles: files.length,
      storageObjects: storageObjects.size,
      files,
      generatedFiles: [{ sourcePath: null, ...readmeEntry, generated: true }],
      storageGroups: groupLabels,
      selfChecksumNote: 'SHA-256 của bảng này không thể nằm trong chính bảng. Kết quả xuất có SHA-256 của bảng và của toàn bộ ZIP; mọi entry đã được kiểm tra trước khi hoàn tất.',
    },
    null,
    2,
  ) + '\n',
  'utf8',
)
expected.push(fingerprint(mappingPath, mappingName))

const expectedPath = join(stagingRoot, 'expected-zip.json')
writeFileSync(expectedPath, JSON.stringify({ files: expected }, null, 2) + '\n', 'utf8')

if (!existsSync(stagePath) || relative(backupRoot, stagePath).startsWith(`..${sep}`)) throw new Error('Export staging left backup root')

console.log(
  JSON.stringify({
    ExportName: exportName,
    StagePath: stagePath,
    ExpectedPath: expectedPath,
    SourceFiles: files.length,
    StorageObjects: storageObjects.size,
    GeneratedFiles: 2,
    MappingPath: mappingName,
    MappingSHA256: sha256(mappingPath).toUpperCase(),
    NativeBytesPreserved: true,
  }),
)

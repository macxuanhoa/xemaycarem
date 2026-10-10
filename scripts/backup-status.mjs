// One-screen answer to "dữ liệu của tôi có an toàn không?" — reads only the local
// backups/ health marker and set listing, never touches production. Exit code 1 when the
// newest successful backup is older than 26 hours or the last restore drill failed, so a
// scheduled wrapper can surface the problem in Task Scheduler history.
// Usage: npm run backup:status
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { BACKUP_DIR, MIRROR_MARKER, SET_PREFIX, checkSetIntegrity, listSets, needsRestoreDrill, offsiteTarget, readHealth } from './backup-lib.mjs'

const health = readHealth()
const sets = listSets()
const complete = sets.filter((s) => s.manifest)
const newest = sets.at(-1)
const hoursSince = (iso) => (Date.now() - new Date(iso).getTime()) / 3600e3
const fmtAge = (iso) => {
  if (!iso) return 'CHƯA CÓ'
  const h = hoursSince(iso)
  return h < 24 ? `${h.toFixed(1)} giờ trước` : `${(h / 24).toFixed(1)} ngày trước`
}

const lines = []
const flags = []
lines.push('=== SỨC KHỎE SAO LƯU — Cà Rem CRM ===')

const lastOk = health?.lastBackup ?? null
if (lastOk) {
  lines.push(`Bản chụp gần nhất : ${lastOk.stamp} (${fmtAge(lastOk.at)}) — ${lastOk.files} tệp, ${(lastOk.bytes / 1024).toFixed(0)} KiB, ${lastOk.storageObjects} ảnh/tệp Storage`)
  const stale = hoursSince(lastOk.at) > 26
  if (stale) flags.push(`SAO LƯU QUÁ CŨ: hơn 26 giờ chưa có bản mới. Xem log: ${join(BACKUP_DIR, 'backup.log')}`)
  const set = complete.find((s) => s.stamp === lastOk.stamp)
  if (!set) flags.push('BẢN CHỤP GẦN NHẤT KHÔNG CÒN ĐỦ MANIFEST TRÊN MÁY')
  else {
    const integrity = checkSetIntegrity(set.manifest)
    if (!integrity.ok) flags.push(`CHECKSUM LỖI: ${integrity.failures.slice(0, 3).join('; ')}`)
    if (!integrity.fullHashes) lines.push('                       (bản cũ dùng 16 ký tự checksum; bản mới sẽ dùng đủ SHA-256)')
  }
} else {
  flags.push('CHƯA CÓ BẢN CHỤP THÀNH CÔNG NÀO được ghi nhận trong backups/LATEST.json — chạy: npm run backup:prod')
}
if (health?.lastBackupFailure) lines.push(`Lần thất bại gần nhất: ${health.lastBackupFailure.stamp} — ${health.lastBackupFailure.error} (${fmtAge(health.lastBackupFailure.at)})`)
if (health?.consecutiveBackupFailures > 0) flags.push(`${health.consecutiveBackupFailures} lần liên tiếp thất bại`)

lines.push('')
if (health?.lastVerify) {
  const v = health.lastVerify
  lines.push(`Diễn tập khôi phục   : ${v.ok ? 'ĐẠT — dữ liệu nghiệp vụ nạp lại trên PostgreSQL thử' : 'LỖI'} (${v.stamp}, ${fmtAge(v.at)})${v.ok ? '' : `: ${v.failed?.join('; ')}`}`)
  if (!v.ok) flags.push(`DIỄN TẬP KHÔI PHỤC LỖI trên bản ${v.stamp}: ${v.failed?.join('; ')}`)
  if (lastOk && v.stamp !== lastOk.stamp) lines.push('                       (bản mới nhất chưa được diễn tập — chạy npm run backup:verify)')
  if (needsRestoreDrill(health)) flags.push('DIỄN TẬP HẰNG TUẦN ĐÃ ĐẾN HẠN: chạy npm run backup:verify')
  lines.push('                       Auth/Storage trên Supabase cần diễn tập riêng ở staging; kiểm tra local chưa chứng minh đăng nhập và quyền truy cập ảnh.')
} else {
  flags.push('CHƯA DIỄN TẬP KHÔI PHỤC: chưa chứng minh được bản chụp nào nạp lại được. Chạy: npm run backup:verify')
}

lines.push('')
lines.push(`Số bộ đang giữ      : ${complete.length} bộ hoàn chỉnh${sets.length - complete.length ? ` + ${sets.length - complete.length} bộ dở dang (không tự xóa)` : ''}`)
if (newest && complete.length) {
  const oldest = complete[0]
  lines.push(`Lịch sử             : ${oldest.stamp} -> ${complete.at(-1).stamp}, chiếm ${((complete.reduce((n, s) => n + s.bytes, 0)) / 1048576).toFixed(1)} MiB`)
}
const retentionWarn = complete.length < 7 && complete.length > 1
if (retentionWarn) lines.push(`Dự phòng          : mới có ${complete.length} bộ — lịch hằng ngày sẽ tích dần tới 7 bộ ngày / 4 bộ tuần / 12 bộ tháng`)

lines.push('')
const target = offsiteTarget()
if (!target) flags.push('BẢN SAO THỨ HAI CHƯA BẬT: tất cả bản chụp đang nằm trên đúng máy này. Cách bật: xem tệp backups/offsite.txt')
else if (!existsSync(target)) flags.push(`Bản sao thứ hai không ghi được: ${target} không tồn tại (Google Drive chưa đồng bộ ở máy này / ổ chưa cắm)`)
else if (!existsSync(join(target, MIRROR_MARKER))) flags.push(`Bản sao thứ hai bị chặn: chưa xác nhận ${target} là nơi cất backup (thiếu tệp ${MIRROR_MARKER})`)
else {
  let mirrored = null
  try { mirrored = existsSync(join(target, 'LATEST.json')) ? JSON.parse(readFileSync(join(target, 'LATEST.json'), 'utf8'))?.lastBackup?.stamp : null } catch { flags.push('TRẠNG THÁI BẢN SAO THỨ HAI BỊ HỎNG') }
  lines.push(`Bản sao thứ hai     : ${target} — lần ghi cuối ${mirrored || 'chưa rõ'}`)
  if (lastOk && mirrored !== lastOk.stamp) flags.push(`Bản sao thứ hai đang cũ (${mirrored}) so với bản mới nhất (${lastOk.stamp})`)
  if (lastOk && mirrored === lastOk.stamp) {
    const setDir = join(target, `${SET_PREFIX}${mirrored}`)
    const manifest = join(setDir, `${SET_PREFIX}${mirrored}-MANIFEST.md`)
    if (!existsSync(manifest) || !checkSetIntegrity(manifest, setDir).ok) flags.push('CHECKSUM BẢN SAO THỨ HAI KHÔNG ĐẠT')
  }
}

console.log(lines.join('\n'))
if (flags.length) {
  console.log('\nCẦN XỬ LÝ:')
  for (const f of flags) console.log(`  ! ${f}`)
  console.log('\nCách xử lý nhanh:')
  console.log('  npm run backup:prod -- --prune     chụp ngay bây giờ (Docker + Supabase CLI phải đang chạy)')
  console.log('  npm run backup:verify              diễn tập nạp lại bản mới nhất')
  console.log('  Bản sao thứ hai: mở tệp backups/offsite.txt bằng Notepad, ghi đường dẫn thư mục')
  console.log('     Google Drive (ví dụ "G:\\CaremBackups") vào dòng đầu tiên, rồi tạo tệp trống')
  process.exitCode = 1
} else {
  console.log('\nKẾT LUẬN: sao lưu tự động đang healthy. Lần tới mở màn hình này mà thấy CẦN XỬ LÝ là có việc phải làm.')
}

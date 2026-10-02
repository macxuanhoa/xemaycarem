#!/usr/bin/env node
/**
 * Generates docs/SYSTEM_REFERENCE.md straight from the repository itself:
 * every public RPC (signature + role gate parsed from the latest migration that
 * defines it), every in-app route with its access level from src/App.tsx, the
 * Edge Functions and the storage buckets. Because the file is derived from code
 * it is always aligned with what the system actually does; regenerate it with
 * `npm run knowledge:system` (chained into knowledge:seed / knowledge:check) so
 * `build-knowledge-seed.mjs` can feed it to the copilot knowledge base.
 *
 * Usage:
 *   node scripts/build-system-docs.mjs            # write docs/SYSTEM_REFERENCE.md
 *   node scripts/build-system-docs.mjs --stdout   # print without writing
 *   node scripts/build-system-docs.mjs --check    # fail if the committed file is stale
 *
 * Output is deterministic (no timestamps) so --check is stable across machines.
 */
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const TARGET = 'docs/SYSTEM_REFERENCE.md';

/** Read migrations oldest-first; the LAST definition of a function wins, mirroring PostgreSQL. */
async function readPublicFunctions() {
  const migrations = join(root, 'supabase', 'migrations');
  const files = (await readdir(migrations)).filter((name) => name.endsWith('.sql')).sort();
  const functions = new Map();
  for (const file of files) {
    const sql = await readFile(join(migrations, file), 'utf8');
    const header = /CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+public\.([a-z_]+)\s*\(/gi;
    let match;
    while ((match = header.exec(sql)) !== null) {
      const name = match[1];
      const argsStart = match.index + match[0].length; // just after the opening paren
      let depth = 1;
      let index = argsStart;
      while (index < sql.length && depth > 0) {
        if (sql[index] === '(') depth += 1;
        else if (sql[index] === ')') depth -= 1;
        index += 1;
      }
      const rawArgs = sql.slice(argsStart, index - 1).replace(/\s+/g, ' ').trim();
      const tail = sql.slice(index);
      const returns = tail.match(/\bRETURNS\s+([a-z_]+(?:\s*\([^)]*\))?|TABLE\s*\(([^)]*)\))/i);
      const bodyEnd = tail.search(/CREATE\s+(?:OR\s+REPLACE\s+)?(?:FUNCTION|TRIGGER|POLICY|TABLE|INDEX)/i);
      const body = tail.slice(0, bodyEnd < 0 ? tail.length : bodyEnd);
      const roleGate = body.match(/private\.require_role\(\s*ARRAY\[([^\]]*)\]/i);
      const roles = roleGate
        ? [...new Set(roleGate[1].split(',').map((role) => role.trim().replace(/'/g, '')))]
        : [];
      functions.set(name, {
        name,
        file,
        args: rawArgs,
        returns: returns?.[1]?.replace(/\s+/g, '') ?? 'jsonb',
        roles,
        definer: /SECURITY\s+DEFINER/i.test(body.slice(0, 400)),
      });
    }
  }
  return [...functions.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** Walk the JSX <Route> tree of src/App.tsx keeping each route's inherited access level. */
async function readRoutes() {
  const source = await readFile(join(root, 'src', 'App.tsx'), 'utf8');
  const accessLabels = { read: 'đăng nhập', operate: 'STAFF trở lên (trong lịch làm việc)', manage: 'MANAGER hoặc OWNER', owner: 'chỉ OWNER' };
  const stack = [{ segment: '', access: 'public' }];
  const routes = [];
  // A hand-rolled scanner: attribute values embed `/>` and `}` (inline JSX elements),
  // so each <Route ...> must be read with brace/quote awareness instead of a regex.
  let cursor = 0;
  const opener = /<Route(?=[\s/>])/g;
  while (true) {
    const close = source.indexOf('</Route>', cursor);
    opener.lastIndex = cursor;
    const found = opener.exec(source);
    const next = found ? found.index : -1;
    if (next === -1) break;
    if (close !== -1 && close < next) {
      stack.pop();
      cursor = close + '</Route>'.length;
      continue;
    }
    let index = next + '<Route'.length;
    let depth = 0;
    let quote = null;
    let selfClosing = false;
    let attrs = '';
    for (; index < source.length; index += 1) {
      const char = source[index];
      if (quote) {
        attrs += char;
        if (char === quote) quote = null;
        continue;
      }
      if (char === '"' || char === "'") { quote = char; attrs += char; continue; }
      if (char === '{') { depth += 1; attrs += char; continue; }
      if (char === '}') { depth -= 1; attrs += char; continue; }
      if (depth === 0 && char === '/' && source[index + 1] === '>') { selfClosing = true; break; }
      if (depth === 0 && char === '>') break;
      attrs += char;
    }
    index += 2; // skip `/>` or `>`
    const protectedMatch = attrs.match(/<Protected\b([^>]*)>/);
    if (protectedMatch) {
      const access = protectedMatch[1].match(/access="(\w+)"/)?.[1] ?? 'read';
      stack.push({ segment: '', access });
      cursor = index;
      if (!selfClosing) continue; // layout wrapper stays open until its </Route>
      stack.pop();
      continue;
    }
    if (/element=\{<AppLayout/.test(attrs)) {
      stack.push({ segment: '', access: null, layout: true });
      cursor = index;
      continue;
    }
    const path = attrs.match(/path="([^"]*)"/)?.[1] ?? null;
    const isIndex = /(^|[\s{])index(\s*=|\s|\/|>|})/.test(attrs) || /\bindex\b/.test(attrs.replace(/path="[^"]*"/g, ''));
    if (path === null && !isIndex) { cursor = index; if (!selfClosing) stack.push({ segment: '', access: null }); continue; }
    const parentPath = stack.map((frame) => frame.segment).filter(Boolean).join('/');
    const fullPath = `/${isIndex ? parentPath : `${parentPath}/${path}`.replace(/^\//, '')}`.replace(/\/\/+/g, '/').replace(/\/$/, '') || '/';
    let inherited = 'public';
    for (const frame of stack) if (frame.access) inherited = frame.access;
    routes.push({ path: fullPath, access: accessLabels[inherited] ?? 'công khai (không cần đăng nhập)' });
    if (!selfClosing) stack.push({ segment: path ?? '', access: null });
    cursor = index;
  }
  // De-duplicate while keeping source order.
  const seen = new Set();
  return routes.filter((route) => {
    if (seen.has(route.path)) return false;
    seen.add(route.path);
    return true;
  });
}

async function readEdgeFunctions() {
  const dir = join(root, 'supabase', 'functions');
  const entries = await readdir(dir, { withFileTypes: true });
  const functions = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    let description = '';
    try {
      const source = await readFile(join(dir, entry.name, 'index.ts'), 'utf8');
      description = source
        .split(/\r?\n/)
        .filter((line) => line.startsWith('//') && !/eslint|deno-lint/.test(line))
        .map((line) => line.replace(/^\/\/\s*/, ''))
        .filter((line) => line && !line.startsWith(`Edge Function: ${entry.name}`))
        .slice(0, 2)
        .join(' ');
    } catch {
      description = '(không có index.ts)';
    }
    functions.push({ name: entry.name, description: description || 'Edge Function nội bộ của cửa hàng.' });
  }
  return functions.sort((a, b) => a.name.localeCompare(b.name));
}

/** storage.buckets INSERT statements are the only source of truth for bucket rules. */
async function readBuckets() {
  const migrations = join(root, 'supabase', 'migrations');
  const files = (await readdir(migrations)).filter((name) => name.endsWith('.sql')).sort();
  const buckets = new Map();
  for (const file of files) {
    const sql = await readFile(join(migrations, file), 'utf8');
    for (const match of sql.matchAll(/insert\s+into\s+storage\.buckets\s*\(([^)]*)\)\s*values\s*\(([^;]*?)\)\s*on\s+conflict/gi)) {
      const columns = match[1].split(',').map((column) => column.trim());
      const values = match[2].split(/,(?![^(]*\))/).map((value) => value.trim());
      const row = Object.fromEntries(columns.slice(0, 4).map((column, i) => [column, values[i]]));
      const mime = values.slice(4).join(',').replace(/array\[|]|'"?/gi, '');
      if (!row.id) continue;
      buckets.set(row.id.replace(/'/g, ''), {
        id: row.id.replace(/'/g, ''),
        public: (row.public ?? 'false').toLowerCase() === 'true',
        limit: Number(row.file_size_limit ?? 0),
        mime,
        file,
      });
    }
  }
  return [...buckets.values()];
}

const escapeCell = (value) => String(value).replace(/\|/g, '\\|');

async function render() {
  const debug = (stage) => { if (process.env.SYSTEM_DOCS_DEBUG) console.error(`[system-docs] ${stage}`); };
  debug('rpc');
  const functions = await readPublicFunctions();
  debug(`rpc done: ${functions.length}`);
  const routes = await readRoutes();
  debug(`routes done: ${JSON.stringify(routes.map((route) => route.path))}`);
  const edgeFunctions = await readEdgeFunctions();
  debug('edge done');
  const buckets = await readBuckets();
  debug(`buckets done: ${buckets.length}`);
  const rpcRows = functions.map((fn) =>
    `| ${fn.name} | ${escapeCell(fn.args || 'không tham số')} | ${fn.roles.length ? fn.roles.join(', ') : 'kiểm tra quyền riêng trong hàm'} |`);
  const routeRows = routes.map((route) => `| \`${route.path}\` | ${route.access} |`);
  const edgeRows = edgeFunctions.map((fn) => `| ${fn.name} | ${escapeCell(fn.description)} |`);
  const bucketRows = buckets.map((bucket) =>
    `| ${bucket.id} | ${bucket.public ? 'công khai' : 'riêng tư'} | ${bucket.limit ? Math.round(bucket.limit / 1048576) + ' MB' : 'mặc định'} | ${escapeCell(bucket.mime || 'ảnh')} |`);

  return `# Tham chiếu hệ thống (sinh tự động)

File này do \`scripts/build-system-docs.mjs\` sinh ra từ chính mã nguồn — **không sửa tay**, sửa script hoặc nguồn rồi chạy \`npm run knowledge:system\`. Nội dung luôn khớp migration mới nhất, routes trong \`src/App.tsx\`, thư mục \`supabase/functions\` và các statement tạo bucket.

## Danh sách chức năng database (RPC)

Toàn bộ hàm \`public\` mà ứng dụng gọi được, lấy từ định nghĩa cuối cùng trong \`supabase/migrations\`. Cột quyền là \`private.require_role\` khai báo trong thân hàm; "kiểm tra quyền riêng" nghĩa là hàm dùng cơ chế khác (so sánh vai trò trực tiếp, chủ tài khoản cuối cùng, v.v.).

| RPC | Tham số | Vai trò cần |
| --- | --- | --- |
${rpcRows.join('\n')}

## Màn hình ứng dụng và quyền mở

Trích từ cây route trong \`src/App.tsx\` (thành phần \`Protected\` kế thừa theo cây).

| Đường dẫn | Quyền mở |
| --- | --- |
${routeRows.join('\n')}

## Edge Functions

| Function | Vai trò |
| --- | --- |
${edgeRows.join('\n')}

## Bucket ảnh riêng tư

Khai báo \`storage.buckets\` trong migration; đường dẫn object luôn là \`<uuid-chủ>/<uuid-ngẫu-nhiên>.<đuôi>\` và trình duyệt chỉ xem qua signed URL ngắn hạn.

| Bucket | Chế độ | Giới hạn dung lượng | Định dạng |
| --- | --- | --- | --- |
${bucketRows.join('\n')}
`;
}

const args = process.argv.slice(2);
const markdown = await render();
const normalize = (value) => value.replace(/\r\n/g, '\n').trimEnd();

if (args.includes('--stdout')) {
  process.stdout.write(markdown);
} else if (args.includes('--check')) {
  const committed = await readFile(join(root, TARGET), 'utf8').catch(() => null);
  if (committed === null || normalize(committed) !== normalize(markdown)) {
    console.error(`${TARGET} is stale: run \`npm run knowledge:system\` after changing code, RPCs or routes.`);
    process.exitCode = 1;
  } else {
    console.log(`${TARGET} is up to date.`);
  }
} else {
  await writeFile(join(root, TARGET), markdown, 'utf8');
  console.log(`${TARGET}: generated from code.`);
}

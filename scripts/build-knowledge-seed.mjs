#!/usr/bin/env node
/**
 * Builds the knowledge_base seed migration from the repository documentation.
 *
 * The AI copilot answers documentation questions from public.knowledge_base, so the
 * markdown corpus must be reproducible inside migrations (PGLite tests and fresh
 * databases get the same rows without touching the filesystem at runtime).
 *
 * Usage:
 *   node scripts/build-knowledge-seed.mjs                 # write the fixed seed migration
 *   node scripts/build-knowledge-seed.mjs --out <path>     # write elsewhere (inspection)
 *   node scripts/build-knowledge-seed.mjs --stdout          # print without writing
 *   node scripts/build-knowledge-seed.mjs --check           # fail if the committed seed is stale
 *
 * Each `## ` heading becomes one row so a citation can link straight to the section.
 * Audience tiers follow private.knowledge_visible(): ALL, STAFF, MANAGER, OWNER.
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, basename } from 'node:path';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const SEED_FILE = '20261001002900_knowledge_seed.sql';
const MAX_BODY = 58_000;

/** source_path -> { audience, title } */
const SOURCES = [
  { path: 'README.md', audience: 'ALL', title: 'Hướng dẫn sử dụng Cà Rem CRM' },
  { path: 'docs/PROJECT_STATE.md', audience: 'STAFF', title: 'Hiện trạng dự án' },
  { path: 'docs/OPERATIONS.md', audience: 'MANAGER', title: 'Vận hành và sao lưu' },
  { path: 'docs/DECISIONS.md', audience: 'MANAGER', title: 'Quyết kiến trúc và nghiệp vụ' },
  { path: 'docs/KNOWN_ISSUES.md', audience: 'MANAGER', title: 'Lỗi đã biết và giới hạn' },
  { path: 'docs/VERIFICATION.md', audience: 'MANAGER', title: 'Quy trình kiểm chứng' },
  { path: 'docs/COMMUNICATION_ARCHITECTURE.md', audience: 'MANAGER', title: 'Kiến trúc liên lạc khách hàng' },
  { path: 'docs/AI_ASSIST_CONTRACT.md', audience: 'MANAGER', title: 'Hợp đồng AI trợ lý' },
  { path: 'docs/UX_FRICTION_AUDIT.md', audience: 'MANAGER', title: 'Kiểm ma sát trải nghiệm' },
  { path: 'docs/PRODUCTION_RELEASE.md', audience: 'OWNER', title: 'Phát hành production' },
  { path: 'docs/AGENT_HANDOFF.md', audience: 'OWNER', title: 'Bàn giao cho agent' },
  { path: 'docs/IMPLEMENTATION_PLAN.md', audience: 'OWNER', title: 'Kế hoạch triển khai' },
  { path: 'docs/IMPLEMENTATION_REPORT.md', audience: 'OWNER', title: 'Báo cáo triển khai' },
  { path: 'docs/AUTH_ACCEPTANCE_REPORT.md', audience: 'OWNER', title: 'Nghiệm thu phân quyền' },
  { path: 'docs/AUTH_BACKUP_METADATA.md', audience: 'OWNER', title: 'Sao lưu metadata đăng nhập' },
  { path: 'docs/AUTH_RECOVERY_AUDIT.md', audience: 'OWNER', title: 'Kiểm kê khôi phục tài khoản' },
  { path: 'supabase/API.md', audience: 'MANAGER', title: 'Hợp đồng database và RPC' },
  { path: 'supabase/SECURITY.md', audience: 'OWNER', title: 'Mô hình bảo mật Supabase' },
];

const slugify = (value) =>
  value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);

/** Postgres string literal escaping: only the single quote needs doubling. */
const quote = (value) => `'${String(value).replace(/'/g, "''")}'`;

const sqlValue = (value) => (value === null ? 'null' : quote(value));

function splitSections(markdown) {
  const lines = markdown.replace(/\r\n/g, '\n').split('\n');
  const chunks = [];
  let current = { heading: null, lines: [] };
  for (const line of lines) {
    if (/^##\s+/.test(line) && !/^###/.test(line)) {
      if (current.lines.join('\n').trim() || current.heading) chunks.push(current);
      current = { heading: line.replace(/^##\s+/, '').trim(), lines: [line] };
      continue;
    }
    current.lines.push(line);
  }
  if (current.lines.join('\n').trim()) chunks.push(current);
  return chunks;
}

/** Keep every row under the table CHECK limit by falling back to `### ` subheadings. */
function bounded(chunk, index, sub) {
  const body = chunk.lines.join('\n').trim();
  if (body.length <= MAX_BODY || !chunk.heading) return [{ ...chunk, body, index, sub }];
  const parts = [];
  let active = { heading: chunk.heading, lines: [chunk.lines[0]] };
  for (const line of chunk.lines.slice(1)) {
    if (/^###\s+/.test(line)) {
      if (active.lines.join('\n').trim()) parts.push(active);
      active = { heading: line.replace(/^###\s+/, '').trim(), lines: [line] };
    } else active.lines.push(line);
  }
  if (active.lines.join('\n').trim()) parts.push(active);
  // `index-n` keeps these distinct from the plain `index` slug of an unsplit section.
  return parts.map((part, i) => ({
    heading: part.heading,
    lines: part.lines,
    body: part.lines.join('\n').trim().slice(0, MAX_BODY),
    index,
    sub: `${index}-${i + 1}`,
  }));
}

async function build() {
  const rows = [];
  for (const source of SOURCES) {
    let markdown;
    try {
      markdown = await readFile(join(root, source.path), 'utf8');
    } catch {
      console.warn(`skip missing ${source.path}`);
      continue;
    }
    const fileStem = slugify(basename(source.path, '.md'));
    const documentTitle = source.title || markdown.match(/^#\s+(.+)$/m)?.[1] || basename(source.path);
    splitSections(markdown).forEach((chunk, index) => {
      for (const part of bounded(chunk, index, chunk.heading === null ? 'preamble' : null)) {
        if (!part.body) continue;
        const slug = `${fileStem}-${part.sub ?? (part.heading === null ? 'preamble' : part.index)}`;
        rows.push({
          slug: slug.slice(0, 120),
          title: documentTitle,
          section: part.heading === null ? null : part.heading.slice(0, 200),
          body_md: part.body,
          audience: source.audience,
          source_path: source.path,
        });
      }
    });
  }

  const seen = new Set();
  const duplicates = [];
  const unique = rows.filter((row) => {
    if (seen.has(row.slug)) { duplicates.push(row.slug); return false; }
    seen.add(row.slug);
    return true;
  });
  if (duplicates.length) console.warn(`duplicate slugs skipped: ${duplicates.join(', ')}`);
  const values = unique
    .map((row) => `  (${['slug', 'title', 'section', 'body_md', 'audience', 'source_path'].map((key) => sqlValue(row[key])).join(', ')})`)
    .join(',\n');
  const slugs = unique.map((row) => sqlValue(row.slug)).join(', ');

  return {
    count: unique.length,
    sql: `-- Migration: ${SEED_FILE}
-- Description: Documentation corpus for the AI copilot knowledge base.
-- Generated by scripts/build-knowledge-seed.mjs from the repository markdown.
-- Do not edit by hand: run \`node scripts/build-knowledge-seed.mjs\` after changing docs.
-- One row per '##' section so a copilot citation can deep-link to the exact evidence.

BEGIN;

INSERT INTO public.knowledge_base (slug, title, section, body_md, audience, source_path)
VALUES
${values}
ON CONFLICT (slug) DO UPDATE
SET title = EXCLUDED.title,
    section = EXCLUDED.section,
    body_md = EXCLUDED.body_md,
    audience = EXCLUDED.audience,
    source_path = EXCLUDED.source_path,
    updated_at = now();

-- Drop sections that no longer exist in the tracked documents.
DELETE FROM public.knowledge_base
WHERE source_path IN (${SOURCES.map((source) => sqlValue(source.path)).join(', ')})
  AND slug NOT IN (${slugs});

COMMIT;
`,
  };
}

const args = process.argv.slice(2);
const { count, sql } = await build();
const normalize = (value) => value.replace(/\r\n/g, '\n').trimEnd();

if (args.includes('--stdout')) {
  process.stdout.write(sql);
} else if (args.includes('--check')) {
  // Documentation edits silently change what the copilot can cite, so CI compares the
  // committed migration instead of trusting that somebody remembered to regenerate it.
  const committed = await readFile(join(root, 'supabase', 'migrations', SEED_FILE), 'utf8').catch(() => null);
  if (committed === null || normalize(committed) !== normalize(sql)) {
    console.error(`knowledge_base seed is stale: run \`npm run knowledge:seed\` after editing documentation.`);
    process.exitCode = 1;
  } else {
    console.log(`knowledge_base seed is up to date (${count} documentation sections).`);
  }
} else {
  const outIndex = args.indexOf('--out');
  const target = outIndex >= 0 ? args[outIndex + 1] : join(root, 'supabase', 'migrations', SEED_FILE);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, sql, 'utf8');
  console.log(`knowledge_base seed: ${count} documentation sections.`);
}

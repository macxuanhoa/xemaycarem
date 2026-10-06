import { mkdtemp, readdir, readFile, realpath, rm } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { createServer } from 'node:net'
import { randomBytes } from 'node:crypto'
import { PGlite } from '@electric-sql/pglite'
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto'

/** A disposable PostgreSQL engine, never a substitute for hosted Auth/Storage tests. */
export async function createDatabase({ engine = 'pglite', applyMigrations = true, loadDump = null, migrationFilter = null } = {}) {
  const database = engine === 'postgres' ? await nativeDatabase() : new PGlite({ extensions: { pgcrypto } })
  if (database.waitReady) await database.waitReady
  await database.exec(SUPABASE_STUB_SQL)
  // Release validation may load a real pg_dump of the production schema first so the
  // pending migrations are exercised against the drifted live baseline, not only a
  // clean build. Applied after the stubs (auth/storage/roles) and before migrations.
  if (loadDump) {
    await database.exec(await readFile(resolve(loadDump), 'utf8'))
    // A pg_dump runs `SELECT set_config('search_path', '', false)`, and because this
    // disposable engine reuses one session, that empty search_path would leak into the
    // pending migrations. `supabase db push` executes each migration on a fresh session
    // with the default path, so restore it here to faithfully mirror production apply.
    await database.exec(`SELECT set_config('search_path', '"$user", public', false)`)
    console.log(`LOADED DUMP ${loadDump}`)
  }
  if (!applyMigrations) return database
  const migrationDirectory = resolve('supabase/migrations')
  let migrations = (await readdir(migrationDirectory)).filter((name) => name.endsWith('.sql')).sort()
  if (migrationFilter) migrations = migrations.filter(migrationFilter)
  if (migrations.length === 0) throw new Error('No SQL migrations found; refusing a false-positive test run.')
  for (const migration of migrations) {
    await database.exec(await readFile(resolve(migrationDirectory, migration), 'utf8'))
    console.log(`MIGRATION ${migration}`)
  }
  return database
}

// Supabase-like scaffolding (roles, auth/storage stubs, default privileges) provided by
// the real managed platform. Extracted as a constant so release validation can load a
// production dump on top of the identical stubs before applying pending migrations.
export const SUPABASE_STUB_SQL = `
    CREATE ROLE anon NOLOGIN;
    CREATE ROLE authenticated NOLOGIN;
    CREATE ROLE service_role NOLOGIN BYPASSRLS;
    CREATE SCHEMA auth;
    CREATE SCHEMA storage;
    CREATE SCHEMA extensions;
    CREATE TABLE auth.users (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      email text UNIQUE,
      encrypted_password text,
      email_confirmed_at timestamptz,
      raw_user_meta_data jsonb NOT NULL DEFAULT '{}'::jsonb,
      raw_app_meta_data jsonb NOT NULL DEFAULT '{}'::jsonb,
      created_at timestamptz DEFAULT now(),
      updated_at timestamptz DEFAULT now()
    );
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS
      $$ SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    CREATE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS
      $$ SELECT nullif(current_setting('request.jwt.claim.role', true), '') $$;
    CREATE FUNCTION auth.jwt() RETURNS jsonb LANGUAGE sql STABLE AS
      $$ SELECT coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb $$;
    CREATE TABLE storage.buckets (
      id text PRIMARY KEY,
      name text NOT NULL UNIQUE,
      owner uuid,
      public boolean DEFAULT false,
      file_size_limit bigint,
      allowed_mime_types text[],
      created_at timestamptz DEFAULT now(),
      updated_at timestamptz DEFAULT now()
    );
    CREATE TABLE storage.objects (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      bucket_id text REFERENCES storage.buckets(id),
      name text NOT NULL,
      owner uuid,
      owner_id text,
      metadata jsonb,
      created_at timestamptz DEFAULT now(),
      updated_at timestamptz DEFAULT now(),
      UNIQUE(bucket_id, name)
    );
    ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;
    CREATE FUNCTION storage.foldername(name text) RETURNS text[] LANGUAGE sql IMMUTABLE AS
      $$ SELECT (string_to_array(name, '/'))[1:greatest(array_length(string_to_array(name, '/'), 1) - 1, 0)] $$;
    CREATE FUNCTION storage.filename(name text) RETURNS text LANGUAGE sql IMMUTABLE AS
      $$ SELECT (string_to_array(name, '/'))[array_length(string_to_array(name, '/'), 1)] $$;
    CREATE FUNCTION storage.extension(name text) RETURNS text LANGUAGE sql IMMUTABLE AS
      $$ SELECT reverse(split_part(reverse(name), '.', 1)) $$;
    GRANT USAGE ON SCHEMA public, auth, storage TO anon, authenticated, service_role;
    GRANT ALL ON ALL TABLES IN SCHEMA storage TO anon, authenticated, service_role;
    GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA auth, storage TO anon, authenticated, service_role;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO anon, authenticated, service_role;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role;
`

async function nativeDatabase() {
  const { default: EmbeddedPostgres } = await import('embedded-postgres')
  const { default: pg } = await import('pg')
  const temporaryRoot = await realpath(tmpdir())
  const databaseDir = await mkdtemp(join(temporaryRoot, 'xe-crm-test-'))
  // embedded-postgres removes this directory on stop. Never point it at existing data.
  if (dirname(await realpath(databaseDir)) !== temporaryRoot) throw new Error('Unsafe temporary database directory')
  const listener = createServer()
  await new Promise((resolve) => listener.listen(0, '127.0.0.1', resolve))
  const port = listener.address().port
  await new Promise((resolve, reject) => listener.close((error) => error ? reject(error) : resolve()))
  const password = randomBytes(24).toString('hex')
  const errors = []
  const cluster = new EmbeddedPostgres({ databaseDir, port, user: 'postgres', password, persistent: false, initdbFlags: ['--encoding=UTF8', '--no-locale'], postgresFlags: ['-h', '127.0.0.1'], onLog: () => {}, onError: (error) => errors.push(String(error)) })
  try {
    await cluster.initialise()
    await cluster.start()
    // Reuse a small pool instead of opening a fresh connection for every request.
    // During app boot the browser mock fires many RPCs at once; per-request TCP
    // connect/teardown against embedded Postgres occasionally spikes past the
    // test timeout, which surfaced as an intermittent login flake. A checked-out
    // client stays exclusive until released, so SET ROLE / set_config session
    // state used by asUser() still behaves like a dedicated connection.
    const pool = new pg.Pool({ host: '127.0.0.1', port, user: 'postgres', password, max: 10 })
    pool.on('error', () => {
      // Idle clients in the pool receive 57P01 (terminating connection due to administrator command)
      // or ECONNRESET when embedded postgres stops (e.g. via SIGINT on Linux).
      // Node's EventEmitter would crash the process if this error event was left unhandled.
    })
    const bootstrap = await pool.connect()
    bootstrap.on('error', () => {})
    const run = (sql, values) => bootstrap.query(sql, values)
    return {
      query: run,
      exec: (sql) => bootstrap.query(sql),
      connection: async () => {
        const connection = await pool.connect()
        // Pool checkouts reuse the same client; do not accumulate one listener per RPC.
        if (connection.listenerCount('error') === 0) connection.on('error', () => {})
        return { query: (sql, values) => connection.query(sql, values), exec: (sql) => connection.query(sql), close: () => connection.release() }
      },
      close: async () => {
        bootstrap.release()
        await pool.end()
        try {
          await Promise.race([
            cluster.stop(),
            new Promise((resolve) => setTimeout(resolve, 2000))
          ])
        } catch (error) {
          // On Windows, embedded-postgres can return before taskkill releases file handles.
          if (error?.code !== 'EBUSY') throw error
          await new Promise((resolve) => setTimeout(resolve, 250))
          await rm(databaseDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
        }
      },
    }
  } catch (error) {
    await cluster.stop().catch(() => {})
    throw new Error(`Temporary PostgreSQL failed: ${error.message}\n${errors.slice(-4).join('\n')}`, { cause: error })
  }
}

/** SET ROLE exercises PostgreSQL privileges and RLS, unlike running assertions as postgres. */
export async function asUser(database, userId, operation, role = 'authenticated') {
  if (!['anon', 'authenticated', 'service_role'].includes(role)) throw new Error('Invalid test role')
  await database.exec(`SET ROLE ${role}`)
  await database.query("SELECT set_config('request.jwt.claim.sub', $1, false), set_config('request.jwt.claim.role', $2, false), set_config('request.jwt.claims', $3, false)", [userId ?? '', role, JSON.stringify({ sub: userId, role })])
  try {
    return await operation(database)
  } finally {
    await database.exec('RESET ROLE')
    await database.query("SELECT set_config('request.jwt.claim.sub', '', false), set_config('request.jwt.claim.role', '', false), set_config('request.jwt.claims', '{}', false)")
  }
}

export async function rpc(database, name, argumentsSql = '', values = []) {
  if (!/^[a-z_]+$/.test(name)) throw new Error('Invalid test RPC name')
  const result = await database.query(`SELECT public.${name}(${argumentsSql}) AS result`, values)
  return result.rows[0]?.result
}

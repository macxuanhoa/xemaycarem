import { mkdtemp, readdir, readFile, realpath, rm } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { createServer } from 'node:net'
import { randomBytes } from 'node:crypto'
import { PGlite } from '@electric-sql/pglite'
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto'

/** A disposable PostgreSQL engine, never a substitute for hosted Auth/Storage tests. */
export async function createDatabase({ engine = 'pglite' } = {}) {
  const database = engine === 'postgres' ? await nativeDatabase() : new PGlite({ extensions: { pgcrypto } })
  if (database.waitReady) await database.waitReady
  await database.exec(`
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
  `)
  const migrationDirectory = resolve('supabase/migrations')
  const migrations = (await readdir(migrationDirectory)).filter((name) => name.endsWith('.sql')).sort()
  if (migrations.length === 0) throw new Error('No SQL migrations found; refusing a false-positive test run.')
  for (const migration of migrations) {
    await database.exec(await readFile(resolve(migrationDirectory, migration), 'utf8'))
    console.log(`MIGRATION ${migration}`)
  }
  return database
}

async function nativeDatabase() {
  const { default: EmbeddedPostgres } = await import('embedded-postgres')
  const temporaryRoot = await realpath(tmpdir())
  const databaseDir = await mkdtemp(join(temporaryRoot, 'xe-crm-test-'))
  // embedded-postgres removes this directory on stop. Never point it at existing data.
  if (dirname(await realpath(databaseDir)) !== temporaryRoot) throw new Error('Unsafe temporary database directory')
  const listener = createServer()
  await new Promise((resolve) => listener.listen(0, '127.0.0.1', resolve))
  const port = listener.address().port
  await new Promise((resolve, reject) => listener.close((error) => error ? reject(error) : resolve()))
  const errors = []
  const cluster = new EmbeddedPostgres({ databaseDir, port, user: 'postgres', password: randomBytes(24).toString('hex'), persistent: false, initdbFlags: ['--encoding=UTF8', '--no-locale'], postgresFlags: ['-h', '127.0.0.1'], onLog: () => {}, onError: (error) => errors.push(String(error)) })
  try {
    await cluster.initialise()
    await cluster.start()
    const client = cluster.getPgClient('postgres', '127.0.0.1')
    await client.connect()
    return {
      query: (sql, values) => client.query(sql, values),
      exec: (sql) => client.query(sql),
      connection: async () => {
        const connection = cluster.getPgClient('postgres', '127.0.0.1')
        await connection.connect()
        return { query: (sql, values) => connection.query(sql, values), exec: (sql) => connection.query(sql), close: () => connection.end() }
      },
      close: async () => {
        await client.end()
        try {
          await cluster.stop()
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

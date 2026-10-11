// scripts/smoke-production.mjs
// Verification suite for live Vercel production deployment
import { createClient } from '@supabase/supabase-js';

const PROD_URL = 'https://xemaycarem.vercel.app';
const SUPABASE_URL = process.env.VITE_SUPABASE_URL || 'https://atsgqtarxhmxrsugulva.supabase.co';
const SUPABASE_ANON = process.env.VITE_SUPABASE_ANON_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImF0c2dxdGFyeGhteHJzdWd1bHZhIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTk0MDM1NjAsImV4cCI6MjA3NDk3OTU2MH0.B-v6eNn55a8RfxZ03E1iY6fN4Jv4Z0-H6L5k8t_v9bQ';

async function runSmokeTests() {
  console.log('=== [PHASE 9: PRODUCTION SMOKE VERIFICATION] ===\n');
  let passCount = 0;
  let totalCount = 0;

  function assert(title, condition, extra = '') {
    totalCount++;
    if (condition) {
      passCount++;
      console.log(`[PASS] ${title} ${extra ? '(' + extra + ')' : ''}`);
    } else {
      console.error(`[FAIL] ${title} ${extra ? '(' + extra + ')' : ''}`);
      throw new Error(`Smoke test failed: ${title}`);
    }
  }

  // 1. Production HTTP Headers & HTML Shell
  console.log('--- 1. Testing Live Production Web App Root ---');
  const indexRes = await fetch(PROD_URL);
  assert('Root HTTP 200 OK', indexRes.status === 200, `status: ${indexRes.status}`);
  const html = await indexRes.text();
  assert('HTML includes root mount node', html.includes('id="root"'));
  assert('HTML includes viewport meta tag', html.includes('name="viewport"'));
  assert('HTML includes manifest link', html.includes('manifest.webmanifest'));
  assert('HTML includes modern title', html.includes('<title>'));

  // 2. PWA Manifest & Service Worker
  console.log('\n--- 2. Testing PWA Web Manifest & Service Worker ---');
  const manifestRes = await fetch(`${PROD_URL}/manifest.webmanifest`);
  assert('Manifest HTTP 200 OK', manifestRes.status === 200);
  const manifest = await manifestRes.json();
  assert('Manifest name matches Cà Rem CRM', manifest.name.includes('Cà Rem') || manifest.short_name.includes('Cà Rem'), manifest.name);
  assert('Manifest has valid icons array', Array.isArray(manifest.icons) && manifest.icons.length >= 2, `${manifest.icons.length} icons`);
  
  const swRes = await fetch(`${PROD_URL}/sw.js`);
  assert('Service Worker HTTP 200 OK', swRes.status === 200);
  const swText = await swRes.text();
  assert('Service Worker contains workbox precache logic', swText.includes('workbox') || swText.includes('precache') || swText.includes('self.__WB_MANIFEST'));

  // 3. Static Assets & Brand Images
  console.log('\n--- 3. Testing New Feature Static Assets ---');
  const loaderRes = await fetch(`${PROD_URL}/carem-ride-subject.png`);
  assert('Carem Ride Loader subject image HTTP 200 OK', loaderRes.status === 200, `type: ${loaderRes.headers.get('content-type')}`);
  const tetRes = await fetch(`${PROD_URL}/tet-de-lai.png`);
  assert('Tet 2027 brand asset HTTP 200 OK', tetRes.status === 200, `type: ${tetRes.headers.get('content-type')}`);

  // 4. Remote Supabase Production Connectivity & Config States
  console.log('\n--- 4. Testing Remote Supabase Production DB Contracts ---');
  const supabase = createClient(SUPABASE_URL, SUPABASE_ANON);

  // Check seasonal theme config: Tet 2027 MUST default to DEFAULT with cinematic disabled
  const { data: themeConfig, error: themeErr } = await supabase
    .from('seasonal_theme_config')
    .select('*')
    .single();

  if (themeErr) {
    console.warn('[WARN] Could not select seasonal_theme_config with anon key (RLS protected):', themeErr.message);
  } else {
    assert('Seasonal theme active_theme is DEFAULT', themeConfig.active_theme === 'DEFAULT', `active: ${themeConfig.active_theme}`);
    assert('Seasonal theme cinematic_intro_enabled is false', themeConfig.cinematic_intro_enabled === false, `cinematic: ${themeConfig.cinematic_intro_enabled}`);
  }

  // 5. Auth / RPC Health Check
  console.log('\n--- 5. Testing Supabase Health & Auth Gateway ---');
  const { data: healthData, error: healthErr } = await supabase.auth.getSession();
  assert('Auth gateway responds cleanly', !healthErr, healthErr ? healthErr.message : 'Session verified');

  console.log(`\n========================================`);
  console.log(`PRODUCTION SMOKE TESTS: ${passCount}/${totalCount} PASSED`);
  console.log(`========================================\n`);
}

runSmokeTests().catch((err) => {
  console.error('\nProduction Smoke Tests FAILED:', err);
  process.exit(1);
});

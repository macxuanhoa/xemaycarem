// Retired recovery endpoint. Recovery uses Supabase Auth or owner-authorized
// manage-users operations; this endpoint can no longer alter any account.
Deno.serve(() => new Response(JSON.stringify({ error: 'ENDPOINT_RETIRED' }), {
  status: 410,
  headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
}));

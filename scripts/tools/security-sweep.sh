#!/usr/bin/env bash
# Live security sweep — verifies the real database, not the migration text.
#
# WHY THIS EXISTS
#   The unit tests covering the anon-exposure fixes only read migration files.
#   A function created AFTER the sweep migration therefore passes every test
#   while being wide open — which is exactly what happened with
#   `pop_one_stock_item` (added in 0079, after 0078's sweep). It was callable
#   with the public anon key and returned real seller credentials:
#
#     POST /rest/v1/rpc/pop_one_stock_item {"p_product_id":"…","p_variant_label":"Default"}
#     → 200 "NFLX-0006-1679"     (no auth, no payment)
#
#   Static tests cannot see the live database, so this script queries it.
#
# CHECKS
#   1. No SECURITY DEFINER function in `public` is executable by anon/authenticated.
#   2. Every table in `public` has RLS enabled.
#   3. The inventory-moving RPCs reject the anon key over PostgREST.
#
# Exit code 0 = clean, 1 = findings.
#
# Written in bash on purpose: spawning a child process from Node fails in this
# environment on Windows (`spawnSync … EBUSY`), so a Node version could not run.
#
# Usage: bash scripts/tools/security-sweep.sh

set -uo pipefail
cd "$(dirname "$0")/../.." || exit 1

REST="${SUPABASE_REST_URL:-http://127.0.0.1:54321}"
FAIL=0
ok()  { echo "✅ $1"; }
bad() { echo "❌ $1"; FAIL=1; }

q() { npx supabase db query --local "$1" --output json 2>/dev/null | sed -n '/^\[/,$p'; }
# NOTE: pass SQL as ONE line. The CLI mangles multi-line statements
# ("missing FROM-clause entry for table …"), which silently returned an empty
# result and made this sweep report "safe" while a hole was open.

# --- 1. anon-reachable SECURITY DEFINER functions ---------------------------
LEAKY_SQL="select p.proname || '(' || pg_get_function_arguments(p.oid) || ')' as fn from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.prosecdef and (has_function_privilege('anon', p.oid, 'EXECUTE') or has_function_privilege('authenticated', p.oid, 'EXECUTE')) order by 1"
LEAKY=$(q "$LEAKY_SQL")
COUNT=$(echo "$LEAKY" | grep -o '"fn"' | wc -l | tr -d ' ')
if [ "$COUNT" -gt 0 ]; then
  NAMES=$(echo "$LEAKY" | grep -o '"fn": *"[^"]*"' | sed 's/.*: *"//; s/"$//' | tr '\n' ' ')
  bad "$COUNT SECURITY DEFINER function(s) bisa dipanggil anon: $NAMES"
else
  ok "tidak ada SECURITY DEFINER function yang bisa dipanggil anon"
fi

# --- 2. tables without RLS --------------------------------------------------
NORLS=$(q "select tablename from pg_tables where schemaname = 'public' and not rowsecurity order by 1")
TCOUNT=$(echo "$NORLS" | grep -o '"tablename"' | wc -l | tr -d ' ')
if [ "$TCOUNT" -gt 0 ]; then
  bad "$TCOUNT tabel tanpa RLS"
else
  ok "semua tabel public punya RLS"
fi

# --- 3. inventory-moving RPCs must reject anon over PostgREST ---------------
ANON=$(grep -E "^NEXT_PUBLIC_SUPABASE_ANON_KEY=|^SUPABASE_ANON_KEY=" .env.local | head -1 | cut -d= -f2-)
PID=$(q "select id from products where status='active' limit 1" | grep -oE '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}' | head -1)

if [ -z "$ANON" ]; then
  bad "anon key tidak ketemu di .env.local"
elif [ -z "$PID" ]; then
  echo "⚠️  tidak ada produk aktif — lewati uji PostgREST"
else
  probe() { # name, json body
    local name="$1" body="$2"
    local code
    code=$(curl -s -m 30 --noproxy '*' -o /dev/null -w '%{http_code}' \
      -X POST "$REST/rest/v1/rpc/$name" \
      -H "apikey: $ANON" -H "Authorization: Bearer $ANON" \
      -H "Content-Type: application/json" -d "$body")
    if [ "$code" = "200" ]; then bad "$name BISA dipanggil anon ($code)"; else ok "$name ditolak untuk anon ($code)"; fi
  }
  probe pop_one_stock_item  "{\"p_product_id\":\"$PID\",\"p_variant_label\":\"Default\"}"
  probe pop_stock_fifo_auto "{\"p_product_id\":\"$PID\",\"p_variant_label\":\"Default\",\"p_qty\":1}"
  probe sql_simple_query    "{\"q\":\"select 1\"}"
fi

# --- 4. permissive write policies that let anon write ----------------------
#
# Added 2026-10-06 after finding one by hand: `mm_audit_log` had a PERMISSIVE
# INSERT policy for role PUBLIC with `WITH CHECK (true)`, plus the anon INSERT
# grant that ships with the public schema — so an UNAUTHENTICATED caller could
# write rows over PostgREST:
#
#   POST /rest/v1/mm_audit_log   (anon key, no session)  -> 201
#
# Checks 1–3 all passed while that hole was open: the function sweep only looks
# at SECURITY DEFINER functions, and the RLS sweep only checks that RLS is
# ENABLED — not what the policies say. A policy is the difference between "RLS
# on" and "actually restricted", so assert on the policy itself.
POLSQL="select p.tablename || '.' || p.policyname || ' (' || p.cmd || ')' as pol from pg_policies p where p.schemaname = 'public' and p.permissive = 'PERMISSIVE' and p.cmd in ('INSERT','UPDATE','DELETE','ALL') and (p.roles::text like '%anon%' or p.roles::text like '%public%') and coalesce(p.with_check, p.qual) = 'true' order by 1"
OPENPOL=$(q "$POLSQL")
PCOUNT=$(echo "$OPENPOL" | grep -o '"pol"' | wc -l | tr -d ' ')
if [ "$PCOUNT" -gt 0 ]; then
  PNAMES=$(echo "$OPENPOL" | grep -o '"pol": *"[^"]*"' | sed 's/.*: *"//; s/"$//' | tr '\n' ' ')
  bad "$PCOUNT write policy terbuka untuk anon (WITH CHECK true): $PNAMES"
else
  ok "tidak ada write policy terbuka untuk anon"
fi

echo
if [ "$FAIL" -eq 0 ]; then
  echo "=== AMAN: tidak ada temuan ==="
else
  echo "=== ADA TEMUAN ==="
fi
exit $FAIL

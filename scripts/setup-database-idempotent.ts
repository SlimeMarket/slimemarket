/**
 * Idempotent Database Setup Script
 * Re-runnable without errors - checks existing state before creating
 * Inspired by Circle Fin's setup.ts pattern for repeated deployments
 */

import { createClient } from '@supabase/supabase-js';
import { readFileSync, existsSync } from 'fs';
import { spawnSync } from 'child_process';
import { join } from 'path';

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SECRET_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error('❌ Missing required environment variables');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false }
});

/**
 * Execute raw SQL against the local Supabase instance.
 *
 * supabase-js has no raw-SQL execution API (`supabase.execute` does not exist),
 * so we shell out to the Supabase CLI. The migration files contain arbitrary
 * DDL (CREATE TABLE, indexes) that PostgREST `.rpc()` cannot run.
 */
async function executeSql(sql: string): Promise<void> {
  // `shell: true` so the `supabase` npm shim resolves on Windows.
  const result = spawnSync('supabase', ['db', 'execute', '--local'], {
    input: sql,
    shell: true,
    encoding: 'utf-8'
  });

  if (result.status !== 0) {
    const msg = result.stderr?.trim() || result.error?.message || 'unknown error';
    throw new Error(`supabase db execute failed: ${msg}`);
  }
}

interface MigrationState {
  id: string;
  version: number;
  migration_name: string;
  executed_at: Date;
}

/**
 * Check if migration has already been executed
 */
async function checkMigrationExists(migrationName: string): Promise<boolean> {
  try {
    const { data } = await supabase
      .from('deployment_state')
      .select('id')
      .eq('migration_name', migrationName)
      .single();
    
    return !!data;
  } catch (error) {
    // If table doesn't exist yet, assume no migrations run
    if ((error as any).code === 'PGRST116') {
      return false;
    }
    throw error;
  }
}

/**
 * Record that a migration has been executed
 */
async function recordMigration(migrationName: string): Promise<void> {
  await supabase.from('deployment_state').insert({
    migration_name: migrationName,
    executed_at: new Date().toISOString()
  });
}

/**
 * Run a single migration file
 */
async function runMigration(filePath: string, migrationName: string): Promise<void> {
  // Check if already executed
  const exists = await checkMigrationExists(migrationName);
  if (exists) {
    console.log(`✅ Skipped ${migrationName} (already executed)`);
    return;
  }
  
  // Read and execute SQL
  console.log(`🚀 Executing ${migrationName}...`);
  const sql = readFileSync(filePath, 'utf-8');
  
  try {
    await executeSql(sql);
    await recordMigration(migrationName);
    console.log(`✅ Completed ${migrationName}`);
  } catch (error) {
    console.error(`❌ Failed to execute ${migrationName}:`, (error as Error).message);
    throw error;
  }
}

/**
 * Create deployment_state table if it doesn't exist
 */
async function ensureDeploymentStateTable(): Promise<void> {
  try {
    await executeSql(`
      CREATE TABLE IF NOT EXISTS public.deployment_state (
        id BIGSERIAL PRIMARY KEY,
        migration_name TEXT UNIQUE NOT NULL,
        executed_at TIMESTAMPTZ DEFAULT NOW()
      );
      
      CREATE INDEX IF NOT EXISTS idx_deployment_migration_name 
      ON public.deployment_state(migration_name);
    `);
    console.log('✅ Created deployment_state table');
  } catch (error) {
    if ((error as any).code !== '23505') { // unique_violation
      throw error;
    }
    console.log('ℹ️ deployment_state table already exists');
  }
}

/**
 * Main execution
 */
async function main() {
  console.log('🔧 Starting idempotent database setup...\n');
  
  try {
    // Create state tracking table first
    await ensureDeploymentStateTable();
    
    // List of migrations to run (in order)
    const migrations = [
      { name: '0044_lifecycle_events.sql', path: './supabase/migrations/0044_lifecycle_events.sql' },
      // Add more migrations here as needed
      // { name: '0045_payment_metadata.sql', path: './supabase/migrations/0045_payment_metadata.sql' },
    ];
    
    // Run each migration idempotently
    for (const migration of migrations) {
      const fullPath = join(process.cwd(), migration.path);
      await runMigration(fullPath, migration.name);
    }
    
    console.log('\n========================================');
    console.log('✅ DATABASE SETUP COMPLETE!');
    console.log('========================================');
    console.log('\nNext steps:');
    console.log('1. Test database connection with: SELECT 1');
    console.log('2. Verify all tables created: \\dt');
    console.log('3. Run application tests\n');
    
  } catch (error) {
    console.error('\n❌ Setup failed:', (error as Error).message);
    process.exit(1);
  }
}

main();

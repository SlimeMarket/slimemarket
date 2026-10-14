/**
 * Delete all mock WL (Whitelist) listings from Supabase database
 */

import { createClient } from '@supabase/supabase-js';

// Load .env.local
import 'dotenv/config';

async function main() {
  console.log("🗑️  DELETING MOCK WL LISTINGS FROM DATABASE");
  
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY;
  
  if (!supabaseUrl || !supabaseKey) {
    console.error("❌ Missing Supabase credentials in .env.local");
    process.exit(1);
  }
  
  const supabase = createClient(supabaseUrl, supabaseKey);
  
  // Check first how many mock listings exist
  const { count, error: countError } = await supabase
    .from('wl_listings')
    .select('*', { count: 'exact', head: true });
  
  if (countError) {
    console.error("❌ Error counting listings:", countError.message);
    process.exit(1);
  }
  
  console.log(`\n📊 Found ${count} WL listings in database`);
  
  if (!count || count === 0) {
    console.log("\n✅ No WL listings to delete!");
    return;
  }
  
  // Fetch all listings to show them
  const { data: existingListings, error: fetchError } = await supabase
    .from('wl_listings')
    .select('*');
    
  if (fetchError) {
    console.error("\n❌ Error fetching listings:", fetchError.message);
    process.exit(1);
  }
  
  // Show which ones will be deleted
  console.log("\n📋 Listings to delete:");
  existingListings?.forEach((listing, index) => {
    if (listing && listing.project) {
      console.log(`  [${index + 1}] Project: ${listing.project} | Price: $${listing.unitPrice}`);
    }
  });
  
  // Delete all by ID
  const idList = existingListings?.map(l => l.id) || [];
  
  if (idList.length === 0) {
    console.log("\n✅ No listings to actually delete!");
    return;
  }
  
  const { error } = await supabase
    .from('wl_listings')
    .delete()
    .in('id', idList);
  
  if (error) {
    console.error("\n❌ Error deleting listings:", error.message);
    process.exit(1);
  }
  
  console.log(`\n✅ Successfully deleted ${count} WL listings!`);
  console.log("Database is now clean. Real listings will appear when users create them.");
}

main().catch(console.error);

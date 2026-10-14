/**
 * Seed REAL Circle UCW Wallets into Local Supabase Database
 * Run this to map your Circle Console users to local accounts
 */

import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";
import { genUid } from "../lib/uid";

dotenv.config();

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || "http://127.0.0.1:54321";
const SUPABASE_SECRET_KEY = process.env.SUPABASE_SECRET_KEY;

if (!SUPABASE_SECRET_KEY) {
  console.error("❌ Missing SUPABASE_SECRET_KEY in .env.local");
  process.exit(1);
}

// Capture the env-narrowed key: module-level narrowing does not propagate into
// nested functions, so createClient() calls below need a plain-string const.
const SUPABASE_SERVICE_ROLE_KEY = SUPABASE_SECRET_KEY;

// YOUR REAL CIRCLE WALLET IDs FROM CONSOLE
const REAL_CIRCLE_USERS = [
  { 
    email: "bintang7paa@gmail.com",
    name: "Admin User",
    circleWalletId: "e4295bfc-b305-53a9-a4ab-3b82a828f99a",
    expectedRole: "Admin"
  },
  { 
    email: "buyer_test@catchmail.io",
    name: "Buyer User",
    circleWalletId: "757704ac-5bfc-5f98-8e3f-7963df37a3a8",
    expectedRole: "Buyer"
  },
  { 
    email: "seller@example.com",
    name: "Seller User",
    circleWalletId: "cf885131-6606-591f-9a23-66a5701e21e1",
    expectedRole: "Seller"
  },
];

async function seedDatabase() {
  console.log("🚀 Seeding REAL Circle UCW users into database...\n");
  
  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  // 4-char pretty uid with collision retry (users.uid UNIQUE).
  const uniqueUid = async (): Promise<string> => {
    let uid = genUid();
    for (let attempt = 0; attempt < 5; attempt++) {
      const { data: clash } = await supabase.from("users").select("id").eq("uid", uid).maybeSingle();
      if (!clash) return uid;
      uid = genUid();
    }
    return uid;
  };

  for (const userData of REAL_CIRCLE_USERS) {
    console.log(`\nProcessing: ${userData.name} (${userData.email})`);
    
    // Check if user exists
    const { data: existingUser, error: userError } = await supabase
      .from("users")
      .select("id, name, role")
      .eq("email", userData.email)
      .maybeSingle();
    
    let userId: string;
    
    if (existingUser && !userError) {
      console.log(`   ✅ User found: ${existingUser.name} (Role: ${existingUser.role})`);
      userId = existingUser.id;
      
      // Update role if needed
      if (existingUser.role !== userData.expectedRole) {
        await supabase.from("users").update({ role: userData.expectedRole }).eq("id", userId);
        console.log(`   🔄 Role updated: ${existingUser.role} → ${userData.expectedRole}`);
      }
    } else {
      // Create new user
      console.log(`   Creating new user...`);
      const uid = await uniqueUid();
      const { data: newUser, error: insertError } = await supabase
        .from("users")
        .insert({
          email: userData.email,
          name: userData.name,
          role: userData.expectedRole,
          preferred_lang: "en",
          uid,
          referral_code: uid.toUpperCase()
        })
        .select("id")
        .single();
      
      if (insertError) {
        console.error(`   ❌ Failed to create user: ${insertError.message}`);
        continue;
      }
      
      console.log(`   ✅ Created user: ${newUser.id}`);
      userId = newUser.id;
    }
    
    // Check/create wallet linked to Circle wallet ID
    const { data: existingWallet, error: walletError } = await supabase
      .from("wallets")
      .select("*")
      .eq("user_id", userId)
      .maybeSingle();
    
    if (existingWallet && !walletError) {
      console.log(`   ℹ️  Wallet exists: ${existingWallet.circle_wallet_id}`);
      
      // Update wallet with correct Circle ID if mismatch
      if (existingWallet.circle_wallet_id !== userData.circleWalletId) {
        await supabase.from("wallets").update({ 
          circle_wallet_id: userData.circleWalletId,
          wallet_type: "ucw"
        }).eq("id", existingWallet.id);
        console.log(`   ✅ Wallet Circle ID updated: ${existingWallet.circle_wallet_id} → ${userData.circleWalletId}`);
      }
    } else {
      // Create new wallet
      console.log(`   Creating wallet linked to Circle...`);
      const { data: newWallet, error: wErr } = await supabase
        .from("wallets")
        .insert({
          user_id: userId,
          address: null, // Will be fetched from Circle API when first used
          circle_wallet_id: userData.circleWalletId,
          wallet_type: "ucw",
          usdc_balance: 0
        })
        .select("*")
        .single();
      
      if (wErr || !newWallet) {
        console.error(`   ❌ Failed to create wallet: ${wErr?.message || "Unknown error"}`);
        continue;
      }
      
      console.log(`   ✅ Wallet created: ${newWallet.id}`);
      console.log(`      - Circle Wallet ID: ${newWallet.circle_wallet_id}`);
      console.log(`      - Address: ${newWallet.address || "Pending Circle provisioning"}`);
    }
  }
  
  console.log("\n========================================");
  console.log("✅ SEEDING COMPLETE!");
  console.log("========================================");
  console.log("Your 3 REAL Circle UCW wallets are now mapped to local database:");
  
  for (const user of REAL_CIRCLE_USERS) {
    const { data } = await supabase
      .from("users")
      .select("id, name, role, wallets(circle_wallet_id)")
      .eq("email", user.email)
      .maybeSingle();
    
    console.log(`\n${user.name}:`);
    console.log(`  Email: ${user.email}`);
    console.log(`  Role: ${data?.role || "N/A"}`);
    const linkedWallet = data?.wallets as { circle_wallet_id?: string } | { circle_wallet_id?: string }[] | undefined;
    const circleWalletId = Array.isArray(linkedWallet) ? linkedWallet[0]?.circle_wallet_id : linkedWallet?.circle_wallet_id;
    console.log(`  Circle Wallet ID: ${circleWalletId || "Not linked"}`);
  }
  
  console.log("\n🎯 NEXT STEPS:");
  console.log("1. Visit http://localhost:3000/profile");
  console.log("2. Login via Circle W3S SDK (enter OTP when prompted)");
  console.log("3. Test Send USDC, Checkout, etc.");
  console.log("\n💡 Or use dev-login to bypass OTP:");
  console.log('fetch("http://localhost:3000/api/auth/dev-login", {');
  console.log('  method: "POST",');
  console.log('  headers: {"Content-Type": "application/json"},');
  console.log('  body: JSON.stringify({email: "bintang7paa@gmail.com"})');
  console.log('}).then(r => r.text()).then(t => console.log("Logged in:", t.substring(0,50)));');
  console.log("========================================\n");
}

seedDatabase().catch(console.error);

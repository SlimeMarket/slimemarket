/**
 * Seed real Circle UCW wallet IDs into local database
 * Run after creating Supabase Cloud project
 */
import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";
import { genUid } from "../lib/uid";

dotenv.config();

// Map your real Circle user IDs to local user roles
const REAL_CIRCLE_USERS = [
  {
    circleWalletId: "26143617-052e-5146-a627-dd9f9ca4a920",
    email: "buyer@example.com",  // Replace with actual email
    name: "Buyer User",
    role: "Buyer" as const,
  },
  {
    circleWalletId: "cf885131-6606-591f-9a23-66a5701e21e1",
    email: "seller@example.com",
    name: "Seller User",
    role: "Seller" as const,
  },
  {
    circleWalletId: "e4295bfc-b305-53a9-a4ab-3b82a828f99a",
    email: "admin@example.com",
    name: "Admin User",
    role: "Admin" as const,
  },
];

async function seedUsers() {
  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SECRET_KEY!
  );

  console.log("Starting user seeding...");

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
    console.log(`Processing: ${userData.email}`);

    // Check if user exists
    const { data: existingUser } = await supabase
      .from("users")
      .select("id")
      .eq("email", userData.email)
      .single();

    if (existingUser) {
      console.log(`✅ User already exists: ${userData.email}`);
    } else {
      // Create user
      const uid = await uniqueUid();
      const { data: newUser, error: userError } = await supabase
        .from("users")
        .insert({
          email: userData.email,
          name: userData.name,
          role: userData.role,
          preferred_lang: "en",
          uid,
          referral_code: uid.toUpperCase(),
        })
        .select("id")
        .single();

      if (userError) {
        console.error(`❌ Failed to create user: ${userError.message}`);
        continue;
      }

      console.log(`✅ Created user: ${newUser.id}`);

      // Create wallet linked to this Circle user
      const { data: newWallet, error: walletError } = await supabase
        .from("wallets")
        .insert({
          user_id: newUser.id,
          circle_wallet_id: userData.circleWalletId,
          wallet_type: "ucw",
          usdc_balance: 0,
          address: null, // Will be fetched from Circle API when user logs in
        })
        .select("id")
        .single();

      if (walletError) {
        console.error(`❌ Failed to create wallet: ${walletError.message}`);
      } else {
        console.log(`✅ Created wallet for: ${userData.email}`);
      }
    }

    console.log("---");
  }

  console.log("Seeding complete!");
}

seedUsers().catch(console.error);

import { supabaseAdminClient } from "@/lib/supabase/admin-client";
import type { CurrentUser } from "@/lib/auth-ucw";
import type { BankAccountRow } from "./types";

/**
 * Bank account CRUD for off-ramp withdrawals.
 *
 * Storage convention (matches 0001_init.sql): `number` is stored MASKED only.
 * We never persist a full account number — only the last 4 digits plus a mask,
 * so a compromised DB row reveals nothing usable. The raw number is used
 * transiently by the M7 Circle Payouts call and never written back.
 *
 * Server-only (uses admin client). Ownership is enforced per-call by `user_id`.
 */

const MAX_BANK_ACCOUNTS = 5;

/** Mask a raw account number to "••••1234" form (keeps last 4 digits). */
export function maskAccountNumber(raw: string): string {
  const digits = raw.replace(/\D+/g, "");
  if (digits.length < 4) {
    // Too short to mask meaningfully — pad-mask rather than expose.
    return "•".repeat(Math.max(digits.length, 1));
  }
  return "•".repeat(Math.max(digits.length - 4, 4)) + digits.slice(-4);
}

function toRow(r: {
  id: string;
  bank: string;
  number: string;
  name: string | null;
  created_at: string;
}): BankAccountRow {
  return {
    id: r.id,
    bank: r.bank,
    number: r.number,
    name: r.name,
    createdAt: r.created_at,
  };
}

/** List all bank accounts owned by the user (masked numbers). */
export async function listBankAccounts(
  user: CurrentUser
): Promise<BankAccountRow[]> {
  const admin = supabaseAdminClient();
  const { data, error } = await admin
    .from("bank_accounts")
    .select("id, bank, number, name, created_at")
    .eq("user_id", user.id)
    .order("created_at", { ascending: false });
  if (error) throw new Error(`list bank accounts failed: ${error.message}`);
  return (data ?? []).map(toRow);
}

export interface AddBankAccountInput {
  bank: string;
  number: string; // raw account number (masked before persist)
  name?: string | null;
}

/** Add a bank account (masked). Enforces per-user cap. Returns the new row. */
export async function addBankAccount(
  user: CurrentUser,
  input: AddBankAccountInput
): Promise<BankAccountRow> {
  const bank = input.bank?.trim();
  const number = input.number?.trim();
  if (!bank) throw new Error("bank is required");
  if (!number) throw new Error("number is required");
  if (bank.length > 80) throw new Error("bank name too long");
  const name = input.name?.trim() || null;

  const admin = supabaseAdminClient();

  // Enforce cap to limit payout-destination sprawl / abuse surface.
  const { count, error: cErr } = await admin
    .from("bank_accounts")
    .select("id", { count: "exact", head: true })
    .eq("user_id", user.id);
  if (cErr) throw new Error(`count bank accounts failed: ${cErr.message}`);
  if ((count ?? 0) >= MAX_BANK_ACCOUNTS) {
    throw new Error(`max ${MAX_BANK_ACCOUNTS} bank accounts reached`);
  }

  const { data, error } = await admin
    .from("bank_accounts")
    .insert({
      user_id: user.id,
      bank,
      number: maskAccountNumber(number),
      name,
    })
    .select("id, bank, number, name, created_at")
    .single();
  if (error || !data) {
    throw new Error(`add bank account failed: ${error?.message}`);
  }
  return toRow(data);
}

/** Remove a bank account owned by the user. Throws if not found/not owned. */
export async function removeBankAccount(
  user: CurrentUser,
  id: string
): Promise<void> {
  const admin = supabaseAdminClient();
  const { error, count } = await admin
    .from("bank_accounts")
    .delete({ count: "exact" })
    .eq("id", id)
    .eq("user_id", user.id);
  if (error) throw new Error(`remove bank account failed: ${error.message}`);
  if ((count ?? 0) === 0) {
    throw new Error("bank account not found for user");
  }
}

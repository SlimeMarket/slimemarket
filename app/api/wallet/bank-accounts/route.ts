import { getCurrentUser } from "@/lib/auth-ucw";
import { jsonError, jsonOk , clientErrorMessage } from "@/lib/utils";
import {
  addBankAccount,
  listBankAccounts,
  removeBankAccount,
} from "@/lib/wallet/bank-accounts";

/**
 * /api/wallet/bank-accounts — CRUD for off-ramp payout destinations.
 *
 *   GET    → list (masked numbers)
 *   POST   → add  { bank, number, name? }    (number is masked before persist)
 *   DELETE → remove { id }
 *
 * Stored `number` is always masked (last 4 digits only); the raw number is
 * never persisted (see lib/wallet/bank-accounts.ts).
 */

export async function GET() {
  const user = await getCurrentUser();
  if (!user) return jsonError("unauthorized", 401);
  const rows = await listBankAccounts(user);
  return jsonOk({ items: rows });
}

export async function POST(req: Request) {
  const user = await getCurrentUser();
  if (!user) return jsonError("unauthorized", 401);

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return jsonError("invalid JSON body", 400);
  }
  const { bank, number, name } = (body ?? {}) as {
    bank?: string;
    number?: string;
    name?: string | null;
  };

  try {
    const row = await addBankAccount(user, { bank: bank ?? "", number: number ?? "", name });
    return jsonOk(row, 201);
  } catch (e) {
    return jsonError(clientErrorMessage(e, "add bank account failed"), 400);
  }
}

export async function DELETE(req: Request) {
  const user = await getCurrentUser();
  if (!user) return jsonError("unauthorized", 401);

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return jsonError("invalid JSON body", 400);
  }
  const { id } = (body ?? {}) as { id?: string };
  if (!id) return jsonError("id is required", 400);

  try {
    await removeBankAccount(user, id);
    return jsonOk({ ok: true });
  } catch (e) {
    return jsonError(clientErrorMessage(e, "remove bank account failed"), 400);
  }
}

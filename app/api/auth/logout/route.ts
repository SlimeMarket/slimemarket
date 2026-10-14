import { NextResponse } from "next/server";

export async function POST() {
  const response = NextResponse.json({ ok: true });
  response.cookies.delete("circle_user_token");
  response.cookies.delete("circle_refresh_token");
  response.cookies.delete("circle_encryption_key");
  response.cookies.delete("circle_email");
  return response;
}

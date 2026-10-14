// app/api/currencies/route.ts
import { NextResponse } from "next/server";

// Supported currencies configuration
const SUPPORTED_CURRENCIES = [
  { 
    code: "USD", 
    name: "US Dollar", 
    symbol: "$",
    circleToken: "USDC",
    decimals: 2 
  },
  { 
    code: "EUR", 
    name: "Euro", 
    symbol: "€",
    circleToken: "EURC",
    decimals: 2 
  },
  { 
    code: "ETH", 
    name: "Ethereum", 
    symbol: "Ξ",
    circleToken: null,
    decimals: 18 
  },
  { 
    code: "ARC", 
    name: "Arc Network Token", 
    symbol: "ARC",
    circleToken: null,
    decimals: 18 
  }
];

// Exchange rates (fetch from oracle in production)
const EXCHANGE_RATES: Record<string, number> = {
  USD: 1.0,
  EUR: 0.92,
  ETH: 2800.0,
  ARC: 1.5
};

export async function GET() {
  return NextResponse.json({
    currencies: SUPPORTED_CURRENCIES,
    exchangeRates: EXCHANGE_RATES,
    defaultCurrency: process.env.DEFAULT_CURRENCY || "USD"
  });
}

export async function POST(request: Request) {
  const { selectedCurrency } = await request.json();
  
  // Set currency preference cookie
  const headers = new Headers();
  headers.set('Set-Cookie', `slimemarket-currency=${selectedCurrency}; path=/; max-age=31536000`);
  
  return NextResponse.json({ success: true }, { headers });
}

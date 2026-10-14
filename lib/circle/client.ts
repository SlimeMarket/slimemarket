import { initiateDeveloperControlledWalletsClient } from "@circle-fin/developer-controlled-wallets";
import { CIRCLE_BLOCKCHAIN, CIRCLE_USDC_TOKEN_ID } from "@/lib/arc";

function buildClient() {
  const apiKey = process.env.CIRCLE_API_KEY;
  const entitySecret = process.env.CIRCLE_ENTITY_SECRET;
  if (!apiKey || !entitySecret) return null;
  return initiateDeveloperControlledWalletsClient({ apiKey, entitySecret });
}

export const circleDeveloperSdk = buildClient();

// UCW config exports
export { CIRCLE_APP_ID, CIRCLE_UCW_API } from "./ucw-config";

// Re-export for convenience
export { CIRCLE_BLOCKCHAIN, CIRCLE_USDC_TOKEN_ID } from "@/lib/arc";

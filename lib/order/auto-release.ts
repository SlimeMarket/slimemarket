/**
 * .E — auto-release moved to lib/order/auto-settlement.ts (decision
 * logic extracted for TDD + lifecycle events added). This module re-exports
 * the pass for back-compat; the cron route is /api/admin/auto-release.
 */
export {
  runAutoReleaseOnce as autoReleaseExpired,
  runAutoReleaseOnce,
  AUTO_RELEASE_WINDOW_HOURS,
  shouldAutoRelease,
  isSettlementTerminal,
  type AutoReleaseResult,
} from "./auto-settlement";

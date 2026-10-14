/**
 * Email templates index — all transactional email templates for SlimeMarket.
 *
 * Import from here: `import { welcomeTemplate } from "@/lib/notif/templates";`
 */

export { baseHtml, ctaButton, esc, summaryRow, statusBanner } from "./base";
export type { EmailTemplateResult, BaseTemplateData } from "./base";

export { welcomeTemplate } from "./welcome";
export type { WelcomeData } from "./welcome";

export { orderNewTemplate } from "./order-new";
export type { OrderNewData } from "./order-new";

export { orderCompletedTemplate } from "./order-completed";
export type { OrderCompletedData } from "./order-completed";

export { orderRefundedTemplate } from "./order-refunded";
export type { OrderRefundedData } from "./order-refunded";

export { disputeOpenedTemplate } from "./dispute-opened";
export type { DisputeOpenedData } from "./dispute-opened";

export { disputeResolvedTemplate } from "./dispute-resolved";
export type { DisputeResolvedData } from "./dispute-resolved";

export { pinResetTemplate } from "./pin-reset";
export type { PinResetData } from "./pin-reset";

export { genericNotificationTemplate } from "./generic-notification";
export type { GenericNotificationData } from "./generic-notification";

export { backupReminderTemplate } from "./backup-reminder";
export type { BackupReminderData } from "./backup-reminder";

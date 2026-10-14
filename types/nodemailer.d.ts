/**
 * Ambient module declaration for nodemailer v9.
 *
 * nodemailer v9 does not ship TypeScript declarations, and @types/nodemailer
 * only covers v6. The dynamic `await import("nodemailer")` call sites only
 * need createTransport(), so we declare a minimal, accurate shape instead of
 * scattering @ts-ignore/@ts-expect-error directives at every usage.
 */
declare module "nodemailer" {
  interface TransportOptions {
    host?: string;
    port?: number;
    secure?: boolean;
    auth?: { user?: string; pass?: string };
    [key: string]: unknown;
  }

  interface MailOptions {
    from?: string;
    to?: string;
    subject?: string;
    text?: string;
    html?: string;
    [key: string]: unknown;
  }

  interface Transporter {
    sendMail(options: MailOptions): Promise<unknown>;
    verify(): Promise<boolean>;
  }

  export function createTransport(options: TransportOptions): Transporter;
  export function verify(): Promise<boolean>;
}

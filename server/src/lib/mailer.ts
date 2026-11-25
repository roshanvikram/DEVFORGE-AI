import fs from "node:fs";
import path from "node:path";
import nodemailer from "nodemailer";
import { config } from "../config.js";
import { log } from "./logger.js";

/**
 * Sends email via SMTP when configured. Without SMTP (development), messages are written to
 * DATA_DIR/outbox/*.eml so verification/reset links can be opened locally. Nothing is printed
 * to logs in production.
 */
const transport = config.smtp
  ? nodemailer.createTransport({ host: config.smtp.host, port: config.smtp.port, secure: config.smtp.port === 465, auth: config.smtp.user ? { user: config.smtp.user, pass: config.smtp.pass } : undefined })
  : null;

export const outboxDir = path.join(config.dataDir, "outbox");

export async function sendMail(to: string, subject: string, text: string) {
  if (transport) {
    await transport.sendMail({ from: config.smtp!.from, to, subject, text });
    return { delivered: "smtp" as const };
  }
  if (config.isProd) {
    log.error("SMTP not configured; email not sent", { subject });
    return { delivered: "none" as const };
  }
  fs.mkdirSync(outboxDir, { recursive: true, mode: 0o700 });
  const file = path.join(outboxDir, `${Date.now()}-${subject.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}.eml`);
  fs.writeFileSync(file, `To: ${to}\nSubject: ${subject}\n\n${text}\n`, { mode: 0o600 });
  log.info("Email written to dev outbox (SMTP not configured)", { file });
  return { delivered: "outbox" as const, file };
}

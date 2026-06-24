import nodemailer from "nodemailer";
import { env } from "../config/env";
import { logger } from "../lib/logger";

const transporter = nodemailer.createTransport({
  host: env.SMTP_HOST,
  port: env.SMTP_PORT,
  secure: env.SMTP_PORT === 465, // true for 465, false for other ports
  auth: {
    user: env.SMTP_USER,
    pass: env.SMTP_PASS,
  },
});

export async function sendOtpEmail(to: string, code: string) {
  if (!env.SMTP_USER || !env.SMTP_PASS) {
    logger.warn(`SMTP credentials not set. Would have sent OTP ${code} to ${to}`);
    return;
  }
  
  const mailOptions = {
    from: env.SMTP_USER,
    to,
    subject: "Your Login OTP",
    text: `Your login OTP is: ${code}. It is valid for 15 minutes.`,
    html: `<p>Your login OTP is: <strong>${code}</strong></p><p>It is valid for 15 minutes.</p>`,
  };

  try {
    await transporter.sendMail(mailOptions);
    logger.info(`OTP email sent to ${to}`);
  } catch (error) {
    logger.error({ error }, "Error sending OTP email");
    throw new Error("Failed to send email");
  }
}

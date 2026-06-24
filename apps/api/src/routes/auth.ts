import { Router } from "express";
import { z } from "zod";
import { prisma } from "../db/client";
import { sendOtpEmail } from "../utils/mailer";
import { signToken } from "../utils/jwt";
import { requireAuth } from "../middleware/auth";

export const authRouter = Router();

// Request OTP
const requestOtpSchema = z.object({
  email: z.string().email(),
});

authRouter.post("/request-otp", async (req, res) => {
  const parsed = requestOtpSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error });
  }

  const { email } = parsed.data;
  
  // Generate a 6 digit code
  const code = Math.floor(100000 + Math.random() * 900000).toString();
  const expiresAt = new Date(Date.now() + 15 * 60 * 1000); // 15 minutes

  await prisma.otp.create({
    data: {
      email,
      code,
      expiresAt,
    },
  });

  await sendOtpEmail(email, code);

  res.json({ message: "OTP sent" });
});

// Verify OTP
const verifyOtpSchema = z.object({
  email: z.string().email(),
  code: z.string(),
});

authRouter.post("/verify-otp", async (req, res) => {
  const parsed = verifyOtpSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error });
  }

  const { email, code } = parsed.data;

  const otpRecord = await prisma.otp.findFirst({
    where: {
      email,
      code,
      expiresAt: { gt: new Date() },
    },
    orderBy: { createdAt: 'desc' },
  });

  if (!otpRecord) {
    return res.status(400).json({ error: "Invalid or expired OTP" });
  }

  // OTP valid, find or create user
  let user = await prisma.user.findUnique({ where: { email } });
  
  if (!user) {
    user = await prisma.user.create({
      data: {
        email,
        isVerified: true,
      },
    });
  } else if (!user.isVerified) {
    user = await prisma.user.update({
      where: { id: user.id },
      data: { isVerified: true },
    });
  }

  // Delete used OTPs for this email to clean up
  await prisma.otp.deleteMany({
    where: { email },
  });

  const token = signToken(user.id);

  res.json({ token, user });
});

authRouter.get("/me", requireAuth, (req, res) => {
  res.json({ user: req.user });
});

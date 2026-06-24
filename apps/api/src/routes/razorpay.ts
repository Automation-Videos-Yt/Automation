import { Router } from "express";
import Razorpay from "razorpay";
import crypto from "crypto";
import { env } from "../config/env";
import { requireAuth } from "../middleware/auth";
import { prisma } from "../db/prisma";
import { logger } from "../lib/logger";

export const razorpayRouter = Router();

const razorpayInstance = new Razorpay({
  key_id: env.RAZORPAY_KEY_ID || "dummy",
  key_secret: env.RAZORPAY_KEY_SECRET || "dummy",
});

razorpayRouter.post("/create-order", requireAuth, async (req, res) => {
  if (!env.RAZORPAY_KEY_ID || !env.RAZORPAY_KEY_SECRET) {
    return res.status(500).json({ error: "Razorpay is not configured" });
  }

  const { amount = 2900 } = req.body; 

  try {
    let customerId = req.user.razorpayCustomerId;

    if (!customerId) {
      try {
        const customer = await razorpayInstance.customers.create({
          name: req.user.email.split('@')[0],
          email: req.user.email,
          notes: { userId: req.user.id },
        });
        customerId = customer.id;
        
        await prisma.user.update({
          where: { id: req.user.id },
          data: { razorpayCustomerId: customerId },
        });
      } catch (err: any) {
         // If customer creation fails (e.g. invalid permissions on test keys), we can proceed without saving customerId
         logger.warn({ err }, "Could not create Razorpay customer. Proceeding with order anyway.");
      }
    }

    const options = {
      amount: amount * 100,  // amount in the smallest currency unit
      currency: "INR",
      receipt: `receipt_${Date.now()}`,
      notes: {
        userId: req.user.id,
      }
    };
    
    if (customerId) {
       (options as any).customer_id = customerId;
    }

    const order = await razorpayInstance.orders.create(options);
    
    res.json({ order, keyId: env.RAZORPAY_KEY_ID });
  } catch (err: any) {
    logger.error({ err }, "Razorpay order creation failed");
    res.status(500).json({ error: err.message || "Failed to create order" });
  }
});

razorpayRouter.post("/verify-payment", requireAuth, async (req, res) => {
  const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body;
  if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
    return res.status(400).json({ error: "Missing required fields" });
  }

  const secret = env.RAZORPAY_KEY_SECRET;
  if (!secret) return res.status(500).json({ error: "Razorpay secret missing" });

  const generatedSignature = crypto
    .createHmac("sha256", secret)
    .update(razorpay_order_id + "|" + razorpay_payment_id)
    .digest("hex");

  if (generatedSignature !== razorpay_signature) {
    return res.status(400).json({ error: "Invalid signature" });
  }

  try {
    const creditsToGrant = 100; // In a full implementation, pass the packageId via frontend
    
    await prisma.$transaction(async (tx: any) => {
      const existing = await tx.payment.findUnique({
        where: { providerPaymentId: razorpay_order_id }
      });

      if (existing) return; // Already processed by webhook

      const payment = await tx.payment.create({
        data: {
          userId: req.user.id,
          provider: "RAZORPAY",
          providerPaymentId: razorpay_order_id,
          amount: 2900, // Hardcoded for now based on V1 logic
          currency: "INR",
          status: "SUCCESS",
          creditsGranted: creditsToGrant
        }
      });

      const user = await tx.user.update({
        where: { id: req.user.id },
        data: { credits: { increment: creditsToGrant } }
      });

      await tx.creditTransaction.create({
        data: {
          userId: req.user.id,
          amount: creditsToGrant,
          balanceAfter: user.credits,
          type: "PURCHASE",
          referenceId: payment.id,
          metadata: { orderId: razorpay_order_id }
        }
      });
    });

    res.json({ success: true });
  } catch (err: any) {
    logger.error({ err }, "Error verifying payment and assigning credits");
    res.status(500).json({ error: "Database error" });
  }
});

// Webhook handling
razorpayRouter.post("/webhook", async (req, res) => {
  const signature = req.headers["x-razorpay-signature"] as string;

  if (!env.RAZORPAY_WEBHOOK_SECRET) {
    logger.warn("Razorpay webhook received but secret not configured.");
    return res.status(400).send("Webhook secret not configured");
  }

  try {
    const expectedSignature = crypto
      .createHmac("sha256", env.RAZORPAY_WEBHOOK_SECRET)
      .update(req.body) // req.body is a Buffer thanks to express.raw in app.ts
      .digest("hex");

    if (expectedSignature !== signature) {
      return res.status(400).send("Invalid signature");
    }

    const event = JSON.parse(req.body.toString());

    switch (event.event) {
      case "order.paid": {
        const order = event.payload.order.entity;
        const userId = order.notes?.userId;
        const packageId = order.notes?.packageId;
        
        if (userId) {
          await prisma.$transaction(async (tx: any) => {
             // Check idempotency via Payment ledger
             const existing = await tx.payment.findUnique({
               where: { providerPaymentId: order.id }
             });

             if (existing) return; // Already processed

             // Find package or default to 100
             let creditsToGrant = 100;
             if (packageId) {
                const pkg = await tx.creditPackage.findUnique({ where: { id: packageId }});
                if (pkg) creditsToGrant = pkg.credits;
             }

             const payment = await tx.payment.create({
               data: {
                 userId,
                 provider: "RAZORPAY",
                 providerPaymentId: order.id,
                 amount: order.amount,
                 currency: order.currency,
                 status: "SUCCESS",
                 creditsGranted: creditsToGrant
               }
             });

             const user = await tx.user.update({
               where: { id: userId },
               data: { credits: { increment: creditsToGrant } }
             });

             await tx.creditTransaction.create({
               data: {
                 userId,
                 amount: creditsToGrant,
                 balanceAfter: user.credits,
                 type: "PURCHASE",
                 referenceId: payment.id,
                 metadata: { orderId: order.id }
               }
             });
          });
        }
        break;
      }
    }
    
    res.json({ status: "ok" });
  } catch (err: any) {
    logger.error({ err }, "Error processing Razorpay webhook");
    res.status(500).send(`Webhook Error: ${err.message}`);
  }
});

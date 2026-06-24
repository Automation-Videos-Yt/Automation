import { Router } from "express";
import Stripe from "stripe";
import { env } from "../config/env";
import { requireAuth } from "../middleware/auth";
import { prisma } from "../db/prisma";
import { logger } from "../lib/logger";
import express from "express";

export const stripeRouter = Router();

const stripe = new Stripe(env.STRIPE_SECRET_KEY || "", {
  apiVersion: "2024-11-20.acacia" as any, 
});

stripeRouter.post("/create-checkout-session", requireAuth, async (req, res) => {
  if (!env.STRIPE_SECRET_KEY) {
    return res.status(500).json({ error: "Stripe is not configured" });
  }

  const { priceId, mode = "subscription" } = req.body;
  
  if (!priceId) {
     return res.status(400).json({ error: "priceId is required" });
  }

  try {
    let customerId = req.user.stripeCustomerId;

    if (!customerId) {
      const customer = await stripe.customers.create({
        email: req.user.email,
        metadata: { userId: req.user.id },
      });
      customerId = customer.id;
      
      await prisma.user.update({
        where: { id: req.user.id },
        data: { stripeCustomerId: customerId },
      });
    }

    const session = await stripe.checkout.sessions.create({
      customer: customerId,
      payment_method_types: ["card"],
      line_items: [
        {
          price: priceId,
          quantity: 1,
        },
      ],
      mode: mode as any, 
      success_url: `${env.WEB_BASE_URL}/payment/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${env.WEB_BASE_URL}/payment/cancel`,
      client_reference_id: req.user.id,
      metadata: {
        userId: req.user.id,
      },
    });

    res.json({ url: session.url });
  } catch (err: any) {
    logger.error({ err }, "Stripe checkout session creation failed");
    res.status(500).json({ error: err.message });
  }
});

// The webhook must use raw body, which will be handled in app.ts before express.json()
stripeRouter.post("/webhook", express.raw({ type: "application/json" }), async (req, res) => {
  const signature = req.headers["stripe-signature"];

  if (!env.STRIPE_WEBHOOK_SECRET) {
    logger.warn("Stripe webhook received but secret not configured.");
    return res.status(400).send("Webhook secret not configured");
  }

  let event: Stripe.Event;

  try {
    event = stripe.webhooks.constructEvent(
      req.body, // The raw body
      signature as string,
      env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err: any) {
    logger.error({ err }, "Webhook signature verification failed");
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  try {
    switch (event.type) {
      case "checkout.session.completed": {
        const session = event.data.object as Stripe.Checkout.Session;
        const userId = session.client_reference_id || session.metadata?.userId;
        
        if (userId) {
          if (session.mode === 'payment') {
             // Handle credits logic here based on metadata or price
             await prisma.user.update({
                where: { id: userId },
                data: {
                   credits: { increment: 100 } // Example static increment
                }
             });
          }
        }
        break;
      }
      case "customer.subscription.created":
      case "customer.subscription.updated": {
        const subscription = event.data.object as Stripe.Subscription;
        const customerId = subscription.customer as string;
        
        await prisma.user.updateMany({
           where: { stripeCustomerId: customerId },
           data: {
              stripeSubscriptionId: subscription.id,
              stripePriceId: subscription.items.data[0].price.id,
              stripeCurrentPeriodEnd: new Date((subscription as any).current_period_end * 1000)
           }
        });
        break;
      }
      case "customer.subscription.deleted": {
        const subscription = event.data.object as Stripe.Subscription;
        const customerId = subscription.customer as string;
        
        await prisma.user.updateMany({
           where: { stripeCustomerId: customerId },
           data: {
              stripeSubscriptionId: null,
              stripePriceId: null,
              stripeCurrentPeriodEnd: null
           }
        });
        break;
      }
    }
    
    res.json({ received: true });
  } catch (err: any) {
    logger.error({ err }, "Error processing Stripe webhook");
    res.status(500).send(`Webhook Error: ${err.message}`);
  }
});

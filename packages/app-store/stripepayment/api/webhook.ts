import process from "node:process";
import { handlePaymentSuccess } from "@calcom/app-store/_utils/payments/handlePaymentSuccess";
import { HttpError as HttpCode } from "@calcom/lib/http-error";
import logger from "@calcom/lib/logger";
import { getServerErrorFromUnknown } from "@calcom/lib/server/getServerErrorFromUnknown";
import { distributedTracing } from "@calcom/lib/tracing/factory";
import prisma from "@calcom/prisma";
import type { NextApiRequest, NextApiResponse } from "next";
import getRawBody from "raw-body";
import Stripe from "stripe";
import getAppKeysFromSlug from "../../_utils/getAppKeysFromSlug";
import appConfig from "../_metadata";

export const config = {
  api: {
    bodyParser: false,
  },
};

const log = logger.getSubLogger({ prefix: ["[stripe-webhook]"] });

/**
 * App keys live in the admin app-store entry (App.keys); the community deployment also carries them as
 * STRIPE_PRIVATE_KEY / STRIPE_WEBHOOK_SECRET in the container env (PaymentService reads the former).
 * Read the raw JSON rather than the strict parsed schema so that a partially filled entry still lets
 * each field fall back to its env var on its own.
 */
async function getStripeKeys(): Promise<{ secretKey?: string; webhookSecret?: string }> {
  const appKeys = await getAppKeysFromSlug(appConfig.slug);
  const str = (v: unknown): string | undefined => (typeof v === "string" && v.length > 0 ? v : undefined);
  return {
    secretKey: str(appKeys.client_secret) || process.env.STRIPE_PRIVATE_KEY,
    webhookSecret: str(appKeys.webhook_secret) || process.env.STRIPE_WEBHOOK_SECRET,
  };
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  try {
    if (req.method !== "POST") {
      throw new HttpCode({ statusCode: 405, message: "Method Not Allowed" });
    }

    const signature = req.headers["stripe-signature"];
    if (!signature || typeof signature !== "string") {
      throw new HttpCode({ statusCode: 400, message: "Missing stripe-signature header" });
    }

    const { secretKey, webhookSecret } = await getStripeKeys();
    if (!secretKey) {
      throw new HttpCode({ statusCode: 500, message: "Stripe secret key is missing" });
    }
    if (!webhookSecret) {
      throw new HttpCode({ statusCode: 500, message: "Stripe webhook secret is missing" });
    }

    const rawBody = (await getRawBody(req)).toString();
    const stripe = new Stripe(secretKey, { apiVersion: "2020-08-27" });

    let event: Stripe.Event;
    try {
      event = stripe.webhooks.constructEvent(rawBody, signature, webhookSecret);
    } catch {
      throw new HttpCode({ statusCode: 400, message: "Webhook signature verification failed" });
    }

    log.info(`Received Stripe event ${event.type}`);

    // `event.account` (the connected Stripe account id) needs no special handling here: the
    // PaymentIntent id is unique across connected accounts and is what we match payments on.
    switch (event.type) {
      case "payment_intent.succeeded": {
        const paymentIntent = event.data.object as Stripe.PaymentIntent;
        const payment = await prisma.payment.findFirst({
          where: { externalId: paymentIntent.id },
          select: { id: true, bookingId: true, success: true },
        });

        if (!payment) {
          log.info(`Payment not found for payment intent ${paymentIntent.id}`);
          return res.status(200).json({ message: "Payment not found" });
        }
        // Stripe delivers events at least once, so never process the same payment twice.
        if (payment.success) {
          log.info(`Payment ${payment.id} was already processed`);
          return res.status(200).json({ message: "Already processed" });
        }
        if (!payment.bookingId) {
          log.info(`Payment ${payment.id} has no booking`);
          return res.status(200).json({ message: "Payment not found" });
        }

        const traceContext = distributedTracing.createTrace("stripe_webhook", {
          meta: { paymentId: payment.id, bookingId: payment.bookingId },
        });
        await handlePaymentSuccess({
          paymentId: payment.id,
          bookingId: payment.bookingId,
          appSlug: appConfig.slug,
          traceContext,
        });
        return res.status(200).json({ message: "Payment processed" });
      }

      case "charge.refunded": {
        const charge = event.data.object as Stripe.Charge;
        if (typeof charge.payment_intent === "string") {
          await prisma.payment.updateMany({
            where: { externalId: String(charge.payment_intent) },
            data: { refunded: true },
          });
          log.info(`Recorded refund for payment intent ${charge.payment_intent}`);
        }
        return res.status(200).json({ message: "Refund recorded" });
      }

      case "payment_intent.payment_failed":
      case "setup_intent.succeeded":
        // Failed intents need no bookkeeping (the booking stays unpaid and expires); HOLD (card-on-file,
        // setup_intent) payments are not supported by this community patch. Logged above by type.
        return res.status(200).json({ message: "Ignored" });

      default:
        return res.status(200).json({ received: true });
    }
  } catch (_err) {
    // Method/signature/config problems map to 4xx/5xx; a processing failure after a verified signature
    // also stays non-2xx on purpose: Stripe then retries with backoff (up to 3 days), so a transient
    // database or e-mail error cannot silently lose a paid booking. Idempotency above makes retries safe.
    const err = getServerErrorFromUnknown(_err);
    log.error(`Stripe webhook error: ${err.message}`);
    return res.status(err.statusCode).json({ message: err.message });
  }
}

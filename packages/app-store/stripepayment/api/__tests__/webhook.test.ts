import { handlePaymentSuccess } from "@calcom/app-store/_utils/payments/handlePaymentSuccess";
import prisma from "@calcom/prisma";
import type { NextApiRequest, NextApiResponse } from "next";
import getRawBody from "raw-body";
import Stripe from "stripe";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import getAppKeysFromSlug from "../../../_utils/getAppKeysFromSlug";

const { mockConstructEvent } = vi.hoisted(() => ({ mockConstructEvent: vi.fn() }));

vi.mock("stripe", () => ({
  // Must be a regular function so `new Stripe(...)` works in the handler.
  default: vi.fn().mockImplementation(function () {
    return { webhooks: { constructEvent: mockConstructEvent } };
  }),
}));

vi.mock("raw-body", () => ({
  default: vi.fn(),
}));

vi.mock("@calcom/prisma", () => ({
  default: {
    payment: {
      findFirst: vi.fn(),
      updateMany: vi.fn(),
    },
  },
}));

vi.mock("@calcom/app-store/_utils/payments/handlePaymentSuccess", () => ({
  handlePaymentSuccess: vi.fn(),
}));

vi.mock("../../../_utils/getAppKeysFromSlug", () => ({
  default: vi.fn(),
}));

const mockGetRawBody = vi.mocked(getRawBody);
const mockStripeConstructor = vi.mocked(Stripe);
const mockHandlePaymentSuccess = vi.mocked(handlePaymentSuccess);
const mockGetAppKeys = vi.mocked(getAppKeysFromSlug);
// Type the mocked prisma properly
const mockPrisma = prisma as unknown as {
  payment: {
    findFirst: ReturnType<typeof vi.fn>;
    updateMany: ReturnType<typeof vi.fn>;
  };
};

const appKeys = {
  client_id: "ca_app",
  client_secret: "sk_app",
  public_key: "pk_app",
  webhook_secret: "whsec_app",
};

const signature = "t=1,v1=signature";

function createRequest(overrides: Partial<NextApiRequest> = {}): NextApiRequest {
  return {
    method: "POST",
    headers: { "stripe-signature": signature },
    ...overrides,
  } as unknown as NextApiRequest;
}

function createResponse() {
  const res = {
    status: vi.fn(),
    json: vi.fn(),
  };
  res.status.mockReturnValue(res);
  res.json.mockReturnValue(res);
  return res;
}

async function runHandler(req: NextApiRequest, res: ReturnType<typeof createResponse>) {
  const { default: handler } = await import("../webhook");
  await handler(req, res as unknown as NextApiResponse);
}

function stripeEvent(type: string, object: Record<string, unknown> = {}): Stripe.Event {
  return { type, data: { object } } as unknown as Stripe.Event;
}

describe("stripepayment webhook", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("STRIPE_PRIVATE_KEY", "");
    vi.stubEnv("STRIPE_WEBHOOK_SECRET", "");

    mockGetRawBody.mockResolvedValue(Buffer.from('{"id":"evt_1"}'));
    mockGetAppKeys.mockResolvedValue(appKeys);
    mockHandlePaymentSuccess.mockResolvedValue(undefined);
    mockConstructEvent.mockReturnValue(stripeEvent("customer.created"));
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("returns 405 for non-POST requests", async () => {
    const res = createResponse();
    await runHandler(createRequest({ method: "GET" }), res);

    expect(res.status).toHaveBeenCalledWith(405);
    expect(mockConstructEvent).not.toHaveBeenCalled();
  });

  it("returns 400 when the stripe-signature header is missing", async () => {
    const res = createResponse();
    await runHandler(createRequest({ headers: {} }), res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(mockGetRawBody).not.toHaveBeenCalled();
    expect(mockConstructEvent).not.toHaveBeenCalled();
  });

  it("returns 400 when signature verification fails", async () => {
    mockConstructEvent.mockImplementation(() => {
      throw new Error("No signatures found matching the expected signature for payload");
    });

    const res = createResponse();
    await runHandler(createRequest(), res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({ message: "Webhook signature verification failed" });
  });

  it("acknowledges unknown event types without touching payments", async () => {
    mockConstructEvent.mockReturnValue(stripeEvent("customer.created"));

    const res = createResponse();
    await runHandler(createRequest(), res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({ received: true });
    expect(mockPrisma.payment.findFirst).not.toHaveBeenCalled();
    expect(mockPrisma.payment.updateMany).not.toHaveBeenCalled();
    expect(mockHandlePaymentSuccess).not.toHaveBeenCalled();
  });

  it("marks the booking as paid for a successful payment intent", async () => {
    mockConstructEvent.mockReturnValue(stripeEvent("payment_intent.succeeded", { id: "pi_123" }));
    mockPrisma.payment.findFirst.mockResolvedValue({ id: 7, bookingId: 21, success: false });

    const res = createResponse();
    await runHandler(createRequest(), res);

    expect(mockPrisma.payment.findFirst).toHaveBeenCalledWith({
      where: { externalId: "pi_123" },
      select: { id: true, bookingId: true, success: true },
    });
    expect(mockHandlePaymentSuccess).toHaveBeenCalledTimes(1);
    expect(mockHandlePaymentSuccess).toHaveBeenCalledWith(
      expect.objectContaining({
        paymentId: 7,
        bookingId: 21,
        appSlug: "stripe",
        traceContext: expect.anything(),
      })
    );
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it("does not re-process a payment that was already successful", async () => {
    mockConstructEvent.mockReturnValue(stripeEvent("payment_intent.succeeded", { id: "pi_123" }));
    mockPrisma.payment.findFirst.mockResolvedValue({ id: 7, bookingId: 21, success: true });

    const res = createResponse();
    await runHandler(createRequest(), res);

    expect(mockHandlePaymentSuccess).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({ message: "Already processed" });
  });

  it("acknowledges a payment intent that has no matching payment", async () => {
    mockConstructEvent.mockReturnValue(stripeEvent("payment_intent.succeeded", { id: "pi_unknown" }));
    mockPrisma.payment.findFirst.mockResolvedValue(null);

    const res = createResponse();
    await runHandler(createRequest(), res);

    expect(mockHandlePaymentSuccess).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({ message: "Payment not found" });
  });

  it("records a refund for the matching payment", async () => {
    mockConstructEvent.mockReturnValue(
      stripeEvent("charge.refunded", { id: "ch_1", payment_intent: "pi_123" })
    );

    const res = createResponse();
    await runHandler(createRequest(), res);

    expect(mockPrisma.payment.updateMany).toHaveBeenCalledWith({
      where: { externalId: "pi_123" },
      data: { refunded: true },
    });
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it("falls back to env vars when the app keys lack a webhook secret", async () => {
    vi.stubEnv("STRIPE_WEBHOOK_SECRET", "whsec_from_env");
    mockGetAppKeys.mockResolvedValue({ ...appKeys, webhook_secret: "" });
    mockConstructEvent.mockReturnValue(stripeEvent("customer.created"));

    const res = createResponse();
    await runHandler(createRequest(), res);

    expect(mockStripeConstructor).toHaveBeenCalledWith("sk_app", { apiVersion: "2020-08-27" });
    expect(mockConstructEvent).toHaveBeenCalledWith(expect.any(String), signature, "whsec_from_env");
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it("keeps the app-key field that is present and falls back only for the missing one", async () => {
    vi.stubEnv("STRIPE_PRIVATE_KEY", "sk_from_env");
    vi.stubEnv("STRIPE_WEBHOOK_SECRET", "whsec_from_env");
    mockGetAppKeys.mockResolvedValue({ client_id: "ca_only", webhook_secret: "whsec_app" });
    mockConstructEvent.mockReturnValue(stripeEvent("customer.created"));

    const res = createResponse();
    await runHandler(createRequest(), res);

    expect(mockStripeConstructor).toHaveBeenCalledWith("sk_from_env", { apiVersion: "2020-08-27" });
    expect(mockConstructEvent).toHaveBeenCalledWith(expect.any(String), signature, "whsec_app");
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it("returns 500 when no secrets are configured", async () => {
    mockGetAppKeys.mockResolvedValue({});

    const res = createResponse();
    await runHandler(createRequest(), res);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(mockConstructEvent).not.toHaveBeenCalled();
  });

  it("answers non-2xx when processing fails after a verified signature, so Stripe retries", async () => {
    mockConstructEvent.mockReturnValue(stripeEvent("payment_intent.succeeded", { id: "pi_123" }));
    mockPrisma.payment.findFirst.mockResolvedValue({ id: 7, bookingId: 21, success: false });
    mockHandlePaymentSuccess.mockRejectedValue(new Error("database unavailable"));

    const res = createResponse();
    await runHandler(createRequest(), res);

    expect(res.status).toHaveBeenCalledWith(500);
  });

  it.each([
    "payment_intent.payment_failed",
    "setup_intent.succeeded",
  ])("acknowledges the ignored event %s", async (type) => {
    mockConstructEvent.mockReturnValue(stripeEvent(type));

    const res = createResponse();
    await runHandler(createRequest(), res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(mockHandlePaymentSuccess).not.toHaveBeenCalled();
    expect(mockPrisma.payment.findFirst).not.toHaveBeenCalled();
  });
});

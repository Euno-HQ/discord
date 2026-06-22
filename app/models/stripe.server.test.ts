import { Effect, Exit } from "effect";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock the Stripe SDK so no real client is constructed and each method's
// underlying call can be controlled per-test. The default export is a class
// whose instance exposes the namespaces StripeService touches.
const checkoutRetrieve = vi.fn();
const customersSearch = vi.fn();
const subscriptionsCancel = vi.fn();
const invoicesList = vi.fn();
const listPaymentMethods = vi.fn();

vi.mock("stripe", () => ({
  default: class {
    checkout = { sessions: { retrieve: checkoutRetrieve, create: vi.fn() } };
    customers = {
      search: customersSearch,
      create: vi.fn(),
      listPaymentMethods,
    };
    subscriptions = { cancel: subscriptionsCancel };
    invoices = { list: invoicesList };
    prices = { list: vi.fn() };
    webhooks = { constructEvent: vi.fn() };
  },
}));

// Sentry side-effect is preserved on the error path; mock to assert it fires.
const captureException = vi.fn();
vi.mock("#~/helpers/sentry.server", () => ({
  default: { captureException },
}));

vi.mock("#~/effects/observability", () => ({
  logEffect: () => Effect.void,
}));

const { StripeService } = await import("./stripe.server");

const run = <A, E>(eff: Effect.Effect<A, E, never>) =>
  Effect.runPromiseExit(eff);

beforeEach(() => {
  vi.clearAllMocks();
});

describe("StripeService recover-as-default branches", () => {
  it("verifyCheckoutSession returns null on SDK error (no failure)", async () => {
    checkoutRetrieve.mockRejectedValueOnce(new Error("boom"));
    const exit = await run(StripeService.verifyCheckoutSession("sess_1"));
    expect(Exit.isSuccess(exit)).toBe(true);
    if (Exit.isSuccess(exit)) expect(exit.value).toBeNull();
    expect(captureException).toHaveBeenCalledTimes(1);
  });

  it("verifyCheckoutSession returns mapped session on success", async () => {
    checkoutRetrieve.mockResolvedValueOnce({
      payment_status: "paid",
      client_reference_id: "guild_1",
      customer: "cus_1",
      subscription: "sub_1",
      amount_total: 1000,
    });
    const exit = await run(StripeService.verifyCheckoutSession("sess_1"));
    expect(Exit.isSuccess(exit)).toBe(true);
    if (Exit.isSuccess(exit))
      expect(exit.value).toEqual({
        payment_status: "paid",
        client_reference_id: "guild_1",
        customer: "cus_1",
        subscription: "sub_1",
        amount_total: 1000,
      });
    expect(captureException).not.toHaveBeenCalled();
  });

  it("getCustomerByGuildId returns null on SDK error", async () => {
    customersSearch.mockRejectedValueOnce(new Error("boom"));
    const exit = await run(StripeService.getCustomerByGuildId("guild_1"));
    expect(Exit.isSuccess(exit)).toBe(true);
    if (Exit.isSuccess(exit)) expect(exit.value).toBeNull();
    expect(captureException).toHaveBeenCalledTimes(1);
  });

  it("getCustomerByGuildId returns null when no match found (no error)", async () => {
    customersSearch.mockResolvedValueOnce({ data: [] });
    const exit = await run(StripeService.getCustomerByGuildId("guild_1"));
    expect(Exit.isSuccess(exit)).toBe(true);
    if (Exit.isSuccess(exit)) expect(exit.value).toBeNull();
    expect(captureException).not.toHaveBeenCalled();
  });

  it("getCustomerByGuildId returns id when found", async () => {
    customersSearch.mockResolvedValueOnce({ data: [{ id: "cus_42" }] });
    const exit = await run(StripeService.getCustomerByGuildId("guild_1"));
    expect(Exit.isSuccess(exit)).toBe(true);
    if (Exit.isSuccess(exit)) expect(exit.value).toBe("cus_42");
  });

  it("cancelSubscription returns false on SDK error", async () => {
    subscriptionsCancel.mockRejectedValueOnce(new Error("boom"));
    const exit = await run(StripeService.cancelSubscription("sub_1"));
    expect(Exit.isSuccess(exit)).toBe(true);
    if (Exit.isSuccess(exit)) expect(exit.value).toBe(false);
    expect(captureException).toHaveBeenCalledTimes(1);
  });

  it("cancelSubscription returns true on success", async () => {
    subscriptionsCancel.mockResolvedValueOnce({});
    const exit = await run(StripeService.cancelSubscription("sub_1"));
    expect(Exit.isSuccess(exit)).toBe(true);
    if (Exit.isSuccess(exit)) expect(exit.value).toBe(true);
  });

  it("listInvoices returns [] on SDK error", async () => {
    invoicesList.mockRejectedValueOnce(new Error("boom"));
    const exit = await run(StripeService.listInvoices("cus_1"));
    expect(Exit.isSuccess(exit)).toBe(true);
    if (Exit.isSuccess(exit)) expect(exit.value).toEqual([]);
    expect(captureException).toHaveBeenCalledTimes(1);
  });

  it("listPaymentMethods returns [] on SDK error", async () => {
    listPaymentMethods.mockRejectedValueOnce(new Error("boom"));
    const exit = await run(StripeService.listPaymentMethods("cus_1"));
    expect(Exit.isSuccess(exit)).toBe(true);
    if (Exit.isSuccess(exit)) expect(exit.value).toEqual([]);
    expect(captureException).toHaveBeenCalledTimes(1);
  });
});

import { expect, test } from "./fixtures/auth";
import { createDiscordMock } from "./mocks/discord";

test.describe("Payment Flow", () => {
  // Run tests serially to avoid database cleanup conflicts
  test.describe.configure({ mode: "serial" });

  test.describe("Authenticated - Payment Flow", () => {
    test("complete Stripe checkout flow upgrades to Pro", async ({
      authenticatedPage,
      db,
      testUser,
    }) => {
      // Setup: Create a free tier guild
      const guild = await db.createGuild({
        productTier: "free",
        status: "active",
      });

      // Setup Discord mock
      const discordMock = createDiscordMock({
        userId: testUser.externalId,
        userEmail: testUser.email,
        guilds: [{ id: guild.id, name: "Test Guild", permissions: "32" }],
      });
      await discordMock.setup(authenticatedPage);

      // Navigate to upgrade page
      await authenticatedPage.goto(`/app/${guild.id}/settings`);
      await expect(
        authenticatedPage.getByRole("tab", { name: "Upgrade" }),
      ).toBeVisible();
      await authenticatedPage.getByRole("tab", { name: "Upgrade" }).click();

      await expect(
        authenticatedPage.getByRole("button", { name: "Switch to Paid" }),
      ).toBeVisible();

      await authenticatedPage
        .getByRole("button", { name: "Switch to Paid" })
        .click();

      // Wait for Stripe checkout page to load
      await authenticatedPage.waitForURL(/checkout\.stripe\.com/);
      await authenticatedPage.waitForLoadState("domcontentloaded");

      // Fill in Stripe test card details
      // Note: Stripe checkout has direct input fields, not iframes
      const emailInput = authenticatedPage.getByLabel("Email", {
        exact: false,
      });
      if (await emailInput.isVisible().catch(() => false)) {
        await emailInput.fill(testUser.email);
      }

      // Fill in card number (test card: 4242 4242 4242 4242)
      await authenticatedPage.locator("#cardNumber").fill("4242424242424242");

      // Fill in expiry date (any future date)
      await authenticatedPage.locator("#cardExpiry").fill("12/34");

      // Fill in CVC
      await authenticatedPage.locator("#cardCvc").fill("123");

      // Fill in cardholder name (required field)
      await authenticatedPage
        .getByPlaceholder("Full name on card")
        .fill("Test User");

      // Fill in ZIP code (required for US)
      await authenticatedPage.getByPlaceholder("ZIP").fill("12345");

      // Uncheck "Save my information" to avoid needing phone number for Link
      const saveInfoCheckbox = authenticatedPage.getByRole("checkbox", {
        name: /save my information/i,
      });
      if (await saveInfoCheckbox.isChecked()) {
        await saveInfoCheckbox.uncheck();
      }

      // Submit the payment
      await authenticatedPage
        .getByTestId("hosted-payment-submit-button")
        .click();

      await authenticatedPage.waitForTimeout(2000);

      // Verify success page
      await expect(
        authenticatedPage.getByText(
          "You have a paid plan. Thank you for subscribing",
        ),
      ).toBeVisible();
    });
  });
});

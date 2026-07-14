import { describe, it, expect } from "vitest";

/**
 * Smoke test: ensures the app's route tree and key route modules can be
 * imported without triggering module-initialization errors (e.g. the
 * circular-dependency wedge that previously broke /login and
 * /admin/settings on startup).
 *
 * If any of these imports throws at module scope, the test fails —
 * catching regressions before they surface as a 500 on the live app.
 */
describe("app boot smoke", () => {
  it("imports the generated route tree without throwing", async () => {
    const mod = await import("@/routeTree.gen");
    expect(mod.routeTree).toBeDefined();
  });

  it("imports the router without throwing", async () => {
    const mod = await import("@/router");
    expect(typeof mod.getRouter).toBe("function");
  });

  it("imports the /login route module without throwing", async () => {
    const mod = await import("@/routes/login");
    expect(mod.Route).toBeDefined();
  });

  it("imports the /admin/settings route module without throwing", async () => {
    const mod = await import("@/routes/_authenticated/admin.settings");
    expect(mod.Route).toBeDefined();
  });

  it("imports the admin settings page component without throwing", async () => {
    const mod = await import(
      "@/routes/_authenticated/-admin-settings-page"
    );
    // The page module should expose at least one export (the component).
    expect(Object.keys(mod).length).toBeGreaterThan(0);
  });
});

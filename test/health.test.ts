import { describe, expect, it } from "vitest";
import { createApp } from "../src/index.js";

describe("GET /health", () => {
  it("reports a healthy database connection", async () => {
    const app = createApp({ checkDatabase: async () => true });

    const response = await app.request("/health");

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, db: true });
  });

  it("reports an unhealthy database connection", async () => {
    const app = createApp({ checkDatabase: async () => false });

    const response = await app.request("/health");

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: false, db: false });
  });
});

import { defineConfig } from "vitest/config";

// Unit tests for the pure logic: the fixture world and its decisions, the loan status machine and the role gates.
// They run in jsdom (the fixture server uses localStorage and window.fetch) and never touch the network.
export default defineConfig({
  test: {
    environment: "jsdom",
    include: ["src/**/*.test.{ts,tsx}"],
  },
});

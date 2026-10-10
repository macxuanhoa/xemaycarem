import { describe, expect, it } from "vitest";
import {
  createRuntimeReporter,
  runtimeRelease,
  runtimeRoute,
  safeRuntimeIssue,
  type RuntimeIssue,
} from "@/lib/runtimeIssueCore";
const base = {
  source: "rpc",
  code: "RPC_SERVER_ERROR",
  operation: "get_vehicle",
  route: "/vehicles",
  release: "1.0.0",
  environment: "production",
};

describe("closed-vocabulary diagnostic privacy", () => {
  it("discards raw errors, payloads, tokens, CCCD and unknown operation names", () => {
    const safe = safeRuntimeIssue({
      ...base,
      operation: "079123456789",
      route: "/vehicles/079123456789?token=secret",
      release: "079123456789",
      message: "PRIVATE CUSTOMER",
      stack: "PRIVATE STACK",
      payload: { photo: "data:image/...", CCCD: "079123456789" },
      token: "secret",
    });
    expect(safe).toEqual({
      ...base,
      operation: "other",
      route: "/vehicles/:id",
      release: "unknown",
    });
    expect(JSON.stringify(safe)).not.toMatch(
      /PRIVATE|079123456789|secret|data:image/,
    );
  });
  it.each([
    ["/vehicles/secret-id/edit?phone=123", "/vehicles/:id/edit"],
    ["/vehicles/secret-id/sell", "/vehicles/:id/sell"],
    ["/sales/secret-id", "/sales/:id"],
    ["/docs/customer-name", "/docs/:slug"],
    ["/some-private-path", "/other"],
    ["/capture/?token=secret", "/capture"],
  ])("templates all variable paths: %s", (path, result) =>
    expect(runtimeRoute(path)).toBe(result),
  );
  it("only accepts release versions or Git hashes, plus fixed source/code enums", () => {
    expect(runtimeRelease("v1.2.3-staging")).toBe("v1.2.3-staging");
    expect(runtimeRelease("a123b456c789")).toBe("a123b456c789");
    expect(runtimeRelease("customer@example.test")).toBe("unknown");
    expect(
      safeRuntimeIssue({ ...base, code: "ERROR with PRIVATE DETAILS" }),
    ).toBeNull();
    expect(safeRuntimeIssue({ ...base, source: "PRIVATE" })).toBeNull();
  });
});

describe("bounded nonblocking diagnostic delivery", () => {
  it("deduplicates a repeated issue for one minute and sends only its safe fields", async () => {
    let time = 1000;
    const sent: RuntimeIssue[] = [];
    const reporter = createRuntimeReporter({
      schedule: false,
      now: () => time,
      send: async (issue) => {
        sent.push(issue);
        return "sent";
      },
    });
    expect(reporter.report({ ...base, message: "SECRET" })).toBe(true);
    expect(reporter.report(base)).toBe(false);
    await reporter.flush();
    expect(sent).toEqual([base]);
    time += 60001;
    expect(reporter.report(base)).toBe(true);
    await reporter.flush();
    expect(sent.length).toBe(2);
    reporter.dispose();
  });
  it("queues offline without sending, limits memory to 20 and limits retries to 3", async () => {
    let online = false,
      attempts = 0;
    const reporter = createRuntimeReporter({
      schedule: false,
      online: () => online,
      send: async () => {
        attempts++;
        throw new Error("PRIVATE NETWORK ERROR");
      },
    });
    for (let i = 0; i < 20; i++)
      expect(reporter.report({ ...base, release: `1.0.${i}` })).toBe(true);
    expect(reporter.report({ ...base, release: "1.1.0" })).toBe(false);
    await reporter.flush();
    expect(attempts).toBe(0);
    online = true;
    await reporter.flush();
    await reporter.flush();
    await reporter.flush();
    expect(attempts).toBe(3);
    await reporter.flush();
    expect(attempts).toBe(4); // Next queued issue, not an endless retry.
    reporter.dispose();
  });
  it("stops on missing monitoring migration without affecting caller work", async () => {
    let attempts = 0;
    const reporter = createRuntimeReporter({
      schedule: false,
      send: async () => {
        attempts++;
        return "disabled";
      },
    });
    reporter.report(base);
    await reporter.flush();
    expect(
      reporter.report({ ...base, source: "render", code: "RENDER_ERROR" }),
    ).toBe(false);
    await reporter.flush();
    expect(attempts).toBe(1);
  });
  it("caps sends at 20 per ten minutes and resumes after the time window", async () => {
    let time = 1000,
      attempts = 0;
    const reporter = createRuntimeReporter({
      schedule: false,
      now: () => time,
      send: async () => {
        attempts++;
        return "sent";
      },
    });
    for (let i = 0; i < 20; i++) {
      reporter.report({ ...base, release: `1.0.${i}` });
      await reporter.flush();
    }
    reporter.report({ ...base, release: "1.1.0" });
    await reporter.flush();
    expect(attempts).toBe(20);
    time += 600001;
    await reporter.flush();
    expect(attempts).toBe(21);
    reporter.dispose();
  });
  it("serializes flushes so simultaneous network/online events cannot duplicate a report", async () => {
    let finish!: (result: "sent") => void,
      attempts = 0;
    const reporter = createRuntimeReporter({
      schedule: false,
      send: () => {
        attempts++;
        return new Promise((resolve) => {
          finish = resolve;
        });
      },
    });
    reporter.report(base);
    const pending = reporter.flush();
    await reporter.flush();
    expect(attempts).toBe(1);
    finish("sent");
    await pending;
    await reporter.flush();
    expect(attempts).toBe(1);
    reporter.dispose();
  });
});

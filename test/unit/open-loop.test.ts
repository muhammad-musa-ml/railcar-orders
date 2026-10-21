import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openLoop, stepReport, timed } from "../../scripts/lib/open-loop";

// A local server that answers after a fixed delay, to check the load generator itself.
const DELAY_MS = 40;
let server: Server;
let url: string;

beforeAll(async () => {
  server = createServer((req, res) => {
    setTimeout(() => {
      if (req.url === "/fail") {
        res.writeHead(500).end();
        return;
      }
      res.writeHead(201, { "content-type": "application/json" }).end(JSON.stringify({ orderId: "o-1" }));
    }, DELAY_MS);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => {
  server.close();
});

describe("openLoop", () => {
  it("sends at the target rate even though each response takes longer than the interval", async () => {
    // 50/s is one request every 20 ms; each answer takes 40 ms, so a closed loop would manage 25/s.
    const { samples, sendSeconds } = await openLoop(50, 1, () => timed(`${url}/orders`, { method: "POST" }));
    const report = stepReport("POST /orders", 50, samples, sendSeconds);
    expect(report.requests).toBe(50);
    expect(report.ok).toBe(50);
    expect(report.achievedSendRate).toBeGreaterThan(40);
    expect(report.achievedSendRate).toBeLessThanOrEqual(51);
    expect(report.latencyMsOk?.min).toBeGreaterThanOrEqual(DELAY_MS - 5);
    expect(samples[0]?.orderId).toBe("o-1");
  });

  it("counts failures by status and keeps them out of the latency summary", async () => {
    const { samples, sendSeconds } = await openLoop(20, 0.5, (i) =>
      timed(i % 2 === 0 ? `${url}/orders` : `${url}/fail`, { method: "POST" }),
    );
    const report = stepReport("POST /orders", 20, samples, sendSeconds);
    expect(report.statuses).toEqual({ "201": 5, "500": 5 });
    expect(report.latencyMsOk?.n).toBe(5);
  });

  it("records a connection failure as status 0", async () => {
    const sample = await timed("http://127.0.0.1:9/", {});
    expect(sample.status).toBe(0);
  });
});

/**
 * Query-policy parity through the real Specmatic JVM.
 *
 * YAML and TypeScript configure the same source-neutral query policy, while
 * the mixed case loads the collection policy from YAML and the targeted
 * fallback policy from TypeScript. Every business request goes through
 * Specmatic; the engine URL is used only for reset and the forwarding probe.
 */

import { startE2eApp } from "./_harness/e2e-test-app";
import type { E2eApp } from "./_harness/e2e-test-app";

const FIXTURE_ROOT = `${process.cwd()}/tests/fixtures/query-policy`;

const MODES = [
  { name: "YAML", config: "potemkin-yaml.yml" },
  { name: "TypeScript", config: "potemkin-typescript.yml" },
  { name: "YAML + TypeScript", config: "potemkin-mixed.yml" },
] as const;

interface OrderPage {
  readonly items: readonly {
    readonly id: string;
    readonly score: number;
    readonly active: boolean;
    readonly _deleted?: boolean;
    readonly customerIds?: readonly string[];
    readonly _customerIds?: readonly {
      readonly id: string;
      readonly score?: number;
      readonly active?: boolean;
    }[];
  }[];
  readonly totalCount: number;
  readonly offset: number;
  readonly limit: number;
  readonly hasMore: boolean;
  readonly nextCursor?: string;
}

const RESPONSE_FORMATS = ["plain", "hal", "jsonapi"] as const;
const PAGINATION_STYLES = ["envelope", "raw", "link-header"] as const;

type ResponseFormat = (typeof RESPONSE_FORMATS)[number];
type PaginationStyle = (typeof PAGINATION_STYLES)[number];

const RESPONSE_FORMAT_MATRIX = RESPONSE_FORMATS.flatMap((format) =>
  PAGINATION_STYLES.map((pagination) => ({ format, pagination })),
);

async function reset(app: E2eApp): Promise<void> {
  const response = await fetch(`${app.engineUrl}/_admin/reset`, { method: "POST" });
  expect([200, 204]).toContain(response.status);
}

describe.each(MODES)("$name query-policy parity", (mode) => {
  let app: E2eApp;

  beforeAll(async () => {
    app = await startE2eApp({
      fixtureName: "query-policy",
      potemkinConfigPath: `${FIXTURE_ROOT}/${mode.config}`,
      warmupPath: "/probes/missing",
      warmupExpectedStatus: 404,
    });
    expect(app.stubForwardingHealthy).toBe(true);
  }, 180_000);

  afterAll(async () => {
    await app?.shutdown();
  }, 30_000);

  beforeEach(async () => {
    await reset(app);
  });

  it("filters, sorts, limits, and envelopes collection results through Specmatic", async () => {
    const response = await fetch(`${app.stubUrl}/orders`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as OrderPage;
    expect(body).toMatchObject({
      items: [
        {
          id: "order-deleted",
          score: 4,
          active: true,
        },
        {
          id: "order-2",
          score: 3,
          active: true,
          customerIds: ["order-1"],
          _customerIds: [{ id: "order-1", score: 1, active: true }],
        },
      ],
      totalCount: 4,
      offset: 0,
      limit: 2,
      hasMore: true,
      nextCursor: expect.any(String),
    });
  }, 60_000);

  it("pushes an initialized entity fixture into Specmatic with the same state", async () => {
    const response = await fetch(`${app.stubUrl}/orders/order-2`);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(
      expect.objectContaining({
        id: "order-2",
        score: 3,
        active: true,
        customerIds: ["order-1"],
      }),
    );
  }, 60_000);

  it("truncates the paginated envelope as UTF-8 bytes through Specmatic", async () => {
    const response = await fetch(`${app.stubUrl}/orders`, {
      headers: { "x-potemkin-body-truncate": "64" },
    });
    expect(response.status).toBe(200);
    const wire = await response.text();
    expect(Buffer.byteLength(wire, "utf8")).toBeLessThanOrEqual(64);
    expect(wire).not.toContain("\uFFFD");
  }, 60_000);

  it("continues from the returned cursor through Specmatic", async () => {
    const first = await fetch(`${app.stubUrl}/orders`);
    expect(first.status).toBe(200);
    const firstBody = (await first.json()) as OrderPage;
    expect(firstBody.nextCursor).toEqual(expect.any(String));

    const second = await fetch(
      `${app.stubUrl}/orders?cursor=${encodeURIComponent(firstBody.nextCursor!)}`,
    );
    expect(second.status).toBe(200);
    await expect(second.json()).resolves.toEqual({
      _links: { self: { href: "/orders" } },
      items: [
        { id: "order-3", score: 2, active: true },
        { id: "order-1", score: 1, active: true },
      ],
      totalCount: 4,
      offset: 2,
      limit: 2,
      hasMore: false,
    });
  }, 60_000);

  it("applies a query-field predicate from the URL through Specmatic", async () => {
    const response = await fetch(`${app.stubUrl}/orders?threshold=3`);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      _links: { self: { href: "/orders" } },
      items: [
        { id: "order-deleted", score: 4, active: true, _deleted: true },
        {
          id: "order-2",
          score: 3,
          active: true,
          customerIds: ["order-1"],
          _customerIds: [{ id: "order-1", score: 1, active: true }],
        },
      ],
      totalCount: 2,
      offset: 0,
      limit: 2,
      hasMore: false,
    });
  }, 60_000);

  it("keeps the declarative include-deleted policy active through Specmatic", async () => {
    const response = await fetch(`${app.stubUrl}/orders?includeDeleted=false`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as OrderPage;
    expect(body).toMatchObject({
      items: [
        { id: "order-deleted", score: 4, active: true },
        { id: "order-2", score: 3, active: true },
      ],
      totalCount: 4,
      offset: 0,
      limit: 2,
      hasMore: true,
    });
  }, 60_000);

  it("combines pagination and fixed HATEOAS across HAL and JSON:API responses", async () => {
    const hal = await fetch(`${app.stubUrl}/orders`, {
      headers: { "x-potemkin-response-format": "hal" },
    });
    expect(hal.status).toBe(200);
    await expect(hal.json()).resolves.toMatchObject({
      _embedded: {
        items: [
          { id: "order-deleted", score: 4, active: true },
          { id: "order-2", score: 3, active: true },
        ],
      },
      _links: { self: { href: "/orders" } },
      totalCount: 4,
      offset: 0,
      limit: 2,
      hasMore: true,
      nextCursor: expect.any(String),
    });
    expect(hal.headers.get("x-potemkin-response-format")).toBe("hal");

    const jsonApi = await fetch(`${app.stubUrl}/orders`, {
      headers: { "x-potemkin-response-format": "jsonapi" },
    });
    expect(jsonApi.status).toBe(200);
    await expect(jsonApi.json()).resolves.toEqual({
      data: [
        {
          type: "Order",
          id: "order-deleted",
          attributes: { score: 4, active: true, _deleted: true },
        },
        {
          type: "Order",
          id: "order-2",
          attributes: {
            score: 3,
            active: true,
            customerIds: ["order-1"],
            _customerIds: [{ id: "order-1", score: 1, active: true }],
          },
        },
      ],
      meta: {
        totalCount: 4,
        offset: 0,
        limit: 2,
        hasMore: true,
      },
    });
    expect(jsonApi.headers.get("x-potemkin-response-format")).toBe("jsonapi");

    const linkHeader = await fetch(`${app.stubUrl}/orders`, {
      headers: {
        "x-potemkin-pagination-style": "link-header",
        "x-potemkin-response-format": "hal",
      },
    });
    expect(linkHeader.status).toBe(200);
    await expect(linkHeader.json()).resolves.toMatchObject({
      _embedded: {
        items: [
          { id: "order-deleted", score: 4, active: true },
          { id: "order-2", score: 3, active: true },
        ],
      },
      _links: { self: { href: "/orders" } },
    });
    expect(linkHeader.headers.get("x-total-count")).toBe("4");
    expect(linkHeader.headers.get("link")).toContain('rel="next"');
  }, 60_000);

  it("combines paginated HAL link headers with request masking", async () => {
    const response = await fetch(`${app.stubUrl}/orders?threshold=3`, {
      headers: {
        "x-potemkin-response-format": "hal",
        "x-potemkin-pagination-style": "link-header",
        "x-potemkin-mask": "score",
      },
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      _embedded: {
        items: [
          { id: "order-deleted", score: "[MASKED]", active: true },
          { id: "order-2", score: "[MASKED]", active: true },
        ],
      },
      _links: { self: { href: "/orders" } },
    });
    expect(response.headers.get("x-total-count")).toBe("2");
    expect(response.headers.get("link")).toBeNull();
  }, 60_000);

  it.each(RESPONSE_FORMAT_MATRIX)(
    "preserves the $format response shape with $pagination pagination and masking",
    async ({ format, pagination }: { format: ResponseFormat; pagination: PaginationStyle }) => {
      const response = await fetch(`${app.stubUrl}/orders`, {
        headers: {
          "x-potemkin-response-format": format,
          "x-potemkin-pagination-style": pagination,
          "x-potemkin-mask": "score",
        },
      });

      expect(response.status).toBe(200);
      expect(response.headers.get("x-potemkin-response-format")).toBe(format);
      const body = (await response.json()) as Record<string, unknown>;
      const serialized = JSON.stringify(body);
      expect(serialized).toContain("[MASKED]");
      expect(serialized).not.toContain('"score":4');

      if (pagination === "link-header") {
        expect(response.headers.get("x-total-count")).toBe("4");
        expect(response.headers.get("link")).toContain('rel="next"');
      } else {
        expect(response.headers.get("x-total-count")).toBeNull();
        expect(response.headers.get("link")).toBeNull();
      }

      if (format === "plain") {
        if (pagination === "envelope") {
          expect(Array.isArray(body.items)).toBe(true);
          expect(body).toMatchObject({ totalCount: 4, offset: 0, limit: 2, hasMore: true });
        } else {
          expect(Array.isArray(body)).toBe(true);
          expect(body as unknown as readonly unknown[]).toHaveLength(2);
        }
        return;
      }

      if (format === "hal") {
        const embedded = body._embedded as { items?: unknown } | undefined;
        expect(embedded).toBeDefined();
        expect(Array.isArray(embedded?.items)).toBe(true);
        expect(body._links).toEqual({ self: { href: "/orders" } });
        if (pagination === "envelope") {
          expect(body).toMatchObject({ totalCount: 4, offset: 0, limit: 2, hasMore: true });
        } else {
          expect(body).not.toHaveProperty("totalCount");
        }
        return;
      }

      expect(Array.isArray(body.data)).toBe(true);
      if (pagination === "envelope") {
        expect(body.meta).toEqual({ totalCount: 4, offset: 0, limit: 2, hasMore: true });
      } else {
        expect(body).not.toHaveProperty("meta");
      }
    },
    60_000,
  );

  it("returns the configured targeted fallback through Specmatic", async () => {
    const response = await fetch(`${app.stubUrl}/orders/missing`);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ code: "ORDER_NOT_FOUND" });
  }, 60_000);
});

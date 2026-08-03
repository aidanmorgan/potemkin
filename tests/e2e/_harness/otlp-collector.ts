import * as http from "node:http";

export interface OtlpAttributeValue {
  readonly stringValue?: string;
  readonly boolValue?: boolean;
  readonly intValue?: string | number;
  readonly doubleValue?: number;
}

export interface OtlpAttribute {
  readonly key: string;
  readonly value?: OtlpAttributeValue;
}

export interface OtlpSpan {
  readonly name?: string;
  readonly attributes?: readonly OtlpAttribute[];
}

export interface OtlpTraceExport {
  readonly resourceSpans?: readonly {
    readonly resource?: {
      readonly attributes?: readonly OtlpAttribute[];
    };
    readonly scopeSpans?: readonly {
      readonly spans?: readonly OtlpSpan[];
    }[];
  }[];
}

export interface OtlpMetricDataPoint {
  readonly asInt?: string | number;
  readonly asDouble?: number;
  readonly value?: number;
  readonly attributes?: readonly OtlpAttribute[];
}

export interface OtlpMetricExport {
  readonly resourceMetrics?: readonly {
    readonly scopeMetrics?: readonly {
      readonly metrics?: readonly {
        readonly name?: string;
        readonly sum?: {
          readonly dataPoints?: readonly OtlpMetricDataPoint[];
        };
        readonly gauge?: {
          readonly dataPoints?: readonly OtlpMetricDataPoint[];
        };
      }[];
    }[];
  }[];
}

export interface OtlpCollector {
  readonly url: string;
  readonly traces: OtlpTraceExport[];
  readonly metrics: OtlpMetricExport[];
  close(): Promise<void>;
}

export interface OtlpCollectorOptions {
  readonly onTraceExport?: (traceExport: OtlpTraceExport) => void;
  readonly onMetricExport?: (metricExport: OtlpMetricExport) => void;
}

function closeServer(server: http.Server): Promise<void> {
  return new Promise<void>((resolve) => {
    server.closeAllConnections?.();
    server.close(() => resolve());
  });
}

function readBody(request: http.IncomingMessage): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => {
      body += chunk;
    });
    request.on("end", () => resolve(body));
    request.on("error", reject);
  });
}

/** A loopback-only OTLP/HTTP JSON collector used by real E2E assertions. */
export async function startOtlpCollector(
  options: OtlpCollectorOptions = {},
): Promise<OtlpCollector> {
  const traces: OtlpTraceExport[] = [];
  const metrics: OtlpMetricExport[] = [];
  const server = http.createServer(async (request, response) => {
    if (request.method !== "POST") {
      response.statusCode = 405;
      response.end();
      return;
    }
    const body = await readBody(request);
    if (request.url === "/v1/traces") {
      try {
        const traceExport = JSON.parse(body) as OtlpTraceExport;
        traces.push(traceExport);
        options.onTraceExport?.(traceExport);
      } catch {
        response.statusCode = 400;
        response.end();
        return;
      }
    }
    if (request.url === "/v1/metrics") {
      try {
        const metricExport = JSON.parse(body) as OtlpMetricExport;
        metrics.push(metricExport);
        options.onMetricExport?.(metricExport);
      } catch {
        response.statusCode = 400;
        response.end();
        return;
      }
    }
    if (request.url !== "/v1/traces" && request.url !== "/v1/metrics") {
      response.statusCode = 404;
      response.end();
      return;
    }
    response.statusCode = 200;
    response.setHeader("content-type", "application/json");
    response.end("{}");
  });

  await new Promise<void>((resolve, reject) => {
    server.listen(0, "127.0.0.1", () => resolve());
    server.once("error", reject);
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    await closeServer(server);
    throw new Error("OTLP collector did not expose a TCP address");
  }

  return {
    url: `http://127.0.0.1:${address.port}`,
    traces,
    metrics,
    close: () => closeServer(server),
  };
}

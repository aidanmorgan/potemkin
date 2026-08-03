import { getAllowedOrigin, isOriginAdmitted } from "../../../src/http/cors";

describe("injected CORS origin policy", () => {
  it("reflects an admitted origin without process-global configuration", () => {
    const allowed = ["https://client.example", "https://admin.example"] as const;

    expect(isOriginAdmitted("https://client.example", allowed)).toBe(true);
    expect(getAllowedOrigin("https://client.example", allowed)).toBe("https://client.example");
    expect(isOriginAdmitted("https://other.example", allowed)).toBe(false);
    expect(getAllowedOrigin("https://other.example", allowed)).toBe("https://client.example");
  });

  it("keeps the local default explicit and deterministic", () => {
    expect(isOriginAdmitted("https://client.example", "*")).toBe(true);
    expect(getAllowedOrigin("https://client.example", "*")).toBe("*");
  });
});

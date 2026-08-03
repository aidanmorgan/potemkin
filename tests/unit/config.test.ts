import {
  ConfigurationError,
  defineOverlayConfig,
  definePotemkinConfig,
  defineSeedConfig,
  isConfigurationError,
} from "../../src/index";
import { createDefaultRuntimeHost } from "../../src/runtime/host";
import { loadOpenApi } from "../../src/contract/loader";
import { bootRuntime } from "../../src/runtime/system";

describe("TypeScript configuration diagnostics", () => {
  it.each([
    ["version", () => definePotemkinConfig({ version: 0, specmatic: "spec", modules: ["dsl"] })],
    ["specmatic", () => definePotemkinConfig({ version: 1, specmatic: "", modules: ["dsl"] })],
    ["modules", () => definePotemkinConfig({ version: 1, specmatic: "spec", modules: [] })],
  ])("reports invalid %s with a typed diagnostic", (_field, action) => {
    try {
      action();
      throw new Error("expected configuration validation to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigurationError);
      expect((error as ConfigurationError).code).toBe("CONFIG_INVALID");
      expect((error as ConfigurationError).details).toEqual({ field: _field });
    }
  });

  it("reports invalid overlay and seed shapes with field paths", () => {
    expect(() => definePotemkinConfig(null as never)).toThrow(ConfigurationError);
    expect(() => defineOverlayConfig(null as never)).toThrow(ConfigurationError);
    expect(() => defineSeedConfig(null as never)).toThrow(ConfigurationError);
    expect(() => defineOverlayConfig({ patches: "invalid" as never })).toThrow(ConfigurationError);
    expect(() => defineSeedConfig({ request: {} } as never)).toThrow(ConfigurationError);
    try {
      defineSeedConfig({ request: {} } as never);
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigurationError);
      expect(isConfigurationError(error)).toBe(true);
      expect((error as ConfigurationError).details).toEqual({ field: "seed.request" });
    }
  });

  it("keeps runtime configuration failures on the typed error surface", async () => {
    await expect(
      bootRuntime({
        host: createDefaultRuntimeHost(),
        openapi: await loadOpenApi(
          'openapi: "3.0.3"\ninfo: {title: test, version: "1"}\npaths: {}\n',
        ),
      } as never),
    ).rejects.toBeInstanceOf(ConfigurationError);
  });
});

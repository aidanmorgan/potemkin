/**
 * Forward-block wiring for the e2e harness.
 *
 * The Specmatic plugin reads its config (engine URL, control port, auth, and the
 * four forward-blocks `seeds`/`workflow`/`overlay`/`governance`) from the
 * potemkin.yml at `POTEMKIN_CONFIG_PATH`. The harness writes a *synthetic*
 * potemkin.yml carrying the dynamic ports; this module enriches that document
 * with the fixture's auth + forward-blocks so the plugin exercises them through
 * the stub, exactly as production would.
 *
 * It also derives a Specmatic OpenAPI **overlay file** from the fixture's
 * `overlay.patches`. Specmatic loads the overlay at HttpStub construction from the
 * path in the `overlayFilePath` env var (verified against specmatic-2.46.2:
 * `SpecmaticConfig.getStubOverlayFilePath` → `readEnvVarOrProperty("overlayFilePath")`).
 * The launcher sets that env var so the served spec reflects the overlay.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as yaml from "js-yaml";
import { translateOverlayPatches } from "../../../src/dsl/forwardBlocks";
import { resolveFixtureDir } from "../../fixtures/index";
import type { Patch } from "../../../src/model/patches";

export interface FixtureForwardBlocks {
  /** YAML snippet (top-level keys) to splice into the plugin's potemkin.yml. */
  readonly pluginConfigYaml: string;
  /** Absolute path to the generated Specmatic overlay file, or undefined when no overlay. */
  readonly overlayFilePath?: string;
}

export interface SharedForwardBlocks extends FixtureForwardBlocks {
  readonly fixtureNames: readonly string[];
}

interface OverlayBlock {
  readonly patches?: readonly Patch[];
}

/**
 * Build the immutable plugin-side expectations for the one Specmatic JVM used
 * by the E2E run. Node configuration is reloaded per fixture; these contract
 * expectations are therefore the union of every fixture's seed/workflow,
 * overlay, and governance declarations.
 */
export function buildSharedForwardBlocks(fixtureNames: readonly string[]): SharedForwardBlocks {
  const merged: Record<string, unknown> = {};
  const seeds: unknown[] = [];
  const workflowIds: Record<string, unknown> = {};
  const overlayPatches: Patch[] = [];
  const governance: Record<string, unknown> = {};

  for (const fixtureName of fixtureNames) {
    const fixtureDir = resolveFixtureDir(fixtureName);
    const potemkinDoc = readYaml(path.join(fixtureDir, "potemkin.yml"));
    const fixtureSeeds = potemkinDoc["seeds"];
    if (Array.isArray(fixtureSeeds)) seeds.push(...fixtureSeeds);
    const fixtureWorkflow = asRecord(potemkinDoc["workflow"]);
    const fixtureIds = asRecord(fixtureWorkflow["ids"]);
    Object.assign(workflowIds, fixtureIds);
    const fixtureOverlay = asRecord(potemkinDoc["overlay"]);
    const fixturePatches = fixtureOverlay["patches"];
    if (Array.isArray(fixturePatches)) overlayPatches.push(...(fixturePatches as Patch[]));
    const fixtureGovernance = asRecord(potemkinDoc["governance"]);
    Object.assign(governance, fixtureGovernance);

    // Auth is deliberately resolved by the reloaded Node runtime. A single
    // JVM cannot hold one static JWT/session policy while the Node config moves
    // between fixtures.
  }

  if (seeds.length > 0) merged["seeds"] = seeds;
  if (Object.keys(workflowIds).length > 0) merged["workflow"] = { ids: workflowIds };
  if (overlayPatches.length > 0) merged["overlay"] = { patches: overlayPatches };
  if (Object.keys(governance).length > 0) merged["governance"] = governance;

  const overlayFilePath = writeOverlayFile("shared", { patches: overlayPatches });
  const pluginConfigYaml = Object.keys(merged).length === 0 ? "" : yaml.dump(merged);
  return {
    fixtureNames: [...fixtureNames],
    pluginConfigYaml,
    ...(overlayFilePath === undefined ? {} : { overlayFilePath }),
  };
}

function readYaml(p: string): Record<string, unknown> {
  if (!fs.existsSync(p)) return {};
  const doc = yaml.load(fs.readFileSync(p, "utf8"));
  return doc !== null && typeof doc === "object" ? (doc as Record<string, unknown>) : {};
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/**
 * Translate `overlay.patches` into a Specmatic overlay document and write it to a
 * temp file. Returns the file path, or undefined when there are no patches.
 */
function writeOverlayFile(
  fixtureName: string,
  overlay: OverlayBlock | undefined,
): string | undefined {
  const patches = overlay?.patches;
  if (!patches || patches.length === 0) return undefined;

  const actions = translateOverlayPatches(patches).map((a) =>
    a.remove === true ? { target: a.target, remove: true } : { target: a.target, update: a.update },
  );
  const overlayDoc = { overlay: "1.0.0", actions };

  const filePath = path.join(os.tmpdir(), `potemkin-overlay-${fixtureName}-${Date.now()}.yaml`);
  fs.writeFileSync(filePath, yaml.dump(overlayDoc), "utf8");
  return filePath;
}

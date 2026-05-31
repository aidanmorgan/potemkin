/**
 * Forward-block wiring for the e2e harness.
 *
 * The Specmatic plugin reads its config (engine URL, control port, auth, and the
 * four forward-blocks `seeds`/`workflow`/`overlay`/`governance`) from the
 * potemkin.yaml at `POTEMKIN_CONFIG_PATH`. The harness writes a *synthetic*
 * potemkin.yaml carrying the dynamic ports; this module enriches that document
 * with the fixture's auth + forward-blocks so the plugin exercises them through
 * the stub, exactly as production would.
 *
 * It also derives a Specmatic OpenAPI **overlay file** from the fixture's
 * `overlay.patches`. Specmatic loads the overlay at HttpStub construction from the
 * path in the `overlayFilePath` env var (verified against specmatic-2.46.2:
 * `SpecmaticConfig.getStubOverlayFilePath` → `readEnvVarOrProperty("overlayFilePath")`).
 * The launcher sets that env var so the served spec reflects the overlay.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as yaml from 'js-yaml';
import { translateOverlayPatches } from '../../../src/dsl/forwardBlocks';
import type { Patch } from '../../../src/dsl/patches';

export interface FixtureForwardBlocks {
  /** YAML snippet (top-level keys) to splice into the plugin's potemkin.yaml. */
  readonly pluginConfigYaml: string;
  /** Absolute path to the generated Specmatic overlay file, or undefined when no overlay. */
  readonly overlayFilePath?: string;
}

interface OverlayBlock {
  readonly patches?: readonly Patch[];
}

/**
 * Read a fixture's auth + forward-blocks and produce (a) the YAML to merge into
 * the plugin potemkin.yaml and (b) a written Specmatic overlay file when the
 * fixture declares `overlay.patches`. When the fixture has none, returns an empty
 * snippet and no overlay path.
 */
export function buildFixtureForwardBlocks(fixtureName: string | undefined): FixtureForwardBlocks {
  if (!fixtureName) return { pluginConfigYaml: '' };

  const fixtureDir = path.resolve(__dirname, '..', '..', 'fixtures', fixtureName);
  const potemkinPath = path.join(fixtureDir, 'potemkin.yaml');
  const globalPath = path.join(fixtureDir, 'dsl', 'global.yaml');

  const potemkinDoc = readYaml(potemkinPath);
  const globalDoc = readYaml(globalPath);

  // The plugin reads forward-blocks at the document root and `auth` under either
  // `plugin.auth` or the root. The fixture authors auth in dsl/global.yaml (the
  // engine's config), so we surface it to the plugin at the root here.
  const merged: Record<string, unknown> = {};
  for (const key of ['seeds', 'workflow', 'overlay', 'governance'] as const) {
    if (potemkinDoc[key] !== undefined) merged[key] = potemkinDoc[key];
  }
  if (globalDoc['auth'] !== undefined) merged['auth'] = globalDoc['auth'];

  const overlayFilePath = writeOverlayFile(fixtureName, potemkinDoc['overlay'] as OverlayBlock | undefined);

  const pluginConfigYaml = Object.keys(merged).length === 0 ? '' : yaml.dump(merged);
  return overlayFilePath ? { pluginConfigYaml, overlayFilePath } : { pluginConfigYaml };
}

function readYaml(p: string): Record<string, unknown> {
  if (!fs.existsSync(p)) return {};
  const doc = yaml.load(fs.readFileSync(p, 'utf8'));
  return doc !== null && typeof doc === 'object' ? (doc as Record<string, unknown>) : {};
}

/**
 * Translate `overlay.patches` into a Specmatic overlay document and write it to a
 * temp file. Returns the file path, or undefined when there are no patches.
 */
function writeOverlayFile(fixtureName: string, overlay: OverlayBlock | undefined): string | undefined {
  const patches = overlay?.patches;
  if (!patches || patches.length === 0) return undefined;

  const actions = translateOverlayPatches(patches).map((a) =>
    a.remove === true ? { target: a.target, remove: true } : { target: a.target, update: a.update },
  );
  const overlayDoc = { overlay: '1.0.0', actions };

  const filePath = path.join(os.tmpdir(), `potemkin-overlay-${fixtureName}-${Date.now()}.yaml`);
  fs.writeFileSync(filePath, yaml.dump(overlayDoc), 'utf8');
  return filePath;
}

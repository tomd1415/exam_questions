/**
 * Snapshots the widget registry to docs/widgets.schema.json.
 *
 * The registry in src/lib/widgets.ts is the source of truth; this script
 * just serialises `widgetRegistryDocument()` to disk so external tools
 * (the question wizard, future MCP servers, integration partners) can
 * discover question types and their part_config shapes without booting
 * the Fastify app.
 *
 * Run via `npm run gen:widgets-schema`. CI enforces freshness with
 * tests/unit/widgets-schema-freshness.test.ts — if the committed file
 * drifts from the registry, the test fails and points at this script.
 */

import { writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { widgetRegistryDocument } from '../src/lib/widgets.js';

const here = dirname(fileURLToPath(import.meta.url));
const target = resolve(here, '..', 'docs', 'widgets.schema.json');

const json = `${JSON.stringify(widgetRegistryDocument(), null, 2)}\n`;
writeFileSync(target, json, 'utf8');

process.stdout.write(`Wrote ${target}\n`);

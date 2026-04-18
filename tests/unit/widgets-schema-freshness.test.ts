// Freshness check: the committed docs/widgets.schema.json must match
// what `widgetRegistryDocument()` currently produces. If this fails,
// run `npm run gen:widgets-schema` and commit the regenerated file.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { widgetRegistryDocument } from '../../src/lib/widgets.js';

describe('docs/widgets.schema.json', () => {
  it('is up to date with the live widget registry', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const target = resolve(here, '..', '..', 'docs', 'widgets.schema.json');
    const onDisk = readFileSync(target, 'utf8');
    const expected = `${JSON.stringify(widgetRegistryDocument(), null, 2)}\n`;
    expect(onDisk).toBe(expected);
  });
});

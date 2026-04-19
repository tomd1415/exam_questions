import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EXPECTED_RESPONSE_TYPES } from '../../src/lib/question-invariants.js';
import { widgetDescriptors, widgetThumbUrl } from '../../src/lib/widgets.js';

const here = dirname(fileURLToPath(import.meta.url));
const STATIC_DIR = resolve(here, '..', '..', 'src', 'static');

describe('widget thumbnails', () => {
  it('every registered response type has a thumbnail file under /static/widget_thumbs/', () => {
    for (const t of EXPECTED_RESPONSE_TYPES) {
      const path = resolve(STATIC_DIR, 'widget_thumbs', `${t}.svg`);
      expect(existsSync(path), `missing thumbnail for ${t}`).toBe(true);
      const svg = readFileSync(path, 'utf8');
      expect(svg).toContain('<svg');
      expect(svg).toContain('currentColor');
    }
  });

  it('widgetThumbUrl is deterministic and matches the descriptor field', () => {
    for (const d of widgetDescriptors()) {
      expect(d.thumbUrl).toBe(`/static/widget_thumbs/${d.type}.svg`);
      expect(d.thumbUrl).toBe(widgetThumbUrl(d.type));
    }
  });
});

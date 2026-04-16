import type { LightMyRequestResponse } from 'fastify';

// Map cookie name -> raw value as it appears in Set-Cookie. For signed
// cookies the value INCLUDES the .signature suffix; we keep it intact so
// the next request round-trips exactly what the server sent.
export type CookieJar = Map<string, string>;

export function newJar(): CookieJar {
  return new Map();
}

export function updateJar(jar: CookieJar, response: LightMyRequestResponse): void {
  for (const c of response.cookies) {
    if (c.value === '' || (c.expires instanceof Date && c.expires.getTime() < Date.now())) {
      jar.delete(c.name);
      continue;
    }
    jar.set(c.name, c.value);
  }
}

export function cookieHeader(jar: CookieJar): string {
  return Array.from(jar.entries())
    .map(([k, v]) => `${k}=${v}`)
    .join('; ');
}

const CSRF_INPUT_RE = /name="_csrf"\s+value="([^"]+)"/;

export function extractCsrfToken(html: string): string {
  const match = CSRF_INPUT_RE.exec(html);
  if (!match) {
    throw new Error('No _csrf hidden input found in HTML');
  }
  return match[1]!;
}

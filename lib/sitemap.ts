import { XMLParser } from 'fast-xml-parser';

interface SitemapUrl {
  loc: string;
  [key: string]: string | undefined;
}

export function parseSitemapUrls(xmlData: string, baseUrl: string): string[] {
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
  });
  const result = parser.parse(xmlData);
  const raw = result.urlset?.url;
  const entries: Array<SitemapUrl | string> = Array.isArray(raw) ? raw : raw ? [raw] : [];

  return entries
    .map((url) => toAbsoluteUrl(typeof url === 'string' ? url : url.loc, baseUrl))
    .filter((url): url is string => url !== null);
}

export function toAbsoluteUrl(loc: unknown, baseUrl: string): string | null {
  const raw = typeof loc === 'string' ? loc.trim() : String(loc ?? '').trim();
  if (!raw) return null;

  try {
    return new URL(raw, baseUrl).toString();
  } catch {
    return null;
  }
}

export function sampleUrls(urls: string[], count: number): string[] {
  const unique = [...new Set(urls)];
  const n = Math.min(count, unique.length);
  const copy = [...unique];

  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }

  return copy.slice(0, n);
}

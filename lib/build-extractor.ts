import axios from 'axios';
import * as cheerio from 'cheerio';
import type { CheerioAPI, Element } from 'cheerio';
import vm from 'node:vm';

export interface FetchedPage {
  url: string;
  html: string;
}

export interface FetchFailure {
  url: string;
  error: string;
}

export interface ExtractionPreview {
  url: string;
  result?: unknown;
  error?: string;
}

const UTILITY_CLASS =
  /^(sm:|md:|lg:|xl:|2xl:|hover:|focus:|active:|group-|peer-|w-|h-|min-|max-|p[trblxy]?-|m[trblxy]?-|gap-|flex|grid|block|inline|hidden|absolute|relative|sticky|overflow|text-|bg-|font-|leading-|tracking-|rounded|border|shadow|col-|row-|items-|justify-|self-|place-|z-|opacity|transition|duration|ease-|cursor-|object-|pointer-|sr-only|container|from-|to-|via-)/;

const http = axios.create({
  timeout: 15000,
  maxRedirects: 5,
  responseType: 'text',
  validateStatus: (status) => status >= 200 && status < 400,
  headers: {
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'User-Agent':
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  },
});

export async function fetchPages(urls: string[]): Promise<{
  pages: FetchedPage[];
  failures: FetchFailure[];
}> {
  const pages: FetchedPage[] = [];
  const failures: FetchFailure[] = [];
  const batchSize = 5;

  for (let i = 0; i < urls.length; i += batchSize) {
    const batch = urls.slice(i, i + batchSize);
    const results = await Promise.all(
      batch.map(async (url) => {
        try {
          const response = await http.get<string>(url);
          const html = typeof response.data === 'string' ? response.data : String(response.data);
          if (!html.trim()) {
            return { url, error: 'Empty response body' };
          }
          return { url: response.request?.res?.responseUrl || url, html };
        } catch (error) {
          const message = axios.isAxiosError(error)
            ? error.message
            : error instanceof Error
              ? error.message
              : 'Unknown fetch error';
          return { url, error: message };
        }
      })
    );

    for (const result of results) {
      if ('html' in result && result.html) {
        pages.push({ url: result.url, html: result.html });
      } else if ('error' in result) {
        failures.push({ url: result.url, error: result.error });
      }
    }
  }

  return { pages, failures };
}

export function buildExtractorFromPages(pages: FetchedPage[]): string {
  const origin = new URL(pages[0].url).origin;
  const nameSelector = voteSelector(pages, collectNameSelectors);
  const descSelectors = voteSelectors(pages, collectDescriptionSelectors, 2);
  const imageSelector = voteSelector(pages, collectImageSelectors);
  const defaultImage = mostCommonOgImage(pages) || `${origin}/favicon.ico`;

  return assembleExtractor({
    origin,
    nameSelector,
    descSelectors,
    imageSelector,
    defaultImage,
  });
}

export function previewExtractor(code: string, pages: FetchedPage[]): ExtractionPreview[] {
  return pages.map((page) => {
    try {
      const $ = cheerio.load(page.html);
      const sandbox: Record<string, unknown> = {
        $: $,
        request: { url: page.url },
        response: { body: $, url: page.url },
      };
      vm.createContext(sandbox);
      const script = new vm.Script(`${code}\nthis.__result = extract(request, response);`);
      script.runInContext(sandbox, { timeout: 3000 });
      return { url: page.url, result: sandbox.__result };
    } catch (error) {
      return {
        url: page.url,
        error: error instanceof Error ? error.message : 'Extractor failed',
      };
    }
  });
}

function collectNameSelectors($: CheerioAPI): string[] {
  const selectors: string[] = [];
  $('h1').each((_, el) => {
    const selector = distinctiveSelector($, el);
    const text = $(el).text().trim();
    if (selector && text) selectors.push(selector);
  });
  return selectors;
}

function collectDescriptionSelectors($: CheerioAPI): string[] {
  const selectors: string[] = [];
  const candidates = $('article, main, [class*="content"], [class*="description"], [class*="body"], .main, .title-text');
  candidates.each((_, el) => {
    const tag = el.tagName?.toLowerCase();
    if (tag === 'main' || tag === 'article') return;
    const text = $(el).text().replace(/\s+/g, ' ').trim();
    if (text.length < 40 || text.length > 4000) return;
    const selector = distinctiveSelector($, el);
    if (selector) selectors.push(selector);
  });
  return selectors;
}

function collectImageSelectors($: CheerioAPI): string[] {
  const selectors: string[] = [];
  $('main img, article img, .hero img, header img, img').each((_, el) => {
    const src = $(el).attr('src') || $(el).attr('data-src') || '';
    if (!src || src.startsWith('data:')) return;
    const classes = ($(el).attr('class') || '') + ' ' + src;
    if (/pixel|spacer|1x1|tracking|logo|icon|sprite|favicon/i.test(classes)) return;
    const selector = distinctiveSelector($, el);
    if (selector) selectors.push(selector);
  });
  return selectors;
}

function voteSelector(pages: FetchedPage[], collect: ($: CheerioAPI) => string[]): string | null {
  return voteSelectors(pages, collect, 1)[0] ?? null;
}

function voteSelectors(
  pages: FetchedPage[],
  collect: ($: CheerioAPI) => string[],
  limit: number
): string[] {
  const counts = new Map<string, number>();
  for (const page of pages) {
    const $ = cheerio.load(page.html);
    const unique = [...new Set(collect($))];
    for (const selector of unique) {
      counts.set(selector, (counts.get(selector) || 0) + 1);
    }
  }

  const minHits = Math.max(1, Math.ceil(pages.length * 0.4));
  return [...counts.entries()]
    .filter(([, hits]) => hits >= minHits)
    .sort((a, b) => b[1] - a[1] || specificity(b[0]) - specificity(a[0]) || a[0].length - b[0].length)
    .slice(0, limit)
    .map(([selector]) => selector);
}

function specificity(selector: string): number {
  return (selector.match(/[.#]/g) || []).length;
}

function mostCommonOgImage(pages: FetchedPage[]): string | null {
  const counts = new Map<string, number>();
  for (const page of pages) {
    const $ = cheerio.load(page.html);
    const image = $('meta[property="og:image"]').attr('content')?.trim();
    if (!image) continue;
    counts.set(image, (counts.get(image) || 0) + 1);
  }
  const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  return ranked[0]?.[0] ?? null;
}

function distinctiveSelector($: CheerioAPI, el: Element, maxDepth = 4): string | null {
  const parts: string[] = [];
  let current: Element | null = el;

  for (let i = 0; i < maxDepth && current; i++) {
    const tag = current.tagName?.toLowerCase();
    if (!tag || tag === 'html' || tag === 'body') break;

    const id = $(current).attr('id');
    if (id && !/^\d+$/.test(id) && !/\d{4,}/.test(id)) {
      parts.unshift(`#${cssEscape(id)}`);
      break;
    }

    const classes = meaningfulClasses($(current).attr('class'));
    if (classes.length) {
      parts.unshift(`${tag}.${classes.map(cssEscape).join('.')}`);
    } else {
      parts.unshift(tag);
    }

    const parent = current.parent;
    current = parent && 'tagName' in parent ? (parent as Element) : null;
  }

  return parts.length ? parts.join(' ') : null;
}

function meaningfulClasses(className: string | undefined): string[] {
  if (!className) return [];
  return className
    .split(/\s+/)
    .filter((cls) => cls && !UTILITY_CLASS.test(cls) && cls.length < 48)
    .slice(0, 2);
}

function cssEscape(value: string): string {
  return value.replace(/([!"#$%&'()*+,./:;<=>?@[\\\]^`{|}~])/g, '\\$1');
}

function jsString(value: string): string {
  return JSON.stringify(value);
}

function assembleExtractor({
  origin,
  nameSelector,
  descSelectors,
  imageSelector,
  defaultImage,
}: {
  origin: string;
  nameSelector: string | null;
  descSelectors: string[];
  imageSelector: string | null;
  defaultImage: string;
}): string {
  const desc1 = descSelectors[0] ? `$(${jsString(descSelectors[0])})` : '$("main, article").first()';
  const desc2 = descSelectors[1]
    ? `$(${jsString(descSelectors[1])})`
    : '$(\'meta[property="og:description"]\')';
  const imageLine = imageSelector
    ? `var image_url = $(${jsString(imageSelector)}).first().attr('src') || $(${jsString(imageSelector)}).first().attr('data-src');`
    : `var image_url = $('main img, article img, .hero img').first().attr('src');`;
  const nameLine = nameSelector
    ? `$(${jsString(nameSelector)}).first().text() || $('meta[name="searchtitle"]').attr('content')`
    : `$('meta[name="searchtitle"]').attr('content')`;

  return `/* eslint-disable @typescript-eslint/no-unused-vars */
// extractor function for use with an advanced JS document extractor
function extract(request, response) {
    $ = response.body;

    // extract the url of the page, preference to meta og:url, fallback to canonical URL
    var url = $('meta[property="og:url"]').attr('content') || $('link[rel="canonical"]').attr('href') || response.url;

    // regex pattern to capture first directory after the domain
    var regex = /^https?:\\/\\/[^\\/]+\\/([^?\\/#]+)\\//g;

    // extract page type by first matching the regex pattern, then prioritize meta og:type
    var p = regex.exec(url);
    var page_type = $('meta[property="og:type"]').attr('content') || (p != null ? p[1] : 'website_content');

    // normalize page type to title case
    page_type = titleCased(page_type);

    ${imageLine}
    if (image_url) {
      image_url = addBaseURL(image_url);
    }

    var desc, desc1 = ${desc1}, desc2 = ${desc2};
    if (desc1.length > 0 && desc1.text && desc1.text().trim()) {
      desc = concatText(desc1).replace(/\\s\\s+/g, ' ').trim();
    } else if (desc2.length > 0 && desc2.text && desc2.text().trim()) {
      desc = concatText(desc2).replace(/\\s\\s+/g, ' ').trim();
    } else {
      desc = null;
    }

    return [{
      'description': desc || $('meta[property="og:description"]').attr('content') || $('meta[name="description"]').attr('content') || $('p').first().text(),
      'name': ${nameLine} || $('meta[name="title"]').attr('content') || $('meta[property="og:title"]').attr('content') || $('title').text(),
      'type': page_type,
      'url': url,
      'image_url': image_url || $('meta[property="og:image"]').attr('content') || ${jsString(defaultImage)}
    }];
}

function titleCased(sentence) {
    return String(sentence || '')
    .replaceAll('-', ' ')
    .replaceAll('_', ' ')
    .split(' ')
    .map(word => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

function addBaseURL(url) {
    if (!url) return url;
    if (/^https?:\\/\\//i.test(url)) return url;
    if (url.startsWith('//')) return 'https:' + url;
    if (url.startsWith('/')) return ${jsString(origin)} + url;
    return ${jsString(origin)} + '/' + url;
}

function concatText(elements) {
    return elements.map((index, element) => $(element).text()).get().join(' ');
}
`;
}

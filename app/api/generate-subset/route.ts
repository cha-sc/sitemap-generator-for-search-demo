import { NextRequest, NextResponse } from 'next/server';
import { XMLParser, XMLBuilder } from 'fast-xml-parser';
import { promises as fs } from 'fs';
import path from 'path';

interface SitemapUrl {
  loc: string;
  [key: string]: string | undefined;
}

const SITEMAP_DIR = path.join(process.cwd(), 'public', 'generated_sitemaps');

// Relative <loc> values are resolved against the sitemap's own URL, so both
// root-relative ("/doctors/jane") and path-relative ("doctors/jane") entries
// end up on the domain the sitemap was fetched from.
function toAbsoluteUrl(loc: unknown, baseUrl: string): string | null {
  const raw = typeof loc === 'string' ? loc.trim() : String(loc ?? '').trim();
  if (!raw) return null;

  try {
    return new URL(raw, baseUrl).toString();
  } catch {
    return null;
  }
}

function determineContentType(url: string): string {
  const urlObj = new URL(url);
  const pathParts = urlObj.pathname.split('/').filter(Boolean);

  // Common content type indicators
  const contentTypeIndicators = ['locations', 'doctors', 'conditions-and-treatments', 'forms', 'about'];

  for (const part of pathParts) {
    const lowercasePart = part.toLowerCase();
    if (contentTypeIndicators.includes(lowercasePart)) {
      return lowercasePart;
    }
    // Check for plural forms
    if (lowercasePart.endsWith('s') && contentTypeIndicators.includes(lowercasePart.slice(0, -1))) {
      return lowercasePart;
    }
  }

  // If no specific content type is found, use the first part of the path
  return pathParts[0] || 'other';
}

export async function POST(request: NextRequest) {
  try {
    const { sitemapUrl, subsetSize } = await request.json();

    const response = await fetch(sitemapUrl);
    const xmlData = await response.text();

    const parser = new XMLParser({
      ignoreAttributes: false,
      attributeNamePrefix: "@_"
    });
    const result = parser.parse(xmlData);

    if (!result.urlset || !Array.isArray(result.urlset.url)) {
      throw new Error('Invalid sitemap format');
    }

    const baseUrl = response.url || sitemapUrl;
    const urls = result.urlset.url
      .map((url: SitemapUrl | string) => toAbsoluteUrl(typeof url === 'string' ? url : url.loc, baseUrl))
      .filter((url: string | null): url is string => url !== null);

    if (urls.length === 0) {
      throw new Error('Sitemap contained no usable URLs');
    }

    // Group URLs by content type
    const groupedUrls: { [key: string]: string[] } = {};
    urls.forEach((url: string) => {
      const contentType = determineContentType(url);
      if (!groupedUrls[contentType]) {
        groupedUrls[contentType] = [];
      }
      groupedUrls[contentType].push(url);
    });

    // Get subset for each group
    const subsetUrls: string[] = [];
    Object.entries(groupedUrls).forEach(([contentType, groupUrls]) => {
      const groupSubset = groupUrls.slice(0, subsetSize);
      subsetUrls.push(...groupSubset);
      console.log(`Content type: ${contentType}, Total URLs: ${groupUrls.length}, Subset size: ${groupSubset.length}`);
    });

    // Generate new sitemap XML
    const builder = new XMLBuilder({
      arrayNodeName: "url",
      format: true,
      ignoreAttributes: false,
      suppressEmptyNode: true
    });
    const newSitemap = builder.build({
      '?xml': { '@_version': '1.0', '@_encoding': 'UTF-8' },
      urlset: {
        '@_xmlns': 'http://www.sitemaps.org/schemas/sitemap/0.9',
        url: subsetUrls.map(url => ({ loc: url }))
      }
    });

    // Generate a unique ID for this sitemap
    const sitemapId = Date.now().toString();
    
    // Ensure the directory exists
    await fs.mkdir(SITEMAP_DIR, { recursive: true });

    // Write the sitemap to a file
    const filePath = path.join(SITEMAP_DIR, `${sitemapId}.xml`);
    await fs.writeFile(filePath, newSitemap);

    return NextResponse.json({ 
      success: true, 
      sitemapId,
      totalUrls: urls.length,
      subsetSize: subsetUrls.length
    });
  } catch (error) {
    console.error('Error processing sitemap:', error);
    return NextResponse.json({ error: 'Failed to process sitemap' }, { status: 500 });
  }
}
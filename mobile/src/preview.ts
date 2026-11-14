export type LinkInfo = { title?: string; image?: string };

const cache = new Map<string, LinkInfo | null>();

function decode(s: string) {
  return s.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>');
}

// Reads the Open Graph title and image of a web page, the same tags chat apps use for link previews.
function og(html: string, prop: string): string | undefined {
  const tag = html.match(new RegExp(`<meta[^>]+property=["']${prop}["'][^>]*>`, 'i'));
  if (!tag) return undefined;
  const content = tag[0].match(/content=["']([^"']*)["']/i);
  return content ? decode(content[1]) : undefined;
}

export async function linkInfo(url: string): Promise<LinkInfo | null> {
  if (cache.has(url)) return cache.get(url) ?? null;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  try {
    const res = await fetch(url, { headers: { 'User-Agent': 'facebookexternalhit/1.1' }, signal: ctrl.signal });
    const html = await res.text();
    const info = { title: og(html, 'og:title'), image: og(html, 'og:image') };
    cache.set(url, info);
    return info;
  } catch {
    cache.set(url, null);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

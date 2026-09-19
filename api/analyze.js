export const maxDuration = 10;

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  let query = '';
  if (req.method === 'GET') {
    query = req.query?.query;
  } else if (req.method === 'POST') {
    query = req.body?.query;
  }

  if (!query || typeof query !== 'string' || !query.trim()) {
    return res.status(200).json({ category: '미상' });
  }

  try {
    const searchUrl = `https://search.daum.net/search?w=tot&q=${encodeURIComponent(query.trim())}`;
    const response = await fetch(searchUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      }
    });

    if (!response.ok) {
      return res.status(200).json({ category: '미상' });
    }

    const html = await response.text();

    const match = html.match(/class="(?:txt_category|category|txt_sub)"[^>]*>([^<]+)<\//i) ||
                  html.match(/data-category="([^"]+)"/i);

    if (match && match[1] && match[1].trim()) {
      return res.status(200).json({ category: match[1].trim() });
    }

    return res.status(200).json({ category: '미상' });
  } catch (err) {
    return res.status(200).json({ category: '미상' });
  }
}

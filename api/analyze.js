export const maxDuration = 10;

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { query } = req.query;
  if (!query || !query.trim()) {
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

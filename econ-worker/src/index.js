const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

// ── In-memory cache (persists across requests within same isolate) ──
const memCache = {};
function memGet(key, ttlMs) {
  const entry = memCache[key];
  if (!entry) return null;
  if (Date.now() - entry.ts > ttlMs) return null;
  return entry.data;
}
function memSet(key, data) {
  memCache[key] = { data, ts: Date.now() };
}

// ── Yahoo Finance: stock quotes ──
async function fetchYahooQuotes(symbols) {
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/quote?symbols=${symbols.join(',')}`;
    const resp = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
    });
    if (!resp.ok) return {};
    const json = await resp.json();
    const results = {};
    (json.quoteResponse?.result || []).forEach(q => {
      results[q.symbol] = {
        price: q.regularMarketPrice,
        change: q.regularMarketChange,
        changePct: q.regularMarketChangePercent,
        prevClose: q.regularMarketPreviousClose,
        high: q.regularMarketDayHigh,
        low: q.regularMarketDayLow,
        name: q.shortName || q.symbol,
      };
    });
    return results;
  } catch (e) {
    console.error('Yahoo quotes error:', e);
    return {};
  }
}

// ── Yahoo Finance: chart data (monthly, 1 year) ──
async function fetchYahooChart(symbol) {
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?range=1y&interval=1mo`;
    const resp = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
    });
    if (!resp.ok) return null;
    const json = await resp.json();
    const result = json.chart?.result?.[0];
    if (!result) return null;
    const timestamps = result.timestamp || [];
    const closes = result.indicators?.quote?.[0]?.close || [];
    return timestamps.map((t, i) => ({
      label: new Date(t * 1000).toISOString().slice(0, 7),
      value: closes[i] ? parseFloat(closes[i].toFixed(2)) : null,
    })).filter(d => d.value !== null);
  } catch (e) {
    console.error('Yahoo chart error:', e);
    return null;
  }
}

// ── CoinGecko: Bitcoin price (no key needed) ──
async function fetchBitcoin() {
  try {
    const url = 'https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd&include_24hr_change=true';
    const resp = await fetch(url);
    if (!resp.ok) return null;
    const json = await resp.json();
    const btc = json.bitcoin;
    if (!btc) return null;
    return {
      price: btc.usd,
      change: null,
      changePct: btc.usd_24h_change ? parseFloat(btc.usd_24h_change.toFixed(2)) : null,
    };
  } catch (e) {
    console.error('BTC error:', e);
    return null;
  }
}

// ── FRED API ──
async function fredFetch(seriesId, limit, apiKey) {
  if (!apiKey) return [];
  try {
    const url = `https://api.stlouisfed.org/fred/series/observations?series_id=${seriesId}&api_key=${apiKey}&file_type=json&sort_order=desc&limit=${limit || 2}`;
    const resp = await fetch(url);
    if (!resp.ok) return [];
    const json = await resp.json();
    return (json.observations || []).filter(o => o.value !== '.');
  } catch (e) {
    console.error('FRED error:', seriesId, e);
    return [];
  }
}

async function buildCPIYoY(apiKey) {
  const obs = await fredFetch('CPIAUCSL', 14, apiKey);
  if (obs.length < 13) return null;
  const latest = parseFloat(obs[0].value);
  const yearAgo = parseFloat(obs[12].value);
  const yoy = ((latest - yearAgo) / yearAgo) * 100;
  const prev = parseFloat(obs[1].value);
  const prevBase = parseFloat(obs[13] ? obs[13].value : obs[12].value);
  const prevYoY = ((prev - prevBase) / prevBase) * 100;
  return { value: yoy.toFixed(1), prev: prevYoY.toFixed(1), date: obs[0].date };
}

// ── Build rates ──
async function buildRates(apiKey) {
  const series = [
    { id: 'FEDFUNDS',     name: 'Fed Funds Rate',    suffix: '%' },
    { id: 'UNRATE',       name: 'Unemployment Rate', suffix: '%' },
    { id: 'DGS10',        name: '10Y Treasury',      suffix: '%' },
    { id: 'MORTGAGE30US', name: '30Y Mortgage',      suffix: '%' },
    { id: 'GDP',          name: 'GDP Growth',        suffix: '%' },
  ];

  const [cpiResult, ...seriesResults] = await Promise.allSettled([
    buildCPIYoY(apiKey),
    ...series.map(s => fredFetch(s.id, 2, apiKey)),
  ]);

  const rates = [];

  if (cpiResult.status === 'fulfilled' && cpiResult.value) {
    const c = cpiResult.value;
    const dir = parseFloat(c.value) > parseFloat(c.prev) ? 'up' : parseFloat(c.value) < parseFloat(c.prev) ? 'down' : 'flat';
    rates.push({ name: 'CPI Inflation (YoY)', value: c.value, prev: c.prev + '%', direction: dir, date: c.date, suffix: '%' });
  }

  series.forEach((s, i) => {
    const res = seriesResults[i];
    if (res.status !== 'fulfilled' || !res.value || res.value.length < 1) return;
    const obs = res.value;
    const cur  = parseFloat(obs[0].value);
    const prev = obs.length > 1 ? parseFloat(obs[1].value) : cur;
    const dir  = cur > prev ? 'up' : cur < prev ? 'down' : 'flat';
    rates.push({ name: s.name, value: cur.toFixed(2), prev: prev.toFixed(2) + '%', direction: dir, date: obs[0].date, suffix: s.suffix });
  });

  return rates;
}

// ── Build markets ──
async function buildMarkets() {
  const [quotesResult, btcResult] = await Promise.allSettled([
    fetchYahooQuotes(['SPY', 'DIA', 'QQQ']),
    fetchBitcoin(),
  ]);

  const quotes = quotesResult.status === 'fulfilled' ? quotesResult.value : {};
  const btc    = btcResult.status === 'fulfilled'    ? btcResult.value    : null;

  const markets = [];
  if (quotes.SPY) markets.push({ name: 'S&P 500 (SPY)', ...quotes.SPY, isInt: false });
  if (quotes.DIA) markets.push({ name: 'Dow (DIA)',     ...quotes.DIA, isInt: false });
  if (quotes.QQQ) markets.push({ name: 'Nasdaq (QQQ)', ...quotes.QQQ, isInt: false });
  if (btc)        markets.push({ name: 'Bitcoin',       ...btc,        isInt: true, prefix: '$' });

  return markets;
}

// ── Build charts ──
async function buildCharts(apiKey) {
  const result = { cpi: null, spy: null };

  // CPI YoY history
  try {
    const obs = await fredFetch('CPIAUCSL', 25, apiKey);
    if (obs && obs.length >= 13) {
      const sorted = obs.slice().reverse();
      const cpiHistory = [];
      for (let i = 12; i < sorted.length; i++) {
        const cur  = parseFloat(sorted[i].value);
        const base = parseFloat(sorted[i - 12].value);
        if (!isNaN(cur) && !isNaN(base) && base > 0) {
          cpiHistory.push({
            label: sorted[i].date.slice(0, 7),
            value: parseFloat(((cur - base) / base * 100).toFixed(2)),
          });
        }
      }
      if (cpiHistory.length >= 2) result.cpi = cpiHistory;
    }
  } catch (e) { /* skip */ }

  // SPY chart from Yahoo Finance
  try {
    const spyData = await fetchYahooChart('SPY');
    if (spyData && spyData.length >= 2) result.spy = spyData;
  } catch (e) { /* skip */ }

  return result;
}

// ── Build news from Google News RSS ──
async function buildNews() {
  try {
    const url = 'https://news.google.com/rss/search?q=US+economy+OR+federal+reserve+OR+inflation+OR+tariffs&hl=en-US&gl=US&ceid=US:en';
    const resp = await fetch(url);
    if (!resp.ok) return [];
    const xml = await resp.text();

    const items = [];
    const itemRegex = /<item>([\s\S]*?)<\/item>/g;
    let match;
    while ((match = itemRegex.exec(xml)) !== null && items.length < 6) {
      const itemXml = match[1];
      const getTag = (tag) => {
        const m = itemXml.match(new RegExp(`<${tag}[^>]*>(?:<!\\[CDATA\\[)?(.*?)(?:\\]\\]>)?<\\/${tag}>`));
        return m ? m[1].trim() : '';
      };
      const title = getTag('title')
        .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
        .replace(/&#39;/g, "'").replace(/&quot;/g, '"');
      const link      = getTag('link');
      const pubDate   = getTag('pubDate');
      const source    = getTag('source');

      if (title && link) {
        items.push({
          title,
          url: link,
          source: source || 'Google News',
          publishedAt: pubDate || new Date().toISOString(),
          description: '',
        });
      }
    }
    return items;
  } catch (e) {
    console.error('News RSS error:', e);
    return [];
  }
}

// ══════════════════════════════════════════════════════
// MAIN REQUEST HANDLER
// ══════════════════════════════════════════════════════
export default {
  async fetch(request, env) {
    // Handle CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS_HEADERS });
    }

    const url          = new URL(request.url);
    const forceRefresh = url.searchParams.get('refresh') === 'true';
    const fredKey      = env.FRED_API_KEY || '';

    // Cache TTLs (milliseconds)
    const TTL = {
      rates:   6 * 60 * 60 * 1000,  // 6 hours
      markets: 5 * 60 * 1000,        // 5 minutes
      news:    30 * 60 * 1000,        // 30 minutes
      charts:  6 * 60 * 60 * 1000,  // 6 hours
    };

    const result  = {};
    const fetches = [];

    // Rates
    if (!forceRefresh && memGet('rates', TTL.rates)) {
      result.rates = memGet('rates', TTL.rates);
    } else {
      fetches.push(
        buildRates(fredKey)
          .then(d  => { memSet('rates', d); result.rates = d; })
          .catch(() => { result.rates = memGet('rates', Infinity) || []; })
      );
    }

    // Markets
    if (!forceRefresh && memGet('markets', TTL.markets)) {
      result.markets = memGet('markets', TTL.markets);
    } else {
      fetches.push(
        buildMarkets()
          .then(d  => { memSet('markets', d); result.markets = d; })
          .catch(() => { result.markets = memGet('markets', Infinity) || []; })
      );
    }

    // News
    if (!forceRefresh && memGet('news', TTL.news)) {
      result.news = memGet('news', TTL.news);
    } else {
      fetches.push(
        buildNews()
          .then(d  => { memSet('news', d); result.news = d; })
          .catch(() => { result.news = memGet('news', Infinity) || []; })
      );
    }

    // Charts
    if (!forceRefresh && memGet('charts', TTL.charts)) {
      result.charts = memGet('charts', TTL.charts);
    } else {
      fetches.push(
        buildCharts(fredKey)
          .then(d  => { memSet('charts', d); result.charts = d; })
          .catch(() => { result.charts = memGet('charts', Infinity) || { cpi: null, spy: null }; })
      );
    }

    await Promise.allSettled(fetches);

    result.timestamp = new Date().toISOString();

    return new Response(JSON.stringify(result), {
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'public, max-age=60',
        ...CORS_HEADERS,
      },
    });
  },
};

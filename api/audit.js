const cheerio = require('cheerio');

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  'Accept-Language': 'en-US,en;q=0.9',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Encoding': 'gzip, deflate, br',
  'Connection': 'keep-alive',
  'Cache-Control': 'max-age=0',
};

async function fetchAmazon(asin) {
  const url = `https://www.amazon.com/dp/${asin}`;
  try {
    const resp = await fetch(url, { headers: HEADERS, redirect: 'follow', signal: AbortSignal.timeout(20000) });
    if (!resp.ok) return { error: `Amazon returned ${resp.status}`, asin, url };
    const html = await resp.text();
    const $ = cheerio.load(html);

    // Remove script/style tags
    $('script, style').remove();

    const data = { asin, url };

    // Title
    data.title = $('#productTitle').text().trim() || 'N/A';

    // Brand
    const brandEl = $('#bylineInfo');
    if (brandEl.length) {
      data.brand = brandEl.text().trim().replace('Visit the ', '').replace(' Store', '').replace('Brand: ', '');
    } else {
      data.brand = 'N/A';
    }

    // Price - multi-pattern
    let price = 'N/A';
    const wholeEl = $('.a-price-whole').first();
    const fractionEl = $('.a-price-fraction').first();
    if (wholeEl.length) {
      const w = wholeEl.text().trim().replace(/,/g, '').replace(/\.$/, '');
      const f = fractionEl.length ? fractionEl.text().trim() : '00';
      price = `${w}.${f}`;
    } else {
      const offscreen = $('.a-offscreen').first();
      if (offscreen.length) {
        const m = offscreen.text().match(/[\d,.]+/);
        if (m) price = m[0].replace(/,/g, '');
      } else {
        for (const pid of ['priceblock_ourprice', 'priceblock_dealprice', 'priceblock_saleprice']) {
          const el = $(`#${pid}`);
          if (el.length) {
            const m = el.text().match(/[\d,.]+/);
            if (m) { price = m[0].replace(/,/g, ''); break; }
          }
        }
      }
    }
    data.price = price;

    // Rating
    const ratingMatch = html.match(/([\d.]+)\s*out\s*of\s*5/);
    data.rating = ratingMatch ? ratingMatch[1] : 'N/A';

    // Review count
    const reviewEl = $('#acrCustomerReviewText');
    if (reviewEl.length) {
      const m = reviewEl.text().match(/([\d,]+)/);
      data.review_count = m ? m[1].replace(/,/g, '') : 'N/A';
    } else {
      data.review_count = 'N/A';
    }

    // Bullets
    const bullets = [];
    $('#feature-bullets li .a-list-item').each((_, el) => {
      const text = $(el).text().trim();
      if (text && !text.includes('Make sure this fits') && text.length > 10) {
        bullets.push(text);
      }
    });
    data.bullets = bullets.slice(0, 5).length ? bullets.slice(0, 5) : ['Failed to extract bullets'];

    // Tech specs
    const specs = {};
    for (const tableId of ['prodDetTable', 'productDetails_techSpec_section_1']) {
      const table = $(`#${tableId}`);
      if (table.length) {
        table.find('tr').each((_, row) => {
          const th = $(row).find('th').text().trim();
          const td = $(row).find('td').text().trim();
          if (th && td) specs[th] = td;
        });
        break;
      }
    }
    data.tech_specs = specs;

    // Images
    const imgCount = $('img.a-dynamic-image').length || (html.match(/altImageCard/g) || []).length;
    data.images_count = Math.max(imgCount, 1);

    // Video
    data.has_video = !!($('video').length || /video|(?:ivm|vp)\./i.test(html));

    // A+
    data.has_aplus = !!($('.aplus-v2').length || html.includes('aplus'));

    // BSR
    const cleanText = $.text();
    const bsrMatch = cleanText.match(/#([\d,]+)\s+in\s+([^(<\n]+)/);
    if (bsrMatch) {
      data.bsr_rank = bsrMatch[1].replace(/,/g, '');
      data.bsr_category = bsrMatch[2].trim();
    } else {
      data.bsr_rank = 'N/A';
      data.bsr_category = 'N/A';
    }

    return data;
  } catch (err) {
    return { error: `Fetch failed: ${err.message}`, asin, url };
  }
}

function auditListing(data) {
  const title = data.title || '';
  const bullets = data.bullets || [];
  const specs = data.tech_specs || {};
  const imagesCount = data.images_count || 0;
  const hasVideo = data.has_video || false;
  const hasAplus = data.has_aplus || false;

  const cdqIssues = [];
  const lqiIssues = [];
  let cdqScore = 100;
  let lqiScore = 100;

  const titleLower = title.toLowerCase();
  const bulletsText = bullets.join(' ').toLowerCase();

  // CDQ: Special chars in title
  if (/["""\u201c\u201d\u2033]/.test(title)) {
    cdqIssues.push({ level: 'high', title: '标题含特殊字符(引号)', detail: '引号可能触发CDQ解析异常，建议替换为-Inch或删去' });
    cdqScore -= 10;
  }

  // CDQ: Keyword repetition
  const wordCounts = {};
  titleLower.split(/\s+/).forEach(w => { if (w.length > 3) wordCounts[w] = (wordCounts[w] || 0) + 1; });
  const repeated = Object.entries(wordCounts).filter(([, v]) => v > 1);
  if (repeated.length) {
    cdqIssues.push({ level: 'high', title: '标题关键词重复', detail: `重复词: ${repeated.map(([k, v]) => `${k}x${v}`).join(', ')}` });
    cdqScore -= 8;
  }

  // CDQ: Voltage
  let voltage = '';
  for (const [k, v] of Object.entries(specs)) {
    if (/voltage|volt/i.test(k)) { voltage = v; break; }
  }
  if (voltage && /(230|220|240)/.test(voltage)) {
    cdqIssues.push({ level: 'critical', title: '电压值异常(美国市场应为110-120V)', detail: `当前: ${voltage}，错误电压导致退货和降权` });
    cdqScore -= 15;
  } else if (!voltage) {
    cdqIssues.push({ level: 'medium', title: '缺失电压属性', detail: 'CDQ高权重属性，建议补充' });
    cdqScore -= 3;
  }

  // CDQ: Wattage inconsistency
  const wattageVals = {};
  for (const [k, v] of Object.entries(specs)) {
    if (/watt|power/i.test(k)) wattageVals[k] = v;
  }
  const wattageUnique = new Set(Object.values(wattageVals));
  if (Object.keys(wattageVals).length > 1 && wattageUnique.size > 1) {
    cdqIssues.push({ level: 'high', title: '功率数据不一致', detail: `多值: ${Object.entries(wattageVals).map(([k, v]) => `${k}=${v}`).join(', ')}` });
    cdqScore -= 8;
  }

  // CDQ: Missing important attributes
  const importantAttrs = { 'Noise Level': '噪音等级', 'Certification': '认证', 'Material': '材质', 'Item Weight': '重量', 'Package Dimensions': '包装尺寸', 'Wattage': '功率' };
  const missing = Object.entries(importantAttrs).filter(([a]) => !Object.keys(specs).some(k => k.toLowerCase().includes(a.toLowerCase())));
  if (missing.length) {
    cdqIssues.push({ level: 'medium', title: `缺失${missing.length}个高权重属性`, detail: `建议补充: ${missing.slice(0, 4).map(([a, c]) => `${a}(${c})`).join(', ')}` });
    cdqScore -= 3 * Math.min(missing.length, 4);
  }

  // CDQ: Title length
  if (title.length < 80) {
    cdqIssues.push({ level: 'low', title: `标题偏短(${title.length}字符)`, detail: '建议150-200字符' });
    cdqScore -= 3;
  } else if (title.length > 200) {
    cdqIssues.push({ level: 'medium', title: `标题过长(${title.length}字符)`, detail: '超200字符会被截断' });
    cdqScore -= 5;
  }

  // LQI: BPA Free
  if (titleLower.includes('bpa') && !bulletsText.includes('bpa')) {
    lqiIssues.push({ level: 'high', title: 'BPA Free仅标题提及', detail: '五点描述未展开' });
    lqiScore -= 12;
  }

  // LQI: Last bullet quality
  if (bullets.length >= 5) {
    const last = bullets[bullets.length - 1].toLowerCase();
    if (['promise', 'quality', 'guarantee', 'deserve', 'mission', 'committed'].some(w => last.includes(w))) {
      lqiIssues.push({ level: 'high', title: '第五条五点为品牌套话', detail: '浪费核心展示位' });
      lqiScore -= 10;
    }
  }

  // LQI: Images
  if (imagesCount < 7) {
    lqiIssues.push({ level: 'high', title: `图片不足(${imagesCount}张)`, detail: '建议9张以上' });
    lqiScore -= 12;
  } else if (imagesCount < 9) {
    lqiIssues.push({ level: 'medium', title: `图片可补充(${imagesCount}张)`, detail: '建议补充至9+' });
    lqiScore -= 5;
  }

  // LQI: Video
  if (!hasVideo) {
    lqiIssues.push({ level: 'medium', title: '缺少产品视频', detail: '视频提升转化率20%+' });
    lqiScore -= 8;
  }

  // LQI: A+
  if (!hasAplus) {
    lqiIssues.push({ level: 'medium', title: '缺少A+页面', detail: 'A+提升转化3-10%' });
    lqiScore -= 8;
  }

  // LQI: Differentiation
  const diffWords = ['wider', 'larger', 'unique', 'only', 'first', 'exclusive', 'unlike', 'compared'];
  if (!diffWords.some(w => bulletsText.includes(w))) {
    lqiIssues.push({ level: 'medium', title: '卖点缺乏竞品对比', detail: '消费者无法感知差异化' });
    lqiScore -= 6;
  }

  // LQI: Data credibility
  const pctMatch = bulletsText.match(/([\d.]+%)\s*(?:juice|yield|extract)/);
  if (pctMatch && !['test', 'lab', 'certif', 'verif'].some(w => bulletsText.includes(w))) {
    lqiIssues.push({ level: 'low', title: '数据声明缺乏支撑', detail: `"${pctMatch[1]}"无第三方认证` });
    lqiScore -= 4;
  }

  cdqScore = Math.max(0, Math.min(100, cdqScore));
  lqiScore = Math.max(0, Math.min(100, lqiScore));
  const overall = Math.round(cdqScore * 0.5 + lqiScore * 0.5);

  let grade;
  if (overall >= 90) grade = 'Optimized';
  else if (overall >= 75) grade = 'Great';
  else if (overall >= 60) grade = 'Good';
  else if (overall >= 40) grade = 'Fair';
  else grade = 'Poor';

  // Optimize title
  let optTitle = title.replace(/[""\u201c\u201d\u2033]/g, '-Inch ');
  const seen = new Set();
  const deduped = [];
  optTitle.split(/\s+/).forEach(w => {
    const wl = w.toLowerCase().replace(/s$/, '');
    if (!seen.has(wl) || w.length <= 3) { deduped.push(w); seen.add(wl); }
  });
  optTitle = deduped.join(' ');

  return {
    cdq_score: cdqScore, lqi_score: lqiScore, overall_score: overall,
    grade, cdq_issues: cdqIssues, lqi_issues: lqiIssues,
    optimized_title: optTitle,
  };
}

export default async function handler(req) {
  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response(null, {
      status: 200,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
      },
    });
  }

  const url = new URL(req.url);
  const asin = (url.searchParams.get('asin') || '').trim().toUpperCase();

  if (!asin || !/^[A-Z0-9]{10}$/.test(asin)) {
    return new Response(JSON.stringify({ error: 'Please enter a valid 10-character ASIN' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
    });
  }

  const data = await fetchAmazon(asin);

  if (data.error) {
    return new Response(JSON.stringify(data), {
      status: 200,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
    });
  }

  const audit = auditListing(data);
  const result = { ...data, audit };

  return new Response(JSON.stringify(result), {
    status: 200,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
  });
}

// Listing CDQ/LQI Audit API - Zero external dependencies, pure regex parsing

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  'Accept-Language': 'en-US,en;q=0.9',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
};

function jsonRes(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
  });
}

async function fetchAmazon(asin) {
  const url = `https://www.amazon.com/dp/${asin}`;
  try {
    const resp = await fetch(url, {
      headers: HEADERS,
      redirect: 'follow',
      signal: AbortSignal.timeout(15000),
    });
    if (!resp.ok) return { error: `Amazon returned status ${resp.status}`, asin, url };
    const html = await resp.text();

    // Clean script/style
    let clean = html.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '');
    clean = clean.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '');

    const data = { asin, url };

    // Title
    const titleMatch = clean.match(/id="productTitle"[^>]*>\s*([\s\S]*?)\s*<\/span>/);
    data.title = titleMatch ? titleMatch[1].replace(/<[^>]+>/g, '').trim() : 'N/A';

    // Brand
    const brandMatch = clean.match(/id="bylineInfo"[^>]*>\s*([\s\S]*?)\s*<\/(?:a|span|div)/);
    if (brandMatch) {
      data.brand = brandMatch[1].replace(/<[^>]+>/g, '').trim()
        .replace('Visit the ', '').replace(' Store', '').replace('Brand: ', '');
    } else {
      data.brand = 'N/A';
    }

    // Price
    let price = 'N/A';
    // Pattern 1: a-price-whole + a-price-fraction
    const pwMatch = clean.match(/class="a-price-whole"[^>]*>\s*\$?([\d,.]+)/);
    const pfMatch = clean.match(/class="a-price-fraction"[^>]*>\s*(\d+)/);
    if (pwMatch) {
      price = pwMatch[1].replace(/,/g, '').replace(/\.$/, '') + '.' + (pfMatch ? pfMatch[1] : '00');
    } else {
      // Pattern 2: a-offscreen
      const offMatch = clean.match(/class="a-offscreen"[^>]*>\s*\$?([\d,.]+)/);
      if (offMatch) price = offMatch[1].replace(/,/g, '');
      else {
        // Pattern 3: priceblock
        for (const pid of ['priceblock_ourprice', 'priceblock_dealprice', 'priceblock_saleprice']) {
          const pm = clean.match(new RegExp(`id="${pid}"[^>]*>\\s*\\$?([\\d,.]+)`));
          if (pm) { price = pm[1].replace(/,/g, ''); break; }
        }
      }
    }
    data.price = price;

    // Rating
    const ratingMatch = html.match(/([\d.]+)\s*out\s*of\s*5/);
    data.rating = ratingMatch ? ratingMatch[1] : 'N/A';

    // Review count
    const reviewMatch = html.match(/id="acrCustomerReviewText"[^>]*>\s*([\d,]+)/);
    data.review_count = reviewMatch ? reviewMatch[1].replace(/,/g, '') : 'N/A';

    // Bullets
    const bullets = [];
    const bulletSection = clean.match(/id="feature-bullets"[\s\S]*?<ul[^>]*>([\s\S]*?)<\/ul>/);
    if (bulletSection) {
      const items = bulletSection[1].match(/<span class="a-list-item">\s*([\s\S]*?)\s*<\/span>/g);
      if (items) {
        for (const item of items) {
          const text = item.replace(/<[^>]+>/g, '').trim();
          if (text && !text.includes('Make sure this fits') && text.length > 10) {
            bullets.push(text);
          }
        }
      }
    }
    data.bullets = bullets.slice(0, 5).length ? bullets.slice(0, 5) : ['Failed to extract bullets'];

    // Tech specs
    const specs = {};
    for (const tableId of ['prodDetTable', 'productDetails_techSpec_section_1']) {
      const tableMatch = html.match(new RegExp(`id="${tableId}"[\\s\\S]*?<tbody>([\\s\\S]*?)<\\/tbody>`));
      if (tableMatch) {
        const rows = tableMatch[1].match(/<tr[^>]*>[\s\S]*?<\/tr>/g);
        if (rows) {
          for (const row of rows) {
            const thMatch = row.match(/<th[^>]*>([\s\S]*?)<\/th>/);
            const tdMatch = row.match(/<td[^>]*>([\s\S]*?)<\/td>/);
            if (thMatch && tdMatch) {
              const k = thMatch[1].replace(/<[^>]+>/g, '').trim();
              const v = tdMatch[1].replace(/<[^>]+>/g, '').trim();
              if (k && v) specs[k] = v;
            }
          }
        }
        break;
      }
    }
    data.tech_specs = specs;

    // Images
    const imgCount = (html.match(/data-a-dynamic-image="/g) || []).length || (html.match(/altImageCard/g) || []).length;
    data.images_count = Math.max(imgCount, 1);

    // Video
    data.has_video = /video|(?:ivm|vp)\./i.test(html);

    // A+
    data.has_aplus = /aplus/.test(html);

    // BSR
    const bsrMatch = clean.match(/#([\d,]+)\s+in\s+([^(<\n]+)/);
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

  // CDQ: Special chars
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
  if (Object.keys(wattageVals).length > 1 && new Set(Object.values(wattageVals)).size > 1) {
    cdqIssues.push({ level: 'high', title: '功率数据不一致', detail: `多值: ${Object.entries(wattageVals).map(([k, v]) => `${k}=${v}`).join(', ')}` });
    cdqScore -= 8;
  }

  // CDQ: Missing attributes
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

  // LQI checks
  if (titleLower.includes('bpa') && !bulletsText.includes('bpa')) {
    lqiIssues.push({ level: 'high', title: 'BPA Free仅标题提及', detail: '五点描述未展开' });
    lqiScore -= 12;
  }

  if (bullets.length >= 5) {
    const last = bullets[bullets.length - 1].toLowerCase();
    if (['promise', 'quality', 'guarantee', 'deserve', 'mission', 'committed'].some(w => last.includes(w))) {
      lqiIssues.push({ level: 'high', title: '第五条五点为品牌套话', detail: '浪费核心展示位' });
      lqiScore -= 10;
    }
  }

  if (imagesCount < 7) {
    lqiIssues.push({ level: 'high', title: `图片不足(${imagesCount}张)`, detail: '建议9张以上' });
    lqiScore -= 12;
  } else if (imagesCount < 9) {
    lqiIssues.push({ level: 'medium', title: `图片可补充(${imagesCount}张)`, detail: '建议补充至9+' });
    lqiScore -= 5;
  }

  if (!hasVideo) {
    lqiIssues.push({ level: 'medium', title: '缺少产品视频', detail: '视频提升转化率20%+' });
    lqiScore -= 8;
  }

  if (!hasAplus) {
    lqiIssues.push({ level: 'medium', title: '缺少A+页面', detail: 'A+提升转化3-10%' });
    lqiScore -= 8;
  }

  const diffWords = ['wider', 'larger', 'unique', 'only', 'first', 'exclusive', 'unlike', 'compared'];
  if (!diffWords.some(w => bulletsText.includes(w))) {
    lqiIssues.push({ level: 'medium', title: '卖点缺乏竞品对比', detail: '消费者无法感知差异化' });
    lqiScore -= 6;
  }

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
  try {
    if (req.method === 'OPTIONS') {
      return new Response(null, {
        status: 200,
        headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, OPTIONS' },
      });
    }

    const u = new URL(req.url);
    const asin = (u.searchParams.get('asin') || '').trim().toUpperCase();

    if (!asin || !/^[A-Z0-9]{10}$/.test(asin)) {
      return jsonRes({ error: 'Please enter a valid 10-character ASIN' }, 400);
    }

    const data = await fetchAmazon(asin);

    if (data.error) {
      return jsonRes(data);
    }

    const audit = auditListing(data);
    return jsonRes({ ...data, audit });

  } catch (err) {
    return jsonRes({ error: `Server error: ${err.message}` }, 500);
  }
}

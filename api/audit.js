// Listing CDQ/LQI Audit API - Uses RapidAPI Amazon Data API
// No more direct scraping = no more CAPTCHA/timeout issues

export const config = { runtime: 'edge' };

const RAPIDAPI_HOST = 'real-time-amazon-data-the-most-complete.p.rapidapi.com';
const RAPIDAPI_KEY = process.env.RAPIDAPI_KEY || '';

function jsonRes(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
  });
}

async function fetchAmazonData(asin) {
  if (!RAPIDAPI_KEY) {
    return { error: 'API key not configured. Please set RAPIDAPI_KEY environment variable in Vercel.', asin };
  }

  const url = `https://${RAPIDAPI_HOST}/product-details?asin=${asin}&country=US`;

  try {
    const resp = await fetch(url, {
      headers: {
        'x-rapidapi-host': RAPIDAPI_HOST,
        'x-rapidapi-key': RAPIDAPI_KEY,
      },
      signal: AbortSignal.timeout(25000),
    });

    if (!resp.ok) {
      const body = await resp.text();
      return { error: `API returned ${resp.status}: ${body.slice(0, 200)}`, asin };
    }

    const json = await resp.json();
    const product = json.data;

    if (!product) {
      return { error: 'No product data returned. ASIN may be invalid or product unavailable.', asin };
    }

    // Map API response to our data structure
    const data = {
      asin,
      url: `https://www.amazon.com/dp/${asin}`,
      title: product.product_title || 'N/A',
      brand: product.product_byline || 'N/A',
      price: 'N/A',
      rating: product.product_star_rating?.toString() || 'N/A',
      review_count: product.product_num_ratings?.toString() || 'N/A',
      bullets: [],
      tech_specs: {},
      images_count: 0,
      has_video: false,
      has_aplus: false,
      bsr_rank: 'N/A',
      bsr_category: 'N/A',
    };

    // Price - try multiple fields
    if (product.product_price) {
      data.price = String(product.product_price).replace(/[^0-9.]/g, '');
    } else if (product.product_original_price) {
      data.price = String(product.product_original_price).replace(/[^0-9.]/g, '');
    }

    // Bullets (feature_bullets)
    if (Array.isArray(product.feature_bullets)) {
      data.bullets = product.feature_bullets.filter(b => b && b.trim().length > 10).slice(0, 5);
    }
    if (data.bullets.length === 0) {
      data.bullets = ['Failed to extract bullets'];
    }

    // Tech specs (product_details)
    if (product.product_details && typeof product.product_details === 'object') {
      const details = product.product_details;
      // API returns specs as key-value pairs
      for (const [k, v] of Object.entries(details)) {
        if (typeof v === 'string' || typeof v === 'number') {
          data.tech_specs[k] = String(v);
        }
      }
    }

    // Images
    if (Array.isArray(product.product_photos)) {
      data.images_count = product.product_photos.length;
    } else if (product.product_photos) {
      data.images_count = Math.max(1, Object.keys(product.product_photos).length);
    }

    // Video
    data.has_video = !!(product.product_video || product.videos);

    // A+ (check if aplus_content exists)
    data.has_aplus = !!(product.aplus_content || product.product_description?.length > 500);

    // BSR
    if (product.bestseller_rank) {
      const bsrStr = String(product.bestseller_rank);
      const bsrMatch = bsrStr.match(/#?([\d,]+)/);
      if (bsrMatch) data.bsr_rank = bsrMatch[1].replace(/,/g, '');
      // Try to extract category
      const catMatch = bsrStr.match(/in\s+(.+?)(?:\s*\(|$)/i);
      if (catMatch) data.bsr_category = catMatch[1].trim();
    }

    // Deal type detection from API data
    data.deal_type = 'none';
    data.deal_price = null;

    if (product.product_offer === 'deal' || product.deal_badge) {
      data.deal_type = 'BD';
      if (product.product_price && product.product_original_price) {
        data.deal_price = String(product.product_price).replace(/[^0-9.]/g, '');
      }
    }

    // Coupon detection
    if (product.coupon_text) {
      const couponMatch = String(product.coupon_text).match(/\$(\d+)/);
      if (couponMatch) {
        data.deal_type = data.deal_type === 'BD' ? 'BD' : 'coupon';
        data.coupon_amount = couponMatch[1];
      }
    }

    return data;
  } catch (err) {
    return { error: `Fetch failed: ${err.message}`, asin };
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

  // CDQ checks

  if (/["""\u201c\u201d\u2033]/.test(title)) {
    cdqIssues.push({ level: 'high', title: '标题含特殊字符(引号)', detail: '引号可能触发CDQ解析异常，建议替换为-Inch或删去' });
    cdqScore -= 10;
  }

  const wordCounts = {};
  titleLower.split(/\s+/).forEach(w => { if (w.length > 3) wordCounts[w] = (wordCounts[w] || 0) + 1; });
  const repeated = Object.entries(wordCounts).filter(([, v]) => v > 1);
  if (repeated.length) {
    cdqIssues.push({ level: 'high', title: '标题关键词重复', detail: `重复词: ${repeated.map(([k, v]) => `${k}x${v}`).join(', ')}` });
    cdqScore -= 8;
  }

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

  const wattageVals = {};
  for (const [k, v] of Object.entries(specs)) {
    if (/watt|power/i.test(k)) wattageVals[k] = v;
  }
  if (Object.keys(wattageVals).length > 1 && new Set(Object.values(wattageVals)).size > 1) {
    cdqIssues.push({ level: 'high', title: '功率数据不一致', detail: `多值: ${Object.entries(wattageVals).map(([k, v]) => `${k}=${v}`).join(', ')}` });
    cdqScore -= 8;
  }

  const importantAttrs = { 'Noise Level': '噪音等级', 'Certification': '认证', 'Material': '材质', 'Item Weight': '重量', 'Package Dimensions': '包装尺寸', 'Wattage': '功率' };
  const missing = Object.entries(importantAttrs).filter(([a]) => !Object.keys(specs).some(k => k.toLowerCase().includes(a.toLowerCase())));
  if (missing.length) {
    cdqIssues.push({ level: 'medium', title: `缺失${missing.length}个高权重属性`, detail: `建议补充: ${missing.slice(0, 4).map(([a, c]) => `${a}(${c})`).join(', ')}` });
    cdqScore -= 3 * Math.min(missing.length, 4);
  }

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

    const data = await fetchAmazonData(asin);

    if (data.error) {
      return jsonRes(data);
    }

    const audit = auditListing(data);
    return jsonRes({ ...data, audit });

  } catch (err) {
    return jsonRes({ error: `Server error: ${err.message}` }, 500);
  }
}

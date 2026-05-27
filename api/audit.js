// Listing CDQ/LQI Audit API v2 - Explainable Scoring + Structured Title + Bullet Rewriting
// Uses RapidAPI Real-Time Amazon Data API

export const config = { runtime: 'edge' };

const RAPIDAPI_HOST = 'real-time-amazon-data.p.rapidapi.com';
const RAPIDAPI_KEY = process.env.RAPIDAPIKEY || '';

function jsonRes(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
  });
}

async function fetchAmazonData(asin) {
  if (!RAPIDAPI_KEY) {
    return { error: 'API key not configured. Please set RAPIDAPIKEY environment variable in Vercel.', asin };
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

    if (json.message && json.message.includes('not subscribed')) {
      return { error: 'RapidAPI subscription required. Please subscribe to Real-Time Amazon Data API (free tier available).', asin };
    }

    const product = json.data;
    if (!product || !product.product_title) {
      return { error: 'No product data returned. ASIN may be invalid or product unavailable.', asin };
    }

    const data = {
      asin,
      url: `https://www.amazon.com/dp/${asin}`,
      title: product.product_title || 'N/A',
      brand: (product.product_byline || 'N/A').replace('Visit the ', '').replace(' Store', ''),
      price: '',
      original_price: '',
      rating: product.product_star_rating?.toString() || 'N/A',
      review_count: product.product_num_ratings?.toString() || 'N/A',
      bullets: [],
      tech_specs: {},
      images_count: 0,
      has_video: false,
      has_aplus: false,
      bsr_rank: 'N/A',
      bsr_category: 'N/A',
      deal_type: 'none',
      is_amazon_choice: product.is_amazon_choice || false,
      is_best_seller: product.is_best_seller || false,
      availability: product.product_availability || '',
      sales_volume: product.sales_volume || '',
    };

    if (product.product_price) data.price = String(product.product_price).replace(/[^0-9.]/g, '');
    if (product.product_original_price) data.original_price = String(product.product_original_price).replace(/[^0-9.]/g, '');
    if (product.deal_badge === 'Limited time deal') data.deal_type = 'BD';

    if (Array.isArray(product.about_product)) {
      data.bullets = product.about_product.filter(b => b && b.trim().length > 5).slice(0, 5);
    }

    if (product.product_information && typeof product.product_information === 'object') {
      for (const [k, v] of Object.entries(product.product_information)) {
        if (typeof v === 'string' || typeof v === 'number') {
          data.tech_specs[k] = String(v);
        }
      }
    }

    if (Array.isArray(product.product_photos)) data.images_count = product.product_photos.length;
    data.has_video = Array.isArray(product.product_videos) && product.product_videos.length > 0;
    data.has_aplus = !!product.has_aplus;

    if (data.tech_specs['Best Sellers Rank']) {
      const bsrStr = data.tech_specs['Best Sellers Rank'];
      const bsrMatch = bsrStr.match(/#([\d,]+)/);
      if (bsrMatch) data.bsr_rank = bsrMatch[1].replace(/,/g, '');
      const catMatch = bsrStr.match(/in\s+([^((]+)/);
      if (catMatch) data.bsr_category = catMatch[1].trim();
    }

    return data;
  } catch (err) {
    return { error: `Fetch failed: ${err.message}`, asin };
  }
}

// ========== DATA COMPLETENESS ==========
function assessCompleteness(data) {
  const modules = [
    { key: 'title', label: '标题', fetched: data.title && data.title !== 'N/A', note: '可用于标题合规分析' },
    { key: 'bullets', label: '五点描述', fetched: data.bullets && data.bullets.length > 0 && data.bullets[0] !== 'Failed to extract bullets', note: '可用于LQI与关键词分析' },
    { key: 'specs', label: '技术规格', fetched: data.tech_specs && Object.keys(data.tech_specs).length > 0, note: '可用于CDQ一致性分析' },
    { key: 'images', label: '图片数量', fetched: data.images_count > 0, note: '仅识别数量，未分析图片文案' },
    { key: 'video', label: '视频', fetched: data.has_video, note: '仅判断有无，未分析视频内容' },
    { key: 'aplus', label: 'A+页面', fetched: data.has_aplus, note: '仅判断有无，未分析模块质量' },
    { key: 'reviews', label: '评论内容', fetched: false, note: '暂未抓取，无法进行VOC分析' },
    { key: 'price', label: '价格信息', fetched: !!data.price, note: '可用于优惠分析' },
  ];
  const fetched = modules.filter(m => m.fetched).length;
  return { modules, fetched, total: modules.length, percentage: Math.round(fetched / modules.length * 100) };
}

// ========== SUB-DIMENSION SCORING + EXPLAINABLE ISSUES ==========
function auditListing(data) {
  const title = data.title || '';
  const bullets = data.bullets || [];
  const specs = data.tech_specs || {};
  const imagesCount = data.images_count || 0;
  const hasVideo = data.has_video || false;
  const hasAplus = data.has_aplus || false;
  const titleLower = title.toLowerCase();
  const bulletsText = bullets.join(' ').toLowerCase();

  // --- CDQ Sub-dimensions ---
  const cdqTitleCompliance = { name: '标题规范', max: 30, score: 30, issues: [] };
  const cdqAttributeComplete = { name: '属性饱和度', max: 30, score: 30, issues: [] };
  const cdqDataConsistency = { name: '数据一致性', max: 40, score: 40, issues: [] };

  // --- LQI Sub-dimensions ---
  const lqiContentQuality = { name: '内容质量', max: 35, score: 35, issues: [] };
  const lqiMediaCoverage = { name: '媒体覆盖', max: 35, score: 35, issues: [] };
  const lqiDifferentiation = { name: '差异化表达', max: 30, score: 30, issues: [] };

  // Helper: add issue
  function addIssue(dim, deduction, level, title_text, impact, fix) {
    dim.score = Math.max(0, dim.score - deduction);
    dim.issues.push({ level, title: title_text, impact, fix, deduction });
  }

  // ===== CDQ: Title Compliance =====
  if (/["""\u201c\u201d\u2033]/.test(title)) {
    addIssue(cdqTitleCompliance, 8, 'high', '标题含特殊字符(引号/英寸符号)',
      'CDQ系统可能解析异常，导致属性缺失或索引失败',
      '将 " 和 ″ 替换为 Inch，将引号内容改为短横线连接');
  }

  const wordCounts = {};
  titleLower.split(/\s+/).forEach(w => { if (w.length > 3) wordCounts[w] = (wordCounts[w] || 0) + 1; });
  const repeated = Object.entries(wordCounts).filter(([, v]) => v > 1);
  if (repeated.length) {
    addIssue(cdqTitleCompliance, 7, 'high', `标题关键词重复(${repeated.length}组)`,
      '亚马逊视为关键词堆砌，可能降权或限制展示',
      `去除重复词: ${repeated.map(([k, v]) => `${k}(${v}次)`).join(', ')}，每词仅保留1次`);
  }

  if (title.length < 80) {
    addIssue(cdqTitleCompliance, 5, 'medium', `标题偏短(${title.length}字符)`,
      '浪费搜索权重空间，少了150+字符可携带的关键词',
      `补充至150-200字符，优先添加用途/场景/材质/颜色等属性`);
  } else if (title.length > 200) {
    addIssue(cdqTitleCompliance, 8, 'high', `标题过长(${title.length}字符)`,
      '超200字符被截断，尾部关键词无效，堆砌风险高',
      '精简至200字符内，保留核心关键词，删除冗余修饰');
  }

  // Brand position check
  const brandInTitle = data.brand && data.brand !== 'N/A' && titleLower.startsWith(data.brand.toLowerCase());
  if (!brandInTitle && data.brand && data.brand !== 'N/A') {
    addIssue(cdqTitleCompliance, 5, 'medium', '品牌名未在标题首位',
      '品牌前置提升搜索权重和品牌认知，CDQ推荐格式Brand+Core+Specs',
      `将 "${data.brand}" 移到标题最前面`);
  }

  // ===== CDQ: Attribute Completeness =====
  let voltage = '';
  for (const [k, v] of Object.entries(specs)) {
    if (/voltage|volt/i.test(k)) { voltage = v; break; }
  }
  if (!voltage) {
    addIssue(cdqAttributeComplete, 5, 'medium', '缺失电压属性',
      '电压是CDQ高权重属性，缺失降低字段饱和度得分',
      '在后台Attributes中补充Voltage值(美国市场填110-120V)');
  }

  const importantAttrs = [
    { key: 'Noise Level', cn: '噪音等级', weight: 4 },
    { key: 'Certification', cn: '认证', weight: 4 },
    { key: 'Material', cn: '材质', weight: 5 },
    { key: 'Item Weight', cn: '重量', weight: 3 },
    { key: 'Package Dimensions', cn: '包装尺寸', weight: 3 },
    { key: 'Wattage', cn: '功率', weight: 5 },
    { key: 'Capacity', cn: '容量', weight: 4 },
    { key: 'Color', cn: '颜色', weight: 2 },
  ];
  const missingAttrs = importantAttrs.filter(a => !Object.keys(specs).some(k => k.toLowerCase().includes(a.key.toLowerCase())));
  if (missingAttrs.length) {
    const totalWeight = missingAttrs.reduce((s, a) => s + a.weight, 0);
    const deduction = Math.min(totalWeight, 20);
    addIssue(cdqAttributeComplete, deduction, 'medium', `缺失${missingAttrs.length}个高权重属性`,
      `字段饱和度不足，影响搜索收录和过滤器匹配`,
      `补充: ${missingAttrs.map(a => `${a.key}(${a.cn})`).join(', ')}，优先补权重≥4的属性`);
  }

  // ===== CDQ: Data Consistency =====
  if (voltage && /(230|220|240)/.test(voltage)) {
    addIssue(cdqDataConsistency, 15, 'critical', `电压值异常: ${voltage}`,
      '美国市场应为110-120V，错误电压导致退货率飙升和CDQ降权，这是最高优先级修复项',
      '立即修改后台Voltage属性为正确值(110V或120V)，同时检查Listing页面显示');
  }

  const wattageVals = {};
  for (const [k, v] of Object.entries(specs)) {
    if (/watt|power/i.test(k)) wattageVals[k] = v;
  }
  if (Object.keys(wattageVals).length > 1 && new Set(Object.values(wattageVals)).size > 1) {
    addIssue(cdqDataConsistency, 10, 'high', `功率数据不一致`,
      'Maximum Power与Wattage字段冲突，亚马逊可能标记数据异常，消费者产生信任危机',
      `统一为一个值: ${Object.entries(wattageVals).map(([k, v]) => `${k}=${v}`).join(', ')}，建议以额定功率为准`);
  }

  // Check for percent sign in title
  if (/[\d.]+%/.test(title)) {
    addIssue(cdqDataConsistency, 5, 'medium', '标题含百分号(%)',
      '亚马逊标题规范建议避免特殊符号，百分号可能触发CDQ解析问题',
      '将百分号改为 Percent，如 99.6% → 99.6 Percent');
  }

  // ===== LQI: Content Quality =====
  if (titleLower.includes('bpa') && !bulletsText.includes('bpa')) {
    addIssue(lqiContentQuality, 8, 'high', 'BPA Free仅标题提及，五点未展开',
      '消费者在决策区域看不到关键卖点，转化率流失',
      '在五点中增加一条: "BPA-Free Materials: All food-contact parts are certified BPA-free for safe, healthy juicing"');
  }

  if (bullets.length >= 5) {
    const last = bullets[bullets.length - 1].toLowerCase();
    if (['promise', 'quality', 'guarantee', 'deserve', 'mission', 'committed'].some(w => last.includes(w))) {
      addIssue(lqiContentQuality, 8, 'high', '第五条五点为品牌套话',
      '第五条是转化黄金位，品牌套话浪费了最后说服买家的机会',
      '替换为实际卖点(清洁方式/配件/保修)，如: "Easy Cleanup & Complete Package: Detachable parts rinse clean in 60 seconds. Includes 2 cups, cleaning brush, and recipe booklet"');
    }
  }

  // Unsupported data claims in bullets
  const pctMatch = bulletsText.match(/([\d.]+%)\s*(?:juice|yield|extract)/);
  if (pctMatch && !['test', 'lab', 'certif', 'verif', 'independ'].some(w => bulletsText.includes(w))) {
    addIssue(lqiContentQuality, 4, 'low', `数据声明"${pctMatch[1]}"缺乏第三方认证`,
      '无支撑的数字声明可能被消费者质疑，也面临合规风险',
      `补充第三方测试报告或修改措辞为"Up to ${pctMatch[1]}"，并附上测试机构名称`);
  }

  // ===== LQI: Media Coverage =====
  if (imagesCount < 7) {
    addIssue(lqiMediaCoverage, 10, 'high', `图片严重不足(仅${imagesCount}张)`,
      '7张以下图片转化率显著偏低，竞品通常9-15张，缺少场景图/细节图/尺寸对比图',
      '补充至9张以上: 1主图+2场景图+2细节图+1尺寸图+1配件图+1对比图');
  } else if (imagesCount < 9) {
    addIssue(lqiMediaCoverage, 5, 'medium', `图片可补充(${imagesCount}张)`,
      '9张是及格线，Top竞品通常12张以上',
      '补充场景图和生活方式图至9+张');
  }

  if (!hasVideo) {
    addIssue(lqiMediaCoverage, 8, 'high', '缺少产品视频',
      '视频提升转化率20%+，亚马逊优先展示含视频的Listing',
      '上传30-60秒产品演示视频，展示核心使用场景和清洁流程');
  }

  if (!hasAplus) {
    addIssue(lqiMediaCoverage, 6, 'medium', '缺少A+页面',
      'A+页面提升转化3-10%，是品牌卖家标配',
      '注册品牌后创建A+内容: 产品对比表+使用场景图+FAQ模块');
  }

  // ===== LQI: Differentiation =====
  const diffWords = ['wider', 'larger', 'unique', 'only', 'first', 'exclusive', 'unlike', 'compared', 'versus', 'faster', 'quieter', 'easier'];
  if (!diffWords.some(w => bulletsText.includes(w))) {
    addIssue(lqiDifferentiation, 6, 'medium', '卖点缺乏竞品对比语言',
      '消费者无法感知"为什么选你"，纯功能罗列无差异化说服力',
      '在五点中加入对比表述: "Unlike traditional juicers..." / "Wider 5.8-inch feed chute vs standard 3-inch..."');
  }

  // Check for benefit-first structure in bullets
  const benefitStarters = ['easy', 'powerful', 'perfect', 'ideal', 'designed', 'upgrade', 'smart', 'enjoy', 'save', 'keep', 'make'];
  const bulletsWithBenefit = bullets.filter(b => benefitStarters.some(w => b.toLowerCase().startsWith(w)));
  if (bullets.length > 0 && bulletsWithBenefit.length < 2) {
    addIssue(lqiDifferentiation, 4, 'low', '五点缺乏利益导向开头',
      '消费者扫读时只看开头5个词，功能描述开头不如利益点开头有吸引力',
      '将五点开头改为利益导向: "Easy to Clean" / "Powerful 400W Motor" / "Save Time with Wide Chute"');
  }

  // ===== COMPUTE TOTALS =====
  const cdqScore = cdqTitleCompliance.score + cdqAttributeComplete.score + cdqDataConsistency.score;
  const lqiScore = lqiContentQuality.score + lqiMediaCoverage.score + lqiDifferentiation.score;
  const overall = Math.round(cdqScore * 0.5 + lqiScore * 0.5);

  let grade;
  if (overall >= 90) grade = 'Optimized';
  else if (overall >= 75) grade = 'Great';
  else if (overall >= 60) grade = 'Good';
  else if (overall >= 40) grade = 'Fair';
  else grade = 'Poor';

  // ===== STRUCTURED TITLE OPTIMIZATION =====
  const titleOpts = generateTitleOptions(title, data.brand, specs, bulletsText);

  // ===== BULLET REWRITING =====
  const bulletRewrites = rewriteBullets(bullets, titleLower, specs);

  // Collect all issues sorted by priority
  const allIssues = [
    ...cdqTitleCompliance.issues.map(i => ({ ...i, dimension: 'CDQ-标题', sub: cdqTitleCompliance.name })),
    ...cdqAttributeComplete.issues.map(i => ({ ...i, dimension: 'CDQ-属性', sub: cdqAttributeComplete.name })),
    ...cdqDataConsistency.issues.map(i => ({ ...i, dimension: 'CDQ-一致', sub: cdqDataConsistency.name })),
    ...lqiContentQuality.issues.map(i => ({ ...i, dimension: 'LQI-内容', sub: lqiContentQuality.name })),
    ...lqiMediaCoverage.issues.map(i => ({ ...i, dimension: 'LQI-媒体', sub: lqiMediaCoverage.name })),
    ...lqiDifferentiation.issues.map(i => ({ ...i, dimension: 'LQI-差异', sub: lqiDifferentiation.name })),
  ].sort((a, b) => {
    const priority = { critical: 0, high: 1, medium: 2, low: 3 };
    return (priority[a.level] || 3) - (priority[b.level] || 3);
  });

  return {
    cdq_score: cdqScore,
    lqi_score: lqiScore,
    overall_score: overall,
    grade,
    cdq_dimensions: [cdqTitleCompliance, cdqAttributeComplete, cdqDataConsistency],
    lqi_dimensions: [lqiContentQuality, lqiMediaCoverage, lqiDifferentiation],
    all_issues: allIssues,
    title_options: titleOpts,
    bullet_rewrites: bulletRewrites,
  };
}

// ========== TITLE OPTIMIZATION ENGINE ==========
function generateTitleOptions(originalTitle, brand, specs, bulletsText) {
  // Extract components
  const brandClean = (brand || '').replace('Visit the ', '').replace(' Store', '').trim();

  // Extract core product type
  const typePatterns = [
    /((?:cold\s+press|slow\s+masticating|masticating)\s+juicer)/i,
    /((?:air\s+fryer|deep\s+fryer)\s*(?:oven)?)/i,
    /((?:espresso|coffee)\s*machine)/i,
    /((?:ice\s*cream|gelato)\s*maker)/i,
    /((?:stand\s*|hand\s*)?mixer)/i,
    /((?:blender|food\s+processor))/i,
    /((?:rice\s*cooker|slow\s*cooker|pressure\s*cooker))/i,
    /((?:toaster|toaster\s*oven))/i,
    /((?:waffle|sandwich)\s*maker)/i,
    /((?:dehydrator|freeze\s*dryer))/i,
    /((?:ice\s*maker|nugget\s*ice\s*maker))/i,
    /(\w+\s+machine)/i,
    /(\w+\s+maker)/i,
    /(\w+\s+juicer)/i,
  ];

  let coreType = 'Appliance';
  for (const pat of typePatterns) {
    const m = originalTitle.match(pat);
    if (m) { coreType = m[1].trim(); break; }
  }

  // Extract key specs from title
  const specExtracts = [];
  const inchMatch = originalTitle.match(/([\d.]+)[""″\u2033\s-]*(?:inch|in\b|''|")/i);
  if (inchMatch) specExtracts.push(`${inchMatch[1]}-Inch`);

  const wattMatch = Object.entries(specs).find(([k]) => /wattage/i.test(k));
  if (wattMatch) specExtracts.push(`${wattMatch[1].replace(/[^0-9]/g, '')}W`);

  const capacityMatch = Object.entries(specs).find(([k]) => /capacity/i.test(k));
  if (capacityMatch) specExtracts.push(capacityMatch[1].trim());

  // Extract differentiators
  const diffPhrases = [];
  if (/bpa[- ]?free/i.test(originalTitle)) diffPhrases.push('BPA-Free');
  if (/easy[- ]?clean/i.test(originalTitle)) diffPhrases.push('Easy-Clean');
  if (/high\s+juice\s+yield/i.test(originalTitle)) diffPhrases.push('High Juice Yield');
  if (/whole\s+(fruit|vegetable)/i.test(originalTitle)) diffPhrases.push('Whole Fruit');

  // Extract color
  const colorMatch = Object.entries(specs).find(([k]) => /color/i.test(k));
  const color = colorMatch ? colorMatch[1].trim() : '';

  // Extract use case
  const useCase = [];
  if (/vegetable|fruit/i.test(originalTitle)) useCase.push('for Vegetables and Fruits');
  if (/kitchen|home/i.test(originalTitle)) useCase.push('for Home Kitchen');

  // Build template: {Brand} {Core Type} {Key Spec 1} {Key Spec 2} {Use Case} {Differentiator} {Material Safety} {Color}
  function buildTitle(parts) {
    return parts.filter(p => p && p.trim()).join(' ');
  }

  // Clean: remove special chars, replace % with Percent
  function clean(s) {
    return s.replace(/["""\u201c\u201d\u2033]/g, '-Inch ')
      .replace(/(\d+\.?\d*)%/g, '$1 Percent')
      .replace(/\s+/g, ' ')
      .trim();
  }

  // Deduplicate words semantically
  const synGroups = [
    ['juicer', 'juicers', 'juice', 'juicing', 'extractor', 'juice extractor'],
    ['machine', 'machines', 'maker', 'makers', 'device'],
    ['press', 'masticating', 'cold press'],
    ['vegetable', 'vegetables', 'veggie', 'veggies'],
    ['fruit', 'fruits'],
  ];

  function dedupTitle(titleStr) {
    const words = titleStr.split(/\s+/);
    const seen = new Set();
    const result = [];
    for (const w of words) {
      const wl = w.toLowerCase().replace(/[.,;:!?]/g, '');
      let found = false;
      for (const group of synGroups) {
        const groupSet = new Set(group);
        if (groupSet.has(wl)) {
          const groupKey = group[0];
          if (seen.has(groupKey)) { found = true; break; }
          seen.add(groupKey);
          break;
        }
      }
      if (!found && wl.length > 0) {
        result.push(w);
        seen.add(wl);
      }
    }
    return result.join(' ');
  }

  // Version 1: SEO Priority (max keywords, 150-200 chars)
  const seoParts = [brandClean, coreType, ...specExtracts, ...useCase, ...diffPhrases];
  if (color && !seoParts.includes(color)) seoParts.push(color);
  let seoTitle = clean(dedupTitle(buildTitle(seoParts)));
  if (seoTitle.length > 200) seoTitle = seoTitle.substring(0, 197) + '...';

  // Version 2: Readability Priority (clean, 120-160 chars)
  const readParts = [brandClean, coreType, specExtracts[0] || '', diffPhrases[0] || '', useCase[0] || ''];
  let readTitle = clean(dedupTitle(buildTitle(readParts)));

  // Version 3: Balanced
  const balParts = [brandClean, coreType, ...specExtracts.slice(0, 2), diffPhrases.slice(0, 2).join(' '), useCase[0] || ''];
  let balTitle = clean(dedupTitle(buildTitle(balParts)));
  if (balTitle.length > 190) balTitle = balTitle.substring(0, 187) + '...';

  return [
    {
      label: 'SEO优先版',
      desc: '关键词密度最高，适合搜索流量导向',
      title: seoTitle,
      charCount: seoTitle.length,
    },
    {
      label: '可读性优先版',
      desc: '简洁清晰，适合品牌调性',
      title: readTitle,
      charCount: readTitle.length,
    },
    {
      label: '平衡版',
      desc: '兼顾搜索和可读性，推荐使用',
      title: balTitle,
      charCount: balTitle.length,
    },
  ];
}

// ========== BULLET REWRITING ENGINE ==========
function rewriteBullets(bullets, titleLower, specs) {
  if (!bullets || bullets.length === 0 || bullets[0] === 'Failed to extract bullets') {
    return [];
  }

  const rewrites = [];
  const brandFluffWords = ['promise', 'mission', 'committed', 'deserve', 'superior quality', 'we offer', 'our mission'];
  const benefitStarters = {
    'large': 'SAVE PREP TIME',
    'easy': 'EFFORTLESS CLEANUP',
    'simple': 'QUICK ASSEMBLY',
    'slow': 'MAXIMUM NUTRITION',
    'one-button': 'ONE-TOUCH OPERATION',
    'powerful': 'POWERFUL PERFORMANCE',
    'superior': 'COMPLETE PACKAGE',
    'bpa': 'SAFE & HEALTHY',
  };

  for (let i = 0; i < bullets.length; i++) {
    const original = bullets[i];
    const origLower = original.toLowerCase();
    let rewritten = original;
    let changes = [];

    // Rule 1: Replace brand fluff in last bullet
    if (i === bullets.length - 1 && brandFluffWords.some(w => origLower.includes(w))) {
      // Generate replacement based on context
      if (origLower.includes('brush') || origLower.includes('cup') || origLower.includes('manual')) {
        rewritten = 'COMPLETE ACCESSORIES & EASY CLEANUP: Includes 2 juice cups, cleaning brush, and user manual. Detachable parts rinse clean in under 60 seconds — no complicated disassembly required.';
      } else if (origLower.includes('warranty') || origLower.includes('support') || origLower.includes('service')) {
        rewritten = 'RELIABLE SUPPORT & WARRANTY: Backed by dedicated customer service and manufacturer warranty. Our team is ready to help with any questions about your juicer.';
      } else {
        rewritten = 'WHAT YOU GET: 1x Cold Press Juicer, 2x Juice Cups, 1x Cleaning Brush, 1x User Manual. Enjoy fresh, healthy juice every day with confidence.';
      }
      changes.push({ type: 'content', desc: '移除品牌套话，替换为配件/清洁/售后等决策推动信息' });
      changes.push({ type: 'structure', desc: '开头改为利益导向大写关键词' });
    }

    // Rule 2: Add benefit-first header if missing
    if (changes.length === 0) {
      const colonIdx = original.indexOf(':');
      if (colonIdx < 0 || colonIdx > 30) {
        // No clear header - try to add one
        for (const [keyword, header] of Object.entries(benefitStarters)) {
          if (origLower.includes(keyword)) {
            const rest = original.trim();
            rewritten = `${header}: ${rest}`;
            changes.push({ type: 'structure', desc: '添加利益导向大写标题，提升扫读转化' });
            break;
          }
        }
      }
    }

    // Rule 3: Fix % in bullets
    if (/[\d.]+%/.test(rewritten)) {
      rewritten = rewritten.replace(/(\d+\.?\d*)%/g, '$1 Percent');
      changes.push({ type: 'compliance', desc: '百分号替换为Percent，符合亚马逊标题/文案规范' });
    }

    // Rule 4: Ensure BPA-free mention if in title
    if (titleLower.includes('bpa') && i === 0 && !origLower.includes('bpa')) {
      rewritten = `BPA-FREE & SAFE: ${rewritten}`;
      changes.push({ type: 'keyword', desc: '标题提及BPA-Free但五点未展开，补充关键词' });
    }

    // Determine improvement dimensions
    const dimensions = changes.map(c => {
      if (c.type === 'structure') return '可读性';
      if (c.type === 'content') return '卖点证据';
      if (c.type === 'keyword') return '关键词密度';
      if (c.type === 'compliance') return '合规性';
      return '场景代入';
    });

    rewrites.push({
      index: i + 1,
      before: original,
      after: rewritten,
      changes: changes.map((c, ci) => `${c.desc} [↑${dimensions[ci]}]`),
      hasChange: changes.length > 0,
    });
  }

  return rewrites;
}

// ========== MAIN HANDLER ==========
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
    const completeness = assessCompleteness(data);

    return jsonRes({ ...data, audit, completeness });

  } catch (err) {
    return jsonRes({ error: `Server error: ${err.message}` }, 500);
  }
}

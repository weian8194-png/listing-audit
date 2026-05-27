// Listing CDQ/LQI Audit API v4 - Field-Lock Title Optimization Engine
// Core principle: Extract → Classify → Lock → Reassemble (NEVER summarize/delete)
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

  const cdqTitleCompliance = { name: '标题规范', max: 30, score: 30, issues: [] };
  const cdqAttributeComplete = { name: '属性饱和度', max: 30, score: 30, issues: [] };
  const cdqDataConsistency = { name: '数据一致性', max: 40, score: 40, issues: [] };

  const lqiContentQuality = { name: '内容质量', max: 35, score: 35, issues: [] };
  const lqiMediaCoverage = { name: '媒体覆盖', max: 35, score: 35, issues: [] };
  const lqiDifferentiation = { name: '差异化表达', max: 30, score: 30, issues: [] };

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
      '替换为实际卖点(清洁方式/配件/保修)');
    }
  }

  const pctMatch = bulletsText.match(/([\d.]+%)\s*(?:juice|yield|extract)/);
  if (pctMatch && !['test', 'lab', 'certif', 'verif', 'independ'].some(w => bulletsText.includes(w))) {
    addIssue(lqiContentQuality, 4, 'low', `数据声明"${pctMatch[1]}"缺乏第三方认证`,
      '无支撑的数字声明可能被消费者质疑，也面临合规风险',
      `补充第三方测试报告或修改措辞为"Up to ${pctMatch[1]}"，并附上测试机构名称`);
  }

  // ===== LQI: Media Coverage =====
  if (imagesCount < 7) {
    addIssue(lqiMediaCoverage, 10, 'high', `图片严重不足(仅${imagesCount}张)`,
      '7张以下图片转化率显著偏低，竞品通常9-15张',
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

  const titleOpts = generateTitleOptions(title, data.brand, specs, bulletsText);
  const bulletRewrites = rewriteBullets(bullets, titleLower, specs);

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

// ========================================================================
// TITLE OPTIMIZATION ENGINE v4 — FIELD-LOCK + REASSEMBLE
// Principle: Extract ALL fields → Classify P0/P1/P2 → Lock P0 → Reassemble
// NEVER summarize. NEVER drop P0. NEVER change numbers.
// ========================================================================

function generateTitleOptions(originalTitle, brand, specs, bulletsText) {
  const titleLower = originalTitle.toLowerCase();
  const brandClean = (brand || '').replace('Visit the ', '').replace(' Store', '').trim();
  const specEntries = Object.entries(specs || {});

  // ===== PHASE 1: EXTRACT ALL FIELDS FROM TITLE (never from specs for numbers) =====
  const fields = { brand: brandClean, productTypes: [], numericSpecs: [], features: [], certifications: [], useCases: [], color: '', capacity: '', modifiers: [], outputRate: '' };

  // --- Color ---
  for (const [k, v] of specEntries) { if (/^color$/i.test(k.trim())) { fields.color = String(v).trim(); break; } }
  if (!fields.color) {
    const cParen = originalTitle.match(/\(([A-Za-z\s]+?)\)\s*$/);
    if (cParen && cParen[1].length < 25) fields.color = cParen[1].trim();
  }

  // --- Product Types: collect ALL matching types, order by specificity ---
  const typePatterns = [
    /Snow\s+Cone\s+Machine/i, /Shaved\s+Ice\s+Machine/i, /Electric\s+Ice\s+Shaver/i, /Snow\s+Cone\s+Maker/i,
    /Espresso\s+Coffee\s+Maker/i, /Espresso\s+Machine/i, /Coffee\s+Maker/i,
    /Cold\s+Press\s+Juicer/i, /Slow\s+Masticating\s+Juicer/i, /Masticating\s+Juicer/i, /Juicer\s+Machine/i, /Juicer/i, /Juice\s+Extractor/i,
    /Air\s+Fryer/i, /Deep\s+Fryer/i,
    /Blender/i, /Food\s+Processor/i,
    /Stand\s+Mixer/i, /Hand\s+Mixer/i, /Mixer/i,
    /Ice\s+Cream\s+Maker/i, /Ice\s+Maker/i, /Nugget\s+Ice\s+Maker/i,
    /Rice\s+Cooker/i, /Slow\s+Cooker/i, /Pressure\s+Cooker/i,
    /Toaster\s+Oven/i, /Toaster/i,
    /Waffle\s+Maker/i, /Sandwich\s+Maker/i,
    /Dehydrator/i,
  ];
  for (const pat of typePatterns) {
    const m = originalTitle.match(pat);
    if (m && !fields.productTypes.some(pt => pt.toLowerCase() === m[0].toLowerCase())) {
      fields.productTypes.push(m[0].trim());
    }
  }

  // --- Numeric Specs: extract from TITLE only, preserve exact numbers ---
  const numExtractors = [
    { re: /(\d+[\d,]*\.?\d*)\s*Lbs\s*\/\s*H/i, norm: v => v.replace(/,/g, '') + ' Lbs per Hour', label: 'Output Rate' },
    { re: /(\d+[\d,]*\.?\d*)\s*Pounds?\s*(?:per|\/)\s*Hour/i, norm: v => v.replace(/,/g, '') + ' Lbs per Hour', label: 'Output Rate' },
    { re: /(\d+\.?\d*)\s*Bar\b/i, norm: v => v + ' Bar', label: 'Pressure' },
    { re: /(\d{3,4})\s*W(?:att)?\b/i, norm: v => v + 'W', label: 'Wattage' },
    { re: /(\d+\.?\d*)\s*(?:Liters?|L)\b/i, norm: v => v + ' Liter', label: 'Capacity' },
    { re: /(\d+\.?\d*)\s*(?:Oz|Ounces?)\b/i, norm: v => v + ' Oz', label: 'Capacity' },
    { re: /(\d+\.?\d*)\s*Cups?\b/i, norm: v => v + ' Cup', label: 'Capacity' },
    { re: /(\d+\.?\d*)\s*Quarts?\b/i, norm: v => v + ' Quart', label: 'Capacity' },
    { re: /(\d+\.?\d*)\s*RPM/i, norm: v => v + ' RPM', label: 'Speed' },
    { re: /(\d+\.?\d*)\s*(?:[""″\u2033]|Inch)/i, norm: v => v + ' Inch', label: 'Size' },
    { re: /(\d+\.?\d*)%/i, norm: v => v + ' Percent', label: 'Percentage' },
  ];
  const seenLabels = {};
  for (const { re, norm, label } of numExtractors) {
    const m = originalTitle.match(re);
    if (m) {
      const normalized = norm(m[1]);
      // Deduplicate by label: keep first (most prominent) match
      if (!seenLabels[label]) {
        fields.numericSpecs.push({ raw: m[0], normalized, label, value: m[1] });
        seenLabels[label] = true;
      }
    }
  }
  // Supplement wattage from specs ONLY if not in title
  if (!seenLabels['Wattage']) {
    for (const [k, v] of specEntries) {
      if (/wattage/i.test(k)) {
        const wVal = String(v).replace(/[^0-9.]/g, '');
        if (wVal) { fields.numericSpecs.push({ raw: v, normalized: wVal + 'W', label: 'Wattage', value: wVal }); break; }
      }
    }
  }

  // --- Output Rate (special for ice machines etc.) ---
  const outRate = fields.numericSpecs.find(s => s.label === 'Output Rate');
  if (outRate) fields.outputRate = outRate.normalized;

  // --- Capacity (separate field for clarity) ---
  const capSpec = fields.numericSpecs.find(s => s.label === 'Capacity');
  if (capSpec) fields.capacity = capSpec.normalized + ' Capacity';

  // --- Features ---
  if (/with\s+Grinder|built[\s-]*in\s+grinder/i.test(originalTitle)) fields.features.push('with Grinder');
  if (/milk\s*frother/i.test(originalTitle)) fields.features.push('with Milk Frother');
  if (/steam\s*wand/i.test(originalTitle)) fields.features.push('with Steam Wand');
  if (/dual\s+blades?/i.test(originalTitle)) fields.features.push('Dual Blades');
  if (/bpa[\s-]*free/i.test(originalTitle)) fields.features.push('BPA Free');
  if (/easy[\s-]*(?:to[\s-]*)?clean/i.test(originalTitle)) fields.features.push('Easy to Clean');
  if (/dishwasher[\s-]*safe/i.test(originalTitle)) fields.features.push('Dishwasher Safe');
  if (/wide\s+feed\s+chute/i.test(originalTitle)) fields.features.push('Wide Feed Chute');
  if (/whole\s+(fruit|vegetable)/i.test(originalTitle)) fields.features.push('Whole Vegetables and Fruits');
  if (/high\s*juice\s*yield/i.test(originalTitle)) fields.features.push('High Juice Yield');
  if (/compact/i.test(originalTitle)) fields.features.push('Compact');
  if (/removable/i.test(originalTitle)) fields.features.push('Removable');
  if (/touch\s*screen/i.test(originalTitle)) fields.features.push('Touch Screen');
  if (/semi[\s-]*automatic/i.test(originalTitle)) fields.features.push('Semi Automatic');
  if (/quiet/i.test(originalTitle)) fields.features.push('Quiet');
  if (/reverse\s*(?:function)?/i.test(originalTitle)) fields.features.push('Reverse Function');
  if (/anti[\s-]*drip|drip[\s-]*free/i.test(originalTitle)) fields.features.push('Anti Drip');

  // --- Certifications ---
  if (/etl[\s-]*certified/i.test(originalTitle)) fields.certifications.push('ETL Certified');
  if (/ul[\s-]*(?:certified|listed)/i.test(originalTitle)) fields.certifications.push('UL Certified');
  if (/ce[\s-]*certified/i.test(originalTitle)) fields.certifications.push('CE Certified');
  if (/nsf[\s-]*certified/i.test(originalTitle)) fields.certifications.push('NSF Certified');
  if (/fcc/i.test(originalTitle)) fields.certifications.push('FCC');
  if (/energy\s*star/i.test(originalTitle)) fields.certifications.push('Energy Star');

  // --- Use Cases ---
  if (/home.*commercial|commercial.*home/i.test(originalTitle)) fields.useCases.push('Home and Commercial Use');
  else if (/home.*kitchen/i.test(originalTitle)) fields.useCases.push('for Home Kitchen');
  else if (/home/i.test(originalTitle) && /commercial/i.test(originalTitle)) fields.useCases.push('Home and Commercial Use');
  else if (/home/i.test(originalTitle)) fields.useCases.push('for Home');
  else if (/commercial/i.test(originalTitle)) fields.useCases.push('Commercial Use');
  // Also check "for X" pattern
  if (fields.useCases.length === 0) {
    const forM = originalTitle.match(/for\s+([A-Za-z\s&]+?)(?:\s*[,(]|\s*$)/i);
    if (forM) fields.useCases.push('for ' + forM[1].trim().replace(/&/g, 'and'));
  }

  // --- Modifiers ---
  if (/professional/i.test(originalTitle)) fields.modifiers.push('Professional');
  if (/commercial/i.test(originalTitle) && !fields.useCases.some(u => /commercial/i.test(u))) fields.modifiers.push('Commercial');
  else if (/commercial/i.test(originalTitle)) fields.modifiers.push('Commercial');
  if (/barista/i.test(originalTitle)) fields.modifiers.push('Barista Style');
  if (/stainless\s*steel/i.test(originalTitle)) fields.modifiers.push('Stainless Steel');

  // ===== PHASE 2: DETECT CATEGORY =====
  let category = 'generic';
  if (/snow\s+cone|shaved\s+ice|ice\s+shaver/i.test(originalTitle)) category = 'snow_cone';
  else if (/espresso\s*machine|espresso\s*coffee\s*maker/i.test(originalTitle)) category = 'espresso';
  else if (/(?:cold\s*press|slow\s*masticating|masticating)\s*juicer|juice\s*extractor|\bjuicer\b/i.test(originalTitle)) category = 'juicer';
  else if (/air\s*fryer/i.test(originalTitle)) category = 'air_fryer';
  else if (/blender/i.test(originalTitle)) category = 'blender';
  else if (/coffee\s*maker/i.test(originalTitle)) category = 'coffee_maker';
  else if (/mixer/i.test(originalTitle)) category = 'mixer';

  // ===== PHASE 3: CLASSIFY FIELDS INTO POSITIONAL SLOTS =====
  // Assembly order: Brand → Core Product Type → Key Specs → Features/Functions → Use Cases → Selling Points/Certs → Material/Color
  const brandSlot = { text: fields.brand || '', name: 'Brand' }; // Position 1
  const coreTypeSlot = []; // Position 2: highest search value product type
  const specSlot = []; // Position 3: numeric specs (output rate, wattage, pressure, capacity, size)
  const featureSlot = []; // Position 4: features/functions (grinder, frother, dual blades, etc.)
  const useCaseSlot = []; // Position 5: use cases (home, commercial, etc.)
  const sellingPointSlot = []; // Position 6: modifiers, certifications, drink types
  const materialColorSlot = []; // Position 7: material + color (always last)

  if (category === 'snow_cone') {
    const snowCone = fields.productTypes.find(t => /snow\s+cone\s+machine/i.test(t));
    if (snowCone) coreTypeSlot.push({ text: snowCone, name: 'Snow Cone Machine' });
    if (fields.outputRate) specSlot.push({ text: fields.outputRate, name: 'Output Rate' });
    const wattSpec = fields.numericSpecs.find(s => s.label === 'Wattage');
    if (wattSpec) specSlot.push({ text: wattSpec.normalized, name: 'Wattage' });
    if (fields.capacity) specSlot.push({ text: fields.capacity, name: 'Capacity' });
    const shavedIce = fields.productTypes.find(t => /shaved\s+ice\s+machine/i.test(t));
    if (shavedIce) featureSlot.push({ text: shavedIce, name: 'Shaved Ice Machine' });
    const iceShaver = fields.productTypes.find(t => /ice\s+shaver/i.test(t));
    if (iceShaver) featureSlot.push({ text: iceShaver, name: 'Electric Ice Shaver' });
    if (fields.features.includes('Dual Blades')) featureSlot.push({ text: 'with Dual Blades', name: 'Dual Blades' });
    if (fields.useCases.length) useCaseSlot.push({ text: fields.useCases[0], name: 'Use Case' });
    if (fields.certifications.includes('ETL Certified')) sellingPointSlot.push({ text: 'ETL Certified', name: 'ETL Certified' });
    const snowMaker = fields.productTypes.find(t => /snow\s+cone\s+maker/i.test(t));
    if (snowMaker) sellingPointSlot.push({ text: snowMaker, name: 'Snow Cone Maker' });
    if (fields.color) materialColorSlot.push({ text: fields.color, name: 'Color' });

  } else if (category === 'espresso') {
    const espressoMachine = fields.productTypes.find(t => /espresso\s+machine/i.test(t));
    if (espressoMachine) coreTypeSlot.push({ text: espressoMachine, name: 'Espresso Machine' });
    const barSpec = fields.numericSpecs.find(s => s.label === 'Pressure');
    if (barSpec) specSlot.push({ text: barSpec.normalized, name: 'Bar Pressure' });
    const wattSpec = fields.numericSpecs.find(s => s.label === 'Wattage');
    if (wattSpec) specSlot.push({ text: wattSpec.normalized, name: 'Wattage' });
    if (fields.capacity) specSlot.push({ text: fields.capacity.replace(' Capacity', '') + ' Water Tank', name: 'Water Tank' });
    if (fields.features.includes('with Grinder')) featureSlot.push({ text: 'with Grinder', name: 'Grinder' });
    if (fields.features.includes('with Milk Frother')) featureSlot.push({ text: 'with Milk Frother', name: 'Milk Frother' });
    const espressoMaker = fields.productTypes.find(t => /espresso\s+coffee\s*maker/i.test(t));
    if (espressoMaker) featureSlot.push({ text: espressoMaker, name: 'Espresso Coffee Maker' });
    if (fields.useCases.length) useCaseSlot.push({ text: fields.useCases[0], name: 'Use Case' });
    if (fields.modifiers.includes('Professional')) sellingPointSlot.push({ text: 'Professional', name: 'Professional' });
    if (fields.modifiers.includes('Barista Style')) sellingPointSlot.push({ text: 'Barista Style', name: 'Barista Style' });
    if (/latte/i.test(originalTitle)) sellingPointSlot.push({ text: 'Latte', name: 'Latte' });
    if (/cappuccino/i.test(originalTitle)) sellingPointSlot.push({ text: 'Cappuccino', name: 'Cappuccino' });
    if (/americano/i.test(originalTitle)) sellingPointSlot.push({ text: 'Americano', name: 'Americano' });
    if (fields.modifiers.includes('Stainless Steel')) materialColorSlot.push({ text: 'Stainless Steel', name: 'Material' });
    if (fields.color) materialColorSlot.push({ text: fields.color, name: 'Color' });

  } else if (category === 'juicer') {
    const juicerType = fields.productTypes[0] || 'Juicer';
    coreTypeSlot.push({ text: juicerType, name: 'Core Type' });
    const inchSpec = fields.numericSpecs.find(s => s.label === 'Size');
    if (inchSpec) specSlot.push({ text: inchSpec.normalized + ' Wide Feed Chute', name: 'Feed Chute' });
    const wattSpec = fields.numericSpecs.find(s => s.label === 'Wattage');
    if (wattSpec) specSlot.push({ text: wattSpec.normalized, name: 'Wattage' });
    if (fields.capacity) specSlot.push({ text: fields.capacity, name: 'Capacity' });
    if (fields.features.includes('BPA Free')) featureSlot.push({ text: 'BPA Free', name: 'BPA Free' });
    if (fields.features.includes('Easy to Clean')) featureSlot.push({ text: 'Easy to Clean', name: 'Easy to Clean' });
    if (fields.features.includes('High Juice Yield')) sellingPointSlot.push({ text: 'High Juice Yield', name: 'High Juice Yield' });
    if (fields.useCases.length) useCaseSlot.push({ text: fields.useCases[0], name: 'Use Case' });
    if (fields.features.includes('Compact')) sellingPointSlot.push({ text: 'Compact', name: 'Compact' });
    if (fields.features.includes('Quiet')) sellingPointSlot.push({ text: 'Quiet Motor', name: 'Quiet' });
    if (fields.color) materialColorSlot.push({ text: fields.color, name: 'Color' });

  } else {
    // Generic
    const coreType = fields.productTypes[0] || '';
    if (coreType) coreTypeSlot.push({ text: coreType, name: 'Core Type' });
    const wattSpec = fields.numericSpecs.find(s => s.label === 'Wattage');
    if (wattSpec) specSlot.push({ text: wattSpec.normalized, name: 'Wattage' });
    if (fields.capacity) specSlot.push({ text: fields.capacity, name: 'Capacity' });
    for (const f of fields.features.slice(0, 3)) featureSlot.push({ text: f, name: f });
    if (fields.useCases.length) useCaseSlot.push({ text: fields.useCases[0], name: 'Use Case' });
    for (const c of fields.certifications) sellingPointSlot.push({ text: c, name: c });
    if (fields.color) materialColorSlot.push({ text: fields.color, name: 'Color' });
  }

  // ===== PHASE 4: ASSEMBLE 3 VERSIONS =====
  // Structure: Brand → Core Type → Specs → Features → Use Case → Selling Points → Material/Color
  function clean(s) {
    return s.replace(/&/g, 'and').replace(/[,;]+/g, '').replace(/\s+/g, ' ').trim();
  }

  function assembleByVersion(version) {
    const parts = [];

    // 1. Brand (always first for Amazon compliance)
    if (brandSlot.text) parts.push(brandSlot.text);

    // 2. Core Product Type (highest search value, right after brand)
    for (const f of coreTypeSlot) parts.push(f.text);

    // 3. Key Specs (all for SEO/Bal, top 2 for Readable)
    if (version === 'read') {
      for (let i = 0; i < Math.min(2, specSlot.length); i++) parts.push(specSlot[i].text);
    } else {
      for (const f of specSlot) parts.push(f.text);
    }

    // 4. Features/Functions (all for SEO, top 2 for Bal, top 1 for Readable)
    if (version === 'seo') {
      for (const f of featureSlot) parts.push(f.text);
    } else if (version === 'bal') {
      for (let i = 0; i < Math.min(2, featureSlot.length); i++) parts.push(featureSlot[i].text);
    } else {
      for (let i = 0; i < Math.min(1, featureSlot.length); i++) parts.push(featureSlot[i].text);
    }

    // 5. Use Cases
    if (useCaseSlot.length) parts.push(useCaseSlot[0].text);

    // 6. Selling Points / Certifications (SEO=all, Bal=first 2, Read=first 1)
    if (version === 'seo') {
      for (const f of sellingPointSlot) parts.push(f.text);
    } else if (version === 'bal') {
      for (let i = 0; i < Math.min(2, sellingPointSlot.length); i++) parts.push(sellingPointSlot[i].text);
    } else {
      for (let i = 0; i < Math.min(1, sellingPointSlot.length); i++) parts.push(sellingPointSlot[i].text);
    }

    // 7. Material / Color (always last)
    for (const f of materialColorSlot) parts.push(f.text);

    let title = clean(parts.join(' '));

    // Trim from end if over max (only remove color/material then selling points, never core content)
    const maxLen = version === 'seo' ? 200 : version === 'bal' ? 180 : 165;
    if (title.length > maxLen) {
      for (const f of [...materialColorSlot].reverse()) {
        if (title.length <= maxLen) break;
        const fClean = clean(f.text);
        const idx = title.lastIndexOf(fClean);
        if (idx > -1) title = clean(title.slice(0, idx) + title.slice(idx + fClean.length));
      }
      for (const f of [...sellingPointSlot].reverse()) {
        if (title.length <= maxLen) break;
        const fClean = clean(f.text);
        const idx = title.lastIndexOf(fClean);
        if (idx > -1) title = clean(title.slice(0, idx) + title.slice(idx + fClean.length));
      }
      for (const f of [...featureSlot].reverse()) {
        if (title.length <= maxLen) break;
        const fClean = clean(f.text);
        const idx = title.lastIndexOf(fClean);
        if (idx > -1) title = clean(title.slice(0, idx) + title.slice(idx + fClean.length));
      }
    }

    return title;
  }

  let seoTitle = assembleByVersion('seo');
  let readTitle = assembleByVersion('read');
  let balTitle = assembleByVersion('bal');

  // ===== PHASE 5: BUILD CHANGE EXPLANATIONS =====
  function explainChanges(original, optimized) {
    const changes = [];
    const origLower = original.toLowerCase();

    // Brand position
    if (fields.brand && origLower.startsWith(fields.brand.toLowerCase())) {
      changes.push(`品牌名"${fields.brand}"保留在标题首位，符合Amazon品牌前置规范`);
    } else if (fields.brand) {
      changes.push(`品牌名"${fields.brand}"移至标题首位，确保品牌识别和Amazon合规`);
    }

    // & → and
    if (original.includes('&') && !optimized.includes('&')) {
      changes.push('将 & 替换为 and，符合亚马逊标题规范');
    }

    // % → Percent
    if (/[\d.]+%/.test(original) && !/[\d.]+%/.test(optimized)) {
      changes.push('将百分号(%)替换为 Percent，避免特殊字符问题');
    }

    // Commas removed
    if (/,/.test(original) && !/,/.test(optimized)) {
      changes.push('移除逗号分隔，改为空格连接，减少堆砌感');
    }

    // Parentheses removed
    if (/\(/.test(original) && !/\(/.test(optimized)) {
      changes.push('移除括号，将颜色/变体信息自然融入标题尾部');
    }

    // Duplicate word reduction
    const origWords = origLower.split(/\s+/);
    const origCounts = {};
    origWords.forEach(w => { if (w.length > 3) origCounts[w] = (origCounts[w] || 0) + 1; });
    const optWords = optimized.toLowerCase().split(/\s+/);
    const optCounts = {};
    optWords.forEach(w => { if (w.length > 3) optCounts[w] = (optCounts[w] || 0) + 1; });
    const reduced = Object.entries(origCounts).filter(([w, c]) => c > 2 && (optCounts[w] || 0) < c);
    if (reduced.length) {
      changes.push(`去重: ${reduced.map(([w, c]) => `"${w}"(${c}次→${optCounts[w]||1}次)`).join('、')}，保留首次出现`);
    }

    // Structure reordering
    if (coreTypeSlot.length > 0 && fields.brand) {
      const brandIdx = origLower.indexOf(fields.brand.toLowerCase());
      const coreIdx = origLower.indexOf(coreTypeSlot[0].text.toLowerCase().split(' ')[0]);
      if (brandIdx > coreIdx && coreIdx > -1) {
        changes.push(`重组顺序为: 品牌→核心产品词→规格→功能→场景→卖点→颜色，提升品牌识别和搜索效率`);
      }
    }

    if (changes.length === 0) {
      changes.push('标题结构已优化，保持核心信息完整，符合Amazon标题规范');
    }
    return changes;
  }

  const seoExplanation = explainChanges(originalTitle, seoTitle);
  const readExplanation = explainChanges(originalTitle, readTitle);
  const balExplanation = explainChanges(originalTitle, balTitle);

  // ===== PHASE 6: QUALITY CHECKS =====
  function checkQuality(title, version) {
    const c = {};
    c.charCount = title.length;
    c.brandFirst = fields.brand ? title.toLowerCase().startsWith(fields.brand.toLowerCase()) : true;
    c.brandIncluded = fields.brand ? title.toLowerCase().includes(fields.brand.toLowerCase()) : true;
    c.coreTypePresent = coreTypeSlot.length > 0 ? title.toLowerCase().includes(coreTypeSlot[0].text.toLowerCase().split(' ')[0]) : true;

    const targets = {
      seo: { min: 160, max: 190 },
      read: { min: 110, max: 160 },
      bal: { min: 140, max: 175 },
    };
    const t = targets[version] || targets.bal;

    // Field coverage across all slots
    c.coveredKeywords = [];
    c.missingP0 = [];
    const mandatorySlots = [brandSlot, ...coreTypeSlot, ...specSlot.slice(0, 2), ...featureSlot.slice(0, 1)];
    for (const f of mandatorySlots) {
      if (!f.text) continue;
      const checkWord = f.text.split(' ')[0].toLowerCase();
      if (title.toLowerCase().includes(checkWord)) {
        c.coveredKeywords.push(f.name);
      } else {
        c.missingP0.push(f.name);
      }
    }
    // Also report covered P1 fields
    const optionalSlots = [...specSlot.slice(2), ...featureSlot.slice(1), ...useCaseSlot, ...sellingPointSlot, ...materialColorSlot];
    for (const f of optionalSlots) {
      if (!f.text) continue;
      const checkWord = f.text.split(' ')[0].toLowerCase();
      if (title.toLowerCase().includes(checkWord)) c.coveredKeywords.push(f.name);
    }

    // Parameter integrity
    c.paramIntegrity = true;
    c.alteredParams = [];
    for (const spec of fields.numericSpecs) {
      const numVal = spec.value.replace(/,/g, '');
      if (!title.includes(numVal)) {
        c.paramIntegrity = false;
        c.alteredParams.push(spec.raw + ' → missing or changed');
      }
    }

    // Core word integrity
    c.coreWordIntegrity = true;
    c.droppedCoreWords = [];
    for (const pt of fields.productTypes) {
      const precedingWord = pt.split(' ').slice(-2, -1)[0];
      if (precedingWord && !title.toLowerCase().includes(precedingWord.toLowerCase())) {
        c.coreWordIntegrity = false;
        c.droppedCoreWords.push(pt);
      }
    }

    // Certification check
    c.droppedCertifications = [];
    for (const cert of fields.certifications) {
      if (!title.toLowerCase().includes(cert.toLowerCase().split(' ')[0])) {
        c.droppedCertifications.push(cert);
      }
    }

    c.hasSpecialChars = /["""\u201c\u201d\u2033&%]/.test(title);

    const wc = {};
    title.toLowerCase().split(/\s+/).forEach(w => { const wl = w.replace(/[.,;:]/g, ''); if (wl.length > 3) wc[wl] = (wc[wl] || 0) + 1; });
    c.repeatedWords = Object.entries(wc).filter(([, v]) => v > 2).map(([w]) => w);

    c.parameterClaims = [];
    for (const spec of fields.numericSpecs) {
      if (title.includes(spec.value.replace(/,/g, ''))) {
        c.parameterClaims.push(spec.label + ': ' + spec.normalized);
      }
    }

    c.tooShort = title.length < 100;
    c.belowTarget = title.length < t.min;
    c.overTarget = title.length > t.max;

    // SCORING
    let score = 10;
    if (c.charCount >= t.min && c.charCount <= t.max) score -= 0;
    else if (c.charCount < 80) score -= 5;
    else if (c.charCount < 100) score -= 3;
    else if (c.charCount < t.min) score -= 1;
    else if (c.charCount > t.max) score -= 1;

    if (!c.brandFirst) score -= 1;
    if (!c.coreTypePresent) score -= 2;
    if (c.missingP0.length > 0) score -= Math.min(c.missingP0.length * 2, 4);
    if (!c.paramIntegrity) score -= 4;
    if (!c.coreWordIntegrity) score -= 4;
    if (c.droppedCertifications.length > 0) score -= Math.min(c.droppedCertifications.length * 2, 3);
    if (c.hasSpecialChars) score -= 1;
    if (c.repeatedWords.length > 0) score -= 1;

    score = Math.max(0, Math.min(10, score));

    if (!c.paramIntegrity || !c.coreWordIntegrity) c.qualityGrade = 'Poor';
    else if (score >= 9) c.qualityGrade = 'Optimized';
    else if (score >= 7 && c.missingP0.length === 0) c.qualityGrade = 'Great';
    else if (score >= 5 && c.charCount >= 80) c.qualityGrade = 'Good';
    else if (c.charCount < 80) c.qualityGrade = 'Fair';
    else c.qualityGrade = 'Fair';

    return c;
  }

  const seoChecks = checkQuality(seoTitle, 'seo');
  const readChecks = checkQuality(readTitle, 'read');
  const balChecks = checkQuality(balTitle, 'bal');

  // ===== PHASE 7: BUILD WARNINGS =====
  function buildWarnings(checks) {
    const w = [];
    if (checks.tooShort) w.push({ type: 'yellow', text: '标题偏短，可能损失搜索词覆盖，建议补充核心功能参数或使用场景。' });
    if (checks.missingP0.length > 0) w.push({ type: 'red', text: `标题缺失核心转化字段: ${checks.missingP0.join('、')}，可能影响点击率和转化率。` });
    if (!checks.paramIntegrity) w.push({ type: 'red', text: `参数被篡改: ${checks.alteredParams.join('；')}，原始数值必须保留。` });
    if (!checks.coreWordIntegrity) w.push({ type: 'red', text: `核心词被删除: ${checks.droppedCoreWords.join('、')}，类目核心词不可丢弃。` });
    if (checks.droppedCertifications.length > 0) w.push({ type: 'yellow', text: `认证被删除: ${checks.droppedCertifications.join('、')}，建议保留认证信息。` });
    if (checks.hasSpecialChars) w.push({ type: 'yellow', text: '标题包含特殊字符，建议替换为标准格式。' });
    if (checks.repeatedWords.length > 0) w.push({ type: 'yellow', text: `标题存在重复关键词: ${checks.repeatedWords.join('、')}，建议合并。` });
    if (checks.parameterClaims.length > 0) w.push({ type: 'info', text: `${checks.parameterClaims.join('、')}属于参数型声明，请确保与后台属性和说明书一致。` });
    return w;
  }

  return [
    { label: 'SEO优先版', desc: '关键词覆盖最大化，适合新品、广告投放、搜索流量导向', title: seoTitle, charCount: seoTitle.length, qualityGrade: seoChecks.qualityGrade, coveredKeywords: seoChecks.coveredKeywords, missingP0: seoChecks.missingP0, paramIntegrity: seoChecks.paramIntegrity, changes: seoExplanation, warnings: buildWarnings(seoChecks) },
    { label: '可读性优先版', desc: '自然流畅，保留核心功能，适合品牌调性和前台点击', title: readTitle, charCount: readTitle.length, qualityGrade: readChecks.qualityGrade, coveredKeywords: readChecks.coveredKeywords, missingP0: readChecks.missingP0, paramIntegrity: readChecks.paramIntegrity, changes: readExplanation, warnings: buildWarnings(readChecks) },
    { label: '平衡版', desc: '兼顾SEO、CDQ合规和用户阅读，推荐默认使用', title: balTitle, charCount: balTitle.length, qualityGrade: balChecks.qualityGrade, coveredKeywords: balChecks.coveredKeywords, missingP0: balChecks.missingP0, paramIntegrity: balChecks.paramIntegrity, changes: balExplanation, warnings: buildWarnings(balChecks) },
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

    if (i === bullets.length - 1 && brandFluffWords.some(w => origLower.includes(w))) {
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

    if (changes.length === 0) {
      const colonIdx = original.indexOf(':');
      if (colonIdx < 0 || colonIdx > 30) {
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

    if (/[\d.]+%/.test(rewritten)) {
      rewritten = rewritten.replace(/(\d+\.?\d*)%/g, '$1 Percent');
      changes.push({ type: 'compliance', desc: '百分号替换为Percent，符合亚马逊文案规范' });
    }

    if (titleLower.includes('bpa') && i === 0 && !origLower.includes('bpa')) {
      rewritten = `BPA-FREE & SAFE: ${rewritten}`;
      changes.push({ type: 'keyword', desc: '标题提及BPA-Free但五点未展开，补充关键词' });
    }

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

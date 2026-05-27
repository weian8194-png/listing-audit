// Listing CDQ/LQI Audit API v3 - Category-Aware Title Optimization Engine
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
      '替换为实际卖点(清洁方式/配件/保修)，如: "Easy Cleanup & Complete Package: Detachable parts rinse clean in 60 seconds. Includes 2 cups, cleaning brush, and recipe booklet"');
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

  // ===== TITLE OPTIMIZATION =====
  const titleOpts = generateTitleOptions(title, data.brand, specs, bulletsText);

  // ===== BULLET REWRITING =====
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

// ========== TITLE OPTIMIZATION ENGINE v3 ==========
// 核心原则：字段保留优先，重组而非删减，类目感知关键词优先级
function generateTitleOptions(originalTitle, brand, specs, bulletsText) {
  const titleLower = originalTitle.toLowerCase();
  const brandClean = (brand || '').replace('Visit the ', '').replace(' Store', '').trim();
  const specEntries = Object.entries(specs || {});

  // ===== 1. CATEGORY DETECTION =====
  let category = 'generic';
  if (/espresso\s*machine|espresso\s*coffee\s*maker/i.test(originalTitle)) category = 'espresso';
  else if (/(?:cold\s*press|slow\s*masticating|masticating)\s*juicer|juice\s*extractor|\bjuicer\b/i.test(originalTitle)) category = 'juicer';
  else if (/air\s*fryer/i.test(originalTitle)) category = 'air_fryer';
  else if (/blender/i.test(originalTitle)) category = 'blender';
  else if (/coffee\s*maker/i.test(originalTitle)) category = 'coffee_maker';
  else if (/mixer/i.test(originalTitle)) category = 'mixer';

  // ===== 2. EXTRACT ALL FIELDS =====

  // Color from specs
  let color = '';
  for (const [k, v] of specEntries) { if (/^color$/i.test(k.trim())) { color = String(v).trim(); break; } }

  // Wattage from specs then title
  let wattage = '';
  for (const [k, v] of specEntries) { if (/wattage/i.test(k)) { wattage = String(v).replace(/[^0-9.]/g, '') + 'W'; break; } }
  if (!wattage) { const m = originalTitle.match(/(\d{3,4})\s*W(?:att)?/i); if (m) wattage = m[1] + 'W'; }

  // Capacity from specs then title
  let capacity = '';
  for (const [k, v] of specEntries) { if (/capacity|volume|tank\s*capacity/i.test(k)) { capacity = String(v).trim(); break; } }
  if (!capacity) { const m = originalTitle.match(/(\d+\.?\d*)\s*(Liter|L\b|oz|Quart|Qt|Cup|ml)\b/i); if (m) capacity = m[0].trim(); }

  // Pressure (Bar)
  let pressure = '';
  const barMatch = originalTitle.match(/(\d+)\s*Bar/i);
  if (barMatch) pressure = barMatch[0];

  // Feed Chute Size
  let feedChute = '';
  const chuteMatch = originalTitle.match(/([\d.]+)\s*["""″\u2033]|([\d.]+)\s*-?\s*[Ii]nch/);
  if (chuteMatch) { feedChute = (chuteMatch[1] || chuteMatch[2]) + ' Inch'; }

  // RPM
  let rpm = '';
  const rpmMatch = originalTitle.match(/(\d+)\s*RPM/i);
  if (rpmMatch) rpm = rpmMatch[0];

  // Material
  let material = '';
  if (/stainless[\s-]*steel/i.test(titleLower)) material = 'Stainless Steel';

  // Core product type
  let coreType = '';
  if (category === 'espresso') {
    coreType = 'Espresso Machine';
  } else if (category === 'juicer') {
    if (/cold\s*press/i.test(titleLower)) coreType = 'Cold Press Juicer';
    else if (/slow\s*masticating|masticating/i.test(titleLower)) coreType = 'Slow Masticating Juicer';
    else coreType = 'Juicer';
  } else {
    const typePatterns = [
      { pat: /((?:air\s+fryer|deep\s+fryer)\s*(?:oven)?)/i },
      { pat: /((?:blender|food\s+processor))/i },
      { pat: /((?:rice|slow|pressure)\s*cooker)/i },
      { pat: /((?:stand\s*|hand\s*)?mixer)/i },
      { pat: /((?:ice\s*cream|gelato)\s*maker)/i },
      { pat: /((?:waffle|sandwich)\s*maker)/i },
      { pat: /((?:ice|nugget\s*ice)\s*maker)/i },
      { pat: /((?:toaster|toaster\s*oven))/i },
      { pat: /(\w+\s+machine)/i },
      { pat: /(\w+\s+maker)/i },
    ];
    for (const { pat } of typePatterns) { const m = originalTitle.match(pat); if (m) { coreType = m[1].trim(); break; } }
    if (!coreType) coreType = 'Appliance';
  }

  function normCap(cap) {
    return cap.replace(/Liters?/i, 'Liter').replace(/Cups?/i, 'Cup').replace(/Ounces?/i, 'Oz').trim();
  }

  // ===== 3. CATEGORY-SPECIFIC BUILDERS =====

  function buildEspressoSEO() {
    const p = [];
    if (brandClean) p.push(brandClean);
    p.push('Espresso Machine');
    if (/with\s*grinder|built[\s-]*in\s*grinder/i.test(titleLower)) p.push('with Grinder');
    if (pressure) p.push(pressure);
    if (/professional/i.test(titleLower)) p.push('Professional');
    p.push('Espresso Coffee Maker');
    if (wattage) p.push(wattage);
    if (/milk\s*frother|steam\s*wand/i.test(titleLower)) p.push('with Milk Frother');
    if (capacity) p.push(normCap(capacity) + ' Water Tank');
    const drinks = [];
    if (/latte/i.test(titleLower)) drinks.push('Latte');
    if (/cappuccino/i.test(titleLower)) drinks.push('Cappuccino');
    if (/americano/i.test(titleLower)) drinks.push('Americano');
    if (drinks.length) p.push('for ' + drinks.join(' '));
    if (/home/i.test(titleLower)) p.push('Home Kitchen');
    if (/barista/i.test(titleLower) && !/home/i.test(titleLower)) p.push('Barista Style');
    else if (/barista/i.test(titleLower)) p.push('Barista');
    if (color) p.push(color);
    return p;
  }

  function buildEspressoReadable() {
    const p = [];
    if (brandClean) p.push(brandClean);
    if (pressure) p.push(pressure);
    p.push('Espresso Machine');
    if (/with\s*grinder|built[\s-]*in\s*grinder/i.test(titleLower)) p.push('with Grinder');
    if (/milk\s*frother|steam\s*wand/i.test(titleLower)) p.push('and Milk Frother');
    const drinks = [];
    if (/latte/i.test(titleLower)) drinks.push('Latte');
    if (/cappuccino/i.test(titleLower)) drinks.push('Cappuccino');
    if (drinks.length) p.push('for ' + drinks.join(' '));
    if (/barista/i.test(titleLower) && /home/i.test(titleLower)) p.push('and Home Barista Coffee');
    else if (/home/i.test(titleLower)) p.push('for Home Kitchen');
    else if (/barista/i.test(titleLower)) p.push('for Barista Coffee');
    if (color) p.push(color);
    return p;
  }

  function buildEspressoBalanced() {
    const p = [];
    if (brandClean) p.push(brandClean);
    p.push('Espresso Machine');
    if (/with\s*grinder|built[\s-]*in\s*grinder/i.test(titleLower)) p.push('with Grinder');
    if (pressure) p.push(pressure);
    p.push('Espresso Coffee Maker');
    if (wattage) p.push(wattage);
    if (/milk\s*frother|steam\s*wand/i.test(titleLower)) p.push('with Milk Frother');
    if (capacity) p.push(normCap(capacity) + ' Water Tank');
    const drinks = [];
    if (/latte/i.test(titleLower)) drinks.push('Latte');
    if (/cappuccino/i.test(titleLower)) drinks.push('Cappuccino');
    if (drinks.length) p.push('for ' + drinks.join(' '));
    if (/home/i.test(titleLower)) p.push('Home Kitchen');
    if (color) p.push(color);
    return p;
  }

  function buildJuicerSEO() {
    const p = [];
    if (brandClean) p.push(brandClean);
    p.push(coreType);
    if (feedChute) p.push(feedChute + ' Wide Feed Chute');
    if (/whole\s*(fruit|vegetable)/i.test(titleLower)) p.push('for Whole Vegetables and Fruits');
    else if (/vegetables?\s*and\s*fruits?|fruits?\s*and\s*vegetables?/i.test(titleLower)) p.push('for Vegetables and Fruits');
    if (wattage) p.push(wattage);
    if (rpm) p.push(rpm);
    if (/high\s*juice\s*yield|\d+\.?\d*%\s*juice/i.test(titleLower)) p.push('High Juice Yield');
    if (/bpa[\s-]*free/i.test(titleLower)) p.push('BPA Free');
    if (/easy[\s-]*(?:to[\s-]*)?clean/i.test(titleLower)) p.push('Easy to Clean');
    if (capacity) p.push(normCap(capacity));
    if (color) p.push(color);
    return p;
  }

  function buildJuicerReadable() {
    const p = [];
    if (brandClean) p.push(brandClean);
    if (feedChute) p.push(feedChute);
    p.push(coreType);
    if (/bpa[\s-]*free/i.test(titleLower)) p.push('BPA Free');
    if (/whole\s*(fruit|vegetable)/i.test(titleLower)) p.push('for Whole Vegetables and Fruits');
    else if (/vegetables?\s*and\s*fruits?/i.test(titleLower)) p.push('for Vegetables and Fruits');
    if (color) p.push(color);
    return p;
  }

  function buildJuicerBalanced() {
    const p = [];
    if (brandClean) p.push(brandClean);
    p.push(coreType);
    if (feedChute) p.push(feedChute + ' Feed Chute');
    if (wattage) p.push(wattage);
    if (/bpa[\s-]*free/i.test(titleLower)) p.push('BPA Free');
    if (/high\s*juice\s*yield|\d+\.?\d*%\s*juice/i.test(titleLower)) p.push('High Juice Yield');
    if (/easy[\s-]*(?:to[\s-]*)?clean/i.test(titleLower)) p.push('Easy to Clean');
    if (/whole\s*(fruit|vegetable)/i.test(titleLower)) p.push('for Whole Vegetables and Fruits');
    else if (/vegetables?\s*and\s*fruits?/i.test(titleLower)) p.push('for Vegetables and Fruits');
    if (capacity) p.push(normCap(capacity));
    if (color) p.push(color);
    return p;
  }

  function buildGenericSEO() {
    const p = [];
    if (brandClean) p.push(brandClean);
    if (coreType) p.push(coreType);
    if (wattage) p.push(wattage);
    if (capacity) p.push(normCap(capacity));
    if (feedChute) p.push(feedChute + ' Wide Feed Chute');
    if (rpm) p.push(rpm);
    if (/bpa[\s-]*free/i.test(titleLower)) p.push('BPA Free');
    if (/easy[\s-]*(?:to[\s-]*)?clean/i.test(titleLower)) p.push('Easy to Clean');
    if (/dishwasher[\s-]*safe/i.test(titleLower)) p.push('Dishwasher Safe');
    if (material) p.push(material);
    if (/home/i.test(titleLower) && /kitchen/i.test(titleLower)) p.push('for Home Kitchen');
    else if (/home/i.test(titleLower)) p.push('for Home');
    else if (/kitchen/i.test(titleLower)) p.push('for Kitchen');
    if (/commercial/i.test(titleLower)) p.push('Commercial');
    if (color) p.push(color);
    return p;
  }

  function buildGenericReadable() {
    const p = [];
    if (brandClean) p.push(brandClean);
    if (coreType) p.push(coreType);
    if (wattage) p.push(wattage);
    if (/home/i.test(titleLower)) p.push('for Home Kitchen');
    if (color) p.push(color);
    return p;
  }

  function buildGenericBalanced() {
    const p = [];
    if (brandClean) p.push(brandClean);
    if (coreType) p.push(coreType);
    if (wattage) p.push(wattage);
    if (capacity) p.push(normCap(capacity));
    if (/bpa[\s-]*free/i.test(titleLower)) p.push('BPA Free');
    if (/easy[\s-]*(?:to[\s-]*)?clean/i.test(titleLower)) p.push('Easy to Clean');
    if (material) p.push(material);
    if (/home/i.test(titleLower)) p.push('for Home Kitchen');
    if (color) p.push(color);
    return p;
  }

  // ===== 4. SELECT BUILDERS & ASSEMBLE =====
  let seoParts, readParts, balParts;
  if (category === 'espresso') { seoParts = buildEspressoSEO(); readParts = buildEspressoReadable(); balParts = buildEspressoBalanced(); }
  else if (category === 'juicer') { seoParts = buildJuicerSEO(); readParts = buildJuicerReadable(); balParts = buildJuicerBalanced(); }
  else { seoParts = buildGenericSEO(); readParts = buildGenericReadable(); balParts = buildGenericBalanced(); }

  function clean(s) {
    return s.replace(/["""\u201c\u201d\u2033]/g, 'Inch ')
      .replace(/(\d+\.?\d*)%/g, '$1 Percent')
      .replace(/&/g, 'and')
      .replace(/[,;]+/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  // Smart dedup: only remove generic words appearing 3+ times (machine, maker)
  function smartDedup(titleStr) {
    const words = titleStr.split(/\s+/);
    const count = {};
    words.forEach(w => { const wl = w.toLowerCase().replace(/[.,;:]/g, ''); if (wl.length > 2) count[wl] = (count[wl] || 0) + 1; });
    const result = [];
    const seen = {};
    for (const w of words) {
      const wl = w.toLowerCase().replace(/[.,;:]/g, '');
      // Only dedup ultra-generic words (machine, maker, the) when 3+ occurrences
      if (['machine', 'maker', 'the'].includes(wl) && (count[wl] || 0) > 2 && seen[wl] >= 2) continue;
      seen[wl] = (seen[wl] || 0) + 1;
      result.push(w);
    }
    return result.join(' ');
  }

  let seoTitle = smartDedup(clean(seoParts.join(' ')));
  let readTitle = smartDedup(clean(readParts.join(' ')));
  let balTitle = smartDedup(clean(balParts.join(' ')));

  // Trim from end if over max
  function trimToMax(title, maxLen) {
    if (title.length <= maxLen) return title;
    const words = title.split(' ');
    while (words.join(' ').length > maxLen && words.length > 5) words.pop();
    return words.join(' ');
  }
  seoTitle = trimToMax(seoTitle, 200);
  balTitle = trimToMax(balTitle, 175);
  readTitle = trimToMax(readTitle, 155);

  // ===== 5. AUTO-SUPPLEMENT SHORT SEO TITLES =====
  if (seoTitle.length < 160 && category === 'espresso') {
    const extras = [];
    if (/professional/i.test(titleLower) && !/professional/i.test(seoTitle)) extras.push('Professional');
    if (/americano/i.test(titleLower) && !/americano/i.test(seoTitle)) extras.push('Americano');
    if (/stainless\s*steel/i.test(titleLower) && !/stainless/i.test(seoTitle)) extras.push('Stainless Steel');
    if (/compact/i.test(titleLower) && !/compact/i.test(seoTitle)) extras.push('Compact');
    if (/semi[\s-]*automatic/i.test(titleLower) && !/semi/i.test(seoTitle)) extras.push('Semi Automatic');
    if (/touch\s*screen/i.test(titleLower) && !/touch/i.test(seoTitle)) extras.push('Touch Screen');
    if (/removable/i.test(titleLower) && !/removable/i.test(seoTitle)) extras.push('Removable Water Tank');
    for (const extra of extras) {
      if (seoTitle.length + extra.length + 1 <= 195) {
        if (color && seoTitle.toLowerCase().endsWith(color.toLowerCase())) {
          seoTitle = seoTitle.slice(0, seoTitle.length - color.length).trim() + ' ' + extra + ' ' + color;
        } else {
          seoTitle += ' ' + extra;
        }
      }
    }
  }
  if (seoTitle.length < 160 && category === 'juicer') {
    const extras = [];
    if (/quiet/i.test(titleLower) && !/quiet/i.test(seoTitle)) extras.push('Quiet Motor');
    if (/reverse/i.test(titleLower) && !/reverse/i.test(seoTitle)) extras.push('Reverse Function');
    if (/drip[\s-]*free|anti[\s-]*drip/i.test(titleLower) && !/drip/i.test(seoTitle)) extras.push('Anti Drip');
    if (/compact/i.test(titleLower) && !/compact/i.test(seoTitle)) extras.push('Compact');
    if (/dishwasher/i.test(titleLower) && !/dishwasher/i.test(seoTitle)) extras.push('Dishwasher Safe');
    if (/nutrition/i.test(titleLower) && !/nutrition/i.test(seoTitle)) extras.push('Nutrition');
    for (const extra of extras) {
      if (seoTitle.length + extra.length + 1 <= 195) {
        if (color && seoTitle.toLowerCase().endsWith(color.toLowerCase())) {
          seoTitle = seoTitle.slice(0, seoTitle.length - color.length).trim() + ' ' + extra + ' ' + color;
        } else {
          seoTitle += ' ' + extra;
        }
      }
    }
  }

  // ===== 6. QUALITY CHECKS =====
  function checkTitleQuality(title, targetMin, targetMax) {
    const c = {};
    c.charCount = title.length;
    c.brandFirst = brandClean ? title.toLowerCase().startsWith(brandClean.toLowerCase()) : true;
    c.hasCoreType = coreType ? title.toLowerCase().includes(coreType.toLowerCase().split(' ').slice(-1)[0]) : true;
    c.hasSpecialChars = /["""\u201c\u201d\u2033&%]/.test(title);

    // Repeated words (>2 occurrences of same word)
    const wc = {};
    title.toLowerCase().split(/\s+/).forEach(w => { const wl = w.replace(/[.,;:]/g, ''); if (wl.length > 3) wc[wl] = (wc[wl] || 0) + 1; });
    c.repeatedWords = Object.entries(wc).filter(([, v]) => v > 2).map(([w]) => w);

    // Field coverage
    c.missingP0 = [];
    c.coveredKeywords = [];
    if (brandClean && c.brandFirst) c.coveredKeywords.push('Brand');
    if (c.hasCoreType && coreType) c.coveredKeywords.push(coreType);

    if (category === 'espresso') {
      const p0 = [
        { name: 'Grinder', test: /grinder/i },
        { name: 'Bar Pressure', test: /\d+\s*bar/i },
        { name: 'Milk Frother', test: /milk\s*frother|frother/i },
        { name: 'Home Use', test: /home/i },
      ];
      const p1 = [
        { name: 'Wattage', test: /\d{3,4}w/i },
        { name: 'Water Tank', test: /water\s*tank|liter/i },
        { name: 'Latte', test: /latte/i },
        { name: 'Cappuccino', test: /cappuccino/i },
        { name: 'Professional', test: /professional/i },
        { name: 'Espresso Coffee Maker', test: /espresso\s*coffee\s*maker/i },
      ];
      for (const f of p0) { if (f.test.test(title)) c.coveredKeywords.push(f.name); else c.missingP0.push(f.name); }
      for (const f of p1) { if (f.test.test(title)) c.coveredKeywords.push(f.name); }
    } else if (category === 'juicer') {
      const p0 = [
        { name: 'Feed Chute', test: /inch|chute/i },
        { name: 'BPA Free', test: /bpa/i },
        { name: 'Easy to Clean', test: /easy.*clean/i },
      ];
      const p1 = [
        { name: 'Wattage', test: /\d{3,4}w/i },
        { name: 'Juice Yield', test: /yield|percent/i },
        { name: 'Capacity', test: /liter|oz|cup|capacity/i },
      ];
      for (const f of p0) { if (f.test.test(title)) c.coveredKeywords.push(f.name); else c.missingP0.push(f.name); }
      for (const f of p1) { if (f.test.test(title)) c.coveredKeywords.push(f.name); }
    }
    if (color && title.toLowerCase().includes(color.toLowerCase())) c.coveredKeywords.push('Color');

    // Parameter claims needing verification
    c.parameterClaims = [];
    if (/\d+\s*bar/i.test(title)) c.parameterClaims.push('Bar Pressure');
    if (/\d{3,4}w/i.test(title)) c.parameterClaims.push('Wattage');
    if (/liter/i.test(title)) c.parameterClaims.push('Capacity');

    // Length
    c.tooShort = title.length < 100;
    c.belowTarget = title.length < targetMin;
    c.overTarget = title.length > targetMax;

    // Quality grade
    let gs = 0;
    if (title.length >= targetMin && title.length <= targetMax) gs += 2; else if (title.length >= 100) gs += 1;
    if (c.brandFirst) gs += 2;
    if (c.missingP0.length === 0) gs += 3; else if (c.missingP0.length <= 1) gs += 1;
    if (!c.hasSpecialChars) gs += 1;
    if (c.repeatedWords.length === 0) gs += 1;
    if (c.hasCoreType) gs += 1;
    if (gs >= 9) c.qualityGrade = 'Optimized';
    else if (gs >= 7) c.qualityGrade = 'Great';
    else if (gs >= 5) c.qualityGrade = 'Good';
    else if (gs >= 3) c.qualityGrade = 'Fair';
    else c.qualityGrade = 'Poor';

    return c;
  }

  const seoChecks = checkTitleQuality(seoTitle, 160, 190);
  const balChecks = checkTitleQuality(balTitle, 140, 170);
  const readChecks = checkTitleQuality(readTitle, 110, 150);

  // ===== 7. BUILD WARNINGS =====
  function buildWarnings(checks) {
    const w = [];
    if (checks.tooShort) w.push({ type: 'yellow', text: '标题偏短，可能损失搜索词覆盖，建议补充核心功能参数或使用场景。' });
    if (checks.missingP0.length > 0) w.push({ type: 'red', text: `标题缺失核心转化字段: ${checks.missingP0.join('、')}，可能影响点击率和转化率。` });
    if (checks.hasSpecialChars) w.push({ type: 'yellow', text: '标题包含特殊字符，建议替换为标准格式。' });
    if (checks.repeatedWords.length > 0) w.push({ type: 'yellow', text: `标题存在重复关键词: ${checks.repeatedWords.join('、')}，建议合并同义词。` });
    if (checks.parameterClaims.length > 0) w.push({ type: 'info', text: `${checks.parameterClaims.join('、')}属于参数型声明，请确保与后台属性和说明书一致。` });
    return w;
  }

  return [
    { label: 'SEO优先版', desc: '关键词覆盖最大化，适合新品、广告投放、搜索流量导向', title: seoTitle, charCount: seoTitle.length, qualityGrade: seoChecks.qualityGrade, coveredKeywords: seoChecks.coveredKeywords, missingP0: seoChecks.missingP0, warnings: buildWarnings(seoChecks) },
    { label: '可读性优先版', desc: '自然流畅，保留核心功能，适合品牌调性和前台点击', title: readTitle, charCount: readTitle.length, qualityGrade: readChecks.qualityGrade, coveredKeywords: readChecks.coveredKeywords, missingP0: readChecks.missingP0, warnings: buildWarnings(readChecks) },
    { label: '平衡版', desc: '兼顾SEO、CDQ合规和用户阅读，推荐默认使用', title: balTitle, charCount: balTitle.length, qualityGrade: balChecks.qualityGrade, coveredKeywords: balChecks.coveredKeywords, missingP0: balChecks.missingP0, warnings: buildWarnings(balChecks) },
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

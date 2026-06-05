// Listing CDQ/LQI Audit API v3.0 - V3.0逻辑修正版
// 1. 属性遗漏判断全部下线 2. 标题只做拼写/语法纠错 3. 五点只做拼写/语法纠错
// 4. LQI竞品对比语言维度删除 5. Power Plug Type和Power Source不交叉比对
export const config = { runtime: "edge" };
const RAPIDAPI_HOST = "real-time-amazon-data.p.rapidapi.com";
const RAPIDAPI_KEY = process.env.RAPIDAPIKEY || "";
function jsonRes(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
  });
}
async function fetchAmazonData(asin) {
  if (!RAPIDAPI_KEY) {
    return { error: "API key not configured. Please set RAPIDAPIKEY environment variable.", asin };
  }
  const url = `https://${RAPIDAPI_HOST}/product-details?asin=${asin}&country=US`;
  try {
    const resp = await fetch(url, {
      headers: {
        "x-rapidapi-host": RAPIDAPI_HOST,
        "x-rapidapi-key": RAPIDAPI_KEY
      },
      signal: AbortSignal.timeout(25e3)
    });
    if (!resp.ok) {
      const body = await resp.text();
      return { error: `API returned ${resp.status}: ${body.slice(0, 200)}`, asin };
    }
    const json = await resp.json();
    if (json.message && json.message.includes("not subscribed")) {
      return { error: "RapidAPI subscription required. Please subscribe to Real-Time Amazon Data API (free tier available).", asin };
    }
    const product = json.data;
    if (!product || !product.product_title) {
      return { error: "No product data returned. ASIN may be invalid or product unavailable.", asin };
    }
    const data = {
      asin,
      url: `https://www.amazon.com/dp/${asin}`,
      title: product.product_title || "N/A",
      brand: (product.product_byline || "N/A").replace("Visit the ", "").replace(" Store", ""),
      price: "",
      original_price: "",
      rating: product.product_star_rating?.toString() || "N/A",
      review_count: product.product_num_ratings?.toString() || "N/A",
      bullets: [],
      tech_specs: {},
      images_count: 0,
      has_video: false,
      has_aplus: false,
      bsr_rank: "N/A",
      bsr_category: "N/A",
      deal_type: "none",
      is_amazon_choice: product.is_amazon_choice || false,
      is_best_seller: product.is_best_seller || false,
      availability: product.product_availability || "",
      sales_volume: product.sales_volume || ""
    };
    if (product.product_price) data.price = String(product.product_price).replace(/[^0-9.]/g, "");
    if (product.product_original_price) data.original_price = String(product.product_original_price).replace(/[^0-9.]/g, "");
    if (product.deal_badge === "Limited time deal") data.deal_type = "BD";
    if (Array.isArray(product.about_product)) {
      data.bullets = product.about_product.filter((b) => b && b.trim().length > 5).slice(0, 5);
    }
    if (product.product_information && typeof product.product_information === "object") {
      for (const [k, v] of Object.entries(product.product_information)) {
        if (typeof v === "string" || typeof v === "number") {
          data.tech_specs[k] = String(v);
        }
      }
    }
    if (Array.isArray(product.product_photos)) data.images_count = product.product_photos.length;
    data.has_video = Array.isArray(product.product_videos) && product.product_videos.length > 0;
    data.has_aplus = !!product.has_aplus;
    if (data.tech_specs["Best Sellers Rank"]) {
      const bsrStr = data.tech_specs["Best Sellers Rank"];
      const bsrMatch = bsrStr.match(/#([\d,]+)/);
      if (bsrMatch) data.bsr_rank = bsrMatch[1].replace(/,/g, "");
      const catMatch = bsrStr.match(/in\s+([^((]+)/);
      if (catMatch) data.bsr_category = catMatch[1].trim();
    }
    return data;
  } catch (err) {
    return { error: `Fetch failed: ${err.message}`, asin };
  }
}
function findAttrInListing(attrName, title, bullets, specs) {
  const attrLower = attrName.toLowerCase();
  const aliases = {
    "noise level": ["noise", "decibel", "db", "quiet", "sound level", "operating noise"],
    "certification": ["certified", "certification", "ul listed", "etl", "ce", "fcc", "energy star", "ul certified"],
    "material": ["material", "stainless steel", "bpa-free", "bpa free", "plastic", "aluminum", "silicone", "glass", "bamboo"],
    "package dimensions": ["package dimension", "package size", "boxed dimension", "product dimension", "item dimension"],
    "wattage": ["wattage", "watt", "power consumption", "rated power"],
    "item weight": ["weight", "lb", "kg", "ounce", "pound"],
    "voltage": ["voltage", "volt", "v ac", "v dc", "110v", "120v", "220v", "240v"],
    "capacity": ["capacity", "volume", "quart", "liter", "can hold", "cubic"],
    "color": ["color", "colour"]
  };
  const keywords = aliases[attrLower] || [attrLower];
  const titleLower = title.toLowerCase();
  const bulletsText = bullets.join(" ").toLowerCase();
  for (const [k, v] of Object.entries(specs)) {
    const kLower = k.toLowerCase();
    if (keywords.some((kw) => kLower.includes(kw))) return { found: true, location: "specs" };
    const vLower = String(v).toLowerCase();
    if (keywords.some((kw) => vLower.includes(kw))) return { found: true, location: "specs" };
  }
  if (keywords.some((kw) => titleLower.includes(kw))) return { found: true, location: "title" };
  if (keywords.some((kw) => bulletsText.includes(kw))) return { found: true, location: "bullets" };
  return { found: false, location: "" };
}
function hasComparativeLanguage(bullets) {
  if (!bullets || bullets.length === 0) return false;
  const text = bullets.join(" ").toLowerCase();
  const comparisonWords = [
    "unlike",
    "compared to",
    "compared with",
    "vs",
    "versus",
    "instead of",
    "rather than",
    "other",
    "traditional",
    "conventional",
    "standard",
    "ordinary",
    "typical",
    "normal",
    "regular",
    "superior",
    "outperform",
    "exceed",
    "surpass",
    "beat",
    "better",
    "faster",
    "quieter",
    "lighter",
    "stronger",
    "easier",
    "more efficient",
    "more powerful",
    "more durable",
    "industry-leading",
    "best-in-class",
    "top-rated",
    "advanced",
    "upgraded",
    "improved",
    "enhanced",
    "next-gen",
    "only",
    "first",
    "exclusive",
    "unique",
    "patented",
    "wider",
    "larger",
    "bigger",
    "longer",
    "higher"
  ];
  if (/\d+x\s+(?:more|less|faster|quieter|longer|bigger|better)/.test(text)) return true;
  if (/than\s+(?:standard|conventional|other|traditional|normal|regular|typical|ordinary)/.test(text)) return true;
  if (/\d+[\d.]*-?\s*(?:inch|in|cm|mm|oz|ml|l)\s+vs/.test(text)) return true;
  return comparisonWords.some((w) => text.includes(w));
}
function classifyBulletOpening(bulletText) {
  if (!bulletText) return "feature";
  const colonMatch = bulletText.match(/^([^:]{2,50}):/);
  const opening = colonMatch ? colonMatch[1].trim().toLowerCase() : bulletText.slice(0, 50).toLowerCase();
  const benefitPatterns = [
    /^(save|stay|enjoy|keep|get|make|create|protect|prevent|avoid|eliminate|reduce|maximize|minimize|never|always|easily|quickly|safely|effortlessly)/,
    /^(easy|quiet|portable|convenient|safe|durable|reliable|powerful|efficient|comfortable|healthy|smart|versatile|flexible|compact|lightweight|ultra)/,
    /^(no more|no need|never worry|peace of mind|ready to|perfect for|ideal for|designed for|built for)/,
    /^easy\s+to\s+/,
    /^save\s+/
  ];
  for (const pat of benefitPatterns) {
    if (pat.test(opening)) return "benefit";
  }
  if (/^\d/.test(opening)) return "feature";
  if (/^(dual|triple|single|multi|2-in-1|3-in-1)\s+/.test(opening)) return "feature";
  if (/^(the\s+)?(compressor|motor|battery|chute|blade|filter|tank|cable|cord|adapter|handle|wheel)/.test(opening)) return "feature";
  const firstWord = (opening.split(/\s+/)[0] || "").replace(/[,;.]/g, "");
  const benefitFirstWords = /* @__PURE__ */ new Set([
    "fast",
    "rapid",
    "quick",
    "ultra",
    "super",
    "powerful",
    "quiet",
    "easy",
    "safe",
    "smart",
    "portable",
    "compact",
    "lightweight",
    "premium",
    "advanced",
    "pro",
    "max",
    "eco"
  ]);
  if (benefitFirstWords.has(firstWord)) return "benefit";
  return "feature";
}
function assessCompleteness(data) {
  const modules = [
    { key: "title", label: "\u6807\u9898", fetched: data.title && data.title !== "N/A", note: "\u53EF\u7528\u4E8E\u6807\u9898\u5408\u89C4\u5206\u6790" },
    { key: "bullets", label: "\u4E94\u70B9\u63CF\u8FF0", fetched: data.bullets && data.bullets.length > 0 && data.bullets[0] !== "Failed to extract bullets", note: "\u53EF\u7528\u4E8ELQI\u4E0E\u5173\u952E\u8BCD\u5206\u6790" },
    { key: "specs", label: "\u6280\u672F\u89C4\u683C", fetched: data.tech_specs && Object.keys(data.tech_specs).length > 0, note: "\u53EF\u7528\u4E8ECDQ\u4E00\u81F4\u6027\u5206\u6790" },
    { key: "images", label: "\u56FE\u7247\u6570\u91CF", fetched: data.images_count > 0, note: "\u4EC5\u8BC6\u522B\u6570\u91CF\uFF0C\u672A\u5206\u6790\u56FE\u7247\u6587\u6848" },
    { key: "video", label: "\u89C6\u9891", fetched: data.has_video, note: "\u4EC5\u5224\u65AD\u6709\u65E0\uFF0C\u672A\u5206\u6790\u89C6\u9891\u5185\u5BB9" },
    { key: "aplus", label: "A+\u9875\u9762", fetched: data.has_aplus, note: "\u4EC5\u5224\u65AD\u6709\u65E0\uFF0C\u672A\u5206\u6790\u6A21\u5757\u8D28\u91CF" },
    { key: "reviews", label: "\u8BC4\u8BBA\u5185\u5BB9", fetched: false, note: "\u6682\u672A\u6293\u53D6\uFF0C\u65E0\u6CD5\u8FDB\u884CVOC\u5206\u6790" },
    { key: "price", label: "\u4EF7\u683C\u4FE1\u606F", fetched: !!data.price, note: "\u53EF\u7528\u4E8E\u4F18\u60E0\u5206\u6790" }
  ];
  const fetched = modules.filter((m) => m.fetched).length;
  return { modules, fetched, total: modules.length, percentage: Math.round(fetched / modules.length * 100) };
}
function auditListing(data) {
  const title = data.title || "";
  const bullets = data.bullets || [];
  const specs = data.tech_specs || {};
  const imagesCount = data.images_count || 0;
  const hasVideo = data.has_video || false;
  const hasAplus = data.has_aplus || false;
  const titleLower = title.toLowerCase();
  const bulletsText = bullets.join(" ").toLowerCase();
  const cdqTitleCompliance = { name: "\u6807\u9898\u89C4\u8303", max: 30, score: 30, issues: [] };
  const cdqAttributeComplete = { name: "\u5C5E\u6027\u9971\u548C\u5EA6", max: 30, score: 30, issues: [] };
  const cdqDataConsistency = { name: "\u6570\u636E\u4E00\u81F4\u6027", max: 40, score: 40, issues: [] };
  const lqiContentQuality = { name: "\u5185\u5BB9\u8D28\u91CF", max: 35, score: 35, issues: [] };
  const lqiMediaCoverage = { name: "\u5A92\u4F53\u8986\u76D6", max: 35, score: 35, issues: [] };
  const lqiDifferentiation = { name: "\u5DEE\u5F02\u5316\u8868\u8FBE", max: 30, score: 30, issues: [] };
  function addIssue(dim, deduction, level, title_text, impact, fix) {
    dim.score = Math.max(0, dim.score - deduction);
    dim.issues.push({ level, title: title_text, impact, fix, deduction });
  }
  // V3.1: 只做拼写准确性校准，禁止字符仅限 !$?_{ }^¬¦
  const forbiddenChars = /[!$?_{ }^¬¦]/;
  if (forbiddenChars.test(title)) {
    const found = [...new Set(title.match(/[!$?_{ }^¬¦]/g))].join(' ');
    addIssue(
      cdqTitleCompliance,
      8,
      "high",
      `标题含禁止字符(${found})`,
      "亚马逊标题规范禁止使用 ! $ ? _ { } ^ ¬ ¦，可能导致Listing被拒或降权",
      `移除禁止字符: ${found}，用空格或连字符替代`
    );
  }
  // V3.1: 以下检查已移除（不做优化建议，只做拼写校准）
  // - 关键词重复检测、标题长度检查、品牌位置检查
  const voltageResult = findAttrInListing("voltage", title, bullets, specs);
  let voltageVal = "";
  for (const [k, v] of Object.entries(specs)) {
    if (/voltage|volt/i.test(k)) {
      voltageVal = v;
      break;
    }
  }
  if (voltageVal && /(230|220|240)/.test(voltageVal)) {
    addIssue(
      cdqDataConsistency,
      15,
      "critical",
      `\u7535\u538B\u503C\u5F02\u5E38: ${voltageVal}`,
      "\u7F8E\u56FD\u5E02\u573A\u5E94\u4E3A110-120V\uFF0C\u9519\u8BEF\u7535\u538B\u5BFC\u81F4\u9000\u8D27\u7387\u98D9\u5347\u548CCDQ\u964D\u6743",
      "\u7ACB\u5373\u4FEE\u6539\u540E\u53F0Voltage\u5C5E\u6027\u4E3A\u6B63\u786E\u503C(110V\u6216120V)"
    );
  }
  const wattageVals = {};
  for (const [k, v] of Object.entries(specs)) {
    const kLower = k.toLowerCase();
    if (/wattage|watt/i.test(kLower) && !/plug|source/i.test(kLower) || kLower === "maximum power" || kLower === "rated power") {
      wattageVals[k] = v;
    }
  }
  if (Object.keys(wattageVals).length > 1 && new Set(Object.values(wattageVals)).size > 1) {
    addIssue(
      cdqDataConsistency,
      10,
      "high",
      `\u529F\u7387\u6570\u636E\u4E0D\u4E00\u81F4`,
      "\u591A\u4E2A\u529F\u7387\u5B57\u6BB5\u503C\u51B2\u7A81\uFF0C\u4E9A\u9A6C\u900A\u53EF\u80FD\u6807\u8BB0\u6570\u636E\u5F02\u5E38\uFF0C\u6D88\u8D39\u8005\u4EA7\u751F\u4FE1\u4EFB\u5371\u673A",
      `\u7EDF\u4E00\u4E3A\u4E00\u4E2A\u503C: ${Object.entries(wattageVals).map(([k, v]) => `${k}=${v}`).join(", ")}\uFF0C\u5EFA\u8BAE\u4EE5\u989D\u5B9A\u529F\u7387\u4E3A\u51C6`
    );
  }
  // V3.1: 百分号(%)允许使用，不再标记为问题
  const commonMisspellings = [
    [/stainless\s+steal/i, "Stainless Steel"],
    [/dishwasher\s+saft/i, "Dishwasher Safe"],
    [/bpa\s+fee/i, "BPA Free"],
    [/powerfull/i, "Powerful"],
    [/effortlesly/i, "Effortlessly"],
    [/quietly\s+opertation/i, "Quiet Operation"],
    [/compatability/i, "Compatibility"],
    [/recieve/i, "Receive"],
    [/occassion/i, "Occasion"],
    [/accomodate/i, "Accommodate"],
    [/seperate/i, "Separate"],
    [/definately/i, "Definitely"],
    [/guarantee\s+tee/i, "Guarantee"],
    [/warrnty/i, "Warranty"],
    [/dimension\s+ns/i, "Dimensions"]
  ];
  for (const [pattern, correction] of commonMisspellings) {
    if (pattern.test(title)) {
      addIssue(
        lqiContentQuality,
        8,
        "high",
        `\u6807\u9898\u62FC\u5199\u9519\u8BEF: "${title.match(pattern)[0]}" \u2192 "${correction}"`,
        "\u62FC\u5199\u9519\u8BEF\u5F71\u54CD\u4E13\u4E1A\u5F62\u8C61\u548C\u641C\u7D22\u6536\u5F55",
        `\u5C06 "${title.match(pattern)[0]}" \u4FEE\u6B63\u4E3A "${correction}"`
      );
    }
  }
  for (let bi = 0; bi < bullets.length; bi++) {
    for (const [pattern, correction] of commonMisspellings) {
      if (pattern.test(bullets[bi])) {
        addIssue(
          lqiContentQuality,
          8,
          "high",
          `\u7B2C${bi + 1}\u6761\u4E94\u70B9\u62FC\u5199\u9519\u8BEF: "${bullets[bi].match(pattern)[0]}" \u2192 "${correction}"`,
          "\u62FC\u5199\u9519\u8BEF\u5F71\u54CD\u4E13\u4E1A\u5F62\u8C61\u548C\u641C\u7D22\u6536\u5F55",
          `\u5C06 "${bullets[bi].match(pattern)[0]}" \u4FEE\u6B63\u4E3A "${correction}"`
        );
      }
    }
  }
  const grammarIssues = [
    [/\ba\b\s+([AEIOUaeiou]\w+)/, "\u51A0\u8BCD\u9519\u8BEF", '\u5728\u5143\u97F3\u5F00\u5934\u7684\u8BCD\u524D\u5E94\u4F7F\u7528"an"\u800C\u975E"a"'],
    [/\bthis\s+(?:is\s+)?are\b/, "\u4E3B\u8C13\u4E0D\u4E00\u81F4", '"this"\u5E94\u642D\u914D"is"\u800C\u975E"are"'],
    [/\bthese\s+(?:is|was)\b/, "\u4E3B\u8C13\u4E0D\u4E00\u81F4", '"these"\u5E94\u642D\u914D"are/were"\u800C\u975E"is/was"'],
    [/\bit\s+have\b/, "\u4E3B\u8C13\u4E0D\u4E00\u81F4", '"it"\u5E94\u642D\u914D"has"\u800C\u975E"have"'],
    [/\bthey\s+has\b/, "\u4E3B\u8C13\u4E0D\u4E00\u81F4", '"they"\u5E94\u642D\u914D"have"\u800C\u975E"has"']
  ];
  for (const [pattern, issueName, fix] of grammarIssues) {
    if (pattern.test(title)) {
      addIssue(
        lqiContentQuality,
        8,
        "high",
        `\u6807\u9898\u8BED\u6CD5\u9519\u8BEF: ${issueName}`,
        "\u8BED\u6CD5\u9519\u8BEF\u964D\u4F4E\u4E70\u5BB6\u4FE1\u4EFB\u5EA6",
        fix
      );
    }
    for (let bi = 0; bi < bullets.length; bi++) {
      if (pattern.test(bullets[bi])) {
        addIssue(
          lqiContentQuality,
          8,
          "high",
          `\u7B2C${bi + 1}\u6761\u4E94\u70B9\u8BED\u6CD5\u9519\u8BEF: ${issueName}`,
          "\u8BED\u6CD5\u9519\u8BEF\u964D\u4F4E\u4E70\u5BB6\u4FE1\u4EFB\u5EA6",
          fix
        );
      }
    }
  }
  if (imagesCount < 7) {
    addIssue(
      lqiMediaCoverage,
      10,
      "high",
      `\u56FE\u7247\u4E25\u91CD\u4E0D\u8DB3(\u4EC5${imagesCount}\u5F20)`,
      "7\u5F20\u4EE5\u4E0B\u56FE\u7247\u8F6C\u5316\u7387\u663E\u8457\u504F\u4F4E\uFF0C\u7ADE\u54C1\u901A\u5E389-15\u5F20",
      "\u8865\u5145\u81F39\u5F20\u4EE5\u4E0A: 1\u4E3B\u56FE+2\u573A\u666F\u56FE+2\u7EC6\u8282\u56FE+1\u5C3A\u5BF8\u56FE+1\u914D\u4EF6\u56FE+1\u5BF9\u6BD4\u56FE"
    );
  } else if (imagesCount < 9) {
    addIssue(
      lqiMediaCoverage,
      5,
      "medium",
      `\u56FE\u7247\u53EF\u8865\u5145(${imagesCount}\u5F20)`,
      "9\u5F20\u662F\u53CA\u683C\u7EBF\uFF0CTop\u7ADE\u54C1\u901A\u5E3812\u5F20\u4EE5\u4E0A",
      "\u8865\u5145\u573A\u666F\u56FE\u548C\u751F\u6D3B\u65B9\u5F0F\u56FE\u81F39+\u5F20"
    );
  }
  if (!hasVideo) {
    addIssue(
      lqiMediaCoverage,
      8,
      "high",
      "\u7F3A\u5C11\u4EA7\u54C1\u89C6\u9891",
      "\u89C6\u9891\u63D0\u5347\u8F6C\u5316\u738720%+\uFF0C\u4E9A\u9A6C\u900A\u4F18\u5148\u5C55\u793A\u542B\u89C6\u9891\u7684Listing",
      "\u4E0A\u4F2030-60\u79D2\u4EA7\u54C1\u6F14\u793A\u89C6\u9891"
    );
  }
  if (!hasAplus) {
    addIssue(
      lqiMediaCoverage,
      6,
      "medium",
      "\u7F3A\u5C11A+\u9875\u9762",
      "A+\u9875\u9762\u63D0\u5347\u8F6C\u53163-10%\uFF0C\u662F\u54C1\u724C\u5356\u5BB6\u6807\u914D",
      "\u6CE8\u518C\u54C1\u724C\u540E\u521B\u5EFAA+\u5185\u5BB9"
    );
  }
  const cdqScore = cdqTitleCompliance.score + cdqAttributeComplete.score + cdqDataConsistency.score;
  const lqiScore = lqiContentQuality.score + lqiMediaCoverage.score + lqiDifferentiation.score;
  const overall = Math.round(cdqScore * 0.5 + lqiScore * 0.5);
  let grade;
  if (overall >= 90) grade = "Optimized";
  else if (overall >= 75) grade = "Great";
  else if (overall >= 60) grade = "Good";
  else if (overall >= 40) grade = "Fair";
  else grade = "Poor";
  const allIssues = [
    ...cdqTitleCompliance.issues.map((i) => ({ ...i, dimension: "CDQ-\u6807\u9898", sub: cdqTitleCompliance.name })),
    ...cdqAttributeComplete.issues.map((i) => ({ ...i, dimension: "CDQ-\u5C5E\u6027", sub: cdqAttributeComplete.name })),
    ...cdqDataConsistency.issues.map((i) => ({ ...i, dimension: "CDQ-\u4E00\u81F4", sub: cdqDataConsistency.name })),
    ...lqiContentQuality.issues.map((i) => ({ ...i, dimension: "LQI-\u5185\u5BB9", sub: lqiContentQuality.name })),
    ...lqiMediaCoverage.issues.map((i) => ({ ...i, dimension: "LQI-\u5A92\u4F53", sub: lqiMediaCoverage.name })),
    ...lqiDifferentiation.issues.map((i) => ({ ...i, dimension: "LQI-\u5DEE\u5F02", sub: lqiDifferentiation.name }))
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
    // V3.0: 以下三个字段已移除（只做硬性纠错，不做文案润色）
    // title_options: titleOpts,
    // bullet_optimization: bulletOptimization,
    // bullet_rewrites: bulletRewrites,
    // V3.0: found_attrs_info 已移除（不再判定属性遗漏）
    found_attrs_info: []
  };
}
function analyzeBullets(bullets, titleLower, specs) {
  if (!bullets || bullets.length === 0 || bullets[0] === "Failed to extract bullets") {
    return [];
  }
  return bullets.slice(0, 5).map((bullet, i) => {
    const openingType = classifyBulletOpening(bullet);
    const colonIdx = bullet.indexOf(":");
    const openingPhrase = colonIdx > 0 ? bullet.slice(0, colonIdx).trim() : bullet.slice(0, 40).trim();
    let suggestion = null;
    if (openingType === "feature") {
      const featureToBenefit = [
        { re: /^(\d+[\d.]*)\s*(?:lb|quart|liter|l|oz|gal)/i, repl: "Store More with " },
        { re: /^(Dual|Triple|Multi|2-in-1|3-in-1)\s+/i, repl: "Versatile " },
        { re: /^(Low|High|Eco|Max)\s+(Power|Mode)/i, repl: "Efficient " }
      ];
      for (const { re, repl } of featureToBenefit) {
        if (re.test(openingPhrase)) {
          suggestion = repl + openingPhrase + (colonIdx > 0 ? ":" + bullet.slice(colonIdx + 1) : "");
          break;
        }
      }
      if (!suggestion && colonIdx > 0) {
        suggestion = `[\u5229\u76CA\u5BFC\u5411\u6539\u5199] \u539F\u5F00\u5934: "${openingPhrase}" \u2014 \u5EFA\u8BAE\u6539\u4E3A\u5229\u76CA\u5BFC\u5411\u5982"Easy to Clean..."/"Save Time with..."/"Enjoy Quiet Operation with..."`;
      }
    }
    return {
      index: i + 1,
      original: bullet.slice(0, 200),
      opening_type: openingType,
      opening_phrase: openingPhrase,
      suggestion
    };
  });
}
function generateTitleOptions(originalTitle, brand, specs, bulletsText) {
  const titleLower = originalTitle.toLowerCase();
  const brandClean = (brand || "").replace("Visit the ", "").replace(" Store", "").trim();
  const specEntries = Object.entries(specs || {});
  const fields = { brand: brandClean, productTypes: [], numericSpecs: [], features: [], certifications: [], useCases: [], color: "", capacity: "", modifiers: [], outputRate: "" };
  for (const [k, v] of specEntries) {
    if (/^color$/i.test(k.trim())) {
      fields.color = String(v).trim();
      break;
    }
  }
  if (!fields.color) {
    const cParen = originalTitle.match(/\(([A-Za-z\s]+?)\)\s*$/);
    if (cParen && cParen[1].length < 25) fields.color = cParen[1].trim();
  }
  const typePatterns = [
    /Snow\s+Cone\s+Machine/i,
    /Shaved\s+Ice\s+Machine/i,
    /Electric\s+Ice\s+Shaver/i,
    /Snow\s+Cone\s+Maker/i,
    /Espresso\s+Coffee\s+Maker/i,
    /Espresso\s+Machine/i,
    /Coffee\s+Maker/i,
    /Cold\s+Press\s+Juicer/i,
    /Slow\s+Masticating\s+Juicer/i,
    /Masticating\s+Juicer/i,
    /Juicer\s+Machine/i,
    /Juicer/i,
    /Juice\s+Extractor/i,
    /Air\s+Fryer/i,
    /Deep\s+Fryer/i,
    /Blender/i,
    /Food\s+Processor/i,
    /Stand\s+Mixer/i,
    /Hand\s+Mixer/i,
    /Mixer/i,
    /Ice\s+Cream\s+Maker/i,
    /Ice\s+Maker/i,
    /Nugget\s+Ice\s+Maker/i,
    /Rice\s+Cooker/i,
    /Slow\s+Cooker/i,
    /Pressure\s+Cooker/i,
    /Toaster\s+Oven/i,
    /Toaster/i,
    /Waffle\s+Maker/i,
    /Sandwich\s+Maker/i,
    /Dehydrator/i,
    /Portable\s+Refrigerator/i,
    /Car\s+Refrigerator/i,
    /Car\s+Freezer/i,
    /Electric\s+Cooler/i,
    /Portable\s+Cooler/i,
    /12V\s+Refrigerator/i
  ];
  for (const pat of typePatterns) {
    const m = originalTitle.match(pat);
    if (m && !fields.productTypes.some((pt) => pt.toLowerCase() === m[0].toLowerCase())) {
      fields.productTypes.push(m[0].trim());
    }
  }
  const numExtractors = [
    { re: /(\d+[\d,]*\.?\d*)\s*Lbs\s*\/\s*H/i, norm: (v) => v.replace(/,/g, "") + " Lbs per Hour", label: "Output Rate" },
    { re: /(\d+[\d,]*\.?\d*)\s*Pounds?\s*(?:per|\/)\s*Hour/i, norm: (v) => v.replace(/,/g, "") + " Lbs per Hour", label: "Output Rate" },
    { re: /(\d+\.?\d*)\s*Bar\b/i, norm: (v) => v + " Bar", label: "Pressure" },
    { re: /(\d{3,4})\s*W(?:att)?\b/i, norm: (v) => v + "W", label: "Wattage" },
    { re: /(\d+\.?\d*)\s*(?:Liters?|L)\b/i, norm: (v) => v + " Liter", label: "Capacity" },
    { re: /(\d+\.?\d*)\s*(?:Oz|Ounces?)\b/i, norm: (v) => v + " Oz", label: "Capacity" },
    { re: /(\d+\.?\d*)\s*Cups?\b/i, norm: (v) => v + " Cup", label: "Capacity" },
    { re: /(\d+\.?\d*)\s*Quarts?\b/i, norm: (v) => v + " Quart", label: "Capacity" },
    { re: /(\d+\.?\d*)\s*RPM/i, norm: (v) => v + " RPM", label: "Speed" },
    { re: /(\d+\.?\d*)\s*(?:["""\u2033]|Inch)/i, norm: (v) => v + " Inch", label: "Size" },
    { re: /(\d+\.?\d*)%/i, norm: (v) => v + "%", label: "Percentage" }
  ];
  const seenLabels = {};
  for (const { re, norm, label } of numExtractors) {
    const m = originalTitle.match(re);
    if (m) {
      const normalized = norm(m[1]);
      if (!seenLabels[label]) {
        fields.numericSpecs.push({ raw: m[0], normalized, label, value: m[1] });
        seenLabels[label] = true;
      }
    }
  }
  if (!seenLabels["Wattage"]) {
    for (const [k, v] of specEntries) {
      if (/wattage/i.test(k)) {
        const wVal = String(v).replace(/[^0-9.]/g, "");
        if (wVal) {
          fields.numericSpecs.push({ raw: v, normalized: wVal + "W", label: "Wattage", value: wVal });
          break;
        }
      }
    }
  }
  const outRate = fields.numericSpecs.find((s) => s.label === "Output Rate");
  if (outRate) fields.outputRate = outRate.normalized;
  const capSpec = fields.numericSpecs.find((s) => s.label === "Capacity");
  if (capSpec) fields.capacity = capSpec.normalized + " Capacity";
  const featureChecks = [
    [/with\s+Grinder|built[\s-]*in\s+grinder/i, "with Grinder"],
    [/milk\s*frother/i, "with Milk Frother"],
    [/steam\s*wand/i, "with Steam Wand"],
    [/dual\s+blades?/i, "Dual Blades"],
    [/bpa[\s-]*free/i, "BPA Free"],
    [/easy[\s-]*(?:to[\s-]*)?clean/i, "Easy to Clean"],
    [/dishwasher[\s-]*safe/i, "Dishwasher Safe"],
    [/wide\s+feed\s+chute/i, "Wide Feed Chute"],
    [/whole\s+(fruit|vegetable)/i, "Whole Vegetables and Fruits"],
    [/high\s*juice\s*yield/i, "High Juice Yield"],
    [/compact/i, "Compact"],
    [/removable/i, "Removable"],
    [/touch\s*screen/i, "Touch Screen"],
    [/semi[\s-]*automatic/i, "Semi Automatic"],
    [/quiet/i, "Quiet"],
    [/reverse\s*(?:function)?/i, "Reverse Function"],
    [/anti[\s-]*drip|drip[\s-]*free/i, "Anti Drip"],
    [/dual\s+power/i, "Dual Power"],
    [/shockproof/i, "Shockproof"],
    [/battery\s*protection/i, "Battery Protection"],
    [/eco\s*mode/i, "ECO Mode"],
    [/memory\s*function/i, "Memory Function"]
  ];
  for (const [re, name] of featureChecks) {
    if (re.test(originalTitle)) fields.features.push(name);
  }
  const certChecks = [
    [/etl[\s-]*certified/i, "ETL Certified"],
    [/ul[\s-]*(?:certified|listed)/i, "UL Certified"],
    [/ce[\s-]*certified/i, "CE Certified"],
    [/nsf[\s-]*certified/i, "NSF Certified"],
    [/fcc/i, "FCC"],
    [/energy\s*star/i, "Energy Star"]
  ];
  for (const [re, name] of certChecks) {
    if (re.test(originalTitle)) fields.certifications.push(name);
  }
  if (/home.*commercial|commercial.*home/i.test(originalTitle)) fields.useCases.push("Home and Commercial Use");
  else if (/home.*kitchen/i.test(originalTitle)) fields.useCases.push("for Home Kitchen");
  else if (/outdoor/i.test(originalTitle) && /indoor/i.test(originalTitle)) fields.useCases.push("Indoor and Outdoor");
  else if (/outdoor/i.test(originalTitle)) fields.useCases.push("for Outdoor");
  else if (/home/i.test(originalTitle)) fields.useCases.push("for Home");
  else if (/commercial/i.test(originalTitle)) fields.useCases.push("Commercial Use");
  if (fields.useCases.length === 0) {
    const forM = originalTitle.match(/for\s+([A-Za-z\s&]+?)(?:\s*[,(]|\s*$)/i);
    if (forM) fields.useCases.push("for " + forM[1].trim());
  }
  if (/professional/i.test(originalTitle)) fields.modifiers.push("Professional");
  if (/commercial/i.test(originalTitle)) fields.modifiers.push("Commercial");
  if (/barista/i.test(originalTitle)) fields.modifiers.push("Barista Style");
  if (/stainless\s*steel/i.test(originalTitle)) fields.modifiers.push("Stainless Steel");
  if (/portable/i.test(originalTitle)) fields.modifiers.push("Portable");
  let category = "generic";
  if (/snow\s+cone|shaved\s+ice|ice\s+shaver/i.test(originalTitle)) category = "snow_cone";
  else if (/espresso\s*machine|espresso\s*coffee\s*maker/i.test(originalTitle)) category = "espresso";
  else if (/(?:cold\s*press|slow\s*masticating|masticating)\s*juicer|juice\s*extractor|\bjuicer\b/i.test(originalTitle)) category = "juicer";
  else if (/air\s*fryer/i.test(originalTitle)) category = "air_fryer";
  else if (/blender/i.test(originalTitle)) category = "blender";
  else if (/coffee\s*maker/i.test(originalTitle)) category = "coffee_maker";
  else if (/mixer/i.test(originalTitle)) category = "mixer";
  else if (/car\s+refrigerator|car\s+freezer|electric\s+cooler|portable\s+(?:refrigerator|cooler)|12v\s+refrigerator/i.test(originalTitle)) category = "car_fridge";
  const brandSlot = { text: fields.brand || "", name: "Brand" };
  const coreTypeSlot = [];
  const specSlot = [];
  const featureSlot = [];
  const useCaseSlot = [];
  const sellingPointSlot = [];
  const materialColorSlot = [];
  for (const pt of fields.productTypes) coreTypeSlot.push({ text: pt, name: pt });
  if (category === "car_fridge") {
    const wattSpec = fields.numericSpecs.find((s) => s.label === "Wattage");
    if (wattSpec) specSlot.push({ text: wattSpec.normalized, name: "Wattage" });
    if (fields.capacity) specSlot.push({ text: fields.capacity, name: "Capacity" });
    for (const f of fields.features.slice(0, 3)) featureSlot.push({ text: f, name: f });
    if (fields.useCases.length) useCaseSlot.push({ text: fields.useCases[0], name: "Use Case" });
    for (const c of fields.certifications) sellingPointSlot.push({ text: c, name: c });
    if (fields.modifiers.includes("Portable")) sellingPointSlot.push({ text: "Portable", name: "Portable" });
    if (fields.color) materialColorSlot.push({ text: fields.color, name: "Color" });
  } else if (category === "snow_cone") {
    if (fields.outputRate) specSlot.push({ text: fields.outputRate, name: "Output Rate" });
    const wattSpec = fields.numericSpecs.find((s) => s.label === "Wattage");
    if (wattSpec) specSlot.push({ text: wattSpec.normalized, name: "Wattage" });
    if (fields.capacity) specSlot.push({ text: fields.capacity, name: "Capacity" });
    if (fields.features.includes("Dual Blades")) featureSlot.push({ text: "with Dual Blades", name: "Dual Blades" });
    if (fields.useCases.length) useCaseSlot.push({ text: fields.useCases[0], name: "Use Case" });
    if (fields.certifications.includes("ETL Certified")) sellingPointSlot.push({ text: "ETL Certified", name: "ETL Certified" });
    if (fields.color) materialColorSlot.push({ text: fields.color, name: "Color" });
  } else if (category === "espresso") {
    const barSpec = fields.numericSpecs.find((s) => s.label === "Pressure");
    if (barSpec) specSlot.push({ text: barSpec.normalized, name: "Bar Pressure" });
    const wattSpec = fields.numericSpecs.find((s) => s.label === "Wattage");
    if (wattSpec) specSlot.push({ text: wattSpec.normalized, name: "Wattage" });
    if (fields.capacity) specSlot.push({ text: fields.capacity.replace(" Capacity", "") + " Water Tank", name: "Water Tank" });
    if (fields.features.includes("with Grinder")) featureSlot.push({ text: "with Grinder", name: "Grinder" });
    if (fields.features.includes("with Milk Frother")) featureSlot.push({ text: "with Milk Frother", name: "Milk Frother" });
    if (fields.useCases.length) useCaseSlot.push({ text: fields.useCases[0], name: "Use Case" });
    if (fields.modifiers.includes("Professional")) sellingPointSlot.push({ text: "Professional", name: "Professional" });
    if (fields.modifiers.includes("Barista Style")) sellingPointSlot.push({ text: "Barista Style", name: "Barista Style" });
    if (fields.modifiers.includes("Stainless Steel")) materialColorSlot.push({ text: "Stainless Steel", name: "Material" });
    if (fields.color) materialColorSlot.push({ text: fields.color, name: "Color" });
  } else if (category === "juicer") {
    const inchSpec = fields.numericSpecs.find((s) => s.label === "Size");
    if (inchSpec) specSlot.push({ text: inchSpec.normalized + " Wide Feed Chute", name: "Feed Chute" });
    const wattSpec = fields.numericSpecs.find((s) => s.label === "Wattage");
    if (wattSpec) specSlot.push({ text: wattSpec.normalized, name: "Wattage" });
    if (fields.capacity) specSlot.push({ text: fields.capacity, name: "Capacity" });
    if (fields.features.includes("BPA Free")) featureSlot.push({ text: "BPA Free", name: "BPA Free" });
    if (fields.features.includes("Easy to Clean")) featureSlot.push({ text: "Easy to Clean", name: "Easy to Clean" });
    if (fields.features.includes("Whole Vegetables and Fruits")) featureSlot.push({ text: "for Whole Vegetables and Fruits", name: "Whole Fruits" });
    if (fields.useCases.length) useCaseSlot.push({ text: fields.useCases[0], name: "Use Case" });
    if (fields.features.includes("High Juice Yield")) sellingPointSlot.push({ text: "High Juice Yield", name: "High Juice Yield" });
    if (fields.features.includes("Compact")) sellingPointSlot.push({ text: "Compact", name: "Compact" });
    if (fields.features.includes("Quiet")) sellingPointSlot.push({ text: "Quiet Motor", name: "Quiet" });
    if (fields.color) materialColorSlot.push({ text: fields.color, name: "Color" });
  } else {
    const wattSpec = fields.numericSpecs.find((s) => s.label === "Wattage");
    if (wattSpec) specSlot.push({ text: wattSpec.normalized, name: "Wattage" });
    if (fields.capacity) specSlot.push({ text: fields.capacity, name: "Capacity" });
    for (const f of fields.features.slice(0, 3)) featureSlot.push({ text: f, name: f });
    if (fields.useCases.length) useCaseSlot.push({ text: fields.useCases[0], name: "Use Case" });
    for (const c of fields.certifications) sellingPointSlot.push({ text: c, name: c });
    if (fields.color) materialColorSlot.push({ text: fields.color, name: "Color" });
  }
  function clean(s) {
    return s.replace(/\s+/g, " ").trim();
  }
  function assembleByVersion(version) {
    const parts = [];
    if (brandSlot.text) parts.push(brandSlot.text);
    for (const f of coreTypeSlot) parts.push(f.text);
    for (const f of specSlot) parts.push(f.text);
    for (const f of featureSlot) parts.push(f.text);
    if (version === "seo") {
      for (const f of useCaseSlot) parts.push(f.text);
    } else if (useCaseSlot.length) parts.push(useCaseSlot[0].text);
    if (version === "seo") {
      for (const f of sellingPointSlot) parts.push(f.text);
    } else if (version === "bal") {
      for (let i = 0; i < Math.min(2, sellingPointSlot.length); i++) parts.push(sellingPointSlot[i].text);
    } else {
      for (let i = 0; i < Math.min(1, sellingPointSlot.length); i++) parts.push(sellingPointSlot[i].text);
    }
    for (const f of materialColorSlot) parts.push(f.text);
    let result = clean(parts.join(" "));
    const maxLen = version === "seo" ? 200 : version === "bal" ? 180 : 165;
    if (result.length > maxLen) {
      for (const f of [...materialColorSlot].reverse()) {
        if (result.length <= maxLen) break;
        const fClean = clean(f.text);
        const idx = result.lastIndexOf(fClean);
        if (idx > -1) result = clean(result.slice(0, idx) + result.slice(idx + fClean.length));
      }
      for (const f of [...sellingPointSlot].reverse()) {
        if (result.length <= maxLen) break;
        const fClean = clean(f.text);
        const idx = result.lastIndexOf(fClean);
        if (idx > -1) result = clean(result.slice(0, idx) + result.slice(idx + fClean.length));
      }
      for (const f of [...useCaseSlot].reverse()) {
        if (result.length <= maxLen) break;
        const fClean = clean(f.text);
        const idx = result.lastIndexOf(fClean);
        if (idx > -1) result = clean(result.slice(0, idx) + result.slice(idx + fClean.length));
      }
    }
    return result;
  }
  const seoTitle = assembleByVersion("seo");
  const readTitle = assembleByVersion("read");
  const balTitle = assembleByVersion("bal");
  function explainChanges(original, optimized) {
    const changes = [];
    const origLower = original.toLowerCase();
    if (fields.brand && origLower.startsWith(fields.brand.toLowerCase())) {
      changes.push(`\u54C1\u724C\u540D"${fields.brand}"\u4FDD\u7559\u5728\u6807\u9898\u9996\u4F4D`);
    } else if (fields.brand) {
      changes.push(`\u54C1\u724C\u540D"${fields.brand}"\u79FB\u81F3\u6807\u9898\u9996\u4F4D`);
    }
    // V3.1: &允许使用，不再替换为and
    if (/\(/.test(original) && !/\(/.test(optimized)) changes.push("\u79FB\u9664\u62EC\u53F7\uFF0C\u989C\u8272\u81EA\u7136\u878D\u5165\u6807\u9898\u5C3E\u90E8");
    const origCounts = {};
    origLower.split(/\s+/).forEach((w) => {
      if (w.length > 3) origCounts[w] = (origCounts[w] || 0) + 1;
    });
    const optCounts = {};
    optimized.toLowerCase().split(/\s+/).forEach((w) => {
      if (w.length > 3) optCounts[w] = (optCounts[w] || 0) + 1;
    });
    const reduced = Object.entries(origCounts).filter(([w, c]) => c > 2 && (optCounts[w] || 0) < c);
    if (reduced.length) changes.push(`\u53BB\u91CD: ${reduced.map(([w, c]) => `"${w}"(${c}\u6B21\u2192${optCounts[w] || 1}\u6B21)`).join("\u3001")}`);
    if (changes.length === 0) changes.push("\u6807\u9898\u7ED3\u6784\u5DF2\u4F18\u5316\uFF0C\u4FDD\u6301\u6838\u5FC3\u4FE1\u606F\u5B8C\u6574");
    return changes;
  }
  function checkQuality(title, version) {
    const c = {};
    c.charCount = title.length;
    c.brandFirst = fields.brand ? title.toLowerCase().startsWith(fields.brand.toLowerCase()) : true;
    const targets = { seo: { min: 160, max: 190 }, read: { min: 110, max: 160 }, bal: { min: 140, max: 175 } };
    const t = targets[version] || targets.bal;
    c.coveredKeywords = [];
    const allSlots = [brandSlot, ...coreTypeSlot, ...specSlot, ...featureSlot, ...useCaseSlot, ...sellingPointSlot, ...materialColorSlot];
    for (const f of allSlots) {
      if (!f.text) continue;
      const checkWord = f.text.split(" ")[0].toLowerCase();
      if (title.toLowerCase().includes(checkWord)) c.coveredKeywords.push(f.name);
    }
    c.paramIntegrity = true;
    c.alteredParams = [];
    for (const spec of fields.numericSpecs) {
      const numVal = spec.value.replace(/,/g, "");
      if (!title.includes(numVal)) {
        c.paramIntegrity = false;
        c.alteredParams.push(spec.raw + " \u2192 missing");
      }
    }
    c.trimmedFields = [];
    for (const f of [...sellingPointSlot, ...materialColorSlot, ...useCaseSlot]) {
      if (!f.text) continue;
      const checkWord = f.text.split(" ")[0].toLowerCase();
      if (!title.toLowerCase().includes(checkWord)) c.trimmedFields.push(f.name);
    }
    c.hasSpecialChars = /[!$?_{ }^¬¦]/.test(title);
    const wc = {};
    title.toLowerCase().split(/\s+/).forEach((w) => {
      const wl = w.replace(/[.,;:]/g, "");
      if (wl.length > 3) wc[wl] = (wc[wl] || 0) + 1;
    });
    c.repeatedWords = Object.entries(wc).filter(([, v]) => v > 2).map(([w]) => w);
    c.parameterClaims = [];
    for (const spec of fields.numericSpecs) {
      if (title.includes(spec.value.replace(/,/g, ""))) c.parameterClaims.push(spec.label + ": " + spec.normalized);
    }
    c.tooShort = title.length < 100;
    c.belowTarget = title.length < t.min;
    let score = 10;
    if (c.charCount < 80) score -= 5;
    else if (c.charCount < 100) score -= 3;
    else if (c.charCount < t.min) score -= 1;
    else if (c.charCount > t.max) score -= 1;
    if (!c.brandFirst) score -= 1;
    if (c.trimmedFields.length > 2) score -= 1;
    if (!c.paramIntegrity) score -= 4;
    if (c.hasSpecialChars) score -= 1;
    if (c.repeatedWords.length > 0) score -= 1;
    score = Math.max(0, Math.min(10, score));
    if (!c.paramIntegrity) c.qualityGrade = "Poor";
    else if (score >= 9) c.qualityGrade = "Optimized";
    else if (score >= 7) c.qualityGrade = "Great";
    else if (score >= 5) c.qualityGrade = "Good";
    else c.qualityGrade = "Fair";
    return c;
  }
  const seoChecks = checkQuality(seoTitle, "seo");
  const readChecks = checkQuality(readTitle, "read");
  const balChecks = checkQuality(balTitle, "bal");
  function buildWarnings(checks) {
    const w = [];
    if (checks.tooShort) w.push({ type: "yellow", text: "\u6807\u9898\u504F\u77ED\uFF0C\u5EFA\u8BAE\u8865\u5145\u6838\u5FC3\u529F\u80FD\u53C2\u6570\u6216\u4F7F\u7528\u573A\u666F\u3002" });
    if (!checks.paramIntegrity) w.push({ type: "red", text: `\u53C2\u6570\u88AB\u7BE1\u6539: ${checks.alteredParams.join("\uFF1B")}\uFF0C\u539F\u59CB\u6570\u503C\u5FC5\u987B\u4FDD\u7559\u3002` });
    if (checks.hasSpecialChars) w.push({ type: "yellow", text: "\u6807\u9898\u5305\u542B\u7279\u6B8A\u5B57\u7B26\uFF0C\u5EFA\u8BAE\u66FF\u6362\u4E3A\u6807\u51C6\u683C\u5F0F\u3002" });
    if (checks.repeatedWords.length > 0) w.push({ type: "yellow", text: `\u6807\u9898\u5B58\u5728\u91CD\u590D\u5173\u952E\u8BCD: ${checks.repeatedWords.join("\u3001")}\uFF0C\u5EFA\u8BAE\u5408\u5E76\u3002` });
    if (checks.parameterClaims.length > 0) w.push({ type: "info", text: `${checks.parameterClaims.join("\u3001")}\u5C5E\u4E8E\u53C2\u6570\u578B\u58F0\u660E\uFF0C\u8BF7\u786E\u4FDD\u4E0E\u540E\u53F0\u5C5E\u6027\u548C\u8BF4\u660E\u4E66\u4E00\u81F4\u3002` });
    if (checks.trimmedFields.length > 0) w.push({ type: "info", text: `\u56E0\u957F\u5EA6\u9650\u5236\u672A\u5305\u542B: ${checks.trimmedFields.join("\u3001")}\uFF0C\u5982\u9700\u5B8C\u6574\u8986\u76D6\u5EFA\u8BAE\u4F7F\u7528SEO\u4F18\u5148\u7248\u3002` });
    return w;
  }
  return [
    { label: "SEO\u4F18\u5148\u7248", desc: "\u5173\u952E\u8BCD\u8986\u76D6\u6700\u5927\u5316\uFF0C\u9002\u5408\u65B0\u54C1\u3001\u5E7F\u544A\u6295\u653E", title: seoTitle, charCount: seoTitle.length, qualityGrade: seoChecks.qualityGrade, coveredKeywords: seoChecks.coveredKeywords, trimmedFields: seoChecks.trimmedFields, paramIntegrity: seoChecks.paramIntegrity, changes: explainChanges(originalTitle, seoTitle), warnings: buildWarnings(seoChecks) },
    { label: "\u53EF\u8BFB\u6027\u4F18\u5148\u7248", desc: "\u81EA\u7136\u6D41\u7545\uFF0C\u4FDD\u7559\u6838\u5FC3\u529F\u80FD", title: readTitle, charCount: readTitle.length, qualityGrade: readChecks.qualityGrade, coveredKeywords: readChecks.coveredKeywords, trimmedFields: readChecks.trimmedFields, paramIntegrity: readChecks.paramIntegrity, changes: explainChanges(originalTitle, readTitle), warnings: buildWarnings(readChecks) },
    { label: "\u5E73\u8861\u7248", desc: "\u517C\u987ESEO\u3001CDQ\u5408\u89C4\u548C\u7528\u6237\u9605\u8BFB\uFF0C\u63A8\u8350\u9ED8\u8BA4\u4F7F\u7528", title: balTitle, charCount: balTitle.length, qualityGrade: balChecks.qualityGrade, coveredKeywords: balChecks.coveredKeywords, trimmedFields: balChecks.trimmedFields, paramIntegrity: balChecks.paramIntegrity, changes: explainChanges(originalTitle, balTitle), warnings: buildWarnings(balChecks) }
  ];
}
function rewriteBullets(bullets, titleLower, specs) {
  if (!bullets || bullets.length === 0 || bullets[0] === "Failed to extract bullets") return [];
  const rewrites = [];
  const brandFluffWords = ["promise", "mission", "committed", "deserve", "superior quality", "we offer", "our mission"];
  for (let i = 0; i < bullets.length; i++) {
    const original = bullets[i];
    const origLower = original.toLowerCase();
    let rewritten = original;
    const changes = [];
    if (i === bullets.length - 1 && brandFluffWords.some((w) => origLower.includes(w))) {
      if (origLower.includes("brush") || origLower.includes("cup") || origLower.includes("manual")) {
        rewritten = "COMPLETE ACCESSORIES & EASY CLEANUP: Includes all accessories. Detachable parts rinse clean in under 60 seconds.";
      } else if (origLower.includes("warranty") || origLower.includes("support") || origLower.includes("service")) {
        rewritten = "RELIABLE SUPPORT & WARRANTY: Backed by dedicated customer service and manufacturer warranty.";
      } else {
        rewritten = "WHAT YOU GET: Complete product with all accessories and user manual. Ready to use right out of the box.";
      }
      changes.push({ type: "content", desc: "\u79FB\u9664\u54C1\u724C\u5957\u8BDD\uFF0C\u66FF\u6362\u4E3A\u51B3\u7B56\u63A8\u52A8\u4FE1\u606F" });
      changes.push({ type: "structure", desc: "\u5F00\u5934\u6539\u4E3A\u5229\u76CA\u5BFC\u5411\u5927\u5199\u5173\u952E\u8BCD" });
    }
    if (changes.length === 0) {
      const colonIdx = original.indexOf(":");
      if (colonIdx < 0 || colonIdx > 30) {
        const benefitStarters = { "large": "SAVE PREP TIME", "easy": "EFFORTLESS CLEANUP", "simple": "QUICK ASSEMBLY", "slow": "MAXIMUM NUTRITION", "one-button": "ONE-TOUCH OPERATION", "powerful": "POWERFUL PERFORMANCE", "superior": "COMPLETE PACKAGE", "bpa": "SAFE & HEALTHY", "fast cooling": "RAPID COOLING", "portable": "ULTRA PORTABLE", "quiet": "WHISPER QUIET", "dual power": "DUAL POWER READY" };
        for (const [keyword, header] of Object.entries(benefitStarters)) {
          if (origLower.includes(keyword)) {
            rewritten = `${header}: ${original.trim()}`;
            changes.push({ type: "structure", desc: "\u6DFB\u52A0\u5229\u76CA\u5BFC\u5411\u5927\u5199\u6807\u9898\uFF0C\u63D0\u5347\u626B\u8BFB\u8F6C\u5316" });
            break;
          }
        }
      }
    }
    // V3.1: 百分号%允许使用，不再替换为Percent
    if (titleLower.includes("bpa") && i === 0 && !origLower.includes("bpa")) {
      rewritten = `BPA-FREE & SAFE: ${rewritten}`;
      changes.push({ type: "keyword", desc: "\u6807\u9898\u63D0\u53CABPA-Free\u4F46\u4E94\u70B9\u672A\u5C55\u5F00" });
    }
    const dimensions = changes.map((c) => {
      if (c.type === "structure") return "\u53EF\u8BFB\u6027";
      if (c.type === "content") return "\u5356\u70B9\u8BC1\u636E";
      if (c.type === "keyword") return "\u5173\u952E\u8BCD\u5BC6\u5EA6";
      if (c.type === "compliance") return "\u5408\u89C4\u6027";
      return "\u573A\u666F\u4EE3\u5165";
    });
    rewrites.push({
      index: i + 1,
      before: original,
      after: rewritten,
      changes: changes.map((c, ci) => `${c.desc} [\u2191${dimensions[ci]}]`),
      hasChange: changes.length > 0
    });
  }
  return rewrites;
}
async function GET(req) {
  try {
    const u = new URL(req.url);
    const asin = (u.searchParams.get("asin") || "").trim().toUpperCase();
    if (!asin || !/^[A-Z0-9]{10}$/.test(asin)) {
      return jsonRes({ error: "Please enter a valid 10-character ASIN" }, 400);
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
export { GET };

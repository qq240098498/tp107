const { load, LEVELS, STATUSES } = require('./store');
const { ApiError, pickText } = require('./errors');

// 一条规则管不管这个文件：适用文件类型写成全部的管所有文件，否则只认同类型的
function ruleAppliesToFile(rule, file) {
  return rule.fileType === '全部' || rule.fileType === file.type;
}

function levelOrder(level) {
  const index = LEVELS.indexOf(level);
  return index === -1 ? LEVELS.length : index;
}

// 级别就高不就低：错误 > 警告 > 提示，在 LEVELS 里序号越大级别越高
function highestLevel(levels) {
  let winner = null;
  levels.forEach((level) => {
    if (!level) return;
    if (!winner || levelOrder(level) > levelOrder(winner)) winner = level;
  });
  return winner;
}

function emptyLevelCounts() {
  const counts = {};
  LEVELS.forEach((item) => { counts[item] = 0; });
  return counts;
}

// 扫一遍：启用的规则逐条去比对范围内的文件，命中记到具体行上。
// 同一文件同一行被多条规则抓到时逐条各记一条（按条口径），再按“文件+行号”归并成处（按处口径），
// 两套总数都给出来，并保证按条总数等于各处条数之和
function scan(options) {
  const input = options && typeof options === 'object' ? options : {};
  const level = pickText(input.level);
  const fileId = pickText(input.fileId);
  const ruleId = pickText(input.ruleId);

  if (level && !LEVELS.includes(level)) {
    throw new ApiError(400, 'LEVEL_INVALID', `级别只能是 ${LEVELS.join('、')} 其中之一`, 'scanLevel');
  }

  const data = load();

  let scopeFile = null;
  if (fileId) {
    scopeFile = data.files.find((item) => item.id === fileId);
    if (!scopeFile) throw new ApiError(404, 'FILE_NOT_FOUND', '选中的文件不在清单里', 'scanFile');
  }

  let scopeRule = null;
  if (ruleId) {
    scopeRule = data.rules.find((item) => item.id === ruleId);
    if (!scopeRule) throw new ApiError(404, 'RULE_NOT_FOUND', '选中的规则不在清单里', 'scanRule');
  }

  const enabled = data.rules.filter((item) => item.status === STATUSES[0]);
  const warning = scopeRule && scopeRule.status !== STATUSES[0]
    ? `${scopeRule.code} 当前是停用状态，这一轮不参与比对`
    : '';

  const rulesUsed = enabled
    .filter((item) => !scopeRule || item.id === scopeRule.id)
    .filter((item) => !level || item.level === level);

  const filesInScope = scopeFile ? [scopeFile] : data.files;

  // 忽略只认“规则 + 文件 + 行号”三元组：命中一条查一条，同行上别的规则不受影响
  const ignoreMap = new Map();
  data.ignores.forEach((item) => {
    ignoreMap.set(`${item.ruleId}\n${item.fileId}\n${item.lineNo}`, item);
  });

  const hits = [];
  rulesUsed.forEach((rule) => {
    filesInScope.filter((file) => ruleAppliesToFile(rule, file)).forEach((file) => {
      file.content.split('\n').forEach((text, index) => {
        if (!text.includes(rule.pattern)) return;
        const lineNo = index + 1;
        const ignoredEntry = ignoreMap.get(`${rule.id}\n${file.id}\n${lineNo}`) || null;
        hits.push({
          ruleId: rule.id,
          code: rule.code,
          ruleName: rule.name,
          level: rule.level,
          pattern: rule.pattern,
          fileId: file.id,
          path: file.path,
          fileType: file.type,
          lineNo,
          lineText: text.trim(),
          ignored: Boolean(ignoredEntry),
          ignoreId: ignoredEntry ? ignoredEntry.id : '',
          ignoreReason: ignoredEntry ? ignoredEntry.reason : '',
          ignoreOperator: ignoredEntry ? ignoredEntry.operator : '',
        });
      });
    });
  });

  // 同一行的多条命中排在一起，方便按条看时与按处互相印证
  hits.sort((a, b) => {
    if (a.path !== b.path) return a.path < b.path ? -1 : 1;
    if (a.lineNo !== b.lineNo) return a.lineNo - b.lineNo;
    if (a.level !== b.level) return levelOrder(b.level) - levelOrder(a.level);
    return a.code < b.code ? -1 : 1;
  });

  // 按处归并：同一文件同一行算一处，不管这处被几条规则抓到
  const placeMap = new Map();
  hits.forEach((hit) => {
    const key = `${hit.fileId}\n${hit.lineNo}`;
    if (!placeMap.has(key)) {
      placeMap.set(key, {
        placeId: `${hit.fileId}-${hit.lineNo}`,
        fileId: hit.fileId,
        path: hit.path,
        fileType: hit.fileType,
        lineNo: hit.lineNo,
        lineText: hit.lineText,
        entries: [],
      });
    }
    placeMap.get(key).entries.push(hit);
  });

  const places = Array.from(placeMap.values()).map((place) => {
    const entries = place.entries.slice().sort((a, b) => {
      if (a.level !== b.level) return levelOrder(b.level) - levelOrder(a.level);
      return a.code < b.code ? -1 : 1;
    });
    const ignoredEntries = entries.filter((item) => item.ignored);
    const activeEntries = entries.filter((item) => !item.ignored);
    const allLevels = Array.from(new Set(entries.map((item) => item.level)));
    const level = highestLevel(allLevels);
    const activeLevel = highestLevel(Array.from(new Set(activeEntries.map((item) => item.level))));
    return {
      placeId: place.placeId,
      fileId: place.fileId,
      path: place.path,
      fileType: place.fileType,
      lineNo: place.lineNo,
      lineText: place.lineText,
      hitCount: entries.length,
      ignoredCount: ignoredEntries.length,
      activeCount: activeEntries.length,
      fullyIgnored: activeEntries.length === 0,
      partiallyIgnored: ignoredEntries.length > 0 && activeEntries.length > 0,
      levelMixed: allLevels.length > 1,
      // 这一处整体按哪一级对待：取参与抓到的规则里最高的级别
      level,
      levelCodes: entries.filter((item) => item.level === level).map((item) => item.code),
      distinctLevels: allLevels,
      // 剔除被忽略的条目后还剩的最高级别；整处都被忽略时为空
      activeLevel: activeLevel || '',
      activeLevelCodes: activeLevel
        ? activeEntries.filter((item) => item.level === activeLevel).map((item) => item.code)
        : [],
      rules: entries.map((item) => ({
        ruleId: item.ruleId,
        code: item.code,
        ruleName: item.ruleName,
        level: item.level,
        pattern: item.pattern,
        ignored: item.ignored,
        ignoreId: item.ignoreId,
        ignoreReason: item.ignoreReason,
        ignoreOperator: item.ignoreOperator,
      })),
    };
  });

  places.sort((a, b) => {
    if (a.path !== b.path) return a.path < b.path ? -1 : 1;
    return a.lineNo - b.lineNo;
  });

  // —— 按条口径 ——
  const byLevel = emptyLevelCounts();
  const activeByLevel = emptyLevelCounts();
  hits.forEach((hit) => {
    byLevel[hit.level] += 1;
    if (!hit.ignored) activeByLevel[hit.level] += 1;
  });

  const byRuleMap = new Map();
  hits.forEach((hit) => {
    if (!byRuleMap.has(hit.code)) {
      byRuleMap.set(hit.code, {
        code: hit.code, ruleName: hit.ruleName, level: hit.level, total: 0, active: 0, ignored: 0,
      });
    }
    const row = byRuleMap.get(hit.code);
    row.total += 1;
    if (hit.ignored) row.ignored += 1;
    else row.active += 1;
  });

  const byFileMap = new Map();
  hits.forEach((hit) => {
    if (!byFileMap.has(hit.path)) {
      byFileMap.set(hit.path, {
        path: hit.path, fileType: hit.fileType, total: 0, active: 0, ignored: 0, places: 0, activePlaces: 0,
      });
    }
    const row = byFileMap.get(hit.path);
    row.total += 1;
    if (hit.ignored) row.ignored += 1;
    else row.active += 1;
  });
  places.forEach((place) => {
    const row = byFileMap.get(place.path);
    row.places += 1;
    if (place.activeCount > 0) row.activePlaces += 1;
  });

  // —— 按处口径 ——
  const placesByLevel = emptyLevelCounts();
  const activePlacesByLevel = emptyLevelCounts();
  const fanOut = {};
  let maxRulesAtPlace = 0;
  let maxRulesPlaces = [];
  places.forEach((place) => {
    placesByLevel[place.level] += 1;
    if (place.activeCount > 0) activePlacesByLevel[place.activeLevel] += 1;
    fanOut[place.hitCount] = (fanOut[place.hitCount] || 0) + 1;
    if (place.hitCount > maxRulesAtPlace) {
      maxRulesAtPlace = place.hitCount;
      maxRulesPlaces = [{ path: place.path, lineNo: place.lineNo, hitCount: place.hitCount }];
    } else if (place.hitCount === maxRulesAtPlace) {
      maxRulesPlaces.push({ path: place.path, lineNo: place.lineNo, hitCount: place.hitCount });
    }
  });

  const totalIgnored = hits.filter((hit) => hit.ignored).length;
  const placesPartiallyIgnored = places.filter((place) => place.partiallyIgnored).length;
  const placesFullyIgnored = places.filter((place) => place.fullyIgnored).length;

  // 两套口径的勾稽：按条总数必须等于各处条数之和，有效、忽略各自也对得上
  const sumHitCount = places.reduce((sum, place) => sum + place.hitCount, 0);
  const sumActiveCount = places.reduce((sum, place) => sum + place.activeCount, 0);
  const sumIgnoredCount = places.reduce((sum, place) => sum + place.ignoredCount, 0);
  const reconciled = hits.length === sumHitCount
    && (hits.length - totalIgnored) === sumActiveCount
    && totalIgnored === sumIgnoredCount
    && byRuleMap.size === new Set(hits.map((hit) => hit.code)).size;

  return {
    scannedAt: new Date().toISOString(),
    enabledRules: enabled.length,
    rulesUsed: rulesUsed.length,
    filesInScope: filesInScope.length,
    filesTotal: data.files.length,
    rulesTotal: data.rules.length,
    ignoresTotal: data.ignores.length,
    warning,
    hits,
    places,
    summary: {
      // 按条：一条规则在一行上的一次命中算一条
      byHit: {
        total: hits.length,
        active: hits.length - totalIgnored,
        ignored: totalIgnored,
        byLevel,
        activeByLevel,
      },
      // 按处：同一文件同一行算一处，不管被几条规则抓到
      byPlace: {
        total: places.length,
        active: places.length - placesFullyIgnored,
        fullyIgnored: placesFullyIgnored,
        partiallyIgnored: placesPartiallyIgnored,
        byLevel: placesByLevel,
        activeByLevel: activePlacesByLevel,
        maxRulesAtPlace,
        maxRulesPlaces,
        fanOut,
      },
      // 兼容旧的概要字段名，内容与按条口径一致
      total: hits.length,
      byLevel,
      byRule: Array.from(byRuleMap.values()).sort((a, b) => (a.code < b.code ? -1 : 1)),
      byFile: Array.from(byFileMap.values()).sort((a, b) => (a.path < b.path ? -1 : 1)),
      reconciled,
      check: {
        hitTotal: hits.length,
        placeHitSum: sumHitCount,
        activeHits: hits.length - totalIgnored,
        placeActiveSum: sumActiveCount,
        ignoredHits: totalIgnored,
        placeIgnoredSum: sumIgnoredCount,
      },
    },
  };
}

module.exports = { scan, ruleAppliesToFile, levelOrder, highestLevel };

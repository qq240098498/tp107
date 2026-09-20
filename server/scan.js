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

// 一处的整体级别：有效条目里取最重的一级；整处都忽略时按全部条目取最重
function pickLocationLevel(entries) {
  const effective = entries.filter((entry) => !entry.ignored);
  const pool = effective.length > 0 ? effective : entries;
  return pool.reduce((top, entry) => (levelOrder(entry.level) > levelOrder(top) ? entry.level : top), pool[0].level);
}

// 按处汇总：同一文件同一行算一处，参与抓到的规则各记一条，忽略口径与按条一致
function buildLocations(hits) {
  const locationMap = new Map();
  hits.forEach((hit) => {
    const key = `${hit.fileId}|${hit.lineNo}`;
    if (!locationMap.has(key)) {
      locationMap.set(key, {
        fileId: hit.fileId,
        path: hit.path,
        fileType: hit.fileType,
        lineNo: hit.lineNo,
        lineText: hit.lineText,
        entries: [],
      });
    }
    locationMap.get(key).entries.push({
      ruleId: hit.ruleId,
      code: hit.code,
      ruleName: hit.ruleName,
      level: hit.level,
      ignored: hit.ignored,
    });
  });

  const locations = Array.from(locationMap.values());
  locations.forEach((location) => {
    location.entries.sort((a, b) => (a.code < b.code ? -1 : 1));
    location.total = location.entries.length;
    location.ignored = location.entries.filter((entry) => entry.ignored).length;
    location.effective = location.total - location.ignored;
    location.status = location.ignored === 0 ? '全部有效' : (location.effective === 0 ? '整处忽略' : '部分忽略');
    location.levelMixed = new Set(location.entries.map((entry) => entry.level)).size > 1;
    location.level = pickLocationLevel(location.entries);
    if (!location.levelMixed) {
      location.levelBasis = '参与条目级别一致';
    } else if (location.effective > 0) {
      location.levelBasis = '级别不一致，按有效条目取最重一级（错误 > 警告 > 提示）';
    } else {
      location.levelBasis = '整处已忽略，按全部条目取最重一级（错误 > 警告 > 提示）';
    }
  });

  locations.sort((a, b) => {
    if (a.path !== b.path) return a.path < b.path ? -1 : 1;
    return a.lineNo - b.lineNo;
  });
  return locations;
}

// 扫一遍：启用的规则逐条去比对范围内的文件，命中记到具体行上
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

  // 忽略记录按（规则、文件、行号）认键，扫描时对应回每一条命中上
  const ignoreMap = new Map();
  (data.ignores || []).forEach((item) => {
    ignoreMap.set(`${item.ruleId}|${item.fileId}|${item.lineNo}`, item);
  });

  const hits = [];
  rulesUsed.forEach((rule) => {
    filesInScope.filter((file) => ruleAppliesToFile(rule, file)).forEach((file) => {
      file.content.split('\n').forEach((text, index) => {
        if (text.includes(rule.pattern)) {
          const ignore = ignoreMap.get(`${rule.id}|${file.id}|${index + 1}`);
          hits.push({
            ruleId: rule.id,
            code: rule.code,
            ruleName: rule.name,
            level: rule.level,
            pattern: rule.pattern,
            fileId: file.id,
            path: file.path,
            fileType: file.type,
            lineNo: index + 1,
            lineText: text.trim(),
            ignored: Boolean(ignore),
            ignoredBy: ignore ? ignore.ignoredBy : '',
            ignoredAt: ignore ? ignore.ignoredAt : '',
          });
        }
      });
    });
  });

  hits.sort((a, b) => {
    if (a.code !== b.code) return a.code < b.code ? -1 : 1;
    if (a.path !== b.path) return a.path < b.path ? -1 : 1;
    return a.lineNo - b.lineNo;
  });

  const byLevel = {};
  LEVELS.forEach((item) => { byLevel[item] = { total: 0, effective: 0, ignored: 0 }; });
  hits.forEach((hit) => {
    byLevel[hit.level].total += 1;
    if (hit.ignored) byLevel[hit.level].ignored += 1;
    else byLevel[hit.level].effective += 1;
  });

  const byRuleMap = new Map();
  hits.forEach((hit) => {
    const key = hit.code;
    if (!byRuleMap.has(key)) {
      byRuleMap.set(key, { code: hit.code, ruleName: hit.ruleName, level: hit.level, count: 0, effective: 0, ignored: 0 });
    }
    const bucket = byRuleMap.get(key);
    bucket.count += 1;
    if (hit.ignored) bucket.ignored += 1;
    else bucket.effective += 1;
  });

  const byFileMap = new Map();
  hits.forEach((hit) => {
    const key = hit.path;
    if (!byFileMap.has(key)) byFileMap.set(key, { path: hit.path, fileType: hit.fileType, count: 0, effective: 0, ignored: 0 });
    const bucket = byFileMap.get(key);
    bucket.count += 1;
    if (hit.ignored) bucket.ignored += 1;
    else bucket.effective += 1;
  });

  // 按处口径：与按条从同一份命中派生，两套数字天然对得上
  const locations = buildLocations(hits);
  const locationByLevel = {};
  LEVELS.forEach((item) => { locationByLevel[item] = 0; });
  locations.forEach((location) => { locationByLevel[location.level] += 1; });
  const maxRules = locations.reduce((max, location) => Math.max(max, location.total), 0);
  const maxLocations = locations
    .filter((location) => location.total === maxRules)
    .map((location) => ({ path: location.path, lineNo: location.lineNo, total: location.total }));

  return {
    scannedAt: new Date().toISOString(),
    enabledRules: enabled.length,
    rulesUsed: rulesUsed.length,
    filesInScope: filesInScope.length,
    filesTotal: data.files.length,
    rulesTotal: data.rules.length,
    warning,
    hits,
    locations,
    summary: {
      total: hits.length,
      effective: hits.filter((hit) => !hit.ignored).length,
      ignored: hits.filter((hit) => hit.ignored).length,
      byLevel,
      byRule: Array.from(byRuleMap.values()).sort((a, b) => (a.code < b.code ? -1 : 1)),
      byFile: Array.from(byFileMap.values()).sort((a, b) => (a.path < b.path ? -1 : 1)),
      locations: {
        total: locations.length,
        fullyIgnored: locations.filter((location) => location.effective === 0).length,
        partial: locations.filter((location) => location.ignored > 0 && location.effective > 0).length,
        maxRules,
        maxLocations,
        byLevel: locationByLevel,
      },
    },
  };
}

module.exports = { scan, ruleAppliesToFile, levelOrder, buildLocations };

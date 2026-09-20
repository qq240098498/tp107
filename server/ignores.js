const crypto = require('crypto');
const { load, save } = require('./store');
const { ApiError, pickText } = require('./errors');

// 一条命中靠（规则、文件、行号）认键，忽略与恢复都按这个键来
function readKey(payload) {
  const input = payload && typeof payload === 'object' ? payload : {};
  return {
    ruleId: pickText(input.ruleId),
    fileId: pickText(input.fileId),
    lineNo: Number(input.lineNo),
  };
}

// 规则与文件要真的在清单里，行号要落在文件现有的行数范围内
function validateKey(key, data) {
  if (!key.ruleId) throw new ApiError(400, 'RULE_REQUIRED', '请给出要操作的规则', '');
  const rule = data.rules.find((item) => item.id === key.ruleId);
  if (!rule) throw new ApiError(404, 'RULE_NOT_FOUND', '这条规则不存在或已被删除', '');
  if (!key.fileId) throw new ApiError(400, 'FILE_REQUIRED', '请给出要操作的文件', '');
  const file = data.files.find((item) => item.id === key.fileId);
  if (!file) throw new ApiError(404, 'FILE_NOT_FOUND', '这个文件不存在或已被移出清单', '');
  const lineCount = file.content ? file.content.split('\n').length : 0;
  if (!Number.isInteger(key.lineNo) || key.lineNo < 1 || key.lineNo > lineCount) {
    throw new ApiError(400, 'HIT_LINE_INVALID', `行号要在 1 到 ${lineCount} 之间`, '');
  }
  return { rule, file };
}

function sameKey(ignore, key) {
  return ignore.ruleId === key.ruleId && ignore.fileId === key.fileId && ignore.lineNo === key.lineNo;
}

// 忽略一条命中：同一条命中重复忽略不会记两次，直接返回已有的记录
function ignoreHit(payload) {
  const input = payload && typeof payload === 'object' ? payload : {};
  const data = load();
  const key = readKey(input);
  validateKey(key, data);
  const existing = data.ignores.find((item) => sameKey(item, key));
  if (existing) return existing;
  const created = {
    id: crypto.randomUUID(),
    ruleId: key.ruleId,
    fileId: key.fileId,
    lineNo: key.lineNo,
    ignoredBy: pickText(input.operator),
    ignoredAt: new Date().toISOString(),
  };
  data.ignores.push(created);
  save(data);
  return created;
}

// 恢复一条命中：本来就没有忽略记录时也算处理成功
function unignoreHit(payload) {
  const data = load();
  const key = readKey(payload);
  validateKey(key, data);
  const index = data.ignores.findIndex((item) => sameKey(item, key));
  if (index === -1) return { removed: false };
  data.ignores.splice(index, 1);
  save(data);
  return { removed: true };
}

module.exports = {
  ignoreHit,
  unignoreHit,
};

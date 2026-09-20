// 命中的忽略登记：忽略的粒度永远是“某条规则在某个文件某一行上的一条命中”。
// 同一行上若还有别的规则命中，那些条目不受影响，仍按有效计入。
const crypto = require('crypto');
const {
  load,
  save,
  MAX_REASON_LENGTH,
  MAX_OPERATOR_LENGTH,
} = require('./store');
const { ApiError, pickText } = require('./errors');

function fileLineCount(file) {
  return file.content ? file.content.split('\n').length : 0;
}

function lineTextOf(file, lineNo) {
  const lines = file.content ? file.content.split('\n') : [];
  const text = lines[lineNo - 1];
  return typeof text === 'string' ? text.trim() : '';
}

// 清单里带上规则与文件的当下信息：规则改名或文件内容变动后，列表仍能对上现在的样子
function decorate(ignore, rule, file) {
  return {
    id: ignore.id,
    ruleId: ignore.ruleId,
    code: rule ? rule.code : '',
    ruleName: rule ? rule.name : '',
    level: rule ? rule.level : '',
    fileId: ignore.fileId,
    path: file ? file.path : '',
    fileType: file ? file.type : '',
    lineNo: ignore.lineNo,
    lineText: file ? lineTextOf(file, ignore.lineNo) : '',
    reason: ignore.reason,
    operator: ignore.operator,
    createdAt: ignore.createdAt,
    updatedAt: ignore.updatedAt,
  };
}

function sortIgnores(list) {
  return list.slice().sort((a, b) => {
    if (a.path !== b.path) return a.path < b.path ? -1 : 1;
    if (a.lineNo !== b.lineNo) return a.lineNo - b.lineNo;
    return a.code < b.code ? -1 : 1;
  });
}

function listIgnores() {
  const data = load();
  const ruleMap = new Map(data.rules.map((item) => [item.id, item]));
  const fileMap = new Map(data.files.map((item) => [item.id, item]));
  const ignores = sortIgnores(data.ignores.map((item) =>
    decorate(item, ruleMap.get(item.ruleId), fileMap.get(item.fileId))));
  return { ignores, total: ignores.length };
}

function validateRuleRef(ruleId, data) {
  const id = pickText(ruleId);
  if (!id) throw new ApiError(400, 'IGNORE_RULE_REQUIRED', '请指明忽略的是哪条规则的命中', 'ruleId');
  const rule = data.rules.find((item) => item.id === id);
  if (!rule) throw new ApiError(404, 'RULE_NOT_FOUND', '这条规则不存在或已被删除', 'ruleId');
  return rule;
}

function validateFileRef(fileId, data) {
  const id = pickText(fileId);
  if (!id) throw new ApiError(400, 'IGNORE_FILE_REQUIRED', '请指明忽略的是哪个文件上的命中', 'fileId');
  const file = data.files.find((item) => item.id === id);
  if (!file) throw new ApiError(404, 'FILE_NOT_FOUND', '这个文件不存在或已被移出清单', 'fileId');
  return file;
}

function validateLineNo(value, file) {
  // 页面传来的行号是文本，直接调用动作时也可能是数字，两种都接住
  const raw = typeof value === 'number' ? String(value) : pickText(value);
  const lineNo = Number(raw);
  if (!Number.isInteger(lineNo) || lineNo < 1) {
    throw new ApiError(400, 'LINE_INVALID', '行号得是从 1 开始的整数', 'lineNo');
  }
  const total = fileLineCount(file);
  if (lineNo > total) {
    throw new ApiError(400, 'LINE_OUT_OF_RANGE', `这个文件只有 ${total} 行，行号超出范围了`, 'lineNo');
  }
  return lineNo;
}

function validateReason(value) {
  const reason = typeof value === 'string' ? value.trim() : '';
  if (!reason) throw new ApiError(400, 'IGNORE_REASON_REQUIRED', '请写清忽略这条命中的原因', 'reason');
  if (reason.length > MAX_REASON_LENGTH) {
    throw new ApiError(400, 'IGNORE_REASON_TOO_LONG', `忽略原因不能超过 ${MAX_REASON_LENGTH} 个字符`, 'reason');
  }
  return reason;
}

function validateOperator(value) {
  const operator = pickText(value);
  if (!operator) throw new ApiError(400, 'OPERATOR_REQUIRED', '请先在页面右上角填上当前操作者', 'operator');
  if (operator.length > MAX_OPERATOR_LENGTH) {
    throw new ApiError(400, 'OPERATOR_TOO_LONG', `操作者不能超过 ${MAX_OPERATOR_LENGTH} 个字符`, 'operator');
  }
  return operator;
}

function createIgnore(payload) {
  const input = payload && typeof payload === 'object' ? payload : {};
  const data = load();
  const rule = validateRuleRef(input.ruleId, data);
  const file = validateFileRef(input.fileId, data);
  const lineNo = validateLineNo(input.lineNo, file);
  const reason = validateReason(input.reason);
  const operator = validateOperator(input.operator);

  const duplicated = data.ignores.find((item) =>
    item.ruleId === rule.id && item.fileId === file.id && item.lineNo === lineNo);
  if (duplicated) {
    throw new ApiError(409, 'IGNORE_DUPLICATED', `${rule.code} 在 ${file.path} 第 ${lineNo} 行的命中已经登记过忽略了`, 'lineNo');
  }

  const now = new Date().toISOString();
  const created = {
    id: crypto.randomUUID(),
    ruleId: rule.id,
    fileId: file.id,
    lineNo,
    reason,
    operator,
    createdAt: now,
    updatedAt: now,
  };
  data.ignores.push(created);
  save(data);
  return decorate(created, rule, file);
}

function deleteIgnore(id) {
  const data = load();
  const index = data.ignores.findIndex((item) => item.id === id);
  if (index === -1) throw new ApiError(404, 'IGNORE_NOT_FOUND', '这条忽略记录不存在或已被取消', '');
  const [removed] = data.ignores.splice(index, 1);
  save(data);
  return { id: removed.id, ruleId: removed.ruleId, fileId: removed.fileId, lineNo: removed.lineNo };
}

module.exports = {
  listIgnores,
  createIgnore,
  deleteIgnore,
};

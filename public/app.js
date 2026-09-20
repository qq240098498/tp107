// 页面交互：规则、文件与扫描三块都从服务端拉取，任何一步失败都把说明显示在顶部并标到对应输入项上

const state = {
  rules: [],
  files: [],
  levels: [],
  statuses: [],
  fileTypes: [],
  ruleLevels: [],
  ruleStatuses: [],
  ruleFileTypes: [],
  editingRuleId: '',
  editingFileId: '',
  lastScan: null,
  scanView: 'hit',
  ignores: [],
};

const el = (id) => document.getElementById(id);

// 统一的请求入口：出错时把服务端给的错误码、说明与出错位置一起抛出去
async function request(path, options) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  let payload = null;
  try {
    payload = await res.json();
  } catch (err) {
    payload = null;
  }
  if (!res.ok) {
    const error = (payload && payload.error) || {};
    const failure = new Error(error.message || `请求失败（状态码 ${res.status}）`);
    failure.code = error.code || '';
    failure.field = error.field || '';
    throw failure;
  }
  return payload;
}

function notify(message, kind) {
  const box = el('notice');
  box.textContent = message;
  box.className = `notice ${kind === 'ok' ? 'ok' : 'error'}`;
}

function clearNotice() {
  const box = el('notice');
  box.className = 'notice hidden';
  box.textContent = '';
}

function clearFieldMarks() {
  document.querySelectorAll('.invalid').forEach((node) => node.classList.remove('invalid'));
}

// 把出错位置标到具体输入项上：规则区与文件区共用一套标记
function markField(field) {
  if (!field) return;
  const target = document.querySelector(`[data-field="${field}"]`);
  if (!target) return;
  target.classList.add('invalid');
  const input = target.tagName === 'INPUT' || target.tagName === 'SELECT' || target.tagName === 'TEXTAREA'
    ? target
    : target.querySelector('input, select, textarea');
  if (input) input.focus();
}

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function formatTime(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const pad = (num) => String(num).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function levelClass(level) {
  if (level === '错误') return 'lv-error';
  if (level === '警告') return 'lv-warn';
  return 'lv-hint';
}

function levelCountsText(counts, activeCounts) {
  return Object.keys(counts)
    .map((key) => {
      const active = activeCounts ? `（有效 ${activeCounts[key]}）` : '';
      return `${key} ${counts[key]}${active}`;
    })
    .join('　');
}

// 一处里参与抓到的规则逐条列出：编码、级别，以及这一条是否已被忽略。
// 忽略/取消按钮只带规则编码，文件与行号从所在处的行容器上取
function ruleChips(rules) {
  return rules.map((rule) => {
    const stateHtml = rule.ignored
      ? `<span class="chip-state off">已忽略${rule.ignoreReason ? `：${escapeHtml(rule.ignoreReason)}` : ''}</span>
         <button type="button" class="link" data-ignore-cancel="${escapeHtml(rule.ignoreId)}">取消忽略</button>`
      : `<span class="chip-state on">有效</span>
         <button type="button" class="link" data-ignore-add="${escapeHtml(rule.ruleId)}">忽略这条</button>`;
    return `<span class="rule-chip ${rule.ignored ? 'is-off' : ''}">
        <span class="mono">${escapeHtml(rule.code)}</span>
        <span class="tag ${levelClass(rule.level)}">${escapeHtml(rule.level)}</span>
        ${stateHtml}
      </span>`;
  }).join('');
}

const OPERATOR_KEY = 'check-hits-operator';

function currentOperator() {
  return el('operator').value.trim();
}

function restoreOperator() {
  el('operator').value = window.localStorage.getItem(OPERATOR_KEY) || '';
}

async function loadHealth() {
  try {
    await request('/api/health');
    el('health').textContent = '服务正常';
    el('health').className = 'health ok';
  } catch (err) {
    el('health').textContent = '服务连不上';
    el('health').className = 'health bad';
  }
}

async function loadRules() {
  const params = new URLSearchParams();
  const level = el('rule-filter-level').value;
  const status = el('rule-filter-status').value;
  const fileType = el('rule-filter-type').value;
  const keyword = el('rule-filter-keyword').value.trim();
  if (level) params.set('level', level);
  if (status) params.set('status', status);
  if (fileType) params.set('fileType', fileType);
  if (keyword) params.set('keyword', keyword);
  const query = params.toString();
  const payload = await request(`/api/rules${query ? `?${query}` : ''}`);
  state.rules = payload.rules || [];
  state.levels = payload.levels || [];
  state.statuses = payload.statuses || [];
  state.fileTypes = payload.fileTypes || [];
  renderRuleFilters();
  renderRules();
  renderScanRuleOptions();
}

async function loadFiles() {
  const params = new URLSearchParams();
  const type = el('file-filter-type').value;
  const keyword = el('file-filter-keyword').value.trim();
  if (type) params.set('type', type);
  if (keyword) params.set('keyword', keyword);
  const query = params.toString();
  const payload = await request(`/api/files${query ? `?${query}` : ''}`);
  state.files = payload.files || [];
  state.ruleFileTypes = payload.fileTypes || [];
  renderFileFilters();
  renderFiles();
  renderScanFileOptions();
}

function renderRuleFilters() {
  const levelSelect = el('rule-filter-level');
  const levelCurrent = levelSelect.value;
  levelSelect.innerHTML = '<option value="">全部级别</option>'
    + state.levels.map((item) => `<option value="${escapeHtml(item)}">${escapeHtml(item)}</option>`).join('');
  if (state.levels.includes(levelCurrent)) levelSelect.value = levelCurrent;

  const statusSelect = el('rule-filter-status');
  const statusCurrent = statusSelect.value;
  statusSelect.innerHTML = '<option value="">全部状态</option>'
    + state.statuses.map((item) => `<option value="${escapeHtml(item)}">${escapeHtml(item)}</option>`).join('');
  if (state.statuses.includes(statusCurrent)) statusSelect.value = statusCurrent;

  const typeSelect = el('rule-filter-type');
  const typeCurrent = typeSelect.value;
  typeSelect.innerHTML = '<option value="">全部适用文件类型</option>'
    + state.fileTypes.map((item) => `<option value="${escapeHtml(item)}">${escapeHtml(item)}</option>`).join('');
  if (state.fileTypes.includes(typeCurrent)) typeSelect.value = typeCurrent;

  const formLevel = el('rule-level');
  const formLevelCurrent = formLevel.value;
  formLevel.innerHTML = state.levels.map((item) => `<option value="${escapeHtml(item)}">${escapeHtml(item)}</option>`).join('');
  if (state.levels.includes(formLevelCurrent)) formLevel.value = formLevelCurrent;

  const formStatus = el('rule-status');
  const formStatusCurrent = formStatus.value;
  formStatus.innerHTML = state.statuses.map((item) => `<option value="${escapeHtml(item)}">${escapeHtml(item)}</option>`).join('');
  if (state.statuses.includes(formStatusCurrent)) formStatus.value = formStatusCurrent;

  const formType = el('rule-file-type');
  const formTypeCurrent = formType.value;
  formType.innerHTML = state.fileTypes.map((item) => `<option value="${escapeHtml(item)}">${escapeHtml(item)}</option>`).join('');
  if (state.fileTypes.includes(formTypeCurrent)) formType.value = formTypeCurrent;

  const scanLevel = el('scan-level');
  const scanLevelCurrent = scanLevel.value;
  scanLevel.innerHTML = '<option value="">全部级别</option>'
    + state.levels.map((item) => `<option value="${escapeHtml(item)}">${escapeHtml(item)}</option>`).join('');
  if (state.levels.includes(scanLevelCurrent)) scanLevel.value = scanLevelCurrent;
}

function renderFileFilters() {
  const typeSelect = el('file-filter-type');
  const current = typeSelect.value;
  typeSelect.innerHTML = '<option value="">全部类型</option>'
    + state.ruleFileTypes.map((item) => `<option value="${escapeHtml(item)}">${escapeHtml(item)}</option>`).join('');
  if (state.ruleFileTypes.includes(current)) typeSelect.value = current;
}

function renderScanRuleOptions() {
  const select = el('scan-rule');
  const current = select.value;
  select.innerHTML = '<option value="">全部规则</option>'
    + state.rules.map((item) => `<option value="${escapeHtml(item.id)}">${escapeHtml(item.code)} ${escapeHtml(item.name)}</option>`).join('');
  if (state.rules.some((item) => item.id === current)) select.value = current;
}

function renderScanFileOptions() {
  const select = el('scan-file');
  const current = select.value;
  select.innerHTML = '<option value="">全部文件</option>'
    + state.files.map((item) => `<option value="${escapeHtml(item.id)}">${escapeHtml(item.path)}</option>`).join('');
  if (state.files.some((item) => item.id === current)) select.value = current;
}

function renderRules() {
  const body = el('rule-body');
  body.innerHTML = state.rules.map((item) => `<tr>
      <td class="mono">${escapeHtml(item.code)}</td>
      <td>${escapeHtml(item.name)}</td>
      <td><span class="tag ${levelClass(item.level)}">${escapeHtml(item.level)}</span></td>
      <td>${escapeHtml(item.status)}</td>
      <td>${escapeHtml(item.fileType)}</td>
      <td class="mono">${escapeHtml(item.pattern)}</td>
      <td class="note-cell">${escapeHtml(item.note)}</td>
      <td class="mono">${escapeHtml(formatTime(item.updatedAt))}</td>
      <td class="actions">
        <button type="button" class="link" data-rule-edit="${escapeHtml(item.id)}">编辑</button>
        <button type="button" class="link danger" data-rule-delete="${escapeHtml(item.id)}">删除</button>
      </td>
    </tr>`).join('');
  el('rule-empty').classList.toggle('hidden', state.rules.length > 0);
}

function renderFiles() {
  const body = el('file-body');
  body.innerHTML = state.files.map((item) => `<tr>
      <td class="mono">${escapeHtml(item.path)}</td>
      <td>${escapeHtml(item.type)}</td>
      <td>${item.lineCount} 行</td>
      <td class="note-cell">${escapeHtml(item.note)}</td>
      <td class="mono">${escapeHtml(formatTime(item.updatedAt))}</td>
      <td class="actions">
        <button type="button" class="link" data-file-view="${escapeHtml(item.id)}">看内容</button>
        <button type="button" class="link" data-file-edit="${escapeHtml(item.id)}">编辑</button>
        <button type="button" class="link danger" data-file-delete="${escapeHtml(item.id)}">删除</button>
      </td>
    </tr>`).join('');
  el('file-empty').classList.toggle('hidden', state.files.length > 0);
}

function openRuleForm(rule) {
  state.editingRuleId = rule ? rule.id : '';
  el('rule-form-title').textContent = rule ? `编辑规则：${rule.code}` : '新建规则';
  el('rule-code').value = rule ? rule.code : '';
  el('rule-name').value = rule ? rule.name : '';
  el('rule-level').value = rule ? rule.level : (state.levels[0] || '提示');
  el('rule-status').value = rule ? rule.status : (state.statuses[0] || '启用');
  el('rule-file-type').value = rule ? rule.fileType : (state.fileTypes[0] || '全部');
  el('rule-pattern').value = rule ? rule.pattern : '';
  el('rule-note').value = rule ? rule.note : '';
  el('rule-form').classList.remove('hidden');
  el('rule-code').focus();
}

function closeRuleForm() {
  state.editingRuleId = '';
  el('rule-form').classList.add('hidden');
  clearFieldMarks();
}

function openFileForm(file) {
  state.editingFileId = file ? file.id : '';
  el('file-form-title').textContent = file ? `编辑文件：${file.path}` : '收录新文件';
  el('file-path').value = file ? file.path : '';
  el('file-content').value = file ? file.content : '';
  el('file-note').value = file ? file.note : '';
  el('file-form').classList.remove('hidden');
  el('file-path').focus();
}

function closeFileForm() {
  state.editingFileId = '';
  el('file-form').classList.add('hidden');
  clearFieldMarks();
}

async function showFileContent(id) {
  clearNotice();
  try {
    const file = await request(`/api/files/${encodeURIComponent(id)}`);
    const preview = el('file-preview');
    preview.textContent = `${file.path}（${file.lineCount} 行）\n${'─'.repeat(40)}\n${file.content}`;
    preview.classList.remove('hidden');
  } catch (err) {
    notify(err.message, 'error');
  }
}

async function submitRule(event) {
  event.preventDefault();
  clearNotice();
  clearFieldMarks();
  const payload = {
    code: el('rule-code').value,
    name: el('rule-name').value,
    level: el('rule-level').value,
    status: el('rule-status').value,
    fileType: el('rule-file-type').value,
    pattern: el('rule-pattern').value,
    note: el('rule-note').value,
  };
  const editing = state.editingRuleId;
  try {
    if (editing) {
      await request(`/api/rules/${encodeURIComponent(editing)}`, { method: 'PATCH', body: JSON.stringify(payload) });
      notify('规则已保存', 'ok');
    } else {
      await request('/api/rules', { method: 'POST', body: JSON.stringify(payload) });
      notify('规则已新增', 'ok');
    }
    closeRuleForm();
    await loadRules();
  } catch (err) {
    notify(err.message, 'error');
    markField(err.field);
  }
}

async function submitFile(event) {
  event.preventDefault();
  clearNotice();
  clearFieldMarks();
  const payload = {
    path: el('file-path').value,
    content: el('file-content').value,
    note: el('file-note').value,
  };
  const editing = state.editingFileId;
  try {
    if (editing) {
      await request(`/api/files/${encodeURIComponent(editing)}`, { method: 'PATCH', body: JSON.stringify(payload) });
      notify('文件已保存', 'ok');
    } else {
      await request('/api/files', { method: 'POST', body: JSON.stringify(payload) });
      notify('文件已收录', 'ok');
    }
    closeFileForm();
    await loadFiles();
  } catch (err) {
    notify(err.message, 'error');
    markField(err.field);
  }
}

// 扫一遍，把概要与命中清单都画出来
async function runScan() {
  clearNotice();
  const body = {
    ruleId: el('scan-rule').value,
    fileId: el('scan-file').value,
    level: el('scan-level').value,
  };
  try {
    const result = await request('/api/scan', { method: 'POST', body: JSON.stringify(body) });
    state.lastScan = result;
    renderScan(result);
  } catch (err) {
    notify(err.message, 'error');
  }
}

function renderScan(result) {
  el('scan-meta').textContent = `扫描时刻 ${formatTime(result.scannedAt)}　参与比对的规则 ${result.rulesUsed} 条（启用共 ${result.enabledRules} 条）　范围里的文件 ${result.filesInScope} 个（清单共 ${result.filesTotal} 个）`;

  const warningBox = el('scan-warning');
  if (result.warning) {
    warningBox.textContent = result.warning;
    warningBox.classList.remove('hidden');
  } else {
    warningBox.classList.add('hidden');
    warningBox.textContent = '';
  }

  renderScanSummary(result);
  renderScanTable(result);
}

// 两套口径并排给数：按条一条规则一行算一条；按处同一文件同一行算一处
function renderScanSummary(result) {
  const s = result.summary;
  const bh = s.byHit;
  const bp = s.byPlace;
  const maxAt = bp.maxRulesPlaces || [];
  const maxText = maxAt.map((item) => `${item.path}:${item.lineNo}`).join('、');
  const fanText = Object.keys(bp.fanOut).sort((a, b) => Number(a) - Number(b))
    .map((key) => `${key} 条规则 × ${bp.fanOut[key]} 处`).join('　');

  const check = s.check;
  const checkRows = [
    ['条总数 = 各处条数之和', check.hitTotal, check.placeHitSum],
    ['有效条 = 各处剩余有效之和', check.activeHits, check.placeActiveSum],
    ['已忽略条 = 各处已忽略之和', check.ignoredHits, check.placeIgnoredSum],
  ];
  const checkHtml = checkRows.map(([label, left, right]) => {
    const ok = left === right;
    return `<span class="check-item ${ok ? 'ok' : 'bad'}">${ok ? '✓' : '✗'} ${escapeHtml(label)}：${left} = ${right}</span>`;
  }).join('');

  el('scan-summary').innerHTML = `
    <div class="summary-grid">
      <div class="summary-card">
        <div class="summary-line"><strong>按条：共 ${bh.total} 条</strong>（有效 ${bh.active} 条、已忽略 ${bh.ignored} 条）</div>
        <div class="summary-line">按级别：${escapeHtml(levelCountsText(bh.byLevel, bh.activeByLevel))}</div>
        <div class="summary-line muted">括号里是剔除忽略后的有效条数</div>
      </div>
      <div class="summary-card">
        <div class="summary-line"><strong>按处：共 ${bp.total} 处</strong>（有效 ${bp.active} 处、整处忽略 ${bp.fullyIgnored} 处、部分忽略 ${bp.partiallyIgnored} 处）</div>
        <div class="summary-line">处的级别：${escapeHtml(levelCountsText(bp.byLevel, bp.activeByLevel))}</div>
        <div class="summary-line">同一处最多被 <strong>${bp.maxRulesAtPlace}</strong> 条规则同时抓到${maxText ? `（${escapeHtml(maxText)}）` : ''}；分布：${escapeHtml(fanText) || '—'}</div>
        <div class="summary-line muted">一处的整体级别按参与规则里最高的级别对待；有效级别指剔除被忽略条目后的最高级别</div>
      </div>
    </div>
    <div class="summary-line reconcile ${s.reconciled ? 'ok' : 'bad'}">
      <strong>两套数字勾稽：</strong>${checkHtml}
      ${s.reconciled ? '' : '　<strong>这一轮两套总数对不上，请检查</strong>'}
    </div>`;
  el('scan-summary').classList.remove('hidden');
}

function renderScanTable(result) {
  const box = el('hit-table-box');
  const byPlace = state.scanView === 'place';
  el('view-by-hit').classList.toggle('active', !byPlace);
  el('view-by-place').classList.toggle('active', byPlace);

  if (!byPlace) {
    box.innerHTML = `<table class="grid">
      <thead>
        <tr>
          <th>规则编码</th>
          <th>级别</th>
          <th>规则名称</th>
          <th>文件</th>
          <th>行号</th>
          <th>那一行的内容</th>
          <th>状态与操作</th>
        </tr>
      </thead>
      <tbody>${result.hits.map((hit) => `<tr class="${hit.ignored ? 'row-off' : ''}" data-file-id="${escapeHtml(hit.fileId)}" data-line-no="${hit.lineNo}">
          <td class="mono">${escapeHtml(hit.code)}</td>
          <td><span class="tag ${levelClass(hit.level)}">${escapeHtml(hit.level)}</span></td>
          <td>${escapeHtml(hit.ruleName)}</td>
          <td class="mono">${escapeHtml(hit.path)}</td>
          <td class="mono">${hit.lineNo}</td>
          <td class="mono line-cell">${escapeHtml(hit.lineText)}</td>
          <td class="actions">${hit.ignored
            ? `已忽略${hit.ignoreReason ? `：${escapeHtml(hit.ignoreReason)}` : ''}
               <button type="button" class="link" data-ignore-cancel="${escapeHtml(hit.ignoreId)}">取消忽略</button>`
            : `<button type="button" class="link" data-ignore-add="${escapeHtml(hit.ruleId)}">忽略这条</button>`}</td>
        </tr>`).join('')}</tbody>
    </table>`;
    el('hit-empty').classList.toggle('hidden', result.hits.length > 0);
    return;
  }

  box.innerHTML = `<table class="grid place-grid">
    <thead>
      <tr>
        <th>文件</th>
        <th>行号</th>
        <th>那一行的内容</th>
        <th>参与抓到的规则（编码与级别）</th>
        <th>条数（剩余有效）</th>
        <th>这处整体级别与依据</th>
      </tr>
    </thead>
    <tbody>${result.places.map((place) => {
      const basis = place.levelMixed
        ? `参与规则级别不一致（${escapeHtml(place.distinctLevels.join('、'))}），按最高的 <strong>${escapeHtml(place.level)}</strong> 对待，依据：${escapeHtml(place.levelCodes.join('、'))}`
        : `参与规则同为 <strong>${escapeHtml(place.level)}</strong>，这处整体按${escapeHtml(place.level)}对待`;
      const activeBasis = place.fullyIgnored
        ? '<span class="chip-state off">这处条目已全部忽略，不计有效</span>'
        : `剔除忽略后还剩 <strong>${place.activeCount}</strong> 条有效，有效级别按 <strong>${escapeHtml(place.activeLevel)}</strong>${place.activeLevelCodes.length ? `（${escapeHtml(place.activeLevelCodes.join('、'))}）` : ''}`;
      return `<tr class="${place.fullyIgnored ? 'row-off' : ''}" data-file-id="${escapeHtml(place.fileId)}" data-line-no="${place.lineNo}">
        <td class="mono">${escapeHtml(place.path)}</td>
        <td class="mono">${place.lineNo}</td>
        <td class="mono line-cell">${escapeHtml(place.lineText)}</td>
        <td><div class="chip-box">${ruleChips(place.rules)}</div></td>
        <td class="mono">${place.hitCount} 条<br><span class="${place.activeCount ? '' : 'chip-state off'}">有效 ${place.activeCount}　忽略 ${place.ignoredCount}</span></td>
        <td><div>${basis}</div><div class="muted">${activeBasis}</div></td>
      </tr>`;
    }).join('')}</tbody>
  </table>`;
  el('hit-empty').classList.toggle('hidden', result.places.length > 0);
}

// 登记一条忽略：忽略粒度是一条命中（某规则在某文件某一行）
async function addIgnore(ruleId, fileId, lineNo) {
  const operator = currentOperator();
  if (!operator) {
    notify('请先在页面右上角填上当前操作者，再登记忽略', 'error');
    el('operator').focus();
    return;
  }
  const reason = window.prompt('写清忽略这条命中的原因（同一行上别的规则不受影响）');
  if (reason === null) return;
  if (!reason.trim()) {
    notify('忽略原因不能为空', 'error');
    return;
  }
  try {
    await request('/api/ignores', {
      method: 'POST',
      body: JSON.stringify({ ruleId, fileId, lineNo: Number(lineNo), reason, operator }),
    });
    notify('已登记忽略，这一轮结果已按新口径重算', 'ok');
    await Promise.all([loadIgnores(), rerunLastScan()]);
  } catch (err) {
    notify(err.message, 'error');
  }
}

async function cancelIgnore(ignoreId) {
  try {
    await request(`/api/ignores/${encodeURIComponent(ignoreId)}`, { method: 'DELETE' });
    notify('已取消忽略，这条命中重新计入', 'ok');
    await Promise.all([loadIgnores(), rerunLastScan()]);
  } catch (err) {
    notify(err.message, 'error');
  }
}

// 登记或取消忽略后沿用上次的范围条件重扫，保证两套数字还是同一轮结果
async function rerunLastScan() {
  const body = {
    ruleId: el('scan-rule').value,
    fileId: el('scan-file').value,
    level: el('scan-level').value,
  };
  try {
    const result = await request('/api/scan', { method: 'POST', body: JSON.stringify(body) });
    state.lastScan = result;
    renderScan(result);
  } catch (err) {
    notify(err.message, 'error');
  }
}

async function loadIgnores() {
  const payload = await request('/api/ignores');
  state.ignores = payload.ignores || [];
  renderIgnores();
}

function renderIgnores() {
  const body = el('ignore-body');
  body.innerHTML = state.ignores.map((item) => `<tr>
      <td class="mono">${escapeHtml(item.code)}</td>
      <td><span class="tag ${levelClass(item.level)}">${escapeHtml(item.level)}</span></td>
      <td class="mono">${escapeHtml(item.path)}</td>
      <td class="mono">${item.lineNo}</td>
      <td class="mono line-cell">${escapeHtml(item.lineText)}</td>
      <td class="note-cell">${escapeHtml(item.reason)}</td>
      <td>${escapeHtml(item.operator)}</td>
      <td class="mono">${escapeHtml(formatTime(item.createdAt))}</td>
      <td class="actions"><button type="button" class="link danger" data-ignore-cancel="${escapeHtml(item.id)}">取消忽略</button></td>
    </tr>`).join('');
  el('ignore-empty').classList.toggle('hidden', state.ignores.length > 0);
}

// 列表上的操作用事件委托统一处理，列表重绘之后不需要重新绑定
document.addEventListener('click', async (event) => {
  const node = event.target.closest('button');
  if (!node) return;

  if (node.dataset.ignoreAdd !== undefined) {
    clearNotice();
    const row = node.closest('tr');
    const fileId = row ? row.dataset.fileId : '';
    const lineNo = row ? row.dataset.lineNo : '';
    if (!fileId || !lineNo) {
      notify('找不到这条命中对应的文件与行号', 'error');
      return;
    }
    await addIgnore(node.dataset.ignoreAdd, fileId, lineNo);
    return;
  }

  if (node.dataset.ignoreCancel !== undefined) {
    clearNotice();
    await cancelIgnore(node.dataset.ignoreCancel);
    return;
  }

  if (node.dataset.ruleEdit) {
    clearNotice();
    const found = state.rules.find((item) => item.id === node.dataset.ruleEdit);
    if (found) openRuleForm(found);
    return;
  }

  if (node.dataset.ruleDelete) {
    clearNotice();
    const found = state.rules.find((item) => item.id === node.dataset.ruleDelete);
    if (!window.confirm(`确定删除规则 ${found ? found.code : ''} 吗？`)) return;
    try {
      await request(`/api/rules/${encodeURIComponent(node.dataset.ruleDelete)}`, { method: 'DELETE' });
      if (state.editingRuleId === node.dataset.ruleDelete) closeRuleForm();
      notify('规则已删除', 'ok');
      await loadRules();
    } catch (err) {
      notify(err.message, 'error');
    }
    return;
  }

  if (node.dataset.fileView) {
    await showFileContent(node.dataset.fileView);
    return;
  }

  if (node.dataset.fileEdit) {
    clearNotice();
    try {
      const file = await request(`/api/files/${encodeURIComponent(node.dataset.fileEdit)}`);
      openFileForm(file);
    } catch (err) {
      notify(err.message, 'error');
    }
    return;
  }

  if (node.dataset.fileDelete) {
    clearNotice();
    const found = state.files.find((item) => item.id === node.dataset.fileDelete);
    if (!window.confirm(`确定把 ${found ? found.path : ''} 移出清单吗？`)) return;
    try {
      await request(`/api/files/${encodeURIComponent(node.dataset.fileDelete)}`, { method: 'DELETE' });
      if (state.editingFileId === node.dataset.fileDelete) closeFileForm();
      el('file-preview').classList.add('hidden');
      notify('文件已移出清单', 'ok');
      await loadFiles();
    } catch (err) {
      notify(err.message, 'error');
    }
  }
});

el('rule-form').addEventListener('submit', submitRule);
el('file-form').addEventListener('submit', submitFile);
el('rule-new').addEventListener('click', () => {
  clearNotice();
  openRuleForm(null);
});
el('rule-cancel').addEventListener('click', closeRuleForm);
el('file-new').addEventListener('click', () => {
  clearNotice();
  openFileForm(null);
});
el('file-cancel').addEventListener('click', closeFileForm);
el('rule-filter-apply').addEventListener('click', () => {
  clearNotice();
  loadRules().catch((err) => notify(err.message, 'error'));
});
el('rule-filter-reset').addEventListener('click', () => {
  el('rule-filter-level').value = '';
  el('rule-filter-status').value = '';
  el('rule-filter-type').value = '';
  el('rule-filter-keyword').value = '';
  loadRules().catch((err) => notify(err.message, 'error'));
});
el('rule-refresh').addEventListener('click', () => {
  clearNotice();
  loadRules()
    .then(loadFiles)
    .catch((err) => notify(err.message, 'error'));
});
el('file-filter-apply').addEventListener('click', () => {
  clearNotice();
  loadFiles().catch((err) => notify(err.message, 'error'));
});
el('file-filter-reset').addEventListener('click', () => {
  el('file-filter-type').value = '';
  el('file-filter-keyword').value = '';
  loadFiles().catch((err) => notify(err.message, 'error'));
});
el('scan-run').addEventListener('click', runScan);
el('view-by-hit').addEventListener('click', () => {
  state.scanView = 'hit';
  if (state.lastScan) renderScan(state.lastScan);
});
el('view-by-place').addEventListener('click', () => {
  state.scanView = 'place';
  if (state.lastScan) renderScan(state.lastScan);
});
el('ignore-refresh').addEventListener('click', () => {
  clearNotice();
  loadIgnores().catch((err) => notify(err.message, 'error'));
});
el('rule-filter-level').addEventListener('change', () => {
  loadRules().catch((err) => notify(err.message, 'error'));
});
el('rule-filter-status').addEventListener('change', () => {
  loadRules().catch((err) => notify(err.message, 'error'));
});
el('operator').addEventListener('change', () => {
  window.localStorage.setItem(OPERATOR_KEY, currentOperator());
});

// 页面打开时先把规则、文件与忽略清单都拉一遍，扫描的范围下拉依赖规则与文件两份清单
restoreOperator();
loadHealth();
loadRules()
  .then(loadFiles)
  .then(loadIgnores)
  .catch((err) => notify(err.message, 'error'));

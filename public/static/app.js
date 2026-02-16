/**
 * あゆっこ業務自動化 — Frontend Application v3.3
 * Single-screen MVP: Upload → Generate → Results with 3-category output
 * 
 * Architecture: UI → Hono proxy → Python Generator → ZIP
 * 
 * v3.3 Enhancements:
 *   - Full meta-driven results display from _meta.json
 *   - 3-category output cards (university, accounting, parents)
 *   - Expanded warnings panel with child names and suggestions
 *   - Submission status panel with submitted/not-submitted/unmatched
 *   - Real progress messages
 *   - Improved error and fatal corruption display
 */

// State
const state = {
  files: {
    lukumi: [],
    schedule: [],
    daily_template: [],
    billing_template: [],
  },
  generating: false,
  lastMeta: null,
  lastBlob: null,
  lastFilename: null,
};

// ===== Drag & Drop =====
function handleDragOver(e) {
  e.preventDefault();
  e.currentTarget.classList.add('drag-over');
}

function handleDragLeave(e) {
  e.currentTarget.classList.remove('drag-over');
}

function handleDrop(e, type) {
  e.preventDefault();
  e.currentTarget.classList.remove('drag-over');
  addFiles(Array.from(e.dataTransfer.files), type);
}

function handleFileSelect(e, type) {
  addFiles(Array.from(e.target.files), type);
}

function addFiles(files, type) {
  if (type === 'lukumi' || type === 'daily_template' || type === 'billing_template') {
    state.files[type] = files.slice(0, 1);
  } else {
    state.files[type] = [...state.files[type], ...files];
  }
  renderFileList(type);
  updateSummary();
}

function removeFile(type, index) {
  state.files[type].splice(index, 1);
  renderFileList(type);
  updateSummary();
}

function renderFileList(type) {
  const container = document.getElementById(`file-list-${type}`);
  if (!container) return;
  const files = state.files[type];
  if (files.length === 0) { container.innerHTML = ''; return; }
  container.innerHTML = files.map((f, i) => `
    <div class="flex items-center justify-between bg-gray-50 rounded-lg px-3 py-1.5">
      <div class="flex items-center gap-2 min-w-0">
        <i class="fas fa-file-excel text-green-500 text-xs flex-shrink-0"></i>
        <span class="text-xs text-gray-700 truncate">${f.name}</span>
        <span class="text-xs text-gray-400">(${formatFileSize(f.size)})</span>
      </div>
      <button onclick="removeFile('${type}', ${i})" class="text-gray-400 hover:text-red-500 ml-2 flex-shrink-0">
        <i class="fas fa-times text-xs"></i>
      </button>
    </div>
  `).join('');
}

function updateSummary() {
  const summary = document.getElementById('upload-summary');
  const text = document.getElementById('summary-text');
  const hasLukumi = state.files.lukumi.length > 0;
  const scheduleCount = state.files.schedule.length;
  const hasDaily = state.files.daily_template.length > 0;
  const hasBilling = state.files.billing_template.length > 0;

  if (hasLukumi || scheduleCount > 0) {
    summary.classList.remove('hidden');
    const parts = [];
    if (hasLukumi) parts.push('ルクミー: 1件');
    if (scheduleCount > 0) parts.push(`予定表: ${scheduleCount}件`);
    if (hasDaily) parts.push('日報テンプレ: ✓');
    if (hasBilling) parts.push('明細テンプレ: ✓');
    text.textContent = parts.join(' / ');

    const btn = document.getElementById('btn-generate');
    if (btn) btn.disabled = !hasLukumi;
  } else {
    summary.classList.add('hidden');
  }
}

// ===== Generation =====
async function startGeneration() {
  if (state.generating) return;

  const year = parseInt(document.getElementById('year-select').value);
  const month = parseInt(document.getElementById('month-select').value);

  if (state.files.lukumi.length === 0) {
    alert('ルクミー登降園データをアップロードしてください');
    return;
  }

  state.generating = true;
  const btn = document.getElementById('btn-generate');
  btn.disabled = true;
  btn.innerHTML = '<i class="fas fa-spinner fa-spin mr-1"></i>生成中...';

  showProgress();
  clearProgressLog();
  updateProgress(5, 'ファイルを準備中...');

  try {
    const formData = new FormData();
    formData.append('year', year.toString());
    formData.append('month', month.toString());
    formData.append('lukumi_file', state.files.lukumi[0]);

    state.files.schedule.forEach(f => {
      formData.append('schedule_files', f);
    });

    if (state.files.daily_template.length > 0) {
      formData.append('daily_report_template', state.files.daily_template[0]);
    }
    if (state.files.billing_template.length > 0) {
      formData.append('billing_template', state.files.billing_template[0]);
    }

    updateProgress(10, `ルクミーデータ送信中...`);
    updateProgress(15, `${state.files.schedule.length}件の予定表を処理中...`);

    // Send to Hono proxy → Python Generator
    const response = await fetch('/api/jobs/generate', {
      method: 'POST',
      body: formData,
    });

    updateProgress(70, 'レスポンスを受信中...');

    // Handle fatal corruption (422)
    if (response.status === 422) {
      const errorData = await response.json();
      updateProgress(0, '⛔ テンプレート破損検出 — 処理中止');
      showFatalResult(errorData);
      return;
    }

    if (!response.ok) {
      let errorData;
      try {
        errorData = await response.json();
      } catch {
        errorData = { error: `HTTP ${response.status}: ${response.statusText}` };
      }
      updateProgress(0, `エラー: ${errorData.error || '生成に失敗しました'}`);
      showErrorResult(errorData);
      return;
    }

    updateProgress(85, 'ZIPを展開中...');

    const blob = await response.blob();

    // ★ Extract full _meta.json from ZIP (JSZip)
    let meta = null;
    try {
      const zip = await JSZip.loadAsync(blob);
      const metaFile = zip.file('_meta.json');
      if (metaFile) {
        const metaText = await metaFile.async('text');
        meta = JSON.parse(metaText);
      }
    } catch (e) {
      console.warn('Failed to extract _meta.json from ZIP:', e);
      // Fallback: try header
      try {
        const metaStr = response.headers.get('X-Meta-Json');
        if (metaStr) meta = JSON.parse(metaStr);
      } catch (e2) { /* ignore */ }
    }

    const warnings = meta?.warnings || [];
    const stats = meta?.stats || {};
    const childrenCount = stats.children_processed || parseInt(response.headers.get('X-Children-Processed') || '0');
    const warningsCount = warnings.length;

    state.lastMeta = meta;
    state.lastBlob = blob;
    state.lastFilename = `あゆっこ_${year}年${String(month).padStart(2, '0')}月.zip`;

    updateProgress(100, `✅ 生成完了！ ${childrenCount}名処理, ${formatFileSize(blob.size)}`);

    showSuccessResult(blob, year, month, warningsCount, childrenCount, meta, warnings);

  } catch (error) {
    updateProgress(0, `接続エラー: ${error.message}`);
    showErrorResult({ error: error.message, suggestion: 'ネットワーク接続を確認してください' });
  } finally {
    state.generating = false;
    btn.disabled = false;
    btn.innerHTML = '<i class="fas fa-magic mr-1"></i>生成開始';
  }
}

function showProgress() {
  document.getElementById('step-progress').classList.remove('hidden');
  document.getElementById('step-result').classList.add('hidden');
  document.getElementById('step-progress').scrollIntoView({ behavior: 'smooth' });
}

function clearProgressLog() {
  document.getElementById('progress-log').innerHTML = '';
}

function updateProgress(pct, text) {
  document.getElementById('progress-bar').style.width = `${pct}%`;
  document.getElementById('progress-text').textContent = text;
  const log = document.getElementById('progress-log');
  const time = new Date().toLocaleTimeString('ja-JP');
  log.innerHTML += `<div>[${time}] ${text}</div>`;
  log.scrollTop = log.scrollHeight;
}

// ===== Results Display =====

function showSuccessResult(blob, year, month, warningsCount, childrenCount, meta, warnings) {
  const resultDiv = document.getElementById('step-result');
  resultDiv.classList.remove('hidden');
  resultDiv.scrollIntoView({ behavior: 'smooth' });

  const subReport = meta?.submission_report;
  const stats = meta?.stats || {};
  // warnings is already passed as parameter from _meta.json extraction

  // Show download button
  const dlBtn = document.getElementById('btn-download-zip');
  dlBtn.style.display = '';

  // ── Submission status panel (B-4) — show FIRST (needs-attention at top) ──
  if (subReport && (subReport.not_submitted?.length > 0 || subReport.unmatched_schedules?.length > 0)) {
    document.getElementById('result-submission').innerHTML = _renderSubmissionPanel(subReport);
  } else if (subReport) {
    // All submitted — collapsed
    document.getElementById('result-submission').innerHTML = _renderSubmissionPanel(subReport);
  } else {
    document.getElementById('result-submission').innerHTML = '';
  }

  // ── Output cards (3 categories) ──
  const hasDailyTemplate = state.files.daily_template.length > 0;
  const hasBillingTemplate = state.files.billing_template.length > 0;
  const pdfCount = meta?.pdf_count || childrenCount;

  document.getElementById('result-files').innerHTML = `
    <div class="grid grid-cols-1 md:grid-cols-3 gap-3 mb-4">
      ${_renderOutputCard('university', '01_園内管理', 'fas fa-school', 'green',
        '園児登園確認表・児童実績表・◆保育時間',
        hasDailyTemplate ? '日報Excel内シート書き込み済' : 'テンプレ未指定（スキップ）',
        hasDailyTemplate)}
      ${_renderOutputCard('accounting', '02_経理提出', 'fas fa-file-invoice-dollar', 'purple',
        '保育料明細（数量列のみ更新）',
        hasBillingTemplate ? '明細Excel数量列更新済' : 'テンプレ未指定（スキップ）',
        hasBillingTemplate)}
      ${_renderOutputCard('parents', '03_保護者配布', 'fas fa-file-pdf', 'blue',
        `利用明細書PDF（${pdfCount}名分）`,
        `${pdfCount}名分のPDFを自動生成`, true)}
    </div>
    <div class="bg-gray-50 rounded-lg p-3 flex items-center justify-between">
      <div class="text-sm text-gray-700">
        <i class="fas fa-file-archive text-blue-500 mr-1"></i>
        <strong>出力ZIP</strong>: ${formatFileSize(blob.size)}
        <span class="text-xs text-gray-500 ml-2">（3フォルダ + _meta.json）</span>
      </div>
      <button onclick="downloadZip()" class="bg-blue-600 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-blue-700 transition-colors">
        <i class="fas fa-download mr-1"></i>ZIP一括ダウンロード
      </button>
    </div>
  `;

  // (submission panel already rendered above — at the top)

  // ── Stats ──
  document.getElementById('result-stats').innerHTML = `
    <div class="flex flex-wrap gap-3 text-sm mt-3">
      <span class="bg-blue-50 text-blue-800 px-3 py-1.5 rounded-full font-medium">
        <i class="fas fa-child mr-1"></i>${childrenCount} 名処理
      </span>
      <span class="bg-green-50 text-green-800 px-3 py-1.5 rounded-full font-medium">
        <i class="fas fa-link mr-1"></i>${stats.schedules_matched || 0} 件予定表突合
      </span>
      ${warningsCount > 0 ? `
      <span class="bg-yellow-50 text-yellow-800 px-3 py-1.5 rounded-full font-medium">
        <i class="fas fa-exclamation-triangle mr-1"></i>${warningsCount} 件注意
      </span>` : ''}
      ${(stats.total_errors || 0) > 0 ? `
      <span class="bg-red-50 text-red-800 px-3 py-1.5 rounded-full font-medium">
        <i class="fas fa-times-circle mr-1"></i>${stats.total_errors} 件エラー
      </span>` : ''}
      <span class="bg-gray-100 text-gray-700 px-3 py-1.5 rounded-full">
        <i class="fas fa-calendar mr-1"></i>${year}年${month}月
      </span>
    </div>
  `;

  // ── Warnings panel (expanded with details) ──
  if (warnings.length > 0) {
    document.getElementById('result-warnings').innerHTML = _renderWarningsPanel(warnings);
  } else {
    document.getElementById('result-warnings').innerHTML = `
      <div class="bg-green-50 rounded-lg border border-green-200 px-4 py-3 mt-4">
        <span class="text-sm text-green-700"><i class="fas fa-check-circle mr-1"></i>警告なし — 全データが正常に処理されました</span>
      </div>
    `;
  }
}

function _renderOutputCard(category, title, icon, color, desc, subtext, active) {
  const opacity = active ? '' : 'opacity-50';
  const badge = active
    ? `<span class="text-xs bg-${color}-100 text-${color}-700 px-2 py-0.5 rounded-full font-medium">
        <i class="fas fa-check mr-0.5"></i>含まれています
      </span>`
    : `<span class="text-xs bg-gray-100 text-gray-500 px-2 py-0.5 rounded-full">スキップ</span>`;
  return `
    <div class="bg-${color}-50 rounded-xl p-4 border border-${color}-200 ${opacity}">
      <div class="flex items-center justify-between mb-2">
        <div class="flex items-center gap-2">
          <div class="w-8 h-8 bg-${color}-100 rounded-lg flex items-center justify-center">
            <i class="${icon} text-${color}-600"></i>
          </div>
          <h4 class="font-semibold text-${color}-800 text-sm">${title}</h4>
        </div>
        ${badge}
      </div>
      <p class="text-xs text-${color}-700 mb-1">${desc}</p>
      <p class="text-xs text-${color}-500">${subtext}</p>
    </div>
  `;
}

function _renderSubmissionPanel(report) {
  const { submitted = [], not_submitted = [], unmatched_schedules = [], summary = {} } = report;
  const hasIssues = not_submitted.length > 0 || unmatched_schedules.length > 0;

  let html = `
    <div class="bg-white rounded-xl border ${hasIssues ? 'border-orange-200' : 'border-gray-200'} mt-4 shadow-sm">
      <div class="px-4 py-3 border-b border-gray-100 flex items-center justify-between">
        <h4 class="text-sm font-semibold text-gray-800">
          <i class="fas fa-clipboard-check text-blue-500 mr-1"></i>予定表提出状況
        </h4>
        <div class="flex gap-3 text-xs">
          <span class="text-green-600 font-medium"><i class="fas fa-check-circle mr-0.5"></i>${summary.submitted || 0} 提出</span>
          <span class="text-orange-600 font-medium"><i class="fas fa-exclamation-circle mr-0.5"></i>${summary.not_submitted || 0} 未提出</span>
          ${(summary.unmatched || 0) > 0 ? `<span class="text-red-600 font-medium"><i class="fas fa-times-circle mr-0.5"></i>${summary.unmatched} 不明</span>` : ''}
        </div>
      </div>
      <div class="p-4">
  `;

  // Not-submitted (needs attention — always show first)
  if (not_submitted.length > 0) {
    html += `
      <div class="mb-4">
        <h5 class="text-xs font-bold text-orange-700 mb-2 flex items-center gap-1">
          <i class="fas fa-exclamation-triangle"></i>要確認（予定表未提出）
        </h5>
        <div class="grid grid-cols-2 md:grid-cols-3 gap-2">
          ${not_submitted.map(ns => `
            <div class="bg-orange-50 px-3 py-2 rounded-lg text-xs border border-orange-100">
              <div class="font-medium text-orange-800">${ns.name}</div>
              <div class="text-orange-500 mt-0.5">${ns.reason || ''}</div>
            </div>
          `).join('')}
        </div>
      </div>
    `;
  }

  // Unmatched schedule files
  if (unmatched_schedules.length > 0) {
    html += `
      <div class="mb-4">
        <h5 class="text-xs font-bold text-red-700 mb-2 flex items-center gap-1">
          <i class="fas fa-question-circle"></i>突合できなかった予定表ファイル
        </h5>
        <div class="space-y-1.5">
          ${unmatched_schedules.map(us => `
            <div class="bg-red-50 px-3 py-2 rounded-lg text-xs border border-red-100">
              <span class="font-medium text-red-800">${us.schedule_name}</span>
              <span class="text-red-500 ml-1">— ${us.reason}</span>
            </div>
          `).join('')}
        </div>
      </div>
    `;
  }

  // Submitted (collapsed by default)
  if (submitted.length > 0) {
    html += `
      <details>
        <summary class="text-xs font-bold text-green-700 cursor-pointer mb-2 flex items-center gap-1">
          <i class="fas fa-check-circle"></i>提出済み (${submitted.length}名)
          <span class="text-green-500 font-normal ml-1">クリックで展開</span>
        </summary>
        <div class="grid grid-cols-3 md:grid-cols-4 gap-1.5">
          ${submitted.map(s => `
            <div class="bg-green-50 px-2.5 py-1.5 rounded text-xs text-green-700 border border-green-100">${s.name}</div>
          `).join('')}
        </div>
      </details>
    `;
  }

  html += '</div></div>';
  return html;
}

function _renderWarningsPanel(warnings) {
  const errors = warnings.filter(w => w.level === 'error');
  const warns = warnings.filter(w => w.level === 'warn');
  const infos = warnings.filter(w => w.level === 'info');

  let html = `
    <div class="mt-4 space-y-3">
  `;

  // Errors (always expanded)
  if (errors.length > 0) {
    html += `
      <div class="bg-red-50 rounded-xl border border-red-200 overflow-hidden">
        <div class="px-4 py-2.5 bg-red-100 text-red-800 text-sm font-semibold flex items-center gap-1">
          <i class="fas fa-times-circle"></i>エラー (${errors.length}件)
        </div>
        <div class="p-4 space-y-2">
          ${errors.map(w => _renderWarningItem(w, 'red')).join('')}
        </div>
      </div>
    `;
  }

  // Warnings (expanded if few, collapsed if many)
  if (warns.length > 0) {
    const isOpen = warns.length <= 5 ? 'open' : '';
    html += `
      <details ${isOpen} class="bg-yellow-50 rounded-xl border border-yellow-200 overflow-hidden">
        <summary class="px-4 py-2.5 bg-yellow-100 text-yellow-800 text-sm font-semibold cursor-pointer flex items-center gap-1">
          <i class="fas fa-exclamation-triangle"></i>警告 (${warns.length}件)
          ${warns.length > 5 ? `<span class="text-yellow-600 font-normal text-xs ml-2">クリックで展開</span>` : ''}
        </summary>
        <div class="p-4 space-y-2 max-h-60 overflow-y-auto">
          ${warns.map(w => _renderWarningItem(w, 'yellow')).join('')}
        </div>
      </details>
    `;
  }

  // Info (always collapsed)
  if (infos.length > 0) {
    html += `
      <details class="bg-blue-50 rounded-xl border border-blue-200 overflow-hidden">
        <summary class="px-4 py-2.5 bg-blue-100 text-blue-800 text-sm font-semibold cursor-pointer flex items-center gap-1">
          <i class="fas fa-info-circle"></i>情報 (${infos.length}件)
          <span class="text-blue-600 font-normal text-xs ml-2">クリックで展開</span>
        </summary>
        <div class="p-4 space-y-2 max-h-48 overflow-y-auto">
          ${infos.map(w => _renderWarningItem(w, 'blue')).join('')}
        </div>
      </details>
    `;
  }

  html += '</div>';
  return html;
}

function _renderWarningItem(w, color) {
  return `
    <div class="bg-white rounded-lg px-3 py-2 border border-${color}-100">
      <div class="flex items-start gap-2">
        ${w.child_name ? `<span class="text-xs font-medium text-${color}-800 bg-${color}-100 px-1.5 py-0.5 rounded whitespace-nowrap">${w.child_name}</span>` : ''}
        <div class="text-xs text-${color}-700 flex-1">${w.message}</div>
      </div>
      ${w.suggestion ? `<div class="text-xs text-${color}-500 mt-1 ml-1"><i class="fas fa-lightbulb mr-1"></i>${w.suggestion}</div>` : ''}
    </div>
  `;
}

function showFatalResult(errorData) {
  const resultDiv = document.getElementById('step-result');
  resultDiv.classList.remove('hidden');

  // Hide download button
  document.getElementById('btn-download-zip').style.display = 'none';

  document.getElementById('result-files').innerHTML = `
    <div class="bg-red-50 rounded-xl p-5 border-2 border-red-300">
      <div class="flex items-center gap-3 mb-3">
        <div class="w-12 h-12 bg-red-100 rounded-full flex items-center justify-center flex-shrink-0">
          <i class="fas fa-shield-alt text-red-600 text-2xl"></i>
        </div>
        <div>
          <h4 class="font-bold text-red-800 text-base">テンプレート破損検出 — 全出力中止</h4>
          <p class="text-xs text-red-600">安全ガードにより、全出力ファイルの生成を中止しました</p>
        </div>
      </div>
      <div class="bg-white rounded-lg p-4 border border-red-200 mt-3">
        <p class="text-sm text-red-700 font-medium">${errorData.error || '不明なエラー'}</p>
        <div class="mt-3 bg-red-50 rounded p-3">
          <p class="text-xs text-red-600">
            <i class="fas fa-info-circle mr-1"></i>
            <strong>対処方法:</strong> テンプレートExcelをPC版Excelで開き、#REF! や #VALUE! エラーを修正してから再度アップロードしてください。
          </p>
        </div>
      </div>
    </div>
  `;

  // Show submission report even on fatal error
  if (errorData.submission_report) {
    document.getElementById('result-submission').innerHTML = _renderSubmissionPanel(errorData.submission_report);
  } else {
    document.getElementById('result-submission').innerHTML = '';
  }

  // Show warnings if present
  if (errorData.warnings && errorData.warnings.length > 0) {
    document.getElementById('result-warnings').innerHTML = _renderWarningsPanel(errorData.warnings);
  } else {
    document.getElementById('result-warnings').innerHTML = '';
  }

  document.getElementById('result-stats').innerHTML = '';
}

function showErrorResult(errorData) {
  const resultDiv = document.getElementById('step-result');
  resultDiv.classList.remove('hidden');

  document.getElementById('btn-download-zip').style.display = 'none';

  document.getElementById('result-files').innerHTML = `
    <div class="bg-red-50 rounded-xl p-5 border border-red-200">
      <div class="flex items-center gap-3 mb-3">
        <div class="w-10 h-10 bg-red-100 rounded-full flex items-center justify-center flex-shrink-0">
          <i class="fas fa-exclamation-circle text-red-500 text-xl"></i>
        </div>
        <div>
          <h4 class="font-semibold text-red-800">生成に失敗しました</h4>
          <p class="text-sm text-red-700 mt-1">${errorData.error || '不明なエラー'}</p>
        </div>
      </div>
      ${errorData.suggestion ? `
        <div class="bg-white rounded-lg p-3 border border-red-100 mt-2">
          <p class="text-xs text-red-600"><i class="fas fa-lightbulb mr-1"></i>${errorData.suggestion}</p>
        </div>
      ` : ''}
      ${errorData.traceback ? `
        <details class="mt-3">
          <summary class="text-xs text-red-500 cursor-pointer">技術詳細を表示</summary>
          <pre class="text-xs text-red-400 bg-red-900/10 rounded p-2 mt-1 overflow-x-auto max-h-40">${errorData.traceback}</pre>
        </details>
      ` : ''}
    </div>
  `;

  document.getElementById('result-submission').innerHTML = '';
  document.getElementById('result-stats').innerHTML = '';
  document.getElementById('result-warnings').innerHTML = '';
}

function downloadZip() {
  if (!state.lastBlob) {
    alert('ダウンロード可能なファイルがありません');
    return;
  }

  const url = URL.createObjectURL(state.lastBlob);
  const a = document.createElement('a');
  a.href = url;
  a.download = state.lastFilename || 'output.zip';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// ===== Reset =====
function resetAll() {
  state.files = { lukumi: [], schedule: [], daily_template: [], billing_template: [] };
  state.generating = false;
  state.lastMeta = null;
  state.lastBlob = null;
  state.lastFilename = null;

  ['lukumi', 'schedule', 'daily_template', 'billing_template'].forEach(type => {
    renderFileList(type);
    const input = document.getElementById(`input-${type}`);
    if (input) input.value = '';
  });

  updateSummary();
  document.getElementById('step-progress').classList.add('hidden');
  document.getElementById('step-result').classList.add('hidden');
}

// ===== Helpers =====
function formatFileSize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

// ===== Init =====
document.addEventListener('DOMContentLoaded', () => {
  // Health check
  fetch('/api/health').then(r => r.json()).then(data => {
    if (data) {
      document.getElementById('health-status').innerHTML =
        `<i class="fas fa-circle text-green-400 mr-1"></i>v${data.version}`;
    }
  }).catch(() => {
    document.getElementById('health-status').innerHTML =
      `<i class="fas fa-circle text-red-400 mr-1"></i>オフライン`;
  });

  // Set current month as default
  const now = new Date();
  const yearSel = document.getElementById('year-select');
  const monthSel = document.getElementById('month-select');
  if (yearSel) yearSel.value = String(now.getFullYear());
  if (monthSel) monthSel.value = String(now.getMonth() + 1);
});

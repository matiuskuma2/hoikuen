/**
 * あゆっこ業務自動化 — Frontend Application v4.5
 * 
 * Architecture: UI → Hono proxy → Python Generator
 * 
 * v4.5: ダッシュボード大幅強化
 *   - カレンダーに登園予定時間を表示
 *   - 食事を4区分に分離（昼食・朝おやつ・午後おやつ・夕食）
 *   - クラス名表示（ルクミーA列のデータ）
 *   - ダッシュボード上で食事・時間の手動編集（キャンセル等）
 *   - 病児保育の手動入力
 *   - 編集データはメモリ内保持（生成時に反映）
 *
 * v4.4 (retained): コード品質改善 (QAチェックリスト対応)
 *
 * v4.3 (retained): テンプレート登録UX改善, 初回登録セクション分離, localStorage状態管理
 * v4.2 (retained): 今日/明日/今週/月間 サブタブ, ZIP説明, AI読み取り, マニュアル
 * v4.1 (retained): Guide card, today summary banner, meal badges, day detail table
 * v4.0 (retained): Tab nav, calendar grid, day-click detail, generation
 * v3.3 (retained): _meta.json, 3-category output, warnings, submission
 */

// ═══════════════════════════════════════════
// CONSTANTS
// ═══════════════════════════════════════════

const VIEWS = Object.freeze({
  TODAY: 'today',
  TOMORROW: 'tomorrow',
  WEEK: 'week',
  MONTH: 'month',
});

const TABS = Object.freeze({
  DASHBOARD: 'dashboard',
  UPLOAD: 'upload',
  GENERATE: 'generate',
});

/** File validation rules per category */
const FILE_RULES = Object.freeze({
  lukumi:           { extensions: ['.xlsx', '.csv'],           maxSizeMB: 50, maxFiles: 1 },
  schedule:         { extensions: ['.xlsx'],                   maxSizeMB: 50, maxFiles: 50 },
  daily_template:   { extensions: ['.xlsx'],                   maxSizeMB: 50, maxFiles: 1 },
  billing_template: { extensions: ['.xlsx'],                   maxSizeMB: 50, maxFiles: 1 },
  photo:            { extensions: ['.pdf','.jpg','.jpeg','.png','.heic'], maxSizeMB: 100, maxFiles: 20 },
});

const MAX_FILE_SIZE_BYTES = 50 * 1024 * 1024; // 50 MB default

// ═══════════════════════════════════════════
// HELPERS — HTML ESCAPE (XSS protection)
// ═══════════════════════════════════════════

/** Escape HTML special characters to prevent XSS */
function escapeHtml(str) {
  if (str == null) return '';
  const s = String(str);
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

// ═══════════════════════════════════════════
// STATE
// ═══════════════════════════════════════════

const state = {
  files: {
    lukumi: [],
    schedule: [],
    daily_template: [],
    billing_template: [],
    photo: [],
  },
  generating: false,
  lastMeta: null,
  lastBlob: null,
  lastFilename: null,
  // Dashboard state
  dashboardData: null,
  dashboardLoading: false,
  selectedDay: null,
  activeTab: TABS.DASHBOARD,
  dashView: VIEWS.TODAY, // VIEWS.TODAY | VIEWS.TOMORROW | VIEWS.WEEK | VIEWS.MONTH
  // Manual edits overlay (applied on top of dashboardData)
  // Key: "childId_day" → { has_lunch, has_am_snack, has_pm_snack, has_dinner, is_sick, cancelled }
  manualEdits: {},
  // Template registration state (persisted in localStorage)
  templateRegistered: {
    daily: false,
    billing: false,
  },
};

// ═══════════════════════════════════════════
// TAB NAVIGATION (top-level)
// ═══════════════════════════════════════════

function switchTab(tab) {
  state.activeTab = tab;
  const tabs = ['dashboard', 'upload', 'generate'];
  tabs.forEach(t => {
    const panel = document.getElementById(`panel-${t}`);
    const tabBtn = document.getElementById(`tab-${t}`);
    if (panel) panel.classList.toggle('hidden', t !== tab);
    if (tabBtn) {
      tabBtn.classList.toggle('tab-active', t === tab);
      tabBtn.classList.toggle('tab-inactive', t !== tab);
    }
  });

  // If switching to generate tab, show/hide panels
  if (tab === 'generate') {
    const hasResult = document.getElementById('step-result') &&
      !document.getElementById('step-result').classList.contains('hidden');
    const hasProgress = document.getElementById('step-progress') &&
      !document.getElementById('step-progress').classList.contains('hidden');
    if (!hasResult && !hasProgress) {
      document.getElementById('generate-empty').classList.remove('hidden');
    }
  }
}

// ═══════════════════════════════════════════
// DASHBOARD SUB-TABS: 今日/明日/今週/月間
// ═══════════════════════════════════════════

function switchDashView(view) {
  state.dashView = view;

  // Update button styles
  document.querySelectorAll('.dash-view-btn').forEach(btn => {
    btn.classList.remove('bg-blue-600', 'text-white');
    btn.classList.add('bg-gray-100', 'text-gray-600', 'hover:bg-gray-200');
  });
  const activeBtn = document.getElementById(`dv-${view}`);
  if (activeBtn) {
    activeBtn.classList.remove('bg-gray-100', 'text-gray-600', 'hover:bg-gray-200');
    activeBtn.classList.add('bg-blue-600', 'text-white');
  }

  if (!state.dashboardData) return;

  const scopedDiv = document.getElementById('dashboard-scoped-view');
  const monthSection = document.getElementById('dashboard-month-section');

  if (view === 'month') {
    // Show full calendar, hide scoped view
    if (scopedDiv) scopedDiv.classList.add('hidden');
    if (monthSection) monthSection.classList.remove('hidden');
    return;
  }

  // Hide month calendar, show scoped view
  if (monthSection) monthSection.classList.add('hidden');
  if (scopedDiv) scopedDiv.classList.remove('hidden');

  const now = new Date();
  const data = state.dashboardData;
  const ds = data.daily_summary || [];

  let targetDays = [];

  if (view === 'today') {
    if (data.year === now.getFullYear() && data.month === now.getMonth() + 1) {
      targetDays = [now.getDate()];
    }
  } else if (view === 'tomorrow') {
    const tomorrow = new Date(now);
    tomorrow.setDate(tomorrow.getDate() + 1);
    if (data.year === tomorrow.getFullYear() && data.month === tomorrow.getMonth() + 1) {
      targetDays = [tomorrow.getDate()];
    }
  } else if (view === 'week') {
    // Get this week's dates (Mon-Sun) that fall in this month
    const dayOfWeek = now.getDay(); // 0=Sun
    const mondayOffset = dayOfWeek === 0 ? -6 : 1 - dayOfWeek;
    for (let i = 0; i < 7; i++) {
      const d = new Date(now);
      d.setDate(now.getDate() + mondayOffset + i);
      if (d.getFullYear() === data.year && d.getMonth() + 1 === data.month) {
        targetDays.push(d.getDate());
      }
    }
  }

  renderScopedDays(data, targetDays, view);
}

function renderScopedDays(data, targetDays, view) {
  const container = document.getElementById('dashboard-scoped-view');
  if (!container) return;

  const viewLabels = { today: '今日', tomorrow: '明日', week: '今週' };
  const label = viewLabels[view] || view;

  if (targetDays.length === 0) {
    container.innerHTML = `
      <div class="bg-white rounded-xl shadow-sm border border-gray-200 p-8 text-center">
        <i class="fas fa-calendar-times text-3xl text-gray-300 mb-3"></i>
        <p class="text-sm text-gray-500">${label}のデータは表示中の月にありません</p>
        <p class="text-xs text-gray-400 mt-1">月間ビューに切り替えて確認してください</p>
      </div>
    `;
    return;
  }

  const ds = data.daily_summary || [];
  let html = '';

  targetDays.forEach(day => {
    const dayData = ds.find(d => d.day === day);
    if (!dayData) {
      html += `
        <div class="bg-white rounded-xl shadow-sm border border-gray-200 p-4 mb-3">
          <h3 class="text-sm font-bold text-gray-700">${data.month}月${day}日</h3>
          <p class="text-sm text-gray-400 mt-2 text-center py-4"><i class="fas fa-moon mr-1"></i>来園予定なし</p>
        </div>
      `;
      return;
    }

    const children = dayData.children || [];
    const sorted = [...children].sort((a, b) => {
      const tA = a.actual_checkin || a.planned_start || '99:99';
      const tB = b.actual_checkin || b.planned_start || '99:99';
      return tA.localeCompare(tB);
    });

    // Summary badges
    const badges = [];
    badges.push(`<span class="bg-blue-100 text-blue-800 px-2.5 py-1 rounded-full text-xs font-bold"><i class="fas fa-child mr-1"></i>${dayData.total_children}名</span>`);
    if (dayData.lunch_count > 0) badges.push(`<span class="bg-green-100 text-green-700 px-2 py-1 rounded-full text-xs font-medium">🍱昼食${dayData.lunch_count}</span>`);
    if (dayData.am_snack_count > 0) badges.push(`<span class="bg-yellow-100 text-yellow-700 px-2 py-1 rounded-full text-xs font-medium">🍪朝${dayData.am_snack_count}</span>`);
    if (dayData.pm_snack_count > 0) badges.push(`<span class="bg-amber-100 text-amber-700 px-2 py-1 rounded-full text-xs font-medium">🍪午${dayData.pm_snack_count}</span>`);
    if (dayData.dinner_count > 0) badges.push(`<span class="bg-orange-100 text-orange-700 px-2 py-1 rounded-full text-xs font-medium">🍽夕食${dayData.dinner_count}</span>`);
    if (dayData.early_morning_count > 0) badges.push(`<span class="bg-orange-100 text-orange-800 px-2 py-1 rounded-full text-xs font-medium">🕒早朝${dayData.early_morning_count}</span>`);
    if (dayData.extension_count > 0) badges.push(`<span class="bg-purple-100 text-purple-800 px-2 py-1 rounded-full text-xs font-medium">🕘延長${dayData.extension_count}</span>`);
    if (dayData.night_count > 0) badges.push(`<span class="bg-indigo-100 text-indigo-800 px-2 py-1 rounded-full text-xs font-medium">🌙夜間${dayData.night_count}</span>`);
    if (dayData.sick_count > 0) badges.push(`<span class="bg-red-100 text-red-800 px-2 py-1 rounded-full text-xs font-medium">💊病児${dayData.sick_count}</span>`);

    // Table
    let tableRows = sorted.map((c, idx) => {
      const rowBg = idx % 2 === 0 ? 'bg-white' : 'bg-gray-50/70';
      // Show both planned and actual times
      const planStart = _shortTime(c.planned_start);
      const planEnd = _shortTime(c.planned_end);
      const actStart = _shortTime(c.actual_checkin);
      const actEnd = _shortTime(c.actual_checkout);
      const timeStr = actStart && actEnd ? `${actStart}-${actEnd}` : (planStart && planEnd ? `${planStart}-${planEnd}` : '-');
      const planStr = planStart && planEnd ? `予${planStart}-${planEnd}` : '';
      
      const eLunch = effectiveVal(c, 'has_lunch', day);
      const eAmSnack = effectiveVal(c, 'has_am_snack', day);
      const ePmSnack = effectiveVal(c, 'has_pm_snack', day);
      const eDinner = effectiveVal(c, 'has_dinner', day);
      const eSick = effectiveVal(c, 'is_sick', day);
      
      const lunchMark = eLunch ? '<span class="text-green-600 font-bold">○</span>' : '';
      const amSnackMark = eAmSnack ? '<span class="text-yellow-600 font-bold">○</span>' : '';
      const pmSnackMark = ePmSnack ? '<span class="text-amber-600 font-bold">○</span>' : '';
      const dinnerMark = eDinner ? '<span class="text-orange-600 font-bold">○</span>' : '';
      const specials = [];
      if (c.is_early_morning) specials.push('<span class="text-orange-500" title="早朝">🕒</span>');
      if (c.is_extension) specials.push('<span class="text-purple-500" title="延長">🕘</span>');
      if (c.is_night) specials.push('<span class="text-indigo-500" title="夜間">🌙</span>');
      if (eSick) specials.push('<span class="text-red-500" title="病児">💊</span>');
      const enrollBadge = c.enrollment_type === '一時'
        ? '<span class="bg-yellow-100 text-yellow-700 px-1 py-0.5 rounded text-[9px] font-medium ml-1">一時</span>'
        : '';
      const classBadge = c.class_name
        ? `<span class="text-[9px] text-gray-400 ml-1">${escapeHtml(c.class_name)}</span>`
        : '';
      return `
        <tr class="${rowBg} border-b border-gray-100 last:border-0">
          <td class="px-3 py-2">
            <div><span class="font-medium text-gray-800">${escapeHtml(c.name)}</span>${enrollBadge}${classBadge}</div>
            ${planStr ? `<div class="text-[10px] text-blue-400">${planStr}</div>` : ''}
          </td>
          <td class="px-3 py-2 text-center text-gray-600 font-mono whitespace-nowrap">${timeStr}</td>
          <td class="px-2 py-2 text-center">${lunchMark}</td>
          <td class="px-2 py-2 text-center">${amSnackMark}</td>
          <td class="px-2 py-2 text-center">${pmSnackMark}</td>
          <td class="px-2 py-2 text-center">${dinnerMark}</td>
          <td class="px-2 py-2 text-center">${specials.join('')}</td>
        </tr>
      `;
    }).join('');

    html += `
      <div class="bg-white rounded-xl shadow-sm border border-gray-200 mb-3 overflow-hidden">
        <div class="px-5 py-3 border-b border-gray-100 flex items-center justify-between flex-wrap gap-2">
          <h3 class="text-sm font-bold text-gray-800">
            ${data.month}月${day}日（${dayData.weekday}）
          </h3>
          <div class="flex flex-wrap gap-1.5">${badges.join('')}</div>
        </div>
        ${sorted.length > 0 ? `
        <table class="w-full text-sm">
          <thead>
            <tr class="bg-gray-50 border-b border-gray-200">
              <th class="px-3 py-2 text-left text-gray-600 font-semibold">園児名</th>
              <th class="px-3 py-2 text-center text-gray-600 font-semibold">時間</th>
              <th class="px-2 py-2 text-center text-gray-400" title="昼食">🍱</th>
              <th class="px-2 py-2 text-center text-gray-400" title="朝おやつ">🍪朝</th>
              <th class="px-2 py-2 text-center text-gray-400" title="午後おやつ">🍪午</th>
              <th class="px-2 py-2 text-center text-gray-400" title="夕食">🍽</th>
              <th class="px-2 py-2 text-center text-gray-600 font-semibold">区分</th>
            </tr>
          </thead>
          <tbody>${tableRows}</tbody>
        </table>
        ` : `<div class="p-4 text-center text-gray-400 text-sm"><i class="fas fa-moon mr-1"></i>来園予定なし</div>`}
      </div>
    `;
  });

  container.innerHTML = html;
}

// ═══════════════════════════════════════════
// MANUAL EDIT FUNCTIONS (dashboard overrides)
// ═══════════════════════════════════════════

/** Get manual edit for a child on a specific day */
function getManualEdit(childId, day) {
  const key = `${childId}_${day}`;
  return state.manualEdits[key] || null;
}

/** Apply a manual edit to a child's day data */
function applyManualEdit(childId, day, field, value) {
  const key = `${childId}_${day}`;
  if (!state.manualEdits[key]) {
    state.manualEdits[key] = {};
  }
  state.manualEdits[key][field] = value;
  
  // Re-render the day detail if currently selected
  if (state.selectedDay === day && state.dashboardData) {
    const ds = (state.dashboardData.daily_summary || []).find(d => d.day === day);
    if (ds) renderDayDetail(day, ds);
  }
}

/** Toggle a meal flag for a child on a day */
function toggleMeal(childId, day, mealField) {
  const data = state.dashboardData;
  if (!data) return;
  
  const ds = (data.daily_summary || []).find(d => d.day === day);
  if (!ds) return;
  
  const child = (ds.children || []).find(c => c.child_id === childId);
  if (!child) return;
  
  const edit = getManualEdit(childId, day);
  const currentVal = (edit && edit[mealField] !== undefined) ? edit[mealField] : child[mealField];
  applyManualEdit(childId, day, mealField, currentVal ? 0 : 1);
}

/** Toggle sick care flag for a child on a day */
function toggleSick(childId, day) {
  const data = state.dashboardData;
  if (!data) return;
  
  const ds = (data.daily_summary || []).find(d => d.day === day);
  if (!ds) return;
  
  const child = (ds.children || []).find(c => c.child_id === childId);
  if (!child) return;
  
  const edit = getManualEdit(childId, day);
  const currentVal = (edit && edit.is_sick !== undefined) ? edit.is_sick : child.is_sick;
  applyManualEdit(childId, day, 'is_sick', currentVal ? 0 : 1);
}

/** Get effective value (manual edit or original) */
function effectiveVal(child, field, day) {
  const edit = getManualEdit(child.child_id, day);
  if (edit && edit[field] !== undefined) return edit[field];
  return child[field];
}

// ═══════════════════════════════════════════
// DRAG & DROP / FILE MANAGEMENT
// ═══════════════════════════════════════════

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
  const rules = FILE_RULES[type];
  if (!rules) return;

  // Validate each file
  const validFiles = [];
  const maxBytes = (rules.maxSizeMB || 50) * 1024 * 1024;

  for (const f of files) {
    // Extension check
    const ext = '.' + f.name.split('.').pop().toLowerCase();
    if (!rules.extensions.includes(ext)) {
      alert(`「${f.name}」は対応していない形式です。\n対応形式: ${rules.extensions.join(', ')}`);
      continue;
    }
    // Size check
    if (f.size > maxBytes) {
      alert(`「${f.name}」のサイズが大きすぎます (${formatFileSize(f.size)})。\n上限: ${rules.maxSizeMB}MB`);
      continue;
    }
    validFiles.push(f);
  }

  if (validFiles.length === 0) return;

  if (rules.maxFiles === 1) {
    state.files[type] = validFiles.slice(0, 1);
  } else {
    const combined = [...state.files[type], ...validFiles];
    if (combined.length > rules.maxFiles) {
      alert(`ファイル数が上限を超えています (最大${rules.maxFiles}件)`);
      state.files[type] = combined.slice(0, rules.maxFiles);
    } else {
      state.files[type] = combined;
    }
  }
  renderFileList(type);
  updateSummary();
  updateAiReadBtn();
  
  // Mark template as registered when uploaded
  if (type === 'daily_template' && files.length > 0) {
    markTemplateRegistered('daily');
  }
  if (type === 'billing_template' && files.length > 0) {
    markTemplateRegistered('billing');
  }
  renderTemplateStatusUI();
}

function removeFile(type, index) {
  state.files[type].splice(index, 1);
  renderFileList(type);
  updateSummary();
  updateAiReadBtn();
  renderTemplateStatusUI();
}

function renderFileList(type) {
  const container = document.getElementById(`file-list-${type}`);
  if (!container) return;
  const files = state.files[type];
  if (files.length === 0) { container.innerHTML = ''; return; }
  const iconMap = {
    lukumi: 'fa-file-excel text-green-500',
    schedule: 'fa-file-excel text-blue-500',
    daily_template: 'fa-file-alt text-emerald-500',
    billing_template: 'fa-file-invoice-dollar text-purple-500',
    photo: 'fa-image text-purple-500',
  };
  const icon = iconMap[type] || 'fa-file text-gray-400';
  container.innerHTML = files.map((f, i) => `
    <div class="flex items-center justify-between bg-gray-50 rounded-lg px-3 py-1.5">
      <div class="flex items-center gap-2 min-w-0">
        <i class="fas ${icon} text-xs flex-shrink-0"></i>
        <span class="text-xs text-gray-700 truncate">${escapeHtml(f.name)}</span>
        <span class="text-xs text-gray-400">(${formatFileSize(f.size)})</span>
      </div>
      <button onclick="removeFile('${escapeHtml(type)}', ${i})" class="text-gray-400 hover:text-red-500 ml-2 flex-shrink-0">
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
  const photoCount = state.files.photo.length;
  const hasDaily = state.files.daily_template.length > 0 || state.templateRegistered.daily;
  const hasBilling = state.files.billing_template.length > 0 || state.templateRegistered.billing;

  if (hasLukumi || scheduleCount > 0 || photoCount > 0) {
    summary.classList.remove('hidden');
    const parts = [];
    if (hasLukumi) parts.push('ルクミー: 1件');
    if (scheduleCount > 0) parts.push(`予定表Excel: ${scheduleCount}件`);
    if (photoCount > 0) parts.push(`写真/PDF: ${photoCount}件`);
    if (hasDaily) parts.push('日報テンプレ: ✓');
    if (hasBilling) parts.push('明細テンプレ: ✓');
    text.textContent = parts.join(' / ');

    const btnGen = document.getElementById('btn-generate');
    if (btnGen) btnGen.disabled = !hasLukumi;
    const btnDash = document.getElementById('btn-dashboard-load');
    if (btnDash) btnDash.disabled = !hasLukumi;
  } else {
    summary.classList.add('hidden');
  }
}

// ═══════════════════════════════════════════
// AI READ (PDF/Photo) — Placeholder
// ═══════════════════════════════════════════

function updateAiReadBtn() {
  const btn = document.getElementById('btn-ai-read');
  if (btn) {
    btn.disabled = state.files.photo.length === 0;
  }
}

function startAiRead() {
  if (state.files.photo.length === 0) return;

  // Show preview panel with placeholder
  const previewDiv = document.getElementById('ai-read-preview');
  const resultDiv = document.getElementById('ai-read-result');

  previewDiv.classList.remove('hidden');

  const fileNames = state.files.photo.map(f => escapeHtml(f.name)).join('、');
  resultDiv.innerHTML = `
    <div class="text-center py-6">
      <i class="fas fa-robot text-purple-400 text-3xl mb-3"></i>
      <p class="text-sm text-purple-700 font-medium mb-2">AI読み取り機能（準備中）</p>
      <p class="text-xs text-gray-500 mb-3">
        対象ファイル: ${fileNames}
      </p>
      <div class="bg-yellow-50 rounded-lg p-3 border border-yellow-200 text-xs text-yellow-700 max-w-md mx-auto">
        <i class="fas fa-info-circle mr-1"></i>
        この機能は近日実装予定です。<br>
        写真・PDFの予定表をAIが読み取り、Excel形式に自動変換します。<br>
        現在はExcelファイルでの入力をお使いください。
      </div>
    </div>
  `;
}

function cancelAiRead() {
  const previewDiv = document.getElementById('ai-read-preview');
  if (previewDiv) previewDiv.classList.add('hidden');
}

function confirmAiRead() {
  // Placeholder: In the future, this would convert AI-read data into schedule files
  alert('AI読み取り結果の確定機能は近日実装予定です。\n現在はExcel予定表をご利用ください。');
  cancelAiRead();
}

// ═══════════════════════════════════════════
// TEMPLATE REGISTRATION STATE (localStorage)
// ═══════════════════════════════════════════

const TEMPLATE_STORAGE_KEY = 'ayukko_template_status';

function loadTemplateStatus() {
  try {
    const saved = localStorage.getItem(TEMPLATE_STORAGE_KEY);
    if (saved) {
      const parsed = JSON.parse(saved);
      state.templateRegistered.daily = !!parsed.daily;
      state.templateRegistered.billing = !!parsed.billing;
    }
  } catch (e) { /* ignore */ }
}

function saveTemplateStatus() {
  try {
    localStorage.setItem(TEMPLATE_STORAGE_KEY, JSON.stringify(state.templateRegistered));
  } catch (e) { /* ignore */ }
}

function markTemplateRegistered(type) {
  // type: 'daily' or 'billing'
  if (type === 'daily_template' || type === 'daily') {
    state.templateRegistered.daily = true;
  } else if (type === 'billing_template' || type === 'billing') {
    state.templateRegistered.billing = true;
  }
  saveTemplateStatus();
  renderTemplateStatusUI();
}

function renderTemplateStatusUI() {
  // Update the status bar
  const bar = document.getElementById('template-status-bar');
  if (bar) {
    const dailyStatus = state.templateRegistered.daily || state.files.daily_template.length > 0;
    const billingStatus = state.templateRegistered.billing || state.files.billing_template.length > 0;
    
    bar.innerHTML = `
      <div class="flex items-center gap-1 text-xs px-2.5 py-1 rounded-full ${dailyStatus ? 'bg-green-50 text-green-700 border border-green-200' : 'bg-gray-50 text-gray-500 border border-gray-200'}">
        <i class="fas ${dailyStatus ? 'fa-check-circle text-green-500' : 'fa-circle text-gray-300'}"></i>
        日報テンプレ: ${dailyStatus ? (state.files.daily_template.length > 0 ? '今回アップロード済み' : '登録済み（前回のを使用）') : '未登録'}
      </div>
      <div class="flex items-center gap-1 text-xs px-2.5 py-1 rounded-full ${billingStatus ? 'bg-green-50 text-green-700 border border-green-200' : 'bg-gray-50 text-gray-500 border border-gray-200'}">
        <i class="fas ${billingStatus ? 'fa-check-circle text-green-500' : 'fa-circle text-gray-300'}"></i>
        明細テンプレ: ${billingStatus ? (state.files.billing_template.length > 0 ? '今回アップロード済み' : '登録済み（前回のを使用）') : '未登録'}
      </div>
      ${!dailyStatus && !billingStatus ? `
        <div class="flex items-center gap-1 text-xs text-amber-600">
          <i class="fas fa-info-circle"></i>
          ダッシュボード表示だけなら不要です
        </div>
      ` : ''}
    `;
  }

  // Update labels
  const dailyLabel = document.getElementById('daily-template-status-label');
  const billingLabel = document.getElementById('billing-template-status-label');
  
  if (dailyLabel) {
    const hasDailyFile = state.files.daily_template.length > 0;
    const dailyReg = state.templateRegistered.daily;
    if (hasDailyFile) {
      dailyLabel.textContent = '(今回アップロード済み)';
      dailyLabel.className = 'text-xs text-green-600 ml-1';
    } else if (dailyReg) {
      dailyLabel.textContent = '(登録済み — 前回のを使用)';
      dailyLabel.className = 'text-xs text-green-600 ml-1';
    } else {
      dailyLabel.textContent = '(未登録)';
      dailyLabel.className = 'text-xs text-amber-600 ml-1';
    }
  }
  
  if (billingLabel) {
    const hasBillingFile = state.files.billing_template.length > 0;
    const billingReg = state.templateRegistered.billing;
    if (hasBillingFile) {
      billingLabel.textContent = '(今回アップロード済み)';
      billingLabel.className = 'text-xs text-green-600 ml-1';
    } else if (billingReg) {
      billingLabel.textContent = '(登録済み — 前回のを使用)';
      billingLabel.className = 'text-xs text-green-600 ml-1';
    } else {
      billingLabel.textContent = '(未登録)';
      billingLabel.className = 'text-xs text-amber-600 ml-1';
    }
  }
}

// ═══════════════════════════════════════════
// MANUAL MODAL
// ═══════════════════════════════════════════

function showManual() {
  const modal = document.getElementById('manual-modal');
  if (modal) modal.classList.remove('hidden');
}

function closeManual() {
  const modal = document.getElementById('manual-modal');
  if (modal) modal.classList.add('hidden');
}

// ═══════════════════════════════════════════
// DASHBOARD: LOAD DATA
// ═══════════════════════════════════════════

async function loadDashboard() {
  if (state.dashboardLoading) return;
  if (state.files.lukumi.length === 0) {
    alert('ルクミー登降園データをアップロードしてください');
    return;
  }

  state.dashboardLoading = true;
  const btn = document.getElementById('btn-dashboard-load');
  if (btn) {
    btn.disabled = true;
    btn.innerHTML = '<i class="fas fa-spinner fa-spin mr-1"></i>読込中...';
  }

  try {
    const year = parseInt(document.getElementById('year-select').value);
    const month = parseInt(document.getElementById('month-select').value);

    const formData = new FormData();
    formData.append('year', year.toString());
    formData.append('month', month.toString());
    formData.append('lukumi_file', state.files.lukumi[0]);
    state.files.schedule.forEach(f => formData.append('schedule_files', f));

    const response = await fetch('/api/jobs/dashboard', {
      method: 'POST',
      body: formData,
    });

    if (!response.ok) {
      let err;
      try {
        err = await response.json();
      } catch {
        err = { error: `HTTP ${response.status}: ${response.statusText}` };
      }
      throw new Error(err.error || `HTTP ${response.status}`);
    }

    let data;
    try {
      data = await response.json();
    } catch {
      throw new Error('サーバーからの応答を解析できませんでした');
    }
    state.dashboardData = data;
    state.selectedDay = null;

    // Switch to dashboard tab and render
    switchTab(TABS.DASHBOARD);
    renderDashboard(data);

  } catch (error) {
    alert(`ダッシュボードの読み込みに失敗しました: ${error.message}`);
  } finally {
    state.dashboardLoading = false;
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = '<i class="fas fa-calendar-alt mr-1"></i>ダッシュボード表示';
    }
  }
}

// ═══════════════════════════════════════════
// DASHBOARD: RENDER
// ═══════════════════════════════════════════

function renderDashboard(data) {
  // Hide empty state, show content
  document.getElementById('dashboard-empty').classList.add('hidden');
  document.getElementById('dashboard-content').classList.remove('hidden');

  // Month title
  document.getElementById('dashboard-month-title').textContent =
    `${data.year}年${data.month}月の利用予定`;

  // ── Monthly summary stats bar ──
  const ds = data.daily_summary || [];
  const maxChildren = Math.max(...ds.map(d => d.total_children), 0);
  const totalEarly = ds.reduce((s, d) => s + d.early_morning_count, 0);
  const totalExt = ds.reduce((s, d) => s + d.extension_count, 0);
  const totalNight = ds.reduce((s, d) => s + d.night_count, 0);

  document.getElementById('dashboard-month-stats').innerHTML = `
    <span class="bg-blue-50 text-blue-700 px-3 py-1 rounded-full text-xs font-medium">
      <i class="fas fa-child mr-1"></i>${data.total_children}名登録
    </span>
    <span class="bg-green-50 text-green-700 px-3 py-1 rounded-full text-xs font-medium">
      最大${maxChildren}名/日
    </span>
    ${totalEarly > 0 ? `<span class="bg-orange-50 text-orange-700 px-3 py-1 rounded-full text-xs font-medium">🕒早朝 ${totalEarly}回</span>` : ''}
    ${totalExt > 0 ? `<span class="bg-purple-50 text-purple-700 px-3 py-1 rounded-full text-xs font-medium">🕘延長 ${totalExt}回</span>` : ''}
    ${totalNight > 0 ? `<span class="bg-indigo-50 text-indigo-700 px-3 py-1 rounded-full text-xs font-medium">🌙夜間 ${totalNight}回</span>` : ''}
  `;

  // ── TODAY SUMMARY (if current month matches) ──
  renderTodaySummary(data);

  // ── Alerts (submission issues) ──
  const alertsDiv = document.getElementById('dashboard-alerts');
  const subReport = data.submission_report;
  if (subReport && (subReport.not_submitted?.length > 0 || subReport.unmatched_schedules?.length > 0)) {
    const notSub = subReport.not_submitted || [];
    const unmatched = subReport.unmatched_schedules || [];
    alertsDiv.innerHTML = `
      <div class="bg-orange-50 border border-orange-200 rounded-xl px-4 py-3 flex items-start gap-3">
        <i class="fas fa-exclamation-triangle text-orange-500 mt-0.5"></i>
        <div class="text-sm">
          ${notSub.length > 0 ? `
            <span class="text-orange-700 font-medium">予定表未提出: </span>
            <span class="text-orange-600">${notSub.map(n => escapeHtml(n.name)).join('、')}</span>
          ` : ''}
          ${unmatched.length > 0 ? `
            <span class="text-red-700 font-medium ml-2">突合不能: </span>
            <span class="text-red-600">${unmatched.map(u => escapeHtml(u.schedule_name)).join('、')}</span>
          ` : ''}
        </div>
      </div>
    `;
  } else {
    alertsDiv.innerHTML = '';
  }

  // Render calendar grid
  renderCalendarGrid(data);

  // ── Apply current dash view ──
  switchDashView(state.dashView);

  // Auto-select today if viewing current month
  const now = new Date();
  if (data.year === now.getFullYear() && data.month === now.getMonth() + 1) {
    selectDay(now.getDate());
  } else {
    renderDayDetailEmpty();
  }
}

function renderTodaySummary(data) {
  const todayDiv = document.getElementById('dashboard-today');
  if (!todayDiv) return;

  const now = new Date();
  if (data.year !== now.getFullYear() || data.month !== now.getMonth() + 1) {
    todayDiv.innerHTML = '';
    return;
  }

  const today = now.getDate();
  const ds = (data.daily_summary || []).find(d => d.day === today);
  if (!ds || ds.total_children === 0) {
    todayDiv.innerHTML = `
      <div class="bg-white rounded-xl shadow-sm border border-gray-200 px-5 py-3 flex items-center gap-3">
        <span class="text-sm font-bold text-gray-700"><i class="fas fa-sun text-yellow-400 mr-1"></i>今日 (${data.month}/${today})</span>
        <span class="text-sm text-gray-400">来園予定なし</span>
      </div>
    `;
    return;
  }

  const badges = [
    `<span class="bg-blue-100 text-blue-800 px-2.5 py-1 rounded-full text-xs font-bold"><i class="fas fa-child mr-1"></i>${ds.total_children}名</span>`,
  ];
  if (ds.lunch_count > 0) badges.push(`<span class="bg-green-100 text-green-700 px-2 py-1 rounded-full text-xs font-medium">🍱昼食${ds.lunch_count}</span>`);
  if (ds.am_snack_count > 0) badges.push(`<span class="bg-amber-100 text-amber-700 px-2 py-1 rounded-full text-xs font-medium">🍪AM${ds.am_snack_count}</span>`);
  if (ds.pm_snack_count > 0) badges.push(`<span class="bg-amber-100 text-amber-700 px-2 py-1 rounded-full text-xs font-medium">🍪PM${ds.pm_snack_count}</span>`);
  if (ds.dinner_count > 0) badges.push(`<span class="bg-orange-100 text-orange-700 px-2 py-1 rounded-full text-xs font-medium">🍽夕食${ds.dinner_count}</span>`);
  if (ds.early_morning_count > 0) badges.push(`<span class="bg-orange-100 text-orange-800 px-2 py-1 rounded-full text-xs font-medium">🕒早朝${ds.early_morning_count}</span>`);
  if (ds.extension_count > 0) badges.push(`<span class="bg-purple-100 text-purple-800 px-2 py-1 rounded-full text-xs font-medium">🕘延長${ds.extension_count}</span>`);
  if (ds.night_count > 0) badges.push(`<span class="bg-indigo-100 text-indigo-800 px-2 py-1 rounded-full text-xs font-medium">🌙夜間${ds.night_count}</span>`);
  if (ds.sick_count > 0) badges.push(`<span class="bg-red-100 text-red-800 px-2 py-1 rounded-full text-xs font-medium">💊病児${ds.sick_count}</span>`);

  todayDiv.innerHTML = `
    <div class="bg-white rounded-xl shadow-sm border border-blue-200 px-5 py-3 cursor-pointer hover:bg-blue-50/50 transition-colors" onclick="switchDashView('today')">
      <div class="flex items-center gap-3 flex-wrap">
        <span class="text-sm font-bold text-gray-800"><i class="fas fa-sun text-yellow-400 mr-1"></i>今日 (${data.month}/${today} ${ds.weekday})</span>
        <div class="flex flex-wrap gap-1.5">
          ${badges.join('')}
        </div>
        <span class="text-xs text-blue-500 ml-auto"><i class="fas fa-arrow-right mr-0.5"></i>詳細</span>
      </div>
    </div>
  `;
}

function renderCalendarGrid(data) {
  const grid = document.getElementById('calendar-grid');
  const year = data.year;
  const month = data.month;
  const daysInMonth = data.days_in_month;
  const dailySummary = data.daily_summary || [];

  // Build lookup: day -> summary
  const dayMap = {};
  dailySummary.forEach(d => { dayMap[d.day] = d; });

  // First day of month (0=Sun, 1=Mon, ... 6=Sat)
  // We want Mon=0 in our grid
  const firstDate = new Date(year, month - 1, 1);
  const firstDayOfWeek = firstDate.getDay(); // 0=Sun
  const startOffset = (firstDayOfWeek + 6) % 7;

  let html = '';

  // Empty cells before month starts
  for (let i = 0; i < startOffset; i++) {
    html += `<div class="border-b border-r border-gray-100 bg-gray-50/50 p-1"></div>`;
  }

  // Day cells
  for (let day = 1; day <= daysInMonth; day++) {
    const ds = dayMap[day] || { total_children: 0, weekday: '', is_weekend: false };
    const isWeekend = ds.is_weekend;
    const isSelected = state.selectedDay === day;
    const hasChildren = ds.total_children > 0;

    const dateClass = isWeekend ? 'text-red-400' : 'text-gray-700';
    const bgClass = isWeekend ? 'bg-gray-50/70' : 'bg-white';
    const selectedClass = isSelected ? 'ring-2 ring-blue-500 bg-blue-50/30' : '';

    let countBadge = '';
    if (hasChildren) {
      const n = ds.total_children;
      const badgeColor = n >= 5 ? 'bg-blue-600 text-white' :
                         n >= 3 ? 'bg-blue-500 text-white' :
                                  'bg-blue-100 text-blue-700';
      countBadge = `<span class="badge ${badgeColor}">${n}名</span>`;
    }

    // Meal badges — 4 categories
    let mealLine = '';
    const mealParts = [];
    if (ds.lunch_count > 0) mealParts.push(`<span title="昼食 ${ds.lunch_count}名">🍱${ds.lunch_count}</span>`);
    if (ds.am_snack_count > 0) mealParts.push(`<span title="朝おやつ ${ds.am_snack_count}名">🍪朝${ds.am_snack_count}</span>`);
    if (ds.pm_snack_count > 0) mealParts.push(`<span title="午後おやつ ${ds.pm_snack_count}名">🍪午${ds.pm_snack_count}</span>`);
    if (ds.dinner_count > 0) mealParts.push(`<span title="夕食 ${ds.dinner_count}名">🍽${ds.dinner_count}</span>`);
    if (mealParts.length > 0) {
      mealLine = `<div class="flex gap-1.5 mt-0.5 text-[10px] text-gray-500">${mealParts.join('')}</div>`;
    }

    // Special indicators
    let indicators = '';
    const indParts = [];
    if (ds.early_morning_count > 0) indParts.push(`<span class="text-orange-500" title="早朝 ${ds.early_morning_count}名">🕒${ds.early_morning_count}</span>`);
    if (ds.extension_count > 0) indParts.push(`<span class="text-purple-500" title="延長 ${ds.extension_count}名">🕘${ds.extension_count}</span>`);
    if (ds.night_count > 0) indParts.push(`<span class="text-indigo-500" title="夜間 ${ds.night_count}名">🌙${ds.night_count}</span>`);
    if (ds.sick_count > 0) indParts.push(`<span class="text-red-500" title="病児 ${ds.sick_count}名">💊${ds.sick_count}</span>`);
    if (indParts.length > 0) {
      indicators = `<div class="flex gap-1 mt-0.5 text-[10px]">${indParts.join('')}</div>`;
    }

    // Children preview
    let childPreview = '';
    if (ds.children && ds.children.length > 0) {
      const preview = ds.children.slice(0, 2).map(c => {
        const surname = escapeHtml(c.name.split(/[\s\u3000]/)[0]);
        // Show planned time, then actual if different
        const tStart = _shortTime(c.planned_start || c.actual_checkin);
        const tEnd = _shortTime(c.planned_end || c.actual_checkout);
        const classTag = c.class_name ? `<span class="text-gray-300">[${escapeHtml(c.class_name)}]</span>` : '';
        return `${surname} ${tStart}-${tEnd} ${classTag}`;
      });
      const more = ds.children.length > 2 ? `<span class="text-gray-400"> +${ds.children.length - 2}</span>` : '';
      childPreview = `<div class="text-[10px] text-gray-500 leading-tight mt-0.5">${preview.join('<br>')}${more}</div>`;
    }

    html += `
      <div class="cal-day border-b border-r border-gray-100 p-1.5 cursor-pointer ${bgClass} ${selectedClass}"
           onclick="selectDay(${day})" id="cal-day-${day}">
        <div class="flex items-center justify-between mb-0.5">
          <span class="text-xs font-semibold ${dateClass}">${day}<span class="text-[10px] font-normal ml-0.5">${ds.weekday || ''}</span></span>
          ${countBadge}
        </div>
        ${childPreview}
        ${mealLine}
        ${indicators}
      </div>
    `;
  }

  // Trailing empty cells
  const totalCells = startOffset + daysInMonth;
  const remainder = totalCells % 7;
  if (remainder > 0) {
    for (let i = 0; i < 7 - remainder; i++) {
      html += `<div class="border-b border-r border-gray-100 bg-gray-50/50 p-1"></div>`;
    }
  }

  grid.innerHTML = html;
}

// ═══════════════════════════════════════════
// DASHBOARD: DAY DETAIL
// ═══════════════════════════════════════════

function selectDay(day) {
  if (!state.dashboardData) return;

  const prevDay = state.selectedDay;
  state.selectedDay = day;

  if (prevDay) {
    const prevEl = document.getElementById(`cal-day-${prevDay}`);
    if (prevEl) prevEl.classList.remove('ring-2', 'ring-blue-500', 'bg-blue-50/30');
  }
  const currEl = document.getElementById(`cal-day-${day}`);
  if (currEl) currEl.classList.add('ring-2', 'ring-blue-500', 'bg-blue-50/30');

  const ds = (state.dashboardData.daily_summary || []).find(d => d.day === day);
  if (!ds) {
    renderDayDetailEmpty();
    return;
  }

  renderDayDetail(day, ds);
}

function renderDayDetailEmpty() {
  document.getElementById('day-detail-title').textContent = '日付を選択してください';
  document.getElementById('day-detail-content').innerHTML = `
    <p class="text-center py-8 text-gray-400 text-sm">
      カレンダーの日付をクリックすると<br>園児一覧が表示されます
    </p>
  `;
}

function renderDayDetail(day, ds) {
  const data = state.dashboardData;
  const weekday = ds.weekday || '';
  const dateStr = `${data.month}月${day}日（${weekday}）`;

  document.getElementById('day-detail-title').innerHTML = `
    <div class="flex items-center justify-between">
      <span>${dateStr}</span>
      <span class="text-xs font-normal text-gray-500">${ds.total_children}名来園</span>
    </div>
  `;

  const children = ds.children || [];
  if (children.length === 0) {
    document.getElementById('day-detail-content').innerHTML = `
      <div class="text-center py-6 text-gray-400">
        <i class="fas fa-moon text-2xl mb-2"></i>
        <p class="text-sm">来園予定なし</p>
      </div>
    `;
    return;
  }

  // Summary counters — 4 meals + specials
  let summaryHtml = `
    <div class="grid grid-cols-6 gap-1.5 mb-3">
      <div class="bg-blue-50 rounded-lg px-1.5 py-1.5 text-center">
        <div class="text-lg font-bold text-blue-700">${ds.total_children}</div>
        <div class="text-[10px] text-blue-500">来園</div>
      </div>
      <div class="bg-green-50 rounded-lg px-1.5 py-1.5 text-center">
        <div class="text-lg font-bold text-green-700">${ds.lunch_count}</div>
        <div class="text-[10px] text-green-500">🍱昼食</div>
      </div>
      <div class="bg-yellow-50 rounded-lg px-1.5 py-1.5 text-center">
        <div class="text-lg font-bold text-yellow-700">${ds.am_snack_count || 0}</div>
        <div class="text-[10px] text-yellow-500">🍪朝</div>
      </div>
      <div class="bg-amber-50 rounded-lg px-1.5 py-1.5 text-center">
        <div class="text-lg font-bold text-amber-700">${ds.pm_snack_count || 0}</div>
        <div class="text-[10px] text-amber-500">🍪午</div>
      </div>
      <div class="bg-orange-50 rounded-lg px-1.5 py-1.5 text-center">
        <div class="text-lg font-bold text-orange-700">${ds.dinner_count || 0}</div>
        <div class="text-[10px] text-orange-500">🍽夕食</div>
      </div>
      <div class="bg-gray-50 rounded-lg px-1.5 py-1.5 text-center">
        <div class="text-lg font-bold text-gray-600">${ds.early_morning_count + ds.extension_count + ds.night_count + ds.sick_count}</div>
        <div class="text-[10px] text-gray-400">特記</div>
      </div>
    </div>
  `;

  // Special counts badges
  const specials = [];
  if (ds.early_morning_count > 0) specials.push(`<span class="bg-orange-100 text-orange-700 px-2 py-0.5 rounded text-[10px] font-medium">🕒 早朝 ${ds.early_morning_count}名</span>`);
  if (ds.extension_count > 0) specials.push(`<span class="bg-purple-100 text-purple-700 px-2 py-0.5 rounded text-[10px] font-medium">🕘 延長 ${ds.extension_count}名</span>`);
  if (ds.night_count > 0) specials.push(`<span class="bg-indigo-100 text-indigo-700 px-2 py-0.5 rounded text-[10px] font-medium">🌙 夜間 ${ds.night_count}名</span>`);
  if (ds.sick_count > 0) specials.push(`<span class="bg-red-100 text-red-700 px-2 py-0.5 rounded text-[10px] font-medium">💊 病児 ${ds.sick_count}名</span>`);

  if (specials.length > 0) {
    summaryHtml += `<div class="flex flex-wrap gap-1 mb-3">${specials.join('')}</div>`;
  }

  // Children table — with 4 meal columns, class name, and edit toggles
  const sorted = [...children].sort((a, b) => {
    const tA = a.actual_checkin || a.planned_start || '99:99';
    const tB = b.actual_checkin || b.planned_start || '99:99';
    return tA.localeCompare(tB);
  });

  let tableHtml = `
    <div class="border border-gray-200 rounded-lg overflow-hidden">
      <div class="bg-blue-50 border-b border-blue-100 px-2 py-1 flex items-center justify-between">
        <span class="text-[10px] text-blue-600"><i class="fas fa-edit mr-0.5"></i>食事・病児はクリックで編集可</span>
      </div>
      <table class="w-full text-xs">
        <thead>
          <tr class="bg-gray-50 border-b border-gray-200">
            <th class="px-2 py-1.5 text-left text-gray-600 font-semibold">園児名</th>
            <th class="px-2 py-1.5 text-center text-gray-600 font-semibold">予定/実績</th>
            <th class="px-1 py-1.5 text-center text-gray-400" title="昼食">🍱</th>
            <th class="px-1 py-1.5 text-center text-gray-400" title="朝おやつ">🍪朝</th>
            <th class="px-1 py-1.5 text-center text-gray-400" title="午後おやつ">🍪午</th>
            <th class="px-1 py-1.5 text-center text-gray-400" title="夕食">🍽</th>
            <th class="px-1 py-1.5 text-center text-gray-400" title="病児">💊</th>
          </tr>
        </thead>
        <tbody>
  `;

  sorted.forEach((c, idx) => {
    const rowBg = idx % 2 === 0 ? 'bg-white' : 'bg-gray-50/70';
    // Show planned time + actual time
    const planStart = _shortTime(c.planned_start);
    const planEnd = _shortTime(c.planned_end);
    const actStart = _shortTime(c.actual_checkin);
    const actEnd = _shortTime(c.actual_checkout);
    
    let timeHtml = '';
    if (planStart && planEnd) {
      timeHtml += `<div class="text-blue-500">予 ${planStart}-${planEnd}</div>`;
    }
    if (actStart && actEnd) {
      timeHtml += `<div class="text-green-600">実 ${actStart}-${actEnd}</div>`;
    }
    if (!timeHtml) timeHtml = '-';

    // Effective values (with manual edits applied)
    const eLunch = effectiveVal(c, 'has_lunch', day);
    const eAmSnack = effectiveVal(c, 'has_am_snack', day);
    const ePmSnack = effectiveVal(c, 'has_pm_snack', day);
    const eDinner = effectiveVal(c, 'has_dinner', day);
    const eSick = effectiveVal(c, 'is_sick', day);
    
    const edit = getManualEdit(c.child_id, day);
    const hasEdit = edit && Object.keys(edit).length > 0;

    // Clickable meal/sick toggles
    const cid = escapeHtml(c.child_id);
    const lunchBtn = `<button onclick="toggleMeal('${cid}',${day},'has_lunch')" class="w-5 h-5 rounded ${eLunch ? 'bg-green-100 text-green-600 font-bold' : 'bg-gray-100 text-gray-300'} text-[10px] hover:ring-1 ring-green-400">${eLunch ? '○' : '·'}</button>`;
    const amSnackBtn = `<button onclick="toggleMeal('${cid}',${day},'has_am_snack')" class="w-5 h-5 rounded ${eAmSnack ? 'bg-yellow-100 text-yellow-600 font-bold' : 'bg-gray-100 text-gray-300'} text-[10px] hover:ring-1 ring-yellow-400">${eAmSnack ? '○' : '·'}</button>`;
    const pmSnackBtn = `<button onclick="toggleMeal('${cid}',${day},'has_pm_snack')" class="w-5 h-5 rounded ${ePmSnack ? 'bg-amber-100 text-amber-600 font-bold' : 'bg-gray-100 text-gray-300'} text-[10px] hover:ring-1 ring-amber-400">${ePmSnack ? '○' : '·'}</button>`;
    const dinnerBtn = `<button onclick="toggleMeal('${cid}',${day},'has_dinner')" class="w-5 h-5 rounded ${eDinner ? 'bg-orange-100 text-orange-600 font-bold' : 'bg-gray-100 text-gray-300'} text-[10px] hover:ring-1 ring-orange-400">${eDinner ? '○' : '·'}</button>`;
    const sickBtn = `<button onclick="toggleSick('${cid}',${day})" class="w-5 h-5 rounded ${eSick ? 'bg-red-100 text-red-600 font-bold' : 'bg-gray-100 text-gray-300'} text-[10px] hover:ring-1 ring-red-400">${eSick ? '○' : '·'}</button>`;

    const enrollBadge = c.enrollment_type === '一時'
      ? '<span class="bg-yellow-100 text-yellow-700 px-1 py-0.5 rounded text-[9px] font-medium ml-1">一時</span>'
      : '';
    const classBadge = c.class_name
      ? `<span class="text-[9px] text-gray-400 block">${escapeHtml(c.class_name)}</span>`
      : '';
    const editBadge = hasEdit ? '<span class="text-[8px] text-blue-500 ml-0.5" title="手動編集あり">✎</span>' : '';

    const specialIcons = [];
    if (c.is_early_morning) specialIcons.push('🕒');
    if (c.is_extension) specialIcons.push('🕘');
    if (c.is_night) specialIcons.push('🌙');
    const specialStr = specialIcons.length > 0
      ? `<span class="text-[9px]">${specialIcons.join('')}</span>`
      : '';

    tableHtml += `
      <tr class="${rowBg} border-b border-gray-100 last:border-0">
        <td class="px-2 py-1.5">
          <div class="flex items-center">
            <span class="font-medium text-gray-800">${escapeHtml(c.name)}</span>${enrollBadge}${editBadge}
          </div>
          ${classBadge}
          ${specialStr}
        </td>
        <td class="px-2 py-1.5 text-center font-mono whitespace-nowrap text-[10px]">${timeHtml}</td>
        <td class="px-1 py-1.5 text-center">${lunchBtn}</td>
        <td class="px-1 py-1.5 text-center">${amSnackBtn}</td>
        <td class="px-1 py-1.5 text-center">${pmSnackBtn}</td>
        <td class="px-1 py-1.5 text-center">${dinnerBtn}</td>
        <td class="px-1 py-1.5 text-center">${sickBtn}</td>
      </tr>
    `;
  });

  tableHtml += '</tbody></table></div>';

  // Manual edits notice
  let editNotice = '';
  const editCount = Object.keys(state.manualEdits).filter(k => k.endsWith(`_${day}`)).length;
  if (editCount > 0) {
    editNotice = `
      <div class="mt-2 bg-blue-50 rounded px-2 py-1.5 flex items-center justify-between">
        <span class="text-[10px] text-blue-600"><i class="fas fa-edit mr-0.5"></i>${editCount}名に手動編集あり（生成時に反映されます）</span>
      </div>
    `;
  }

  document.getElementById('day-detail-content').innerHTML = summaryHtml + tableHtml + editNotice;
}

// ═══════════════════════════════════════════
// GENERATION (v3.3 retained)
// ═══════════════════════════════════════════

async function startGeneration() {
  if (state.generating) return;

  const year = parseInt(document.getElementById('year-select').value);
  const month = parseInt(document.getElementById('month-select').value);

  if (state.files.lukumi.length === 0) {
    alert('ルクミー登降園データをアップロードしてください');
    return;
  }

  // Switch to generate tab
  switchTab('generate');

  state.generating = true;
  const btn = document.getElementById('btn-generate');
  if (btn) {
    btn.disabled = true;
    btn.innerHTML = '<i class="fas fa-spinner fa-spin mr-1"></i>生成中...';
  }

  document.getElementById('generate-empty').classList.add('hidden');
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

    const response = await fetch('/api/jobs/generate', {
      method: 'POST',
      body: formData,
    });

    updateProgress(70, 'レスポンスを受信中...');

    if (response.status === 422) {
      let errorData;
      try {
        errorData = await response.json();
      } catch {
        errorData = { error: 'テンプレート破損検出（詳細取得失敗）' };
      }
      updateProgress(0, 'テンプレート破損検出 — 処理中止');
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

    let meta = null;
    try {
      const zip = await JSZip.loadAsync(blob);
      const metaFile = zip.file('_meta.json');
      if (metaFile) {
        const metaText = await metaFile.async('text');
        meta = JSON.parse(metaText);
      } else {
        console.warn('_meta.json not found in ZIP — falling back to response header');
      }
    } catch (e) {
      console.warn('Failed to extract _meta.json from ZIP:', e);
    }

    // Fallback: read meta from response header if ZIP extraction failed
    if (!meta) {
      try {
        const metaStr = response.headers.get('X-Meta-Json');
        if (metaStr) meta = JSON.parse(metaStr);
      } catch (e2) {
        console.warn('Failed to parse X-Meta-Json header:', e2);
      }
    }

    // Ensure meta is at least an empty object for safe access
    if (!meta) meta = {};

    const warnings = meta.warnings || [];
    const stats = meta.stats || {};
    const childrenCount = stats.children_processed || parseInt(response.headers.get('X-Children-Processed') || '0');
    const warningsCount = warnings.length;

    state.lastMeta = meta;
    state.lastBlob = blob;
    state.lastFilename = `あゆっこ_${year}年${String(month).padStart(2, '0')}月.zip`;

    updateProgress(100, `生成完了! ${childrenCount}名処理, ${formatFileSize(blob.size)}`);
    showSuccessResult(blob, year, month, warningsCount, childrenCount, meta, warnings);

  } catch (error) {
    updateProgress(0, `接続エラー: ${error.message}`);
    showErrorResult({ error: error.message, suggestion: 'ネットワーク接続を確認してください' });
  } finally {
    state.generating = false;
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = '<i class="fas fa-magic mr-1"></i>提出物生成';
    }
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

// ═══════════════════════════════════════════
// RESULTS DISPLAY (v3.3 retained)
// ═══════════════════════════════════════════

function showSuccessResult(blob, year, month, warningsCount, childrenCount, meta, warnings) {
  const resultDiv = document.getElementById('step-result');
  resultDiv.classList.remove('hidden');
  resultDiv.scrollIntoView({ behavior: 'smooth' });

  const subReport = meta?.submission_report;
  const stats = meta?.stats || {};

  document.getElementById('btn-download-zip').style.display = '';

  // Mark templates as registered on successful generation
  if (state.files.daily_template.length > 0) markTemplateRegistered('daily');
  if (state.files.billing_template.length > 0) markTemplateRegistered('billing');

  if (subReport) {
    document.getElementById('result-submission').innerHTML = _renderSubmissionPanel(subReport);
  } else {
    document.getElementById('result-submission').innerHTML = '';
  }

  const hasDailyTemplate = state.files.daily_template.length > 0;
  const hasBillingTemplate = state.files.billing_template.length > 0;
  const pdfCount = meta?.pdf_count || childrenCount;

  document.getElementById('result-files').innerHTML = `
    <div class="grid grid-cols-1 md:grid-cols-3 gap-3 mb-4">
      ${_renderOutputCard('university', '01_園内管理', 'fas fa-school', 'green',
        '園児登園確認表・児童実績表・保育時間',
        hasDailyTemplate ? '日報Excel内シート書き込み済' : 'テンプレ未指定（スキップ）',
        hasDailyTemplate)}
      ${_renderOutputCard('accounting', '02_経理提出', 'fas fa-file-invoice-dollar', 'purple',
        '保育料明細（数量列のみ更新）',
        hasBillingTemplate ? '明細Excel数量列更新済' : 'テンプレ未指定（スキップ）',
        hasBillingTemplate)}
      ${_renderOutputCard('parents', '03_保護者配布', 'fas fa-file-pdf', 'blue',
        '利用明細書PDF（' + pdfCount + '名分）',
        pdfCount + '名分のPDFを自動生成', true)}
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

  if (not_submitted.length > 0) {
    html += `
      <div class="mb-4">
        <h5 class="text-xs font-bold text-orange-700 mb-2 flex items-center gap-1">
          <i class="fas fa-exclamation-triangle"></i>要確認（予定表未提出）
        </h5>
        <div class="grid grid-cols-2 md:grid-cols-3 gap-2">
          ${not_submitted.map(ns => `
            <div class="bg-orange-50 px-3 py-2 rounded-lg text-xs border border-orange-100">
              <div class="font-medium text-orange-800">${escapeHtml(ns.name)}</div>
              <div class="text-orange-500 mt-0.5">${escapeHtml(ns.reason || '')}</div>
            </div>
          `).join('')}
        </div>
      </div>
    `;
  }

  if (unmatched_schedules.length > 0) {
    html += `
      <div class="mb-4">
        <h5 class="text-xs font-bold text-red-700 mb-2 flex items-center gap-1">
          <i class="fas fa-question-circle"></i>突合できなかった予定表ファイル
        </h5>
        <div class="space-y-1.5">
          ${unmatched_schedules.map(us => `
            <div class="bg-red-50 px-3 py-2 rounded-lg text-xs border border-red-100">
              <span class="font-medium text-red-800">${escapeHtml(us.schedule_name)}</span>
              <span class="text-red-500 ml-1">— ${escapeHtml(us.reason)}</span>
            </div>
          `).join('')}
        </div>
      </div>
    `;
  }

  if (submitted.length > 0) {
    html += `
      <details>
        <summary class="text-xs font-bold text-green-700 cursor-pointer mb-2 flex items-center gap-1">
          <i class="fas fa-check-circle"></i>提出済み (${submitted.length}名)
          <span class="text-green-500 font-normal ml-1">クリックで展開</span>
        </summary>
        <div class="grid grid-cols-3 md:grid-cols-4 gap-1.5">
          ${submitted.map(s => `
            <div class="bg-green-50 px-2.5 py-1.5 rounded text-xs text-green-700 border border-green-100">${escapeHtml(s.name)}</div>
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

  let html = '<div class="mt-4 space-y-3">';

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

  if (warns.length > 0) {
    const isOpen = warns.length <= 5 ? 'open' : '';
    html += `
      <details ${isOpen} class="bg-yellow-50 rounded-xl border border-yellow-200 overflow-hidden">
        <summary class="px-4 py-2.5 bg-yellow-100 text-yellow-800 text-sm font-semibold cursor-pointer flex items-center gap-1">
          <i class="fas fa-exclamation-triangle"></i>警告 (${warns.length}件)
          ${warns.length > 5 ? '<span class="text-yellow-600 font-normal text-xs ml-2">クリックで展開</span>' : ''}
        </summary>
        <div class="p-4 space-y-2 max-h-60 overflow-y-auto">
          ${warns.map(w => _renderWarningItem(w, 'yellow')).join('')}
        </div>
      </details>
    `;
  }

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
        ${w.child_name ? `<span class="text-xs font-medium text-${color}-800 bg-${color}-100 px-1.5 py-0.5 rounded whitespace-nowrap">${escapeHtml(w.child_name)}</span>` : ''}
        <div class="text-xs text-${color}-700 flex-1">${escapeHtml(w.message)}</div>
      </div>
      ${w.suggestion ? `<div class="text-xs text-${color}-500 mt-1 ml-1"><i class="fas fa-lightbulb mr-1"></i>${escapeHtml(w.suggestion)}</div>` : ''}
    </div>
  `;
}

function showFatalResult(errorData) {
  const resultDiv = document.getElementById('step-result');
  resultDiv.classList.remove('hidden');

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
        <p class="text-sm text-red-700 font-medium">${escapeHtml(errorData.error || '不明なエラー')}</p>
        <div class="mt-3 bg-red-50 rounded p-3">
          <p class="text-xs text-red-600">
            <i class="fas fa-info-circle mr-1"></i>
            <strong>対処方法:</strong> テンプレートExcelをPC版Excelで開き、#REF! や #VALUE! エラーを修正してから再度アップロードしてください。
          </p>
        </div>
      </div>
    </div>
  `;

  if (errorData.submission_report) {
    document.getElementById('result-submission').innerHTML = _renderSubmissionPanel(errorData.submission_report);
  } else {
    document.getElementById('result-submission').innerHTML = '';
  }

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
          <p class="text-sm text-red-700 mt-1">${escapeHtml(errorData.error || '不明なエラー')}</p>
        </div>
      </div>
      ${errorData.suggestion ? `
        <div class="bg-white rounded-lg p-3 border border-red-100 mt-2">
          <p class="text-xs text-red-600"><i class="fas fa-lightbulb mr-1"></i>${escapeHtml(errorData.suggestion)}</p>
        </div>
      ` : ''}
      ${errorData.traceback ? `
        <details class="mt-3">
          <summary class="text-xs text-red-500 cursor-pointer">技術詳細を表示</summary>
          <pre class="text-xs text-red-400 bg-red-900/10 rounded p-2 mt-1 overflow-x-auto max-h-40">${escapeHtml(errorData.traceback)}</pre>
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

// ═══════════════════════════════════════════
// RESET
// ═══════════════════════════════════════════

function resetAll() {
  state.files = { lukumi: [], schedule: [], daily_template: [], billing_template: [], photo: [] };
  state.generating = false;
  state.lastMeta = null;
  state.lastBlob = null;
  state.lastFilename = null;
  state.dashboardData = null;
  state.dashboardLoading = false;
  state.selectedDay = null;
  state.dashView = VIEWS.TODAY;
  state.manualEdits = {};

  ['lukumi', 'schedule', 'daily_template', 'billing_template', 'photo'].forEach(type => {
    renderFileList(type);
    const input = document.getElementById(`input-${type}`);
    if (input) input.value = '';
  });

  updateSummary();
  updateAiReadBtn();

  // Reset dashboard
  const dashEmpty = document.getElementById('dashboard-empty');
  const dashContent = document.getElementById('dashboard-content');
  if (dashEmpty) dashEmpty.classList.remove('hidden');
  if (dashContent) dashContent.classList.add('hidden');
  const todayDiv = document.getElementById('dashboard-today');
  if (todayDiv) todayDiv.innerHTML = '';

  // Reset AI read preview
  cancelAiRead();

  // Reset generation
  document.getElementById('step-progress').classList.add('hidden');
  document.getElementById('step-result').classList.add('hidden');
  document.getElementById('generate-empty').classList.remove('hidden');

  switchTab(TABS.DASHBOARD);
}

// ═══════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════

function formatFileSize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

/** Format time string "HH:MM" or "HH:MM:SS" -> "H:MM" (remove leading zero) */
function _shortTime(timeStr) {
  if (!timeStr || typeof timeStr !== 'string') return '';
  const s = timeStr.trim();
  if (s.length < 4) return s; // too short to be a time
  const m = s.match(/^0?(\d{1,2}):(\d{2})/);
  if (m) return `${parseInt(m[1])}:${m[2]}`;
  return s;
}

// ═══════════════════════════════════════════
// INIT
// ═══════════════════════════════════════════

document.addEventListener('DOMContentLoaded', () => {
  // Load template registration status from localStorage
  loadTemplateStatus();
  renderTemplateStatusUI();

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

  // Start on dashboard tab
  switchTab(TABS.DASHBOARD);
});

/**
 * あゆっこ保育園 業務自動化システム
 * Main Hono Application Entry Point
 * 
 * v3.1 (2026-02-16)
 * Core: Upload → One-click Generate → ZIP of all deliverables
 */

import { Hono } from 'hono';
import { cors } from 'hono/cors';
import type { HonoEnv } from './types/index';
import jobRoutes from './routes/jobs';
import childRoutes from './routes/children';
import templateRoutes from './routes/templates';

const app = new Hono<HonoEnv>();

// CORS
app.use('/api/*', cors());

// Health check
app.get('/api/health', (c) => {
  return c.json({
    status: 'ok',
    version: '3.1',
    system: 'あゆっこ保育園 業務自動化システム',
    timestamp: new Date().toISOString(),
  });
});

// API Routes
app.route('/api/jobs', jobRoutes);
app.route('/api/children', childRoutes);
app.route('/api/templates', templateRoutes);

// Main UI - Single screen MVP
app.get('/', (c) => {
  return c.html(`<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>あゆっこ 業務自動化</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <link href="https://cdn.jsdelivr.net/npm/@fortawesome/fontawesome-free@6.4.0/css/all.min.css" rel="stylesheet">
  <style>
    .drop-zone { 
      border: 2px dashed #cbd5e1; 
      transition: all 0.2s; 
    }
    .drop-zone.drag-over { 
      border-color: #3b82f6; 
      background: #eff6ff; 
    }
    .step-active { background: #dbeafe; border-color: #3b82f6; }
    .step-done { background: #dcfce7; border-color: #22c55e; }
    .progress-fill { transition: width 0.5s ease-in-out; }
    @keyframes pulse-gentle { 0%, 100% { opacity: 1; } 50% { opacity: 0.7; } }
    .pulse-gentle { animation: pulse-gentle 2s infinite; }
  </style>
</head>
<body class="bg-gray-50 min-h-screen">
  <!-- Header -->
  <header class="bg-white border-b border-gray-200 shadow-sm">
    <div class="max-w-6xl mx-auto px-4 py-3 flex items-center justify-between">
      <div class="flex items-center gap-3">
        <div class="w-10 h-10 bg-blue-600 rounded-lg flex items-center justify-center">
          <i class="fas fa-child text-white text-lg"></i>
        </div>
        <div>
          <h1 class="text-lg font-bold text-gray-800">あゆっこ 業務自動化</h1>
          <p class="text-xs text-gray-500">滋賀医科大学学内保育所</p>
        </div>
      </div>
      <div class="flex items-center gap-2">
        <a href="/templates" class="text-sm text-gray-600 hover:text-blue-600 px-3 py-1.5 rounded-md hover:bg-gray-100">
          <i class="fas fa-file-alt mr-1"></i>テンプレート
        </a>
        <span id="health-status" class="text-xs text-gray-400">
          <i class="fas fa-circle text-green-400 mr-1"></i>稼働中
        </span>
      </div>
    </div>
  </header>

  <main class="max-w-6xl mx-auto px-4 py-6">
    <!-- Step 1: Month selection + File upload -->
    <div id="step-upload" class="bg-white rounded-xl shadow-sm border border-gray-200 mb-4">
      <div class="px-6 py-4 border-b border-gray-100 flex items-center gap-2">
        <span class="w-7 h-7 bg-blue-600 text-white rounded-full flex items-center justify-center text-sm font-bold">1</span>
        <h2 class="text-base font-semibold text-gray-800">対象月 & ファイルアップロード</h2>
      </div>
      <div class="p-6">
        <!-- Month selector -->
        <div class="flex items-center gap-4 mb-6">
          <label class="text-sm font-medium text-gray-700">対象月:</label>
          <select id="year-select" class="border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500">
            <option value="2026">2026年</option>
            <option value="2025">2025年</option>
          </select>
          <select id="month-select" class="border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500">
            <option value="1">1月</option><option value="2">2月</option>
            <option value="3">3月</option><option value="4">4月</option>
            <option value="5">5月</option><option value="6">6月</option>
            <option value="7">7月</option><option value="8">8月</option>
            <option value="9">9月</option><option value="10">10月</option>
            <option value="11">11月</option><option value="12">12月</option>
          </select>
        </div>

        <!-- File upload zones -->
        <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
          <!-- Lukumi data -->
          <div>
            <label class="text-sm font-medium text-gray-700 mb-2 block">
              <i class="fas fa-file-excel text-green-600 mr-1"></i>
              ルクミー登降園データ
              <span class="text-xs text-gray-400 ml-1">(.xlsx / .csv)</span>
            </label>
            <div id="drop-lukumi" class="drop-zone rounded-xl p-8 text-center cursor-pointer hover:border-blue-400"
                 ondragover="handleDragOver(event)" ondragleave="handleDragLeave(event)" 
                 ondrop="handleDrop(event, 'lukumi')" onclick="document.getElementById('input-lukumi').click()">
              <i class="fas fa-cloud-upload-alt text-3xl text-gray-400 mb-2"></i>
              <p class="text-sm text-gray-500">ドラッグ&ドロップ または クリック</p>
              <p class="text-xs text-gray-400 mt-1">1ファイル</p>
              <input type="file" id="input-lukumi" class="hidden" accept=".xlsx,.csv" onchange="handleFileSelect(event, 'lukumi')">
            </div>
            <div id="file-list-lukumi" class="mt-2 space-y-1"></div>
          </div>

          <!-- Schedule plans -->
          <div>
            <label class="text-sm font-medium text-gray-700 mb-2 block">
              <i class="fas fa-calendar-alt text-blue-600 mr-1"></i>
              児童利用予定表
              <span class="text-xs text-gray-400 ml-1">(複数ファイル .xlsx)</span>
            </label>
            <div id="drop-schedule" class="drop-zone rounded-xl p-8 text-center cursor-pointer hover:border-blue-400"
                 ondragover="handleDragOver(event)" ondragleave="handleDragLeave(event)" 
                 ondrop="handleDrop(event, 'schedule')" onclick="document.getElementById('input-schedule').click()">
              <i class="fas fa-cloud-upload-alt text-3xl text-gray-400 mb-2"></i>
              <p class="text-sm text-gray-500">ドラッグ&ドロップ または クリック</p>
              <p class="text-xs text-gray-400 mt-1">複数ファイル可 (1園児1ファイル)</p>
              <input type="file" id="input-schedule" class="hidden" accept=".xlsx" multiple onchange="handleFileSelect(event, 'schedule')">
            </div>
            <div id="file-list-schedule" class="mt-2 space-y-1"></div>
          </div>
        </div>

        <!-- Upload summary -->
        <div id="upload-summary" class="hidden mt-4 bg-blue-50 rounded-lg p-4">
          <div class="flex items-center justify-between">
            <div>
              <span class="text-sm font-medium text-blue-800">
                <i class="fas fa-check-circle mr-1"></i>
                アップロード準備完了
              </span>
              <span id="summary-text" class="text-xs text-blue-600 ml-2"></span>
            </div>
            <button id="btn-generate" onclick="startGeneration()"
                    class="bg-blue-600 text-white px-6 py-2.5 rounded-lg text-sm font-medium hover:bg-blue-700 transition-colors shadow-sm">
              <i class="fas fa-magic mr-1"></i>生成開始
            </button>
          </div>
        </div>
      </div>
    </div>

    <!-- Step 2: Progress -->
    <div id="step-progress" class="hidden bg-white rounded-xl shadow-sm border border-gray-200 mb-4">
      <div class="px-6 py-4 border-b border-gray-100 flex items-center gap-2">
        <span class="w-7 h-7 bg-yellow-500 text-white rounded-full flex items-center justify-center text-sm font-bold pulse-gentle">2</span>
        <h2 class="text-base font-semibold text-gray-800">処理中...</h2>
      </div>
      <div class="p-6">
        <div class="w-full bg-gray-200 rounded-full h-3 mb-3">
          <div id="progress-bar" class="bg-blue-600 h-3 rounded-full progress-fill" style="width: 0%"></div>
        </div>
        <p id="progress-text" class="text-sm text-gray-600">ファイルを解析中...</p>
        <div id="progress-log" class="mt-4 bg-gray-50 rounded-lg p-3 max-h-40 overflow-y-auto text-xs font-mono text-gray-600">
        </div>
      </div>
    </div>

    <!-- Step 3: Results -->
    <div id="step-result" class="hidden bg-white rounded-xl shadow-sm border border-gray-200 mb-4">
      <div class="px-6 py-4 border-b border-gray-100 flex items-center gap-2">
        <span class="w-7 h-7 bg-green-500 text-white rounded-full flex items-center justify-center text-sm font-bold">3</span>
        <h2 class="text-base font-semibold text-gray-800">生成完了</h2>
        <button id="btn-download-zip" onclick="downloadZip()" 
                class="ml-auto bg-green-600 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-green-700">
          <i class="fas fa-download mr-1"></i>ZIP一括ダウンロード
        </button>
      </div>
      <div class="p-6">
        <div id="result-files" class="space-y-3"></div>
        <div id="result-warnings" class="mt-4"></div>
        <div id="result-stats" class="mt-4 text-sm text-gray-600"></div>
      </div>
    </div>

    <!-- Past Jobs -->
    <div class="bg-white rounded-xl shadow-sm border border-gray-200">
      <div class="px-6 py-4 border-b border-gray-100">
        <h2 class="text-base font-semibold text-gray-800">
          <i class="fas fa-history text-gray-400 mr-2"></i>過去の実行
        </h2>
      </div>
      <div id="past-jobs" class="p-6">
        <p class="text-sm text-gray-400 text-center py-4">まだ実行履歴はありません</p>
      </div>
    </div>
  </main>

  <script src="/static/app.js"></script>
</body>
</html>`);
});

// Templates management page
app.get('/templates', (c) => {
  return c.html(`<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>テンプレート管理 - あゆっこ</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <link href="https://cdn.jsdelivr.net/npm/@fortawesome/fontawesome-free@6.4.0/css/all.min.css" rel="stylesheet">
</head>
<body class="bg-gray-50 min-h-screen">
  <header class="bg-white border-b border-gray-200 shadow-sm">
    <div class="max-w-6xl mx-auto px-4 py-3 flex items-center gap-3">
      <a href="/" class="text-gray-400 hover:text-blue-600"><i class="fas fa-arrow-left"></i></a>
      <div class="w-10 h-10 bg-blue-600 rounded-lg flex items-center justify-center">
        <i class="fas fa-file-alt text-white"></i>
      </div>
      <h1 class="text-lg font-bold text-gray-800">テンプレート・料金ルール管理</h1>
    </div>
  </header>
  <main class="max-w-6xl mx-auto px-4 py-6">
    <!-- Template upload sections -->
    <div class="grid grid-cols-1 md:grid-cols-2 gap-4 mb-6">
      <div class="bg-white rounded-xl shadow-sm border p-6">
        <h3 class="font-semibold text-gray-800 mb-3"><i class="fas fa-file-excel text-green-600 mr-2"></i>日報テンプレート</h3>
        <p class="text-xs text-gray-500 mb-4">22シート構成の日報Excelテンプレート</p>
        <div id="tmpl-daily-status" class="text-sm text-gray-400 mb-3">未アップロード</div>
        <input type="file" id="tmpl-daily-input" class="hidden" accept=".xlsx" 
               onchange="uploadTemplate(event, 'daily_report')">
        <button onclick="document.getElementById('tmpl-daily-input').click()"
                class="bg-blue-50 text-blue-600 px-4 py-2 rounded-lg text-sm hover:bg-blue-100">
          <i class="fas fa-upload mr-1"></i>アップロード
        </button>
      </div>
      <div class="bg-white rounded-xl shadow-sm border p-6">
        <h3 class="font-semibold text-gray-800 mb-3"><i class="fas fa-file-invoice-dollar text-purple-600 mr-2"></i>保育料明細テンプレート</h3>
        <p class="text-xs text-gray-500 mb-4">月別シート構成の保育料明細Excel</p>
        <div id="tmpl-billing-status" class="text-sm text-gray-400 mb-3">未アップロード</div>
        <input type="file" id="tmpl-billing-input" class="hidden" accept=".xlsx" 
               onchange="uploadTemplate(event, 'billing_detail')">
        <button onclick="document.getElementById('tmpl-billing-input').click()"
                class="bg-blue-50 text-blue-600 px-4 py-2 rounded-lg text-sm hover:bg-blue-100">
          <i class="fas fa-upload mr-1"></i>アップロード
        </button>
      </div>
    </div>

    <!-- Pricing rules -->
    <div class="bg-white rounded-xl shadow-sm border p-6">
      <h3 class="font-semibold text-gray-800 mb-3"><i class="fas fa-yen-sign text-yellow-600 mr-2"></i>料金ルール</h3>
      <p class="text-xs text-gray-500 mb-4">保育料案内PDFから自動抽出、または手動設定</p>
      <div id="pricing-status" class="text-sm text-gray-600 mb-4">デフォルト料金ルール (2025年度) を使用</div>
      <button onclick="loadDefaultPricing()"
              class="bg-yellow-50 text-yellow-700 px-4 py-2 rounded-lg text-sm hover:bg-yellow-100">
        <i class="fas fa-sync mr-1"></i>デフォルト料金を読み込み
      </button>
    </div>
  </main>
  <script>
    async function uploadTemplate(event, type) {
      const file = event.target.files[0];
      if (!file) return;
      const formData = new FormData();
      formData.append('file', file);
      formData.append('template_type', type);
      try {
        const res = await fetch('/api/templates/upload', { method: 'POST', body: formData });
        const data = await res.json();
        if (res.ok) {
          const statusId = type === 'daily_report' ? 'tmpl-daily-status' : 'tmpl-billing-status';
          document.getElementById(statusId).innerHTML = '<span class="text-green-600"><i class="fas fa-check-circle mr-1"></i>' + file.name + '</span>';
        } else {
          alert(data.error || 'アップロードに失敗しました');
        }
      } catch (e) { alert('エラー: ' + e.message); }
    }
    async function loadDefaultPricing() {
      const rules = ${JSON.stringify({
        fiscal_year: 2025,
        monthly_fees: { "0~2歳": { "1": 45000, "2": 50000, "3": 54000 }, "3歳": { "1": 36000, "2": 41000, "3": 45000 }, "4~5歳": { "1": 35000, "2": 39000, "3": 42000 } },
        spot_rates: { "0~2歳": 200, "3歳": 200, "4~5歳": 150 },
        early_morning_fee: 300,
        extension_fee: 300,
        night_fees: { "0~2歳": 3000, "3歳": 2500, "4~5歳": 2500 },
        sick_fee: 2500,
        meal_prices: { lunch: 300, am_snack: 50, pm_snack: 100, dinner: 300 },
        time_boundaries: { open: "07:30", early_start: "07:00", early_end: "07:30", extension_start: "18:00", night_start: "20:00", close: "20:00" },
        rounding: { monthly: "15min", spot: "30min" }
      })};
      try {
        const res = await fetch('/api/templates/pricing', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ fiscal_year: 2025, rules })
        });
        if (res.ok) {
          document.getElementById('pricing-status').innerHTML = '<span class="text-green-600"><i class="fas fa-check-circle mr-1"></i>2025年度 デフォルト料金ルールを保存しました</span>';
        }
      } catch (e) { alert('エラー: ' + e.message); }
    }
    // Load existing templates on page load
    fetch('/api/templates').then(r => r.json()).then(data => {
      for (const t of data.templates || []) {
        const statusId = t.template_type === 'daily_report' ? 'tmpl-daily-status' : 'tmpl-billing-status';
        const el = document.getElementById(statusId);
        if (el) el.innerHTML = '<span class="text-green-600"><i class="fas fa-check-circle mr-1"></i>' + t.file_name + '</span>';
      }
    }).catch(() => {});
  </script>
</body>
</html>`);
});

export default app;

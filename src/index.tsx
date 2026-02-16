/**
 * あゆっこ保育園 業務自動化システム
 * Main Hono Application Entry Point
 * 
 * v3.2 (2026-02-16) — Phase B: Enhanced Parsers
 * Core: Upload → One-click Generate → ZIP of all deliverables
 * Architecture: Hono (UI + proxy) → Python Generator (port 8787)
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

// Favicon - return empty 204
app.get('/favicon.ico', (c) => new Response(null, { status: 204 }));

// Health check
app.get('/api/health', (c) => {
  return c.json({
    status: 'ok',
    version: '3.3',
    system: 'あゆっこ保育園 業務自動化システム',
    phase: 'B-D (parsers+writers+UI)',
    timestamp: new Date().toISOString(),
  });
});

// API Routes
app.route('/api/jobs', jobRoutes);
app.route('/api/children', childRoutes);
app.route('/api/templates', templateRoutes);

// Main UI HTML
function mainPage(): string {
  return `<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>あゆっこ 業務自動化</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <link href="https://cdn.jsdelivr.net/npm/@fortawesome/fontawesome-free@6.4.0/css/all.min.css" rel="stylesheet">
  <style>
    .drop-zone { border: 2px dashed #cbd5e1; transition: all 0.2s; }
    .drop-zone.drag-over { border-color: #3b82f6; background: #eff6ff; }
    .progress-fill { transition: width 0.5s ease-in-out; }
    @keyframes pulse-gentle { 0%, 100% { opacity: 1; } 50% { opacity: 0.7; } }
    .pulse-gentle { animation: pulse-gentle 2s infinite; }
    details > summary { list-style: none; }
    details > summary::-webkit-details-marker { display: none; }
  </style>
</head>
<body class="bg-gray-50 min-h-screen">
  <header class="bg-white border-b border-gray-200 shadow-sm">
    <div class="max-w-6xl mx-auto px-4 py-3 flex items-center justify-between">
      <div class="flex items-center gap-3">
        <div class="w-10 h-10 bg-blue-600 rounded-lg flex items-center justify-center">
          <i class="fas fa-child text-white text-lg"></i>
        </div>
        <div>
          <h1 class="text-lg font-bold text-gray-800">あゆっこ 業務自動化</h1>
          <p class="text-xs text-gray-500">滋賀医科大学学内保育所 v3.3</p>
        </div>
      </div>
      <div class="flex items-center gap-2">
        <button onclick="resetAll()" class="text-xs text-gray-400 hover:text-red-500 transition-colors px-2 py-1 rounded">
          <i class="fas fa-redo mr-1"></i>リセット
        </button>
        <span id="health-status" class="text-xs text-gray-400">
          <i class="fas fa-circle text-green-400 mr-1"></i>稼働中
        </span>
      </div>
    </div>
  </header>

  <main class="max-w-6xl mx-auto px-4 py-6">

    <div id="step-upload" class="bg-white rounded-xl shadow-sm border border-gray-200 mb-4">
      <div class="px-6 py-4 border-b border-gray-100 flex items-center gap-2">
        <span class="w-7 h-7 bg-blue-600 text-white rounded-full flex items-center justify-center text-sm font-bold">1</span>
        <h2 class="text-base font-semibold text-gray-800">対象月 & ファイルアップロード</h2>
      </div>
      <div class="p-6">
        <div class="flex items-center gap-4 mb-6">
          <label class="text-sm font-medium text-gray-700">対象月:</label>
          <select id="year-select" class="border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-blue-500">
            <option value="2026">2026年</option>
            <option value="2025">2025年</option>
          </select>
          <select id="month-select" class="border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-blue-500">
            <option value="1">1月</option><option value="2">2月</option>
            <option value="3">3月</option><option value="4">4月</option>
            <option value="5">5月</option><option value="6">6月</option>
            <option value="7">7月</option><option value="8">8月</option>
            <option value="9">9月</option><option value="10">10月</option>
            <option value="11">11月</option><option value="12">12月</option>
          </select>
        </div>

        <h3 class="text-sm font-semibold text-gray-700 mb-3">
          <i class="fas fa-asterisk text-red-400 text-xs mr-1"></i>必須ファイル
        </h3>
        <div class="grid grid-cols-1 md:grid-cols-2 gap-4 mb-6">
          <div>
            <label class="text-sm font-medium text-gray-700 mb-2 block">
              <i class="fas fa-file-excel text-green-600 mr-1"></i>ルクミー登降園データ
              <span class="text-xs text-red-400 ml-1">(必須)</span>
            </label>
            <div id="drop-lukumi" class="drop-zone rounded-xl p-6 text-center cursor-pointer hover:border-blue-400"
                 ondragover="handleDragOver(event)" ondragleave="handleDragLeave(event)"
                 ondrop="handleDrop(event, 'lukumi')" onclick="document.getElementById('input-lukumi').click()">
              <i class="fas fa-cloud-upload-alt text-2xl text-gray-400 mb-1"></i>
              <p class="text-sm text-gray-500">ドラッグ&ドロップ または クリック</p>
              <p class="text-xs text-gray-400 mt-1">.xlsx / .csv</p>
              <input type="file" id="input-lukumi" class="hidden" accept=".xlsx,.csv" onchange="handleFileSelect(event, 'lukumi')">
            </div>
            <div id="file-list-lukumi" class="mt-2 space-y-1"></div>
          </div>

          <div>
            <label class="text-sm font-medium text-gray-700 mb-2 block">
              <i class="fas fa-calendar-alt text-blue-600 mr-1"></i>児童利用予定表
              <span class="text-xs text-gray-400 ml-1">(複数ファイル)</span>
            </label>
            <div id="drop-schedule" class="drop-zone rounded-xl p-6 text-center cursor-pointer hover:border-blue-400"
                 ondragover="handleDragOver(event)" ondragleave="handleDragLeave(event)"
                 ondrop="handleDrop(event, 'schedule')" onclick="document.getElementById('input-schedule').click()">
              <i class="fas fa-cloud-upload-alt text-2xl text-gray-400 mb-1"></i>
              <p class="text-sm text-gray-500">ドラッグ&ドロップ または クリック</p>
              <p class="text-xs text-gray-400 mt-1">1園児1ファイル (.xlsx)</p>
              <input type="file" id="input-schedule" class="hidden" accept=".xlsx" multiple onchange="handleFileSelect(event, 'schedule')">
            </div>
            <div id="file-list-schedule" class="mt-2 space-y-1"></div>
          </div>
        </div>

        <details class="mb-4">
          <summary class="text-sm font-semibold text-gray-700 cursor-pointer mb-3">
            <i class="fas fa-cog text-gray-400 text-xs mr-1"></i>テンプレートファイル（任意）
            <span class="text-xs text-gray-400 ml-2">クリックで展開</span>
          </summary>
          <div class="grid grid-cols-1 md:grid-cols-2 gap-4 mt-3">
            <div>
              <label class="text-sm font-medium text-gray-700 mb-2 block">
                <i class="fas fa-file-alt text-emerald-600 mr-1"></i>日報テンプレート
              </label>
              <div id="drop-daily_template" class="drop-zone rounded-lg p-4 text-center cursor-pointer hover:border-emerald-400"
                   ondragover="handleDragOver(event)" ondragleave="handleDragLeave(event)"
                   ondrop="handleDrop(event, 'daily_template')" onclick="document.getElementById('input-daily_template').click()">
                <i class="fas fa-upload text-gray-400 mb-1"></i>
                <p class="text-xs text-gray-500">日報テンプレートExcel (.xlsx)</p>
                <input type="file" id="input-daily_template" class="hidden" accept=".xlsx" onchange="handleFileSelect(event, 'daily_template')">
              </div>
              <div id="file-list-daily_template" class="mt-1 space-y-1"></div>
            </div>
            <div>
              <label class="text-sm font-medium text-gray-700 mb-2 block">
                <i class="fas fa-file-invoice-dollar text-purple-600 mr-1"></i>保育料明細テンプレート
              </label>
              <div id="drop-billing_template" class="drop-zone rounded-lg p-4 text-center cursor-pointer hover:border-purple-400"
                   ondragover="handleDragOver(event)" ondragleave="handleDragLeave(event)"
                   ondrop="handleDrop(event, 'billing_template')" onclick="document.getElementById('input-billing_template').click()">
                <i class="fas fa-upload text-gray-400 mb-1"></i>
                <p class="text-xs text-gray-500">保育料明細テンプレートExcel (.xlsx)</p>
                <input type="file" id="input-billing_template" class="hidden" accept=".xlsx" onchange="handleFileSelect(event, 'billing_template')">
              </div>
              <div id="file-list-billing_template" class="mt-1 space-y-1"></div>
            </div>
          </div>
        </details>

        <div id="upload-summary" class="hidden mt-4 bg-blue-50 rounded-lg p-4">
          <div class="flex items-center justify-between">
            <div>
              <span class="text-sm font-medium text-blue-800">
                <i class="fas fa-check-circle mr-1"></i>アップロード準備完了
              </span>
              <span id="summary-text" class="text-xs text-blue-600 ml-2"></span>
            </div>
            <button id="btn-generate" onclick="startGeneration()"
                    class="bg-blue-600 text-white px-6 py-2.5 rounded-lg text-sm font-medium hover:bg-blue-700 transition-colors shadow-sm disabled:opacity-50 disabled:cursor-not-allowed">
              <i class="fas fa-magic mr-1"></i>生成開始
            </button>
          </div>
        </div>
      </div>
    </div>

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
        <div id="progress-log" class="mt-4 bg-gray-50 rounded-lg p-3 max-h-40 overflow-y-auto text-xs font-mono text-gray-600"></div>
      </div>
    </div>

    <div id="step-result" class="hidden bg-white rounded-xl shadow-sm border border-gray-200 mb-4">
      <div class="px-6 py-4 border-b border-gray-100 flex items-center gap-2">
        <span class="w-7 h-7 bg-green-500 text-white rounded-full flex items-center justify-center text-sm font-bold">3</span>
        <h2 class="text-base font-semibold text-gray-800">生成結果</h2>
        <button id="btn-download-zip" onclick="downloadZip()"
                class="ml-auto bg-green-600 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-green-700">
          <i class="fas fa-download mr-1"></i>ZIP一括ダウンロード
        </button>
      </div>
      <div class="p-6">
        <div id="result-files" class="space-y-3"></div>
        <div id="result-submission" class="mt-4"></div>
        <div id="result-warnings" class="mt-4"></div>
        <div id="result-stats" class="mt-4 text-sm text-gray-600"></div>
      </div>
    </div>

  </main>
  <script src="/static/app.js"></script>
</body>
</html>`;
}

app.get('/', (c) => {
  return c.html(mainPage());
});

export default app;

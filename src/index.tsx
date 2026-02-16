/**
 * 滋賀医科大学学内保育所 あゆっこ — 業務自動化システム
 * Main Hono Application Entry Point
 * 
 * v4.2 (2026-02-16) — ダッシュボード強化: 今日/明日/今週/月間タブ、提出物説明、AI読み取り入口、マニュアル
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

// Favicon
app.get('/favicon.ico', (c) => new Response(null, { status: 204 }));

// Health check
app.get('/api/health', (c) => {
  return c.json({
    status: 'ok',
    version: '4.2',
    system: '滋賀医科大学学内保育所 あゆっこ 業務自動化システム',
    phase: 'Dashboard + Generator',
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
  <title>あゆっこ 業務自動化システム</title>
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
    .cal-day { min-height: 90px; transition: all 0.15s; }
    .cal-day:hover { transform: translateY(-1px); box-shadow: 0 4px 12px rgba(0,0,0,0.1); }
    .cal-day.selected { ring: 2px; box-shadow: 0 0 0 2px #3b82f6; }
    .cal-day.weekend { background: #fafafa; }
    .badge { display: inline-flex; align-items: center; gap: 2px; font-size: 10px; padding: 1px 5px; border-radius: 9999px; font-weight: 600; }
    .tab-active { border-bottom: 2px solid #3b82f6; color: #1d4ed8; font-weight: 600; }
    .tab-inactive { color: #6b7280; }
    .tab-inactive:hover { color: #374151; }
  </style>
</head>
<body class="bg-gray-50 min-h-screen">
  <!-- ═══ HEADER ═══ -->
  <header class="bg-white border-b border-gray-200 shadow-sm">
    <div class="max-w-7xl mx-auto px-4 py-3 flex items-center justify-between">
      <div class="flex items-center gap-3">
        <div class="w-10 h-10 bg-blue-600 rounded-lg flex items-center justify-center">
          <i class="fas fa-child text-white text-lg"></i>
        </div>
        <div>
          <h1 class="text-base font-bold text-gray-800">滋賀医科大学学内保育所 あゆっこ</h1>
          <p class="text-xs text-gray-500">業務自動化システム v4.2</p>
        </div>
      </div>
      <div class="flex items-center gap-3">
        <button onclick="showManual()" class="text-xs text-blue-500 hover:text-blue-700 transition-colors px-2 py-1 rounded" title="使い方マニュアル">
          <i class="fas fa-book mr-1"></i>マニュアル
        </button>
        <button onclick="resetAll()" class="text-xs text-gray-400 hover:text-red-500 transition-colors px-2 py-1 rounded" title="全リセット">
          <i class="fas fa-redo mr-1"></i>リセット
        </button>
        <span id="health-status" class="text-xs text-gray-400">
          <i class="fas fa-circle text-green-400 mr-1"></i>稼働中
        </span>
      </div>
    </div>
  </header>

  <main class="max-w-7xl mx-auto px-4 py-4">

    <!-- ═══ TAB NAVIGATION ═══ -->
    <div class="flex border-b border-gray-200 mb-4 gap-6">
      <button onclick="switchTab('dashboard')" id="tab-dashboard" class="pb-2 text-sm tab-active">
        <i class="fas fa-calendar-alt mr-1"></i>月間ダッシュボード
      </button>
      <button onclick="switchTab('upload')" id="tab-upload" class="pb-2 text-sm tab-inactive">
        <i class="fas fa-upload mr-1"></i>データ入力
      </button>
      <button onclick="switchTab('generate')" id="tab-generate" class="pb-2 text-sm tab-inactive">
        <i class="fas fa-file-archive mr-1"></i>提出物生成
      </button>
    </div>

    <!-- ═══════════════════════════════════════════ -->
    <!-- TAB 1: DASHBOARD (月間カレンダー)          -->
    <!-- ═══════════════════════════════════════════ -->
    <div id="panel-dashboard">

      <!-- ═══ EMPTY STATE (before data loaded) ═══ -->
      <div id="dashboard-empty">
        <!-- Guide card: always visible even before upload -->
        <div class="bg-white rounded-xl shadow-sm border border-gray-200 mb-4">
          <div class="px-5 py-4">
            <h3 class="text-sm font-bold text-gray-800 mb-3 flex items-center gap-2">
              <span class="w-6 h-6 bg-blue-600 rounded-lg flex items-center justify-center">
                <i class="fas fa-info text-white text-xs"></i>
              </span>
              このシステムでできること
            </h3>
            <div class="grid grid-cols-1 md:grid-cols-2 gap-3 mb-4">
              <div class="bg-blue-50 rounded-lg px-4 py-3 border border-blue-100">
                <div class="text-xs font-bold text-blue-800 mb-1"><i class="fas fa-calendar-alt mr-1"></i>月間ダッシュボード（この画面）</div>
                <div class="text-xs text-blue-600 leading-relaxed">
                  「誰が何日の何時に来るか」をカレンダー表示。<br>
                  食数・早朝/延長/夜間を一目で確認 → 職員シフト計画に。
                </div>
              </div>
              <div class="bg-green-50 rounded-lg px-4 py-3 border border-green-100">
                <div class="text-xs font-bold text-green-800 mb-1"><i class="fas fa-file-archive mr-1"></i>提出物の一括生成</div>
                <div class="text-xs text-green-600 leading-relaxed">
                  月末にZIP出力 → 3フォルダで提出完了。<br>
                  日報Excel / 保育料明細 / 保護者PDF を自動作成。
                </div>
              </div>
            </div>
            <!-- ZIP output explanation -->
            <details>
              <summary class="text-xs font-semibold text-gray-600 cursor-pointer flex items-center gap-1">
                <i class="fas fa-folder-open text-gray-400"></i>
                出力される提出物（ZIP）の詳細
                <span class="text-gray-400 font-normal ml-1">クリックで展開</span>
              </summary>
              <div class="mt-3 grid grid-cols-1 md:grid-cols-4 gap-2 text-xs">
                <div class="bg-emerald-50 rounded-lg px-3 py-2 border border-emerald-200">
                  <div class="font-bold text-emerald-800">01_園内管理</div>
                  <div class="text-emerald-600 mt-0.5">園児登園確認表<br>児童実績表申請<br>◆保育時間（食数含む）</div>
                </div>
                <div class="bg-purple-50 rounded-lg px-3 py-2 border border-purple-200">
                  <div class="font-bold text-purple-800">02_経理提出</div>
                  <div class="text-purple-600 mt-0.5">保育料明細Excel<br>数量列のみ自動入力<br>（単価・合計はテンプレ計算）</div>
                </div>
                <div class="bg-blue-50 rounded-lg px-3 py-2 border border-blue-200">
                  <div class="font-bold text-blue-800">03_保護者配布</div>
                  <div class="text-blue-600 mt-0.5">園児別 利用明細書PDF<br>（自動生成）</div>
                </div>
                <div class="bg-gray-50 rounded-lg px-3 py-2 border border-gray-200">
                  <div class="font-bold text-gray-700">_meta.json</div>
                  <div class="text-gray-500 mt-0.5">未提出・例外の一覧<br>処理結果サマリー</div>
                </div>
              </div>
            </details>
          </div>
        </div>

        <!-- How to start -->
        <div class="bg-white rounded-xl shadow-sm border border-gray-200 p-10 text-center">
          <div class="w-14 h-14 bg-blue-50 rounded-full flex items-center justify-center mx-auto mb-4">
            <i class="fas fa-calendar-alt text-blue-400 text-2xl"></i>
          </div>
          <h3 class="text-base font-semibold text-gray-700 mb-2">月間ダッシュボード</h3>
          <p class="text-sm text-gray-500 mb-1 max-w-md mx-auto">
            ルクミー登降園データと利用予定表をアップロードすると、<br>
            月間の来園予定・食数・早朝/延長/夜間がカレンダーで表示されます。
          </p>
          <p class="text-xs text-gray-400 mb-5 max-w-md mx-auto">
            ① ルクミー ② 予定表 を入れて「月間表示」。提出が必要なときだけ「提出物を作成」。
          </p>
          <button onclick="switchTab('upload')" class="bg-blue-600 text-white px-6 py-2.5 rounded-lg text-sm font-medium hover:bg-blue-700 transition-colors">
            <i class="fas fa-upload mr-1"></i>データをアップロード
          </button>
        </div>
      </div>

      <!-- ═══ DASHBOARD CONTENT (after data loaded) ═══ -->
      <div id="dashboard-content" class="hidden">

        <!-- Guide card (collapsed in loaded state) -->
        <details id="dashboard-guide" class="bg-white rounded-xl shadow-sm border border-gray-200 mb-4">
          <summary class="px-5 py-3 cursor-pointer flex items-center justify-between text-sm">
            <span class="font-semibold text-gray-700 flex items-center gap-2">
              <i class="fas fa-info-circle text-blue-500"></i>このシステムでできること
            </span>
            <span class="text-xs text-gray-400">クリックで展開</span>
          </summary>
          <div class="px-5 pb-4">
            <div class="grid grid-cols-1 md:grid-cols-4 gap-2 text-xs mt-2">
              <div class="bg-emerald-50 rounded-lg px-3 py-2 border border-emerald-200">
                <div class="font-bold text-emerald-800">01_園内管理</div>
                <div class="text-emerald-600 mt-0.5">園児登園確認表 / 児童実績表 / ◆保育時間</div>
              </div>
              <div class="bg-purple-50 rounded-lg px-3 py-2 border border-purple-200">
                <div class="font-bold text-purple-800">02_経理提出</div>
                <div class="text-purple-600 mt-0.5">保育料明細（数量列のみ自動入力）</div>
              </div>
              <div class="bg-blue-50 rounded-lg px-3 py-2 border border-blue-200">
                <div class="font-bold text-blue-800">03_保護者配布</div>
                <div class="text-blue-600 mt-0.5">園児別 利用明細書PDF</div>
              </div>
              <div class="bg-gray-50 rounded-lg px-3 py-2 border border-gray-200">
                <div class="font-bold text-gray-700">_meta.json</div>
                <div class="text-gray-500 mt-0.5">未提出・例外の一覧</div>
              </div>
            </div>
          </div>
        </details>

        <!-- ═══ DASHBOARD SUB-TABS: 今日/明日/今週/月間 ═══ -->
        <div class="flex items-center gap-1 mb-4 bg-white rounded-xl shadow-sm border border-gray-200 px-3 py-2">
          <span class="text-xs text-gray-500 mr-2 font-medium"><i class="fas fa-eye mr-1"></i>表示:</span>
          <button onclick="switchDashView('today')" id="dv-today" class="dash-view-btn px-3 py-1.5 rounded-lg text-xs font-medium transition-all bg-blue-600 text-white">
            <i class="fas fa-sun mr-1"></i>今日
          </button>
          <button onclick="switchDashView('tomorrow')" id="dv-tomorrow" class="dash-view-btn px-3 py-1.5 rounded-lg text-xs font-medium transition-all bg-gray-100 text-gray-600 hover:bg-gray-200">
            <i class="fas fa-forward mr-1"></i>明日
          </button>
          <button onclick="switchDashView('week')" id="dv-week" class="dash-view-btn px-3 py-1.5 rounded-lg text-xs font-medium transition-all bg-gray-100 text-gray-600 hover:bg-gray-200">
            <i class="fas fa-calendar-week mr-1"></i>今週
          </button>
          <button onclick="switchDashView('month')" id="dv-month" class="dash-view-btn px-3 py-1.5 rounded-lg text-xs font-medium transition-all bg-gray-100 text-gray-600 hover:bg-gray-200">
            <i class="fas fa-calendar mr-1"></i>月間
          </button>
        </div>

        <!-- TODAY SUMMARY (dynamic) -->
        <div id="dashboard-today" class="mb-4"></div>

        <!-- ═══ SCOPED VIEW: today/tomorrow/week (single-day or list) ═══ -->
        <div id="dashboard-scoped-view" class="mb-4 hidden"></div>

        <!-- Alerts (submission issues) -->
        <div id="dashboard-alerts" class="mb-4"></div>

        <!-- Month header + summary -->
        <div id="dashboard-month-section">
        <div class="flex items-center justify-between mb-4 flex-wrap gap-2">
          <h2 id="dashboard-month-title" class="text-lg font-bold text-gray-800"></h2>
          <div id="dashboard-month-stats" class="flex flex-wrap gap-2"></div>
        </div>

        <!-- Calendar + Detail split -->
        <div class="grid grid-cols-1 lg:grid-cols-3 gap-4">
          <!-- Calendar (2/3 width) -->
          <div class="lg:col-span-2">
            <div class="bg-white rounded-xl shadow-sm border border-gray-200 overflow-hidden">
              <div class="grid grid-cols-7 bg-gray-50 border-b border-gray-200">
                <div class="px-2 py-2 text-center text-xs font-semibold text-gray-500">月</div>
                <div class="px-2 py-2 text-center text-xs font-semibold text-gray-500">火</div>
                <div class="px-2 py-2 text-center text-xs font-semibold text-gray-500">水</div>
                <div class="px-2 py-2 text-center text-xs font-semibold text-gray-500">木</div>
                <div class="px-2 py-2 text-center text-xs font-semibold text-gray-500">金</div>
                <div class="px-2 py-2 text-center text-xs font-semibold text-red-400">土</div>
                <div class="px-2 py-2 text-center text-xs font-semibold text-red-400">日</div>
              </div>
              <div id="calendar-grid" class="grid grid-cols-7"></div>
            </div>

            <!-- Legend -->
            <div class="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-gray-500">
              <span><span class="inline-block w-2 h-2 rounded-full bg-blue-400 mr-1"></span>来園人数</span>
              <span>🍱昼食</span>
              <span>🍪おやつ</span>
              <span>🍽夕食</span>
              <span class="text-orange-600">🕒早朝(~7:30)</span>
              <span class="text-purple-600">🕘延長(18:00~)</span>
              <span class="text-indigo-600">🌙夜間(20:00~)</span>
              <span class="text-red-600">💊病児</span>
            </div>
          </div>

          <!-- Day detail (1/3 width) -->
          <div class="lg:col-span-1">
            <div id="day-detail" class="bg-white rounded-xl shadow-sm border border-gray-200 sticky top-4">
              <div class="px-4 py-3 border-b border-gray-100">
                <h3 id="day-detail-title" class="text-sm font-bold text-gray-800">日付を選択してください</h3>
              </div>
              <div id="day-detail-content" class="p-4 text-sm text-gray-500">
                <p class="text-center py-8">カレンダーの日付をクリックすると<br>園児一覧が表示されます</p>
              </div>
            </div>
          </div>
        </div>
      </div>
      </div><!-- /dashboard-month-section -->
    </div>

    <!-- ═══════════════════════════════════════════ -->
    <!-- TAB 2: UPLOAD (データ入力)                  -->
    <!-- ═══════════════════════════════════════════ -->
    <div id="panel-upload" class="hidden">
      <div class="bg-white rounded-xl shadow-sm border border-gray-200 mb-4">
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

          <!-- ═══ SECTION A: Excelファイル ═══ -->
          <div class="mb-6">
            <h3 class="text-sm font-semibold text-gray-700 mb-3 flex items-center gap-2">
              <span class="w-5 h-5 bg-green-600 rounded flex items-center justify-center">
                <i class="fas fa-file-excel text-white text-[10px]"></i>
              </span>
              Excelファイル
              <span class="text-xs text-red-400">(必須)</span>
            </h3>
            <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
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
                  <i class="fas fa-calendar-alt text-blue-600 mr-1"></i>児童利用予定表 (Excel)
                  <span class="text-xs text-gray-400 ml-1">(複数OK)</span>
                </label>
                <div id="drop-schedule" class="drop-zone rounded-xl p-6 text-center cursor-pointer hover:border-blue-400"
                     ondragover="handleDragOver(event)" ondragleave="handleDragLeave(event)"
                     ondrop="handleDrop(event, 'schedule')" onclick="document.getElementById('input-schedule').click()">
                  <i class="fas fa-cloud-upload-alt text-2xl text-gray-400 mb-1"></i>
                  <p class="text-sm text-gray-500">ドラッグ&ドロップ または クリック</p>
                  <p class="text-xs text-gray-400 mt-1">.xlsx (複数ファイル可)</p>
                  <input type="file" id="input-schedule" class="hidden" accept=".xlsx" multiple onchange="handleFileSelect(event, 'schedule')">
                </div>
                <div id="file-list-schedule" class="mt-2 space-y-1"></div>
              </div>
            </div>
          </div>

          <!-- ═══ SECTION B: PDF/写真 (AI読み取り) ═══ -->
          <div class="mb-6">
            <h3 class="text-sm font-semibold text-gray-700 mb-3 flex items-center gap-2">
              <span class="w-5 h-5 bg-purple-600 rounded flex items-center justify-center">
                <i class="fas fa-camera text-white text-[10px]"></i>
              </span>
              PDF / 写真（予定表の写メ・スキャン）
              <span class="text-xs text-gray-400">(任意)</span>
              <span class="bg-purple-100 text-purple-700 text-[10px] px-2 py-0.5 rounded-full font-medium">AI読み取り対応</span>
            </h3>
            <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <div id="drop-photo" class="drop-zone rounded-xl p-6 text-center cursor-pointer hover:border-purple-400 border-purple-200"
                     ondragover="handleDragOver(event)" ondragleave="handleDragLeave(event)"
                     ondrop="handleDrop(event, 'photo')" onclick="document.getElementById('input-photo').click()">
                  <i class="fas fa-camera text-2xl text-purple-400 mb-1"></i>
                  <p class="text-sm text-purple-600">写真・PDF をアップロード</p>
                  <p class="text-xs text-gray-400 mt-1">.pdf / .jpg / .png / .heic (複数OK)</p>
                  <input type="file" id="input-photo" class="hidden" accept=".pdf,.jpg,.jpeg,.png,.heic" multiple onchange="handleFileSelect(event, 'photo')">
                </div>
                <div id="file-list-photo" class="mt-2 space-y-1"></div>
              </div>
              <div class="flex flex-col justify-center">
                <div class="bg-purple-50 rounded-xl p-4 border border-purple-100">
                  <p class="text-xs text-purple-700 mb-3 leading-relaxed">
                    <i class="fas fa-magic mr-1"></i>
                    手書きの予定表やPDFをAIで読み取り、<br>
                    Excel予定表と同じ形式に自動変換します。
                  </p>
                  <button id="btn-ai-read" onclick="startAiRead()" disabled
                          class="w-full bg-purple-600 text-white px-4 py-2.5 rounded-lg text-sm font-medium hover:bg-purple-700 transition-colors disabled:opacity-40 disabled:cursor-not-allowed">
                    <i class="fas fa-robot mr-1"></i>AIで読み取り
                  </button>
                  <p class="text-[10px] text-purple-400 mt-2 text-center">写真/PDFをアップロードするとボタンが有効になります</p>
                </div>
              </div>
            </div>

            <!-- AI読み取りプレビュー (hidden by default) -->
            <div id="ai-read-preview" class="hidden mt-4 bg-purple-50 rounded-xl border border-purple-200 p-4">
              <div class="flex items-center justify-between mb-3">
                <h4 class="text-sm font-bold text-purple-800"><i class="fas fa-search mr-1"></i>AI読み取り結果（プレビュー）</h4>
                <div class="flex gap-2">
                  <button onclick="cancelAiRead()" class="text-xs text-gray-500 hover:text-red-500 px-3 py-1 rounded border border-gray-200">
                    <i class="fas fa-times mr-1"></i>キャンセル
                  </button>
                  <button onclick="confirmAiRead()" class="text-xs bg-purple-600 text-white px-3 py-1 rounded hover:bg-purple-700">
                    <i class="fas fa-check mr-1"></i>この内容で確定
                  </button>
                </div>
              </div>
              <div id="ai-read-result" class="text-xs text-gray-700 bg-white rounded-lg p-3 border border-purple-100 max-h-48 overflow-y-auto">
                <!-- AI result table will be rendered here -->
              </div>
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
            <div class="flex items-center justify-between flex-wrap gap-3">
              <div>
                <span class="text-sm font-medium text-blue-800">
                  <i class="fas fa-check-circle mr-1"></i>アップロード準備完了
                </span>
                <span id="summary-text" class="text-xs text-blue-600 ml-2"></span>
              </div>
              <div class="flex gap-2">
                <button id="btn-dashboard-load" onclick="loadDashboard()"
                        class="bg-blue-600 text-white px-5 py-2 rounded-lg text-sm font-medium hover:bg-blue-700 transition-colors shadow-sm disabled:opacity-50">
                  <i class="fas fa-calendar-alt mr-1"></i>ダッシュボード表示
                </button>
                <button id="btn-generate" onclick="startGeneration()"
                        class="bg-green-600 text-white px-5 py-2 rounded-lg text-sm font-medium hover:bg-green-700 transition-colors shadow-sm disabled:opacity-50 disabled:cursor-not-allowed">
                  <i class="fas fa-magic mr-1"></i>提出物生成
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- ═══════════════════════════════════════════ -->
    <!-- TAB 3: GENERATE (提出物生成)                -->
    <!-- ═══════════════════════════════════════════ -->
    <div id="panel-generate" class="hidden">

      <!-- ═══ FIXED ZIP CONTENTS EXPLANATION ═══ -->
      <div class="bg-white rounded-xl shadow-sm border border-gray-200 mb-4">
        <div class="px-5 py-4">
          <h3 class="text-sm font-bold text-gray-800 mb-3 flex items-center gap-2">
            <span class="w-6 h-6 bg-green-600 rounded-lg flex items-center justify-center">
              <i class="fas fa-file-archive text-white text-xs"></i>
            </span>
            生成される提出物（ZIPファイル）
          </h3>
          <div class="grid grid-cols-1 md:grid-cols-4 gap-2 text-xs">
            <div class="bg-emerald-50 rounded-lg px-3 py-2.5 border border-emerald-200">
              <div class="font-bold text-emerald-800 flex items-center gap-1"><i class="fas fa-folder text-emerald-500"></i>01_園内管理</div>
              <div class="text-emerald-600 mt-1 leading-relaxed">園児登園確認表<br>児童実績表申請<br>◆保育時間（食数含む）</div>
              <div class="text-emerald-400 mt-1 text-[10px]">日報Excel内シート</div>
            </div>
            <div class="bg-purple-50 rounded-lg px-3 py-2.5 border border-purple-200">
              <div class="font-bold text-purple-800 flex items-center gap-1"><i class="fas fa-folder text-purple-500"></i>02_経理提出</div>
              <div class="text-purple-600 mt-1 leading-relaxed">保育料明細Excel<br>数量列のみ自動入力<br>（単価・合計はテンプレ計算）</div>
              <div class="text-purple-400 mt-1 text-[10px]">明細テンプレートベース</div>
            </div>
            <div class="bg-blue-50 rounded-lg px-3 py-2.5 border border-blue-200">
              <div class="font-bold text-blue-800 flex items-center gap-1"><i class="fas fa-folder text-blue-500"></i>03_保護者配布</div>
              <div class="text-blue-600 mt-1 leading-relaxed">園児別 利用明細書PDF<br>（自動生成 / 印刷用）</div>
              <div class="text-blue-400 mt-1 text-[10px]">全園児分を一括生成</div>
            </div>
            <div class="bg-gray-50 rounded-lg px-3 py-2.5 border border-gray-200">
              <div class="font-bold text-gray-700 flex items-center gap-1"><i class="fas fa-file-code text-gray-500"></i>_meta.json</div>
              <div class="text-gray-500 mt-1 leading-relaxed">処理結果サマリー<br>未提出・例外の一覧<br>警告・エラー情報</div>
              <div class="text-gray-400 mt-1 text-[10px]">システム内部確認用</div>
            </div>
          </div>
        </div>
      </div>

      <!-- Progress -->
      <div id="step-progress" class="hidden bg-white rounded-xl shadow-sm border border-gray-200 mb-4">
        <div class="px-6 py-4 border-b border-gray-100 flex items-center gap-2">
          <span class="w-7 h-7 bg-yellow-500 text-white rounded-full flex items-center justify-center text-sm font-bold pulse-gentle">⏳</span>
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

      <!-- Result -->
      <div id="step-result" class="hidden bg-white rounded-xl shadow-sm border border-gray-200 mb-4">
        <div class="px-6 py-4 border-b border-gray-100 flex items-center gap-2">
          <span class="w-7 h-7 bg-green-500 text-white rounded-full flex items-center justify-center text-sm font-bold">✓</span>
          <h2 class="text-base font-semibold text-gray-800">生成結果</h2>
          <button id="btn-download-zip" onclick="downloadZip()"
                  class="ml-auto bg-green-600 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-green-700">
            <i class="fas fa-download mr-1"></i>ZIP一括ダウンロード
          </button>
        </div>
        <div class="p-6">
          <div id="result-submission" class="mb-4"></div>

          <!-- What's in the ZIP -->
          <div class="bg-gray-50 rounded-xl p-4 mb-4 border border-gray-200">
            <h4 class="text-sm font-bold text-gray-700 mb-3"><i class="fas fa-folder-open text-blue-500 mr-1"></i>生成されるもの</h4>
            <div class="grid grid-cols-1 md:grid-cols-3 gap-3" id="result-files"></div>
          </div>

          <div id="result-warnings" class="mt-4"></div>
          <div id="result-stats" class="mt-4 text-sm text-gray-600"></div>
        </div>
      </div>

      <!-- Empty state -->
      <div id="generate-empty" class="bg-white rounded-xl shadow-sm border border-gray-200 p-12 text-center">
        <div class="w-16 h-16 bg-green-50 rounded-full flex items-center justify-center mx-auto mb-4">
          <i class="fas fa-file-archive text-green-400 text-2xl"></i>
        </div>
        <h3 class="text-lg font-semibold text-gray-700 mb-2">提出物生成</h3>
        <p class="text-sm text-gray-500 mb-2 max-w-lg mx-auto">
          データをアップロードすると、以下の提出物を一括生成できます：
        </p>
        <div class="flex justify-center gap-4 mt-4 mb-6 text-xs text-gray-600">
          <div class="bg-green-50 px-3 py-2 rounded-lg border border-green-200">
            <div class="font-bold text-green-700">📁 01_園内管理</div>
            <div>登園確認表・実績表・保育時間</div>
          </div>
          <div class="bg-purple-50 px-3 py-2 rounded-lg border border-purple-200">
            <div class="font-bold text-purple-700">📁 02_経理提出</div>
            <div>保育料明細（数量列自動入力）</div>
          </div>
          <div class="bg-blue-50 px-3 py-2 rounded-lg border border-blue-200">
            <div class="font-bold text-blue-700">📁 03_保護者配布</div>
            <div>園児別 利用明細書PDF</div>
          </div>
        </div>
        <button onclick="switchTab('upload')" class="bg-green-600 text-white px-6 py-2.5 rounded-lg text-sm font-medium hover:bg-green-700">
          <i class="fas fa-upload mr-1"></i>データをアップロード
        </button>
      </div>
    </div>

  </main>
  <!-- ═══ MANUAL MODAL ═══ -->
  <div id="manual-modal" class="fixed inset-0 bg-black/50 z-50 hidden flex items-center justify-center p-4" onclick="if(event.target===this)closeManual()">
    <div class="bg-white rounded-2xl shadow-2xl max-w-2xl w-full max-h-[90vh] overflow-y-auto">
      <div class="sticky top-0 bg-white border-b border-gray-200 px-6 py-4 flex items-center justify-between rounded-t-2xl">
        <h2 class="text-base font-bold text-gray-800"><i class="fas fa-book text-blue-500 mr-2"></i>使い方マニュアル（1ページ版）</h2>
        <button onclick="closeManual()" class="text-gray-400 hover:text-gray-600"><i class="fas fa-times text-lg"></i></button>
      </div>
      <div class="p-6 text-sm text-gray-700 leading-relaxed space-y-5">

        <div class="bg-blue-50 rounded-xl p-4 border border-blue-200">
          <h3 class="font-bold text-blue-800 mb-2"><i class="fas fa-info-circle mr-1"></i>このシステムでできること</h3>
          <p class="text-xs text-blue-700">
            毎月のルクミー登降園データと園児利用予定表（2ファイル）を読み込むだけで、<br>
            <strong>月間ダッシュボード</strong>（誰が何時に来園するか）と<strong>提出物一式</strong>（ZIP）を自動生成します。
          </p>
        </div>

        <div>
          <h3 class="font-bold text-gray-800 mb-2 flex items-center gap-2">
            <span class="w-6 h-6 bg-blue-600 rounded-full flex items-center justify-center text-white text-xs font-bold">1</span>
            毎月やること（2ファイル準備）
          </h3>
          <div class="grid grid-cols-2 gap-3 ml-8">
            <div class="bg-green-50 rounded-lg px-3 py-2 border border-green-200">
              <div class="text-xs font-bold text-green-800"><i class="fas fa-file-excel text-green-600 mr-1"></i>ルクミー登降園データ</div>
              <div class="text-xs text-green-600 mt-1">ルクミー管理画面からCSV/Excelをダウンロード</div>
            </div>
            <div class="bg-blue-50 rounded-lg px-3 py-2 border border-blue-200">
              <div class="text-xs font-bold text-blue-800"><i class="fas fa-calendar-alt text-blue-600 mr-1"></i>児童利用予定表</div>
              <div class="text-xs text-blue-600 mt-1">保護者から回収したExcel（写メ/PDFもAI読み取り対応）</div>
            </div>
          </div>
        </div>

        <div>
          <h3 class="font-bold text-gray-800 mb-2 flex items-center gap-2">
            <span class="w-6 h-6 bg-blue-600 rounded-full flex items-center justify-center text-white text-xs font-bold">2</span>
            ダッシュボードを見る
          </h3>
          <div class="ml-8 text-xs text-gray-600 space-y-1">
            <p>1.「<strong>データ入力</strong>」タブで2ファイルをアップロード</p>
            <p>2.「<strong>ダッシュボード表示</strong>」ボタンをクリック</p>
            <p>3. 月間カレンダーで人数・食数・早朝/延長/夜間が一目で分かります</p>
            <p>4.「<strong>今日/明日/今週/月間</strong>」タブで表示範囲を切り替え</p>
            <p>5. 日付クリックで園児一覧・食事・時間帯の詳細を確認</p>
          </div>
        </div>

        <div>
          <h3 class="font-bold text-gray-800 mb-2 flex items-center gap-2">
            <span class="w-6 h-6 bg-blue-600 rounded-full flex items-center justify-center text-white text-xs font-bold">3</span>
            提出物を作成する
          </h3>
          <div class="ml-8 text-xs text-gray-600 space-y-1">
            <p>1. 必要に応じてテンプレートファイル（日報・明細）も追加</p>
            <p>2.「<strong>提出物生成</strong>」ボタンをクリック</p>
            <p>3. 自動生成されたZIPをダウンロード</p>
            <p>4. ZIPの中身:</p>
          </div>
          <div class="ml-8 mt-2 grid grid-cols-4 gap-2 text-xs">
            <div class="bg-emerald-50 px-2 py-1.5 rounded border border-emerald-200 text-center">
              <div class="font-bold text-emerald-800">01_園内管理</div>
              <div class="text-emerald-600">日報Excel</div>
            </div>
            <div class="bg-purple-50 px-2 py-1.5 rounded border border-purple-200 text-center">
              <div class="font-bold text-purple-800">02_経理提出</div>
              <div class="text-purple-600">保育料明細</div>
            </div>
            <div class="bg-blue-50 px-2 py-1.5 rounded border border-blue-200 text-center">
              <div class="font-bold text-blue-800">03_保護者配布</div>
              <div class="text-blue-600">利用明細PDF</div>
            </div>
            <div class="bg-gray-50 px-2 py-1.5 rounded border border-gray-200 text-center">
              <div class="font-bold text-gray-700">_meta.json</div>
              <div class="text-gray-500">処理結果</div>
            </div>
          </div>
        </div>

        <div class="bg-yellow-50 rounded-xl p-4 border border-yellow-200">
          <h3 class="font-bold text-yellow-800 mb-1"><i class="fas fa-lightbulb mr-1"></i>困ったら</h3>
          <div class="text-xs text-yellow-700 space-y-1">
            <p>- 予定表が未提出の園児は<strong>オレンジ色の警告</strong>で表示されます</p>
            <p>- 写真やPDFの予定表は「<strong>AIで読み取り</strong>」ボタンで自動変換できます</p>
            <p>- 右上の「<strong>リセット</strong>」で全データをクリアして最初からやり直せます</p>
          </div>
        </div>
      </div>
    </div>
  </div>

  <script src="https://cdn.jsdelivr.net/npm/jszip@3.10.1/dist/jszip.min.js"></script>
  <script src="/static/app.js"></script>
</body>
</html>`;
}

app.get('/', (c) => {
  return c.html(mainPage());
});

export default app;

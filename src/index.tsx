/**
 * 滋賀医科大学学内保育所 あゆっこ — 業務自動化システム
 * Main Hono Application Entry Point
 * 
 * v6.1 (2026-03-02) — ダッシュボードDB直結: ファイルアップロード不要でDB予定から即表示
 * Architecture: Hono (UI + proxy) → Python Generator (port 8787)
 */

import { Hono } from 'hono';
import { cors } from 'hono/cors';
import type { HonoEnv } from './types/index';
import jobRoutes from './routes/jobs';
import childRoutes from './routes/children';
import templateRoutes from './routes/templates';
import scheduleRoutes from './routes/schedules';
import lineRoutes from './routes/line';
import liffRoutes from './routes/liff';
import uploadRoutes from './routes/upload';
import generateRoutes from './routes/generate';

const app = new Hono<HonoEnv>();

// CORS — restrict origins; reject unknown origins
app.use('/api/*', cors({
  origin: (origin) => {
    // Allow same-origin requests (origin is null/empty for same-origin)
    if (!origin) return '*';
    // Allow Cloudflare Pages and local development
    if (origin.endsWith('.pages.dev') ||
        origin.includes('localhost') ||
        origin.includes('127.0.0.1') ||
        origin.includes('.sandbox.novita.ai') ||
        origin.includes('.genspark.ai') ||
        origin.includes('.line.me') ||
        origin.includes('.line-scdn.net')) {
      return origin;
    }
    // Reject unknown origins
    return '';
  },
  allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowHeaders: ['Content-Type', 'Authorization'],
  maxAge: 86400,
}));

// Favicon
app.get('/favicon.ico', (c) => new Response(null, { status: 204 }));

// Health check
app.get('/api/health', (c) => {
  return c.json({
    status: 'ok',
    version: '10.0',
    system: '滋賀医科大学学内保育所 あゆっこ 業務自動化システム',
    phase: 'Full TypeScript (No Python dependency)',
    timestamp: new Date().toISOString(),
  });
});

// Generator config: tell frontend where the Python Generator is
// In sandbox: same host, port 8787. In production: could be different.
app.get('/api/config', (c) => {
  // Build generator URL based on current request origin
  const url = new URL(c.req.url);
  // In sandbox, the generator runs on port 8787 of the same host
  // For external access via sandbox URL, replace port 3000 with 8787
  const host = url.hostname;
  const protocol = url.protocol;
  
  // If accessed via sandbox URL (*.sandbox.novita.ai), construct 8787 URL
  let generatorUrl = '';
  if (host.startsWith('3000-')) {
    // Replace 3000- prefix with 8787- and always use https for sandbox
    const genHost = host.replace(/^3000-/, '8787-');
    generatorUrl = `https://${genHost}`;
  } else if (host === 'localhost' || host === '127.0.0.1') {
    generatorUrl = `http://${host}:8787`;
  } else {
    // Fallback: proxy mode (use Hono proxy endpoints)
    generatorUrl = '';
  }
  
  return c.json({
    generator_url: generatorUrl,
    mode: generatorUrl ? 'direct' : 'proxy',
  });
});

// API Routes
app.route('/api/jobs', jobRoutes);
app.route('/api/children', childRoutes);
app.route('/api/templates', templateRoutes);
app.route('/api/schedules', scheduleRoutes);
app.route('/api/line', lineRoutes);
app.route('/api/liff', liffRoutes);
app.route('/api/upload', uploadRoutes);
app.route('/api/generate', generateRoutes);

// ═══════════════════════════════════════════
// LIFF Entry Point — LINE内ブラウザで開くページ
// リッチメニュー「予定入力」→ この URL がLIFFアプリのEndpoint
// ═══════════════════════════════════════════
app.get('/line/entry', (c) => {
  // LIFF_ID は環境変数から取得。未設定時は仮値（LINE Console設定後に差替）
  const liffId = (c.env as any).LIFF_ID || 'PENDING_LIFF_ID';
  return c.html(liffEntryPage(liffId));
});

// ═══════════════════════════════════════════
// Staff pages: 日次情報 & 園児登園確認表（印刷対応）
// ═══════════════════════════════════════════
app.get('/staff/daily/:year/:month/:day?', (c) => {
  const year = c.req.param('year') || '';
  const month = c.req.param('month') || '';
  const day = c.req.param('day') || '';
  if (!/^\d{4}$/.test(year) || !/^\d{1,2}$/.test(month)) {
    return c.text('Invalid date', 400);
  }
  return c.html(staffDailyPage(year, month, day));
});

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
          <p class="text-xs text-gray-500">業務自動化システム v9.5</p>
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
      <button onclick="switchTab('children')" id="tab-children" class="pb-2 text-sm tab-inactive">
        <i class="fas fa-child mr-1"></i>園児管理
      </button>
      <button onclick="switchTab('line-manage')" id="tab-line-manage" class="pb-2 text-sm tab-inactive">
        <i class="fab fa-line mr-1" style="color:#06C755"></i>LINE予定収集
      </button>
      <button onclick="switchTab('schedule-input')" id="tab-schedule-input" class="pb-2 text-sm tab-inactive">
        <i class="fas fa-edit mr-1"></i>予定入力
      </button>
      <button onclick="switchTab('upload')" id="tab-upload" class="pb-2 text-sm tab-inactive">
        <i class="fas fa-upload mr-1"></i>ファイル入力
      </button>
      <button onclick="switchTab('generate')" id="tab-generate" class="pb-2 text-sm tab-inactive">
        <i class="fas fa-file-archive mr-1"></i>提出物生成
      </button>
    </div>

    <!-- ═══════════════════════════════════════════ -->
    <!-- TAB 1: DASHBOARD (月間カレンダー)          -->
    <!-- ═══════════════════════════════════════════ -->
    <div id="panel-dashboard">

      <!-- ═══ MONTH SELECTOR (always visible) ═══ -->
      <div class="bg-white rounded-xl shadow-sm border border-gray-200 mb-4">
        <div class="px-5 py-4 flex flex-wrap items-end gap-3">
          <div>
            <label class="block text-xs font-medium text-gray-600 mb-1">年</label>
            <input type="number" id="dash-year" min="2024" max="2030" class="w-24 border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-blue-500">
          </div>
          <div>
            <label class="block text-xs font-medium text-gray-600 mb-1">月</label>
            <select id="dash-month" class="w-20 border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-blue-500">
              <option value="1">1月</option><option value="2">2月</option><option value="3">3月</option>
              <option value="4">4月</option><option value="5">5月</option><option value="6">6月</option>
              <option value="7">7月</option><option value="8">8月</option><option value="9">9月</option>
              <option value="10">10月</option><option value="11">11月</option><option value="12">12月</option>
            </select>
          </div>
          <button onclick="loadDashboardFromDB()" id="btn-dash-db" class="bg-blue-600 text-white px-5 py-2 rounded-lg text-sm font-medium hover:bg-blue-700 transition-colors">
            <i class="fas fa-calendar-alt mr-1"></i>予定を表示
          </button>
          <span class="text-xs text-gray-400 ml-1">
            <i class="fas fa-database mr-1"></i>登録済みの予定をDBから表示します
          </span>
        </div>
      </div>

      <!-- ═══ EMPTY STATE (before data loaded) ═══ -->
      <div id="dashboard-empty">
        <!-- Guide card -->
        <div class="bg-white rounded-xl shadow-sm border border-gray-200 mb-4">
          <div class="px-5 py-4">
            <h3 class="text-sm font-bold text-gray-800 mb-3 flex items-center gap-2">
              <span class="w-6 h-6 bg-blue-600 rounded-lg flex items-center justify-center">
                <i class="fas fa-info text-white text-xs"></i>
              </span>
              使い方ガイド
            </h3>
            <div class="grid grid-cols-1 md:grid-cols-3 gap-3 mb-4">
              <div class="bg-indigo-50 rounded-lg px-4 py-3 border border-indigo-100">
                <div class="text-xs font-bold text-indigo-800 mb-1"><i class="fas fa-child mr-1"></i>① 園児を登録</div>
                <div class="text-xs text-indigo-600 leading-relaxed">
                  「園児管理」タブで園児の名前・生年月日・利用区分を登録。
                </div>
              </div>
              <div class="bg-teal-50 rounded-lg px-4 py-3 border border-teal-100">
                <div class="text-xs font-bold text-teal-800 mb-1"><i class="fas fa-edit mr-1"></i>② 予定を入力</div>
                <div class="text-xs text-teal-600 leading-relaxed">
                  「予定入力」タブで各園児の登降園時間・食事フラグを入力。<br>
                  <span class="text-teal-500">（紙の予定表→画面で直接入力）</span>
                </div>
              </div>
              <div class="bg-blue-50 rounded-lg px-4 py-3 border border-blue-100">
                <div class="text-xs font-bold text-blue-800 mb-1"><i class="fas fa-calendar-alt mr-1"></i>③ ダッシュボードで確認</div>
                <div class="text-xs text-blue-600 leading-relaxed">
                  上の「予定を表示」で月間カレンダー表示。<br>
                  食数・早朝/延長/夜間を一覧確認。
                </div>
              </div>
            </div>
            <div class="grid grid-cols-1 md:grid-cols-2 gap-3">
              <div class="bg-green-50 rounded-lg px-4 py-3 border border-green-100">
                <div class="text-xs font-bold text-green-800 mb-1"><i class="fas fa-file-archive mr-1"></i>④ 提出物を一括生成</div>
                <div class="text-xs text-green-600 leading-relaxed">
                  月末に「提出物生成」タブで日報Excel / 保育料明細 / 保護者PDFをZIP出力。
                </div>
              </div>
              <div class="bg-amber-50 rounded-lg px-4 py-3 border border-amber-100">
                <div class="text-xs font-bold text-amber-800 mb-1"><i class="fas fa-upload mr-1"></i>ルクミー実績の反映</div>
                <div class="text-xs text-amber-600 leading-relaxed">
                  ルクミーの登降園実績がある場合は「ファイル入力」タブからアップロード。<br>
                  <span class="text-amber-500">予定 vs 実績の差分を確認できます。</span>
                </div>
              </div>
            </div>
            <!-- ZIP output explanation -->
            <details class="mt-3">
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

        <!-- Empty state message -->
        <div class="bg-white rounded-xl shadow-sm border border-gray-200 p-10 text-center">
          <div class="w-14 h-14 bg-blue-50 rounded-full flex items-center justify-center mx-auto mb-4">
            <i class="fas fa-calendar-alt text-blue-400 text-2xl"></i>
          </div>
          <h3 class="text-base font-semibold text-gray-700 mb-2">月間ダッシュボード</h3>
          <p class="text-sm text-gray-500 mb-4 max-w-md mx-auto">
            上の「予定を表示」ボタンで、登録済みの予定をカレンダー表示します。
          </p>
          <div class="flex flex-col sm:flex-row gap-3 justify-center">
            <button onclick="loadDashboardFromDB()" class="bg-blue-600 text-white px-6 py-2.5 rounded-lg text-sm font-medium hover:bg-blue-700 transition-colors">
              <i class="fas fa-calendar-alt mr-1"></i>予定を表示
            </button>
            <button onclick="switchTab('children')" class="bg-indigo-100 text-indigo-700 px-6 py-2.5 rounded-lg text-sm font-medium hover:bg-indigo-200 transition-colors">
              <i class="fas fa-child mr-1"></i>園児を登録する
            </button>
            <button onclick="switchTab('schedule-input')" class="bg-teal-100 text-teal-700 px-6 py-2.5 rounded-lg text-sm font-medium hover:bg-teal-200 transition-colors">
              <i class="fas fa-edit mr-1"></i>予定を入力する
            </button>
          </div>
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
              <span>🍪朝おやつ</span>
              <span>🍪午後おやつ</span>
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
    <!-- TAB: CHILDREN (園児管理)                    -->
    <!-- ═══════════════════════════════════════════ -->
    <div id="panel-children" class="hidden">
      <div class="bg-white rounded-xl shadow-sm border border-gray-200 mb-4">
        <div class="px-5 py-4 border-b border-gray-100 flex items-center justify-between">
          <h2 class="text-base font-semibold text-gray-800 flex items-center gap-2">
            <span class="w-7 h-7 bg-indigo-600 text-white rounded-full flex items-center justify-center text-sm"><i class="fas fa-child"></i></span>
            園児マスタ管理
          </h2>
          <button onclick="openChildForm()" class="bg-indigo-600 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-indigo-700 transition-colors">
            <i class="fas fa-plus mr-1"></i>園児を追加
          </button>
        </div>
        <div class="p-4">
          <p class="text-xs text-gray-500 mb-3">
            <i class="fas fa-info-circle mr-1 text-blue-400"></i>
            園児の名前・生年月日・利用区分を登録すると、年齢クラスが自動計算されます。予定入力やダッシュボードで利用されます。
          </p>
          <!-- Children Table -->
          <div class="overflow-x-auto">
            <table class="w-full text-sm">
              <thead>
                <tr class="bg-gray-50 text-gray-600">
                  <th class="px-3 py-2 text-left font-medium">名前</th>
                  <th class="px-3 py-2 text-left font-medium">フリガナ</th>
                  <th class="px-3 py-2 text-center font-medium">生年月日</th>
                  <th class="px-3 py-2 text-center font-medium">クラス</th>
                  <th class="px-3 py-2 text-center font-medium">利用区分</th>
                  <th class="px-3 py-2 text-center font-medium">第○子</th>
                  <th class="px-3 py-2 text-center font-medium">アレルギー</th>
                  <th class="px-3 py-2 text-center font-medium">ルクミーID</th>
                  <th class="px-3 py-2 text-center font-medium">操作</th>
                </tr>
              </thead>
              <tbody id="children-table-body">
                <tr><td colspan="9" class="text-center py-8 text-gray-400"><i class="fas fa-spinner fa-spin mr-1"></i>読み込み中...</td></tr>
              </tbody>
            </table>
          </div>
          <div id="children-count" class="mt-3 text-xs text-gray-400 text-right"></div>
        </div>
      </div>

      <!-- ═══ CHILD ADD/EDIT MODAL ═══ -->
      <div id="child-modal" class="fixed inset-0 bg-black/40 z-50 hidden flex items-center justify-center">
        <div class="bg-white rounded-xl shadow-xl w-full max-w-lg mx-4 overflow-hidden">
          <div class="px-5 py-4 border-b border-gray-200 flex items-center justify-between">
            <h3 id="child-modal-title" class="text-base font-semibold text-gray-800">園児を追加</h3>
            <button onclick="closeChildForm()" class="text-gray-400 hover:text-gray-600"><i class="fas fa-times"></i></button>
          </div>
          <form id="child-form" onsubmit="saveChild(event)" class="px-5 py-4 space-y-3">
            <input type="hidden" id="child-edit-id" value="">
            <div class="grid grid-cols-2 gap-3">
              <div>
                <label class="block text-xs font-medium text-gray-600 mb-1">名前 <span class="text-red-400">*</span></label>
                <input type="text" id="child-name" required class="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500" placeholder="例：山田 太郎">
              </div>
              <div>
                <label class="block text-xs font-medium text-gray-600 mb-1">フリガナ</label>
                <input type="text" id="child-name-kana" class="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500" placeholder="例：ヤマダ タロウ">
              </div>
            </div>
            <div class="grid grid-cols-2 gap-3">
              <div>
                <label class="block text-xs font-medium text-gray-600 mb-1">生年月日</label>
                <input type="date" id="child-birth-date" class="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500">
              </div>
              <div>
                <label class="block text-xs font-medium text-gray-600 mb-1">利用区分 <span class="text-red-400">*</span></label>
                <select id="child-enrollment" class="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500">
                  <option value="月極">月極</option>
                  <option value="一時">一時</option>
                </select>
              </div>
            </div>
            <div class="grid grid-cols-3 gap-3">
              <div>
                <label class="block text-xs font-medium text-gray-600 mb-1">第○子</label>
                <input type="number" id="child-order" min="1" max="10" value="1" class="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500">
              </div>
              <div>
                <label class="block text-xs font-medium text-gray-600 mb-1">ルクミーID</label>
                <input type="text" id="child-lukumi-id" class="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500" placeholder="自動突合用">
              </div>
              <div class="flex items-end pb-1">
                <label class="flex items-center gap-2 text-sm text-gray-700 cursor-pointer">
                  <input type="checkbox" id="child-allergy" class="w-4 h-4 text-indigo-600 rounded">
                  アレルギー食
                </label>
              </div>
            </div>
            <div class="flex justify-end gap-2 pt-2 border-t border-gray-100">
              <button type="button" onclick="closeChildForm()" class="px-4 py-2 text-sm text-gray-600 bg-gray-100 rounded-lg hover:bg-gray-200">キャンセル</button>
              <button type="submit" class="px-4 py-2 text-sm text-white bg-indigo-600 rounded-lg hover:bg-indigo-700 font-medium">
                <i class="fas fa-save mr-1"></i><span id="child-save-label">保存</span>
              </button>
            </div>
          </form>
        </div>
      </div>
    </div>

    <!-- ═══════════════════════════════════════════ -->
    <!-- TAB: LINE予定収集                           -->
    <!-- ═══════════════════════════════════════════ -->
    <div id="panel-line-manage" class="hidden">

      <!-- LINE友だち追加セクション -->
      <div class="bg-white rounded-xl shadow-sm border border-gray-200 mb-4">
        <div class="px-5 py-4 border-b border-gray-100">
          <h2 class="text-base font-semibold text-gray-800 flex items-center gap-2">
            <span class="w-7 h-7 rounded-full flex items-center justify-center text-sm" style="background:#06C755">
              <i class="fab fa-line text-white"></i>
            </span>
            LINE予定収集 — 保護者にLINEで予定を提出してもらう
          </h2>
        </div>
        <div class="p-5">
          <!-- Step説明 -->
          <div class="grid grid-cols-1 md:grid-cols-3 gap-4 mb-6">
            <div class="bg-green-50 rounded-lg px-4 py-3 border border-green-200">
              <div class="text-xs font-bold text-green-800 mb-1">
                <span class="inline-flex items-center justify-center w-5 h-5 rounded-full bg-green-600 text-white text-[10px] mr-1">1</span>
                保護者にLINE友だち追加してもらう
              </div>
              <div class="text-xs text-green-600">下のQRコード or リンクを保護者へ共有</div>
            </div>
            <div class="bg-blue-50 rounded-lg px-4 py-3 border border-blue-200">
              <div class="text-xs font-bold text-blue-800 mb-1">
                <span class="inline-flex items-center justify-center w-5 h-5 rounded-full bg-blue-600 text-white text-[10px] mr-1">2</span>
                連携コードを渡す
              </div>
              <div class="text-xs text-blue-600">園児ごとに発行したコードを保護者へ通知</div>
            </div>
            <div class="bg-purple-50 rounded-lg px-4 py-3 border border-purple-200">
              <div class="text-xs font-bold text-purple-800 mb-1">
                <span class="inline-flex items-center justify-center w-5 h-5 rounded-full bg-purple-600 text-white text-[10px] mr-1">3</span>
                保護者がLINEで予定入力
              </div>
              <div class="text-xs text-purple-600">「予定入力」→月→日時→確定で自動保存</div>
            </div>
          </div>

          <!-- QRコード & リンク -->
          <div class="bg-gray-50 rounded-xl p-5 border border-gray-200 mb-6">
            <h3 class="text-sm font-bold text-gray-800 mb-3">
              <i class="fab fa-line mr-1" style="color:#06C755"></i>友だち追加リンク（保護者に共有）
            </h3>
            <div class="flex flex-col md:flex-row items-center gap-6">
              <div class="text-center">
                <img src="https://qr-official.line.me/gs/M_591xcqds_GW.png" alt="LINE QRコード" class="w-36 h-36 rounded-lg border border-gray-200 shadow-sm">
                <p class="text-xs text-gray-500 mt-2">QRコードで友だち追加</p>
              </div>
              <div class="flex-1">
                <div class="mb-3">
                  <label class="text-xs text-gray-600 font-medium">友だち追加URL:</label>
                  <div class="flex items-center gap-2 mt-1">
                    <input type="text" value="https://lin.ee/H02sZM5" readonly
                           class="flex-1 bg-white border border-gray-300 rounded-lg px-3 py-2 text-sm text-gray-700 font-mono" id="line-add-url">
                    <button onclick="copyToClipboard('line-add-url')" class="bg-gray-200 text-gray-700 px-3 py-2 rounded-lg text-sm hover:bg-gray-300">
                      <i class="fas fa-copy"></i>
                    </button>
                  </div>
                </div>
                <div class="bg-yellow-50 rounded-lg px-3 py-2 border border-yellow-200 text-xs text-yellow-700">
                  <i class="fas fa-info-circle mr-1"></i>
                  保護者に友だち追加してもらった後、連携コードを入力してもらいます。
                  コードは下の「連携コード管理」から発行できます。
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      <!-- 月次提出状況 -->
      <div class="bg-white rounded-xl shadow-sm border border-gray-200 mb-4">
        <div class="px-5 py-4 border-b border-gray-100 flex items-center justify-between">
          <h3 class="text-sm font-semibold text-gray-800 flex items-center gap-2">
            <i class="fas fa-clipboard-check text-blue-500"></i>
            月次予定 提出状況
          </h3>
          <div class="flex items-center gap-2">
            <select id="line-status-year" class="border border-gray-300 rounded-lg px-2 py-1 text-xs">
            </select>
            <select id="line-status-month" class="border border-gray-300 rounded-lg px-2 py-1 text-xs">
              <option value="1">1月</option><option value="2">2月</option><option value="3">3月</option>
              <option value="4">4月</option><option value="5">5月</option><option value="6">6月</option>
              <option value="7">7月</option><option value="8">8月</option><option value="9">9月</option>
              <option value="10">10月</option><option value="11">11月</option><option value="12">12月</option>
            </select>
            <button onclick="loadSubmissionStatus()" class="bg-blue-600 text-white px-3 py-1 rounded-lg text-xs hover:bg-blue-700">
              <i class="fas fa-sync-alt mr-1"></i>更新
            </button>
          </div>
        </div>
        <div class="p-4">
          <!-- サマリーバー -->
          <div id="submission-summary" class="flex gap-3 mb-4">
            <div class="bg-gray-100 rounded-lg px-4 py-2 text-center flex-1">
              <div class="text-lg font-bold text-gray-800" id="stat-total">-</div>
              <div class="text-[10px] text-gray-500">園児数</div>
            </div>
            <div class="bg-green-50 rounded-lg px-4 py-2 text-center flex-1 border border-green-200">
              <div class="text-lg font-bold text-green-700" id="stat-linked">-</div>
              <div class="text-[10px] text-green-600">LINE連携済</div>
            </div>
            <div class="bg-blue-50 rounded-lg px-4 py-2 text-center flex-1 border border-blue-200">
              <div class="text-lg font-bold text-blue-700" id="stat-submitted">-</div>
              <div class="text-[10px] text-blue-600">提出済</div>
            </div>
            <div class="bg-red-50 rounded-lg px-4 py-2 text-center flex-1 border border-red-200">
              <div class="text-lg font-bold text-red-600" id="stat-not-submitted">-</div>
              <div class="text-[10px] text-red-500">未提出</div>
            </div>
          </div>
          <!-- テーブル -->
          <div class="overflow-x-auto">
            <table class="w-full text-sm">
              <thead>
                <tr class="bg-gray-50 text-gray-600">
                  <th class="px-3 py-2 text-left font-medium">園児名</th>
                  <th class="px-3 py-2 text-center font-medium">区分</th>
                  <th class="px-3 py-2 text-center font-medium">LINE連携</th>
                  <th class="px-3 py-2 text-center font-medium">LINE名</th>
                  <th class="px-3 py-2 text-center font-medium">提出状況</th>
                  <th class="px-3 py-2 text-center font-medium">提出日数</th>
                  <th class="px-3 py-2 text-center font-medium">連携コード</th>
                  <th class="px-3 py-2 text-center font-medium">カレンダー</th>
                </tr>
              </thead>
              <tbody id="submission-table-body">
                <tr><td colspan="8" class="text-center py-8 text-gray-400">「更新」をクリックして読み込み</td></tr>
              </tbody>
            </table>
          </div>
        </div>
      </div>

      <!-- 連携コード管理 -->
      <div class="bg-white rounded-xl shadow-sm border border-gray-200 mb-4">
        <div class="px-5 py-4 border-b border-gray-100 flex items-center justify-between">
          <h3 class="text-sm font-semibold text-gray-800 flex items-center gap-2">
            <i class="fas fa-key text-amber-500"></i>
            連携コード管理
          </h3>
          <button onclick="openLinkCodeModal()" class="bg-amber-500 text-white px-4 py-1.5 rounded-lg text-xs font-medium hover:bg-amber-600">
            <i class="fas fa-plus mr-1"></i>新しいコードを発行
          </button>
        </div>
        <div class="p-4">
          <p class="text-xs text-gray-500 mb-3">
            <i class="fas fa-info-circle text-blue-400 mr-1"></i>
            コード発行時に対象園児を選択してください。保護者がLINE内でコードを入力すると、選択した園児のみ紐づきます。
          </p>
          <div class="overflow-x-auto">
            <table class="w-full text-sm">
              <thead>
                <tr class="bg-gray-50 text-gray-600">
                  <th class="px-3 py-2 text-left font-medium">コード</th>
                  <th class="px-3 py-2 text-left font-medium">対象園児</th>
                  <th class="px-3 py-2 text-center font-medium">使用状況</th>
                  <th class="px-3 py-2 text-center font-medium">使用者</th>
                  <th class="px-3 py-2 text-center font-medium">有効期限</th>
                </tr>
              </thead>
              <tbody id="link-codes-table-body">
                <tr><td colspan="5" class="text-center py-6 text-gray-400"><i class="fas fa-spinner fa-spin mr-1"></i>読み込み中...</td></tr>
              </tbody>
            </table>
          </div>
        </div>
      </div>

      <!-- 連携コード発行モーダル -->
      <div id="link-code-modal" class="fixed inset-0 bg-black/40 z-50 hidden flex items-center justify-center" onclick="if(event.target===this)closeLinkCodeModal()">
        <div class="bg-white rounded-2xl w-full max-w-md mx-4 shadow-2xl" onclick="event.stopPropagation()">
          <div class="px-5 py-4 border-b border-gray-200 flex items-center justify-between">
            <h3 class="text-sm font-bold text-gray-800"><i class="fas fa-key text-amber-500 mr-2"></i>連携コード発行</h3>
            <button onclick="closeLinkCodeModal()" class="text-gray-400 hover:text-gray-600"><i class="fas fa-times"></i></button>
          </div>
          <div class="p-5">
            <p class="text-xs text-gray-600 mb-3">対象園児を選択してください（複数選択可 = 兄弟対応）</p>
            <div class="mb-3 flex gap-2">
              <input type="text" id="child-search-input" placeholder="園児名で検索..." class="flex-1 border border-gray-300 rounded-lg px-3 py-1.5 text-xs" oninput="filterChildCheckboxes()">
              <button onclick="toggleAllChildren(true)" class="text-[10px] text-blue-600 hover:underline">全選択</button>
              <button onclick="toggleAllChildren(false)" class="text-[10px] text-gray-500 hover:underline">全解除</button>
            </div>
            <div id="child-checkboxes" class="max-h-60 overflow-y-auto border border-gray-200 rounded-lg divide-y divide-gray-100">
              <div class="p-4 text-center text-gray-400 text-xs">読み込み中...</div>
            </div>
            <div class="mt-4 flex gap-2">
              <button onclick="closeLinkCodeModal()" class="flex-1 bg-gray-100 text-gray-600 py-2.5 rounded-xl text-sm font-medium">キャンセル</button>
              <button onclick="generateLinkCode()" id="gen-code-btn" class="flex-1 bg-amber-500 text-white py-2.5 rounded-xl text-sm font-medium hover:bg-amber-600">
                <i class="fas fa-key mr-1"></i>コード発行
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- ═══════════════════════════════════════════ -->
    <!-- TAB: SCHEDULE INPUT (予定入力)              -->
    <!-- ═══════════════════════════════════════════ -->
    <div id="panel-schedule-input" class="hidden">
      <div class="bg-white rounded-xl shadow-sm border border-gray-200 mb-4">
        <div class="px-5 py-4 border-b border-gray-100">
          <h2 class="text-base font-semibold text-gray-800 flex items-center gap-2">
            <span class="w-7 h-7 bg-teal-600 text-white rounded-full flex items-center justify-center text-sm"><i class="fas fa-edit"></i></span>
            予定入力（画面入力モード）
          </h2>
          <p class="text-xs text-gray-500 mt-1">
            <i class="fas fa-info-circle mr-1 text-blue-400"></i>
            Excelの利用予定表ファイルがない場合、ここで直接入力できます。園児を選択して月のカレンダーで予定を入力してください。
          </p>
        </div>
        <div class="p-4">
          <!-- Month selector + Child selector -->
          <div class="flex flex-wrap items-end gap-3 mb-4">
            <div>
              <label class="block text-xs font-medium text-gray-600 mb-1">年</label>
              <input type="number" id="sched-year" min="2024" max="2030" class="w-24 border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-teal-500">
            </div>
            <div>
              <label class="block text-xs font-medium text-gray-600 mb-1">月</label>
              <select id="sched-month" class="w-20 border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-teal-500">
                <option value="1">1月</option><option value="2">2月</option><option value="3">3月</option>
                <option value="4">4月</option><option value="5">5月</option><option value="6">6月</option>
                <option value="7">7月</option><option value="8">8月</option><option value="9">9月</option>
                <option value="10">10月</option><option value="11">11月</option><option value="12">12月</option>
              </select>
            </div>
            <div class="flex-1 min-w-[200px]">
              <label class="block text-xs font-medium text-gray-600 mb-1">園児を選択</label>
              <select id="sched-child" class="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-teal-500">
                <option value="">-- 園児を選択 --</option>
              </select>
            </div>
            <button onclick="loadScheduleGrid()" class="bg-teal-600 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-teal-700 transition-colors">
              <i class="fas fa-calendar-alt mr-1"></i>表示
            </button>
          </div>

          <!-- Schedule Grid -->
          <div id="schedule-grid-container" class="hidden">
            <div class="flex items-center justify-between mb-3">
              <h3 id="schedule-grid-title" class="text-sm font-bold text-gray-700"></h3>
              <div class="flex gap-2">
                <button onclick="applyDefaultTimes()" class="text-xs bg-gray-100 text-gray-600 px-3 py-1.5 rounded-lg hover:bg-gray-200 transition-colors" title="月極のデフォルト時間を全日に一括入力">
                  <i class="fas fa-magic mr-1"></i>デフォルト一括入力
                </button>
                <button onclick="saveSchedule()" class="bg-teal-600 text-white px-4 py-1.5 rounded-lg text-sm font-medium hover:bg-teal-700 transition-colors">
                  <i class="fas fa-save mr-1"></i>保存
                </button>
              </div>
            </div>

            <!-- Default times row -->
            <div id="schedule-defaults" class="bg-teal-50 rounded-lg px-4 py-3 mb-3 border border-teal-200">
              <div class="text-xs font-medium text-teal-700 mb-2"><i class="fas fa-clock mr-1"></i>デフォルト時間（一括入力用）</div>
              <div class="flex flex-wrap gap-3 items-center">
                <div class="flex items-center gap-1">
                  <label class="text-xs text-gray-600">登園:</label>
                  <input type="time" id="sched-default-start" value="08:30" class="border border-gray-300 rounded px-2 py-1 text-xs">
                </div>
                <div class="flex items-center gap-1">
                  <label class="text-xs text-gray-600">降園:</label>
                  <input type="time" id="sched-default-end" value="17:30" class="border border-gray-300 rounded px-2 py-1 text-xs">
                </div>
                <label class="flex items-center gap-1 text-xs text-gray-600 cursor-pointer">
                  <input type="checkbox" id="sched-default-lunch" checked class="w-3.5 h-3.5 text-teal-600 rounded"> 昼食
                </label>
                <label class="flex items-center gap-1 text-xs text-gray-600 cursor-pointer">
                  <input type="checkbox" id="sched-default-pm-snack" checked class="w-3.5 h-3.5 text-teal-600 rounded"> 午後おやつ
                </label>
                <label class="flex items-center gap-1 text-xs text-gray-600 cursor-pointer">
                  <input type="checkbox" id="sched-default-am-snack" class="w-3.5 h-3.5 text-teal-600 rounded"> 朝おやつ
                </label>
                <label class="flex items-center gap-1 text-xs text-gray-600 cursor-pointer">
                  <input type="checkbox" id="sched-default-dinner" class="w-3.5 h-3.5 text-teal-600 rounded"> 夕食
                </label>
              </div>
            </div>

            <!-- Calendar grid -->
            <div class="overflow-x-auto">
              <table class="w-full text-xs border-collapse" id="schedule-table">
                <thead>
                  <tr class="bg-gray-50">
                    <th class="px-2 py-2 text-center font-medium text-gray-600 w-12 border">日</th>
                    <th class="px-2 py-2 text-center font-medium text-gray-600 w-10 border">曜日</th>
                    <th class="px-2 py-2 text-center font-medium text-gray-600 border">登園</th>
                    <th class="px-2 py-2 text-center font-medium text-gray-600 border">降園</th>
                    <th class="px-2 py-2 text-center font-medium text-gray-600 w-10 border">昼食</th>
                    <th class="px-2 py-2 text-center font-medium text-gray-600 w-10 border">朝お</th>
                    <th class="px-2 py-2 text-center font-medium text-gray-600 w-10 border">午お</th>
                    <th class="px-2 py-2 text-center font-medium text-gray-600 w-10 border">夕食</th>
                    <th class="px-2 py-2 text-center font-medium text-gray-600 w-10 border">休</th>
                  </tr>
                </thead>
                <tbody id="schedule-table-body">
                </tbody>
              </table>
            </div>
            <div id="schedule-save-status" class="mt-3 text-xs text-gray-400"></div>
          </div>

          <!-- Empty state -->
          <div id="schedule-empty" class="text-center py-10 text-gray-400">
            <i class="fas fa-calendar-plus text-3xl mb-3 text-gray-300"></i>
            <p class="text-sm">年月と園児を選択して「表示」をクリックしてください</p>
          </div>
        </div>
      </div>
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

          <!-- ═══ SECTION C: テンプレート（初回登録） ═══ -->
          <div class="mb-4">
            <div class="flex items-center gap-2 mb-3">
              <h3 class="text-sm font-semibold text-gray-700 flex items-center gap-2">
                <span class="w-5 h-5 bg-amber-500 rounded flex items-center justify-center">
                  <i class="fas fa-star text-white text-[10px]"></i>
                </span>
                初回のみ：提出物テンプレート
              </h3>
              <span class="text-xs text-amber-600 bg-amber-50 px-2 py-0.5 rounded-full border border-amber-200">初回だけ登録</span>
            </div>

            <!-- 説明カード: これは何？ -->
            <div class="bg-amber-50 rounded-xl p-4 border border-amber-200 mb-4">
              <div class="flex items-start gap-3">
                <div class="w-8 h-8 bg-amber-100 rounded-lg flex items-center justify-center flex-shrink-0 mt-0.5">
                  <i class="fas fa-question-circle text-amber-600"></i>
                </div>
                <div class="text-xs text-amber-800 leading-relaxed">
                  <p class="font-bold mb-1">日報テンプレとは？</p>
                  <p>今まで使っている「<strong>日報202601.xlsx</strong>」をそのまま型として使い、<br>
                  園児登園確認表・児童実績表申請・◆保育時間などを<strong>自動入力した完成版</strong>を作ります。</p>
                  <p class="mt-1.5"><strong>大学提出を日報Excelで行う場合に必要です（初回だけ）。</strong></p>
                  <p class="text-amber-600 mt-1.5">※ダッシュボード表示だけなら不要です。提出物ZIPに含める場合のみ使います。</p>
                </div>
              </div>
            </div>

            <!-- 登録状態バー -->
            <div id="template-status-bar" class="mb-3 flex flex-wrap gap-2">
              <!-- populated by JS: shows ✅登録済み or ⚠️未登録 per template -->
            </div>

            <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label class="text-sm font-medium text-gray-700 mb-2 block">
                  <i class="fas fa-file-alt text-emerald-600 mr-1"></i>日報テンプレート
                  <span class="text-xs text-amber-600 ml-1" id="daily-template-status-label">(未登録)</span>
                </label>
                <p class="text-[10px] text-gray-500 mb-1.5">提出物に日報Excel (01_園内管理) を含める場合に必要</p>
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
                  <span class="text-xs text-amber-600 ml-1" id="billing-template-status-label">(未登録)</span>
                </label>
                <p class="text-[10px] text-gray-500 mb-1.5">提出物に保育料明細 (02_経理提出) を含める場合に必要</p>
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
          </div>

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

      <!-- Empty state / Quick Generate -->
      <div id="generate-empty" class="bg-white rounded-xl shadow-sm border border-gray-200">
        <div class="px-5 py-4 border-b border-gray-100">
          <h3 class="text-base font-semibold text-gray-800 flex items-center gap-2">
            <span class="w-7 h-7 bg-green-600 text-white rounded-full flex items-center justify-center text-sm"><i class="fas fa-bolt"></i></span>
            Excel帳票生成（DB直結）
          </h3>
          <p class="text-xs text-gray-500 mt-1">
            <i class="fas fa-info-circle text-blue-400 mr-1"></i>
            DBに保存済みの予定・出席データから、請求明細Excel・日報Excelを一括生成します。
          </p>
        </div>
        <div class="p-5">
          <div class="flex flex-wrap items-end gap-3 mb-5">
            <div>
              <label class="block text-xs font-medium text-gray-600 mb-1">年</label>
              <input type="number" id="gen-year" min="2024" max="2030" class="w-24 border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-green-500">
            </div>
            <div>
              <label class="block text-xs font-medium text-gray-600 mb-1">月</label>
              <select id="gen-month" class="w-20 border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-green-500">
                <option value="1">1月</option><option value="2">2月</option><option value="3">3月</option>
                <option value="4">4月</option><option value="5">5月</option><option value="6">6月</option>
                <option value="7">7月</option><option value="8">8月</option><option value="9">9月</option>
                <option value="10">10月</option><option value="11">11月</option><option value="12">12月</option>
              </select>
            </div>
            <button onclick="generateAll()" id="btn-generate-all" class="bg-green-600 text-white px-5 py-2 rounded-lg text-sm font-medium hover:bg-green-700 transition-colors">
              <i class="fas fa-cogs mr-1"></i>計算＆帳票生成
            </button>
            <button onclick="downloadBilling()" class="bg-purple-600 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-purple-700 transition-colors">
              <i class="fas fa-file-invoice-dollar mr-1"></i>請求明細のみ
            </button>
            <button onclick="downloadDaily()" class="bg-blue-600 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-blue-700 transition-colors">
              <i class="fas fa-clipboard-list mr-1"></i>日報のみ
            </button>
          </div>
          <div id="gen-result" class="hidden">
            <div id="gen-result-content" class="bg-green-50 rounded-lg p-4 border border-green-200 text-sm"></div>
          </div>
          <div id="gen-error" class="hidden bg-red-50 rounded-lg p-4 border border-red-200 text-sm text-red-700"></div>
        </div>
      </div>

      <!-- CSV Import Section -->
      <div class="bg-white rounded-xl shadow-sm border border-gray-200 mt-4">
        <div class="px-5 py-4 border-b border-gray-100">
          <h3 class="text-base font-semibold text-gray-800 flex items-center gap-2">
            <span class="w-7 h-7 bg-orange-500 text-white rounded-full flex items-center justify-center text-sm"><i class="fas fa-file-csv"></i></span>
            園児CSVインポート
          </h3>
          <p class="text-xs text-gray-500 mt-1">
            <i class="fas fa-info-circle text-blue-400 mr-1"></i>
            ルクミーCSVをインポートして園児マスタを一括更新します。クラス名から「一時預かり」/「月極」を自動判定し、生年月日から年齢クラスを算出します。
          </p>
        </div>
        <div class="p-5">
          <div class="flex items-end gap-3">
            <div class="flex-1">
              <label class="block text-xs font-medium text-gray-600 mb-1">CSVファイル</label>
              <input type="file" id="csv-import-file" accept=".csv" class="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm">
            </div>
            <button onclick="importChildrenCsv()" class="bg-orange-500 text-white px-5 py-2 rounded-lg text-sm font-medium hover:bg-orange-600 transition-colors">
              <i class="fas fa-upload mr-1"></i>インポート
            </button>
          </div>
          <div id="csv-import-result" class="hidden mt-3"></div>
        </div>
      </div>

      <!-- File Import Section (ルクミー＋予定表→DB保存) -->
      <div class="bg-white rounded-xl shadow-sm border border-gray-200 mt-4">
        <div class="px-5 py-4 border-b border-gray-100">
          <h3 class="text-base font-semibold text-gray-800 flex items-center gap-2">
            <span class="w-7 h-7 bg-indigo-600 text-white rounded-full flex items-center justify-center text-sm"><i class="fas fa-database"></i></span>
            ファイル→DB取込
          </h3>
          <p class="text-xs text-gray-500 mt-1">
            <i class="fas fa-info-circle text-blue-400 mr-1"></i>
            ルクミー登降園データ・利用予定表Excelをアップロードして、DBに出席・予定データを保存します。
          </p>
        </div>
        <div class="p-5">
          <div class="flex flex-wrap items-end gap-3 mb-3">
            <div>
              <label class="block text-xs font-medium text-gray-600 mb-1">年</label>
              <input type="number" id="import-year" min="2024" max="2030" class="w-24 border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-indigo-500">
            </div>
            <div>
              <label class="block text-xs font-medium text-gray-600 mb-1">月</label>
              <select id="import-month" class="w-20 border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-indigo-500">
                <option value="1">1月</option><option value="2">2月</option><option value="3">3月</option>
                <option value="4">4月</option><option value="5">5月</option><option value="6">6月</option>
                <option value="7">7月</option><option value="8">8月</option><option value="9">9月</option>
                <option value="10">10月</option><option value="11">11月</option><option value="12">12月</option>
              </select>
            </div>
          </div>
          <div class="grid grid-cols-1 md:grid-cols-2 gap-3 mb-3">
            <div>
              <label class="block text-xs font-medium text-gray-600 mb-1">ルクミー登降園データ（任意）</label>
              <input type="file" id="import-lukumi" accept=".csv,.xlsx,.xls" class="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm">
            </div>
            <div>
              <label class="block text-xs font-medium text-gray-600 mb-1">利用予定表Excel（任意・複数可）</label>
              <input type="file" id="import-schedules" accept=".xlsx,.xls" multiple class="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm">
            </div>
          </div>
          <button onclick="importFilesToDb()" class="bg-indigo-600 text-white px-5 py-2 rounded-lg text-sm font-medium hover:bg-indigo-700 transition-colors">
            <i class="fas fa-database mr-1"></i>DBに取込
          </button>
          <div id="import-result" class="hidden mt-3"></div>
        </div>
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
  <script src="/static/app.js?v=${Date.now()}"></script>
</body>
</html>`;
}

app.get('/', (c) => {
  return c.html(mainPage());
});

// ═══════════════════════════════════════════
// LIFF Entry Page — LINE内ブラウザ起動ページ
// ═══════════════════════════════════════════
function liffEntryPage(liffId: string): string {
  return `<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>あゆっこ 予定入力</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <link href="https://cdn.jsdelivr.net/npm/@fortawesome/fontawesome-free@6.4.0/css/all.min.css" rel="stylesheet">
  <script charset="utf-8" src="https://static.line-scdn.net/liff/edge/2/sdk.js"></script>
  <style>
    .fade-in { animation: fadeIn 0.4s ease-out; }
    @keyframes fadeIn { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: translateY(0); } }
    .pulse { animation: pulse 1.5s infinite; }
    @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.5; } }
  </style>
</head>
<body class="bg-gradient-to-b from-green-50 to-white min-h-screen flex flex-col">

  <!-- Header -->
  <header class="bg-white border-b border-gray-200 shadow-sm">
    <div class="max-w-lg mx-auto px-4 py-3 flex items-center gap-3">
      <div class="w-9 h-9 rounded-xl flex items-center justify-center text-white text-sm" style="background:#06C755">
        <i class="fab fa-line"></i>
      </div>
      <div>
        <h1 class="text-sm font-bold text-gray-800">あゆっこ 利用予定入力</h1>
        <p class="text-[10px] text-gray-500">滋賀医科大学学内保育所</p>
      </div>
    </div>
  </header>

  <main class="flex-1 max-w-lg mx-auto w-full px-4 py-6">
    <!-- Loading state -->
    <div id="state-loading" class="text-center py-16">
      <div class="w-16 h-16 mx-auto mb-4 rounded-full flex items-center justify-center" style="background:#06C755">
        <i class="fab fa-line text-white text-2xl pulse"></i>
      </div>
      <p class="text-sm text-gray-600 font-medium">LINE連携を確認中...</p>
      <p class="text-xs text-gray-400 mt-1">少々お待ちください</p>
    </div>

    <!-- Not in LINE browser -->
    <div id="state-not-line" class="hidden fade-in">
      <div class="bg-white rounded-2xl shadow-sm border border-gray-200 p-6 text-center">
        <div class="w-14 h-14 mx-auto mb-4 rounded-full bg-yellow-100 flex items-center justify-center">
          <i class="fas fa-mobile-alt text-yellow-600 text-xl"></i>
        </div>
        <h2 class="text-base font-bold text-gray-800 mb-2">LINEアプリから開いてください</h2>
        <p class="text-sm text-gray-600 mb-4">
          この画面はLINEのリッチメニューから開く必要があります。
        </p>
        <div class="bg-gray-50 rounded-xl p-4 border border-gray-200">
          <p class="text-xs text-gray-500 mb-2">あゆっこLINE公式アカウント</p>
          <img src="https://qr-official.line.me/gs/M_591xcqds_GW.png" alt="QRコード" class="w-32 h-32 mx-auto rounded-lg border border-gray-200">
          <a href="https://lin.ee/H02sZM5" class="block mt-3 text-sm font-medium" style="color:#06C755">
            <i class="fab fa-line mr-1"></i>友だち追加はこちら
          </a>
        </div>
      </div>
    </div>

    <!-- Link form (not linked yet) -->
    <div id="state-link" class="hidden fade-in">
      <div class="bg-white rounded-2xl shadow-sm border border-gray-200 p-6">
        <div class="text-center mb-5">
          <div class="w-14 h-14 mx-auto mb-3 rounded-full bg-blue-100 flex items-center justify-center">
            <i class="fas fa-link text-blue-600 text-xl"></i>
          </div>
          <h2 class="text-base font-bold text-gray-800 mb-1">初回連携</h2>
          <p class="text-sm text-gray-600">
            園から受け取った連携コードを入力してください
          </p>
        </div>

        <div class="mb-4">
          <label class="text-xs text-gray-600 font-medium mb-1 block">連携コード</label>
          <input type="text" id="link-code-input" placeholder="AYK-1234"
                 class="w-full border-2 border-gray-200 rounded-xl px-4 py-3 text-center text-lg font-mono font-bold tracking-widest
                        focus:border-blue-500 focus:outline-none uppercase"
                 maxlength="8" autocomplete="off" inputmode="text">
          <p id="link-error" class="hidden text-xs text-red-500 mt-2 text-center"></p>
        </div>

        <button onclick="submitLinkCode()" id="link-btn"
                class="w-full py-3 rounded-xl text-white font-medium text-sm"
                style="background:#06C755">
          <i class="fas fa-check mr-1"></i>連携する
        </button>

        <p class="text-[10px] text-gray-400 text-center mt-3">
          連携コードがわからない場合は園の職員にお問い合わせください
        </p>
      </div>
    </div>

    <!-- Child selector (multiple children) -->
    <div id="state-select" class="hidden fade-in">
      <div class="bg-white rounded-2xl shadow-sm border border-gray-200 p-6">
        <div class="text-center mb-5">
          <div class="w-14 h-14 mx-auto mb-3 rounded-full bg-green-100 flex items-center justify-center">
            <i class="fas fa-child text-green-600 text-xl"></i>
          </div>
          <h2 class="text-base font-bold text-gray-800 mb-1">お子様を選択</h2>
          <p class="text-sm text-gray-600" id="select-greeting"></p>
        </div>
        <div id="child-list" class="space-y-2"></div>
      </div>
    </div>

    <!-- Error state -->
    <div id="state-error" class="hidden fade-in">
      <div class="bg-white rounded-2xl shadow-sm border border-red-200 p-6 text-center">
        <div class="w-14 h-14 mx-auto mb-4 rounded-full bg-red-100 flex items-center justify-center">
          <i class="fas fa-exclamation-triangle text-red-500 text-xl"></i>
        </div>
        <h2 class="text-base font-bold text-gray-800 mb-2">エラーが発生しました</h2>
        <p id="error-detail" class="text-sm text-gray-600 mb-4"></p>
        <button onclick="location.reload()" class="bg-gray-200 text-gray-700 px-6 py-2 rounded-xl text-sm font-medium">
          <i class="fas fa-redo mr-1"></i>やり直す
        </button>
      </div>
    </div>
  </main>

  <footer class="max-w-lg mx-auto w-full px-4 pb-6">
    <p class="text-center text-[10px] text-gray-400">
      滋賀医科大学学内保育所 あゆっこ
    </p>
  </footer>

  <script>
    const LIFF_ID = '${liffId}';
    let lineUserId = null;
    let displayName = null;

    // ── State management ──
    function showState(stateId) {
      ['state-loading', 'state-not-line', 'state-link', 'state-select', 'state-error'].forEach(id => {
        document.getElementById(id).classList.add('hidden');
      });
      document.getElementById(stateId).classList.remove('hidden');
    }

    function showError(msg) {
      document.getElementById('error-detail').textContent = msg;
      showState('state-error');
    }

    // ── LIFF initialization ──
    async function initLiff() {
      try {
        await liff.init({ liffId: LIFF_ID });

        // LINE内ブラウザチェック
        if (!liff.isInClient()) {
          // LINE外ブラウザで開いた場合
          // ログインさせて続行するか、案内を出すか
          if (!liff.isLoggedIn()) {
            // 未ログイン → LINE側のログイン画面へ
            // LINE外の場合はQRコード案内を表示
            showState('state-not-line');
            return;
          }
        }

        // ログイン済みでない場合はログイン
        if (!liff.isLoggedIn()) {
          liff.login();
          return;
        }

        // プロフィール取得
        const profile = await liff.getProfile();
        lineUserId = profile.userId;
        displayName = profile.displayName;

        // サーバーに連携状態を確認
        await checkLinkStatus();
      } catch (e) {
        console.error('LIFF init error:', e);
        if (LIFF_ID === 'PENDING_LIFF_ID') {
          showError('LIFF IDが未設定です。LINE Developer Consoleで設定が必要です。管理者にお問い合わせください。');
        } else {
          showError('LINEの初期化に失敗しました: ' + (e.message || e));
        }
      }
    }

    // ── Check link status ──
    async function checkLinkStatus() {
      try {
        const res = await fetch('/api/liff/me?line_user_id=' + encodeURIComponent(lineUserId));
        if (!res.ok) {
          throw new Error('サーバーエラー: ' + res.status);
        }
        const data = await res.json();

        if (data.linked && data.children && data.children.length > 0) {
          if (data.children.length === 1) {
            // 1名 → 即リダイレクト
            const child = data.children[0];
            window.location.href = '/my/' + child.view_token;
          } else {
            // 複数 → 選択画面
            showChildSelector(data.children);
          }
        } else {
          // 未連携 → 連携コード入力
          showState('state-link');
          // フォーカス
          setTimeout(() => document.getElementById('link-code-input')?.focus(), 300);
        }
      } catch (e) {
        console.error('Check link error:', e);
        showError('連携状態の確認に失敗しました: ' + (e.message || e));
      }
    }

    // ── Child selector ──
    function showChildSelector(children) {
      const list = document.getElementById('child-list');
      const greeting = document.getElementById('select-greeting');
      greeting.textContent = (displayName || '') + 'さん、予定を入力するお子様を選んでください';

      list.innerHTML = children.map(ch => {
        const badge = ch.enrollment_type === '月極'
          ? '<span class="text-[10px] bg-blue-100 text-blue-700 px-2 py-0.5 rounded-full">' + ch.enrollment_type + '</span>'
          : '<span class="text-[10px] bg-orange-100 text-orange-700 px-2 py-0.5 rounded-full">' + ch.enrollment_type + '</span>';
        return '<button onclick="selectChild(\\'' + ch.view_token + '\\')" ' +
          'class="w-full flex items-center gap-3 p-4 bg-gray-50 rounded-xl border border-gray-200 hover:border-green-400 hover:bg-green-50 transition-all">' +
          '<div class="w-10 h-10 rounded-full bg-green-100 flex items-center justify-center text-green-600"><i class="fas fa-child"></i></div>' +
          '<div class="text-left flex-1"><div class="text-sm font-bold text-gray-800">' + ch.name + '</div>' + badge + '</div>' +
          '<i class="fas fa-chevron-right text-gray-400"></i></button>';
      }).join('');

      showState('state-select');
    }

    function selectChild(viewToken) {
      window.location.href = '/my/' + viewToken;
    }

    // ── Link code submission ──
    async function submitLinkCode() {
      const input = document.getElementById('link-code-input');
      const errorEl = document.getElementById('link-error');
      const btn = document.getElementById('link-btn');
      let code = input.value.trim().toUpperCase();

      // Auto-format: add AYK- prefix if just digits
      if (/^\\d{4}$/.test(code)) {
        code = 'AYK-' + code;
        input.value = code;
      }

      if (!/^AYK-\\d{4}$/i.test(code)) {
        errorEl.textContent = 'コードは「AYK-1234」の形式で入力してください';
        errorEl.classList.remove('hidden');
        return;
      }

      errorEl.classList.add('hidden');
      btn.disabled = true;
      btn.innerHTML = '<i class="fas fa-spinner fa-spin mr-1"></i>連携中...';

      try {
        const res = await fetch('/api/liff/link', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            line_user_id: lineUserId,
            code: code,
            display_name: displayName,
          }),
        });

        const data = await res.json();

        if (!res.ok) {
          errorEl.textContent = data.error || '連携に失敗しました';
          errorEl.classList.remove('hidden');
          return;
        }

        if (data.children && data.children.length === 1) {
          window.location.href = '/my/' + data.children[0].view_token;
        } else if (data.children && data.children.length > 1) {
          showChildSelector(data.children);
        } else {
          showError('連携は成功しましたが、園児情報が取得できませんでした');
        }
      } catch (e) {
        errorEl.textContent = '通信エラー: ' + (e.message || e);
        errorEl.classList.remove('hidden');
      } finally {
        btn.disabled = false;
        btn.innerHTML = '<i class="fas fa-check mr-1"></i>連携する';
      }
    }

    // Auto-format input
    document.getElementById('link-code-input')?.addEventListener('input', function(e) {
      let v = e.target.value.toUpperCase().replace(/[^A-Z0-9-]/g, '');
      // If user types just digits and length is 4, auto-add prefix
      if (/^\\d{4}$/.test(v)) {
        v = 'AYK-' + v;
      }
      e.target.value = v;
    });

    // Enter key support
    document.getElementById('link-code-input')?.addEventListener('keydown', function(e) {
      if (e.key === 'Enter') submitLinkCode();
    });

    // ── Start ──
    initLiff();
  </script>
</body>
</html>`;
}

// ═══════════════════════════════════════════
// Parent-facing schedule calendar view
// URL: /my/:token  (view_token or childId, defaults to current/next month)
// URL: /my/:token/:year/:month
// ═══════════════════════════════════════════
app.get('/my/:token/:year?/:month?', (c) => {
  // Sanitize token to prevent XSS (allow only alphanumeric + hyphen + underscore)
  const rawToken = c.req.param('token') || '';
  const token = rawToken.replace(/[^a-zA-Z0-9_-]/g, '');
  if (!token || token !== rawToken) {
    return c.text('Invalid token', 400);
  }
  const now = new Date();
  const rawYear = c.req.param('year');
  const rawMonth = c.req.param('month');
  const year = rawYear && /^\d{4}$/.test(rawYear) ? rawYear : String(now.getFullYear());
  const month = rawMonth && /^\d{1,2}$/.test(rawMonth) ? rawMonth : String(now.getMonth() + 2 > 12 ? 1 : now.getMonth() + 2);
  return c.html(mySchedulePage(token, year, month));
});

function mySchedulePage(token: string, defaultYear: string, defaultMonth: string): string {
  return `<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>利用予定入力 — あゆっこ</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <link href="https://cdn.jsdelivr.net/npm/@fortawesome/fontawesome-free@6.4.0/css/all.min.css" rel="stylesheet">
  <style>
    .cal-cell { min-height: 56px; transition: all 0.15s; }
    .cal-cell.has-plan { background: #eff6ff; border-left: 3px solid #3b82f6; }
    .cal-cell.no-plan { background: #fff; }
    .cal-cell.weekend { background: #fef2f2; }
    .cal-cell.weekend.has-plan { background: #dbeafe; border-left: 3px solid #3b82f6; }
    .cal-cell.editing { box-shadow: 0 0 0 2px #f59e0b; }
    .slide-up { animation: slideUp 0.3s ease-out; }
    @keyframes slideUp { from { transform: translateY(100%); opacity: 0; } to { transform: translateY(0); opacity: 1; } }
  </style>
</head>
<body class="bg-gray-50 min-h-screen pb-20">
  <header class="bg-white border-b border-gray-200 shadow-sm sticky top-0 z-10">
    <div class="max-w-lg mx-auto px-4 py-3 flex items-center justify-between">
      <div class="flex items-center gap-3">
        <div class="w-8 h-8 bg-blue-600 rounded-lg flex items-center justify-center">
          <i class="fas fa-calendar-alt text-white text-sm"></i>
        </div>
        <div>
          <h1 class="text-sm font-bold text-gray-800">あゆっこ 利用予定入力</h1>
          <p id="child-info" class="text-xs text-gray-500">読み込み中...</p>
        </div>
      </div>
      <div class="flex items-center gap-2">
        <button onclick="toggleMode()" id="mode-btn" class="text-xs bg-amber-100 text-amber-700 px-2.5 py-1 rounded-lg font-medium">
          <i class="fas fa-edit mr-1"></i>入力モード
        </button>
      </div>
    </div>
  </header>

  <main class="max-w-lg mx-auto px-4 py-4">
    <!-- Month Navigation -->
    <div class="flex items-center justify-between mb-4 bg-white rounded-xl shadow-sm border border-gray-200 px-4 py-3">
      <button onclick="changeMonth(-1)" class="text-gray-500 hover:text-blue-600 px-2 py-1 rounded">
        <i class="fas fa-chevron-left"></i>
      </button>
      <h2 id="month-title" class="text-base font-bold text-gray-800"></h2>
      <button onclick="changeMonth(1)" class="text-gray-500 hover:text-blue-600 px-2 py-1 rounded">
        <i class="fas fa-chevron-right"></i>
      </button>
    </div>

    <!-- Summary -->
    <div id="summary-bar" class="flex gap-2 mb-4">
      <div class="bg-blue-50 rounded-lg px-3 py-2 text-center flex-1 border border-blue-200">
        <div id="sum-days" class="text-lg font-bold text-blue-700">-</div>
        <div class="text-[10px] text-blue-500">登園予定日</div>
      </div>
      <div class="bg-green-50 rounded-lg px-3 py-2 text-center flex-1 border border-green-200">
        <div id="sum-lunch" class="text-lg font-bold text-green-700">-</div>
        <div class="text-[10px] text-green-500">昼食</div>
      </div>
      <div class="bg-amber-50 rounded-lg px-3 py-2 text-center flex-1 border border-amber-200">
        <div id="sum-snack" class="text-lg font-bold text-amber-700">-</div>
        <div class="text-[10px] text-amber-500">午後おやつ</div>
      </div>
    </div>

    <!-- Edit Mode: Default times -->
    <div id="edit-defaults" class="hidden mb-4 bg-amber-50 rounded-xl border border-amber-200 px-4 py-3 slide-up">
      <div class="text-xs font-bold text-amber-800 mb-2"><i class="fas fa-magic mr-1"></i>一括設定（平日に適用）</div>
      <div class="grid grid-cols-2 gap-2 mb-2">
        <div>
          <label class="text-[10px] text-gray-600">登園時間</label>
          <input type="time" id="def-start" value="08:30" class="w-full border border-gray-300 rounded-lg px-2 py-1.5 text-sm">
        </div>
        <div>
          <label class="text-[10px] text-gray-600">降園時間</label>
          <input type="time" id="def-end" value="17:30" class="w-full border border-gray-300 rounded-lg px-2 py-1.5 text-sm">
        </div>
      </div>
      <p class="text-[10px] text-gray-500 mb-2"><i class="fas fa-info-circle mr-1"></i>食事は時間から自動で設定されます</p>
      <button onclick="applyDefaults()" class="w-full bg-amber-500 text-white py-2 rounded-lg text-xs font-medium hover:bg-amber-600">
        <i class="fas fa-check mr-1"></i>平日すべてに適用
      </button>
    </div>

    <!-- Calendar -->
    <div class="bg-white rounded-xl shadow-sm border border-gray-200 overflow-hidden mb-4">
      <div class="grid grid-cols-7 bg-gray-50 border-b border-gray-200">
        <div class="px-1 py-2 text-center text-[10px] font-semibold text-gray-500">月</div>
        <div class="px-1 py-2 text-center text-[10px] font-semibold text-gray-500">火</div>
        <div class="px-1 py-2 text-center text-[10px] font-semibold text-gray-500">水</div>
        <div class="px-1 py-2 text-center text-[10px] font-semibold text-gray-500">木</div>
        <div class="px-1 py-2 text-center text-[10px] font-semibold text-gray-500">金</div>
        <div class="px-1 py-2 text-center text-[10px] font-semibold text-red-400">土</div>
        <div class="px-1 py-2 text-center text-[10px] font-semibold text-red-400">日</div>
      </div>
      <div id="cal-grid" class="grid grid-cols-7"></div>
    </div>

    <!-- Day List / Edit List -->
    <div id="day-list" class="space-y-1"></div>

    <!-- No data state -->
    <div id="no-data" class="hidden bg-white rounded-xl shadow-sm border border-gray-200 p-8 text-center">
      <i class="fas fa-calendar-plus text-3xl text-gray-300 mb-3"></i>
      <p class="text-sm text-gray-500">この月の予定はまだ入力されていません。</p>
      <p class="text-xs text-gray-400 mt-1">上の「入力モード」をタップして予定を入力してください。</p>
    </div>

    <!-- Error state -->
    <div id="error-state" class="hidden bg-red-50 rounded-xl border border-red-200 p-6 text-center">
      <i class="fas fa-exclamation-triangle text-2xl text-red-400 mb-2"></i>
      <p id="error-msg" class="text-sm text-red-600"></p>
    </div>

    <!-- Footer -->
    <div class="text-center text-xs text-gray-400 mt-6 mb-4">
      <p>滋賀医科大学学内保育所 あゆっこ</p>
    </div>
  </main>

  <!-- Day Edit Modal (bottom sheet) -->
  <div id="day-modal" class="fixed inset-0 bg-black/40 z-50 hidden flex items-end justify-center" onclick="if(event.target===this)closeDayModal()">
    <div class="bg-white rounded-t-2xl w-full max-w-lg slide-up" onclick="event.stopPropagation()">
      <div class="px-5 py-3 border-b border-gray-200 flex items-center justify-between">
        <h3 id="modal-title" class="text-sm font-bold text-gray-800"></h3>
        <button onclick="closeDayModal()" class="text-gray-400 hover:text-gray-600 p-1"><i class="fas fa-times"></i></button>
      </div>
      <div class="px-5 py-4 space-y-3">
        <div class="grid grid-cols-2 gap-3">
          <div>
            <label class="text-xs text-gray-600 font-medium">登園時間</label>
            <input type="time" id="modal-start" class="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm mt-1">
          </div>
          <div>
            <label class="text-xs text-gray-600 font-medium">降園時間</label>
            <input type="time" id="modal-end" class="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm mt-1">
          </div>
        </div>
        <div id="modal-meals" class="text-xs text-gray-500 bg-gray-50 rounded-lg px-3 py-2">
          <i class="fas fa-utensils mr-1"></i><span id="modal-meals-text">食事は時間から自動設定されます</span>
        </div>
        <div class="flex gap-2 pt-2">
          <button onclick="clearDay()" class="flex-1 bg-gray-100 text-gray-600 py-2.5 rounded-lg text-sm font-medium hover:bg-gray-200">
            <i class="fas fa-times mr-1"></i>休み
          </button>
          <button onclick="saveDay()" class="flex-1 bg-blue-600 text-white py-2.5 rounded-lg text-sm font-medium hover:bg-blue-700">
            <i class="fas fa-check mr-1"></i>保存
          </button>
        </div>
      </div>
    </div>
  </div>

  <!-- Fixed bottom save bar (edit mode) -->
  <div id="save-bar" class="hidden fixed bottom-0 left-0 right-0 bg-white border-t border-gray-200 shadow-lg z-40 slide-up">
    <div class="max-w-lg mx-auto px-4 py-3 flex items-center justify-between">
      <div class="text-xs text-gray-600">
        <span id="unsaved-count" class="text-amber-600 font-bold">0</span>件の変更があります
      </div>
      <button onclick="submitAll()" id="btn-submit" class="bg-green-600 text-white px-6 py-2 rounded-lg text-sm font-medium hover:bg-green-700">
        <i class="fas fa-paper-plane mr-1"></i>予定を提出
      </button>
    </div>
  </div>

  <script>
    const VIEW_TOKEN = '${token}';
    let currentYear = parseInt('${defaultYear}');
    let currentMonth = parseInt('${defaultMonth}');
    let scheduleData = null;
    let editMode = false;
    let editingDay = null;
    let childId = null;
    // Local edits: { day: { start, end, deleted } }
    // 食事フラグはサーバー側で自動計算（保護者には入力させない）
    let localEdits = {};

    // 食事フラグ自動計算（サーバー側 meal-rules.ts と同一ロジック）
    function autoCalcMeals(start, end) {
      if (!start || !end) return { lunch: false, am: false, pm: false, dinner: false, bf: false };
      const [sh,sm] = start.split(':').map(Number);
      const [eh,em] = end.split(':').map(Number);
      const startMin = sh*60+sm;
      const endMin = eh*60+em;
      const isNight = startMin >= 19*60;
      return {
        bf: startMin < 12*60 || isNight,
        lunch: startMin < 12*60,
        am: false,
        pm: endMin >= 15*60,
        dinner: false,
      };
    }

    async function loadSchedule() {
      const grid = document.getElementById('cal-grid');
      const dayList = document.getElementById('day-list');
      const noData = document.getElementById('no-data');
      const errorState = document.getElementById('error-state');

      grid.innerHTML = '<div class="col-span-7 py-8 text-center text-gray-400 text-sm"><i class="fas fa-spinner fa-spin mr-1"></i>読み込み中...</div>';
      dayList.innerHTML = '';
      noData.classList.add('hidden');
      errorState.classList.add('hidden');
      localEdits = {};
      updateSaveBar();

      document.getElementById('month-title').textContent = currentYear + '年' + currentMonth + '月';

      try {
        const res = await fetch('/api/schedules/view/' + VIEW_TOKEN + '/' + currentYear + '/' + currentMonth);
        if (!res.ok) {
          const err = await res.json();
          throw new Error(err.error || 'HTTP ' + res.status);
        }
        scheduleData = await res.json();
        childId = scheduleData.child.id;

        const ch = scheduleData.child;
        document.getElementById('child-info').textContent = ch.name + '（' + ch.enrollment_type + '）';

        renderAll();
      } catch (e) {
        grid.innerHTML = '';
        errorState.classList.remove('hidden');
        document.getElementById('error-msg').textContent = e.message;
      }
    }

    function renderAll() {
      if (!scheduleData) return;
      const days = scheduleData.days || [];
      const planned = days.filter(d => getDayData(d).has_plan);
      
      document.getElementById('sum-days').textContent = planned.length;
      document.getElementById('sum-lunch').textContent = planned.filter(d => getDayData(d).lunch).length;
      document.getElementById('sum-snack').textContent = planned.filter(d => getDayData(d).am || getDayData(d).pm).length;

      const noData = document.getElementById('no-data');
      if (planned.length === 0 && !editMode) {
        noData.classList.remove('hidden');
      } else {
        noData.classList.add('hidden');
      }

      renderCalendar(days);
      renderDayList(days);
    }

    function getDayData(d) {
      const edit = localEdits[d.day];
      if (edit) {
        if (edit.deleted) return { has_plan: false, start: null, end: null, lunch: false, am: false, pm: false, dinner: false, bf: false };
        const meals = autoCalcMeals(edit.start, edit.end);
        return {
          has_plan: !!(edit.start || edit.end),
          start: edit.start, end: edit.end,
          lunch: meals.lunch, am: meals.am, pm: meals.pm, dinner: meals.dinner, bf: meals.bf,
        };
      }
      // DBからの値も時間から再計算して表示（表示一貫性のため）
      if (d.has_plan && d.planned_start && d.planned_end) {
        const meals = autoCalcMeals(d.planned_start, d.planned_end);
        return {
          has_plan: true,
          start: d.planned_start, end: d.planned_end,
          lunch: meals.lunch, am: meals.am, pm: meals.pm, dinner: meals.dinner, bf: meals.bf,
        };
      }
      return {
        has_plan: d.has_plan,
        start: d.planned_start, end: d.planned_end,
        lunch: !!d.lunch_flag, am: !!d.am_snack_flag, pm: !!d.pm_snack_flag, dinner: !!d.dinner_flag, bf: !!d.breakfast_flag,
      };
    }

    function renderCalendar(days) {
      const grid = document.getElementById('cal-grid');
      const firstDate = new Date(currentYear, currentMonth - 1, 1);
      const startOffset = (firstDate.getDay() + 6) % 7;

      let html = '';
      for (let i = 0; i < startOffset; i++) {
        html += '<div class="border-b border-r border-gray-100 bg-gray-50/50 p-1"></div>';
      }

      days.forEach(d => {
        const dd = getDayData(d);
        const isWE = d.is_weekend;
        const edited = localEdits[d.day] !== undefined;
        let cls = 'cal-cell border-b border-r border-gray-100 p-1.5 cursor-pointer';
        cls += isWE ? ' weekend' : '';
        cls += dd.has_plan ? ' has-plan' : ' no-plan';
        cls += edited ? ' editing' : '';

        const dateColor = isWE ? 'text-red-400' : 'text-gray-700';
        const onClick = editMode ? 'openDayModal(' + d.day + ')' : 'scrollToDay(' + d.day + ')';
        let timeStr = '';
        if (dd.has_plan && dd.start && dd.end) {
          timeStr = '<div class="text-[9px] text-blue-600 mt-0.5">' + shortTime(dd.start) + '-' + shortTime(dd.end) + '</div>';
        } else if (!isWE && editMode) {
          timeStr = '<div class="text-[9px] text-amber-400 mt-0.5"><i class="fas fa-plus"></i></div>';
        }

        const meals = [];
        if (dd.lunch) meals.push('🍱');
        if (dd.am) meals.push('🍪');
        if (dd.pm) meals.push('🍪');
        if (dd.dinner) meals.push('🍽');
        const mealStr = meals.length > 0 ? '<div class="text-[8px] mt-0.5">' + meals.join('') + '</div>' : '';

        html += '<div class="' + cls + '" onclick="' + onClick + '">' +
          '<div class="text-xs font-semibold ' + dateColor + '">' + d.day + (edited ? '<span class="text-amber-500 ml-0.5">*</span>' : '') + '</div>' +
          timeStr + mealStr + '</div>';
      });

      const totalCells = startOffset + days.length;
      const remainder = totalCells % 7;
      if (remainder > 0) {
        for (let i = 0; i < 7 - remainder; i++) {
          html += '<div class="border-b border-r border-gray-100 bg-gray-50/50 p-1"></div>';
        }
      }
      grid.innerHTML = html;
    }

    function renderDayList(days) {
      const list = document.getElementById('day-list');
      const allDays = editMode ? days.filter(d => !d.is_weekend) : days.filter(d => getDayData(d).has_plan);

      if (allDays.length === 0) { list.innerHTML = ''; return; }

      const wds = ['日','月','火','水','木','金','土'];
      list.innerHTML = '<h3 class="text-xs font-bold text-gray-600 mb-2 mt-2"><i class="fas fa-list mr-1"></i>' +
        (editMode ? '平日一覧（タップで編集）' : '登園予定一覧 (' + allDays.filter(d => getDayData(d).has_plan).length + '日)') + '</h3>' +
        allDays.map(d => {
          const dd = getDayData(d);
          const wd = d.weekday || wds[new Date(currentYear, currentMonth-1, d.day).getDay()];
          const edited = localEdits[d.day] !== undefined;

          if (!dd.has_plan && !editMode) return '';

          const tStr = dd.start && dd.end ? shortTime(dd.start) + ' - ' + shortTime(dd.end) : (editMode ? 'タップして入力' : '時間未定');
          const meals = [];
          if (dd.lunch) meals.push('🍱');
          if (dd.am) meals.push('🍪');
          if (dd.pm) meals.push('🍪');
          if (dd.dinner) meals.push('🍽');
          const mealStr = meals.join(' ');

          const borderCls = edited ? 'border-amber-300 bg-amber-50' : (dd.has_plan ? 'border-gray-200' : 'border-gray-100 bg-gray-50');
          const onClick = editMode ? 'openDayModal(' + d.day + ')' : '';

          return '<div id="day-' + d.day + '" class="bg-white rounded-lg shadow-sm border ' + borderCls + ' px-3 py-2 flex items-center justify-between cursor-pointer" onclick="' + onClick + '">' +
            '<div>' +
              '<span class="text-sm font-semibold text-gray-800">' + currentMonth + '/' + d.day + ' (' + wd + ')</span>' +
              (edited ? ' <span class="text-[9px] text-amber-600 bg-amber-100 px-1 rounded">変更</span>' : '') +
              '<div class="text-xs ' + (dd.has_plan ? 'text-blue-600' : 'text-gray-400') + ' mt-0.5"><i class="fas fa-clock mr-0.5"></i>' + tStr + '</div>' +
              (mealStr ? '<div class="text-[10px] mt-0.5">' + mealStr + '</div>' : '') +
            '</div>' +
            (dd.has_plan ? '<div class="text-blue-500"><i class="fas fa-check-circle"></i></div>' : (editMode ? '<div class="text-gray-300"><i class="fas fa-plus-circle"></i></div>' : '')) +
          '</div>';
        }).join('');
    }

    function toggleMode() {
      editMode = !editMode;
      const btn = document.getElementById('mode-btn');
      const defs = document.getElementById('edit-defaults');
      if (editMode) {
        btn.innerHTML = '<i class="fas fa-eye mr-1"></i>閲覧モード';
        btn.className = 'text-xs bg-blue-100 text-blue-700 px-2.5 py-1 rounded-lg font-medium';
        defs.classList.remove('hidden');
      } else {
        btn.innerHTML = '<i class="fas fa-edit mr-1"></i>入力モード';
        btn.className = 'text-xs bg-amber-100 text-amber-700 px-2.5 py-1 rounded-lg font-medium';
        defs.classList.add('hidden');
      }
      renderAll();
      updateSaveBar();
    }

    function applyDefaults() {
      if (!scheduleData) return;
      const start = document.getElementById('def-start').value;
      const end = document.getElementById('def-end').value;

      for (const d of scheduleData.days) {
        if (d.is_weekend) continue;
        localEdits[d.day] = { start, end };
      }
      renderAll();
      updateSaveBar();
    }

    function openDayModal(day) {
      if (!editMode) return;
      editingDay = day;
      const d = scheduleData.days.find(x => x.day === day);
      const dd = getDayData(d);
      const wds = ['日','月','火','水','木','金','土'];
      const wd = wds[new Date(currentYear, currentMonth-1, day).getDay()];

      document.getElementById('modal-title').textContent = currentMonth + '月' + day + '日（' + wd + '）';
      document.getElementById('modal-start').value = dd.start || '08:30';
      document.getElementById('modal-end').value = dd.end || '17:30';
      updateModalMeals();

      // 時間変更時に食事プレビュー更新
      document.getElementById('modal-start').onchange = updateModalMeals;
      document.getElementById('modal-end').onchange = updateModalMeals;

      document.getElementById('day-modal').classList.remove('hidden');
    }

    function updateModalMeals() {
      const s = document.getElementById('modal-start').value;
      const e = document.getElementById('modal-end').value;
      const m = autoCalcMeals(s, e);
      const items = [];
      if (m.bf) items.push('朝食');
      if (m.lunch) items.push('昼食');
      if (m.pm) items.push('午後おやつ');
      document.getElementById('modal-meals-text').textContent = items.length > 0 ? items.join('・') + '（自動）' : '食事なし';
    }

    function closeDayModal() {
      document.getElementById('day-modal').classList.add('hidden');
      editingDay = null;
    }

    function saveDay() {
      if (editingDay === null) return;
      localEdits[editingDay] = {
        start: document.getElementById('modal-start').value || null,
        end: document.getElementById('modal-end').value || null,
      };
      closeDayModal();
      renderAll();
      updateSaveBar();
    }

    function clearDay() {
      if (editingDay === null) return;
      localEdits[editingDay] = { deleted: true };
      closeDayModal();
      renderAll();
      updateSaveBar();
    }

    function updateSaveBar() {
      const count = Object.keys(localEdits).length;
      document.getElementById('unsaved-count').textContent = count;
      const bar = document.getElementById('save-bar');
      if (count > 0 && editMode) {
        bar.classList.remove('hidden');
      } else {
        bar.classList.add('hidden');
      }
    }

    async function submitAll() {
      if (!childId || Object.keys(localEdits).length === 0) return;
      const btn = document.getElementById('btn-submit');
      btn.disabled = true;
      btn.innerHTML = '<i class="fas fa-spinner fa-spin mr-1"></i>送信中...';

      const days = [];
      for (const [dayStr, edit] of Object.entries(localEdits)) {
        const day = parseInt(dayStr);
        if (edit.deleted) {
          days.push({ day, planned_start: null, planned_end: null });
        } else {
          // 食事フラグは送らない（サーバー側で自動計算）
          days.push({
            day,
            planned_start: edit.start || null,
            planned_end: edit.end || null,
          });
        }
      }

      try {
        const res = await fetch('/api/schedules/submit/' + VIEW_TOKEN, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ year: currentYear, month: currentMonth, days }),
        });
        const result = await res.json();
        if (!res.ok) throw new Error(result.error || 'エラー');

        // Success: reload
        localEdits = {};
        await loadSchedule();
        editMode = false;
        toggleMode(); // switch back to view
        toggleMode(); // this toggles it to edit... let me fix
        // Actually just reload
        alert('予定を提出しました！（' + result.upserted + '日分）');
        localEdits = {};
        await loadSchedule();
        if (editMode) toggleMode();
      } catch (e) {
        alert('エラー: ' + e.message);
      } finally {
        btn.disabled = false;
        btn.innerHTML = '<i class="fas fa-paper-plane mr-1"></i>予定を提出';
      }
    }

    function shortTime(t) {
      if (!t) return '';
      const m = t.match(/^0?(\\d{1,2}):(\\d{2})/);
      return m ? parseInt(m[1]) + ':' + m[2] : t;
    }

    function changeMonth(delta) {
      currentMonth += delta;
      if (currentMonth > 12) { currentMonth = 1; currentYear++; }
      if (currentMonth < 1) { currentMonth = 12; currentYear--; }
      loadSchedule();
    }

    function scrollToDay(day) {
      const el = document.getElementById('day-' + day);
      if (el) {
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        el.classList.add('ring-2', 'ring-blue-400');
        setTimeout(() => el.classList.remove('ring-2', 'ring-blue-400'), 2000);
      }
    }

    // Init
    loadSchedule();
  </script>
</body>
</html>`;
}

// ═══════════════════════════════════════════
// Staff Daily Info & Attendance Sheet
// ═══════════════════════════════════════════
function staffDailyPage(defaultYear: string, defaultMonth: string, defaultDay: string): string {
  const now = new Date();
  const dy = defaultDay || String(now.getDate());
  return `<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>日次情報 — あゆっこ</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <link href="https://cdn.jsdelivr.net/npm/@fortawesome/fontawesome-free@6.4.0/css/all.min.css" rel="stylesheet">
  <style>
    @media print {
      body { -webkit-print-color-adjust: exact; print-color-adjust: exact; font-size: 11px; }
      .no-print { display: none !important; }
      .page-break { page-break-before: always; }
      table { border-collapse: collapse; width: 100%; }
      th, td { border: 1px solid #888; padding: 3px 6px; }
      .print-title { font-size: 16px; font-weight: bold; margin-bottom: 8px; }
    }
    @media screen {
      .print-only { display: none; }
    }
  </style>
</head>
<body class="bg-gray-50 min-h-screen">
  <!-- Screen header -->
  <header class="bg-white border-b border-gray-200 shadow-sm no-print">
    <div class="max-w-5xl mx-auto px-4 py-3 flex items-center justify-between">
      <div class="flex items-center gap-3">
        <div class="w-8 h-8 bg-teal-600 rounded-lg flex items-center justify-center">
          <i class="fas fa-clipboard-list text-white text-sm"></i>
        </div>
        <div>
          <h1 class="text-sm font-bold text-gray-800">あゆっこ 日次情報 / 園児登園確認表</h1>
          <p class="text-xs text-gray-500">職員共有用（印刷対応）</p>
        </div>
      </div>
      <div class="flex items-center gap-2">
        <input type="date" id="date-picker" class="border border-gray-300 rounded-lg px-3 py-1.5 text-sm"
               value="${defaultYear}-${defaultMonth.padStart(2,'0')}-${dy.padStart(2,'0')}"
               onchange="loadDate()">
        <button onclick="window.print()" class="bg-teal-600 text-white px-4 py-1.5 rounded-lg text-sm hover:bg-teal-700">
          <i class="fas fa-print mr-1"></i>印刷
        </button>
        <a href="/" class="text-xs text-gray-400 hover:text-gray-600 px-2"><i class="fas fa-home"></i></a>
      </div>
    </div>
  </header>

  <main class="max-w-5xl mx-auto px-4 py-4">
    <div id="loading" class="text-center py-12 text-gray-400"><i class="fas fa-spinner fa-spin mr-1"></i>読み込み中...</div>

    <!-- ═══ 日次情報 ═══ -->
    <div id="daily-info" class="hidden">
      <div class="print-title print-only" id="print-title-daily"></div>
      <h2 id="daily-title" class="text-lg font-bold text-gray-800 mb-3 no-print"></h2>

      <!-- Summary cards -->
      <div class="grid grid-cols-2 md:grid-cols-5 gap-2 mb-4" id="daily-summary"></div>

      <!-- 園児登園確認表 -->
      <div class="bg-white rounded-xl shadow-sm border border-gray-200 mb-4 overflow-x-auto">
        <div class="px-4 py-3 border-b border-gray-100">
          <h3 class="text-sm font-bold text-gray-800"><i class="fas fa-check-square text-teal-500 mr-1"></i>園児登園確認表</h3>
        </div>
        <table class="w-full text-xs" id="attendance-table">
          <thead>
            <tr class="bg-gray-50 text-gray-600">
              <th class="px-2 py-2 text-left font-medium w-8">No</th>
              <th class="px-2 py-2 text-left font-medium">クラス</th>
              <th class="px-2 py-2 text-left font-medium">氏名</th>
              <th class="px-2 py-2 text-center font-medium">区分</th>
              <th class="px-2 py-2 text-center font-medium">予定登園</th>
              <th class="px-2 py-2 text-center font-medium">予定降園</th>
              <th class="px-2 py-2 text-center font-medium">朝食</th>
              <th class="px-2 py-2 text-center font-medium">昼食</th>
              <th class="px-2 py-2 text-center font-medium">朝おやつ</th>
              <th class="px-2 py-2 text-center font-medium">午後おやつ</th>
              <th class="px-2 py-2 text-center font-medium">夕食</th>
              <th class="px-2 py-2 text-center font-medium">早朝</th>
              <th class="px-2 py-2 text-center font-medium">延長</th>
              <th class="px-2 py-2 text-center font-medium">夜間</th>
              <th class="px-2 py-2 text-center font-medium print-only" style="width:60px">実績登園</th>
              <th class="px-2 py-2 text-center font-medium print-only" style="width:60px">実績降園</th>
              <th class="px-2 py-2 text-center font-medium print-only" style="width:40px">確認</th>
            </tr>
          </thead>
          <tbody id="attendance-body"></tbody>
        </table>
      </div>

      <!-- 食事サマリー -->
      <div class="bg-white rounded-xl shadow-sm border border-gray-200 mb-4">
        <div class="px-4 py-3 border-b border-gray-100">
          <h3 class="text-sm font-bold text-gray-800"><i class="fas fa-utensils text-green-500 mr-1"></i>食事サマリー</h3>
        </div>
        <div class="p-4" id="meal-summary"></div>
      </div>
    </div>

    <!-- Error -->
    <div id="error-state" class="hidden bg-red-50 rounded-xl border border-red-200 p-6 text-center">
      <i class="fas fa-exclamation-triangle text-2xl text-red-400 mb-2"></i>
      <p id="error-msg" class="text-sm text-red-600"></p>
    </div>
  </main>

  <script>
    let currentYear = ${defaultYear};
    let currentMonth = ${defaultMonth};
    let currentDay = ${dy};

    async function loadDate() {
      const picker = document.getElementById('date-picker');
      if (picker && picker.value) {
        const parts = picker.value.split('-');
        currentYear = parseInt(parts[0]);
        currentMonth = parseInt(parts[1]);
        currentDay = parseInt(parts[2]);
        // Update URL without reload
        history.pushState(null, '', '/staff/daily/' + currentYear + '/' + currentMonth + '/' + currentDay);
      }
      await loadDayData();
    }

    async function loadDayData() {
      document.getElementById('loading').classList.remove('hidden');
      document.getElementById('daily-info').classList.add('hidden');
      document.getElementById('error-state').classList.add('hidden');

      try {
        // Get dashboard data for this month
        const res = await fetch('/api/schedules/dashboard', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ year: currentYear, month: currentMonth }),
        });
        if (!res.ok) throw new Error('データ取得に失敗しました');
        const data = await res.json();

        const daySummary = data.daily_summary.find(d => d.day === currentDay);
        if (!daySummary) throw new Error('指定日のデータがありません');

        const wds = ['日','月','火','水','木','金','土'];
        const wd = wds[new Date(currentYear, currentMonth-1, currentDay).getDay()];
        const dateStr = currentYear + '年' + currentMonth + '月' + currentDay + '日（' + wd + '）';
        
        document.getElementById('daily-title').textContent = dateStr + ' 日次情報';
        document.getElementById('print-title-daily').textContent = '滋賀医科大学学内保育所 あゆっこ　' + dateStr + ' 日次情報';

        // Summary cards
        const s = daySummary;
        document.getElementById('daily-summary').innerHTML = [
          { label: '登園予定', value: s.total_children, color: 'blue', icon: 'child' },
          { label: '昼食', value: s.lunch_count, color: 'green', icon: 'utensils' },
          { label: '早朝', value: s.early_morning_count, color: 'orange', icon: 'sun' },
          { label: '延長', value: s.extension_count, color: 'purple', icon: 'clock' },
          { label: '一時', value: s.temp_count, color: 'amber', icon: 'user-clock' },
        ].map(c => '<div class="bg-' + c.color + '-50 rounded-lg px-3 py-2 text-center border border-' + c.color + '-200">' +
          '<div class="text-lg font-bold text-' + c.color + '-700">' + c.value + '</div>' +
          '<div class="text-[10px] text-' + c.color + '-500"><i class="fas fa-' + c.icon + ' mr-0.5"></i>' + c.label + '</div>' +
        '</div>').join('');

        // Attendance table
        const children = s.children || [];
        const tbody = document.getElementById('attendance-body');
        if (children.length === 0) {
          tbody.innerHTML = '<tr><td colspan="17" class="text-center py-6 text-gray-400">この日の予定はありません</td></tr>';
        } else {
          tbody.innerHTML = children.map((ch, i) => {
            const flagCell = (val) => val ? '<span class="text-green-600 font-bold">○</span>' : '';
            return '<tr class="' + (i % 2 ? 'bg-gray-50' : '') + '">' +
              '<td class="px-2 py-1.5 text-center text-gray-500">' + (i+1) + '</td>' +
              '<td class="px-2 py-1.5">' + (ch.class_name || '') + '</td>' +
              '<td class="px-2 py-1.5 font-medium">' + ch.name + '</td>' +
              '<td class="px-2 py-1.5 text-center">' + ch.enrollment_type + '</td>' +
              '<td class="px-2 py-1.5 text-center text-blue-600">' + shortTime(ch.planned_start) + '</td>' +
              '<td class="px-2 py-1.5 text-center text-blue-600">' + shortTime(ch.planned_end) + '</td>' +
              '<td class="px-2 py-1.5 text-center">' + flagCell(ch.has_breakfast) + '</td>' +
              '<td class="px-2 py-1.5 text-center">' + flagCell(ch.has_lunch) + '</td>' +
              '<td class="px-2 py-1.5 text-center">' + flagCell(ch.has_am_snack) + '</td>' +
              '<td class="px-2 py-1.5 text-center">' + flagCell(ch.has_pm_snack) + '</td>' +
              '<td class="px-2 py-1.5 text-center">' + flagCell(ch.has_dinner) + '</td>' +
              '<td class="px-2 py-1.5 text-center">' + flagCell(ch.is_early_morning) + '</td>' +
              '<td class="px-2 py-1.5 text-center">' + flagCell(ch.is_extension) + '</td>' +
              '<td class="px-2 py-1.5 text-center">' + flagCell(ch.is_night) + '</td>' +
              '<td class="px-2 py-1.5 text-center print-only"></td>' +
              '<td class="px-2 py-1.5 text-center print-only"></td>' +
              '<td class="px-2 py-1.5 text-center print-only"></td>' +
            '</tr>';
          }).join('');
        }

        // Meal summary
        document.getElementById('meal-summary').innerHTML = '<div class="grid grid-cols-3 md:grid-cols-6 gap-2 text-xs">' +
          [
            { label: '朝食', count: s.breakfast_count, icon: '🍞' },
            { label: '昼食', count: s.lunch_count, icon: '🍱' },
            { label: '朝おやつ', count: s.am_snack_count, icon: '🍪' },
            { label: '午後おやつ', count: s.pm_snack_count, icon: '🍪' },
            { label: '夕食', count: s.dinner_count, icon: '🍽' },
            { label: 'アレルギー対応', count: children.filter(c => c.meal_allergy).length, icon: '⚠️' },
          ].map(m => '<div class="text-center bg-gray-50 rounded-lg px-2 py-2 border border-gray-200">' +
            '<div class="text-lg">' + m.icon + '</div>' +
            '<div class="font-bold text-gray-800">' + m.count + '</div>' +
            '<div class="text-gray-500">' + m.label + '</div>' +
          '</div>').join('') + '</div>';

        document.getElementById('loading').classList.add('hidden');
        document.getElementById('daily-info').classList.remove('hidden');

      } catch (e) {
        document.getElementById('loading').classList.add('hidden');
        document.getElementById('error-state').classList.remove('hidden');
        document.getElementById('error-msg').textContent = e.message;
      }
    }

    function shortTime(t) {
      if (!t) return '';
      const m = t.match(/^0?(\\d{1,2}):(\\d{2})/);
      return m ? parseInt(m[1]) + ':' + m[2] : t;
    }

    // Init
    loadDayData();
  </script>
</body>
</html>`;
}

export default app;

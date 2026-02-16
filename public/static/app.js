/**
 * あゆっこ業務自動化 - Frontend Application
 * Single-screen MVP: Upload → Generate → Download
 */

// State
const state = {
  files: {
    lukumi: [],
    schedule: [],
  },
  currentJobId: null,
  pollInterval: null,
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
  const files = Array.from(e.dataTransfer.files);
  addFiles(files, type);
}

function handleFileSelect(e, type) {
  const files = Array.from(e.target.files);
  addFiles(files, type);
}

function addFiles(files, type) {
  if (type === 'lukumi') {
    // Only one lukumi file
    state.files.lukumi = files.slice(0, 1);
  } else {
    // Append schedule files
    state.files.schedule = [...state.files.schedule, ...files];
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
  const files = state.files[type];
  
  if (files.length === 0) {
    container.innerHTML = '';
    return;
  }

  container.innerHTML = files.map((f, i) => `
    <div class="flex items-center justify-between bg-gray-50 rounded-lg px-3 py-2">
      <div class="flex items-center gap-2 min-w-0">
        <i class="fas fa-file-excel text-green-500 text-sm flex-shrink-0"></i>
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

  if (hasLukumi || scheduleCount > 0) {
    summary.classList.remove('hidden');
    const parts = [];
    if (hasLukumi) parts.push('ルクミー: 1件');
    if (scheduleCount > 0) parts.push(`予定表: ${scheduleCount}件`);
    text.textContent = parts.join(' / ');
  } else {
    summary.classList.add('hidden');
  }
}

// ===== Generation =====

async function startGeneration() {
  const year = parseInt(document.getElementById('year-select').value);
  const month = parseInt(document.getElementById('month-select').value);

  if (state.files.lukumi.length === 0) {
    alert('ルクミー登降園データをアップロードしてください');
    return;
  }

  const btn = document.getElementById('btn-generate');
  btn.disabled = true;
  btn.innerHTML = '<i class="fas fa-spinner fa-spin mr-1"></i>処理開始中...';

  try {
    // 1. Create job
    const jobRes = await fetch('/api/jobs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ year, month }),
    });
    const job = await jobRes.json();
    state.currentJobId = job.id;

    // 2. Upload files
    showProgress();
    updateProgress(5, 'ファイルをアップロード中...');

    const formData = new FormData();
    state.files.lukumi.forEach(f => formData.append('lukumi', f));
    state.files.schedule.forEach(f => formData.append('schedule', f));

    await fetch(`/api/jobs/${job.id}/upload`, {
      method: 'POST',
      body: formData,
    });

    updateProgress(15, 'アップロード完了。処理を開始します...');

    // 3. Start processing
    await fetch(`/api/jobs/${job.id}/run`, {
      method: 'POST',
    });

    // 4. Poll for results
    pollJobStatus(job.id);

  } catch (error) {
    alert('エラーが発生しました: ' + error.message);
    btn.disabled = false;
    btn.innerHTML = '<i class="fas fa-magic mr-1"></i>生成開始';
  }
}

function showProgress() {
  document.getElementById('step-progress').classList.remove('hidden');
  document.getElementById('step-progress').scrollIntoView({ behavior: 'smooth' });
}

function updateProgress(pct, text) {
  document.getElementById('progress-bar').style.width = `${pct}%`;
  document.getElementById('progress-text').textContent = text;
  
  const log = document.getElementById('progress-log');
  const time = new Date().toLocaleTimeString('ja-JP');
  log.innerHTML += `<div>[${time}] ${text}</div>`;
  log.scrollTop = log.scrollHeight;
}

function pollJobStatus(jobId) {
  let tick = 0;
  state.pollInterval = setInterval(async () => {
    tick++;
    try {
      const res = await fetch(`/api/jobs/${jobId}`);
      const job = await res.json();

      const statusMessages = {
        parsing: 'ファイルを解析中...',
        calculating: '課金計算中...',
        generating: '帳票を生成中...',
        completed: '生成完了！',
        failed: '処理に失敗しました',
      };

      const statusProgress = {
        parsing: 20 + tick * 5,
        calculating: 50 + tick * 3,
        generating: 70 + tick * 2,
        completed: 100,
        failed: 0,
      };

      const pct = Math.min(statusProgress[job.status] || 0, 99);
      updateProgress(
        job.status === 'completed' ? 100 : pct,
        statusMessages[job.status] || job.status
      );

      if (job.status === 'completed' || job.status === 'failed') {
        clearInterval(state.pollInterval);
        if (job.status === 'completed') {
          showResults(jobId);
        } else {
          updateProgress(0, 'エラー: ' + (job.error_json || '不明なエラー'));
        }
      }
    } catch (e) {
      // Retry on network error
      if (tick > 60) {
        clearInterval(state.pollInterval);
        updateProgress(0, 'タイムアウト: ジョブの状態を確認できませんでした');
      }
    }
  }, 2000);
}

async function showResults(jobId) {
  const res = await fetch(`/api/jobs/${jobId}/result`);
  const result = await res.json();

  document.getElementById('step-result').classList.remove('hidden');
  document.getElementById('step-result').scrollIntoView({ behavior: 'smooth' });

  // Render files
  const filesContainer = document.getElementById('result-files');
  const outputs = result.outputs || [];
  
  if (outputs.length === 0) {
    filesContainer.innerHTML = `
      <div class="text-center py-6 text-gray-500">
        <i class="fas fa-info-circle text-2xl mb-2"></i>
        <p class="text-sm">処理は完了しましたが、出力ファイルはまだ生成されていません</p>
        <p class="text-xs text-gray-400 mt-1">Phase D (テンプレート書き込み) の実装後に出力されます</p>
      </div>
    `;
  } else {
    filesContainer.innerHTML = outputs.map(f => `
      <div class="flex items-center justify-between bg-gray-50 rounded-lg p-3">
        <div class="flex items-center gap-3">
          <i class="fas ${getFileIcon(f.file_type)} text-lg ${getFileColor(f.file_type)}"></i>
          <div>
            <p class="text-sm font-medium text-gray-800">${f.file_name}</p>
            <p class="text-xs text-gray-500">${f.purpose || ''}</p>
          </div>
        </div>
        <a href="${f.download_url}" class="text-blue-600 hover:text-blue-800 text-sm">
          <i class="fas fa-download mr-1"></i>ダウンロード
        </a>
      </div>
    `).join('');
  }

  // Render warnings
  const warnings = result.warnings || [];
  const warningsContainer = document.getElementById('result-warnings');
  if (warnings.length > 0) {
    warningsContainer.innerHTML = `
      <h4 class="text-sm font-semibold text-yellow-700 mb-2">
        <i class="fas fa-exclamation-triangle mr-1"></i>警告 (${warnings.length}件)
      </h4>
      <div class="space-y-2">
        ${warnings.map(w => `
          <div class="bg-yellow-50 rounded-lg p-3 text-sm">
            <p class="text-yellow-800"><strong>${w.child_name || ''}:</strong> ${w.message}</p>
            ${w.suggestion ? `<p class="text-yellow-600 text-xs mt-1">→ ${w.suggestion}</p>` : ''}
          </div>
        `).join('')}
      </div>
    `;
  }

  // Render stats
  const stats = result.stats || {};
  document.getElementById('result-stats').innerHTML = `
    <div class="flex gap-6 text-sm text-gray-500">
      <span><strong>${stats.children_processed || 0}</strong>名 処理</span>
      <span><strong>${stats.children_skipped || 0}</strong>名 スキップ</span>
      <span><strong>${stats.total_warnings || 0}</strong>件 警告</span>
    </div>
  `;
}

async function downloadZip() {
  if (!state.currentJobId) return;
  window.location.href = `/api/jobs/${state.currentJobId}/download`;
}

// ===== Helpers =====

function formatFileSize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

function getFileIcon(type) {
  const icons = {
    daily_report: 'fa-file-excel',
    billing_detail: 'fa-file-invoice-dollar',
    parent_statement: 'fa-file-pdf',
    zip: 'fa-file-archive',
  };
  return icons[type] || 'fa-file';
}

function getFileColor(type) {
  const colors = {
    daily_report: 'text-green-600',
    billing_detail: 'text-purple-600',
    parent_statement: 'text-red-600',
    zip: 'text-yellow-600',
  };
  return colors[type] || 'text-gray-600';
}

// ===== Init =====
document.addEventListener('DOMContentLoaded', () => {
  // Health check
  fetch('/api/health')
    .then(r => r.json())
    .then(data => {
      document.getElementById('health-status').innerHTML = 
        `<i class="fas fa-circle text-green-400 mr-1"></i>稼働中 v${data.version}`;
    })
    .catch(() => {
      document.getElementById('health-status').innerHTML = 
        '<i class="fas fa-circle text-red-400 mr-1"></i>接続エラー';
    });
});

/* Personal Todo Vault — 配置中心：邮件提醒与坚果云备份设置
   经典 script 依序加载、共享全局作用域；依赖 app.core.js 先行。 */
  /* ── Settings Modal ── */
  function defaultSettings() {
    return {
      email: {
        enabled: false,
        checkTime: '09:00',
        host: 'smtp.163.com',
        port: 465,
        secure: true,
        user: '',
        passwordConfigured: false,
        fromName: 'TODO提醒',
        from: '',
        recipients: '',
        configured: false,
      },
      webdav: {
        provider: 'jianguoyun',
        baseUrl: 'https://dav.jianguoyun.com/dav/',
        username: '',
        passwordConfigured: false,
        backupDir: 'todo-app-backups',
        autoEnabled: false,
        intervalHours: 24,
        configured: false,
      },
      emailEnabled: false,
      checkTime: '09:00',
      smtpReady: false,
      backup: null,
    };
  }

  function normalizeSettings(raw = {}) {
    const base = defaultSettings();
    const email = { ...base.email, ...(raw.email || {}) };
    email.enabled = raw.emailEnabled !== undefined ? !!raw.emailEnabled : !!email.enabled;
    email.checkTime = raw.checkTime || email.checkTime || '09:00';
    email.configured = raw.smtpReady !== undefined ? !!raw.smtpReady : !!email.configured;
    const webdav = { ...base.webdav, ...(raw.webdav || {}), ...(raw.backup || {}) };
    return {
      ...base,
      ...raw,
      email,
      webdav,
      emailEnabled: email.enabled,
      checkTime: email.checkTime,
      smtpReady: email.configured,
    };
  }

  function setBadge(id, ok, yesText = '✅ 已配置', noText = '❌ 未配置') {
    const badge = document.getElementById(id);
    if (!badge) return;
    badge.textContent = ok ? yesText : noText;
    badge.style.background = ok ? 'rgba(82,196,26,0.12)' : 'rgba(255,85,85,0.12)';
    badge.style.color = ok ? '#52c41a' : '#ff5555';
  }

  function setResult(id, text, kind = 'muted') {
    const el = document.getElementById(id);
    if (!el) return;
    el.textContent = text || '';
    el.style.color = kind === 'ok' ? '#52c41a' : kind === 'error' ? 'var(--danger)' : 'var(--text-3)';
  }

  function setBackupActionHint(text, kind = 'muted') {
    const hint = document.getElementById('backupActionHint');
    if (!hint) return;
    hint.textContent = text || '';
    hint.className = `settings-meta backup-action-hint${kind === 'ok' ? ' is-ready' : kind === 'warning' ? ' is-warning' : kind === 'error' ? ' is-error' : ''}`;
  }

  function backupRemoteSummary(remote) {
    if (!remote) return '';
    if (remote.state === 'empty') return '云端目录可访问，但还没有快照。';
    if (remote.state === 'invalid') return `云端目录可访问，但备份不可用：${remote.error || remote.message || '快照格式无效'}。`;
    const created = remote.createdAt ? new Date(remote.createdAt).toLocaleString() : '时间未知';
    const todoCount = remote.todoCount === null || remote.todoCount === undefined ? '待办数量未知' : `${remote.todoCount} 个待办`;
    return `已找到云端快照：${created} · ${todoCount} · ${remote.noteCount ?? 0} 个笔记。`;
  }

  function setButtonBusy(id, busy, text) {
    const btn = document.getElementById(id);
    if (!btn) return null;
    if (!btn.dataset.defaultText) btn.dataset.defaultText = btn.textContent;
    btn.disabled = !!busy;
    btn.textContent = busy ? text : btn.dataset.defaultText;
    return btn;
  }

  async function refreshSettings() {
    const res = await fetch(API + '/settings?_=' + Date.now());
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || '读取配置失败');
    settings = normalizeSettings(data);
    backupStatus = settings.backup || settings.webdav || backupStatus;
    populateSettingsForm();
    renderBackupStatus();
    return settings;
  }

  function populateSettingsForm() {
    settings = normalizeSettings(settings);
    populateThemeForm();
    const email = settings.email;
    const webdav = settings.webdav;
    const setVal = (id, value = '') => { const el = document.getElementById(id); if (el) el.value = value ?? ''; };
    const setChecked = (id, value) => { const el = document.getElementById(id); if (el) el.checked = !!value; };

    setChecked('emailEnabledToggle', email.enabled);
    setVal('checkTimeInput', email.checkTime || '09:00');
    setVal('emailHostInput', email.host || 'smtp.163.com');
    setVal('emailPortInput', email.port || 465);
    setChecked('emailSecureToggle', email.secure !== false);
    setVal('emailUserInput', email.user || '');
    setVal('emailFromNameInput', email.fromName || 'TODO提醒');
    setVal('emailFromInput', email.from || '');
    setVal('emailRecipientsInput', email.recipients || '');
    setVal('emailPasswordInput', '');
    const emailPasswordInput = document.getElementById('emailPasswordInput');
    if (emailPasswordInput) emailPasswordInput.placeholder = email.passwordConfigured ? '已配置，留空不修改' : 'SMTP 密码 / 授权码';
    setBadge('smtpStatusBadge', !!email.configured);

    setVal('webdavBaseUrlInput', webdav.baseUrl || 'https://dav.jianguoyun.com/dav/');
    setVal('webdavUsernameInput', webdav.username || '');
    setVal('webdavBackupDirInput', webdav.backupDir || 'todo-app-backups');
    setVal('webdavIntervalInput', webdav.intervalHours || 24);
    setChecked('webdavAutoEnabledToggle', webdav.autoEnabled);
    setVal('webdavPasswordInput', '');
    const webdavPasswordInput = document.getElementById('webdavPasswordInput');
    if (webdavPasswordInput) webdavPasswordInput.placeholder = webdav.passwordConfigured ? '已配置，留空不修改' : '坚果云应用密码';
    setBadge('backupStatusBadge', !!webdav.configured);
    renderBackupStatus();
  }

  function settingsPayloadFromForm() {
    const value = id => (document.getElementById(id)?.value || '').trim();
    const checked = id => !!document.getElementById(id)?.checked;
    const payload = {
      email: {
        enabled: checked('emailEnabledToggle'),
        checkTime: value('checkTimeInput') || '09:00',
        host: value('emailHostInput'),
        port: Number(value('emailPortInput')) || 465,
        secure: checked('emailSecureToggle'),
        user: value('emailUserInput'),
        fromName: value('emailFromNameInput') || 'TODO提醒',
        from: value('emailFromInput'),
        recipients: value('emailRecipientsInput'),
      },
      webdav: {
        baseUrl: value('webdavBaseUrlInput') || 'https://dav.jianguoyun.com/dav/',
        username: value('webdavUsernameInput'),
        backupDir: value('webdavBackupDirInput') || 'todo-app-backups',
        autoEnabled: checked('webdavAutoEnabledToggle'),
        intervalHours: Number(value('webdavIntervalInput')) || 24,
      },
    };
    const emailPassword = document.getElementById('emailPasswordInput')?.value || '';
    const webdavPassword = document.getElementById('webdavPasswordInput')?.value || '';
    if (emailPassword) payload.email.password = emailPassword;
    if (webdavPassword) payload.webdav.password = webdavPassword;
    return payload;
  }

  async function openSettingsModal(source) {
    resetSettingsDisclosure();
    showModal('settingsModal', source || document.getElementById('settingsBtn'));
    populateSettingsForm();
    populateAuthForm();
    setResult('settingsSaveResult', '正在读取配置…');
    try {
      await refreshSettings();
      setResult('settingsSaveResult', '');
    } catch (e) {
      setResult('settingsSaveResult', e.message, 'error');
    }
  }

  function closeSettingsModal() {
    hideModal('settingsModal');
  }

  async function saveSettings() {
    setButtonBusy('saveSettingsBtn', true, '保存中…');
    setResult('settingsSaveResult', '正在保存配置…');
    try {
      const res = await fetch(API + '/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(settingsPayloadFromForm()),
      });
      const updated = await res.json();
      if (!res.ok) throw new Error(updated.error || '保存配置失败');
      settings = normalizeSettings(updated);
      backupStatus = settings.backup || settings.webdav || backupStatus;
      backupTestState = null;
      backupRemoteState = null;
      populateSettingsForm();
      setResult('settingsSaveResult', '✅ 配置已保存，服务端已按新配置生效。', 'ok');
    } catch (e) {
      setResult('settingsSaveResult', `❌ ${e.message}`, 'error');
    } finally {
      setButtonBusy('saveSettingsBtn', false);
    }
  }

  async function testEmailSettings() {
    setButtonBusy('testEmailBtn', true, '测试中…');
    setResult('emailTestResult', '正在发送测试邮件…');
    try {
      const payload = settingsPayloadFromForm();
      const res = await fetch(API + '/settings/test-email', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || '邮件测试失败');
      setResult('emailTestResult', `✅ 测试邮件已发送至 ${data.to || payload.email.recipients}`, 'ok');
    } catch (e) {
      setResult('emailTestResult', `❌ ${e.message}`, 'error');
    } finally {
      setButtonBusy('testEmailBtn', false);
    }
  }

  function formatBytes(bytes) {
    if (!Number.isFinite(bytes)) return '-';
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / 1024 / 1024).toFixed(1) + ' MB';
  }

  function renderBackupStatus() {
    const settingsWebdav = normalizeSettings(settings).webdav;
    const status = { ...settingsWebdav, ...(backupStatus || {}) };
    const configured = !!status.configured;
    setBadge('backupStatusBadge', configured);

    const meta = document.getElementById('backupMeta');
    const btn = document.getElementById('backupNowBtn');
    const syncBtn = document.getElementById('syncBackupBtn');
    if (btn) btn.disabled = !configured;
    if (syncBtn) syncBtn.disabled = !configured;
    if (meta) {
      meta.textContent = `目录：${status.backupDir || 'todo-app-backups'} · 增量上传 / 完整快照 · ${status.autoEnabled ? `自动备份：每 ${status.intervalHours || 24} 小时` : '自动备份：未启用'}`;
    }

    if (!configured) {
      setBackupActionHint(
        backupTestState?.success
          ? '连接测试成功，请点击“保存配置”；保存后才能执行备份或云端同步。'
          : '请先保存配置；测试按钮使用临时表单数据，不会自动保存应用密码。',
        backupTestState?.success ? 'ok' : 'muted',
      );
    } else if (backupRemoteState?.state === 'valid') {
      setBackupActionHint(`${backupRemoteSummary(backupRemoteState)} 首次使用建议先点“与云端同步”。`, 'ok');
    } else if (backupRemoteState?.state === 'invalid') {
      setBackupActionHint('检测到云端目录，但快照不可用；请检查目录或改用新的备份目录。', 'error');
    } else {
      setBackupActionHint('配置已保存。首次使用请先点“与云端同步”，系统会先检查云端再合并。', 'muted');
    }

    const lastBackup = status.lastBackup || backupStatus?.lastBackup;
    if (lastBackup?.success) {
      setResult('backupResult', `最近同步：${new Date(lastBackup.createdAt).toLocaleString()} · 上传对象 ${lastBackup.uploadedObjects ?? '-'} 个，复用 ${lastBackup.reusedObjects ?? '-'} 个 · ${lastBackup.noteCount ?? 0} 个笔记 · ${formatBytes(lastBackup.bytes)}`);
    } else if (lastBackup?.error) {
      setResult('backupResult', `最近备份失败：${lastBackup.error}`, 'error');
    } else {
      setResult('backupResult', configured ? '配置完整，可测试连接或立即备份。' : '请填写坚果云账号和应用密码。');
    }
  }

  async function refreshBackupStatus() {
    try {
      const res = await fetch(API + '/backup/status?_=' + Date.now());
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || '读取备份状态失败');
      backupStatus = data;
      settings = normalizeSettings({ ...settings, webdav: { ...normalizeSettings(settings).webdav, ...data } });
      renderBackupStatus();
    } catch (e) {
      console.error(e);
    }
  }

  async function testWebdavSettings() {
    setButtonBusy('testWebdavBtn', true, '测试中…');
    setResult('backupResult', '正在连接坚果云 WebDAV…');
    try {
      const res = await fetch(API + '/backup/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(settingsPayloadFromForm()),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || '坚果云测试失败');
      backupTestState = data;
      backupRemoteState = data.remote || null;
      const remoteCopy = backupRemoteSummary(data.remote);
      setResult('backupResult', `✅ 坚果云连接成功：${data.backupDir || 'todo-app-backups'}（${data.durationMs}ms）${remoteCopy ? ` ${remoteCopy}` : ''}`, 'ok');
      setBackupActionHint('连接测试成功，请点击“保存配置”；保存后才能执行备份或云端同步。', 'ok');
    } catch (e) {
      setResult('backupResult', `❌ ${e.message}`, 'error');
    } finally {
      setButtonBusy('testWebdavBtn', false);
    }
  }

  async function runCloudBackup() {
    const status = backupStatus || {};
    if (!status.configured) { renderBackupStatus(); return; }
    setButtonBusy('backupNowBtn', true, '备份中…');
    setResult('backupResult', '正在同步数据库和 Markdown 变更…');
    try {
      const res = await fetch(API + '/backup/run', { method: 'POST' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || '备份失败');
      backupStatus = { ...backupStatus, configured: true, lastBackup: data };
      settings = normalizeSettings({ ...settings, backup: backupStatus });
      setResult('backupResult', `✅ 同步完成：上传对象 ${data.uploadedObjects} 个，复用 ${data.reusedObjects} 个 · ${data.noteCount} 个笔记 · ${formatBytes(data.bytes)}`, 'ok');
    } catch (e) {
      backupStatus = { ...backupStatus, lastBackup: { success: false, error: e.message, createdAt: new Date().toISOString() } };
      setResult('backupResult', `❌ ${e.message}`, 'error');
    } finally {
      setButtonBusy('backupNowBtn', false);
      renderBackupStatus();
    }
  }

  function openBackupSyncModal() {
    const status = backupStatus || {};
    if (!status.configured) { renderBackupStatus(); return; }
    syncPreflightReady = false;
    const summary = document.getElementById('backupSyncSummary');
    const confirm = document.getElementById('confirmBackupSyncBtn');
    if (summary) summary.textContent = '正在检查云端目录和最新快照…';
    if (confirm) confirm.disabled = true;
    showModal('backupSyncModal', document.getElementById('syncBackupBtn'));
    inspectBackupBeforeSync();
  }

  async function inspectBackupBeforeSync() {
    const summary = document.getElementById('backupSyncSummary');
    const confirm = document.getElementById('confirmBackupSyncBtn');
    try {
      const res = await fetch(API + '/backup/inspect', { method: 'POST' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || '云端检查失败');
      backupRemoteState = data;
      if (data.state === 'invalid') {
        if (summary) summary.textContent = `${backupRemoteSummary(data)} 已停止同步，避免覆盖可能有问题的云端数据。`;
        if (confirm) confirm.disabled = true;
        return;
      }
      if (summary) {
        summary.textContent = data.state === 'empty'
          ? '云端目录已存在，但没有快照；本地数据会被安全地上传为第一份快照。'
          : `${backupRemoteSummary(data)} 同步后本地和云端新增内容都会保留。`;
      }
      syncPreflightReady = true;
      if (confirm) confirm.disabled = false;
    } catch (e) {
      if (summary) summary.textContent = `云端检查失败：${e.message} 请修正配置后重试。`;
      if (confirm) confirm.disabled = true;
    }
  }

  function closeBackupSyncModal() {
    hideModal('backupSyncModal');
  }

  async function confirmBackupSync() {
    const status = backupStatus || {};
    if (!status.configured) { closeBackupSyncModal(); renderBackupStatus(); return; }
    if (!syncPreflightReady) return;
    setButtonBusy('confirmBackupSyncBtn', true, '同步中…');
    setButtonBusy('syncBackupBtn', true, '同步中…');
    setResult('backupResult', '正在校验并合并本地与云端数据，请稍候…');
    closeBackupSyncModal();
    try {
      const res = await fetch(API + '/backup/sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || '云端同步失败');
      await loadData();
      backupStatus = { ...backupStatus, configured: true, lastBackup: data };
      settings = normalizeSettings({ ...settings, backup: backupStatus });
      renderBackupStatus();
      const sync = data.sync || {};
      const pending = data.cloudSyncPending ? '；云端上传失败，本地结果已保留，请稍后重试' : '';
      setResult('backupResult', `✅ ${data.message || '合并同步完成'} 本地新增 ${sync.localOnlyTodos ?? 0} 项，云端新增 ${sync.cloudOnlyTodos ?? 0} 项，冲突 ${sync.conflictingTodos ?? 0} 项${pending}`, data.cloudSyncPending ? 'error' : 'ok');
    } catch (e) {
      setResult('backupResult', `❌ ${e.message}`, 'error');
    } finally {
      setButtonBusy('confirmBackupSyncBtn', false);
      setButtonBusy('syncBackupBtn', false);
    }
  }

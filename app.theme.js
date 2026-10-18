/* Personal Todo Vault — 外观主题：手动 / 跟随系统 / 按时间自动切换
   经典 script 依序加载、共享全局作用域；依赖 app.core.js 先行。 */
  /* ── Theme ── */
  function initTheme() {
    const storedMode = getStoredValue(THEME_MODE_KEY);
    const storedTheme = getStoredValue('todo-theme');
    const storedLightStart = getStoredValue(THEME_LIGHT_START_KEY);
    const storedDarkStart = getStoredValue(THEME_DARK_START_KEY);
    themeMode = ['manual', 'system', 'schedule'].includes(storedMode) ? storedMode : 'manual';
    manualTheme = storedTheme === 'dark' ? 'dark' : 'light';
    themeLightStart = isValidThemeTime(storedLightStart) ? storedLightStart : '07:00';
    themeDarkStart = isValidThemeTime(storedDarkStart) ? storedDarkStart : '19:00';
    applyResolvedTheme();
    initThemeListeners();
  }
  function getStoredValue(key) {
    try { return localStorage.getItem(key) || ''; } catch (e) { return ''; }
  }
  function setStoredValue(key, value) {
    try { localStorage.setItem(key, value); } catch (e) {}
  }
  function isValidThemeTime(value) {
    return typeof value === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(value);
  }
  function minutesFromThemeTime(value) {
    const [hours, minutes] = value.split(':').map(Number);
    return hours * 60 + minutes;
  }
  function isLightScheduleTime(nowMinutes) {
    const lightStart = minutesFromThemeTime(themeLightStart);
    const darkStart = minutesFromThemeTime(themeDarkStart);
    if (lightStart === darkStart) return true;
    return lightStart < darkStart
      ? nowMinutes >= lightStart && nowMinutes < darkStart
      : nowMinutes >= lightStart || nowMinutes < darkStart;
  }
  function resolveTheme() {
    if (themeMode === 'system') {
      return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    }
    if (themeMode === 'schedule') {
      const now = new Date();
      const nowMinutes = now.getHours() * 60 + now.getMinutes();
      return isLightScheduleTime(nowMinutes) ? 'light' : 'dark';
    }
    return manualTheme;
  }
  function applyResolvedTheme() {
    setTheme(resolveTheme(), { persist: false });
  }
  function themeModeLabel(mode = themeMode) {
    return mode === 'system' ? '跟随系统' : mode === 'schedule' ? '按时间' : '手动';
  }
  function setTheme(t, { persist = true } = {}) {
    if (t !== 'dark' && t !== 'light') t = 'light';
    document.documentElement.setAttribute('data-theme', t);
    if (persist) {
      manualTheme = t;
      setStoredValue('todo-theme', t);
    }
    const button = document.getElementById('themeToggle');
    if (button) {
      button.textContent = t === 'dark' ? '☀️' : '🌙';
      button.title = `切换主题（${t === 'dark' ? '深色' : '浅色'} · ${themeModeLabel()}）`;
      button.setAttribute('aria-label', button.title);
    }
  }
  function toggleTheme() {
    const cur = document.documentElement.getAttribute('data-theme') || 'light';
    if (themeMode !== 'manual') {
      themeMode = 'manual';
      setStoredValue(THEME_MODE_KEY, themeMode);
      populateThemeForm();
    }
    setTheme(cur === 'dark' ? 'light' : 'dark');
    const button = document.getElementById('themeToggle');
    if (button && !prefersReducedMotion() && button.animate) {
      button.animate([
        { transform: 'rotate(-12deg) scale(0.9)' },
        { transform: 'rotate(8deg) scale(1.08)' },
        { transform: 'rotate(0) scale(1)' }
      ], { duration: 260, easing: 'cubic-bezier(0.16, 1, 0.3, 1)' });
    }
  }
  function initThemeListeners() {
    themeMediaQuery = window.matchMedia?.('(prefers-color-scheme: dark)') || null;
    themeMediaQuery?.addEventListener?.('change', () => {
      if (themeMode === 'system') applyResolvedTheme();
    });
    window.addEventListener('storage', e => {
      if (![THEME_MODE_KEY, 'todo-theme', THEME_LIGHT_START_KEY, THEME_DARK_START_KEY].includes(e.key)) return;
      const storedMode = getStoredValue(THEME_MODE_KEY);
      themeMode = ['manual', 'system', 'schedule'].includes(storedMode) ? storedMode : 'manual';
      const storedTheme = getStoredValue('todo-theme');
      manualTheme = storedTheme === 'dark' ? 'dark' : 'light';
      const storedLightStart = getStoredValue(THEME_LIGHT_START_KEY);
      const storedDarkStart = getStoredValue(THEME_DARK_START_KEY);
      if (isValidThemeTime(storedLightStart)) themeLightStart = storedLightStart;
      if (isValidThemeTime(storedDarkStart)) themeDarkStart = storedDarkStart;
      applyResolvedTheme();
      refreshThemeTimer();
      populateThemeForm();
    });
    refreshThemeTimer();
  }
  function refreshThemeTimer() {
    window.clearInterval(themeScheduleTimer);
    themeScheduleTimer = null;
    if (themeMode === 'schedule') {
      themeScheduleTimer = window.setInterval(applyResolvedTheme, 30000);
    }
  }
  function populateThemeForm() {
    document.querySelectorAll('input[name="themeMode"]').forEach(input => {
      input.checked = input.value === themeMode;
    });
    const lightInput = document.getElementById('themeLightStartInput');
    const darkInput = document.getElementById('themeDarkStartInput');
    if (lightInput) lightInput.value = themeLightStart;
    if (darkInput) darkInput.value = themeDarkStart;
    const scheduleFields = document.getElementById('themeScheduleFields');
    if (scheduleFields) scheduleFields.hidden = themeMode !== 'schedule';
    const hint = document.getElementById('themeScheduleHint');
    if (hint) {
      hint.textContent = themeMode === 'schedule'
        ? `每天 ${themeLightStart}–${themeDarkStart} 使用浅色，其余时间使用深色。`
        : themeMode === 'system'
          ? '系统主题变化时会自动同步；右上角按钮仍可临时切换为手动模式。'
          : '右上角按钮控制当前主题；切换后会保存在当前浏览器。';
    }
    const badge = document.getElementById('themeStatusBadge');
    if (badge) badge.textContent = themeModeLabel();
  }
  function setThemeMode(mode) {
    if (!['manual', 'system', 'schedule'].includes(mode)) return;
    if (mode === 'manual') {
      const current = document.documentElement.getAttribute('data-theme');
      if (current === 'dark' || current === 'light') manualTheme = current;
    }
    themeMode = mode;
    setStoredValue(THEME_MODE_KEY, themeMode);
    applyResolvedTheme();
    refreshThemeTimer();
    populateThemeForm();
  }
  function handleThemePreferenceChange() {
    const selected = document.querySelector('input[name="themeMode"]:checked');
    if (selected) setThemeMode(selected.value);
  }
  function handleThemeScheduleChange() {
    const lightInput = document.getElementById('themeLightStartInput');
    const darkInput = document.getElementById('themeDarkStartInput');
    if (isValidThemeTime(lightInput?.value)) {
      themeLightStart = lightInput.value;
      setStoredValue(THEME_LIGHT_START_KEY, themeLightStart);
    }
    if (isValidThemeTime(darkInput?.value)) {
      themeDarkStart = darkInput.value;
      setStoredValue(THEME_DARK_START_KEY, themeDarkStart);
    }
    applyResolvedTheme();
    populateThemeForm();
  }

  function resetSettingsDisclosure() {
    document.querySelectorAll('details.settings-disclosure').forEach(section => {
      section.open = false;
    });
  }
  function initSettingsDisclosure() {
    resetSettingsDisclosure();
  }

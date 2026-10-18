
  const API = '/api';
  let categories = [];
  let todos = [];
  let activeCatId = null; // null = 全部
  let editingCatId = null;
  let editingTodoId = null;
  const todoEditDrafts = new Map();
  const todoEditSaving = new Set();
  let editingProgressTodoId = null;
  let editingReminderTodoId = null;
  const COMPLETED_PAGE_SIZE = 10;
  let completedPage = 1;
  let settings = {
    email: { enabled: false, checkTime: '09:00', host: 'smtp.163.com', port: 465, secure: true, user: '', passwordConfigured: false, fromName: 'TODO提醒', from: '', recipients: '', configured: false },
    webdav: { provider: 'jianguoyun', baseUrl: 'https://dav.jianguoyun.com/dav/', username: '', passwordConfigured: false, backupDir: 'todo-app-backups', autoEnabled: false, intervalHours: 24, configured: false },
    emailEnabled: false, checkTime: '09:00', smtpReady: false, backup: null
  };
  let backupStatus = { configured: false, backupDir: 'todo-app-backups', provider: 'jianguoyun', lastBackup: null };
  let backupTestState = null;
  let backupRemoteState = null;
  let syncPreflightReady = false;
  let selectedIcon = '🏷️';
  let selectedAddCatId = localStorage.getItem('lastUsedCatId') || 'cat_default';
  let defaultCatId = null; // resolved after categories load
  const THEME_MODE_KEY = 'todo-theme-mode';
  const THEME_LIGHT_START_KEY = 'todo-theme-light-start';
  const THEME_DARK_START_KEY = 'todo-theme-dark-start';
  let themeMode = 'manual';
  let manualTheme = 'light';
  let themeLightStart = '07:00';
  let themeDarkStart = '19:00';
  let themeMediaQuery = null;
  let themeScheduleTimer = null;
  let modalScrollState = null;
  let viewMode = 'list';
  let selectedAddDueDate = '';
  let selectedAddDueTime = '';
  let selectedAddDueHour = '';
  let selectedAddDueMinute = '';
  let addDuePickerMonth = new Date();
  let calendarViewDate = new Date();
  const MOBILE_LONG_PRESS_MS = 560;
  let mobileLongPressTimer = null;
  let mobileLongPressState = null;
  let mobileSuppressClickUntil = 0;
  let mobileActionMenuTodoId = null;

  const PRESET_ICONS = [
    '🏷️','📋','📥','📌','📍','💰','💎','💳','🎬','🎥','🎞️','📺',
    '📚','📖','📕','🎮','🕹️','🎯','⚽','🏀','🎸','🎨',
    '🍳','☕','🍺','🍜','🏠','🚗','✈️','💼','🏢','📱',
    '💻','🔧','🔬','📊','📈','📉','🧘','🏃','🌱','🌸',
    '🎁','⭐','🔥','💡','⚡','🎉','🎊','👀','✔️','❌',
    '🗑️','✏️','📝','📧','🛒','🎒','🏋️','🧗','🚴','🏊',
    '🎵','🎤','🎬','📷','🎨','🖼️','🌅','🏞️','🌺','🍀',
    '🌻','🌹','🍎','🍕','🎂','🍦','🧃','🍷','🏨','🛵'
  ];

  document.addEventListener('DOMContentLoaded', () => {
    initTheme();
    initSettingsDisclosure();
    initSidebarWidth();
    initModalScrollGuards();
    initMobileActionMenu();
    renderViewSwitcher();
    renderAddPriorityLabel();
    resetAddDueDate();
    initAuthGate().then(() => { if (!authGateState.overlayShown) loadData(); });
    initIconGrid();
    document.getElementById('todoInput').addEventListener('keypress', e => {
      if (e.key === 'Enter') addTodo();
    });
    document.getElementById('authPasswordInput').addEventListener('keypress', e => {
      if (e.key === 'Enter') authLogin();
    });
    document.getElementById('catNameInput').addEventListener('keypress', e => {
      if (e.key === 'Enter') saveCatModal();
    });
    // Close dropdowns on outside click
    document.addEventListener('click', e => {
      if (!e.target.closest('#mobile-action-menu-portal')) closeMobileActionMenu();
      if (!e.target.closest('.move-dropdown') && !e.target.closest('.priority-dropdown') &&
          !e.target.closest('.todo-priority-tag') && !e.target.closest('.add-priority-btn') &&
          !e.target.closest('.cat-picker-list') &&
          !e.target.closest('.cat-picker-btn') &&
          !e.target.closest('#addDueDatePicker') &&
          !e.target.closest('#addDueDateBtn')) {
        closeMoveDropdown();
        closePriorityDropdown();
        closeCatPicker();
      }
      if (!e.target.closest('#addDueDatePicker') && !e.target.closest('#addDueDateBtn')) closeAddDueDatePicker();
      if (!e.target.closest('.due-picker-time-menu') && !e.target.closest('.due-picker-time-select')) closeAddDueTimeMenu();
    });
  });

  /* ── Auth gate：访问保护 ── */
  const authGateState = { enabled: false, authed: false, overlayShown: false };
  const authGuardInstalled = { value: false };

  function installAuthFetchGuard() {
    if (authGuardInstalled.value) return;
    authGuardInstalled.value = true;
    const originalFetch = window.fetch.bind(window);
    window.fetch = async function (input, init) {
      const res = await originalFetch(input, init);
      if (res.status === 401 && authGateState.enabled && !authGateState.overlayShown) {
        authGateState.authed = false;
        authGateState.overlayShown = true;
        showModal('authGate');
        showToast('登录状态已失效，请重新解锁');
        document.getElementById('authPasswordInput')?.focus();
      }
      return res;
    };
  }

  async function initAuthGate() {
    try {
      const res = await fetch(API + '/auth/status?_=' + Date.now());
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || '访问状态读取失败');
      authGateState.enabled = !!data.enabled;
      authGateState.authed = !!data.authed;
    } catch (e) {
      console.error('[AUTH] status check failed:', e);
      return;
    }
    if (authGateState.enabled) {
      installAuthFetchGuard();
      if (!authGateState.authed) {
        authGateState.overlayShown = true;
        showModal('authGate');
        document.getElementById('authPasswordInput')?.focus();
      }
    }
  }

  function showAuthGateError(message, shake = true) {
    const errorEl = document.getElementById('authGateError');
    const input = document.getElementById('authPasswordInput');
    if (errorEl) {
      errorEl.textContent = message || '';
      if (message && shake) {
        errorEl.classList.remove('shake-text');
        void errorEl.offsetWidth;
        errorEl.classList.add('shake-text');
      }
    }
    if (shake && input) {
      input.classList.add('shake');
      setTimeout(() => input.classList.remove('shake'), 350);
    }
  }

  async function authLogin() {
    const input = document.getElementById('authPasswordInput');
    const remember = !!document.getElementById('authRememberToggle')?.checked;
    const password = input.value;
    if (!password) {
      showAuthGateError('请输入访问密码');
      return;
    }
    setButtonBusy('authLoginBtn', true, '解锁中…');
    document.getElementById('authGateError').textContent = '';
    try {
      const res = await fetch(API + '/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password, remember }),
      });
      const data = await res.json();
      if (!res.ok) {
        input.value = '';
        showAuthGateError(data.error || (data.retryAfterMs ? '尝试过于频繁，请稍后重试' : '密码错误'));
        return;
      }
      input.value = '';
      authGateState.authed = true;
      authGateState.overlayShown = false;
      hideModal('authGate');
      showToast('✅ 已解锁');
      document.getElementById('authGateError').textContent = '';
      loadData();
    } catch (e) {
      showAuthGateError(e.message || '网络错误，请重试', false);
    } finally {
      setButtonBusy('authLoginBtn', false);
    }
  }

  async function refreshAuthStatus() {
    const res = await fetch(API + '/auth/status?_=' + Date.now());
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || '读取访问控制状态失败');
    return data;
  }

  async function populateAuthForm() {
    try {
      const status = await refreshAuthStatus();
      authGateState.enabled = !!status.enabled;
      authGateState.authed = !!status.authed;
      setBadge('authStatusBadge', status.enabled, '🔒 密码已启用', '🔓 未启用');
      document.getElementById('authDisabledControls').hidden = !!status.enabled;
      document.getElementById('authEnabledControls').hidden = !status.enabled;
      for (const id of ['authNewPasswordInput', 'authConfirmPasswordInput', 'authCurrentPasswordInput', 'authNewPassword2Input', 'authNewPasswordConfirmInput']) {
        const el = document.getElementById(id);
        if (el) el.value = '';
      }
      setResult('authEnableResult', '');
      setResult('authManageResult', '');
    } catch (e) {
      setResult('authEnableResult', `读取状态失败：${e.message}`, 'error');
    }
  }

  async function enableAuthFromSettings() {
    const newPassword = document.getElementById('authNewPasswordInput').value;
    const confirm = document.getElementById('authConfirmPasswordInput').value;
    if (newPassword.length < 6) { setResult('authEnableResult', '❌ 访问密码至少 6 个字符', 'error'); return; }
    if (newPassword !== confirm) { setResult('authEnableResult', '❌ 两次输入的密码不一致', 'error'); return; }
    setButtonBusy('authEnableBtn', true, '启用中…');
    try {
      const res = await fetch(API + '/auth/password', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ currentPassword: '', newPassword }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || '启用失败');
      showToast('🔒 密码保护已启用');
      await populateAuthForm();
    } catch (e) {
      setResult('authEnableResult', `❌ ${e.message}`, 'error');
    } finally {
      setButtonBusy('authEnableBtn', false);
    }
  }

  async function changeAuthPasswordFromSettings() {
    const current = document.getElementById('authCurrentPasswordInput').value;
    const next = document.getElementById('authNewPassword2Input').value;
    const confirm = document.getElementById('authNewPasswordConfirmInput').value;
    if (!current) { setResult('authManageResult', '❌ 请输入当前密码', 'error'); return; }
    if (next.length < 6) { setResult('authManageResult', '❌ 新密码至少 6 个字符', 'error'); return; }
    if (next !== confirm) { setResult('authManageResult', '❌ 两次输入的新密码不一致', 'error'); return; }
    setButtonBusy('authChangeBtn', true, '修改中…');
    try {
      const res = await fetch(API + '/auth/password', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ currentPassword: current, newPassword: next }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || '修改失败');
      showToast('✅ 密码已更新，所有设备需重新登录');
      await populateAuthForm();
    } catch (e) {
      setResult('authManageResult', `❌ ${e.message}`, 'error');
    } finally {
      setButtonBusy('authChangeBtn', false);
    }
  }

  async function disableAuthFromSettings() {
    const current = document.getElementById('authCurrentPasswordInput').value;
    if (!current) { setResult('authManageResult', '❌ 请输入当前密码以确认关闭保护', 'error'); return; }
    setButtonBusy('authDisableBtn', true, '操作中…');
    try {
      const res = await fetch(API + '/auth/disable', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ currentPassword: current }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || '关闭失败');
      authGateState.enabled = false;
      showToast('🔓 密码保护已关闭');
      await populateAuthForm();
    } catch (e) {
      setResult('authManageResult', `❌ ${e.message}`, 'error');
    } finally {
      setButtonBusy('authDisableBtn', false);
    }
  }

  async function logoutFromSettings() {
    setButtonBusy('authLogoutBtn', true, '退出中…');
    try {
      const res = await fetch(API + '/auth/logout', { method: 'POST' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || '退出失败');
      closeSettingsModal();
      if (authGateState.enabled) {
        authGateState.authed = false;
        authGateState.overlayShown = true;
        showModal('authGate');
        document.getElementById('authPasswordInput')?.focus();
      }
      showToast('已退出登录');
    } catch (e) {
      setResult('authManageResult', `❌ ${e.message}`, 'error');
    } finally {
      setButtonBusy('authLogoutBtn', false);
    }
  }

  function prefersReducedMotion() {
    return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  }

  function findTodoElement(id) {
    return [...document.querySelectorAll('.todo-item')].find(el => el.dataset.id === String(id)) || null;
  }

  function isMobileActionMenuViewport() {
    return !!window.matchMedia?.('(max-width: 768px)').matches;
  }

  function isMobileLongPressExcludedTarget(target) {
    return target instanceof Element && !!target.closest(
      'button, a, input, textarea, select, option, .todo-actions, .todo-priority-tag, .todo-cat-tag, .todo-progress-row, .todo-title-editor'
    );
  }

  function clearMobileLongPress() {
    if (mobileLongPressTimer != null) {
      window.clearTimeout(mobileLongPressTimer);
      mobileLongPressTimer = null;
    }
    if (mobileLongPressState?.item) mobileLongPressState.item.classList.remove('mobile-long-pressing');
    mobileLongPressState = null;
  }

  function mobileActionLabel(button) {
    if (button.classList.contains('reminder-action')) return '提醒';
    if (button.classList.contains('note-action')) return '笔记';
    if (button.classList.contains('edit-action')) return '编辑';
    if (button.classList.contains('del')) return '删除';
    return button.title || '操作';
  }

  function closeMobileActionMenu() {
    clearMobileLongPress();
    document.querySelectorAll('.todo-item.mobile-action-menu-open').forEach(item => {
      item.classList.remove('mobile-action-menu-open');
    });
    const menu = document.getElementById('mobile-action-menu-portal');
    if (menu) {
      menu.classList.remove('show');
      menu.hidden = true;
      menu.style.removeProperty('left');
      menu.style.removeProperty('top');
      menu.style.removeProperty('visibility');
    }
    mobileActionMenuTodoId = null;
  }

  function openMobileActionMenu(todoItem, anchor = {}) {
    if (!isMobileActionMenuViewport() || !todoItem?.isConnected) return;
    const todoId = todoItem.dataset.id;
    const todo = todos.find(item => item.id === todoId);
    const menu = document.getElementById('mobile-action-menu-portal');
    const grid = document.getElementById('mobile-action-menu-grid');
    if (!todo || !menu || !grid) return;

    window.getSelection?.()?.removeAllRanges();
    closeMobileActionMenu();
    mobileActionMenuTodoId = todoId;
    todoItem.classList.add('mobile-action-menu-open');
    menu.setAttribute('aria-label', '待办操作');
    grid.replaceChildren();

    const sourceButtons = [...todoItem.querySelectorAll('.todo-actions .todo-act-btn')];
    sourceButtons.forEach(sourceButton => {
      const item = document.createElement('button');
      const icon = document.createElement('span');
      const label = document.createElement('span');
      const actionLabel = mobileActionLabel(sourceButton);
      item.type = 'button';
      item.className = `mobile-action-menu-item${sourceButton.classList.contains('del') ? ' danger' : ''}`;
      item.setAttribute('role', 'menuitem');
      item.setAttribute('aria-label', actionLabel);
      icon.className = 'menu-action-icon';
      icon.setAttribute('aria-hidden', 'true');
      icon.textContent = sourceButton.textContent.trim();
      label.className = 'menu-action-label';
      label.textContent = actionLabel;
      item.append(icon, label);
      item.addEventListener('click', event => {
        event.stopPropagation();
        closeMobileActionMenu();
        sourceButton.click();
      });
      grid.append(item);
    });

    if (!sourceButtons.length) {
      closeMobileActionMenu();
      return;
    }

    menu.hidden = false;
    menu.style.visibility = 'hidden';
    const cardRect = todoItem.getBoundingClientRect();
    const menuRect = menu.getBoundingClientRect();
    const viewportPadding = 12;
    const anchorX = Number.isFinite(anchor.x) ? anchor.x : cardRect.left + cardRect.width / 2;
    const anchorY = Number.isFinite(anchor.y) ? anchor.y : cardRect.top + cardRect.height / 2;
    const gap = 10;
    const maxLeft = Math.max(viewportPadding, window.innerWidth - menuRect.width - viewportPadding);
    const maxTop = Math.max(viewportPadding, window.innerHeight - menuRect.height - viewportPadding);
    let left = anchorX + gap;
    if (left > maxLeft) left = anchorX - menuRect.width - gap;
    left = Math.min(Math.max(viewportPadding, left), maxLeft);
    let top = anchorY + gap;
    if (top > maxTop) top = anchorY - menuRect.height - gap;
    top = Math.min(Math.max(viewportPadding, top), maxTop);
    menu.style.left = `${left}px`;
    menu.style.top = `${top}px`;
    menu.style.visibility = 'visible';
    requestAnimationFrame(() => {
      if (mobileActionMenuTodoId !== todoId || menu.hidden) return;
      menu.classList.add('show');
      menu.querySelector('.mobile-action-menu-item')?.focus({ preventScroll: true });
    });
  }

  function initMobileActionMenu() {
    document.addEventListener('pointerdown', event => {
      if (!isMobileActionMenuViewport() || event.pointerType === 'mouse' || event.isPrimary === false) return;
      if (event.target.closest('#mobile-action-menu-portal')) return;
      closeMobileActionMenu();
      if (isMobileLongPressExcludedTarget(event.target)) return;
      const todoItem = event.target.closest('.todo-item');
      if (!todoItem || todoItem.classList.contains('editing')) return;
      clearMobileLongPress();
      mobileLongPressState = {
        item: todoItem,
        pointerId: event.pointerId,
        x: event.clientX,
        y: event.clientY,
        triggered: false,
      };
      todoItem.classList.add('mobile-long-pressing');
      mobileLongPressTimer = window.setTimeout(() => {
        const state = mobileLongPressState;
        if (!state || state.item !== todoItem || state.pointerId !== event.pointerId) return;
        state.triggered = true;
        mobileSuppressClickUntil = Date.now() + 900;
        todoItem.classList.remove('mobile-long-pressing');
        openMobileActionMenu(todoItem, { x: state.x, y: state.y });
        navigator.vibrate?.(10);
      }, MOBILE_LONG_PRESS_MS);
    });

    document.addEventListener('pointermove', event => {
      const state = mobileLongPressState;
      if (!state || state.pointerId !== event.pointerId || state.triggered) return;
      const movedX = event.clientX - state.x;
      const movedY = event.clientY - state.y;
      if (Math.hypot(movedX, movedY) > 10) clearMobileLongPress();
    }, { passive: true });

    document.addEventListener('pointerup', event => {
      const state = mobileLongPressState;
      if (!state || state.pointerId !== event.pointerId) return;
      clearMobileLongPress();
      if (state.triggered) event.preventDefault();
    });
    document.addEventListener('pointercancel', clearMobileLongPress);
    document.addEventListener('contextmenu', event => {
      if (!isMobileActionMenuViewport()) return;
      if (event.target.closest('#mobile-action-menu-portal')) {
        event.preventDefault();
        return;
      }
      const todoItem = event.target.closest('.todo-item');
      if (!todoItem || todoItem.classList.contains('editing') || isMobileLongPressExcludedTarget(event.target)) return;
      event.preventDefault();
      clearMobileLongPress();
      openMobileActionMenu(todoItem, { x: event.clientX, y: event.clientY });
    });
    document.addEventListener('click', event => {
      if (!mobileSuppressClickUntil) return;
      const shouldSuppress = Date.now() <= mobileSuppressClickUntil;
      mobileSuppressClickUntil = 0;
      if (shouldSuppress && event.target.closest('.todo-item')) {
        event.preventDefault();
        event.stopPropagation();
      }
    }, true);
    document.addEventListener('keydown', event => {
      if (event.key === 'Escape' && mobileActionMenuTodoId) {
        event.preventDefault();
        closeMobileActionMenu();
      }
    });
    document.addEventListener('scroll', closeMobileActionMenu, { capture: true, passive: true });
    window.addEventListener('resize', closeMobileActionMenu);
  }

  function animateTodoItem(id) {
    const el = findTodoElement(id);
    if (!el || prefersReducedMotion()) return;
    el.classList.remove('motion-enter');
    void el.offsetWidth;
    el.classList.add('motion-enter');
    el.addEventListener('animationend', () => el.classList.remove('motion-enter'), { once: true });
  }

  function animateTodoTransition(id, firstRect) {
    const el = findTodoElement(id);
    if (!el) return;
    const checkbox = el.querySelector('.checkbox');
    if (el.classList.contains('completed') && checkbox && !prefersReducedMotion()) {
      checkbox.classList.remove('just-checked');
      void checkbox.offsetWidth;
      checkbox.classList.add('just-checked');
      checkbox.addEventListener('animationend', () => checkbox.classList.remove('just-checked'), { once: true });
    }
    if (!firstRect || prefersReducedMotion() || !el.animate) return;
    const lastRect = el.getBoundingClientRect();
    const dx = firstRect.left - lastRect.left;
    const dy = firstRect.top - lastRect.top;
    const canFlip = Number.isFinite(dx) && Number.isFinite(dy) && Math.abs(dy) < Math.max(window.innerHeight * 1.5, 900);
    if (!canFlip) {
      animateTodoItem(id);
      return;
    }
    const targetOpacity = el.classList.contains('completed') ? 0.5 : 1;
    const animation = el.animate([
      { transform: `translate(${dx}px, ${dy}px)`, opacity: Math.min(1, targetOpacity + 0.35) },
      { transform: 'translate(0, 0)', opacity: targetOpacity }
    ], { duration: 360, easing: 'cubic-bezier(0.16, 1, 0.3, 1)' });
    animation.onfinish = () => {
      el.style.removeProperty('transform');
      el.style.removeProperty('opacity');
    };
  }

  function animateListChange() {
    if (prefersReducedMotion()) return;
    document.querySelectorAll('.todo-list').forEach(list => {
      if (!list.children.length || list.offsetParent === null) return;
      list.classList.remove('motion-list-change');
      void list.offsetWidth;
      list.classList.add('motion-list-change');
      list.addEventListener('animationend', () => list.classList.remove('motion-list-change'), { once: true });
    });
  }

  function clearModalMotion(modal) {
    if (modal._motionFrame != null) {
      window.cancelAnimationFrame(modal._motionFrame);
      modal._motionFrame = null;
    }
    if (modal._motionAnimation) {
      modal._motionAnimation.cancel();
      modal._motionAnimation = null;
    }
    const panel = modal.querySelector('.modal');
    if (panel) panel.style.removeProperty('transform-origin');
  }

  function hasOpenModal() {
    return [...document.querySelectorAll('.modal-overlay')].some(modal =>
      modal.classList.contains('show') || modal.classList.contains('closing'));
  }

  function lockModalScroll() {
    if (modalScrollState) return;
    const body = document.body;
    const html = document.documentElement;
    const scrollY = window.scrollY || html.scrollTop || 0;
    const scrollbarWidth = Math.max(0, window.innerWidth - html.clientWidth);
    modalScrollState = {
      scrollY,
      top: body.style.top,
      paddingRight: body.style.paddingRight,
    };
    html.classList.add('modal-scroll-locked');
    body.classList.add('modal-scroll-locked');
    body.style.top = `-${scrollY}px`;
    if (scrollbarWidth > 0) body.style.paddingRight = `${scrollbarWidth}px`;
  }

  function unlockModalScroll() {
    if (!modalScrollState) return;
    const body = document.body;
    const html = document.documentElement;
    const { scrollY, top, paddingRight } = modalScrollState;
    modalScrollState = null;
    html.classList.remove('modal-scroll-locked');
    body.classList.remove('modal-scroll-locked');
    body.style.top = top;
    body.style.paddingRight = paddingRight;
    window.scrollTo(0, scrollY);
  }

  function initModalScrollGuards() {
    document.querySelectorAll('.modal-overlay').forEach(overlay => {
      const preventBackdropScroll = event => {
        if (!event.target.closest('.modal')) event.preventDefault();
      };
      overlay.addEventListener('wheel', preventBackdropScroll, { passive: false });
      overlay.addEventListener('touchmove', preventBackdropScroll, { passive: false });
    });
  }

  function finishModalClose(modal) {
    clearModalMotion(modal);
    modal.classList.remove('show', 'closing', 'origin-motion', 'motion-ready');
    modal._motionSource = null;
    modal._hideTimer = null;
    if (!hasOpenModal()) unlockModalScroll();
  }

  function getModalOrigin(modal, source) {
    const panel = modal.querySelector('.modal');
    if (!panel || !source?.isConnected || typeof source.getBoundingClientRect !== 'function') return null;
    const sourceRect = source.getBoundingClientRect();
    const panelRect = panel.getBoundingClientRect();
    if (!sourceRect.width || !sourceRect.height || !panelRect.width || !panelRect.height) return null;
    return {
      panel,
      x: sourceRect.left + sourceRect.width / 2 - panelRect.left,
      y: sourceRect.top + sourceRect.height / 2 - panelRect.top,
    };
  }

  function showModal(id, source = null) {
    const modal = document.getElementById(id);
    if (!modal) return;
    lockModalScroll();
    if (modal._hideTimer != null) {
      window.clearTimeout(modal._hideTimer);
      modal._hideTimer = null;
    }
    clearModalMotion(modal);
    modal.classList.remove('show', 'closing', 'origin-motion', 'motion-ready');
    modal._motionSource = null;

    const canUseOriginMotion = source && !prefersReducedMotion() && typeof Element !== 'undefined' && Element.prototype.animate;
    if (!canUseOriginMotion) {
      modal.classList.add('show');
      return;
    }

    modal._motionSource = source;
    modal.classList.add('origin-motion', 'show');
    modal._motionFrame = window.requestAnimationFrame(() => {
      modal._motionFrame = null;
      if (!modal.classList.contains('show') || modal._motionSource !== source) return;
      const origin = getModalOrigin(modal, source);
      if (!origin) {
        modal.classList.remove('origin-motion', 'motion-ready');
        modal._motionSource = null;
        return;
      }
      origin.panel.style.transformOrigin = `${origin.x}px ${origin.y}px`;
      modal.classList.add('motion-ready');
      modal._motionAnimation = origin.panel.animate([
        { opacity: 0, transform: 'scale(0.84)' },
        { opacity: 1, transform: 'scale(1)' }
      ], { duration: 360, easing: 'cubic-bezier(0.16, 1, 0.3, 1)' });
      modal._motionAnimation.onfinish = () => {
        modal._motionAnimation = null;
      };
    });
  }

  function hideModal(id) {
    const modal = document.getElementById(id);
    if (!modal) return;
    if (modal._hideTimer != null) {
      window.clearTimeout(modal._hideTimer);
      modal._hideTimer = null;
    }
    const source = modal._motionSource;
    const shouldReturnToOrigin = modal.classList.contains('origin-motion')
      && !prefersReducedMotion()
      && typeof Element !== 'undefined'
      && Element.prototype.animate;
    const returnOrigin = shouldReturnToOrigin ? getModalOrigin(modal, source) : null;
    clearModalMotion(modal);
    modal.classList.remove('show');
    if (prefersReducedMotion()) {
      finishModalClose(modal);
      return;
    }
    modal.classList.add('closing');
    if (shouldReturnToOrigin) {
      const origin = returnOrigin || getModalOrigin(modal, source);
      if (origin) {
        origin.panel.style.transformOrigin = `${origin.x}px ${origin.y}px`;
        modal.classList.add('origin-motion', 'motion-ready');
        modal._motionAnimation = origin.panel.animate([
          { opacity: 1, transform: 'scale(1)' },
          { opacity: 0, transform: 'scale(0.84)' }
        ], { duration: 190, easing: 'cubic-bezier(0.4, 0, 1, 1)' });
      } else {
        modal.classList.remove('origin-motion', 'motion-ready');
        modal._motionSource = null;
      }
    } else {
      modal.classList.remove('origin-motion', 'motion-ready');
      modal._motionSource = null;
    }
    modal._hideTimer = window.setTimeout(() => finishModalClose(modal), shouldReturnToOrigin ? 205 : 180);
  }

  let toastTimer = null;
  let toastHideTimer = null;

  function showToast(message, duration = 2200) {
    const toast = document.getElementById('appToast');
    if (!toast) return;
    window.clearTimeout(toastTimer);
    window.clearTimeout(toastHideTimer);
    toast.textContent = message;
    toast.hidden = false;
    requestAnimationFrame(() => toast.classList.add('show'));
    toastTimer = window.setTimeout(hideToast, duration);
  }

  function hideToast() {
    const toast = document.getElementById('appToast');
    if (!toast) return;
    toast.classList.remove('show');
    window.clearTimeout(toastHideTimer);
    toastHideTimer = window.setTimeout(() => {
      if (!toast.classList.contains('show')) toast.hidden = true;
    }, prefersReducedMotion() ? 0 : 220);
  }

  /* ── Sidebar width ── */
  function initSidebarWidth() {
    const root = document.documentElement;
    const cssMin = parseFloat(getComputedStyle(root).getPropertyValue('--sidebar-min-w')) || 220;
    const cssMax = parseFloat(getComputedStyle(root).getPropertyValue('--sidebar-max-w')) || 460;
    let saved = null;
    try { saved = parseFloat(localStorage.getItem('sidebar-w')); } catch (e) {}
    const width = saved && saved >= cssMin && saved <= cssMax
      ? saved
      : Math.round(Math.min(Math.max(window.innerWidth * 0.22, cssMin), cssMax));
    root.style.setProperty('--sidebar-w', width + 'px');
    localStorage.setItem('sidebar-w', width);

    const resizer = document.getElementById('sidebarResizer');
    if (!resizer) return;
    let startX, startW, dragging = false;

    const onMove = e => {
      if (!dragging) return;
      const x = e.touches ? e.touches[0].clientX : e.clientX;
      const w = Math.round(Math.min(Math.max(startW + (x - startX), cssMin), cssMax));
      root.style.setProperty('--sidebar-w', w + 'px');
      localStorage.setItem('sidebar-w', w);
      resizer.classList.add('dragging');
    };
    const onDown = e => {
      dragging = true;
      startX = e.touches ? e.touches[0].clientX : e.clientX;
      startW = parseFloat(getComputedStyle(root).getPropertyValue('--sidebar-w')) || startX;
      document.body.classList.add('resizing');
      window.addEventListener('mousemove', onMove);
      window.addEventListener('touchmove', onMove, { passive: false });
    };
    const onUp = () => {
      if (!dragging) return;
      dragging = false;
      document.body.classList.remove('resizing');
      resizer.classList.remove('dragging');
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('touchmove', onMove);
    };
    resizer.addEventListener('mousedown', onDown);
    resizer.addEventListener('touchstart', onDown, { passive: true });
    window.addEventListener('mouseup', onUp);
    window.addEventListener('touchend', onUp);
  }

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

  /* ── Reminder Modal ── */
  function getReminderWeekdays() {
    return [...document.querySelectorAll('input[name="reminderWeekday"]:checked')]
      .map(input => Number(input.value));
  }

  function updateReminderWeekdaysSummary() {
    const names = ['', '周一', '周二', '周三', '周四', '周五', '周六', '周日'];
    const selected = getReminderWeekdays();
    const summary = document.getElementById('reminderWeekdaysSummary');
    const count = document.getElementById('reminderWeekdaysCount');
    const error = document.getElementById('reminderWeekdaysError');
    if (summary) summary.textContent = selected.length === 0
      ? '尚未选择发送日'
      : selected.length === 7
        ? '每天'
        : selected.map(day => names[day]).join('、');
    if (count) count.textContent = `已选 ${selected.length} 天`;
    if (selected.length > 0 && error) error.textContent = '';
  }

  function setReminderWeekdays(preset) {
    const presets = {
      workdays: [1, 2, 3, 4, 5],
      everyday: [1, 2, 3, 4, 5, 6, 7],
      weekend: [6, 7],
      clear: [],
    };
    const selected = new Set(presets[preset] || []);
    document.querySelectorAll('input[name="reminderWeekday"]').forEach(input => {
      input.checked = selected.has(Number(input.value));
    });
    updateReminderWeekdaysSummary();
  }

  function parseReminderTime(value) {
    const raw = String(value || '').trim().replace('：', ':');
    let match = raw.match(/^(\d{1,2}):(\d{1,2})$/);
    if (!match && /^\d{3,4}$/.test(raw)) {
      match = [raw, raw.slice(0, -2), raw.slice(-2)];
    }
    if (!match) return null;
    const hour = Number(match[1]);
    const minute = Number(match[2]);
    if (!Number.isInteger(hour) || !Number.isInteger(minute) || hour > 23 || minute > 59) return null;
    return { hour, minute, value: `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}` };
  }

  function reminderTimePeriod(hour) {
    if (hour < 5) return '深夜';
    if (hour < 12) return '上午';
    if (hour < 14) return '中午';
    if (hour < 18) return '下午';
    return '晚上';
  }

  function reminderTimeScene(hour) {
    if (hour < 7) return '夜间';
    if (hour < 10) return '早间';
    if (hour < 12) return '上午';
    if (hour < 14) return '午间';
    if (hour < 18) return '下午';
    if (hour < 21) return '傍晚';
    return '夜间';
  }

  function updateReminderTimePicker() {
    const input = document.getElementById('reminderTimeInput');
    const parsed = parseReminderTime(input?.value);
    if (!parsed) return;
    const hourValue = document.getElementById('reminderHourValue');
    const minuteValue = document.getElementById('reminderMinuteValue');
    const context = document.getElementById('reminderTimeContext');
    if (hourValue) hourValue.textContent = String(parsed.hour).padStart(2, '0');
    if (minuteValue) minuteValue.textContent = String(parsed.minute).padStart(2, '0');
    if (context) context.textContent = `${reminderTimePeriod(parsed.hour)} · ${reminderTimeScene(parsed.hour)}`;
    document.querySelectorAll('[data-reminder-time]').forEach(button => {
      const active = button.dataset.reminderTime === parsed.value;
      button.classList.toggle('active', active);
      button.setAttribute('aria-pressed', String(active));
    });
    document.querySelectorAll('[data-reminder-minute]').forEach(button => {
      const active = Number(button.dataset.reminderMinute) === parsed.minute;
      button.classList.toggle('active', active);
      button.setAttribute('aria-pressed', String(active));
    });
    const error = document.getElementById('reminderTimeError');
    if (error) error.textContent = '';
  }

  function setReminderTime(value) {
    const parsed = parseReminderTime(value);
    const input = document.getElementById('reminderTimeInput');
    if (!parsed || !input) return;
    input.value = parsed.value;
    updateReminderTimePicker();
  }

  function syncReminderTimePicker() {
    if (parseReminderTime(document.getElementById('reminderTimeInput')?.value)) updateReminderTimePicker();
  }

  function commitReminderTimeInput() {
    const input = document.getElementById('reminderTimeInput');
    const parsed = parseReminderTime(input?.value);
    const error = document.getElementById('reminderTimeError');
    if (!parsed) {
      if (error) error.textContent = '请输入有效时间，例如 09:00（小时 00–23，分钟 00–59）。';
      return false;
    }
    input.value = parsed.value;
    updateReminderTimePicker();
    return true;
  }

  function adjustReminderTime(part, delta) {
    const parsed = parseReminderTime(document.getElementById('reminderTimeInput')?.value) || parseReminderTime('09:00');
    if (part === 'hour') parsed.hour = (parsed.hour + delta + 24) % 24;
    if (part === 'minute') parsed.minute = (parsed.minute + delta + 60) % 60;
    setReminderTime(`${parsed.hour}:${parsed.minute}`);
  }

  function setReminderMinute(minute) {
    const parsed = parseReminderTime(document.getElementById('reminderTimeInput')?.value) || parseReminderTime('09:00');
    setReminderTime(`${parsed.hour}:${Number(minute)}`);
  }

  function updateReminderStatusCopy() {
    const enabled = document.getElementById('reminderEnabledToggle')?.checked;
    const copy = document.getElementById('reminderStatusCopy');
    if (copy) copy.textContent = enabled
      ? '到点发送；单次提醒成功后关闭，重复提醒按计划继续。'
      : '关闭后不会发送新的提醒邮件。';
  }

  function toggleReminderRepeatFields() {
    const mode = document.getElementById('reminderModeInput')?.value || 'once';
    const weekdaysRow = document.getElementById('reminderWeekdaysRow');
    const countRow = document.getElementById('reminderRepeatCountRow');
    const modeHelp = document.getElementById('reminderModeHelp');
    const weekdaysHelp = document.getElementById('reminderWeekdaysHelp');
    if (weekdaysRow) weekdaysRow.style.display = mode === 'once' ? 'none' : 'flex';
    if (countRow) countRow.style.display = mode === 'count' ? 'flex' : 'none';
    if (modeHelp) modeHelp.textContent = mode === 'once'
      ? '发送成功后自动关闭，不会重复打扰。'
      : mode === 'weekly'
        ? '在选中的星期按时发送，直到手动关闭或任务完成。'
        : '按选中的星期发送，达到总次数后自动关闭。';
    if (weekdaysHelp) weekdaysHelp.textContent = mode === 'count'
      ? '选择发送日，每个选中日最多发送一次。'
      : '选择至少一个发送日。';
    updateReminderWeekdaysSummary();
  }

  function openReminderModal(todoId, source) {
    const t = todos.find(t => t.id === todoId);
    if (!t || t.completed) return;
    editingReminderTodoId = todoId;
    const cat = categories.find(category => category.id === t.categoryId);
    const taskMeta = document.getElementById('reminderTaskMeta');
    const taskProgress = document.getElementById('reminderTaskProgress');
    const progress = t.completed ? 100 : Math.max(0, Math.min(100, Number(t.progress) || 0));
    document.getElementById('reminderEnabledToggle').checked = !!t.reminderEnabled;
    document.getElementById('reminderModeInput').value = t.reminderMode || 'once';
    setReminderTime(t.reminderTime || '09:00');
    document.getElementById('reminderRepeatCountInput').value = t.reminderRepeatCount || 4;
    document.querySelectorAll('input[name="reminderWeekday"]').forEach(input => {
      input.checked = (t.reminderWeekdays || []).includes(Number(input.value));
    });
    document.getElementById('creatorEmailInput').value = t.creatorEmail || '';
    document.getElementById('reminderModalTitle').textContent = (t.reminderEnabled ? '🔔 ' : '🔕 ') + t.title;
    if (taskMeta) taskMeta.innerHTML = `${cat ? `${categoryIconMarkup(cat)}<span>${escHtml(cat.name)}</span>` : `${systemIcon('default')}<span>默认</span>`} · 待完成`;
    if (taskProgress) taskProgress.textContent = `进度 ${progress}%`;
    updateReminderStatusCopy();
    toggleReminderRepeatFields();
    showModal('reminderModal', source);
  }
  function closeReminderModal() {
    hideModal('reminderModal');
    editingReminderTodoId = null;
  }
  async function saveReminderSettings() {
    if (!editingReminderTodoId) return;
    const currentTodo = todos.find(t => t.id === editingReminderTodoId);
    if (!currentTodo || currentTodo.completed) {
      closeReminderModal();
      return;
    }
    const reminderEnabled = document.getElementById('reminderEnabledToggle').checked;
    const reminderMode = document.getElementById('reminderModeInput').value;
    if (!commitReminderTimeInput()) {
      document.getElementById('reminderTimeInput')?.focus();
      return;
    }
    const reminderTime = document.getElementById('reminderTimeInput').value;
    const reminderWeekdays = getReminderWeekdays();
    const weekdaysError = document.getElementById('reminderWeekdaysError');
    if (['weekly', 'count'].includes(reminderMode) && reminderWeekdays.length === 0) {
      if (weekdaysError) weekdaysError.textContent = '请选择至少一个发送日，也可以使用上方快捷选择。';
      document.querySelector('input[name="reminderWeekday"]')?.focus();
      return;
    }
    if (weekdaysError) weekdaysError.textContent = '';
    const reminderRepeatCount = Math.max(1, Number(document.getElementById('reminderRepeatCountInput').value) || 1);
    const creatorEmail = document.getElementById('creatorEmailInput').value.trim();
    const todoId = editingReminderTodoId;
    const saveBtn = document.querySelector('#reminderModal .modal-btn.primary');
    if (saveBtn) saveBtn.disabled = true;
    try {
      const res = await fetch(API + '/todos/' + todoId, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reminderEnabled, reminderMode, reminderTime, reminderWeekdays, reminderRepeatCount, creatorEmail })
      });
      const updated = await res.json();
      if (!res.ok) throw new Error(updated.error || '保存提醒设置失败');
      const idx = todos.findIndex(t => t.id === todoId);
      if (idx !== -1) todos[idx] = updated;
      closeReminderModal();
      render();
    } catch (e) {
      alert(e.message);
    } finally {
      if (saveBtn) saveBtn.disabled = false;
    }
  }


  /* ── Sidebar ── */
  function openSidebar() { document.getElementById('sidebar').classList.add('open'); }
  function closeSidebar() { document.getElementById('sidebar').classList.remove('open'); }

  /* ── Data loading ── */
  async function loadData() {
    try {
      const ts = Date.now();
      const [catsRes, todosRes, settingsRes, backupRes] = await Promise.all([
        fetch(API + '/categories?_=' + ts),
        fetch(API + '/todos?_=' + ts),
        fetch(API + '/settings?_=' + ts),
        fetch(API + '/backup/status?_=' + ts)
      ]);
      const newCats = await catsRes.json();
      const newTodos = await todosRes.json();
      const newSettings = await settingsRes.json();
      const newBackupStatus = await backupRes.json();
      settings = newSettings;
      backupStatus = newBackupStatus;
      categories.splice(0, categories.length, ...newCats);
      todos.splice(0, todos.length, ...newTodos);
      // Resolve default category id
      const stored = localStorage.getItem('lastUsedCatId');
      defaultCatId = newCats.find(c => c.name === '默认')?.id || newCats[0]?.id || null;
      if (stored && newCats.find(c => c.id === stored)) {
        selectedAddCatId = stored;
      } else {
        selectedAddCatId = defaultCatId;
        localStorage.setItem('lastUsedCatId', defaultCatId);
      }
      renderCats();
      initCatPicker();
      render();
    } catch (e) { console.error(e); }
  }

  /* ── Render categories (sidebar) ── */
  const SYSTEM_ICON_PATHS = {
    categories: '<path d="M6 4.5h11.5A1.5 1.5 0 0 1 19 6v12.5A1.5 1.5 0 0 1 17.5 20H6A1.5 1.5 0 0 1 4.5 18.5V6A1.5 1.5 0 0 1 6 4.5Z"/><path d="M7.5 2.5h10A1.5 1.5 0 0 1 19 4v.5M8 9h7M8 13h5"/>',
    all: '<circle cx="12" cy="12" r="8.5"/><path d="M3.5 12h17M12 3.5c2.2 2.4 3.3 5.2 3.3 8.5s-1.1 6.1-3.3 8.5c-2.2-2.4-3.3-5.2-3.3-8.5S9.8 5.9 12 3.5Z"/>',
    default: '<path d="M4 6.5h16l1.5 5.5v5a2 2 0 0 1-2 2h-15a2 2 0 0 1-2-2v-5L4 6.5Z"/><path d="M4 12h4l1.5 2h5l1.5-2h4"/>'
  };

  function systemIcon(name) {
    return `<svg class="ui-icon ui-icon-${name}" viewBox="0 0 24 24" aria-hidden="true">${SYSTEM_ICON_PATHS[name] || ''}</svg>`;
  }

  function categoryIconValue(cat) {
    return cat && cat.id === 'cat_default' ? '📥' : (cat?.icon || '🏷️');
  }

  function categoryIconMarkup(cat) {
    const icon = cat && cat.id === 'cat_default' ? systemIcon('default') : escHtml(categoryIconValue(cat));
    return `<span class="category-icon-slot" aria-hidden="true">${icon}</span>`;
  }

  function categoryIconText(cat) {
    return categoryIconValue(cat);
  }

  function renderCats() {
    const allCount = todos.length;
    const catCounts = {};
    todos.forEach(t => {
      catCounts[t.categoryId] = (catCounts[t.categoryId] || 0) + 1;
    });

    const sorted = categories.sort((a, b) => a.sort_order - b.sort_order);

    let html = `
      <div class="cat-item cat-all${activeCatId === null ? ' active' : ''}" onclick="selectCat(null)">
        <span class="cat-icon">${systemIcon('all')}</span>
        <span class="cat-name">全部</span>
        <span class="cat-count">${allCount}</span>
      </div>
    `;

    html += `<div class="cat-divider"></div>`;

    sorted.forEach((cat, idx) => {
      const count = catCounts[cat.id] || 0;
      const canUp = idx > 0;
      const canDown = idx < sorted.length - 1;
      html += `
        <div class="cat-item${activeCatId === cat.id ? ' active' : ''}" onclick="selectCat('${cat.id}')">
          <span class="cat-icon">${categoryIconMarkup(cat)}</span>
          <span class="cat-name">${escHtml(cat.name)}</span>
          <span class="cat-count">${count}</span>
          <div class="cat-order-btns">
            <button class="cat-act-btn move${!canUp ? ' disabled' : ''}"
                    onclick="event.stopPropagation(); reorderCat('${cat.id}', 'up')"
                    title="上移">▲</button>
            <button class="cat-act-btn move${!canDown ? ' disabled' : ''}"
                    onclick="event.stopPropagation(); reorderCat('${cat.id}', 'down')"
                    title="下移">▼</button>
          </div>
          <div class="cat-actions">
            <button class="cat-act-btn" onclick="event.stopPropagation(); openEditCatModal('${cat.id}')" title="编辑">✎</button>
            <button class="cat-act-btn del" onclick="event.stopPropagation(); openDelCatConfirm('${cat.id}')" title="删除">🗑</button>
          </div>
        </div>
      `;
    });

    document.getElementById('catList').innerHTML = html;
  }

  async function reorderCat(catId, direction) {
    const sorted = [...categories].sort((a, b) => a.sort_order - b.sort_order);
    const idx = sorted.findIndex(c => c.id === catId);
    if (idx === -1) return;
    const swapIdx = direction === 'up' ? idx - 1 : idx + 1;
    if (swapIdx < 0 || swapIdx >= sorted.length) return;
    // Swap orders
    const tmpOrder = sorted[idx].sort_order;
    sorted[idx].sort_order = sorted[swapIdx].sort_order;
    sorted[swapIdx].sort_order = tmpOrder;
    // Update local state
    categories = sorted;
    renderCats();
    // Persist
    try {
      await fetch(API + '/categories/reorder', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ order: sorted.map(c => c.id) })
      });
    } catch (e) { console.error(e); }
  }

  function selectCat(catId) {
    activeCatId = catId;
    completedPage = 1;
    const cat = catId ? categories.find(c => c.id === catId) : null;
    document.getElementById('currentCatTitle').innerHTML =
      cat ? `${categoryIconMarkup(cat)} <span>${escHtml(cat.name)}</span>` : `${systemIcon('all')} <span>全部</span>`;
    // Sync: also set the add-form category to the selected one
    if (catId) {
      selectedAddCatId = catId;
    } else {
      // "All" → reset to default category
      selectedAddCatId = defaultCatId;
    }
    localStorage.setItem('lastUsedCatId', selectedAddCatId);
    renderCatPickerLabel();
    renderCats();
    render({ animateLists: true });
    closeSidebar();
  }

  /* ── Category select (native select) ── */
  function initCatPicker() {
    renderCatPickerLabel();
  }

  function renderCatPickerLabel() {
    const cat = categories.find(c => c.id === selectedAddCatId) || categories[0];
    const label = document.getElementById('catPickerLabel');
    if (label && cat) label.innerHTML = `${categoryIconMarkup(cat)}<span>${escHtml(cat.name)}</span>`;
  }

  function toggleCatPicker(e) {
    if (e) e.stopPropagation();
    const list = document.getElementById('catPickerList');
    const btn = document.getElementById('catPickerBtn');
    if (!list || !btn) return;
    const isOpen = list.classList.contains('open');
    if (isOpen) {
      closeCatPicker();
      return;
    }
    closePriorityDropdown();
    closeMoveDropdown();
    closeAddDueDatePicker();
    // Build list
    list.innerHTML = categories.sort((a, b) => a.sort_order - b.sort_order).map(c => `
      <div class="cat-picker-item${c.id === selectedAddCatId ? ' selected' : ''}"
           onclick="selectAddCat('${c.id}')">
        <span class="check">${c.id === selectedAddCatId ? '✔' : ''}</span>
        ${categoryIconMarkup(c)}<span>${escHtml(c.name)}</span>
      </div>
    `).join('');
    // Move to body for Portal behavior (avoids stacking context issues)
    if (list.parentElement !== document.body) {
      document.body.appendChild(list);
    }
    list.style.position = 'fixed';
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const rect = btn.getBoundingClientRect();
    if (vw <= 768) {
      // Mobile: anchor below the button and flip above it when needed.
      const edge = 8;
      const width = Math.min(Math.max(rect.width, 160), vw - edge * 2);
      const maxHeight = Math.max(160, Math.min(260, vh - edge * 2));
      const left = Math.min(Math.max(edge, rect.left), vw - width - edge);
      list.style.left = left + 'px';
      list.style.right = 'auto';
      list.style.width = width + 'px';
      list.style.maxHeight = maxHeight + 'px';
      list.style.top = (rect.bottom + 4) + 'px';
      list.style.bottom = 'auto';
    } else {
      // Desktop: appear below button
      list.style.left = rect.left + 'px';
      list.style.right = 'auto';
      list.style.top = (rect.bottom + 4) + 'px';
      list.style.bottom = 'auto';
      list.style.width = 'auto';
      list.style.maxHeight = '260px';
    }
    btn.classList.add('open');
    list.classList.add('open');
    if (vw <= 768) {
      const menuHeight = Math.min(list.scrollHeight, parseFloat(list.style.maxHeight));
      const belowTop = rect.bottom + 4;
      const aboveTop = rect.top - menuHeight - 4;
      const top = belowTop + menuHeight <= vh - 8
        ? belowTop
        : Math.max(8, aboveTop);
      list.style.top = top + 'px';
    }
  }

  function closeCatPicker() {
    document.getElementById('catPickerList')?.classList.remove('open');
    document.getElementById('catPickerBtn')?.classList.remove('open');
  }

  function selectAddCat(catId) {
    selectedAddCatId = catId;
    localStorage.setItem('lastUsedCatId', catId);
    closeCatPicker();
    renderCatPickerLabel();
  }

  const VIEW_MODE_LABELS = { list: '列表视图', day: '日视图', month: '月视图' };
  const CALENDAR_WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六'];

  function renderViewSwitcher() {
    Object.entries(VIEW_MODE_LABELS).forEach(([mode]) => {
      const button = document.getElementById(`viewMode${mode[0].toUpperCase()}${mode.slice(1)}`);
      if (!button) return;
      const active = mode === viewMode;
      button.classList.toggle('view-active', active);
      button.setAttribute('aria-pressed', active ? 'true' : 'false');
    });
  }

  function setViewMode(mode) {
    if (!VIEW_MODE_LABELS[mode] || mode === viewMode) return;
    viewMode = mode;
    renderViewSwitcher();
    render({ animateLists: true });
  }

  function calendarDateKey(date) {
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  }

  function isValidDateKey(value) {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const [year, month, day] = value.split('-').map(Number);
    const date = new Date(0);
    date.setHours(0, 0, 0, 0);
    date.setFullYear(year, month - 1, day);
    return date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day;
  }

  function parseCalendarDateKey(value) {
    if (!isValidDateKey(value)) return null;
    const [year, month, day] = value.split('-').map(Number);
    const date = new Date(0);
    date.setHours(0, 0, 0, 0);
    date.setFullYear(year, month - 1, day);
    return date;
  }

  function todayDateKey() { return calendarDateKey(new Date()); }

  function todoCreatedDateKey(todo) {
    const date = new Date(todo?.createdAt);
    return Number.isNaN(date.getTime()) ? '' : calendarDateKey(date);
  }

  function todoDueDateKey(todo) {
    const value = String(todo?.dueDate || '').trim();
    return isValidDateKey(value) ? value : '';
  }

  function todoCalendarDateKey(todo) {
    return todoDueDateKey(todo) || todoCreatedDateKey(todo);
  }

  function calendarDateLabel(date) {
    return `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日 · 星期${CALENDAR_WEEKDAYS[date.getDay()]}`;
  }

  function calendarMonthLabel(date) {
    return `${date.getFullYear()}年${date.getMonth() + 1}月`;
  }

  function calendarTaskSort(a, b) {
    const aKey = todoCalendarDateKey(a) || '9999-99-99';
    const bKey = todoCalendarDateKey(b) || '9999-99-99';
    const dateCompare = aKey.localeCompare(bKey);
    if (dateCompare !== 0) return dateCompare;
    return String(a.title || '').localeCompare(String(b.title || ''), 'zh-CN');
  }

  function shiftCalendarDate(delta) {
    const date = new Date(calendarViewDate);
    if (viewMode === 'month') date.setDate(1);
    if (viewMode === 'month') date.setMonth(date.getMonth() + delta);
    else date.setDate(date.getDate() + delta);
    calendarViewDate = date;
    render();
  }

  function resetCalendarToToday() {
    calendarViewDate = new Date();
    render();
  }

  function openCalendarDay(dateKey) {
    const date = parseCalendarDateKey(dateKey);
    if (!date) return;
    calendarViewDate = date;
    viewMode = 'day';
    renderViewSwitcher();
    render({ animateLists: true });
  }

  function resetAddDueDate() {
    selectedAddDueDate = todayDateKey();
    selectedAddDueTime = '';
    selectedAddDueHour = '';
    selectedAddDueMinute = '';
    addDuePickerMonth = new Date();
    renderAddDueDateButton();
  }

  function renderAddDueDateButton() {
    const button = document.getElementById('addDueDateBtn');
    if (!button) return;
    if (!isValidDateKey(selectedAddDueDate)) selectedAddDueDate = todayDateKey();
    const date = parseCalendarDateKey(selectedAddDueDate);
    const isToday = selectedAddDueDate === todayDateKey();
    const time = /^\d{2}:[0-5]\d$/.test(String(selectedAddDueTime || '')) ? ` ${selectedAddDueTime}` : '';
    const label = date && isToday ? `今天${time}` : date ? `${date.getMonth() + 1}月${date.getDate()}日${time}` : `今天${time}`;
    button.title = `预期完成时间：${label}，点击修改`;
    button.setAttribute('aria-label', `预期完成时间：${label}，点击修改`);
    button.classList.toggle('has-date', !!date && (!isToday || !!time));
  }

  function openAddDueDatePicker(event) {
    if (event) event.stopPropagation();
    const picker = document.getElementById('addDueDatePicker');
    const button = document.getElementById('addDueDateBtn');
    if (!picker || !button) return;
    if (!isValidDateKey(selectedAddDueDate)) resetAddDueDate();
    closePriorityDropdown();
    closeMoveDropdown();
    closeCatPicker();
    const selected = parseCalendarDateKey(selectedAddDueDate);
    addDuePickerMonth = selected ? new Date(selected.getFullYear(), selected.getMonth(), 1) : new Date();
    renderAddDueDatePicker();
    picker.hidden = false;
    picker.classList.add('show');
    button.classList.add('open');
    const rect = button.getBoundingClientRect();
    const pickerRect = picker.getBoundingClientRect();
    const edge = 8;
    let left = Math.min(Math.max(edge, rect.right - pickerRect.width), window.innerWidth - pickerRect.width - edge);
    let top = rect.bottom + edge;
    if (top + pickerRect.height > window.innerHeight - edge) {
      top = Math.max(edge, rect.top - pickerRect.height - edge);
    }
    picker.style.left = `${left}px`;
    picker.style.top = `${top}px`;
  }

  function renderAddDueDatePicker() {
    const monthLabel = document.getElementById('addDuePickerMonth');
    const weekdays = document.querySelector('.due-picker-weekdays');
    const grid = document.getElementById('addDuePickerGrid');
    if (!monthLabel || !grid) return;
    monthLabel.textContent = calendarMonthLabel(addDuePickerMonth);
    if (weekdays && !weekdays.childElementCount) {
      weekdays.innerHTML = CALENDAR_WEEKDAYS.map(day => `<span>${day}</span>`).join('');
    }
    const year = addDuePickerMonth.getFullYear();
    const month = addDuePickerMonth.getMonth();
    const firstDay = new Date(year, month, 1).getDay();
    const today = todayDateKey();
    grid.innerHTML = Array.from({ length: 42 }, (_, index) => {
      const date = new Date(year, month, index - firstDay + 1);
      const key = calendarDateKey(date);
      const inMonth = date.getMonth() === month;
      const classes = [
        inMonth ? '' : 'is-outside',
        key === today ? 'is-today' : '',
        key === selectedAddDueDate ? 'is-selected' : ''
      ].filter(Boolean).join(' ');
      return `<button type="button" class="${classes}" onclick="selectAddDueDate('${key}')">${date.getDate()}</button>`;
    }).join('');
    renderAddDueTimeControls();
  }

  function renderAddDueTimeControls() {
    if (/^\d{2}:[0-5]\d$/.test(String(selectedAddDueTime || ''))) {
      selectedAddDueHour = selectedAddDueTime.slice(0, 2);
      selectedAddDueMinute = selectedAddDueTime.slice(3);
    }
    const hour = document.getElementById('addDueHourInput');
    const minute = document.getElementById('addDueMinuteInput');
    [[hour, selectedAddDueHour, '小时'], [minute, selectedAddDueMinute, '分钟']].forEach(([button, value, label]) => {
      if (!button) return;
      button.value = value || '';
      button.textContent = value || '--';
      button.classList.toggle('has-value', !!value);
      button.setAttribute('aria-label', value ? `${label}：${value}` : `选择${label}`);
    });
  }

  function closeAddDueTimeMenu() {
    const menu = document.getElementById('addDueTimeMenu');
    if (!menu) return;
    menu.hidden = true;
    menu.removeAttribute('data-kind');
    document.querySelectorAll('.due-picker-time-select').forEach(button => button.setAttribute('aria-expanded', 'false'));
  }

  function toggleAddDueTimeMenu(kind, event) {
    if (event) event.stopPropagation();
    const menu = document.getElementById('addDueTimeMenu');
    const button = document.getElementById(kind === 'hour' ? 'addDueHourInput' : 'addDueMinuteInput');
    if (!menu || !button) return;
    if (!menu.hidden && menu.dataset.kind === kind) {
      closeAddDueTimeMenu();
      return;
    }
    const values = kind === 'hour'
      ? Array.from({ length: 24 }, (_, value) => String(value).padStart(2, '0'))
      : Array.from({ length: 12 }, (_, value) => String(value * 5).padStart(2, '0'));
    const selected = kind === 'hour' ? selectedAddDueHour : selectedAddDueMinute;
    menu.dataset.kind = kind;
    menu.innerHTML = `
      <div class="due-picker-time-menu-header">
        <strong>${kind === 'hour' ? '选择小时' : '选择分钟'}</strong>
        <span>${kind === 'hour' ? '24 小时制' : '每 5 分钟'}</span>
      </div>
      <div class="due-picker-time-options">
        ${values.map(value => `<button type="button" class="due-picker-time-option${value === selected ? ' is-selected' : ''}" role="option" aria-selected="${value === selected}" onclick="selectAddDueTime('${kind}', '${value}')">${value}</button>`).join('')}
      </div>
    `;
    menu.hidden = false;
    document.querySelectorAll('.due-picker-time-select').forEach(control => control.setAttribute('aria-expanded', control === button ? 'true' : 'false'));
  }

  function selectAddDueTime(kind, value) {
    if (!/^\d{2}$/.test(String(value))) return;
    if (kind === 'hour' && Number(value) <= 23) selectedAddDueHour = value;
    if (kind === 'minute' && Number(value) % 5 === 0 && Number(value) <= 59) selectedAddDueMinute = value;
    handleAddDueTimeChange();
    closeAddDueTimeMenu();
  }

  function shiftAddDuePickerMonth(delta) {
    addDuePickerMonth.setMonth(addDuePickerMonth.getMonth() + Number(delta || 0));
    renderAddDueDatePicker();
  }

  function selectAddDueDate(value) {
    if (!isValidDateKey(value)) return;
    selectedAddDueDate = value;
    const date = parseCalendarDateKey(value);
    if (date) addDuePickerMonth = new Date(date.getFullYear(), date.getMonth(), 1);
    renderAddDueDateButton();
    renderAddDueDatePicker();
  }

  function setAddDueDateToday() {
    selectedAddDueDate = todayDateKey();
    const today = parseCalendarDateKey(selectedAddDueDate);
    if (today) addDuePickerMonth = new Date(today.getFullYear(), today.getMonth(), 1);
    renderAddDueDateButton();
    renderAddDueDatePicker();
  }

  function handleAddDueTimeChange() {
    const hour = selectedAddDueHour || document.getElementById('addDueHourInput')?.value || '';
    const minute = selectedAddDueMinute || document.getElementById('addDueMinuteInput')?.value || '';
    selectedAddDueHour = hour;
    selectedAddDueMinute = minute;
    selectedAddDueTime = hour && minute ? `${hour}:${minute}` : '';
    renderAddDueDateButton();
    renderAddDueTimeControls();
  }

  function clearAddDueTime() {
    selectedAddDueTime = '';
    selectedAddDueHour = '';
    selectedAddDueMinute = '';
    const hour = document.getElementById('addDueHourInput');
    const minute = document.getElementById('addDueMinuteInput');
    if (hour) hour.value = '';
    if (minute) minute.value = '';
    closeAddDueTimeMenu();
    renderAddDueTimeControls();
    renderAddDueDateButton();
  }

  function closeAddDueDatePicker() {
    const picker = document.getElementById('addDueDatePicker');
    if (picker) {
      picker.classList.remove('show');
      picker.hidden = true;
    }
    closeAddDueTimeMenu();
    document.getElementById('addDueDateBtn')?.classList.remove('open');
  }

  function renderCalendarTaskRows(tasks) {
    if (!tasks.length) return '<div class="calendar-empty">这里暂时没有待办</div>';
    return tasks.map(makeTodoItem).join('');
  }

  function renderCalendarTaskGroup(title, tasks) {
    return `
      <section class="calendar-task-group">
        <div class="calendar-task-group-header">
          <span class="calendar-task-group-title">${title}</span>
          <span class="calendar-task-group-count">${tasks.length} 项</span>
        </div>
        <div class="calendar-task-list calendar-task-card-list">${renderCalendarTaskRows(tasks)}</div>
      </section>
    `;
  }

  function renderCalendarView(filtered, pending, completed) {
    const container = document.getElementById('calendarView');
    if (!container) return;
    const isListView = viewMode === 'list';
    container.hidden = isListView;
    if (isListView) return;

    const viewDate = new Date(calendarViewDate);
    const todayKey = todayDateKey();
    const tasksByDate = filtered.reduce((groups, todo) => {
      const key = todoCalendarDateKey(todo) || '__unknown__';
      (groups[key] ||= []).push(todo);
      return groups;
    }, {});
    const summary = `${pending.length} 项待完成 · ${completed.length} 项已完成`;
    const monthTitle = calendarMonthLabel(viewDate);
    const dayTitle = calendarDateLabel(viewDate);
    const selectedKey = calendarDateKey(viewDate);
    const viewActions = (previousLabel, nextLabel) => `
      <div class="calendar-view-actions">
        <span class="calendar-view-summary">${summary}</span>
        <div class="calendar-nav" role="group" aria-label="${viewMode === 'day' ? '日视图日期导航' : '月视图日期导航'}">
          <button class="calendar-nav-btn" type="button" onclick="shiftCalendarDate(-1)" aria-label="${previousLabel}" title="${previousLabel}">‹</button>
          <button class="calendar-nav-btn" type="button" onclick="resetCalendarToToday()" title="回到今天">回到今天</button>
          <button class="calendar-nav-btn" type="button" onclick="shiftCalendarDate(1)" aria-label="${nextLabel}" title="${nextLabel}">›</button>
        </div>
        ${viewMode === 'day' ? '<button class="calendar-nav-btn" type="button" onclick="setViewMode(\'month\')">月视图</button>' : ''}
      </div>
    `;

    if (viewMode === 'day') {
      const dayTasks = (tasksByDate[selectedKey] || []).slice().sort(calendarTaskSort);
      const unknownTasks = tasksByDate.__unknown__ || [];
      container.innerHTML = `
        <div class="calendar-view-header">
          <div>
            <h2 class="calendar-view-title">日视图</h2>
            <div class="calendar-view-subtitle">${selectedKey === todayKey ? '今天' : '预期完成日期'} · ${dayTitle}</div>
          </div>
          ${viewActions('前一天', '后一天')}
        </div>
        <section class="calendar-day-panel">
          <div class="calendar-day-number">${pad(viewDate.getDate())}</div>
          <div class="calendar-day-copy">
            <div class="calendar-day-date">${dayTitle}</div>
            <div class="calendar-day-description">${dayTasks.length ? `当天有 ${dayTasks.length} 项待办` : '当天还没有待办'}</div>
          </div>
        </section>
        ${renderCalendarTaskGroup('当天待办', dayTasks)}
        ${unknownTasks.length ? renderCalendarTaskGroup('日期未知', unknownTasks) : ''}
        <div class="calendar-view-note">日视图优先按预期完成日期归类；旧待办没有预期完成日期时使用创建日期。</div>
      `;
      return;
    }

    const year = viewDate.getFullYear();
    const month = viewDate.getMonth();
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    const firstDay = new Date(year, month, 1).getDay();
    const calendarCells = [];
    for (let index = 0; index < 42; index += 1) {
      const dayNumber = index - firstDay + 1;
      const date = new Date(year, month, dayNumber);
      const inMonth = dayNumber >= 1 && dayNumber <= daysInMonth;
      const key = calendarDateKey(date);
      const count = tasksByDate[key]?.length || 0;
      const isWeekend = date.getDay() === 0 || date.getDay() === 6;
      calendarCells.push(`
        <button class="calendar-day-cell${inMonth ? '' : ' is-outside'}${key === todayKey ? ' is-today' : ''}${key === selectedKey ? ' is-selected' : ''}${isWeekend ? ' is-weekend' : ''}" type="button" onclick="openCalendarDay('${key}')" aria-label="${key}，${count ? `${count} 项待办` : '无待办'}">
          ${date.getDate()}
          ${count ? `<span class="calendar-day-cell-count">${count} 项</span>` : ''}
        </button>
      `);
    }
    const monthPrefix = `${year}-${pad(month + 1)}-`;
    const monthTasks = filtered.filter(todo => todoCalendarDateKey(todo).startsWith(monthPrefix)).slice().sort(calendarTaskSort);
    container.innerHTML = `
      <div class="calendar-view-header">
        <div>
          <h2 class="calendar-view-title">月视图 <span class="calendar-month-title">${monthTitle}</span></h2>
          <div class="calendar-view-subtitle">点击日期查看日视图</div>
        </div>
        ${viewActions('上个月', '下个月')}
      </div>
      <section class="calendar-month-panel">
        <div class="calendar-weekdays">${CALENDAR_WEEKDAYS.map((day, index) => `<span class="calendar-weekday${index === 0 || index === 6 ? ' is-weekend' : ''}">${day}</span>`).join('')}</div>
        <div class="calendar-month-grid">${calendarCells.join('')}</div>
      </section>
      ${renderCalendarTaskGroup(`${monthTitle}待办`, monthTasks)}
      ${tasksByDate.__unknown__?.length ? renderCalendarTaskGroup('日期未知', tasksByDate.__unknown__) : ''}
      <div class="calendar-view-note">月视图优先按预期完成日期归类；旧待办没有预期完成日期时使用创建日期，日期格数字表示当天待办数量。</div>
    `;
  }

  /* ── Render todos ── */
  function render({ animateTodoId = null, animateLists = false } = {}) {
    let filtered = todos;
    if (activeCatId !== null) {
      filtered = todos.filter(t => t.categoryId === activeCatId);
    }
    const pending = filtered.filter(t => !t.completed);
    const completed = filtered.filter(t => t.completed);
    const total = filtered.length;
    const done = completed.length;
    const pageCount = Math.max(1, Math.ceil(done / COMPLETED_PAGE_SIZE));
    completedPage = Math.min(Math.max(completedPage, 1), pageCount);
    const pageStart = (completedPage - 1) * COMPLETED_PAGE_SIZE;
    const visibleCompleted = completed.slice(pageStart, pageStart + COMPLETED_PAGE_SIZE);

    document.getElementById('doneCount').textContent = done;
    document.getElementById('totalCount').textContent = total;

    const progCard = document.getElementById('progressCard');
    if (total > 0) {
      const pct = pending.length > 0
        ? Math.round(pending.reduce((sum, t) => sum + Math.max(0, Math.min(100, Number(t.progress) || 0)), 0) / pending.length)
        : 100;
      progCard.style.display = 'block';
      document.getElementById('progressLabel').textContent = pending.length > 0 ? '待完成进度' : '全部完成';
      document.getElementById('progressPct').textContent = pct + '%';
      document.getElementById('progressSubtext').textContent = pending.length > 0
        ? `剩余 ${pending.length} 项 · 已完成 ${done} 项`
        : `当前分类已全部完成 · 共 ${done} 项`;
      document.getElementById('progressFill').style.width = pct + '%';
    } else {
      progCard.style.display = 'none';
    }

    const isListView = viewMode === 'list';
    document.getElementById('pendingSection').style.display = isListView && total > 0 && pending.length > 0 ? 'block' : 'none';
    document.getElementById('doneSection').style.display = isListView && total > 0 && completed.length > 0 ? 'block' : 'none';
    document.getElementById('todoList').innerHTML = pending.map(makeTodoItem).join('');
    document.getElementById('doneList').innerHTML = visibleCompleted.map(makeTodoItem).join('');
    renderCompletedPagination(completedPage, pageCount);
    renderCalendarView(filtered, pending, completed);
    if (animateLists) animateListChange();
    if (animateTodoId) requestAnimationFrame(() => animateTodoItem(animateTodoId));
  }

  function renderCompletedPagination(page, pageCount) {
    const container = document.getElementById('completedPagination');
    if (!container) return;
    const pageNumbers = new Set([1, pageCount, page - 1, page, page + 1].filter(n => n >= 1 && n <= pageCount));
    const orderedPages = [...pageNumbers].sort((a, b) => a - b);
    const pageItems = [];
    orderedPages.forEach((pageNumber, index) => {
      if (index > 0 && pageNumber - orderedPages[index - 1] > 1) pageItems.push('<span class="pagination-ellipsis">…</span>');
      pageItems.push(`<button class="pagination-btn${pageNumber === page ? ' active' : ''}" onclick="goToCompletedPage(${pageNumber})" aria-label="第 ${pageNumber} 页"${pageNumber === page ? ' aria-current="page"' : ''}>${pageNumber}</button>`);
    });
    container.hidden = false;
    container.innerHTML = `
      <div class="completed-pagination-controls">
        <button class="pagination-btn" onclick="goToCompletedPage(${page - 1})" aria-label="上一页"${page === 1 ? ' disabled' : ''}>‹</button>
        ${pageItems.join('')}
        <button class="pagination-btn" onclick="goToCompletedPage(${page + 1})" aria-label="下一页"${page === pageCount ? ' disabled' : ''}>›</button>
      </div>
    `;
  }

  function goToCompletedPage(page) {
    completedPage = Number(page) || 1;
    render({ animateLists: true });
    document.getElementById('doneSection')?.scrollIntoView({ behavior: prefersReducedMotion() ? 'auto' : 'smooth', block: 'start' });
  }

  const PRIORITY_META = Object.freeze({
    0: { className: 'normal', label: '普通' },
    1: { className: 'important', label: '重要' },
    2: { className: 'urgent', label: '紧急' },
  });

  function todoPriorityValue(todo) {
    const priority = Number(todo?.priority);
    return Number.isInteger(priority) && PRIORITY_META[priority] ? priority : 0;
  }

  function priorityTagMarkup(todo) {
    const priority = todoPriorityValue(todo);
    const meta = PRIORITY_META[priority];
    const readonly = !!todo.completed;
    return `<button type="button" class="todo-priority-tag priority-${meta.className}" ${readonly ? 'disabled' : `onclick="event.stopPropagation(); togglePriorityDropdown('${todo.id}', event)"`} title="${readonly ? '重要程度：' : '修改重要程度：'}${meta.label}"><span class="priority-dot priority-dot-${meta.className}" aria-hidden="true"></span>${meta.label}</button>`;
  }

  function makeTodoItem(t) {
    const cat = categories.find(c => c.id === t.categoryId);
    const isEditing = editingTodoId === t.id;
    const catIcon = categoryIconMarkup(cat);
    const catName = cat ? cat.name : '默认';
    const dateStr = formatDate(t.createdAt);
    const updatedDateStr = formatDate(t.updatedAt || t.createdAt);
    const periodBadge = (() => {
      if (t.completed) return '';
      const today = parseCalendarDateKey(todayDateKey());
      const dueKey = todoDueDateKey(t);
      if (dueKey) {
        const due = parseCalendarDateKey(dueKey);
        const daysUntilDue = Math.round((due.getTime() - today.getTime()) / 86400000);
        if (daysUntilDue < 0) return '<span class="period-badge overdue">⏰ 已逾期</span>';
        if (daysUntilDue === 0) return '<span class="period-badge today">📅 今日</span>';
        if (daysUntilDue === 1) return '<span class="period-badge week">📅 明日</span>';
        if (daysUntilDue <= 3) return '<span class="period-badge week">📆 近3日</span>';
        if (daysUntilDue <= 7) return '<span class="period-badge week">📆 本周</span>';
        return `<span class="period-badge month">📅 ${due.getMonth() + 1}月${due.getDate()}日</span>`;
      }

      const created = new Date(t.createdAt);
      if (Number.isNaN(created.getTime())) return '';
      created.setHours(0, 0, 0, 0);
      const ageInDays = Math.round((today.getTime() - created.getTime()) / 86400000);
      if (ageInDays === 0) return '<span class="period-badge today">📅 今日</span>';
      if (ageInDays <= 3) return '<span class="period-badge week">📆 近3日</span>';
      if (ageInDays <= 7) return '<span class="period-badge week">📆 本周</span>';
      if (ageInDays <= 30) return '<span class="period-badge month">📅 近1月</span>';
      return '';
    })();

    const progress = t.progress ?? 0
    const showProgress = progress > 0
    const editValue = todoEditDrafts.has(t.id) ? todoEditDrafts.get(t.id) : t.title;
    const titleMarkup = isEditing ? `
      <div class="todo-title-editor">
        <div class="todo-text todo-title-placeholder" aria-hidden="true">${escHtml(t.title)}</div>
        <textarea
          class="edit-input"
          id="edit-todo-${t.id}"
          maxlength="200"
          rows="1"
          oninput="rememberTodoDraft('${t.id}', this.value)"
          onkeydown="handleTodoEditKey(event, '${t.id}')"
          onblur="saveTodoEdit('${t.id}')"
        >${escHtml(editValue)}</textarea>
      </div>
    ` : `<div class="todo-text${t.completed ? ' readonly' : ''}" ${t.completed ? 'aria-readonly="true"' : ''}>${escHtml(t.title)}</div>`;

    return `
      <div class="todo-item${t.completed ? ' completed' : ''}${isEditing ? ' editing' : ''}" data-id="${t.id}">
        <div class="checkbox${t.completed ? ' checked' : ''}" ${isEditing ? '' : `onclick="toggleTodo('${t.id}')"`}></div>
        <div class="todo-body">
          ${titleMarkup}
          ${t.completed ? `
          <div class="todo-progress-row" style="cursor:default;opacity:0.7">
            <div class="todo-progress-track">
              <div class="todo-progress-fill" style="width:100%"></div>
            </div>
            <span class="todo-progress-pct">100%</span>
          </div>
          ` : showProgress ? `
          <div class="todo-progress-row" onclick="event.stopPropagation(); openProgressModal('${t.id}')">
            <div class="todo-progress-track">
              <div class="todo-progress-fill" style="width:${progress}%"></div>
            </div>
            <span class="todo-progress-pct">${progress}%</span>
          </div>
          ` : `
          <div class="todo-progress-row" onclick="event.stopPropagation(); openProgressModal('${t.id}')">
            <span class="todo-progress-add">+ 添加进度</span>
          </div>
          `}
          <div class="todo-meta">
            <div class="todo-labels">
              <span class="todo-cat-tag${t.completed ? ' readonly' : ''}" ${t.completed ? 'aria-disabled="true"' : `onclick="event.stopPropagation(); toggleMoveDropdown('${t.id}', event)"`}>${catIcon}<span>${escHtml(catName)}</span> ▼</span>
              ${priorityTagMarkup(t)}
              ${periodBadge}
            </div>
            <div class="todo-dates">
              <span class="todo-date todo-date-created">${dateStr}</span>
              <span class="todo-date-divider" aria-hidden="true">｜</span>
              <span class="todo-date todo-date-updated">${updatedDateStr}</span>
            </div>
          </div>
        </div>
        <div class="todo-actions">
          ${!t.completed ? `<button class="todo-act-btn reminder-action${t.reminderEnabled ? ' active' : ''}" onclick="openReminderModal('${t.id}', this)" title="${t.reminderEnabled ? '提醒已开启' : '提醒已关闭'}">${t.reminderEnabled ? '🔔' : '🔕'}</button>` : ''}
          <button class="todo-act-btn note-action${t.noteFile ? ' has-note' : ''}" onclick="openNoteModal('${t.id}', this)" title="${t.completed ? '查看笔记（只读）' : '笔记'}">📄</button>
          ${!t.completed ? `<button class="todo-act-btn edit-action" onclick="startEditTodo('${t.id}')" title="编辑">✎</button>` : ''}
          <button class="todo-act-btn del" onclick="deleteTodo('${t.id}')" title="删除">✕</button>
        </div>
      </div>
    `;
  }

  let openMoveTodoId = null;
  let openPriorityTodoId = null;
  let selectedAddPriority = 0;
  const ADD_PRIORITY_TODO_ID = '__new__';

  function renderAddPriorityLabel() {
    const label = document.getElementById('addPriorityLabel');
    const button = document.getElementById('addPriorityBtn');
    const meta = PRIORITY_META[selectedAddPriority] || PRIORITY_META[0];
    if (label) label.innerHTML = `<span class="priority-dot priority-dot-${meta.className}" aria-hidden="true"></span>${meta.label}`;
    if (button) {
      button.classList.remove('priority-normal', 'priority-important', 'priority-urgent');
      button.classList.add(`priority-${meta.className}`);
    }
  }

  function toggleAddPriorityDropdown(event) {
    if (event) event.stopPropagation();
    const portal = document.getElementById('priority-dropdown-portal');
    const button = event?.currentTarget || document.getElementById('addPriorityBtn');
    if (!portal || !button) return;
    if (openPriorityTodoId === ADD_PRIORITY_TODO_ID && portal.classList.contains('show')) {
      closePriorityDropdown();
      return;
    }

    closeMoveDropdown();
    closePriorityDropdown();
    closeCatPicker();
    closeAddDueDatePicker();
    openPriorityTodoId = ADD_PRIORITY_TODO_ID;
    portal.innerHTML = Object.entries(PRIORITY_META).map(([value, meta]) => `
      <button type="button" class="priority-option priority-${meta.className}${Number(value) === selectedAddPriority ? ' active' : ''}"
              onclick="setAddPriority(${value})">
        <span class="priority-option-swatch" aria-hidden="true"></span>
        <span>${meta.label}</span>
        ${Number(value) === selectedAddPriority ? '<span aria-hidden="true">✓</span>' : ''}
      </button>
    `).join('');

    const rect = button.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let top = rect.bottom + 4;
    let left = rect.left;
    portal.classList.add('show');
    const menuRect = portal.getBoundingClientRect();
    if (left + menuRect.width > vw) left = Math.max(4, vw - menuRect.width - 4);
    if (top + menuRect.height > vh) top = Math.max(4, rect.top - menuRect.height - 4);
    portal.style.top = `${top}px`;
    portal.style.left = `${left}px`;
    button.classList.add('open');
  }

  function setAddPriority(priority) {
    const numericPriority = Number(priority);
    if (!PRIORITY_META[numericPriority]) return;
    selectedAddPriority = numericPriority;
    renderAddPriorityLabel();
    closePriorityDropdown();
  }

  function togglePriorityDropdown(todoId, event) {
    if (event) event.stopPropagation();
    const portal = document.getElementById('priority-dropdown-portal');
    const todo = todos.find(item => item.id === todoId);
    if (!portal || !todo || todo.completed) {
      closePriorityDropdown();
      return;
    }
    if (openPriorityTodoId === todoId && portal.classList.contains('show')) {
      closePriorityDropdown();
      return;
    }

    closeMoveDropdown();
    closeCatPicker();
    closeAddDueDatePicker();
    document.getElementById('addPriorityBtn')?.classList.remove('open');
    openPriorityTodoId = todoId;
    const currentPriority = todoPriorityValue(todo);
    portal.innerHTML = Object.entries(PRIORITY_META).map(([value, meta]) => `
      <button type="button" class="priority-option priority-${meta.className}${Number(value) === currentPriority ? ' active' : ''}"
              onclick="setTodoPriority('${todoId}', ${value})">
        <span class="priority-option-swatch" aria-hidden="true"></span>
        <span>${meta.label}</span>
        ${Number(value) === currentPriority ? '<span aria-hidden="true">✓</span>' : ''}
      </button>
    `).join('');

    const source = event?.currentTarget || document.querySelector(`[data-id="${todoId}"] .todo-priority-tag`);
    const rect = source?.getBoundingClientRect?.();
    if (!rect) {
      closePriorityDropdown();
      return;
    }
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let top = rect.bottom + 4;
    let left = rect.left;
    portal.classList.add('show');
    const menuRect = portal.getBoundingClientRect();
    if (left + menuRect.width > vw) left = Math.max(4, vw - menuRect.width - 4);
    if (top + menuRect.height > vh) top = Math.max(4, rect.top - menuRect.height - 4);
    portal.style.top = `${top}px`;
    portal.style.left = `${left}px`;
  }

  function closePriorityDropdown() {
    const portal = document.getElementById('priority-dropdown-portal');
    if (portal) {
      portal.classList.remove('show');
      portal.innerHTML = '';
    }
    document.getElementById('addPriorityBtn')?.classList.remove('open');
    openPriorityTodoId = null;
  }

  async function setTodoPriority(todoId, priority) {
    const todo = todos.find(item => item.id === todoId);
    const numericPriority = Number(priority);
    closePriorityDropdown();
    if (!todo || todo.completed || !PRIORITY_META[numericPriority]) return;
    if (todoPriorityValue(todo) === numericPriority) return;
    try {
      const res = await fetch(`${API}/todos/${todoId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ priority: numericPriority })
      });
      const updated = await res.json();
      if (!res.ok) throw new Error(updated.error || '更新重要程度失败');
      const index = todos.findIndex(item => item.id === todoId);
      if (index !== -1) todos[index] = updated;
      render();
      showToast(`已设为${PRIORITY_META[numericPriority].label}`);
    } catch (e) {
      console.error(e);
      showToast('重要程度保存失败，请重试');
    }
  }

  function toggleMoveDropdown(todoId, event) {
    if (event) event.stopPropagation();
    const portal = document.getElementById('move-dropdown-portal');
    if (!portal) return;
    closePriorityDropdown();
    closeCatPicker();
    closeAddDueDatePicker();
    const moveTodoItem = todos.find(x => x.id === todoId);
    if (!moveTodoItem || moveTodoItem.completed) {
      closeMoveDropdown();
      return;
    }

    // If clicking the same item, close
    if (openMoveTodoId === todoId && portal.style.display !== 'none') {
      portal.style.display = 'none';
      openMoveTodoId = null;
      return;
    }
    openMoveTodoId = todoId;

    // Build options HTML
    const t = moveTodoItem;
    const optsHtml = categories.filter(c => c.id !== t.categoryId).map(c => `
      <div class="move-option" onclick="moveTodo('${todoId}', '${c.id}'); closeMoveDropdown();">
        ${escHtml(c.icon)} ${escHtml(c.name)}
      </div>
    `).join('') || '<div style="padding:8px 12px;font-size:0.82rem;color:var(--text-3)">无其他分类</div>';

    portal.innerHTML = optsHtml;

    // Position below the category tag of this item
    const item = document.querySelector(`[data-id="${todoId}"]`);
    const catTag = item ? item.querySelector('.todo-cat-tag') : null;
    if (catTag) {
      const rect = catTag.getBoundingClientRect();
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      let top = rect.bottom + 4;
      let left = rect.left;
      // Clamp: if overflow right, flip left
      if (left + 160 > vw) left = Math.max(4, vw - 164);
      // If overflow bottom, flip up
      if (top + 260 > vh) top = rect.top - 260 - 4;
      portal.style.top = top + 'px';
      portal.style.left = left + 'px';
    }
    portal.style.display = 'block';
  }

  function closeMoveDropdown() {
    const portal = document.getElementById('move-dropdown-portal');
    if (portal) portal.style.display = 'none';
    openMoveTodoId = null;
  }

  function escHtml(s) {
    return String(s ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  /* ── Todo actions ── */
  async function addTodo() {
    const input = document.getElementById('todoInput');
    const title = input.value.trim();
    if (!title) { input.classList.add('shake'); setTimeout(() => input.classList.remove('shake'), 350); return; }
    const categoryId = selectedAddCatId;
    try {
      const res = await fetch(API + '/todos', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title, categoryId, priority: selectedAddPriority, dueDate: selectedAddDueDate || todayDateKey(), dueTime: selectedAddDueTime || '' })
      });
      const t = await res.json();
      if (!res.ok) throw new Error(t.error || '添加待办失败');
      todos.unshift(t);
      input.value = '';
      selectedAddPriority = 0;
      renderAddPriorityLabel();
      resetAddDueDate();
      renderCats();
      render({ animateTodoId: t.id });
      const cat = categories.find(c => c.id === categoryId);
      showToast(`已添加到 ${cat?.name || '默认'}`);
    } catch (e) { console.error(e); }
  }

  async function toggleTodo(id) {
    const t = todos.find(x => x.id === id);
    if (!t) return;
    const completed = !t.completed;
    const firstRect = findTodoElement(id)?.getBoundingClientRect();
    try {
      const res = await fetch(`${API}/todos/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ completed, progress: completed ? 100 : 0 })
      });
      const updated = await res.json();
      if (!res.ok) throw new Error(updated.error || '更新任务状态失败');
      const index = todos.findIndex(x => x.id === id);
      if (index !== -1) todos[index] = updated;
      renderCats();
      render();
      animateTodoTransition(id, firstRect);
      showToast(completed ? '已完成' : '已重新打开');
    } catch (e) { console.error(e); }
  }

  async function deleteTodo(id) {
    const el = document.querySelector(`[data-id="${id}"]`);
    if (el && !prefersReducedMotion()) { el.classList.add('deleting'); await sleep(220); }
    try {
      const res = await fetch(`${API}/todos/${id}`, { method: 'DELETE' });
      if (!res.ok) throw new Error('删除待办失败');
      todos = todos.filter(x => x.id !== id);
      todoEditDrafts.delete(id);
      todoEditSaving.delete(id);
      editingTodoId = null;
      renderCats();
      render();
      showToast('待办已删除');
    } catch (e) { console.error(e); }
  }

  async function moveTodo(todoId, catId) {
    const todo = todos.find(t => t.id === todoId);
    if (!todo || todo.completed) return;
    try {
      const res = await fetch(`${API}/todos/${todoId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ categoryId: catId })
      });
      const updated = await res.json();
      if (!res.ok) throw new Error(updated.error || '移动任务失败');
      const index = todos.findIndex(x => x.id === todoId);
      if (index !== -1) todos[index] = updated;
      renderCats();
      render();
    } catch (e) { console.error(e); }
  }

  function rememberTodoDraft(id, value) {
    todoEditDrafts.set(id, value);
  }

  function startEditTodo(id) {
    const todo = todos.find(t => t.id === id);
    if (!todo || todo.completed || todoEditSaving.has(id)) return;
    todoEditDrafts.set(id, todo.title);
    editingTodoId = id;
    render();
    const inp = document.getElementById(`edit-todo-${id}`);
    if (inp) { inp.focus(); inp.select(); }
  }

  async function saveTodoEdit(id) {
    if (todoEditSaving.has(id)) return;
    const inp = document.getElementById(`edit-todo-${id}`);
    if (!inp) return;
    todoEditDrafts.set(id, inp.value);
    const newTitle = inp.value.trim();
    if (!newTitle) { inp.classList.add('shake'); setTimeout(() => inp.classList.remove('shake'), 350); return; }
    const t = todos.find(x => x.id === id);
    if (!t || t.completed) {
      todoEditDrafts.delete(id);
      editingTodoId = null;
      render();
      return;
    }
    todoEditSaving.add(id);
    inp.disabled = true;
    try {
      const res = await fetch(`${API}/todos/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: newTitle })
      });
      const updated = await res.json();
      if (!res.ok) throw new Error(updated.error || '保存任务失败');
      const index = todos.findIndex(x => x.id === id);
      if (index !== -1) todos[index] = updated;
      todoEditDrafts.delete(id);
      if (editingTodoId === id) editingTodoId = null;
      render();
    } catch (e) {
      console.error(e);
      todoEditDrafts.set(id, inp.value);
      inp.disabled = false;
      inp.focus();
      inp.select();
      showToast('保存任务失败，请重试');
    } finally {
      todoEditSaving.delete(id);
    }
  }

  function handleTodoEditKey(e, id) {
    if (e.key === 'Enter') { e.preventDefault(); saveTodoEdit(id); }
    if (e.key === 'Escape' && !todoEditSaving.has(id)) {
      todoEditDrafts.delete(id);
      editingTodoId = null;
      render();
    }
  }

  /* ── Progress Modal ── */
  function openProgressModal(todoId) {
    const t = todos.find(x => x.id === todoId)
    if (t?.completed) return
    editingProgressTodoId = todoId
    const val = t?.progress ?? 0
    document.getElementById('progressRange').value = val
    document.getElementById('progressRangePct').textContent = val + '%'
    document.getElementById('progressModalTitle').textContent = t ? `进度: ${t.title}` : '设置进度'
    showModal('progressModal')
  }

  function syncProgressPct(val) {
    document.getElementById('progressRangePct').textContent = val + '%'
  }

  function setProgressVal(val) {
    document.getElementById('progressRange').value = val
    syncProgressPct(val)
  }

  function closeProgressModal() {
    hideModal('progressModal')
    editingProgressTodoId = null
  }

  async function saveProgress() {
    const val = parseInt(document.getElementById('progressRange').value, 10)
    const id = editingProgressTodoId
    closeProgressModal()
    if (!id) return
    const t = todos.find(x => x.id === id)
    if (t?.completed) return
    try {
      const res = await fetch(`${API}/todos/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ progress: val })
      })
      const updated = await res.json()
      if (!res.ok) throw new Error(updated.error || '保存进度失败')
      const index = todos.findIndex(x => x.id === id)
      if (index !== -1) todos[index] = updated
      renderCats()
      render({ animateTodoId: id })
      showToast('进度已更新')
    } catch (e) { console.error(e) }
  }

  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

  /* ── Category Modal ── */
  function initIconGrid() {
    const grid = document.getElementById('iconGrid');
    grid.innerHTML = PRESET_ICONS.map(icon => `
      <button class="icon-option${icon === selectedIcon ? ' selected' : ''}"
              onclick="selectIcon('${icon}')">${icon}</button>
    `).join('');
  }

  function selectIcon(icon) {
    selectedIcon = icon;
    document.querySelectorAll('.icon-option').forEach(opt => {
      opt.classList.toggle('selected', opt.textContent === icon);
    });
  }

  let pendingDeleteCatId = null;

  function openAddCatModal() {
    editingCatId = null;
    selectedIcon = '🏷️';
    document.getElementById('catModalTitle').textContent = '新增分类';
    document.getElementById('catNameInput').value = '';
    document.getElementById('saveCatBtn').textContent = '创建';
    document.getElementById('delCatBtn').style.display = 'none';
    showModal('catModal');
    document.getElementById('catNameInput').focus();
    initIconGrid();
  }

  function openEditCatModal(catId) {
    const cat = categories.find(c => c.id === catId);
    if (!cat) return;
    editingCatId = catId;
    selectedIcon = categoryIconText(cat);
    document.getElementById('catModalTitle').textContent = '编辑分类';
    document.getElementById('catNameInput').value = cat.name;
    document.getElementById('saveCatBtn').textContent = '保存';
    document.getElementById('delCatBtn').style.display = 'inline-flex';
    showModal('catModal');
    document.getElementById('catNameInput').focus();
    initIconGrid();
    // Pre-select current icon
    setTimeout(() => {
      document.querySelectorAll('.icon-option').forEach(opt => {
        opt.classList.toggle('selected', opt.textContent === selectedIcon);
      });
    }, 0);
  }

  function closeCatModal() {
    hideModal('catModal');
  }

  async function saveCatModal() {
    const name = document.getElementById('catNameInput').value.trim();
    if (!name) {
      document.getElementById('catNameInput').classList.add('shake');
      setTimeout(() => document.getElementById('catNameInput').classList.remove('shake'), 350);
      return;
    }
    try {
      if (editingCatId) {
        // Update
        const res = await fetch(`${API}/categories/${editingCatId}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name, icon: selectedIcon })
        });
        const updated = await res.json();
        const idx = categories.findIndex(c => c.id === editingCatId);
        if (idx !== -1) categories[idx] = updated;
        // Update active cat title if needed
        const activeCat = activeCatId ? categories.find(c => c.id === activeCatId) : null;
        if (activeCat) {
          document.getElementById('currentCatTitle').innerHTML = `${categoryIconMarkup(activeCat)} <span>${escHtml(activeCat.name)}</span>`;
        }
      } else {
        // Create
        const res = await fetch(API + '/categories', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name, icon: selectedIcon })
        });
        const newCat = await res.json();
        categories.push(newCat);
      }
      closeCatModal();
      renderCats();
      initCatPicker();
    } catch (e) { console.error(e); }
  }

  function openDelCatConfirm(catId) {
    const cat = categories.find(c => c.id === catId);
    if (!cat) return;
    pendingDeleteCatId = catId;
    const todoCount = todos.filter(t => t.categoryId === catId).length;
    const msg = todoCount > 0
      ? `确定删除「${categoryIconText(cat)} ${cat.name}」吗？该分类下 ${todoCount} 条待办也会一并删除，此操作不可撤销。`
      : `确定删除「${categoryIconText(cat)} ${cat.name}」吗？`;
    document.getElementById('confirmMsg').textContent = msg;
    showModal('confirmModal');
  }

  function closeConfirmModal() {
    hideModal('confirmModal');
    pendingDeleteCatId = null;
  }

  async function doDeleteCat() {
    if (!pendingDeleteCatId) return;
    const catId = pendingDeleteCatId;
    closeConfirmModal();
    try {
      await fetch(`${API}/categories/${catId}`, { method: 'DELETE' });
      categories = categories.filter(c => c.id !== catId);
      todos = todos.filter(t => t.categoryId !== catId);
      if (activeCatId === catId) activeCatId = null;
      document.getElementById('currentCatTitle').innerHTML = `${systemIcon('all')} <span>全部</span>`;
      renderCats();
      initCatPicker();
      render();
    } catch (e) { console.error(e); }
  }

  /* ── Date format ── */
  function formatDate(iso) {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '时间未知';
    const now = new Date();
    const isToday = d.toDateString() === now.toDateString();
    if (isToday) return `今天 ${pad(d.getHours())}:${pad(d.getMinutes())}`;
    const yd = new Date(now); yd.setDate(now.getDate() - 1);
    if (d.toDateString() === yd.toDateString()) return `昨天 ${pad(d.getHours())}:${pad(d.getMinutes())}`;
    return `${d.getMonth()+1}月${d.getDate()}日 ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }
  function pad(n) { return n.toString().padStart(2, '0'); }

  /* ── Help document ── */
  let helpLoaded = false;

  async function openHelpModal(source) {
    const modal = document.getElementById('helpModal');
    const preview = document.getElementById('helpPreview');
    if (!modal || !preview) return;
    showModal('helpModal', source);
    if (helpLoaded) return;
    preview.innerHTML = '<article class="note-document-page"><p>正在加载使用说明…</p></article>';
    try {
      const res = await fetch('USAGE.md?_=' + Date.now(), { cache: 'no-store' });
      if (!res.ok) throw new Error(`加载失败（${res.status}）`);
      const markdown = await res.text();
      preview.innerHTML = `<article class="note-document-page">${renderMarkdown(markdown)}</article>`;
      helpLoaded = true;
    } catch (e) {
      console.error(e);
      preview.innerHTML = '<article class="note-document-page"><p>使用说明暂时无法加载，请稍后重试。</p></article>';
    }
  }

  function closeHelpModal() {
    hideModal('helpModal');
  }

  /* ── Note modal ── */
  let noteTodoId = null;
  let noteMode = 'preview';
  let noteSessionToken = 0;
  let noteLoadStatus = 'idle';
  let noteLoadedSessionToken = 0;
  let noteSaveRequestToken = 0;
  let noteSaveInFlight = false;

  function setNoteReadOnlyState(readOnly, loading = false, saving = false) {
    const modal = document.getElementById('noteModal');
    const editTab = document.getElementById('noteTabEdit');
    const saveButton = modal?.querySelector('.modal-btn.primary');
    const editor = document.getElementById('noteEditor');
    const disabled = readOnly || loading || saving;
    if (modal) {
      modal.dataset.readonly = readOnly ? 'true' : 'false';
      modal.dataset.loading = loading ? 'true' : 'false';
      modal.dataset.saving = saving ? 'true' : 'false';
    }
    if (editTab) {
      editTab.hidden = readOnly;
      editTab.disabled = disabled;
    }
    if (saveButton) {
      saveButton.hidden = readOnly;
      saveButton.disabled = disabled;
    }
    if (editor) editor.readOnly = disabled;
  }

  async function openNoteModal(todoId, source) {
    noteSessionToken += 1;
    noteLoadStatus = 'loading';
    noteLoadedSessionToken = 0;
    noteSaveRequestToken += 1;
    noteSaveInFlight = false;
    const sessionToken = noteSessionToken;
    noteTodoId = todoId;
    const t = todos.find(x => x.id === todoId);
    const title = t ? t.title : '笔记';
    document.getElementById('noteModalTitle').textContent = `📄 ${title}`;
    setNoteReadOnlyState(!!t?.completed, true);
    document.getElementById('noteSaveStatus').textContent = t?.completed ? '任务已完成 · 仅供查看' : '';
    showModal('noteModal', source);
    setNoteMode('preview');
    document.getElementById('noteEditor').value = '';
    document.getElementById('notePreview').innerHTML = '<article class="note-document-page"><p>正在加载笔记…</p></article>';
    await loadNote(todoId, sessionToken);
  }

  function closeNoteModal() {
    noteSessionToken += 1;
    noteLoadStatus = 'idle';
    noteLoadedSessionToken = 0;
    noteSaveRequestToken += 1;
    noteSaveInFlight = false;
    hideModal('noteModal');
    noteTodoId = null;
    setNoteReadOnlyState(false);
  }

  async function loadNote(todoId, sessionToken) {
    const requestToken = sessionToken === undefined
      ? (typeof noteSessionToken === 'number' ? noteSessionToken : 0)
      : sessionToken;
    const isCurrent = () => requestToken === (typeof noteSessionToken === 'number' ? noteSessionToken : 0) &&
      noteTodoId === todoId;
    try {
      const res = await fetch(`${API}/todos/${todoId}/note`);
      const data = await res.json();
      if (!isCurrent()) return;
      if (!res.ok) throw new Error(data.error || `加载失败（${res.status}）`);
      document.getElementById('noteEditor').value = data.content || '';
      renderNotePreview(data.content || '');
      const t = todos.find(x => x.id === todoId);
      noteLoadStatus = 'ready';
      noteLoadedSessionToken = requestToken;
      setNoteReadOnlyState(!!t?.completed);
      if (t?.completed && noteMode === 'edit') setNoteMode('preview');
      if (t?.completed) document.getElementById('noteSaveStatus').textContent = '任务已完成 · 仅供查看';
      document.getElementById('noteModalTitle').textContent = `📄 ${t ? t.title : '笔记'}`;
    } catch (e) {
      console.error(e);
      if (isCurrent()) {
        noteLoadStatus = 'error';
        noteLoadedSessionToken = 0;
        const t = todos.find(x => x.id === todoId);
        setNoteReadOnlyState(!!t?.completed, true);
        document.getElementById('noteSaveStatus').textContent = '❌ 加载失败，请关闭后重试';
      }
    }
  }

  function setNoteMode(mode) {
    const noteTodo = todos.find(x => x.id === noteTodoId);
    if (mode === 'edit' && (noteLoadStatus !== 'ready' || noteLoadedSessionToken !== noteSessionToken)) {
      document.getElementById('noteSaveStatus').textContent = noteLoadStatus === 'error'
        ? '❌ 加载失败，请关闭后重试'
        : '笔记加载中…';
      return;
    }
    if (mode === 'edit' && noteTodo?.completed) {
      setNoteReadOnlyState(true);
      document.getElementById('noteSaveStatus').textContent = '任务已完成 · 仅供查看';
      mode = 'preview';
    }
    noteMode = mode;
    const modal = document.getElementById('noteModal');
    modal.dataset.mode = mode === 'edit' ? 'editor' : 'preview';
    document.getElementById('noteTabPreview').classList.toggle('active', mode !== 'edit');
    document.getElementById('noteTabEdit').classList.toggle('active', mode === 'edit');
    if (mode === 'edit') {
      const ed = document.getElementById('noteEditor');
      ed.focus();
    } else {
      renderNotePreview(document.getElementById('noteEditor').value);
    }
  }

  function renderNotePreview(content) {
    const html = renderMarkdown(content !== undefined ? content : document.getElementById('noteEditor').value);
    document.getElementById('notePreview').innerHTML = `<article class="note-document-page">${html}</article>`;
  }

  async function saveNote() {
    if (!noteTodoId) return;
    if (noteSaveInFlight) return;
    if (noteLoadStatus !== 'ready' || noteLoadedSessionToken !== noteSessionToken) {
      document.getElementById('noteSaveStatus').textContent = noteLoadStatus === 'error'
        ? '❌ 加载失败，请关闭后重试'
        : '笔记加载中…';
      return;
    }
    const todo = todos.find(x => x.id === noteTodoId);
    if (!todo || todo.completed) {
      setNoteReadOnlyState(true);
      setNoteMode('preview');
      document.getElementById('noteSaveStatus').textContent = '任务已完成 · 仅供查看';
      return;
    }
    const content = document.getElementById('noteEditor').value;
    const savedTodoId = noteTodoId;
    const savedSessionToken = noteSessionToken;
    const saveRequestToken = ++noteSaveRequestToken;
    const isCurrent = () => noteSessionToken === savedSessionToken && noteTodoId === savedTodoId &&
      noteSaveRequestToken === saveRequestToken;
    noteSaveInFlight = true;
    setNoteReadOnlyState(false, false, true);
    document.getElementById('noteSaveStatus').textContent = '保存中…';
    try {
      const res = await fetch(`${API}/todos/${savedTodoId}/note`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content })
      });
      const data = await res.json();
      if (!isCurrent()) return;
      if (!res.ok) {
        if (res.status === 409) {
          setNoteReadOnlyState(true);
          setNoteMode('preview');
          document.getElementById('noteSaveStatus').textContent = '任务已完成 · 仅供查看';
          return;
        }
        throw new Error(data.error || `保存失败（${res.status}）`);
      }
      renderNotePreview(content);
      const st = document.getElementById('noteSaveStatus');
      st.textContent = '✅ 已保存';
      const t = todos.find(x => x.id === savedTodoId);
      if (t) {
        t.noteFile = data.noteFile;
        if (data.updatedAt) t.updatedAt = data.updatedAt;
      }
      render();
      await sleep(1000);
      if (isCurrent()) closeNoteModal();
    } catch (e) {
      console.error(e);
      if (isCurrent()) {
        document.getElementById('noteSaveStatus').textContent = '❌ 保存失败';
        const currentTodo = todos.find(x => x.id === savedTodoId);
        setNoteReadOnlyState(!!currentTodo?.completed);
      }
    } finally {
      if (noteSaveRequestToken === saveRequestToken) noteSaveInFlight = false;
    }
  }

  /* ── Markdown renderer ── */
  function escMd(s) {
    return String(s ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }
  function safeMdUrl(value) {
    const decoder = document.createElement('textarea');
    decoder.innerHTML = String(value || '');
    const decoded = decoder.value.trim();
    try {
      const parsed = new URL(decoded, document.baseURI);
      if (!['http:', 'https:', 'mailto:'].includes(parsed.protocol)) return null;
      return escMd(decoded);
    } catch (_) {
      return null;
    }
  }
  function inlineMd(s) {
    let html = escMd(s);
    html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (match, label, href) => {
      const safeHref = safeMdUrl(href);
      return safeHref
        ? `<a href="${safeHref}" target="_blank" rel="noopener">${label}</a>`
        : label;
    });
    return html
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/\*([^*]+)\*/g, '<em>$1</em>')
      .replace(/~~([^~]+)~~/g, '<del>$1</del>');
  }
  function renderMarkdown(md) {
    if (!md) return '<p style="color:var(--text-3)"><i>空白笔记，点击"编辑"开始书写</i></p>';
    const lines = md.replace(/\r\n/g, '\n').split('\n');
    let html = '';
    let inCode = false, inCodeLines = [], tableRows = [];
    const flushTable = () => {
      if (tableRows.length < 3) { html += tableRows.join('<br>'); tableRows = []; return; }
      const rows = tableRows.map((r, i) => {
        if (/^\|?\s*:?-+\s*(\|\s*:?-+\s*)+\|?$/.test(r.trim())) return null;
        const cells = r.split('|').slice(1, -1);
        const tag = i === 0 ? 'th' : 'td';
        return `<tr>${cells.map(c => `<${tag}>${inlineMd(c.trim())}</${tag}>`).join('')}</tr>`;
      }).filter(Boolean);
      if (rows.length) {
        html += `<table><thead>${rows[0]}</thead><tbody>${rows.slice(1).join('')}</tbody></table>`;
      }
      tableRows = [];
    };
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const trimmed = line.trim();
      const isTableRow = trimmed.startsWith('|') && trimmed.endsWith('|');
      if (tableRows.length && !isTableRow) flushTable();
      if (trimmed.startsWith('```')) {
        if (inCode) { html += `<pre><code>${escMd(inCodeLines.join('\n'))}</code></pre>`; inCodeLines = []; inCode = false; }
        else { inCode = true; inCodeLines = []; }
        continue;
      }
      if (inCode) { inCodeLines.push(line); continue; }
      const h = trimmed.match(/^(#{1,6})\s+(.*)$/);
      if (h) { html += `<h${h[1].length}>${inlineMd(h[2])}</h${h[1].length}>`; continue; }
      if (isTableRow) {
        tableRows.push(trimmed);
        continue;
      }
      if (/^[-*]\s+/.test(trimmed) && !/^[-*]\s+\[[ xX]\]/.test(trimmed)) {
        const items = [];
        while (i < lines.length) {
          const t2 = lines[i].trim();
          if (t2 === '' || !/^[-*]\s+/.test(t2)) break;
          items.push(t2.replace(/^[-*]\s+/, ''));
          i++;
        }
        i--;
        html += `<ul>${items.map(it => `<li>${inlineMd(it)}</li>`).join('')}</ul>`;
        continue;
      }
      if (/^\d+\.\s+/.test(trimmed)) {
        const items = [];
        while (i < lines.length) {
          const t2 = lines[i].trim();
          if (t2 === '') break;
          const m = t2.match(/^\d+\.\s+(.*)$/);
          if (!m) break;
          items.push(m[1]);
          i++;
        }
        i--;
        html += `<ol>${items.map(it => `<li>${inlineMd(it)}</li>`).join('')}</ol>`;
        continue;
      }
      if (/\s*- \[[ xX]\]\s*/.test(trimmed)) {
        const items = [];
        while (i < lines.length) {
          const t2 = lines[i].trim();
          if (t2 === '') break;
          const m = t2.match(/^- \[([ xX])\]\s*(.*)$/);
          if (!m) break;
          items.push(`<li><input type="checkbox" ${m[1].toLowerCase() === 'x' ? 'checked' : ''} disabled> ${inlineMd(m[2])}</li>`);
          i++;
        }
        i--;
        html += `<ul class="task-list">${items.join('')}</ul>`;
        continue;
      }
      if (trimmed.startsWith('> ')) {
        const quotes = [];
        while (i < lines.length && lines[i].trim().startsWith('> ')) { quotes.push(lines[i].trim().slice(2)); i++; }
        i--;
        html += `<blockquote>${quotes.map(q => inlineMd(q)).join('<br>')}</blockquote>`;
        continue;
      }
      if (trimmed === '---' || trimmed === '***') { html += '<hr>'; continue; }
      if (trimmed === '') { continue; }
      html += `<p>${inlineMd(line)}</p>`;
    }
    if (inCode) { flushTable(); html += `<pre><code>${escMd(inCodeLines.join('\n'))}</code></pre>`; }
    flushTable();
    return html;
  }


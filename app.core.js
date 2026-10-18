/* Personal Todo Vault — 前端核心：全局状态、启动链、访问保护门、动画与弹窗 / toast 通用件
   经典 script 依序加载、共享全局作用域；依赖 app.core.js 先行。 */

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

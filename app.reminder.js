/* Personal Todo Vault — 任务提醒：发送时间与重复规则
   经典 script 依序加载、共享全局作用域；依赖 app.core.js 先行。 */
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


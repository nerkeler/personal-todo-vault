/* Personal Todo Vault — 日历：月视图、日视图回退与新增待办的时间选择器
   经典 script 依序加载、共享全局作用域；依赖 app.core.js 先行。 */
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

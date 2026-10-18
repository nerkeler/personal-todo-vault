/* Personal Todo Vault — 待办：数据加载、卡片渲染、行内编辑、进度与完成状态
   经典 script 依序加载、共享全局作用域；依赖 app.core.js 先行。 */
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

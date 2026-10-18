/* Personal Todo Vault — 分类：侧栏展示、排序、原生 select 与分类弹窗
   经典 script 依序加载、共享全局作用域；依赖 app.core.js 先行。 */
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

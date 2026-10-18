/* Personal Todo Vault — Markdown：使用说明、笔记弹窗与渲染器
   经典 script 依序加载、共享全局作用域；依赖 app.core.js 先行。 */
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


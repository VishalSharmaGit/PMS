

/* ------------------------- Tab cache-and-refresh engine ------------------------- */
// Generic pattern: first visit to a tab does a real fetch and shows a spinner.
// Every later visit paints instantly from cache, then quietly refetches in the
// background and re-renders only if the tab is still the one showing.
const tabCache = { dashboard: null, tasks: null, workers: null, assign: null, reports: null };

function loadTabData(tabName, fetcher, onData, container) {
  const cached = tabCache[tabName];
  if (cached) {
    onData(cached, false); // instant paint from cache, not a fresh fetch
  } else if (container) {
    container.innerHTML = '<div class="loading-spinner"><div class="spinner"></div></div>';
  }

  fetcher().then(data => {
    tabCache[tabName] = data;
    if (state.tab === tabName) onData(data, true); // only repaint if still on this tab
  }).catch(error => {
    if (!cached && container) {
      container.innerHTML = `<div class="glass-card empty">${esc(error.message || 'Something went wrong.')}</div>`;
    }
    // if cached data is already showing, a failed background refresh just keeps showing what we have
  });
}

  const state = { token: 'supabase', user: null, processes: [], tab: 'dashboard', pending: [], setup: null };
const run = (name, ...args) => window.callApi(name, ...args).catch(e => {   // Supabase instead of google.script.run
  if (/session has ended/i.test(e.message) && state.user) { state.user = null; location.reload(); }
  throw e;
});
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/* ------------------------------- Boot / auth ------------------------------- */

function onIdentifierInput() { /* password/PIN field is always visible now */ }

function submitLogin(event) {
  event.preventDefault();
  const identifier = document.querySelector('#loginIdentifier').value;
  const password = document.querySelector('#loginPassword').value;
  const btn = event.target.querySelector('button[type=submit]');
  const errorEl = document.querySelector('#loginError');
  errorEl.textContent = '';
  btn.disabled = true;

  run('login', identifier, password).then(result => {
    document.querySelector('#loginPassword').value = '';
    document.querySelector('#loginScreen').hidden = true;
    onAuthenticated(result);
  }).catch(e => { errorEl.textContent = e.message; }).finally(() => { btn.disabled = false; });
}

function boot() {
  run('getAppContext', state.token).then(ctx => {
    if (!ctx.user) { showLogin(); return; }
    onAuthenticated(ctx);
  }).catch(e => {
    console.error('boot() failed:', e);
    showLogin(e.message);
  });
}

function showLogin(errorMessage) {
  document.querySelector('#app').hidden = true;
  document.querySelector('#loginScreen').hidden = false;
  const el = document.querySelector('#loginError');
  if (el) el.textContent = errorMessage || '';
}

let originalTabsHTML = null;

function onAuthenticated(ctx) {
  // Snapshot the full tab bar once, before any role-based tabs get removed —
  // so signOut can restore it for whoever signs in next.
  if (originalTabsHTML === null) {
    const tabsEl = document.querySelector('.tabs-scroll');
    if (tabsEl) originalTabsHTML = tabsEl.innerHTML;
  }

  document.querySelector('#loginScreen').hidden = true;
  state.user = ctx.user; state.processes = ctx.processes;
  document.querySelector('#app').hidden = false;
  document.querySelector('#userDisplay').textContent = ctx.user.name;
  document.querySelector('#userRole').textContent = ctx.user.role.replace('_', ' ');
  const isManager = ['ADMIN', 'PRODUCTION_MANAGER'].includes(ctx.user.role);
  document.querySelectorAll('.manager').forEach(x => x.hidden = !isManager);
  document.querySelectorAll('.admin').forEach(x => x.hidden = ctx.user.role !== 'ADMIN');

  if (ctx.user.role === 'WORKER') {
    document.querySelectorAll('.tab').forEach(btn => { if (btn.dataset.tab !== 'tasks') btn.remove(); });
    switchTab('tasks');
  } else {
    switchTab('dashboard');
  }
  startMyTasksPolling();
  startRealtime();
}

function signOut() {
  const signOutBtn = document.querySelector('.text-btn');
  if (signOutBtn) signOutBtn.disabled = true;

  run('logout', state.token).catch(() => {}).finally(() => {
    state.token = null;
    state.user = null;
    state.myTasks = null;
    state.pending = [];
    state.setup = null;
    stopMyTasksPolling();
    stopRealtime();
    resetHistoryFlags();

    // Put the tab bar back to its full, un-trimmed state (undoes the worker-only
    // tab removal from onAuthenticated) so the next sign-in sees everything again —
    // no full page reload needed, which avoids the blank sandboxed-iframe flash.
    const tabsEl = document.querySelector('.tabs-scroll');
    if (tabsEl && originalTabsHTML !== null) tabsEl.innerHTML = originalTabsHTML;

    document.querySelector('#app').hidden = true;
    document.querySelector('#tabContent').innerHTML = '';
    const passwordEl = document.querySelector('#loginPassword');
    if (passwordEl) passwordEl.value = '';
    const errorEl = document.querySelector('#loginError');
    if (errorEl) errorEl.textContent = '';
    document.querySelector('#loginScreen').hidden = false;
    if (signOutBtn) signOutBtn.disabled = false;
  });
}

/* --------------------------------- Tabs --------------------------------- */

function switchTab(tab) {
  state.tab = tab;
  document.querySelectorAll('.tab').forEach(btn => btn.classList.toggle('active', btn.dataset.tab === tab));
  const container = document.querySelector('#tabContent');
  container.classList.remove('tab-ready');
  container.innerHTML = '<div class="loading-spinner"><div class="spinner"></div></div>';
  requestAnimationFrame(() => {
    const handlers = { dashboard: () => dashboard(container), tasks: () => tasks(container), workers: () => workers(container), assign: () => assign(container), reports: () => reports(container) };
    try {
      (handlers[tab] || handlers.dashboard)();
      requestAnimationFrame(() => container.classList.add('tab-ready'));
    } catch (e) {
      console.error('switchTab failed for "' + tab + '":', e);
      container.innerHTML = `<div class="glass-card empty">Something went wrong loading this tab: ${esc(e.message)}</div>`;
    }
  });
}

let myTasksPollTimer = null;

// Silently refetches only this worker's tasks and re-renders just #taskGrid —
// never touches the rest of the page, so nothing "reloads" visibly.
function startMyTasksPolling() {
  stopMyTasksPolling();
  myTasksPollTimer = setInterval(() => {
    if (!state.user || state.tab !== 'tasks') return;   // only poll while My Tasks is the open tab
    if (document.visibilityState === 'hidden') return;  // don't poll a backgrounded/minimized tab
    run('getMyTasks', state.token, { all: histFull.tasks }).then(items => {
      if (!items) return;
      state.myTasks = items;
      renderMyTasks(); // rebuilds only the task cards, using whatever filters are currently set
    }).catch(() => {}); // silent — a missed background poll just tries again next cycle
  }, 60000);   // safety net only — real-time pushes changes instantly
}

function stopMyTasksPolling() {
  if (myTasksPollTimer) { clearInterval(myTasksPollTimer); myTasksPollTimer = null; }
}

/* ------------- Recent-first loading: open + last N days load instantly; older history on demand ------------- */
const histFull = { dashboard: false, tasks: false };
function resetHistoryFlags() { histFull.dashboard = false; histFull.tasks = false; }
function recentCutoffDate() {
  const d = new Date(); d.setDate(d.getDate() - ((window.PMS_CONFIG || {}).RECENT_DAYS || 45));
  return d.toISOString().slice(0, 10);
}
function keepSelect(id, fn) {                 // re-fill a filter list without losing what the person had chosen
  const el = document.querySelector(id), v = el ? el.value : '';
  fn(); const el2 = document.querySelector(id); if (el2 && v) el2.value = v;
}
function loadFullHistory(kind) {
  if (histFull[kind]) return;
  histFull[kind] = true;
  toast('Loading full history…', 'info');
  const p = kind === 'dashboard'
    ? run('getDashboard', state.token, { all: true }).then(r => {
        tabCache.dashboard = r; state.dashboardTasks = r.tasks || [];
        ['#dashboardWorker', '#dashboardProcess'].forEach(id => keepSelect(id, populateDashboardFilters));
        renderDashboardFiltered();
      })
    : run('getMyTasks', state.token, { all: true }).then(items => {
        tabCache.tasks = items; state.myTasks = items;
        ['#myTaskWorker', '#myTaskProcess', '#myTaskFMS'].forEach(id => keepSelect(id, populateMyTaskFilters));
        renderMyTasks();
      });
  p.catch(e => { histFull[kind] = false; toast(e.message, 'error'); });
}

/* ------------- Real-time: the database pushes every task change straight to this screen ------------- */
let rtChannel = null, rtTimer = null;

function startRealtime() {
  stopRealtime();
  rtChannel = window.sb.channel('pms-tasks-' + Math.random().toString(36).slice(2))
    .on('postgres_changes', { event: '*', schema: 'public', table: 'pms_tasks' }, onTaskChange)
    .subscribe(status => { if (status === 'SUBSCRIBED') scheduleLiveRefresh(); });   // (re)connected -> resync once
}
function stopRealtime() {
  clearTimeout(rtTimer);
  if (rtChannel) { try { window.sb.removeChannel(rtChannel); } catch (e) {} rtChannel = null; }
}
function upsertTask(list, task, newestFirst) {
  const i = list.findIndex(x => x && String(x['Assignment ID']) === String(task['Assignment ID']));
  if (i > -1) list[i] = task; else if (newestFirst) list.unshift(task); else list.push(task);
}
function onTaskChange(payload) {
  const row = payload && payload.new;
  if (!row || !row.assignment_id || !state.user) return;
  const task = window.rowToApi(row);
  if (state.myTasks)        { upsertTask(state.myTasks, task, true);  if (tabCache.tasks)     tabCache.tasks = state.myTasks; }
  if (state.dashboardTasks) { upsertTask(state.dashboardTasks, task, false); if (tabCache.dashboard) tabCache.dashboard = { tasks: state.dashboardTasks }; }
  clearTimeout(rtTimer);
  rtTimer = setTimeout(repaintLive, 150);      // merge a burst of changes into one repaint
}
function repaintLive() {
  if (!state.user || document.visibilityState === 'hidden') return;
  if (state.tab === 'tasks' && state.myTasks) renderMyTasks();
  else if (state.tab === 'dashboard' && state.dashboardTasks) renderDashboardFiltered();
}
function scheduleLiveRefresh() {              // full resync (after reconnect / returning to the tab)
  clearTimeout(rtTimer);
  rtTimer = setTimeout(() => {
    if (!state.user || document.visibilityState === 'hidden') return;
    if (state.tab === 'tasks') {
      run('getMyTasks', state.token, { all: histFull.tasks }).then(items => { if (items && state.tab === 'tasks') { tabCache.tasks = items; state.myTasks = items; renderMyTasks(); } }).catch(() => {});
    } else if (state.tab === 'dashboard') {
      run('getDashboard', state.token, { all: histFull.dashboard }).then(r => { if (r && state.tab === 'dashboard') { tabCache.dashboard = r; state.dashboardTasks = r.tasks || []; renderDashboardFiltered(); } }).catch(() => {});
    }
  }, 300);
}
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') scheduleLiveRefresh(); });

/* -------------------------------- Dashboard -------------------------------- */

function dashboard(c) {
  c.innerHTML = `
    <section class="page-head">
      <div>
        <h1>Production dashboard</h1>
        <p>Live task status across the production floor.</p>
      </div>
    </section>

    <div class="dashboard-filters">
      <input type="text" id="dashboardOrder" placeholder="Search Order No." oninput="filterDashboard()">
      <select id="dashboardWorker" onchange="filterDashboard()"><option value="">All workers</option></select>
      <select id="dashboardProcess" onchange="filterDashboard()"><option value="">All processes</option></select>
      <div class="date-range">
        <input type="date" id="dashboardDateFrom" onchange="filterDashboard()" title="From date">
        <span>to</span>
        <input type="date" id="dashboardDateTo" onchange="filterDashboard()" title="To date">
      </div>
    </div>

    <div id="dashboardContent">
      <div class="loading-spinner"><div class="spinner"></div></div>
    </div>
  `;

  loadTabData('dashboard', () => run('getDashboard', state.token, { all: histFull.dashboard }), (result) => {
    state.dashboardTasks = result?.tasks || [];
    populateDashboardFilters();
    renderDashboardFiltered();
  }, document.querySelector('#dashboardContent'));
}

function populateDashboardFilters() {

  const tasks = state.dashboardTasks || [];

  const workers = [
    ...new Set(
      tasks
        .map(t => String(t['Worker Name'] || '').trim())
        .filter(Boolean)
    )
  ].sort();

  const processes = [
    ...new Set(
      tasks
        .map(t => String(t.Process || '').trim())
        .filter(Boolean)
    )
  ].sort();

  const workerSelect =
    document.querySelector('#dashboardWorker');

  const processSelect =
    document.querySelector('#dashboardProcess');

  if (workerSelect) {
    workerSelect.innerHTML =
      `<option value="">All workers</option>` +
      workers
        .map(w => `<option value="${esc(w)}">${esc(w)}</option>`)
        .join('');
  }

  if (processSelect) {
    processSelect.innerHTML =
      `<option value="">All processes</option>` +
      processes
        .map(p => `<option value="${esc(p)}">${esc(p)}</option>`)
        .join('');
  }
}

function filterDashboard() {
  renderDashboardFiltered();
  if (histFull.dashboard) return;
  const from = document.querySelector('#dashboardDateFrom')?.value || '';
  const order = String(document.querySelector('#dashboardOrder')?.value || '').trim().toLowerCase();
  const noMatch = order && !(state.dashboardTasks || []).some(t => String(t['Order ID'] || '').toLowerCase().includes(order));
  if ((from && from < recentCutoffDate()) || noMatch) loadFullHistory('dashboard');
}

function renderDashboardFiltered() {

  const allTasks = state.dashboardTasks || [];

  const order =
    String(
      document.querySelector('#dashboardOrder')?.value || ''
    )
      .trim()
      .toLowerCase();

  const worker =
    document.querySelector('#dashboardWorker')?.value || '';

  const process =
    document.querySelector('#dashboardProcess')?.value || '';

  const fromDate =
    document.querySelector('#dashboardDateFrom')?.value || '';

  const toDate =
    document.querySelector('#dashboardDateTo')?.value || '';

  const filtered = allTasks.filter(task => {

    // ---------------- Order ----------------
    const orderMatch =
      !order ||
      String(task['Order ID'] || '')
        .toLowerCase()
        .includes(order);

    // ---------------- Worker ----------------
    const workerMatch =
      !worker ||
      String(task['Worker Name'] || '') === worker;

    // ---------------- Process ----------------
    const processMatch =
      !process ||
      String(task.Process || '') === process;

    // ---------------- Date Range ----------------
    let dateMatch = true;

    const timestamp =
      task['Assigned Timestamp'] ||
      task['Created Timestamp'];

    if (fromDate || toDate) {

      if (!timestamp) {
        dateMatch = false;
      } else {

        const taskDate = new Date(timestamp);

        if (fromDate) {
          const from = new Date(fromDate + 'T00:00:00');

          if (taskDate < from) {
            dateMatch = false;
          }
        }

        if (toDate) {
          const to = new Date(toDate + 'T23:59:59');

          if (taskDate > to) {
            dateMatch = false;
          }
        }
      }
    }

    return (
      orderMatch &&
      workerMatch &&
      processMatch &&
      dateMatch
    );
  });

  // ---------------- KPI ----------------

  const total =
    filtered.length;

  const assigned =
    filtered.filter(
      t => String(t.Status).toUpperCase() === 'ASSIGNED'
    ).length;

  const progress =
    filtered.filter(
      t => String(t.Status).toUpperCase() === 'IN_PROGRESS'
    ).length;

  const completed =
    filtered.filter(
      t => String(t.Status).toUpperCase() === 'COMPLETED'
    ).length;


    // ---------------- Recent Tasks ----------------
  const searching = !!order;

  const recent = searching
    ? [...filtered].sort((a, b) => {
        const ta = new Date(a['Start Timestamp'] || a['Assigned Timestamp'] || a['Created Timestamp'] || 0).getTime();
        const tb = new Date(b['Start Timestamp'] || b['Assigned Timestamp'] || b['Created Timestamp'] || 0).getTime();
        return ta - tb; // earliest first, so the work sequence is readable top-to-bottom
      })
    : [...filtered]
        .sort((a, b) => {
          const da = new Date(a['Assigned Timestamp'] || a['Created Timestamp'] || 0).getTime();
          const db = new Date(b['Assigned Timestamp'] || b['Created Timestamp'] || 0).getTime();
          return db - da;
        })
        .slice(0, 8);


  const el =
    document.querySelector('#dashboardContent');

  if (!el) return;

  el.innerHTML = `

    <div class="stats">

      <article>
        <b>${total}</b>
        <span>Total tasks</span>
      </article>

      <article>
        <b>${assigned}</b>
        <span>Assigned</span>
      </article>

      <article>
        <b>${progress}</b>
        <span>In progress</span>
      </article>

      <article>
        <b>${completed}</b>
        <span>Completed</span>
      </article>

    </div>

    <section class="glass-card">

      <h2>${searching ? 'Matching tasks (in order worked)' : 'Recent tasks'}</h2>

      ${taskTable(recent)}

    </section>
  `;
}

function taskTable(items) {
  if (!items.length) return '<p class="empty">No tasks yet.</p>';

  // End Timestamp arrives as "yyyy-MM-dd HH:mm:ss" — show it as dd/MM/yyyy HH:mm.
  const fmtDate = v => {
    const m = String(v || '').match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}:\d{2}))?/);
    return m ? `${m[3]}/${m[2]}/${m[1]}${m[4] ? ' ' + m[4] : ''}` : '—';
  };

  return `<div class="table-wrap"><table><thead><tr><th>Order</th><th>Process</th><th>Worker</th><th>Status</th><th>Completion Date</th><th>Actual hrs</th></tr></thead><tbody>
    ${items.map(t => `<tr><td>${esc(t['Order ID'])}</td><td>${esc(t.Process)}</td><td>${esc(t['Worker Name'])}</td>
      <td><span class="status ${String(t.Status).toLowerCase()}">${esc(t.Status)}</span></td>
      <td>${String(t.Status).toUpperCase() === 'COMPLETED' ? esc(fmtDate(t['End Timestamp'])) : '—'}</td>
      <td>${t['Actual Hours'] ? Number(t['Actual Hours']).toFixed(2) : '—'}</td></tr>`).join('')}
    </tbody></table></div>`;
}


/* --------------------------------- My tasks --------------------------------- */

function tasks(c) {
  c.innerHTML = `
    <section class="page-head mytasks-head">
      <div>
        <h1>My tasks</h1>
        <p>Start and complete only the work assigned to you.</p>
      </div>
    </section>

    <div id="myTasksFilters" class="mytasks-filters">

      <!-- Worker Name -->
      <select id="myTaskWorker" onchange="filterMyTasks()">
        <option value="">All workers</option>
      </select>

      <!-- Process -->
      <select id="myTaskProcess" onchange="filterMyTasks()">
        <option value="">All processes</option>
      </select>

      <!-- Process -->
      <select id="myTaskFMS" onchange="filterMyTasks()">
        <option value="">All FMS</option>
      </select>

      <!-- Order -->
      <input
        id="myTaskOrder"
        type="text"
        placeholder="Search Order No."
        oninput="filterMyTasks()"
      >

      <!-- Date Range -->
      <div class="mytask-date-range">
        <input
          id="myTaskDateFrom"
          type="date"
          onchange="filterMyTasks()"
        >

        <span>to</span>

        <input
          id="myTaskDateTo"
          type="date"
          onchange="filterMyTasks()"
        >
      </div>

    </div>

    <!-- Status -->
    <div class="mytask-status-filter">

      <button
        class="mytask-status active"
        data-status="ASSIGNED"
        onclick="setMyTaskStatus('ASSIGNED')"
      >
        Pending
      </button>

      <button
        class="mytask-status"
        data-status="IN_PROGRESS"
        onclick="setMyTaskStatus('IN_PROGRESS')"
      >
        In Progress
      </button>

      <button
        class="mytask-status"
        data-status="COMPLETED"
        onclick="setMyTaskStatus('COMPLETED')"
      >
        Completed
      </button>

    </div>

    <div id="taskGrid" class="task-grid">
      <div class="glass-card empty">
        <div class="loading-spinner">
          <div class="spinner"></div>
        </div>
      </div>
    </div>
  `;

    loadTabData('tasks', () => run('getMyTasks', state.token, { all: histFull.tasks }), (items) => {
    state.myTasks = items || [];
    if (!state.myTaskStatus) state.myTaskStatus = 'ASSIGNED'; // only default once, don't reset an active filter on refresh
    populateMyTaskFilters();
    renderMyTasks();
  }, document.querySelector('#taskGrid'));
}

function populateMyTaskFilters() {

  const items = state.myTasks || [];

  const workers = [
    ...new Set(
      items
        .map(t => String(t['Worker Name'] || '').trim())
        .filter(Boolean)
    )
  ].sort();

  const processes = [
    ...new Set(
      items
        .map(t => String(t.Process || '').trim())
        .filter(Boolean)
    )
  ].sort();

  const workerSelect =
    document.querySelector('#myTaskWorker');

  const processSelect =
    document.querySelector('#myTaskProcess');
  
  const fmsSelect =
    document.querySelector('#myTaskFMS');


  if (workerSelect) {
    workerSelect.innerHTML =
      `<option value="">All workers</option>` +
      workers.map(name =>
        `<option value="${esc(name)}">${esc(name)}</option>`
      ).join('');
  }

  if (fmsSelect) {
    const fmsIds = [
      ...new Set(
        items
          .map(t => String(t['FMS ID'] || '').trim())
          .filter(Boolean)
      )
    ].sort();

    fmsSelect.innerHTML =
      `<option value="">All FMS</option>` +
      fmsIds.map(id =>
        `<option value="${esc(id)}">${esc(id)}</option>`
      ).join('');
  }

  if (processSelect) {
    processSelect.innerHTML =
      `<option value="">All processes</option>` +
      processes.map(process =>
        `<option value="${esc(process)}">${esc(process)}</option>`
      ).join('');
  }
}

function setMyTaskStatus(status) {

  state.myTaskStatus = status;

  document
    .querySelectorAll('.mytask-status')
    .forEach(button => {
      button.classList.toggle(
        'active',
        button.dataset.status === status
      );
    });

  renderMyTasks();
}

function filterMyTasks() {
  renderMyTasks();
  if (histFull.tasks) return;
  const from = document.querySelector('#myTaskDateFrom')?.value || '';
  const order = String(document.querySelector('#myTaskOrder')?.value || '').trim().toLowerCase();
  const noMatch = order && !(state.myTasks || []).some(t => String(t['Order ID'] || '').toLowerCase().includes(order));
  if ((from && from < recentCutoffDate()) || noMatch) loadFullHistory('tasks');
}

function renderMyTasks() {

  const allTasks = state.myTasks || [];

  const status =
    state.myTaskStatus || 'ASSIGNED';

  const worker =
    document.querySelector('#myTaskWorker')?.value || '';
  
  const fms =
    document.querySelector('#myTaskFMS')?.value || '';

  const process =
    document.querySelector('#myTaskProcess')?.value || '';

  const order =
    String(
      document.querySelector('#myTaskOrder')?.value || ''
    )
      .trim()
      .toLowerCase();

  const fromDate =
    document.querySelector('#myTaskDateFrom')?.value || '';

  const toDate =
    document.querySelector('#myTaskDateTo')?.value || '';

  const filtered = allTasks.filter(task => {
    // ---------------- FMS ----------------
    const fmsMatch =
      !fms ||
      String(task['FMS ID'] || '') === fms;
    // ---------------- STATUS ----------------
    const taskStatus = String(task.Status || '').toUpperCase();
    const statusMatch =
      status === 'IN_PROGRESS'
        ? (taskStatus === 'IN_PROGRESS' || taskStatus === 'PAUSED')
        : taskStatus === status;

    // ---------------- WORKER ----------------
    const workerMatch =
      !worker ||
      String(task['Worker Name'] || '') === worker;

    // ---------------- PROCESS ----------------
    const processMatch =
      !process ||
      String(task.Process || '') === process;

    // ---------------- ORDER ----------------
    const orderMatch =
      !order ||
      String(task['Order ID'] || '')
        .toLowerCase()
        .includes(order);

    // ---------------- DATE ----------------
    let dateMatch = true;

    const taskTimestamp =
      task['Assigned Timestamp'] ||
      task['Created Timestamp'];

    if (fromDate || toDate) {

      if (!taskTimestamp) {

        dateMatch = false;

      } else {

        const taskDate =
          new Date(taskTimestamp);

        if (fromDate) {

          const from =
            new Date(fromDate + 'T00:00:00');

          if (taskDate < from) {
            dateMatch = false;
          }
        }

        if (toDate) {

          const to =
            new Date(toDate + 'T23:59:59');

          if (taskDate > to) {
            dateMatch = false;
          }
        }
      }
    }

    return (
      statusMatch &&
      workerMatch &&
      processMatch &&
      fmsMatch &&
      orderMatch &&
      dateMatch
    );
  });

  const grid =
    document.querySelector('#taskGrid');

  if (!grid) return;

  if (!filtered.length) {

    const statusText =
      status === 'ASSIGNED'
        ? 'pending'
        : status === 'IN_PROGRESS'
          ? 'in-progress'
          : 'completed';

    grid.innerHTML = `
      <div class="glass-card empty mytask-empty">
        No ${statusText} tasks match your filters.
      </div>
    `;

    return;
  }

  grid.innerHTML =
    filtered.map(taskCard).join('');
}

function taskCard(t) {
  const s = String(t.Status || '');
  const isPieceRate = String(t['Pay Type'] || '').trim() === 'PIECE_RATE';

  const isManager = state.user && ['ADMIN', 'PRODUCTION_MANAGER'].includes(state.user.role);
  const transferBtn = (isManager && s === 'ASSIGNED')
    ? `<button type="button" class="secondary" style="margin-top:8px;width:100%;" onclick="openTransferModal('${esc(t['Assignment ID'])}','${esc(t.Process)}','${esc(t['Worker ID'])}')">Transfer to another worker</button>`
    : '';

  const action = isPieceRate
    ? (s === 'ASSIGNED'
        ? `<button class="primary" onclick="executeTask('${esc(t['Assignment ID'])}','done')">Done</button>`
        : `<button class="assigned-action" disabled>Completed</button>`)
    : (s === 'ASSIGNED'
        ? `<button class="primary" onclick="executeTask('${esc(t['Assignment ID'])}','start')">Start work</button>`
        : s === 'IN_PROGRESS'
          ? `<div style="display:flex;gap:8px;">
               <button class="secondary" style="flex:1;" onclick="executeTask('${esc(t['Assignment ID'])}','pause')">Pause</button>
               <button class="danger" style="flex:1;" onclick="executeTask('${esc(t['Assignment ID'])}','end')">End work</button>
             </div>`
          : s === 'PAUSED'
            ? `<div style="display:flex;gap:8px;">
                 <button class="primary" style="flex:1;" onclick="executeTask('${esc(t['Assignment ID'])}','resume')">Resume</button>
                 <button class="danger" style="flex:1;" onclick="executeTask('${esc(t['Assignment ID'])}','end')">End work</button>
               </div>`
            : `<button class="assigned-action" disabled>Completed</button>`);

  const plannedHours = formatPlannedHours(t['Planned Hours']);
  const actualHours = formatActualHours(t['Actual Hours']);

  const detailsHtml = isPieceRate
    ? `<dl>
        <div><dt>Quantity</dt><dd>${esc(t.Quantity || '—')}</dd></div>
        <div><dt>Rate</dt><dd>${esc(t.Rate || '—')}</dd></div>
      </dl>`
    : `<dl>
        <div><dt>Quantity</dt><dd>${esc(t.Quantity || '—')}</dd></div>
        <div><dt>Planned hrs</dt><dd>${esc(plannedHours)}</dd></div>
        <div><dt>Actual hrs</dt><dd>${esc(actualHours)}</dd></div>
        <div><dt>OT hrs</dt><dd>${esc(formatActualHours(t['OT Hours']))}</dd></div>
      </dl>`;

  return `
    <article class="glass-card task-card" id="task-${esc(t['Assignment ID'])}">
      <div>
        <span class="status ${s.toLowerCase()}">${esc(s)}</span>
        <h2>${esc(t['Order ID'])}${t.Style ? ` <span style="font-size:15px;font-weight:600;color:#7a8495;">· ${esc(t.Style)}</span>` : ''}</h2>
        <p>${esc(t.Process)} · ${esc(t['Worker Name'])}${isPieceRate ? ' · Piece Rate' : ''}</p>
      </div>
      ${detailsHtml}
      ${action}
      ${transferBtn}
    </article>
  `;
}

// Updates a single task in place (server round trip + DOM patch only — never reloads the whole list).
function executeTask(id, action) {
  const card = document.querySelector('#task-' + CSS.escape(id));
  if (!card) return;
  const btn = card.querySelectorAll('button')[0];
  card.querySelectorAll('button').forEach(b => b.disabled = true);

    const fnMap = { start: 'startTask', pause: 'pauseTask', resume: 'resumeTask', end: 'endTask', done: 'completePieceRateTask' };
  run(fnMap[action], state.token, id).then(updated => {
    if (!updated || !updated['Assignment ID']) {
      throw new Error('The server did not return an updated task. Please refresh and try again.');
    }
    const idx = (state.myTasks || []).findIndex(x => x && String(x['Assignment ID']) === String(id));
    if (idx > -1) state.myTasks[idx] = updated;
    renderMyTasks();
    const labels = { start: 'Task started.', pause: 'Task paused.', resume: 'Task resumed.', end: 'Task completed — FMS updated.', done: 'Marked done — FMS updated.' };
    toast(labels[action], 'success');
  }).catch(e => {
    toast(e.message, 'error');
    card.querySelectorAll('button').forEach(b => b.disabled = false);
  });
}

/* ---------------------------------- Workers ---------------------------------- */

function workers(c) {
  c.innerHTML = `
    <section class="page-head">
      <div>
        <h1>Workers</h1>
        <p>Current worker availability and assigned workload.</p>
      </div>
    </section>

    <div class="workers-filters">
      <select id="workerDepartmentFilter" onchange="onWorkerDepartmentChange()">
        <option value="">All Departments</option>
      </select>
      <select id="workerNameFilter" onchange="filterWorkers()">
        <option value="">All Workers</option>
      </select>
    </div>

    <div class="worker-grid" id="workerGrid"></div>
  `;

  loadTabData('workers', () => run('getWorkers', state.token), (w) => {
    state.workers = w || [];
    populateWorkerDepartments();
    populateWorkerNames();
    renderWorkers();
  }, document.querySelector('#workerGrid'));
}

function populateWorkerDepartments() {

  const workers = state.workers || [];

  const departments = [
    ...new Set(
      workers
        .map(w => String(w.department || '').trim())
        .filter(Boolean)
    )
  ].sort();

  const select =
    document.querySelector('#workerDepartmentFilter');

  if (!select) return;

  select.innerHTML =
    `<option value="">All Departments</option>` +
    departments
      .map(department =>
        `<option value="${esc(department)}">
          ${esc(department)}
        </option>`
      )
      .join('');
}

function populateWorkerNames() {

  const workers = state.workers || [];

  const selectedDepartment =
    document.querySelector(
      '#workerDepartmentFilter'
    )?.value || '';

  const filteredWorkers =
    workers.filter(worker => {

      if (!selectedDepartment) {
        return true;
      }

      return String(worker.department || '')
        .trim()
        .toLowerCase() ===
        selectedDepartment
          .trim()
          .toLowerCase();
    });

  const names = [
    ...new Set(
      filteredWorkers
        .map(w => String(w.name || '').trim())
        .filter(Boolean)
    )
  ].sort();

  const select =
    document.querySelector('#workerNameFilter');

  if (!select) return;

  select.innerHTML =
    `<option value="">All Workers</option>` +
    names
      .map(name =>
        `<option value="${esc(name)}">
          ${esc(name)}
        </option>`
      )
      .join('');
}

function onWorkerDepartmentChange() {

  // First rebuild Worker dropdown
  // according to selected department
  populateWorkerNames();

  // Then render the cards
  renderWorkers();
}

function populateWorkerFilters() {

  const workers =
    state.workers || [];

  const departments = [
    ...new Set(
      workers
        .map(w => String(w.department || '').trim())
        .filter(Boolean)
    )
  ].sort();

  const names = [
    ...new Set(
      workers
        .map(w => String(w.name || '').trim())
        .filter(Boolean)
    )
  ].sort();

  const departmentSelect =
    document.querySelector(
      '#workerDepartmentFilter'
    );

  const nameSelect =
    document.querySelector(
      '#workerNameFilter'
    );

  if (departmentSelect) {

    departmentSelect.innerHTML =
      `<option value="">All departments</option>` +
      departments
        .map(department =>
          `<option value="${esc(department)}">
            ${esc(department)}
           </option>`
        )
        .join('');
  }

  if (nameSelect) {

    nameSelect.innerHTML =
      `<option value="">All workers</option>` +
      names
        .map(name =>
          `<option value="${esc(name)}">
            ${esc(name)}
           </option>`
        )
        .join('');
  }
}

function filterWorkers() {
  renderWorkers();
}

function renderWorkers() {

  const workers = state.workers || [];

  const selectedDepartment =
    document.querySelector(
      '#workerDepartmentFilter'
    )?.value || '';

  const selectedWorker =
    document.querySelector(
      '#workerNameFilter'
    )?.value || '';

  const filteredWorkers =
    workers.filter(worker => {

      const department =
        String(worker.department || '')
          .trim()
          .toLowerCase();

      const name =
        String(worker.name || '')
          .trim()
          .toLowerCase();

      const departmentMatch =
        !selectedDepartment ||
        department ===
        selectedDepartment
          .trim()
          .toLowerCase();

      const workerMatch =
        !selectedWorker ||
        name ===
        selectedWorker
          .trim()
          .toLowerCase();

      return (
        departmentMatch &&
        workerMatch
      );
    });

  const grid =
    document.querySelector('#workerGrid');

  if (!grid) return;

  if (!filteredWorkers.length) {

    grid.innerHTML = `
      <div class="glass-card empty">
        No workers found.
      </div>
    `;

    return;
  }

  grid.innerHTML =
    filteredWorkers.map(worker => `

      <article
        class="glass-card worker-card worker-clickable"
        onclick="openWorkerHistory(
          '${esc(worker.id)}',
          '${esc(worker.name)}',
          '${esc(worker.department || '')}'
        )"
        title="Click to view worker history"
      >

        <h2>
          ${esc(worker.name)}
        </h2>

        <p>
          ${esc(worker.department || 'No department')}
        </p>

        <p class="muted">
          ${esc(worker.skill || 'No skill listed')}
        </p>

        <b>
          ${worker.workload}
          active task${worker.workload === 1 ? '' : 's'}
        </b>

      </article>

    `).join('');
}

/* =========================================================
   WORKER HISTORY MODAL
   ========================================================= */

function openWorkerHistory(
  workerId,
  workerName,
  department
) {

  const oldModal =
    document.querySelector('#workerHistoryModal');

  if (oldModal) oldModal.remove();

  document.body.insertAdjacentHTML(
    'beforeend',
    `
    <div
      id="workerHistoryModal"
      class="modal-backdrop"
      onclick="closeWorkerHistory(event)"
    >

      <div
        class="modal worker-history-modal"
        onclick="event.stopPropagation()"
      >

        <button
          class="close"
          onclick="closeWorkerHistory()"
        >
          ×
        </button>

        <h2>
          ${esc(workerName)}
        </h2>

        <p>
          ${esc(department || 'No department')}
        </p>

        <!-- Date Filters -->

        <div class="worker-history-filters">

          <div>
            <label>
              From Date
            </label>

            <input
              type="date"
              id="workerHistoryStart"
            >
          </div>

          <div>
            <label>
              To Date
            </label>

            <input
              type="date"
              id="workerHistoryEnd"
            >
          </div>

        </div>

        <div class="worker-history-actions">

          <button
            class="primary"
            onclick="loadWorkerHistory(
              '${esc(workerId)}',
              '${esc(workerName)}',
              '${esc(department || '')}'
            )"
          >
            Apply Filter
          </button>

          <button
            class="secondary"
            onclick="exportWorkerHistory(
              '${esc(workerId)}',
              'xlsx'
            )"
          >
            Export Excel
          </button>

          <button
            class="secondary"
            onclick="exportWorkerHistory(
              '${esc(workerId)}',
              'pdf'
            )"
          >
            Export PDF
          </button>

        </div>

        <div
          id="workerHistoryContent"
          class="worker-history-content"
        >
          <div class="loading-spinner">
            <div class="spinner"></div>
            <p>Loading worker history...</p>
          </div>
        </div>

      </div>

    </div>
    `
  );

  loadWorkerHistory(
    workerId,
    workerName,
    department
  );
}

function loadWorkerHistory(
  workerId,
  workerName,
  department
) {

  const content =
    document.querySelector(
      '#workerHistoryContent'
    );

  if (!content) return;

  const start =
    document.querySelector(
      '#workerHistoryStart'
    )?.value || '';

  const end =
    document.querySelector(
      '#workerHistoryEnd'
    )?.value || '';

  content.innerHTML = `
    <div class="loading-spinner">
      <div class="spinner"></div>
      <p>Loading history...</p>
    </div>
  `;

  run(
    'getWorkerHistory',
    state.token,
    workerId,
    start,
    end
  )
  .then(report => {

    renderWorkerHistoryTable(
      report
    );

  })
  .catch(e => {

    content.innerHTML = `
      <div class="glass-card empty">
        ${esc(
          e.message ||
          'Unable to load worker history.'
        )}
      </div>
    `;

  });
}

function renderWorkerHistoryTable(report) {

  const content =
    document.querySelector(
      '#workerHistoryContent'
    );

  if (!content) return;

  if (!report.rows.length) {

    content.innerHTML = `
      <div class="glass-card empty">
        No work found for the selected date range.
      </div>
    `;

    return;
  }

  content.innerHTML = `

    <div class="worker-history-summary">

      <strong>
        ${esc(report.workerName)}
      </strong>

      <span>
        ${esc(report.department || '—')}
      </span>

      <span>
        ${
          report.startDate && report.endDate
            ? esc(
                report.startDate +
                ' to ' +
                report.endDate
              )
            : 'All dates'
        }
      </span>

    </div>

    <div class="table-wrap worker-history-table-wrap">

      <table class="worker-history-table">

        <thead>

          <tr>
            <th>Order No</th>
            <th>Style Code</th>
            <th>Quantity</th>
            <th>Assigned Date</th>
            <th>Planned Hours</th>
            <th>Start Date Time</th>
            <th>End Date Time</th>
            <th>Actual Hours</th>
          </tr>

        </thead>

        <tbody>

          ${report.rows.map(row => {

            let rowClass = '';

            if (
              row.actualHoursValue !== null &&
              row.plannedHoursValue !== null
            ) {

              rowClass =
                row.plannedHoursValue >=
                row.actualHoursValue
                  ? 'hours-good'
                  : 'hours-bad';
            }

            return `

              <tr class="${rowClass}">

                <td>
                  ${esc(row.orderId || '—')}
                </td>

                <td>
                  ${esc(row.styleCode || '—')}
                </td>

                <td>
                  ${esc(row.quantity ?? '—')}
                </td>

                <td>
                  ${esc(row.assignedDate || '—')}
                </td>

                <td>
                  ${esc(row.plannedHours || '—')}
                </td>

                <td>
                  ${esc(row.startDateTime || '—')}
                </td>

                <td>
                  ${esc(row.endDateTime || '—')}
                </td>

                <td>
                  ${esc(row.actualHours || '—')}
                </td>

              </tr>

            `;

          }).join('')}

        </tbody>

      </table>

    </div>
  `;
}

function exportWorkerHistory(
  workerId,
  format
) {

  const start =
    document.querySelector(
      '#workerHistoryStart'
    )?.value || '';

  const end =
    document.querySelector(
      '#workerHistoryEnd'
    )?.value || '';

  const buttonText =
    format === 'xlsx'
      ? 'Excel'
      : 'PDF';

  toast(
    'Preparing ' +
    buttonText +
    ' report...',
    'info'
  );

  run(
    'exportWorkerReport',
    state.token,
    workerId,
    start,
    end,
    format
  )
  .then(file => {

    downloadBase64File(
      file.base64,
      file.mimeType,
      file.fileName
    );

    toast(
      buttonText +
      ' report downloaded.',
      'success'
    );

  })
  .catch(e => {

    toast(
      e.message ||
      'Export failed.',
      'error'
    );

  });
}

function downloadBase64File(
  base64,
  mimeType,
  fileName
) {

  const binary =
    atob(base64);

  const bytes =
    new Uint8Array(
      binary.length
    );

  for (
    let i = 0;
    i < binary.length;
    i++
  ) {
    bytes[i] =
      binary.charCodeAt(i);
  }

  const blob =
    new Blob(
      [bytes],
      { type: mimeType }
    );

  const url =
    URL.createObjectURL(blob);

  const a =
    document.createElement('a');

  a.href = url;
  a.download = fileName;

  document.body.appendChild(a);

  a.click();

  a.remove();

  URL.revokeObjectURL(url);
}

function closeWorkerHistory(event) {

  if (
    event &&
    event.target !== event.currentTarget
  ) {
    return;
  }

  document
    .querySelector(
      '#workerHistoryModal'
    )
    ?.remove();
}

function assign(c) {
  c.innerHTML = `<section class="page-head"><div><h1>Assign work</h1><p>Select a pending FMS production step and allocate it.</p></div>
    <button class="secondary" onclick="loadPending()">Refresh</button></section>
    <div id="pending" class="glass-card"><div class="loading-spinner"><div class="spinner"></div><p>Loading pending FMS work...</p></div></div>`;
  loadPending();
}

/* --------------------------------- Assign work --------------------------------- */

function loadPending() {
  const el = document.querySelector('#pending');
  if (!el) return;

  loadTabData('assign', () => Promise.all([run('getPendingWork', state.token), run('getAssignmentSetup', state.token)]),
    ([p, s]) => {
      state.pending = p || [];
      state.setup = s || {};
      renderPending();
    }, el);
}

function pendingOptions(values, label) {
  return `<option value="">All ${label}</option>${[...new Set(values.filter(Boolean))].sort().map(v => `<option value="${esc(v)}">${esc(v)}</option>`).join('')}`;
}
function pendingRows(items) {
  if (!items.length) {
    return '<tr><td colspan="10" class="empty">No work matches these filters.</td></tr>';
  }

  return items.map(item => {

    const index = state.pending.indexOf(item);

    const image = item.imageUrl
      ? `<img class="order-image"
          src="${esc(item.imageUrl)}"
          alt="Order image"
          onerror="this.outerHTML='<span class=&quot;no-image&quot;>No image</span>'">`
      : '<span class="no-image">No image</span>';

    const date = item.assignedDate
      ? new Date(item.assignedDate).toLocaleDateString('en-GB')
      : '';

    let action = '';

    if (item.assignmentStatus) {

      const workerName =
        item.assignedWorkers || 'Worker not recorded';

      action = `
        <button
          class="assigned-action"
          disabled
          title="Assigned to: ${esc(workerName)}"
        >
          <strong>${esc(item.assignmentStatus)}</strong>
          <span>Assigned to: ${esc(workerName)}</span>
          ${date ? `<small>${esc(date)}</small>` : ''}
        </button>
      `;

    } else {

      action = `
        <button
          class="primary"
          onclick="openAssign(${index})"
        >
          Assign
        </button>
      `;
    }

    return `
      <tr id="pending-row-${index}">
        <td>${esc(item.orderId)}</td>
        <td>${esc(item.client || '—')}</td>
        <td>${esc(item.style || '—')}</td>
        <td>${image}</td>
        <td>${esc(item.color || '—')}</td>
        <td>${esc(item.quantity || '—')}</td>
        <td>${esc(item.deliveryDate || '—')}</td>
        <td>${esc(item.fmsName)}</td>
        <td>${esc(item.process)}</td>
        <td>${action}</td>
      </tr>
    `;

  }).join('');
}
// Renders purely from state.pending / DOM filter values — no network call, so this is instant.
function renderPending() {
  const el = document.querySelector('#pending');
  if (!el) return;

  const items = state.pending || [];

  const fms = document.querySelector('#pendingFms')?.value || '';
  const client = document.querySelector('#pendingClient')?.value || '';
  const merchandiser = document.querySelector('#pendingMerchandiser')?.value || '';
  const process = document.querySelector('#pendingProcess')?.value || '';
  const order = document.querySelector('#pendingOrder')?.value || '';

  const byFms = items.filter(item =>
    !fms || item.fmsName === fms
  );

  const byClient = byFms.filter(item =>
    !client || item.client === client
  );

  const byMerchandiser = byClient.filter(item =>
    !merchandiser || item.merchandiser === merchandiser
  );

  const filtered = byMerchandiser.filter(item =>
    (!process || item.process === process) &&
    (
      !order ||
      String(item.orderId)
        .toLowerCase()
        .includes(order.toLowerCase())
    )
  ).sort((a, b) => parseDeliveryDate_(a.deliveryDate) - parseDeliveryDate_(b.deliveryDate));

  const pendingCount = filtered.filter(
    item => !item.assignmentStatus
  ).length;

  el.innerHTML = `
    <div class="pending-top">

      <article class="pending-kpi">
        <span>Total pending assign work</span>
        <b>${pendingCount}</b>
      </article>

      <div class="pending-filters">

        <select id="pendingFms" onchange="filterPending()">
          ${pendingOptions(
            items.map(x => x.fmsName),
            'FMS'
          )}
        </select>

        <select id="pendingClient" onchange="filterPending()">
          ${pendingOptions(
            byFms.map(x => x.client),
            'clients'
          )}
        </select>

        <select id="pendingMerchandiser" onchange="filterPending()">
          ${pendingOptions(
            byFms.map(x => x.merchandiser),
            'merchandisers'
          )}
        </select>

        <select id="pendingProcess" onchange="filterPending()">
          ${pendingOptions(
            byClient.map(x => x.process),
            'processes'
          )}
        </select>

        <input
          id="pendingOrder"
          value="${esc(order)}"
          oninput="filterPending()"
          placeholder="Search Order No."
        >

      </div>
    </div>

    <div class="table-wrap">
      <table class="pending-table">
        <thead>
          <tr>
            <th>Order No</th>
            <th>Client Name</th>
            <th>Style Code</th>
            <th>Image</th>
            <th>Color</th>
            <th>QTY</th>
            <th>Delivery Date</th>
            <th>FMS</th>
            <th>Process Required</th>
            <th>Action</th>
          </tr>
        </thead>

        <tbody>
          ${pendingRows(filtered)}
        </tbody>
      </table>
    </div>
  `;

  document.querySelector('#pendingFms').value = fms;
  document.querySelector('#pendingClient').value = client;
  document.querySelector('#pendingMerchandiser').value = merchandiser;
  document.querySelector('#pendingProcess').value = process;
  document.querySelector('#pendingOrder').value = order;
}
function filterPending() {
  const fms = document.querySelector('#pendingFms')?.value || '';
  const oldClient = document.querySelector('#pendingClient')?.value || '';
  const oldMerchandiser = document.querySelector('#pendingMerchandiser')?.value || '';
  const oldProcess = document.querySelector('#pendingProcess')?.value || '';
  const order = document.querySelector('#pendingOrder')?.value || '';
  const items = state.pending || [];
  const fmsItems = items.filter(item => !fms || item.fmsName === fms);
  const clients = [...new Set(fmsItems.map(item => item.client).filter(Boolean))];
  const client = clients.includes(oldClient) ? oldClient : '';
  const merchandisers = [...new Set(fmsItems.map(item => item.merchandiser).filter(Boolean))];
  const merchandiser = merchandisers.includes(oldMerchandiser) ? oldMerchandiser : '';
  const clientItems = fmsItems.filter(item => (!client || item.client === client) && (!merchandiser || item.merchandiser === merchandiser));
  const processes = [...new Set(clientItems.map(item => item.process).filter(Boolean))];
  const process = processes.includes(oldProcess) ? oldProcess : '';

  const activeId = document.activeElement && document.activeElement.id;
  const selStart = document.activeElement && typeof document.activeElement.selectionStart === 'number' ? document.activeElement.selectionStart : null;

  renderPending();

  document.querySelector('#pendingFms').value = fms;
  document.querySelector('#pendingClient').value = client;
  document.querySelector('#pendingMerchandiser').value = merchandiser;
  document.querySelector('#pendingProcess').value = process;
  document.querySelector('#pendingOrder').value = order;

  if (activeId) {
    const toFocus = document.querySelector('#' + activeId);
    if (toFocus) {
      toFocus.focus();
      if (selStart !== null && typeof toFocus.setSelectionRange === 'function') {
        toFocus.setSelectionRange(selStart, selStart);
      }
    }
  }
}

/* ------------------------------ Assignment modal ------------------------------ */

function processProfile(name) {
  const key = String(name).toLowerCase();
  return {
    name, usesPalla: key === 'pintuck', usesQuantity: true,
    rateRequired: ['kaaj button', 'hand work', 'blockprint'].includes(key), rateLabel: 'Rate per Piece',
    help: key === 'pintuck' ? 'Allocate Palla per worker.'
      : (['hand work', 'kaaj button', 'blockprint'].includes(key) ? 'Allocate piece quantity and rate per worker.' : 'Allocate order quantity and planned hours per worker.')
  };
}
function eligibleWorkers(process) {
  const target = String(process || '')
    .trim()
    .toLowerCase();

  if (!target) return [];

  return (state.setup?.workers || []).filter(worker => {
    const skills = String(worker.skill || '')
      .toLowerCase()
      .split(/[,\/|]+/)
      .map(s => s.trim())
      .filter(Boolean);

    return skills.includes(target);
  });
}
function allocationRow(profile, workerOptions, work, pieceRate) {
  const quantity = profile.usesQuantity ? `<label>Quantity<input name="quantity" type="number" min="0" step="1" value="${esc(work.quantity || '')}" required></label>` : '';
  const palla = profile.usesPalla ? `<label>Palla<input name="palla" type="number" min="0" step=".01" required></label>` : '';
  const showRate = profile.rateRequired || pieceRate;
  const rate = showRate ? `<label>${profile.rateLabel || 'Rate'}<input name="rate" type="number" min="0" step=".01" ${pieceRate ? 'required' : ''}></label>` : '';
  const plannedHours = pieceRate ? '' : `<label>Planned hours<input name="plannedHours" placeholder="2:00" pattern="^([0-9]{1,3}):[0-5][0-9]$" required></label>`;
  return `<div class="allocation-row"><div class="allocation-title">Worker allocation <button type="button" class="remove-allocation" onclick="removeAllocation(this)">Remove</button></div>
    <label>Worker<select name="workerId" required>${workerOptions}</select></label>
    <div class="allocation-fields">${quantity}${palla}${plannedHours}${rate}</div></div>`;
}

function openAssign(index) {
  const work = state.pending[index];
  document.body.insertAdjacentHTML('beforeend', `<div class="modal-backdrop" id="modal">
    <div class="glass-card modal process-modal">
      <button type="button" class="close" onclick="closeModal()">×</button>
      <h2>Assign ${esc(work.process)}</h2>
      <div class="assignment-summary"><b>Order: ${esc(work.orderId)}</b><span>Client: ${esc(work.client || '—')}</span><span>FMS: ${esc(work.fmsName)}</span><span>Style: ${esc(work.style || '—')}</span></div>
      <p>How is this work paid?</p>
      <div class="pay-type-choice">
        <button type="button" class="secondary full" onclick="openAssignForm(${index}, 'SALARIED')">Salaried Worker</button>
        <button type="button" class="secondary full" onclick="openPieceRateChoice(${index})">Piece Rate Worker</button>
      </div>
    </div></div>`);
}

function openTransferModal(assignmentId, process, currentWorkerId) {
  document.querySelector('#modal')?.remove();
  document.body.insertAdjacentHTML('beforeend', `<div class="modal-backdrop" id="modal">
    <div class="glass-card modal process-modal">
      <button type="button" class="close" onclick="closeModal()">×</button>
      <h2>Transfer task</h2>
      <p>Reassign this ${esc(process)} task to another eligible worker.</p>
      <div id="transferBody"><div class="loading-spinner"><div class="spinner"></div></div></div>
    </div></div>`);

  run('getWorkers', state.token).then(workers => {
    const body = document.querySelector('#transferBody');
    if (!body) return;
    const target = String(process || '').trim().toLowerCase();
    const eligible = (workers || []).filter(w => {
      const skills = String(w.skill || '').toLowerCase().split(/[,\/|]+/).map(s => s.trim()).filter(Boolean);
      return skills.includes(target) && String(w.id) !== String(currentWorkerId);
    });
    if (!eligible.length) {
      body.innerHTML = `<div class="glass-card empty">No other worker has "${esc(process)}" in Process/Skill.</div>`;
      return;
    }
    const options = eligible.map(w => `<option value="${esc(w.id)}">${esc(formatWorkerLoad(w))}</option>`).join('');
    body.innerHTML = `
      <label>New worker<select id="transferWorkerId">${options}</select></label>
      <button type="button" class="primary full" style="margin-top:14px;" onclick="submitTransfer('${esc(assignmentId)}')">Transfer</button>
    `;
  }).catch(e => {
    const body = document.querySelector('#transferBody');
    if (body) body.innerHTML = `<div class="glass-card empty">${esc(e.message)}</div>`;
  });
}

function submitTransfer(assignmentId) {
  const select = document.querySelector('#transferWorkerId');
  const newWorkerId = select ? select.value : '';
  if (!newWorkerId) return toast('Choose a worker to transfer to.', 'error');

  const btn = document.querySelector('#transferBody button.primary');
  if (btn) btn.disabled = true;

  run('transferTask', state.token, assignmentId, newWorkerId).then(updated => {
    if (!updated || !updated['Assignment ID']) throw new Error('The server did not return an updated task.');
    const idx = (state.myTasks || []).findIndex(x => x && String(x['Assignment ID']) === String(assignmentId));
    if (idx > -1) state.myTasks[idx] = updated;
    closeModal();
    renderMyTasks();
    toast('Task transferred to ' + (updated['Worker Name'] || 'the new worker') + '.', 'success');
  }).catch(e => {
    toast(e.message, 'error');
    if (btn) btn.disabled = false;
  });
}

function openPieceRateChoice(index) {
  closeModal();
  const work = state.pending[index];
  document.body.insertAdjacentHTML('beforeend', `<div class="modal-backdrop" id="modal">
    <div class="glass-card modal process-modal">
      <button type="button" class="close" onclick="closeModal()">×</button>
      <h2>${esc(work.process)} — Piece Rate</h2>
      <div class="assignment-summary"><b>Order: ${esc(work.orderId)}</b><span>Client: ${esc(work.client || '—')}</span><span>FMS: ${esc(work.fmsName)}</span><span>Style: ${esc(work.style || '—')}</span></div>
      <p>Issue this to a worker to do, or record work that's already done?</p>
      <div class="pay-type-choice">
        <button type="button" class="secondary full" onclick="openAssignForm(${index}, 'PIECE_RATE_ISSUE')">Issue (assign to worker)</button>
        <button type="button" class="secondary full" onclick="openAssignForm(${index}, 'PIECE_RATE_RECEIVE')">Receive (mark done now)</button>
      </div>
    </div></div>`);
}

function openAssignForm(index, payType) {
  closeModal();
  const work = state.pending[index], profile = processProfile(work.process), eligible = eligibleWorkers(work.process);
  if (!eligible.length) return toast(`No active worker has "${work.process}" in Process/Skill.`, 'error');
  const options = eligible.map(w => `<option value="${esc(w.id)}">${esc(formatWorkerLoad(w))}</option>`).join('');
  const isPieceRate = payType === 'PIECE_RATE_ISSUE' || payType === 'PIECE_RATE_RECEIVE';
  const isIssue = payType === 'PIECE_RATE_ISSUE';

  const submitFn = payType === 'SALARIED' ? 'submitAssign' : isIssue ? 'submitPieceRateIssue' : 'submitPieceRateAssign';
  const buttonLabel = payType === 'SALARIED' ? 'Create assignment' : isIssue ? 'Issue to worker' : 'Complete & update FMS';
  const titleSuffix = payType === 'SALARIED' ? 'Salaried' : isIssue ? 'Piece Rate — Issue' : 'Piece Rate — Receive';
  const helpText = payType === 'SALARIED'
    ? esc(profile.help)
    : isIssue
      ? 'This goes to the worker\'s task list. They tap "Done" when finished — no start/pause, no hours tracked.'
      : 'Piece rate work is marked done immediately and pushed to FMS right away — no start/end tracking.';

  document.body.insertAdjacentHTML('beforeend', `<div class="modal-backdrop" id="modal">
    <form class="glass-card modal process-modal" onsubmit="${submitFn}(event,${index})">
      <button type="button" class="close" onclick="closeModal()">×</button>
      <h2>Assign ${esc(work.process)} — ${titleSuffix}</h2>
      <div class="assignment-summary"><b>Order: ${esc(work.orderId)}</b><span>Client: ${esc(work.client || '—')}</span><span>FMS: ${esc(work.fmsName)}</span><span>Style: ${esc(work.style || '—')}</span></div>
      <p>${helpText}</p>
      <div id="allocationList">${allocationRow(profile, options, work, isPieceRate)}</div>
      <button type="button" class="secondary add-worker" onclick="addWorkerAllocation(${index}, '${payType}')">+ Add worker</button>
      <button class="primary full" type="submit">${buttonLabel}</button>
    </form></div>`);
}

function addWorkerAllocation(index, payType) {
  const work = state.pending[index], profile = processProfile(work.process);
  const pieceRate = payType === 'PIECE_RATE_ISSUE' || payType === 'PIECE_RATE_RECEIVE';
  const options = eligibleWorkers(work.process).map(w => `<option value="${esc(w.id)}">${esc(formatWorkerLoad(w))}</option>`).join('');
  document.querySelector('#allocationList').insertAdjacentHTML('beforeend', allocationRow(profile, options, { plannedHours: '' }, pieceRate));
}
function removeAllocation(button) {
  const rows = document.querySelectorAll('#allocationList .allocation-row');
  if (rows.length === 1) return toast('At least one worker is required.', 'warning');
  button.closest('.allocation-row').remove();
}
function filterAssignmentWorkers(input) {
  const term = input.value.toLowerCase(), select = input.parentElement.querySelector('select');
  [...select.options].forEach(o => o.hidden = !o.text.toLowerCase().includes(term));
  const current = select.options[select.selectedIndex];
  if (current && current.hidden) select.value = '';
}
function closeModal() { document.querySelector('#modal')?.remove(); }

// Submits the assignment, then patches state locally — no full reload of the pending table or worker list.
function submitAssign(event, index) {
  event.preventDefault();

  const work = state.pending[index];

  const rows = [
    ...document.querySelectorAll('#allocationList .allocation-row')
  ];

  const assignments = rows.map(row => ({
    workerId:
      row.querySelector('[name=workerId]')?.value || '',

    quantity:
      row.querySelector('[name=quantity]')?.value || '',

    palla:
      row.querySelector('[name=palla]')?.value || '',

    plannedHours:
      row.querySelector('[name=plannedHours]')?.value || '',

    rate:
      row.querySelector('[name=rate]')?.value || ''
  }));

  if (assignments.some(a => !a.workerId)) {
    return toast(
      'Choose a worker for every allocation.',
      'error'
    );
  }

  const btn = event.target.querySelector('[type=submit]');

  btn.disabled = true;

  run(
    'assignWork',
    state.token,
    {
      ...work,
      assignments
    }
  )
    .then(result => {

      if (!result) {
        throw new Error(
          'Assignment was created but no response was returned from the server.'
        );
      }

      if (!result.success) {
        throw new Error(
          'Assignment could not be created.'
        );
      }

      const count = Number(result.count || 0);

      if (!count) {
        throw new Error(
          'No assignment rows were created.'
        );
      }

      closeModal();

      toast(
        `${count} task${count === 1 ? '' : 's'} assigned successfully.`,
        'success'
      );

      const workerNames =
        (result.tasks || [])
          .map(t => t['Worker Name'])
          .filter(Boolean)
          .join(', ');

      state.pending[index] = {
        ...work,
        assignmentStatus: 'ASSIGNED',
        assignedDate: new Date().toISOString(),
        assignedWorkers: workerNames
      };
      tabCache.assign = [state.pending, state.setup];

      if (state.setup?.workers && Array.isArray(assignments)) {

        assignments.forEach(a => {

          const worker =
            state.setup.workers.find(
              x => String(x.id) === String(a.workerId)
            );

          if (worker) {
            worker.workload =
              (Number(worker.workload) || 0) + 1;

            worker.remainingHours =
              (Number(worker.remainingHours) || 0) +
              parseHoursInput_(a.plannedHours);
          }

        });
      }

      renderPending();
    })

    .catch(error => {

      console.error(
        'Assignment creation error:',
        error
      );

      toast(
        error.message || 'Unable to create assignment.',
        'error'
      );

    })

    .finally(() => {

      if (btn && btn.isConnected) {
        btn.disabled = false;
      }

    });
}

function submitPieceRateAssign(event, index) {
  event.preventDefault();

  const work = state.pending[index];
  const rows = [...document.querySelectorAll('#allocationList .allocation-row')];

  const assignments = rows.map(row => ({
    workerId: row.querySelector('[name=workerId]')?.value || '',
    quantity: row.querySelector('[name=quantity]')?.value || '',
    palla: row.querySelector('[name=palla]')?.value || '',
    rate: row.querySelector('[name=rate]')?.value || ''
  }));

  if (assignments.some(a => !a.workerId)) return toast('Choose a worker for every allocation.', 'error');
  if (assignments.some(a => !a.rate)) return toast('Enter a rate for every allocation.', 'error');

  const btn = event.target.querySelector('[type=submit]');
  btn.disabled = true;

  run('assignPieceRateWork', state.token, { ...work, assignments }).then(result => {
    if (!result || !result.success) throw new Error('Assignment could not be created.');
    const count = Number(result.count || 0);
    if (!count) throw new Error('No assignment rows were created.');

    closeModal();
    toast(`${count} piece-rate task${count === 1 ? '' : 's'} completed and FMS updated.`, 'success');

    const workerNames = (result.tasks || []).map(t => t['Worker Name']).filter(Boolean).join(', ');
    state.pending[index] = { ...work, assignmentStatus: 'COMPLETED', assignedDate: new Date().toISOString(), assignedWorkers: workerNames };
    tabCache.assign = [state.pending, state.setup];   // ← add this line
    renderPending();
  }).catch(error => {
    toast(error.message || 'Unable to create assignment.', 'error');
  }).finally(() => { if (btn && btn.isConnected) btn.disabled = false; });
}

function submitPieceRateIssue(event, index) {
  event.preventDefault();
  const work = state.pending[index];
  const rows = [...document.querySelectorAll('#allocationList .allocation-row')];

  const assignments = rows.map(row => ({
    workerId: row.querySelector('[name=workerId]')?.value || '',
    quantity: row.querySelector('[name=quantity]')?.value || '',
    palla: row.querySelector('[name=palla]')?.value || '',
    rate: row.querySelector('[name=rate]')?.value || ''
  }));

  if (assignments.some(a => !a.workerId)) return toast('Choose a worker for every allocation.', 'error');
  if (assignments.some(a => !a.rate)) return toast('Enter a rate for every allocation.', 'error');

  const btn = event.target.querySelector('[type=submit]');
  btn.disabled = true;

  run('assignPieceRateIssue', state.token, { ...work, assignments }).then(result => {
    if (!result || !result.success) throw new Error('Assignment could not be created.');
    const count = Number(result.count || 0);
    if (!count) throw new Error('No assignment rows were created.');

    closeModal();
    toast(`${count} piece-rate task${count === 1 ? '' : 's'} issued to worker${count === 1 ? '' : 's'}.`, 'success');

    const workerNames = (result.tasks || []).map(t => t['Worker Name']).filter(Boolean).join(', ');
    state.pending[index] = { ...work, assignmentStatus: 'ASSIGNED', assignedDate: new Date().toISOString(), assignedWorkers: workerNames };
   tabCache.assign = [state.pending, state.setup]; 
    if (state.setup?.workers && Array.isArray(result.workerIds)) {
      result.workerIds.forEach(id => {
        const worker = state.setup.workers.find(x => String(x.id) === String(id));
        if (worker) worker.workload = (Number(worker.workload) || 0) + 1;
      });
    }
    renderPending();
  }).catch(error => {
    toast(error.message || 'Unable to issue work.', 'error');
  }).finally(() => { if (btn && btn.isConnected) btn.disabled = false; });
}

/* ---------------------------------- Reports ---------------------------------- */

function reports(c) {
  c.innerHTML = `
     <section class="page-head"><div><h1>Reports</h1></div></section>
      <section class="glass-card" style="margin-top:20px;">
        <h2>Monthly overtime & efficiency</h2>
        <p style="color:#697386;font-size:13px;margin-bottom:14px;">Efficiency = in-shift hours ÷ (in-shift + OT hours). Click a row to see what was worked that month. Lower efficiency means more of a worker's output came from overtime.</p>
        <input id="reportWorkerSearch" oninput="renderReportsMonthly()" placeholder="Search worker..." style="max-width:280px;margin-bottom:12px;">
        <div class="table-wrap"><table><thead><tr><th>Month</th><th>Worker</th><th>Planned</th><th>Actual (shift)</th><th>OT</th><th>Efficiency</th></tr></thead>
        <tbody id="reportsMonthlyBody"></tbody></table></div>
      </section>`;

  loadTabData('reports', () => run('getReports', state.token), (r) => {
    state.reportsMonthly = r.monthly || [];
    renderReportsMonthly();
  }, document.querySelector('#reportsMonthlyBody'));
}

function renderReportsMonthly() {
  const body = document.querySelector('#reportsMonthlyBody');
  if (!body) return;
  const search = (document.querySelector('#reportWorkerSearch')?.value || '').trim().toLowerCase();
  const rows = (state.reportsMonthly || []).filter(m => !search || m.worker.toLowerCase().includes(search));

  body.innerHTML = rows.length ? rows.map(m => `
    <tr class="report-row" style="cursor:pointer;" onclick="openMonthlyDetail('${esc(m.worker)}','${esc(m.month)}')">
      <td>${esc(m.month)}</td>
      <td>${esc(m.worker)}</td>
      <td>${formatActualHours(m.plannedHours)}</td>
      <td>${formatActualHours(m.actualHours)}</td>
      <td>${formatActualHours(m.otHours)}</td>
      <td>${m.efficiency === null ? '—' : m.efficiency + '%'}</td>
    </tr>`).join('') : '<tr><td colspan="6" class="empty">No matching data.</td></tr>';
}

function openMonthlyDetail(worker, month) {
  document.querySelector('#monthlyDetailModal')?.remove();
  document.body.insertAdjacentHTML('beforeend', `
    <div id="monthlyDetailModal" class="modal-backdrop" onclick="closeMonthlyDetail(event)">
      <div class="modal worker-history-modal" onclick="event.stopPropagation()">
        <button class="close" onclick="closeMonthlyDetail()">×</button>
        <h2>${esc(worker)}</h2>
        <p>${esc(month)} — completed work</p>
        <div id="monthlyDetailContent"><div class="loading-spinner"><div class="spinner"></div></div></div>
      </div>
    </div>`);

  run('getMonthlyWorkerDetail', state.token, worker, month).then(report => {
    const content = document.querySelector('#monthlyDetailContent');
    if (!content) return;
    if (!report.rows.length) { content.innerHTML = '<div class="glass-card empty">No completed tasks found.</div>'; return; }
    content.innerHTML = `<div class="table-wrap"><table><thead><tr><th>Order</th><th>Process</th><th>Date</th><th>Planned</th><th>Actual</th><th>OT</th></tr></thead>
      <tbody>${report.rows.map(r => `<tr>
        <td>${esc(r.orderId)}</td><td>${esc(r.process)}</td><td>${esc(r.date)}</td>
        <td>${formatActualHours(r.plannedHours)}</td><td>${formatActualHours(r.actualHours)}</td><td>${formatActualHours(r.otHours)}</td>
      </tr>`).join('')}</tbody></table></div>`;
  }).catch(e => {
    const content = document.querySelector('#monthlyDetailContent');
    if (content) content.innerHTML = `<div class="glass-card empty">${esc(e.message)}</div>`;
  });
}

function closeMonthlyDetail(event) {
  if (event && event.target !== event.currentTarget) return;
  document.querySelector('#monthlyDetailModal')?.remove();
}

function parseHoursInput_(text) {
  const match = String(text || '').trim().match(/^(\d{1,3}):([0-5]\d)$/);
  if (!match) return 0;
  return Number(match[1]) + Number(match[2]) / 60;
}

function formatWorkerLoad(worker) {
  const hrs = Number(worker.remainingHours || 0);
  const h = Math.floor(hrs), m = Math.round((hrs - h) * 60);
  const hoursText = (h > 0 || m > 0) ? `${h}:${String(m).padStart(2, '0')}` : '0:00';
  return `${worker.name} (Active ${worker.workload} / Remaining Work ${hoursText})`;
}

/* --------------------------------- Utilities --------------------------------- */

// Parses "dd/mm/yyyy" (or "d/m/yyyy") into a sortable timestamp. Unparseable/blank
// dates sort to the very end, so they don't get treated as "most urgent."
function parseDeliveryDate_(value) {
  const text = String(value || '').trim();
  const match = text.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!match) return Infinity;
  const [, d, m, y] = match;
  return new Date(Number(y), Number(m) - 1, Number(d)).getTime();
}

function showErr(el) { return e => el.innerHTML = `<div class="glass-card empty">${esc(e.message || 'Something went wrong.')}</div>`; }
function toast(m, type = 'info') { const e = document.createElement('div'); e.className = 'toast toast-' + type; e.textContent = m; document.body.append(e); setTimeout(() => e.remove(), 4000); }

window.switchTab = switchTab; window.signOut = signOut; window.executeTask = executeTask;
window.filterMyTasks = filterMyTasks;
window.filterWorkers = filterWorkers;
window.onWorkerDepartmentChange = onWorkerDepartmentChange;
window.setMyTaskStatus = setMyTaskStatus;
window.openWorkerHistory = openWorkerHistory;
window.closeWorkerHistory = closeWorkerHistory;
window.loadWorkerHistory = loadWorkerHistory;
window.exportWorkerHistory = exportWorkerHistory;
window.loadPending = loadPending; window.filterPending = filterPending; window.openAssign = openAssign;
window.addWorkerAllocation = addWorkerAllocation; window.removeAllocation = removeAllocation;
window.filterAssignmentWorkers = filterAssignmentWorkers; window.closeModal = closeModal; window.submitAssign = submitAssign;
window.openAssignForm = openAssignForm; window.submitPieceRateAssign = submitPieceRateAssign;
window.openPieceRateChoice = openPieceRateChoice; window.submitPieceRateIssue = submitPieceRateIssue;
window.openTransferModal = openTransferModal; window.submitTransfer = submitTransfer;
boot();


function formatPlannedHours(value) {
  if (value === null || value === undefined || value === '') {
    return '—';
  }

  // Numeric value is already in decimal hours
  // Example: 1.5 = 01:30
  if (typeof value === 'number') {
    const totalMinutes = Math.round(value * 60);
    const hours = Math.floor(totalMinutes / 60);
    const minutes = totalMinutes % 60;

    return String(hours).padStart(2, '0') + ':' +
           String(minutes).padStart(2, '0');
  }

  const text = String(value).trim();

  // Google Sheets date/time/duration string
  // Examples:
  // 1:30:00
  // 1899-12-30 01:30:00
  const match = text.match(
    /(\d{1,3}):(\d{2})(?::(\d{2}))?$/
  );

  if (match) {
    return (
      String(match[1]).padStart(2, '0') +
      ':' +
      String(match[2]).padStart(2, '0')
    );
  }

  return text;
}

function formatActualHours(value) {
  if (value === null || value === undefined || value === '' || isNaN(Number(value))) {
    return '—';
  }
  const totalMinutes = Math.round(Number(value) * 60);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return String(hours).padStart(2, '0') + ':' + String(minutes).padStart(2, '0');
}

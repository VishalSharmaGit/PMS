/* =====================================================================
 * api.js  —  replaces google.script.run.  Every function the old Apps Script exposed
 * is implemented here against Supabase, with the same names, arguments and return shapes,
 * so app.js (your old JS.html) keeps working unchanged.
 * ===================================================================== */
(function () {
  const CFG = window.PMS_CONFIG;
  const sb = window.supabase.createClient(CFG.SUPABASE_URL, CFG.SUPABASE_ANON_KEY, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false },
    realtime: { params: { eventsPerSecond: 20 } }
  });
  window.sb = sb;

  /* ---------------------------- helpers ---------------------------- */
  const IST_MS = 19800000; // Asia/Kolkata = UTC+5:30, no daylight saving
  const fmtTs = v => {                       // ISO -> 'yyyy-MM-dd HH:mm:ss' in India time (same as the old server output)
    if (!v) return '';
    const d = new Date(v); if (isNaN(d)) return '';
    return new Date(d.getTime() + IST_MS).toISOString().slice(0, 19).replace('T', ' ');
  };
  const fmtDate = v => { const s = fmtTs(v); return s ? s.slice(0, 10) : ''; };
  const fmtTime = v => { const s = fmtTs(v); return s ? s.slice(11) : ''; };
  const nz = v => (v === null || v === undefined) ? '' : v;

  /** DB row (snake_case) -> the header-keyed object the UI has always used */
  function rowToApi(t) {
    return {
      'Order ID': nz(t.order_id), 'FMS ID': nz(t.fms_id), 'FMS Sheet': nz(t.fms_sheet),
      'FMS Source Key': nz(t.fms_source_key), 'FMS Source Row': nz(t.fms_source_row),
      'Process': nz(t.process), 'Assignment ID': nz(t.assignment_id), 'Parent Assignment': nz(t.parent_assignment),
      'Worker ID': nz(t.worker_id), 'Worker Name': nz(t.worker_name),
      'Quantity': nz(t.quantity), 'Palla': nz(t.palla), 'Planned Hours': t.planned_hours === undefined ? null : t.planned_hours,
      'Rate': nz(t.rate), 'Assigned By': nz(t.assigned_by), 'Assigned Timestamp': fmtTs(t.assigned_timestamp),
      'Status': nz(t.status),
      'Start Timestamp': fmtTs(t.start_timestamp), 'Start Date': fmtDate(t.start_timestamp), 'Start Time': fmtTime(t.start_timestamp),
      'End Timestamp': fmtTs(t.end_timestamp), 'End Date': fmtDate(t.end_timestamp), 'End Time': fmtTime(t.end_timestamp),
      'Actual Hours': t.actual_hours === undefined ? null : t.actual_hours,
      'Total Labor Hours': t.total_labor_hours === undefined ? null : t.total_labor_hours,
      'Production Elapsed Time': t.production_elapsed_time === undefined ? null : t.production_elapsed_time,
      'FMS Actual Method': nz(t.fms_actual_method), 'FMS Update Status': nz(t.fms_update_status),
      'FMS Updated Timestamp': fmtTs(t.fms_updated_timestamp),
      'Created Timestamp': fmtTs(t.created_timestamp), 'Last Updated Timestamp': fmtTs(t.last_updated_timestamp),
      'Client': nz(t.client), 'Style': nz(t.style), 'Image URL': nz(t.image_url), 'Color': nz(t.color),
      'Delivery Date': nz(t.delivery_date), 'Pay Type': nz(t.pay_type),
      'Work Segments': t.work_segments ? JSON.stringify(t.work_segments) : '',
      'OT Hours': t.ot_hours === undefined ? null : t.ot_hours
    };
  }
  window.rowToApi = rowToApi;

  async function rpc(fn, args) {
    const { data, error } = await sb.rpc(fn, args || {});
    if (error) throw new Error(friendly(error));
    return data;
  }
  function friendly(e) {
    const m = String(e.message || e);
    if (/JWT|not authenticated|Invalid Refresh Token/i.test(m)) return 'Your session has ended. Please sign in again.';
    if (/Failed to fetch|NetworkError|network/i.test(m)) return 'Network problem — check your internet connection and try again.';
    return m;
  }

  /* hours text "2:30" / "02:30:00" / 2.5  ->  decimal hours (same rules as the old plannedHoursToDuration_) */
  function plannedToHours(value) {
    if (value === '' || value === null || value === undefined) return '';
    if (typeof value === 'number') return value >= 0 && value < 1 ? Math.round(value * 24 * 1e6) / 1e6 : value;
    const text = String(value).trim();
    if (!text) return '';
    const m = text.match(/^(\d+):(\d{1,2})(?::(\d{1,2}))?$/);
    if (m) return Math.round((Number(m[1]) + Number(m[2]) / 60 + Number(m[3] || 0) / 3600) * 1e6) / 1e6;
    const n = Number(text);
    if (!isNaN(n)) return n;
    throw new Error('Invalid planned hours: ' + value);
  }
  const toNum = v => { if (v === '' || v == null) return ''; const n = Number(String(v).replace(/,/g, '').trim()); return isNaN(n) ? '' : n; };

  const sinceIso = days => new Date(Date.now() - days * 86400000).toISOString();

  /* ---------------------------- session ---------------------------- */
  let meCache = null;
  async function loadMe() {
    const { data: s } = await sb.auth.getSession();
    if (!s || !s.session) { meCache = null; return null; }
    const { data, error } = await sb.from('pms_users').select('role,worker_id,name,email,active').eq('user_id', s.session.user.id).maybeSingle();
    if (error || !data || !data.active) { meCache = null; return null; }
    meCache = { role: data.role, name: data.name, email: data.email, workerId: data.worker_id };
    return meCache;
  }
  async function loadProcesses() {
    const { data, error } = await sb.from('pms_process_master').select('*').eq('active', true).order('sort_order');
    if (error) throw new Error(friendly(error));
    return (data || []).map(r => ({
      'Process': r.process, 'Active': r.active, 'Worker Selection': nz(r.worker_selection), 'Multiple Workers': nz(r.multiple_workers),
      'Quantity Type': nz(r.quantity_type), 'Planned Hours Required': nz(r.planned_hours_required),
      'FMS Actual Update Required': nz(r.fms_actual_update_required), 'Rework Allowed': nz(r.rework_allowed),
      'Partial Completion Allowed': nz(r.partial_completion_allowed), 'FMS Actual Calculation Method': nz(r.fms_actual_calculation_method)
    }));
  }

  /* ---------------------------- the API (same names as the old Apps Script) ---------------------------- */
  const API = {
    /** Worker: Worker ID + PIN.   Admin/supervisor: email + password. */
    async login(identifier, password) {
      const id = String(identifier || '').trim();
      if (!id) throw new Error('Enter your Worker ID or email.');
      if (!password) throw new Error(id.includes('@') ? 'Enter your password.' : 'Enter your PIN.');
      const email = id.includes('@') ? id.toLowerCase() : id.toLowerCase() + '@' + CFG.WORKER_EMAIL_DOMAIN;
      const { error } = await sb.auth.signInWithPassword({ email, password: String(password) });
      if (error) throw new Error(id.includes('@') ? 'Incorrect email or password.' : 'Incorrect Worker ID or PIN.');
      const user = await loadMe();
      if (!user) { await sb.auth.signOut(); throw new Error('This account is not active. Please contact your admin.'); }
      return { user, processes: await loadProcesses() };
    },
    async getAppContext() {
      const user = await loadMe();
      if (!user) return { user: null, processes: [] };
      return { user, processes: await loadProcesses() };
    },
    async logout() { meCache = null; await sb.auth.signOut(); return true; },

    /* ---- task lists.  opts.all = true -> whole history ---- */
    async getDashboard(token, opts) {
      const rows = await rpc('pms_get_tasks', { p_from: opts && opts.all ? null : sinceIso(CFG.RECENT_DAYS) });
      return { tasks: rows.map(rowToApi) };
    },
    async getMyTasks(token, opts) {
      const rows = await rpc('pms_get_tasks', { p_from: opts && opts.all ? null : sinceIso(CFG.RECENT_DAYS) });
      return rows.map(rowToApi).reverse();
    },

    /* ---- task actions ---- */
    async startTask(token, id)  { return rowToApi(await rpc('pms_task_action', { p_assignment_id: String(id), p_action: 'START' })); },
    async pauseTask(token, id)  { return rowToApi(await rpc('pms_task_action', { p_assignment_id: String(id), p_action: 'PAUSE' })); },
    async resumeTask(token, id) { return rowToApi(await rpc('pms_task_action', { p_assignment_id: String(id), p_action: 'RESUME' })); },
    async endTask(token, id)    { return rowToApi(await rpc('pms_task_action', { p_assignment_id: String(id), p_action: 'END' })); },
    async completePieceRateTask(token, id) { return rowToApi(await rpc('pms_complete_piece', { p_assignment_id: String(id) })); },
    async transferTask(token, id, newWorkerId) {
      return rowToApi(await rpc('pms_transfer_task', { p_assignment_id: String(id), p_new_worker_id: String(newWorkerId) }));
    },

    /* ---- workers / assign ---- */
    async getWorkers() { return rpc('pms_get_workers'); },
    async getPendingWork() { return rpc('pms_pending_work'); },
    async getAssignmentSetup() {
      const [workers, processes] = await Promise.all([rpc('pms_get_workers'), loadProcesses()]);
      return { workers, processes };
    },
    async assignWork(token, p)           { return createAssignments(p, 'SALARIED'); },
    async assignPieceRateIssue(token, p) { return createAssignments(p, 'PIECE_ISSUE'); },
    async assignPieceRateWork(token, p)  { return createAssignments(p, 'PIECE_DONE'); },

    /* ---- reports ---- */
    async getReports() { return rpc('pms_reports'); },
    async getMonthlyWorkerDetail(token, worker, month) { return rpc('pms_monthly_detail', { p_worker: String(worker || ''), p_month: String(month || '') }); },
    async getWorkerHistory(token, workerId, startDate, endDate) {
      return rpc('pms_worker_history', { p_worker_id: String(workerId), p_start: startDate || '', p_end: endDate || '' });
    },
    async exportWorkerReport(token, workerId, startDate, endDate, format) {
      format = String(format || 'xlsx').toLowerCase();
      if (!['xlsx', 'pdf'].includes(format)) throw new Error('Invalid export format.');
      const report = await API.getWorkerHistory(token, workerId, startDate, endDate);
      if (!report.rows.length) throw new Error('No work found for this worker in the selected date range.');
      return format === 'xlsx' ? exportXlsx(report) : exportPdf(report);
    }
  };

  async function createAssignments(p, mode) {
    ['orderId', 'fmsId', 'fmsSheet', 'sourceRow', 'process', 'assignments'].forEach(k => {
      if (!p[k] || (Array.isArray(p[k]) && !p[k].length)) throw new Error(k + ' is required.');
    });
    const payload = {
      mode, order_id: p.orderId, process: p.process, fms_id: p.fmsId, fms_sheet: p.fmsSheet,
      source_key: p.sourceKey || '', source_row: Number(p.sourceRow),
      client: p.client || '', style: p.style || '', image_url: p.imageUrl || '', color: p.color || '',
      delivery_date: p.deliveryDate || '',
      quantity: toNum(p.quantity), palla: toNum(p.palla), rate: toNum(p.rate),
      assignments: p.assignments.map(a => ({
        workerId: String(a.workerId).trim(),
        quantity: toNum(a.quantity), palla: toNum(a.palla), rate: toNum(a.rate),
        plannedHours: mode === 'SALARIED' ? plannedToHours(a.plannedHours || p.plannedHours || '') : ''
      }))
    };
    const res = await rpc('pms_create_assignments', { p: payload });
    return {
      success: res.success, count: res.count, parentAssignment: res.parentAssignment,
      tasks: (res.tasks || []).map(rowToApi), workerIds: p.assignments.map(a => String(a.workerId).trim())
    };
  }

  /* ---------------------------- in-browser Excel / PDF export ---------------------------- */
  const loadScript = src => new Promise((ok, no) => {
    if (document.querySelector('script[data-lib="' + src + '"]')) return ok();
    const s = document.createElement('script'); s.src = src; s.dataset.lib = src; s.onload = ok; s.onerror = () => no(new Error('Could not load export library.'));
    document.head.appendChild(s);
  });
  const safeName = n => String(n || 'Worker').replace(/[^A-Za-z0-9_\- ]/g, '').trim().replace(/\s+/g, '_') || 'Worker';
  const HEADERS = ['Order No', 'Style Code', 'Quantity', 'Assigned Date', 'Planned Hours', 'Start Date Time', 'End Date Time', 'Actual Hours'];
  const rowsOf = r => [r.orderId, r.styleCode, r.quantity, r.assignedDate, r.plannedHours, r.startDateTime, r.endDateTime, r.actualHours];
  const dateLine = rep => rep.startDate && rep.endDate ? rep.startDate + ' to ' + rep.endDate : 'All Dates';
  const isGood = r => r.actualHoursValue !== null && r.plannedHoursValue !== null && r.plannedHoursValue >= r.actualHoursValue;
  const isBad  = r => r.actualHoursValue !== null && r.plannedHoursValue !== null && r.plannedHoursValue <  r.actualHoursValue;

  async function exportXlsx(rep) {
    await loadScript('https://cdn.jsdelivr.net/npm/exceljs@4.4.0/dist/exceljs.min.js');
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Worker Report', { views: [{ state: 'frozen', ySplit: 5 }] });
    ws.getCell('A1').value = 'Worker Name :'; ws.getCell('B1').value = rep.workerName;
    ws.getCell('A2').value = 'Department :';  ws.getCell('B2').value = rep.department || '';
    ws.getCell('A3').value = 'Date :';        ws.getCell('B3').value = dateLine(rep);
    ['A1', 'B1', 'A2', 'B2', 'A3', 'B3'].forEach(c => ws.getCell(c).font = { bold: true });
    const border = { top: { style: 'thin', color: { argb: 'FFDDE3ED' } }, left: { style: 'thin', color: { argb: 'FFDDE3ED' } }, bottom: { style: 'thin', color: { argb: 'FFDDE3ED' } }, right: { style: 'thin', color: { argb: 'FFDDE3ED' } } };
    const hr = ws.getRow(5); HEADERS.forEach((h, i) => { const c = hr.getCell(i + 1); c.value = h; c.font = { bold: true }; c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE8ECF7' } }; c.border = border; c.alignment = { wrapText: true }; });
    rep.rows.forEach((r, idx) => {
      const row = ws.getRow(6 + idx);
      rowsOf(r).forEach((v, i) => {
        const c = row.getCell(i + 1); c.value = v; c.border = border; c.alignment = { wrapText: true, horizontal: i === 2 ? 'center' : undefined };
        if (isGood(r)) c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE8F5E9' } };
        else if (isBad(r)) c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFDECEC' } };
      });
    });
    ws.columns.forEach((col, i) => {
      let max = HEADERS[i].length;
      rep.rows.forEach(r => { max = Math.max(max, String(rowsOf(r)[i] ?? '').length); });
      col.width = Math.min(40, max + 3);
    });
    const buf = await wb.xlsx.writeBuffer();
    return { base64: bufToB64(buf), mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', fileName: safeName(rep.workerName) + '_Worker_Report.xlsx' };
  }

  async function exportPdf(rep) {
    await loadScript('https://cdn.jsdelivr.net/npm/jspdf@2.5.1/dist/jspdf.umd.min.js');
    await loadScript('https://cdn.jsdelivr.net/npm/jspdf-autotable@3.8.2/dist/jspdf.plugin.autotable.min.js');
    const doc = new window.jspdf.jsPDF({ orientation: 'landscape', unit: 'pt', format: 'a4' });
    doc.setFontSize(11); doc.setFont(undefined, 'bold');
    doc.text('Worker Name : ' + rep.workerName, 40, 40);
    doc.text('Department : ' + (rep.department || ''), 40, 58);
    doc.text('Date : ' + dateLine(rep), 40, 76);
    doc.autoTable({
      startY: 92, head: [HEADERS], body: rep.rows.map(r => rowsOf(r).map(v => String(v ?? ''))),
      styles: { fontSize: 8, cellPadding: 4, lineColor: [221, 227, 237], lineWidth: 0.5 },
      headStyles: { fillColor: [232, 236, 247], textColor: 20, fontStyle: 'bold' },
      columnStyles: { 2: { halign: 'center' } },
      didParseCell: d => {
        if (d.section !== 'body') return;
        const r = rep.rows[d.row.index];
        if (isGood(r)) d.cell.styles.fillColor = [232, 245, 233]; else if (isBad(r)) d.cell.styles.fillColor = [253, 236, 236];
      }
    });
    return { base64: doc.output('datauristring').split(',')[1], mimeType: 'application/pdf', fileName: safeName(rep.workerName) + '_Worker_Report.pdf' };
  }
  function bufToB64(buf) {
    const bytes = new Uint8Array(buf); let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(bin);
  }

  /* app.js calls this exactly like google.script.run:  run('name', token, ...args) */
  window.callApi = (name, ...args) => {
    const fn = API[name];
    if (!fn) return Promise.reject(new Error('Unknown action: ' + name));
    return Promise.resolve().then(() => fn(...args));
  };
})();

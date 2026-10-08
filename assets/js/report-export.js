/* assets/js/report-export.js
   Export the report currently shown on reports.html as a PDF or Excel (.xlsx) file.
   Reads the rendered table (#reportHead / #reportBody / #reportFoot), the filters and the stat cards,
   so it exports exactly what is on screen (including column filters) for every tab.
   PDF  : built from a clean A4 layout and downloaded directly (html2pdf.js, loaded on first use).
   Excel: SheetJS, loaded on first use. */
(function () {
  'use strict';

  var XLSX_URL = 'https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js';
  var PDF_URL = 'https://cdn.jsdelivr.net/npm/html2pdf.js@0.10.2/dist/html2pdf.bundle.min.js';

  var $ = function (id) { return document.getElementById(id); };
  var clean = function (el) { return (el.textContent || '').replace(/\s+/g, ' ').trim(); };
  var esc = function (s) {
    return String(s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  };
  var selText = function (id) { var s = $(id); return s.options[s.selectedIndex].text; };

  function loadScript(url, globalName) {
    if (window[globalName]) return Promise.resolve(window[globalName]);
    return new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = url;
      s.onload = function () { resolve(window[globalName]); };
      s.onerror = function () { reject(new Error('Could not load the export library. Check your internet connection.')); };
      document.head.appendChild(s);
    });
  }

  /* ---------- Read what is on screen ---------- */
  // Text of a cell without the column-filter menu that lives inside some headers
  function cellText(td) {
    var copy = td.cloneNode(true);
    copy.querySelectorAll('.col-filter').forEach(function (n) { n.remove(); });
    return clean(copy);
  }

  function readSection(id) {
    return Array.prototype.map.call($(id).rows, function (tr) {
      return Array.prototype.map.call(tr.cells, function (td) {
        return {
          text: cellText(td),
          num: td.classList.contains('num'),
          ctr: td.classList.contains('ctr'),
          span: td.colSpan || 1
        };
      });
    });
  }

  function readReport() {
    var body = $('reportBody');
    if (!body.rows.length || body.querySelector('td.empty')) return null;   // loading / no data

    var tabBtn = document.querySelector('#reportTabs .nav-link.active');
    var from = $('fFrom').value, to = $('fTo').value;
    var stats = [
      ['Net revenue', 'statNet', 'statNetSub'],
      ['Receipts', 'statReceipts', 'statReceiptsSub'],
      ['Gross', 'statGross'],
      ['Discounts', 'statDiscount'],
      ['Adjustments', 'statAdjust']
    ].map(function (s) {
      var sub = s[2] ? clean($(s[2])) : '';
      return { label: s[0], value: clean($(s[1])), sub: sub };
    });

    var note = $('tabNote');
    var tabName = tabBtn ? clean(tabBtn) : 'Report';
    if (tabBtn && tabBtn.dataset.tab === 'daily') tabName += ' (by ' + selText('groupBy').toLowerCase() + ')';

    return {
      tabKey: tabBtn ? tabBtn.dataset.tab : 'report',
      tabName: tabName,
      period: (from || '…') + '  to  ' + (to || '…'),
      from: from, to: to,
      filters: 'Status: ' + selText('fStatus') + '   |   Payment: ' + selText('fPayment'),
      generated: new Date().toLocaleString(),
      stats: stats,
      head: readSection('reportHead'),
      body: readSection('reportBody'),
      foot: readSection('reportFoot'),
      note: note && !note.classList.contains('hidden') ? clean(note) : ''
    };
  }

  function fileName(r, ext) {
    var range = [r.from, r.to].filter(Boolean).join('_to_');
    return ('revenue-report_' + r.tabKey + (range ? '_' + range : '') + '.' + ext).replace(/\s+/g, '');
  }

  function busy(btn, on) {
    if (!btn) return;
    btn.disabled = on;
    btn.dataset.label = btn.dataset.label || btn.textContent;
    btn.textContent = on ? 'Preparing…' : btn.dataset.label;
  }

  /* ---------- PDF ---------- */
  function rowsHtml(rows, cellTag) {
    return rows.map(function (cells) {
      return '<tr>' + cells.map(function (c) {
        var cls = c.num ? ' class="num"' : c.ctr ? ' class="ctr"' : '';
        var span = c.span > 1 ? ' colspan="' + c.span + '"' : '';
        return '<' + cellTag + cls + span + '>' + esc(c.text) + '</' + cellTag + '>';
      }).join('') + '</tr>';
    }).join('');
  }

  var SHEET_CSS =
    '.pdf-sheet{box-sizing:border-box;background:#fff;color:#111827;font-family:"Kantumruy Pro",system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;font-size:12px;line-height:1.4}' +
    '.pdf-sheet *{box-sizing:border-box}' +
    '.pdf-sheet .head{display:flex;justify-content:space-between;align-items:flex-end;padding-bottom:8px;border-bottom:2px solid #1d4ed8;margin-bottom:12px}' +
    '.pdf-sheet h1{margin:0;font-size:22px;font-weight:700;color:#1d4ed8}' +
    '.pdf-sheet .sub{margin:2px 0 0;font-size:13px;color:#4b5563;font-weight:600}' +
    '.pdf-sheet .meta{text-align:right;font-size:11px;color:#6b7280;line-height:1.6}' +
    '.pdf-sheet .stats{display:flex;gap:8px;margin-bottom:14px}' +
    '.pdf-sheet .stat{flex:1;min-width:0;padding:7px 9px;border:1px solid #e5e7eb;border-radius:6px;background:#f9fafb}' +
    '.pdf-sheet .stat-label{font-size:9.5px;text-transform:uppercase;letter-spacing:.04em;color:#6b7280;font-weight:600}' +
    '.pdf-sheet .stat-value{margin-top:2px;font-size:13px;font-weight:700}' +
    '.pdf-sheet .stat-sub{font-size:9.5px;color:#6b7280}' +
    '.pdf-sheet table{width:100%;border-collapse:collapse}' +
    '.pdf-sheet th{padding:6px 8px;text-align:left;font-size:10px;text-transform:uppercase;letter-spacing:.04em;color:#374151;background:#f3f4f6;border-top:1px solid #d1d5db;border-bottom:1px solid #d1d5db}' +
    '.pdf-sheet td{padding:5px 8px;border-bottom:1px solid #eef0f3;vertical-align:middle}' +
    '.pdf-sheet tbody tr:nth-child(even) td{background:#fafafa}' +
    '.pdf-sheet .num{text-align:right;white-space:nowrap}' +
    '.pdf-sheet .ctr{text-align:center}' +
    '.pdf-sheet tfoot td{font-weight:700;background:#eff6ff;border-top:2px solid #1d4ed8;border-bottom:1px solid #1d4ed8}' +
    '.pdf-sheet .note{margin-top:10px;font-size:10.5px;color:#6b7280}' +
    '.pdf-sheet .foot{margin-top:16px;padding-top:6px;border-top:1px solid #e5e7eb;font-size:10px;color:#9ca3af;display:flex;justify-content:space-between}';

  function sheetHtml(r) {
    var stats = r.stats.map(function (s) {
      return '<div class="stat"><div class="stat-label">' + esc(s.label) + '</div><div class="stat-value">' + esc(s.value) + '</div>' +
        (s.sub ? '<div class="stat-sub">' + esc(s.sub) + '</div>' : '') + '</div>';
    }).join('');

    return '<style>' + SHEET_CSS + '</style>' +
      '<div class="head"><div><h1>Revenue Report</h1><p class="sub">' + esc(r.tabName) + '</p></div>' +
      '<div class="meta"><div><b>Period:</b> ' + esc(r.period) + '</div><div>' + esc(r.filters) + '</div></div></div>' +
      '<div class="stats">' + stats + '</div>' +
      '<table><thead>' + rowsHtml(r.head, 'th') + '</thead><tbody>' + rowsHtml(r.body, 'td') + '</tbody>' +
      (r.foot.length ? '<tfoot>' + rowsHtml(r.foot, 'td') + '</tfoot>' : '') + '</table>' +
      (r.note ? '<p class="note">' + esc(r.note) + '</p>' : '') +
      '<div class="foot"><span>Generated ' + esc(r.generated) + '</span><span>Revenue Report · ' + esc(r.tabName) + '</span></div>';
  }

  function exportPdf() {
    var r = readReport();
    if (!r) return alert('There is no report data to export yet.');

    var btn = $('btnExportPdf');
    busy(btn, true);

    var cols = r.head.length ? r.head[0].reduce(function (n, c) { return n + c.span; }, 0) : 0;
    var landscape = cols > 6;
    var margin = 10;                                   // mm
    var widthPx = Math.round(((landscape ? 297 : 210) - margin * 2) / 25.4 * 96);

    var holder = document.createElement('div');
    holder.className = 'pdf-sheet';
    holder.style.cssText = 'position:fixed;left:-10000px;top:0;width:' + widthPx + 'px;';
    holder.innerHTML = sheetHtml(r);
    document.body.appendChild(holder);

    var fontsReady = document.fonts && document.fonts.ready ? document.fonts.ready : Promise.resolve();

    Promise.all([loadScript(PDF_URL, 'html2pdf'), fontsReady])
      .then(function () {
        return window.html2pdf().set({
          margin: margin,
          filename: fileName(r, 'pdf'),
          image: { type: 'jpeg', quality: 0.98 },
          html2canvas: { scale: 2, useCORS: true, backgroundColor: '#ffffff', scrollX: 0, scrollY: 0 },
          jsPDF: { unit: 'mm', format: 'a4', orientation: landscape ? 'landscape' : 'portrait' },
          pagebreak: { mode: ['css', 'legacy'], avoid: ['tr', '.stats', '.head'] }
        }).from(holder).save();
      })
      .catch(function (err) { alert(err.message || 'PDF export failed.'); })
      .then(function () { holder.remove(); busy(btn, false); });
  }

  /* ---------- Excel ---------- */
  // Number columns -> real numbers with a matching display format; everything else stays text
  function toCell(c) {
    if (!c.num) return { t: 's', v: c.text };
    var t = c.text.replace(/[\s,៛$]/g, '').replace(/[−–]/g, '-').replace(/^\+/, '');
    if (!/^-?\d+(\.\d+)?$/.test(t)) return { t: 's', v: c.text };
    var n = Number(t);
    var z = c.text.indexOf('៛') > -1 ? '#,##0" ៛"'
          : c.text.indexOf('$') > -1 ? '$#,##0.00'
          : Number.isInteger(n) ? '#,##0' : '#,##0.00';
    return { t: 'n', v: n, z: z };
  }

  function sectionToRows(rows) {
    return rows.map(function (cells) {
      var out = [];
      cells.forEach(function (c) {
        out.push(toCell(c));
        for (var i = 1; i < c.span; i++) out.push({ t: 's', v: '' });
      });
      return out;
    });
  }

  function exportXlsx() {
    var r = readReport();
    if (!r) return alert('There is no report data to export yet.');

    var btn = $('btnExportXlsx');
    busy(btn, true);

    loadScript(XLSX_URL, 'XLSX').then(function (XLSX) {
      var aoa = [
        [{ t: 's', v: 'Revenue Report - ' + r.tabName }],
        [{ t: 's', v: 'Period: ' + r.period.replace(/\s+/g, ' ') }],
        [{ t: 's', v: r.filters.replace(/\s+/g, ' ') }],
        [{ t: 's', v: 'Generated: ' + r.generated }],
        []
      ];
      r.stats.forEach(function (s) { aoa.push([{ t: 's', v: s.label }, { t: 's', v: s.value + (s.sub ? ' (' + s.sub + ')' : '') }]); });
      aoa.push([]);
      var tableStart = aoa.length;
      aoa = aoa.concat(sectionToRows(r.head), sectionToRows(r.body), sectionToRows(r.foot));
      if (r.note) aoa.push([], [{ t: 's', v: r.note }]);

      var ws = XLSX.utils.aoa_to_sheet(aoa.map(function (row) { return row.map(function (c) { return c.v; }); }));
      aoa.forEach(function (row, ri) {
        row.forEach(function (c, ci) {
          if (c.z) { var ref = XLSX.utils.encode_cell({ r: ri, c: ci }); if (ws[ref]) ws[ref].z = c.z; }
        });
      });
      var widths = [];
      aoa.slice(tableStart).forEach(function (row) {
        row.forEach(function (c, i) { widths[i] = Math.max(widths[i] || 10, String(c.v).length + 3); });
      });
      ws['!cols'] = widths.map(function (w) { return { wch: Math.min(w, 40) }; });

      var wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, r.tabName.replace(/[\\\/?*\[\]:]/g, '').slice(0, 31) || 'Report');
      XLSX.writeFile(wb, fileName(r, 'xlsx'));
    }).catch(function (err) { alert(err.message); })
      .then(function () { busy(btn, false); });
  }

  /* ---------- Wire up ---------- */
  document.addEventListener('DOMContentLoaded', function () {
    var pdf = $('btnExportPdf'), xls = $('btnExportXlsx');
    if (pdf) pdf.addEventListener('click', exportPdf);
    if (xls) xls.addEventListener('click', exportXlsx);
  });
})();

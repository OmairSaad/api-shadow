// API Shadow dashboard. Renders the model posted by the extension host. Every value from the
// model is inserted as text (never as HTML); actions are sent back as small messages that the
// host validates. Source locations are opaque `ref` numbers resolved by the host.
(function () {
  'use strict';
  const vscode = acquireVsCodeApi();
  const app = document.getElementById('app');
  const TABS = [
    ['overview', 'Overview'],
    ['explorer', 'API Explorer'],
    ['impact', 'Impact Analysis'],
    ['security', 'Security'],
    ['graph', 'Dependency Graph'],
    ['contracts', 'Contracts'],
    ['tests', 'Test Generator'],
  ];
  const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'HEAD', 'ALL'];
  const saved = vscode.getState() || {};
  const ui = Object.assign(
    {
      tab: 'overview',
      explorer: { view: 'endpoints', text: '', methods: [], framework: '', status: '', confidence: '', auth: '', selected: '', requestText: '', requestStatus: '' },
      security: { severity: '', confidence: '', rule: '', showDismissed: false },
      graph: { methods: [], framework: '', unmatched: true, uncalled: true, impactedOnly: false, selected: '', query: '' },
      tests: { selected: [], text: '', runner: 'auto' },
    },
    saved,
  );
  let model;
  let focusId;
  /** The graph is fitted to the view once, and again when its focus changes. */
  let fitted = false;

  function persist() {
    vscode.setState(ui);
  }

  // ---------------------------------------------------------------------------------------------
  // DOM helpers: text only
  // ---------------------------------------------------------------------------------------------

  function h(tag, attrs) {
    const el = document.createElement(tag);
    if (attrs) {
      for (const [k, v] of Object.entries(attrs)) {
        if (v === undefined || v === null || v === false) continue;
        if (k === 'class') el.className = v;
        else if (k === 'text') el.textContent = String(v);
        // Style attributes are blocked by the CSP; CSSOM properties are not.
        else if (k === 'flexGrow') el.style.flexGrow = String(v);
        else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
        else if (v === true) el.setAttribute(k, '');
        else el.setAttribute(k, String(v));
      }
    }
    for (let i = 2; i < arguments.length; i++) append(el, arguments[i]);
    return el;
  }

  function append(el, child) {
    if (child === undefined || child === null || child === false) return;
    if (Array.isArray(child)) child.forEach((c) => append(el, c));
    else if (child instanceof Node) el.appendChild(child);
    else el.appendChild(document.createTextNode(String(child)));
  }

  /** Text with `backticked` parts as code elements (still text only, never HTML). */
  function rich(text) {
    return String(text)
      .split(/(`[^`]+`)/)
      .filter(Boolean)
      .map((part) => (part.length > 2 && part.startsWith('`') && part.endsWith('`') ? h('code', { text: part.slice(1, -1) }) : document.createTextNode(part)));
  }

  function svg(tag, attrs) {
    const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === undefined || v === null) continue;
      if (k === 'text') el.textContent = String(v);
      else el.setAttribute(k, String(v));
    }
    return el;
  }

  function send(msg) {
    vscode.postMessage(msg);
  }

  function open(ref) {
    if (typeof ref === 'number') send({ type: 'open', ref });
  }

  function command(id, args) {
    send({ type: 'command', command: id, args: args || [] });
  }

  function linkButton(label, ref, title) {
    if (typeof ref !== 'number') return h('span', { class: 'muted', text: label });
    return h('button', { class: 'link', type: 'button', title: title || `Open ${label}`, onclick: () => open(ref) }, label);
  }

  function methodBadge(m) {
    return h('span', { class: `method m-${(m || 'ALL').toLowerCase()}`, text: m || 'ANY' });
  }

  function badge(text, kind) {
    return h('span', { class: `badge ${kind || ''}`, text });
  }

  function empty(text, ...children) {
    return h('div', { class: 'empty' }, h('p', { text }), ...children);
  }

  function button(label, onclick, opts) {
    return h('button', Object.assign({ type: 'button', onclick }, opts || {}), label);
  }

  function select(label, value, options, onchange) {
    const id = `sel-${label.replace(/\W+/g, '-').toLowerCase()}`;
    const s = h('select', { id, onchange: (e) => onchange(e.target.value) }, options.map(([v, t]) => h('option', { value: v, selected: v === value, text: t })));
    return h('label', { class: 'field', for: id }, h('span', { text: label }), s);
  }

  function search(placeholder, value, oninput, label) {
    return h('input', {
      type: 'search',
      id: `search-${ui.tab}-${slug(placeholder)}`,
      placeholder,
      value,
      'aria-label': label || placeholder,
      oninput: (e) => oninput(e.target.value),
    });
  }

  function slug(text) {
    return String(text).toLowerCase().replace(/\(\d+\)/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  }

  function chip(label, active, onclick, title) {
    return h('button', { type: 'button', id: `chip-${ui.tab}-${slug(label)}`, class: `chip${active ? ' on' : ''}`, 'aria-pressed': active ? 'true' : 'false', title, onclick }, label);
  }

  function count(n, word) {
    return `${n} ${word}${n === 1 ? '' : 's'}`;
  }

  // ---------------------------------------------------------------------------------------------
  // Shell
  // ---------------------------------------------------------------------------------------------

  function render() {
    const scrollY = window.scrollY;
    // Keep keyboard focus on the same control across re-renders.
    const activeId = document.activeElement && document.activeElement.id;
    app.textContent = '';
    if (!model) {
      app.appendChild(empty('Loading…'));
      return;
    }
    const header = h(
      'header',
      { class: 'top' },
      h('div', { class: 'title' }, h('h1', { text: `API Shadow · ${model.workspace}` }), h('span', { class: 'status', text: status() })),
      h('div', { class: 'actions' }, button('Refresh', () => command('apiShadow.refresh'), { title: 'Re-analyze the workspace' }), button('Export report', () => command('apiShadow.exportReport'), { title: 'Save a Markdown report' })),
    );
    const tablist = h('div', { class: 'tabs', role: 'tablist', 'aria-label': 'Dashboard sections' });
    TABS.forEach(([id, label]) => {
      const selected = ui.tab === id;
      const tab = h('button', {
        role: 'tab',
        id: `tab-${id}`,
        'aria-selected': selected ? 'true' : 'false',
        'aria-controls': 'panel',
        tabindex: selected ? '0' : '-1',
        class: selected ? 'tab on' : 'tab',
        onclick: () => selectTab(id),
        onkeydown: (e) => {
          const i = TABS.findIndex((t) => t[0] === id);
          let next;
          if (e.key === 'ArrowRight') next = TABS[(i + 1) % TABS.length][0];
          if (e.key === 'ArrowLeft') next = TABS[(i - 1 + TABS.length) % TABS.length][0];
          if (e.key === 'Home') next = TABS[0][0];
          if (e.key === 'End') next = TABS[TABS.length - 1][0];
          if (next) {
            e.preventDefault();
            selectTab(next);
            document.getElementById(`tab-${next}`)?.focus();
          }
        },
      }, label, tabCount(id));
      tablist.appendChild(tab);
    });
    const panel = h('main', { id: 'panel', role: 'tabpanel', 'aria-labelledby': `tab-${ui.tab}`, class: `panel panel-${ui.tab}` });
    if (!model.ready) {
      panel.appendChild(empty(model.analyzing ? 'Analyzing the workspace…' : 'No analysis yet.', button('Analyze workspace', () => command('apiShadow.refresh'))));
    } else {
      const views = { overview, explorer, impact, security, graph, contracts, tests };
      panel.appendChild(views[ui.tab]());
    }
    app.append(header, tablist, panel);
    if (ui.tab !== 'graph') window.scrollTo(0, scrollY);
    if (activeId) document.getElementById(activeId)?.focus();
  }

  function status() {
    if (model.analyzing) return 'Analyzing…';
    if (!model.ready) return 'Not analyzed';
    const d = new Date(model.generatedAt);
    return `Updated ${d.toLocaleTimeString()}`;
  }

  function tabCount(id) {
    if (!model || !model.ready) return null;
    const s = model.summary;
    let n;
    if (id === 'explorer') n = s.endpoints;
    if (id === 'impact') n = s.impact ? s.impact.high + s.impact.medium : 0;
    if (id === 'security') n = model.security.filter((f) => !f.dismissed).length;
    return n ? h('span', { class: 'count', 'aria-label': `${n} items`, text: String(n) }) : null;
  }

  function selectTab(id) {
    ui.tab = id;
    persist();
    send({ type: 'tab', tab: id });
    render();
  }

  // ---------------------------------------------------------------------------------------------
  // Overview
  // ---------------------------------------------------------------------------------------------

  function overview() {
    const s = model.summary;
    const tile = (value, label, onclick, kind, note) =>
      h('button', { type: 'button', class: `tile ${kind || ''}`, onclick, 'aria-label': `${label}: ${value}${note ? ', ' + note : ''}` }, h('span', { class: 'value', text: value }), h('span', { class: 'label', text: label }), note ? h('span', { class: 'note', text: note }) : null);
    const goExplorer = (patch) => () => {
      Object.assign(ui.explorer, { view: 'endpoints', text: '', methods: [], status: '', confidence: '', auth: '', framework: '' }, patch);
      selectTab('explorer');
    };
    const methods = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].map((m) => tile(s.byMethod[m] || 0, m, goExplorer({ methods: [m] }), `m-${m.toLowerCase()}`));
    const impactTotal = s.impact ? s.impact.high + s.impact.medium : 0;
    const sec = s.security;
    const grid = h(
      'section',
      { class: 'tiles', 'aria-label': 'Summary' },
      tile(s.endpoints, 'Endpoints', goExplorer({}), 'primary', Object.entries(s.byFramework).map(([f, n]) => `${f} ${n}`).join(' · ')),
      methods,
      tile(s.calls.matched, 'Matched frontend requests', () => {
        Object.assign(ui.explorer, { view: 'requests', requestText: '', requestStatus: 'matched' });
        selectTab('explorer');
      }),
      tile(s.calls.unmatched, 'Unmatched frontend requests', () => {
        Object.assign(ui.explorer, { view: 'requests', requestText: '', requestStatus: 'unmatched' });
        selectTab('explorer');
      }, s.calls.unmatched ? 'warn' : ''),
      tile(s.potentiallyUnused, 'Potentially unused routes', goExplorer({ status: 'uncalled' }), '', 'no caller found in the workspace'),
      tile(impactTotal, 'Potential breaking changes', () => selectTab('impact'), impactTotal ? 'danger' : '', s.impact ? `since ${s.impact.baseLabel}` : model.impact.status === 'computing' ? 'computing baseline…' : 'no baseline'),
      tile(sec.high + sec.medium + sec.low, 'Security findings', () => selectTab('security'), sec.high ? 'danger' : sec.medium ? 'warn' : '', `${sec.high} high · ${sec.medium} medium · ${sec.low} low`),
      tile(s.responseMismatches, 'Reads of missing fields', () => {
        Object.assign(ui.explorer, { view: 'issues' });
        selectTab('explorer');
      }, s.responseMismatches ? 'warn' : ''),
    );
    const attention = [];
    for (const e of model.impact.endpoints.filter((x) => x.risk === 'high').slice(0, 5)) {
      attention.push(h('li', {}, badge('Breaking', 'danger'), ' ', methodBadge(e.method), ' ', h('code', { text: e.path }), ' — ', e.changes[0] ? rich(e.changes[0].text) : '', ' ', linkButton('open', e.ref)));
    }
    const kinds = { 'response-mismatch': 'Missing field', 'broken-call': 'No route', unreachable: 'Unreachable', duplicate: 'Duplicate' };
    for (const i of model.issues.filter((x) => kinds[x.kind]).slice(0, 8)) {
      attention.push(h('li', {}, badge(kinds[i.kind], i.kind === 'unreachable' ? 'danger' : 'warn'), ' ', rich(i.message), ' ', linkButton(i.where || 'open', i.ref)));
    }
    for (const f of model.security.filter((x) => x.severity === 'high' && !x.dismissed).slice(0, 5)) {
      attention.push(h('li', {}, badge('Security', 'danger'), ' ', f.title, f.endpoint ? ` — ${f.endpoint}` : '', ' ', linkButton(f.where || 'open', f.ref)));
    }
    const conf = s.confidence;
    // At a glance: how the API is split by method, and its largest path prefixes with their mounts.
    const total = Math.max(1, s.endpoints);
    const bar = h(
      'div',
      { class: 'mbar', role: 'img', 'aria-label': METHODS.filter((m) => s.byMethod[m]).map((m) => `${m} ${s.byMethod[m]}`).join(', ') },
      METHODS.filter((m) => s.byMethod[m]).map((m) => h('span', { class: `mseg m-${m.toLowerCase()}`, flexGrow: s.byMethod[m], title: `${m}: ${s.byMethod[m]} (${Math.round((s.byMethod[m] / total) * 100)}%)` })),
    );
    const legend = h('div', { class: 'mlegend' }, METHODS.filter((m) => s.byMethod[m]).map((m) => h('span', {}, h('span', { class: `mswatch m-${m.toLowerCase()}`, 'aria-hidden': 'true' }), `${m} ${s.byMethod[m]}`)));
    const prefixes = [];
    const collect = (node, depth) => {
      for (const c of node.children.values()) {
        if (depth < 2) {
          prefixes.push(c);
          collect(c, depth + 1);
        }
      }
    };
    collect(buildApiMap(), 0);
    prefixes.sort((a, b) => countEndpoints(b) - countEndpoints(a) || a.path.localeCompare(b.path));
    const glance = h(
      'section',
      { class: 'card glance' },
      h('h2', { text: 'API at a glance' }),
      bar,
      legend,
      h(
        'ul',
        { class: 'plain prefixes' },
        prefixes.slice(0, 6).map((p) =>
          h(
            'li',
            {},
            h('button', { type: 'button', class: 'link', onclick: () => {
              Object.assign(ui.explorer, { view: 'map', mapText: p.path });
              selectTab('explorer');
            } }, p.path),
            h('span', { class: 'muted', text: ` ${countEndpoints(p)} endpoint(s)` }),
            p.mount ? [' · ', h('button', { type: 'button', class: 'mount-link', title: p.mount.text, onclick: () => open(p.mount.ref) }, h('span', { class: 'muted', text: 'mounted at ' }), h('span', { class: 'mount-file', text: p.mount.where }))] : null,
          ),
        ),
      ),
    );
    return h(
      'div',
      {},
      grid,
      glance,
      h('section', { class: 'card' }, h('h2', { text: 'Needs attention' }), attention.length ? h('ul', { class: 'plain' }, attention) : h('p', { class: 'muted', text: 'Nothing urgent: no high-risk changes, missing routes, missing fields or high-severity findings.' })),
      h(
        'section',
        { class: 'card' },
        h('h2', { text: 'Analysis status' }),
        h(
          'ul',
          { class: 'plain' },
          h('li', { text: `${conf.high} endpoint path(s) fully resolved, ${conf.medium} relative to a router whose mount point was not found, ${conf.low} with parts that could not be resolved statically.` }),
          h('li', { text: `${s.calls.app} frontend request(s) and ${s.calls.test} test request(s) found; ${s.calls.ambiguous} match several routes.` }),
          h('li', { text: `${s.withoutCallers} endpoint(s) have no caller in the workspace. Mobile apps, other services or external clients may still use them.` }),
          h('li', { text: 'Static analysis cannot see dynamic routing, runtime configuration or code outside the workspace. Findings are labelled with their confidence.' }),
        ),
      ),
    );
  }

  // ---------------------------------------------------------------------------------------------
  // Explorer
  // ---------------------------------------------------------------------------------------------

  function explorer() {
    const x = ui.explorer;
    const seg = h(
      'div',
      { class: 'segmented', role: 'group', 'aria-label': 'Explorer view' },
      [['endpoints', `Endpoints (${model.endpoints.length})`], ['map', 'API map'], ['requests', `Frontend requests (${model.calls.filter((c) => c.kind === 'app').length})`], ['issues', `Coverage findings (${model.issues.length})`]].map(([v, label]) =>
        chip(label, x.view === v, () => {
          x.view = v;
          persist();
          render();
        }),
      ),
    );
    if (x.view === 'map') return h('div', {}, seg, apiMapView());
    if (x.view === 'requests') return h('div', {}, seg, requestsView());
    if (x.view === 'issues') return h('div', {}, seg, issuesView());
    const frameworks = [...new Set(model.endpoints.map((e) => e.framework))];
    const present = METHODS.filter((m) => model.endpoints.some((e) => e.method === m));
    const toolbar = h(
      'div',
      { class: 'toolbar' },
      search('Search method, path, handler, file…', x.text, (v) => {
        x.text = v;
        persist();
        renderList();
      }, 'Search endpoints'),
      h('div', { class: 'chips', role: 'group', 'aria-label': 'HTTP methods' }, present.map((m) =>
        chip(m, x.methods.includes(m), () => {
          x.methods = x.methods.includes(m) ? x.methods.filter((y) => y !== m) : [...x.methods, m];
          persist();
          render();
        }),
      )),
      select('Framework', x.framework, [['', 'All'], ...frameworks.map((f) => [f, f])], (v) => {
        x.framework = v;
        persist();
        render();
      }),
      select('Callers', x.status, [['', 'All'], ['called', 'Called from frontend'], ['uncalled', 'No frontend caller'], ['tested', 'Covered by tests'], ['untested', 'No tests']], (v) => {
        x.status = v;
        persist();
        render();
      }),
      select('Auth', x.auth, [['', 'All'], ['protected', 'Protected'], ['public', 'Public'], ['central', 'Central config'], ['none', 'None detected']], (v) => {
        x.auth = v;
        persist();
        render();
      }),
      select('Confidence', x.confidence, [['', 'All'], ['high', 'Resolved'], ['medium', 'Unmounted router'], ['low', 'Dynamic parts']], (v) => {
        x.confidence = v;
        persist();
        render();
      }),
    );
    const list = h('div', { class: 'list', id: 'endpoint-list' });
    const details = h('aside', { class: 'details', id: 'endpoint-details', 'aria-label': 'Endpoint details' });
    const layout = h('div', { class: 'split' }, list, details);
    function renderList() {
      list.textContent = '';
      const rows = filteredEndpoints();
      const caption = h('p', { class: 'muted', role: 'status', text: `${rows.length} of ${model.endpoints.length} endpoint(s)` });
      if (rows.length === 0) {
        list.append(caption, empty('No endpoints match these filters.'));
        return;
      }
      const sort = x.sort || { key: 'path', dir: 1 };
      const columns = [
        ['method', 'Method', (e) => METHODS.indexOf(e.method)],
        ['path', 'Path', (e) => e.path],
        ['handler', 'Handler', (e) => handlerLabel(e)],
        ['auth', 'Auth', (e) => e.auth],
        ['mount', 'Mounted at', (e) => mountOf(e)?.where || '~'],
        ['callers', 'Callers', (e) => e.callers * 1000 + e.tests],
        ['response', 'Response', (e) => e.response || ''],
      ];
      const keyOf = (columns.find((c) => c[0] === sort.key) || columns[1])[2];
      rows.sort((a, b) => {
        const va = keyOf(a);
        const vb = keyOf(b);
        const d = typeof va === 'number' && typeof vb === 'number' ? va - vb : String(va).localeCompare(String(vb));
        return d * sort.dir || a.path.localeCompare(b.path) || METHODS.indexOf(a.method) - METHODS.indexOf(b.method);
      });
      const head = h(
        'tr',
        {},
        columns.map(([key, label]) =>
          h(
            'th',
            { scope: 'col', 'aria-sort': sort.key === key ? (sort.dir > 0 ? 'ascending' : 'descending') : 'none' },
            h('button', { type: 'button', class: 'sort', title: `Sort by ${label.toLowerCase()}`, 'aria-label': `Sort by ${label.toLowerCase()}`, onclick: () => {
              x.sort = { key, dir: sort.key === key ? -sort.dir : 1 };
              persist();
              renderList();
            } }, label, sort.key === key ? h('span', { class: 'arrow', 'aria-hidden': 'true', text: sort.dir > 0 ? ' ▲' : ' ▼' }) : null),
          ),
        ),
      );
      const table = h('table', { class: 'grid', 'aria-label': 'Endpoints' }, h('thead', {}, head));
      const body = h('tbody');
      const shown = rows.slice(0, 1000);
      for (const [index, e] of shown.entries()) {        const tr = h(
          'tr',
          {
            tabindex: '0',
            class: e.id === x.selected ? 'sel' : '',
            'aria-selected': e.id === x.selected ? 'true' : 'false',
            onclick: () => selectEndpoint(e.id),
            'data-index': String(index),
            'data-id': e.id,
            onkeydown: (ev) => {
              if (ev.key === 'Enter' || ev.key === ' ') {
                ev.preventDefault();
                selectEndpoint(e.id);
              } else if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
                // Move through rows like a list; the details follow the focused row.
                ev.preventDefault();
                const next = shown[index + (ev.key === 'ArrowDown' ? 1 : -1)];
                if (next) selectEndpoint(next.id, true);
              }
            },
          },
          h('td', {}, methodBadge(e.method)),
          h('td', {}, h('code', { text: e.path }), e.confidence !== 'high' ? badge(e.confidence === 'low' ? 'dynamic' : 'unmounted', 'muted') : null, e.impacted ? badge(`impact ${e.impacted}`, e.impacted === 'high' ? 'danger' : 'warn') : null, e.security ? badge(`${e.security} security`, 'warn') : null),
          h('td', { text: handlerLabel(e) }),
          h('td', {}, authBadge(e)),
          h('td', { class: 'mount small' }, mountCell(e)),
          h('td', { class: 'nowrap', text: `${e.callers} · ${e.tests} test${e.tests === 1 ? '' : 's'}` }),
          h('td', { class: 'mono small', text: e.response || '' }),
        );
        body.appendChild(tr);
      }
      table.appendChild(body);
      list.append(caption, table);
      if (rows.length > 1000) list.appendChild(h('p', { class: 'muted', text: `Showing the first 1000; refine the search to see the rest.` }));
    }
    function selectEndpoint(id) {
      x.selected = id;
      persist();
      renderDetails();
      renderList();
      const row = list.querySelector(`tr[data-id="${CSS.escape(id)}"]`);
      if (row) {
        row.focus({ preventScroll: true });
        row.scrollIntoView({ block: 'nearest' });
      }
    }
    function renderDetails() {
      details.textContent = '';
      const e = model.endpoints.find((y) => y.id === x.selected);
      if (!e) {
        details.appendChild(empty('Select an endpoint to see its details.'));
        return;
      }
      details.appendChild(endpointDetails(e));
    }
    renderList();
    renderDetails();
    return h('div', {}, seg, toolbar, layout);
  }

  function filteredEndpoints() {
    const x = ui.explorer;
    const terms = x.text.toLowerCase().split(/\s+/).filter(Boolean);
    return model.endpoints.filter((e) => {
      if (x.methods.length && !x.methods.includes(e.method)) return false;
      if (x.framework && e.framework !== x.framework) return false;
      if (x.auth && e.auth !== x.auth) return false;
      if (x.confidence && e.confidence !== x.confidence) return false;
      if (x.status === 'called' && e.callers === 0) return false;
      if (x.status === 'uncalled' && e.callers > 0) return false;
      if (x.status === 'tested' && e.tests === 0) return false;
      if (x.status === 'untested' && e.tests > 0) return false;
      if (terms.length) {
        const hay = `${e.method} ${e.path} ${e.controller || ''} ${e.handler || ''} ${e.where || ''} ${e.middleware.join(' ')} ${e.services.map((s) => s.name).join(' ')}`.toLowerCase();
        return terms.every((t) => hay.includes(t));
      }
      return true;
    });
  }

  function handlerLabel(e) {
    if (!e.handler) return '';
    if (e.handler === '(anonymous)') return 'inline handler';
    return e.controller && !e.handler.includes('.') ? `${e.controller}.${e.handler}` : e.handler;
  }

  function authBadge(e) {
    const label = { protected: 'protected', public: 'public', central: 'central', none: 'none' }[e.auth] || e.auth;
    return badge(label, e.auth === 'none' ? 'muted' : 'ok');
  }

  function endpointDetails(e) {
    const callers = model.calls.filter((c) => c.endpointIds.includes(e.id));
    const app = callers.filter((c) => c.kind === 'app');
    const tests = callers.filter((c) => c.kind === 'test');
    const findings = model.security.filter((f) => f.endpointId === e.id && !f.dismissed);
    const card = (title, ...content) => h('section', { class: 'dcard' }, h('h3', { text: title }), ...content);
    const action = (label, title, onclick) => h('button', { type: 'button', class: 'act', title, onclick }, label);
    const statusChip = (s) => h('span', { class: `chip-status s${String(s)[0]}`, text: String(s) });
    const confidence = { high: ['resolved', 'ok'], medium: ['unmounted router', 'warn'], low: ['dynamic path', 'warn'] }[e.confidence] || ['', ''];

    // How the path is built: each mount, prefix or group, then the route and its handler.
    const steps = [
      ...e.trace.map((t) => ({ text: t.text, where: t.where, ref: t.ref })),
      { text: `Route ${e.method} declared`, where: e.where, ref: e.ref, strong: true },
      ...(e.handlerRef !== undefined && e.handler ? [{ text: `Handled by ${handlerLabel(e)}`, where: undefined, ref: e.handlerRef }] : []),
    ];
    const stepper = h(
      'ol',
      { class: 'stepper' },
      steps.map((st, i) =>
        h(
          'li',
          { class: `step${st.strong ? ' strong' : ''}${typeof st.ref === 'number' ? ' clickable' : ''}`, tabindex: typeof st.ref === 'number' ? '0' : undefined, role: typeof st.ref === 'number' ? 'button' : undefined, 'aria-label': typeof st.ref === 'number' ? `${st.text}, open ${st.where || 'source'}` : undefined, onclick: () => open(st.ref), onkeydown: (ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); open(st.ref); } } },
          h('span', { class: 'dot', 'aria-hidden': 'true', text: String(i + 1) }),
          h('span', { class: 'stext' }, rich(st.text)),
          st.where ? h('span', { class: 'sloc', text: st.where }) : typeof st.ref === 'number' ? h('span', { class: 'sloc', text: 'open' }) : h('span', { class: 'sloc muted', text: 'not in source' }),
        ),
      ),
    );

    const params = e.params.length
      ? h('table', { class: 'mini' }, h('thead', {}, h('tr', {}, ['Name', 'In', 'Required', 'Type'].map((c) => h('th', { scope: 'col', text: c })))), h('tbody', {}, e.params.map((p) => h('tr', {}, h('td', {}, h('code', { text: p.name })), h('td', { text: p.in }), h('td', { text: p.required ? 'yes' : 'no' }), h('td', { text: p.type || '' })))))
      : h('p', { class: 'muted', text: 'No path, query or header parameters.' });

    return h(
      'div',
      { class: 'endpoint-details' },
      h(
        'header',
        { class: 'dhead' },
        h('div', { class: 'dtitle' }, h('h2', {}, methodBadge(e.method), ' ', h('code', { class: 'dpath', text: e.path })), h('button', { type: 'button', class: 'icon', title: 'Copy path', 'aria-label': 'Copy path', onclick: () => send({ type: 'copy', text: e.path }) }, '⧉')),
        h('div', { class: 'dmeta' }, h('span', { text: handlerLabel(e) || 'no handler' }), ' · ', h('span', { text: e.framework }), ' ', authBadge(e), confidence[0] ? badge(confidence[0], confidence[1]) : null, e.impacted ? badge(`impact ${e.impacted}`, e.impacted === 'high' ? 'danger' : 'warn') : null),
      ),
      h(
        'div',
        { class: 'actions-bar', role: 'toolbar', 'aria-label': 'Endpoint actions' },
        action('Open route', `Open ${e.where}`, () => open(e.ref)),
        e.handlerRef !== undefined ? action('Open handler', 'Open the handler function', () => open(e.handlerRef)) : null,
        action('Request flow', 'Callers → middleware → handler → services', () => send({ type: 'endpoint', action: 'flow', id: e.id })),
        action('Try it', 'Open a ready-to-send .http request', () => send({ type: 'endpoint', action: 'request', id: e.id })),
        action('Copy cURL', 'Copy as a cURL command', () => send({ type: 'endpoint', action: 'curl', id: e.id })),
        action('Generate tests', 'Preview and create tests for this endpoint', () => {
          ui.tests.selected = [e.id];
          persist();
          selectTab('tests');
        }),
      ),
      card('How this path is built', stepper),
      card(
        'Request',
        params,
        e.body ? h('div', { class: 'kv' }, h('span', { class: 'k', text: 'Body' }), h('code', { class: 'v', text: e.body })) : null,
        e.validation ? h('div', { class: 'kv' }, h('span', { class: 'k', text: 'Validation' }), h('span', { class: 'v' }, badge(e.validation === 'validated' ? 'validated' : 'not validated', e.validation === 'validated' ? 'ok' : 'warn'))) : null,
        e.version ? h('div', { class: 'kv' }, h('span', { class: 'k', text: 'Version' }), h('span', { class: 'v', text: e.version })) : null,
      ),
      card(
        'Response (inferred)',
        e.statuses.length ? h('div', { class: 'chips' }, e.statuses.map(statusChip)) : null,
        e.response ? h('code', { class: 'block', text: e.response }) : h('p', { class: 'muted', text: 'Not known statically: the handler returns a value API Shadow cannot see into.' }),
      ),
      e.middleware.length || e.authVia.length
        ? card('Middleware and auth', h('ol', { class: 'mw' }, e.middleware.map((m) => h('li', { class: e.authVia.includes(m) ? 'auth' : '' }, h('code', { text: m }), e.authVia.includes(m) ? badge('auth', 'ok') : null))))
        : null,
      e.services.length || e.dataAccess.length
        ? card(
            'Implementation',
            h(
              'ul',
              { class: 'plain' },
              e.services.map((sv) => h('li', {}, linkButton(sv.name, sv.ref), sv.uses.length ? h('span', { class: 'muted', text: ` → ${sv.uses.join(', ')}` }) : null)),
              e.dataAccess.map((d) => h('li', {}, h('code', { text: d }), h('span', { class: 'muted', text: ' data access' }))),
            ),
          )
        : null,
      card(
        `Frontend callers (${app.length})`,
        app.length
          ? h('ul', { class: 'plain' }, app.map((c) => h('li', {}, linkButton(c.within || c.where, c.ref, c.where), h('span', { class: 'muted', text: ` ${c.client} · ${c.where}` }), c.reads.length ? h('div', { class: 'small' }, 'reads ', c.reads.map((r, i) => [i ? ', ' : '', h('code', { text: r })])) : null, c.consumers.length ? h('div', { class: 'small' }, 'used by ', c.consumers.map((u, i) => [i ? ', ' : '', linkButton(u.within || u.where, u.ref)])) : null)))
          : h('p', { class: 'muted', text: 'No caller found in the workspace. It may be called by other apps or services.' }),
        app.length ? action('Show all callers', 'Peek every caller in the editor', () => send({ type: 'endpoint', action: 'callers', id: e.id })) : null,
      ),
      card(`Tests (${tests.length})`, tests.length ? h('ul', { class: 'plain' }, tests.map((c) => h('li', {}, linkButton(c.where, c.ref), h('span', { class: 'muted', text: ` ${c.client}` })))) : h('p', { class: 'muted', text: 'No test request found.' })),
      findings.length
        ? card(
            `Security (${findings.length})`,
            h('ul', { class: 'plain' }, findings.map((f) => h('li', {}, badge(f.severity, f.severity === 'high' ? 'danger' : f.severity === 'medium' ? 'warn' : 'muted'), ' ', h('button', { type: 'button', class: 'link', onclick: () => { focusId = f.id; selectTab('security'); revealFocus(); } }, f.title), ' ', linkButton(f.where, f.ref)))),
          )
        : null,
      e.notes.length ? card('Analysis notes', h('ul', { class: 'plain small' }, e.notes.map((n) => h('li', {}, rich(n))))) : null,
    );
  }

  /** The innermost step of the endpoint's path that has a source location (where it is mounted). */
  function mountOf(e) {
    for (let i = e.trace.length - 1; i >= 0; i--) if (typeof e.trace[i].ref === 'number') return e.trace[i];
    return undefined;
  }

  /** `"/api" app.js:12` as a link that opens the mount; clicks don't select the row. */
  function mountCell(e) {
    const m = mountOf(e);
    if (!m) return h('span', { class: 'muted', text: '—' });
    const prefix = /["']([^"']*)["']/.exec(m.text);
    return h(
      'button',
      { type: 'button', class: 'mount-link', title: `${m.text} — ${m.where}. Click to open.`, 'aria-label': `${m.text}, open ${m.where}`, onclick: (ev) => { ev.stopPropagation(); open(m.ref); }, onkeydown: (ev) => ev.stopPropagation() },
      prefix ? h('code', { text: prefix[1] || '/' }) : null,
      h('span', { class: 'mount-file', text: m.where.split('/').pop() }),
    );
  }

  /**
   * The API as a tree of path segments. A prefix that a mount, global prefix, controller or group
   * adds shows where it is declared; leaves are endpoints.
   */
  function buildApiMap() {
    const root = { seg: '', path: '', children: new Map(), endpoints: [], mounts: [] };
    for (const e of model.endpoints) {
      // Prefixes added by trace steps, accumulated: `/api`, `/api/users`.
      const declared = new Map();
      let acc = '';
      for (const t of e.trace) {
        const q = /["']([^"']*)["']/.exec(t.text);
        if (!q || typeof t.ref !== 'number') continue;
        acc = joinPath(acc, q[1]);
        if (acc !== '/' && !declared.has(acc)) declared.set(acc, t);
      }
      const segments = e.path.split(' ~ ')[0].split('/').filter(Boolean);
      let node = root;
      let p = '';
      for (const seg of segments) {
        p = `${p}/${seg}`;
        let next = node.children.get(seg);
        if (!next) {
          next = { seg, path: p, children: new Map(), endpoints: [], mounts: [] };
          node.children.set(seg, next);
        }
        // A prefix can be mounted in several places (two apps, two routers): keep each once.
        const m = declared.get(p);
        if (m && !next.mounts.some((x) => x.ref === m.ref || x.where === m.where)) next.mounts.push(m);
        node = next;
      }
      node.endpoints.push(e);
    }
    return root;
  }

  function joinPath(a, b) {
    const out = `${a.replace(/\/+$/, '')}/${String(b).replace(/^\/+/, '')}`.replace(/\/+/g, '/');
    return out.length > 1 ? out.replace(/\/$/, '') : out;
  }

  function countEndpoints(node) {
    let n = node.endpoints.length;
    for (const c of node.children.values()) n += countEndpoints(c);
    return n;
  }

  function methodsUnder(node, out = new Set()) {
    for (const e of node.endpoints) out.add(e.method);
    for (const c of node.children.values()) methodsUnder(c, out);
    return out;
  }

  function apiMapView() {
    const x = ui.explorer;
    x.collapsed = x.collapsed || [];
    const root = buildApiMap();
    const terms = (x.mapText || '').toLowerCase().split(/\s+/).filter(Boolean);
    const matches = (node) => !terms.length || terms.every((t) => node.path.toLowerCase().includes(t)) || [...node.children.values()].some(matches) || node.endpoints.some((e) => terms.every((t) => `${e.method} ${e.path} ${handlerLabel(e)}`.toLowerCase().includes(t)));
    const toggle = (path) => {
      x.collapsed = x.collapsed.includes(path) ? x.collapsed.filter((p) => p !== path) : [...x.collapsed, path];
      persist();
      render();
    };
    const renderNode = (node, depth) => {
      const kids = [...node.children.values()].filter(matches).sort((a, b) => a.seg.localeCompare(b.seg));
      const expanded = terms.length > 0 || !x.collapsed.includes(node.path);
      const isParam = /^[:{]/.test(node.seg);
      const label = h(
        'div',
        { class: `map-row depth-${Math.min(depth, 6)}` },
        kids.length
          ? h('button', { type: 'button', class: 'twisty', 'aria-expanded': expanded ? 'true' : 'false', 'aria-label': `${expanded ? 'Collapse' : 'Expand'} ${node.path}`, onclick: () => toggle(node.path) }, expanded ? '▾' : '▸')
          : h('span', { class: 'twisty spacer', 'aria-hidden': 'true' }),
        h('code', { class: `seg${isParam ? ' param' : ''}`, text: `/${node.seg}` }),
        h('span', { class: 'count', title: 'Endpoints under this path', text: String(countEndpoints(node)) }),
        h('span', { class: 'methods' }, [...methodsUnder(node)].map((m) => h('span', { class: `mdot m-${m.toLowerCase()}`, title: m, text: m }))),
        node.mounts.length ? h('span', { class: 'muted mount-label', text: 'mounted at' }) : null,
        node.mounts.map((m) => h('button', { type: 'button', class: 'mount-link', title: `${m.text} — ${m.where}. Click to open.`, 'aria-label': `${node.path} mounted at ${m.where}, open`, onclick: () => open(m.ref) }, h('span', { class: 'mount-file', text: m.where }))),
      );
      const leaves = node.endpoints.map((e) =>
        h(
          'li',
          { class: 'map-endpoint' },
          h(
            'button',
            { type: 'button', class: 'leaf', onclick: () => {
              x.view = 'endpoints';
              x.selected = e.id;
              x.text = '';
              persist();
              render();
            }, title: 'Show endpoint details' },
            methodBadge(e.method),
            ' ',
            h('span', { text: handlerLabel(e) || e.path }),
          ),
          ' ',
          linkButton(e.where, e.ref),
        ),
      );
      return h('li', { class: 'map-node' }, label, expanded && (leaves.length || kids.length) ? h('ul', { class: 'map-children' }, leaves, kids.map((k) => renderNode(k, depth + 1))) : null);
    };
    const top = [...root.children.values()].filter(matches).sort((a, b) => a.seg.localeCompare(b.seg));
    const toolbar = h(
      'div',
      { class: 'toolbar' },
      search('Filter paths…', x.mapText || '', (v) => {
        x.mapText = v;
        persist();
        render();
      }, 'Filter the API map'),
      button('Expand all', () => {
        x.collapsed = [];
        persist();
        render();
      }),
      button('Collapse all', () => {
        const all = [];
        const walk = (n) => n.children.forEach((c) => {
          if (c.children.size) all.push(c.path);
          walk(c);
        });
        walk(root);
        x.collapsed = all;
        persist();
        render();
      }),
    );
    if (!top.length && !root.endpoints.length) return h('div', {}, toolbar, empty('No paths match.'));
    return h(
      'div',
      {},
      toolbar,
      h('p', { class: 'muted small', text: 'Every path prefix of the API. "mounted at" opens the line that adds the prefix: app.use(), a global prefix, @Controller/@RequestMapping, a route group or a loaded route file.' }),
      h('ul', { class: 'api-map', 'aria-label': 'API map' }, root.endpoints.length ? renderNode({ ...root, seg: '', path: '/', children: new Map() }, 0) : null, top.map((n) => renderNode(n, 0))),
    );
  }

  function requestsView() {
    const x = ui.explorer;
    const byId = new Map(model.endpoints.map((e) => [e.id, e]));
    const terms = (x.requestText || '').toLowerCase().split(/\s+/).filter(Boolean);
    const status = x.requestStatus || '';
    const rows = model.calls.filter((c) => {
      if (c.kind !== 'app') return false;
      if (status === 'unmatched' && c.endpointIds.length) return false;
      if (status === 'matched' && !c.endpointIds.length) return false;
      if (status === 'ambiguous' && c.endpointIds.length < 2) return false;
      return !terms.length || terms.every((t) => `${c.method} ${c.url} ${c.client} ${c.where} ${c.within || ''}`.toLowerCase().includes(t));
    });
    const toolbar = h(
      'div',
      { class: 'toolbar' },
      search('Search URL, client, file…', x.requestText || '', (v) => {
        x.requestText = v;
        persist();
        render();
      }, 'Search requests'),
      select('Status', status, [['', 'All'], ['matched', 'Matched'], ['unmatched', 'Unmatched'], ['ambiguous', 'Several candidates']], (v) => {
        x.requestStatus = v;
        persist();
        render();
      }),
    );
    if (rows.length === 0) return h('div', {}, toolbar, empty('No frontend requests match.'));
    const table = h('table', { class: 'grid' }, h('thead', {}, h('tr', {}, ['Method', 'URL', 'From', 'Matched route', 'Fields read'].map((c) => h('th', { scope: 'col', text: c })))));
    const body = h('tbody');
    for (const c of rows.slice(0, 1000)) {
      const targets = c.endpointIds.map((id) => byId.get(id)).filter(Boolean);
      body.appendChild(
        h(
          'tr',
          {},
          h('td', {}, methodBadge(c.method === 'ALL' ? undefined : c.method)),
          h('td', {}, h('code', { text: c.url })),
          h('td', {}, linkButton(c.within || c.where, c.ref, c.where), h('div', { class: 'muted small', text: `${c.client} · ${c.where}` })),
          h('td', {}, targets.length === 0 ? badge('unmatched', 'warn') : targets.length > 1 ? [badge(`${targets.length} candidates`, 'warn'), ' '] : null, targets.map((t, i) => [i ? ', ' : '', linkButton(`${t.method} ${t.path}`, t.ref)])),
          h('td', { class: 'small' }, c.reads.length ? c.reads.slice(0, 8).map((r, i) => [i ? ', ' : '', h('code', { text: r })]) : h('span', { class: 'muted', text: '—' })),
        ),
      );
    }
    table.appendChild(body);
    return h('div', {}, toolbar, h('p', { class: 'muted', role: 'status', text: `${rows.length} request(s). Unmatched requests may target another service or use a URL built at runtime.` }), table);
  }

  function issuesView() {
    const labels = {
      'broken-call': 'Unmatched frontend request',
      'response-mismatch': 'Read of a missing response field',
      duplicate: 'Duplicate route candidate',
      unreachable: 'Unreachable route',
      uncalled: 'Potentially unused',
      'no-auth': 'No recognizable auth',
      'no-validation': 'No body validation',
      limitation: 'Analysis limitation',
      'parse-error': 'Parse error',
      skipped: 'Skipped',
    };
    const order = Object.keys(labels);
    const groups = order.map((k) => [k, model.issues.filter((i) => i.kind === k)]).filter(([, list]) => list.length);
    const dynamic = model.endpoints.filter((e) => e.confidence === 'low');
    const unmounted = model.endpoints.filter((e) => e.confidence === 'medium');
    const blocks = [];
    if (dynamic.length) blocks.push(h('section', { class: 'card' }, h('h3', { text: `Dynamic routes requiring review (${dynamic.length})` }), h('ul', { class: 'plain' }, dynamic.map((e) => h('li', {}, methodBadge(e.method), ' ', h('code', { text: e.path }), ' ', linkButton(e.where, e.ref))))));
    if (unmounted.length) blocks.push(h('section', { class: 'card' }, h('h3', { text: `Routes relative to an unmounted router (${unmounted.length})` }), h('ul', { class: 'plain' }, unmounted.map((e) => h('li', {}, methodBadge(e.method), ' ', h('code', { text: e.path }), ' ', linkButton(e.where, e.ref))))));
    for (const [kind, list] of groups) {
      blocks.push(h('section', { class: 'card' }, h('h3', { text: `${labels[kind]} (${list.length})` }), h('ul', { class: 'plain' }, list.slice(0, 300).map((i) => h('li', {}, rich(i.message), ' ', linkButton(i.where || 'open', i.ref))))));
    }
    return blocks.length ? h('div', {}, blocks) : empty('No coverage findings.');
  }

  // ---------------------------------------------------------------------------------------------
  // Impact
  // ---------------------------------------------------------------------------------------------

  function impact() {
    const im = model.impact;
    const head = h(
      'div',
      { class: 'toolbar' },
      h('div', { class: 'grow' }, im.status === 'ready' ? h('p', {}, 'Comparing the current code with ', h('strong', { text: im.baseLabel }), '.') : im.status === 'computing' ? h('p', { role: 'status', text: `Analyzing ${im.baseLabel || 'the baseline'}…` }) : h('p', { class: 'muted', text: im.reason || 'Impact analysis is not available.' }), im.note ? h('p', { class: 'muted small', text: im.note }) : null),
      button('Change baseline…', () => command('apiShadow.setImpactBaseline')),
      button('Re-analyze', () => command('apiShadow.refresh')),
    );
    if (im.status !== 'ready') return h('div', {}, head);
    if (im.endpoints.length === 0) {
      return h('div', {}, head, empty(`No endpoint changes since ${im.baseLabel}${im.added ? ` (${count(im.added, 'endpoint')} added)` : ''}.`));
    }
    const chips = h('p', {}, badge(`${im.summary.high} high`, 'danger'), ' ', badge(`${im.summary.medium} medium`, 'warn'), ' ', badge(`${im.summary.low} low`, 'muted'), im.added ? ` · ${count(im.added, 'endpoint')} added` : '');
    const cards = im.endpoints.map((e) =>
      h(
        'article',
        { class: `card impact risk-${e.risk}`, id: `impact-${e.key}` },
        h('h3', {}, badge(e.risk.toUpperCase(), e.risk === 'high' ? 'danger' : e.risk === 'medium' ? 'warn' : 'muted'), ' ', methodBadge(e.method), ' ', h('code', { text: e.path }), ' ', h('span', { class: 'muted', text: e.status === 'removed' ? 'removed' : e.status === 'moved' ? `was ${e.before}` : 'changed' }), ' ', linkButton('open', e.ref)),
        h(
          'ul',
          { class: 'plain' },
          e.changes.map((c) =>
            h(
              'li',
              {},
              h('div', {}, c.breaking ? badge('breaking', 'danger') : badge('compatible', 'ok'), ' ', rich(c.text), ' ', badge(c.evidence, c.evidence === 'confirmed' ? 'ok' : 'muted')),
              h('div', { class: 'muted small' }, rich(c.reason)),
              c.reads.length
                ? h(
                    'ul',
                    { class: 'reads' },
                    c.reads.map((r) => h('li', {}, 'reads ', h('code', { text: r.path }), r.within ? ` in ${r.within} ` : ' ', linkButton(r.where, r.ref), r.suggestion ? h('div', { class: 'small' }, 'Suggested fix: use ', h('code', { text: r.suggestion.to }), ' instead of ', h('code', { text: r.suggestion.from }), ' (quick fix on the line in the editor)') : null)),
                  )
                : null,
            ),
          ),
        ),
        e.callers.length
          ? h('details', {}, h('summary', { text: `${count(e.callers.length, 'caller')}` }), h('ul', { class: 'plain small' }, e.callers.map((c) => h('li', {}, linkButton(c.within || c.where, c.ref, c.where), ` ${c.kind === 'test' ? 'test' : c.client} · ${c.where}`, c.consumers.length ? h('span', { class: 'muted' }, ' · used by ', c.consumers.map((u, i) => [i ? ', ' : '', linkButton(u.within || u.where, u.ref)])) : null))))
          : h('p', { class: 'muted small', text: 'No caller found in the workspace; external clients may still be affected.' }),
      ),
    );
    return h('div', {}, head, chips, cards, h('p', { class: 'muted small', text: 'Confirmed: a read of the changed field was found. Heuristic: callers exist, but how they use the response could not be traced. Response shapes are inferred from code and may be incomplete.' }));
  }

  // ---------------------------------------------------------------------------------------------
  // Security
  // ---------------------------------------------------------------------------------------------

  function security() {
    const x = ui.security;
    const rules = [...new Set(model.security.map((f) => f.rule))];
    const list = model.security.filter((f) => (x.showDismissed ? true : !f.dismissed) && (!x.severity || f.severity === x.severity) && (!x.confidence || f.confidence === x.confidence) && (!x.rule || f.rule === x.rule));
    const toolbar = h(
      'div',
      { class: 'toolbar' },
      h('div', { class: 'chips', role: 'group', 'aria-label': 'Severity' }, ['high', 'medium', 'low', 'info'].map((s) =>
        chip(`${s} (${model.security.filter((f) => f.severity === s && !f.dismissed).length})`, x.severity === s, () => {
          x.severity = x.severity === s ? '' : s;
          persist();
          render();
        }),
      )),
      select('Confidence', x.confidence, [['', 'All'], ['high', 'High'], ['medium', 'Medium'], ['low', 'Low']], (v) => {
        x.confidence = v;
        persist();
        render();
      }),
      select('Rule', x.rule, [['', 'All rules'], ...rules.map((r) => [r, r])], (v) => {
        x.rule = v;
        persist();
        render();
      }),
      h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: x.showDismissed, onchange: (e) => {
        x.showDismissed = e.target.checked;
        persist();
        render();
      } }), ' Show dismissed'),
    );
    const groups = ['high', 'medium', 'low', 'info'].map((s) => [s, list.filter((f) => f.severity === s)]).filter(([, l]) => l.length);
    const content = groups.length
      ? groups.map(([sev, items]) =>
          h(
            'section',
            {},
            h('h2', { text: `${sev[0].toUpperCase()}${sev.slice(1)} (${items.length})` }),
            items.map((f) =>
              h(
                'article',
                { class: `card finding sev-${f.severity}${f.dismissed ? ' dismissed' : ''}`, id: `finding-${f.id}` },
                h('h3', {}, f.title, f.endpoint ? h('span', { class: 'muted' }, ' — ', h('code', { text: f.endpoint })) : null),
                h('p', {}, rich(f.message)),
                h('div', { class: 'kv' }, h('span', { class: 'k', text: 'Evidence' }), h('code', { class: 'v', text: f.evidence })),
                h('div', { class: 'kv' }, h('span', { class: 'k', text: 'Mitigation' }), h('span', { class: 'v' }, rich(f.mitigation))),
                h('div', { class: 'row' }, badge(`confidence ${f.confidence}`, 'muted'), badge(f.rule, 'muted'), linkButton(f.where, f.ref), f.dismissed ? button('Restore', () => send({ type: 'restore', id: f.id })) : button('Dismiss', () => send({ type: 'dismiss', id: f.id }), { title: 'Hide this finding in this workspace (false positive or accepted risk)' })),
              ),
            ),
          ),
        )
      : [empty(model.security.length ? 'No findings match these filters.' : 'No security findings. This does not prove the API is secure: only the patterns listed below are checked.')];
    const rulesCard = h(
      'details',
      { class: 'card' },
      h('summary', { text: 'Rules and exclusions' }),
      h('p', { class: 'muted small', text: 'Turning a rule off updates the workspace setting apiShadow.security.disabledRules. Files can be excluded with apiShadow.security.exclude.' }),
      h('ul', { class: 'plain' }, model.rules.map((r) => h('li', {}, h('strong', { text: r.title }), ' ', h('code', { text: r.id }), ' ', r.disabled ? button('Turn on', () => command('apiShadow.enableSecurityRule', [r.id])) : button('Turn off…', () => command('apiShadow.disableSecurityRule', [r.id])), h('div', { class: 'muted small' }, rich(r.description))))),
      model.security.some((f) => f.dismissed) ? button('Restore all dismissed findings', () => command('apiShadow.restoreDismissedFindings')) : null,
    );
    return h('div', {}, toolbar, h('p', { class: 'muted small', text: 'Potential issues found by static analysis, not confirmed vulnerabilities. Nothing was executed or sent anywhere.' }), content, rulesCard);
  }

  // ---------------------------------------------------------------------------------------------
  // Graph
  // ---------------------------------------------------------------------------------------------

  const COLUMNS = { component: 0, client: 1, request: 2, test: 2, endpoint: 3, handler: 4, service: 5, data: 6 };
  const COLUMN_TITLES = ['Components', 'API functions', 'Requests & tests', 'Endpoints', 'Handlers', 'Services', 'Repositories & models'];
  const NODE_W = 210;
  const NODE_H = 34;
  const GAP_X = 70;
  const GAP_Y = 10;
  let view = { x: 20, y: 40, k: 1 };
  let lastLayout;
  /** Below this zoom labels are unreadable; the first view never goes smaller. */
  const READABLE = 0.7;

  function graph() {
    const g = model.graph;
    const x = ui.graph;
    if (!g || g.nodes.length === 0) return empty('No endpoints or requests to show.');
    const frameworks = [...new Set(g.nodes.filter((n) => n.framework).map((n) => n.framework))];
    const toolbar = h(
      'div',
      { class: 'toolbar' },
      h('form', { class: 'inline', onsubmit: (e) => {
        e.preventDefault();
        x.query = e.target.elements.q.value;
        persist();
        send({ type: 'graphFocus', query: x.query });
      } }, h('input', { type: 'search', name: 'q', value: g.focus || '', placeholder: 'Focus on endpoints matching…', 'aria-label': 'Focus the graph on matching endpoints' }), button('Focus', null, { type: 'submit' }), g.focus ? button('Show all', () => {
        x.query = '';
        persist();
        send({ type: 'graphFocus', query: '' });
      }) : null),
      h('div', { class: 'chips', role: 'group', 'aria-label': 'HTTP methods' }, ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].map((m) =>
        chip(m, x.methods.includes(m), () => {
          x.methods = x.methods.includes(m) ? x.methods.filter((y) => y !== m) : [...x.methods, m];
          persist();
          render();
        }),
      )),
      frameworks.length > 1 ? select('Framework', x.framework, [['', 'All'], ...frameworks.map((f) => [f, f])], (v) => {
        x.framework = v;
        persist();
        render();
      }) : null,
      chip('Unmatched requests', x.unmatched, () => {
        x.unmatched = !x.unmatched;
        persist();
        render();
      }, 'Show requests that match no route'),
      chip('Uncalled endpoints', x.uncalled, () => {
        x.uncalled = !x.uncalled;
        persist();
        render();
      }, 'Show endpoints with no caller in the workspace'),
      chip('Impacted only', x.impactedOnly, () => {
        x.impactedOnly = !x.impactedOnly;
        persist();
        render();
      }, 'Only what the current change may affect'),
      h('div', { class: 'row' }, button('−', () => zoom(1 / 1.25), { 'aria-label': 'Zoom out' }), h('span', { id: 'zoom-level', class: 'zoom-level', 'aria-live': 'polite', text: `${Math.round(view.k * 100)}%` }), button('+', () => zoom(1.25), { 'aria-label': 'Zoom in' }), button('Fit', () => fit(), { 'aria-label': 'Fit to view' }), button('Export…', () => command('apiShadow.exportGraph'), { title: 'Save as Mermaid or JSON' })),
    );
    const note = g.endpoints.shown < g.endpoints.total ? h('p', { class: 'muted small', role: 'status', text: `Showing ${g.endpoints.shown} of ${g.endpoints.total} endpoints (most connected first). Focus on a path or controller to see others.` }) : null;
    const { nodes, edges } = visibleGraph(g);
    if (nodes.length === 0) return h('div', {}, toolbar, note, empty('Nothing matches these filters.'));
    const layout = layoutGraph(nodes, edges);
    lastLayout = layout;
    const canvas = h('div', { class: 'graph-wrap' });
    const s = svg('svg', { class: 'graph', role: 'application', 'aria-label': 'API dependency graph. Tab to move between nodes, Enter to select, O to open source.', tabindex: '0' });
    const root = svg('g', {});
    s.appendChild(root);
    // Column titles
    COLUMN_TITLES.forEach((t, i) => {
      if (layout.columnX.has(i)) root.appendChild(svg('text', { x: layout.columnX.get(i), y: -14, class: 'col-title', text: t }));
    });
    const selected = x.selected && layout.pos.has(x.selected) ? x.selected : '';
    const lit = selected ? neighbourhood(selected, edges) : null;
    for (const e of edges) {
      const a = layout.pos.get(e.from);
      const b = layout.pos.get(e.to);
      if (!a || !b) continue;
      const x1 = a.x + NODE_W;
      const y1 = a.y + NODE_H / 2;
      const x2 = b.x;
      const y2 = b.y + NODE_H / 2;
      const mid = (x1 + x2) / 2;
      const d = x2 >= x1 ? `M${x1},${y1} C${mid},${y1} ${mid},${y2} ${x2},${y2}` : `M${a.x},${y1} C${a.x - 60},${y1} ${x2 + NODE_W + 60},${y2} ${x2 + NODE_W},${y2}`;
      root.appendChild(svg('path', { d, class: `edge e-${e.kind}${lit ? (lit.has(e.from) && lit.has(e.to) ? ' lit' : ' dim') : ''}` }));
    }
    for (const n of nodes) {
      const p = layout.pos.get(n.id);
      const cls = ['node', `k-${n.kind}`, n.method ? `m-${n.method.toLowerCase()}` : '', n.unmatched ? 'unmatched' : '', n.ambiguous ? 'ambiguous' : '', n.uncalled ? 'uncalled' : '', n.impacted ? `impacted-${n.impacted}` : '', n.security ? 'insecure' : '', n.id === selected ? 'sel' : '', lit && !lit.has(n.id) ? 'dim' : ''].filter(Boolean).join(' ');
      const label = `${n.kind}: ${n.label}${n.unmatched ? ', no matching route' : ''}${n.uncalled ? ', no caller found' : ''}${n.impacted ? `, impact ${n.impacted}` : ''}`;
      const g2 = svg('g', { class: cls, transform: `translate(${p.x},${p.y})`, tabindex: '0', role: 'button', 'aria-label': label, 'data-id': n.id });
      g2.appendChild(svg('title', { text: `${n.label}${n.detail ? `\n${n.detail}` : ''}` }));
      g2.appendChild(svg('rect', { width: NODE_W, height: NODE_H, rx: 6 }));
      g2.appendChild(svg('text', { x: 10, y: 21, text: truncate(n.label, 26) }));
      if (n.security) g2.appendChild(svg('circle', { cx: NODE_W - 10, cy: 10, r: 4, class: 'dot-sec' }));
      g2.addEventListener('click', (ev) => {
        ev.stopPropagation();
        selectNode(n.id);
      });
      g2.addEventListener('dblclick', () => open(n.ref));
      g2.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter' || ev.key === ' ') {
          ev.preventDefault();
          selectNode(n.id);
        } else if (ev.key === 'o' || ev.key === 'O') open(n.ref);
        else if (ev.key === 'Escape') selectNode('');
      });
      root.appendChild(g2);
    }
    canvas.appendChild(s);
    const details = h('aside', { class: 'details graph-details', 'aria-label': 'Node details' }, nodeDetails(nodes, edges, selected));
    const legend = h('p', { class: 'legend small' }, h('span', { class: 'lg unmatched', text: 'dashed: no matching route' }), h('span', { class: 'lg uncalled', text: 'faded: no caller found' }), h('span', { class: 'lg impacted', text: 'red outline: affected by the change' }), h('span', { class: 'lg ambiguous', text: 'dotted edge: several candidate routes' }), h('span', { class: 'lg hint', text: 'Drag to pan · scroll to zoom · Esc clears the selection · O opens source' }));
    const wrap = h('div', { class: 'graph-layout' }, canvas, details);
    setTimeout(() => {
      apply();
      installPanZoom(s);
      if (!fitted) {
        fitted = true;
        fitWidth();
      }
    });
    function apply() {
      root.setAttribute('transform', `translate(${view.x},${view.y}) scale(${view.k})`);
      const level = document.getElementById('zoom-level');
      if (level) level.textContent = `${Math.round(view.k * 100)}%`;
    }
    function zoom(f, cx, cy) {
      const r = s.getBoundingClientRect();
      const px = cx === undefined ? r.width / 2 : cx;
      const py = cy === undefined ? r.height / 2 : cy;
      const k = Math.min(3, Math.max(0.15, view.k * f));
      view.x = px - ((px - view.x) * k) / view.k;
      view.y = py - ((py - view.y) * k) / view.k;
      view.k = k;
      apply();
    }
    /** Everything in view, however small. */
    function fit() {
      const r = s.getBoundingClientRect();
      if (!r.width) return;
      const k = Math.min(1.2, Math.max(0.15, Math.min((r.width - 40) / layout.width, (r.height - 60) / layout.height)));
      view = { x: 20, y: 40, k };
      apply();
    }
    /** All columns side by side at a readable size; tall columns are reached by panning. */
    function fitWidth() {
      const r = s.getBoundingClientRect();
      if (!r.width) return;
      const k = Math.min(1.1, Math.max(READABLE, (r.width - 40) / layout.width));
      view = { x: 20, y: 40, k };
      apply();
    }
    function installPanZoom(el) {
      let drag;
      /** Set when the pointer moved enough to be a pan; the click that ends a pan is ignored. */
      let panned = false;
      el.addEventListener('wheel', (ev) => {
        ev.preventDefault();
        const r = el.getBoundingClientRect();
        zoom(ev.deltaY < 0 ? 1.1 : 1 / 1.1, ev.clientX - r.left, ev.clientY - r.top);
      }, { passive: false });
      el.addEventListener('pointerdown', (ev) => {
        if (ev.target.closest && ev.target.closest('.node')) return;
        drag = { x: ev.clientX, y: ev.clientY, vx: view.x, vy: view.y };
        panned = false;
        el.setPointerCapture(ev.pointerId);
      });
      el.addEventListener('pointermove', (ev) => {
        if (!drag) return;
        if (Math.abs(ev.clientX - drag.x) + Math.abs(ev.clientY - drag.y) > 4) panned = true;
        view.x = drag.vx + ev.clientX - drag.x;
        view.y = drag.vy + ev.clientY - drag.y;
        apply();
      });
      const endDrag = () => (drag = undefined);
      el.addEventListener('pointerup', endDrag);
      el.addEventListener('pointercancel', endDrag);
      el.addEventListener('click', (ev) => {
        // Only a click on empty canvas clears the selection, never the end of a pan.
        if (panned) {
          panned = false;
          return;
        }
        if (!(ev.target.closest && ev.target.closest('.node')) && x.selected) selectNode('');
      });
      el.addEventListener('keydown', (ev) => {
        const step = 40;
        if (ev.target !== el) return;
        if (ev.key === 'ArrowLeft') view.x += step;
        else if (ev.key === 'ArrowRight') view.x -= step;
        else if (ev.key === 'ArrowUp') view.y += step;
        else if (ev.key === 'ArrowDown') view.y -= step;
        else if (ev.key === '+' || ev.key === '=') return zoom(1.2);
        else if (ev.key === '-') return zoom(1 / 1.2);
        else if (ev.key === 'Escape' && x.selected) return selectNode('');
        else return;
        ev.preventDefault();
        apply();
      });
    }
    function selectNode(id) {
      x.selected = id;
      persist();
      render();
      if (!id) return;
      revealNode(id);
      document.querySelector(`[data-id="${CSS.escape(id)}"]`)?.focus({ preventScroll: true });
    }
    return h('div', {}, toolbar, note, legend, wrap);
  }

  /** Pans so a node is inside the viewport, if it is not already. */
  function revealNode(id) {
    const el = document.querySelector('svg.graph');
    const p = lastLayout && lastLayout.pos.get(id);
    if (!el || !p) return;
    const r = el.getBoundingClientRect();
    const sx = view.x + p.x * view.k;
    const sy = view.y + p.y * view.k;
    const inside = sx >= 0 && sy >= 0 && sx + NODE_W * view.k <= r.width && sy + NODE_H * view.k <= r.height;
    if (inside) return;
    view.x = r.width / 2 - (p.x + NODE_W / 2) * view.k;
    view.y = r.height / 2 - (p.y + NODE_H / 2) * view.k;
    document.querySelector('svg.graph > g')?.setAttribute('transform', `translate(${view.x},${view.y}) scale(${view.k})`);
  }

  function visibleGraph(g) {
    const x = ui.graph;
    const endpointOk = (n) => (!x.methods.length || x.methods.includes(n.method)) && (!x.framework || n.framework === x.framework) && (x.uncalled || !n.uncalled) && (!x.impactedOnly || n.impacted);
    const keepEndpoints = new Set(g.nodes.filter((n) => n.kind === 'endpoint' && endpointOk(n)).map((n) => n.id));
    // Keep nodes connected to a kept endpoint, plus unmatched requests (and their callers) if asked.
    const adj = new Map();
    for (const e of g.edges) {
      if (!adj.has(e.from)) adj.set(e.from, []);
      if (!adj.has(e.to)) adj.set(e.to, []);
      adj.get(e.from).push(e.to);
      adj.get(e.to).push(e.from);
    }
    const keep = new Set();
    const byId = new Map(g.nodes.map((n) => [n.id, n]));
    const walk = (start) => {
      const stack = [start];
      while (stack.length) {
        const id = stack.pop();
        if (keep.has(id)) continue;
        const n = byId.get(id);
        if (!n) continue;
        if (n.kind === 'endpoint' && !keepEndpoints.has(id)) continue;
        if (x.impactedOnly && (n.kind === 'request' || n.kind === 'component') && !n.impacted) continue;
        keep.add(id);
        for (const nb of adj.get(id) || []) stack.push(nb);
      }
    };
    for (const id of keepEndpoints) walk(id);
    if (x.unmatched && !x.impactedOnly) for (const n of g.nodes) if (n.unmatched) walk(n.id);
    const nodes = g.nodes.filter((n) => keep.has(n.id));
    const edges = g.edges.filter((e) => keep.has(e.from) && keep.has(e.to));
    return { nodes, edges };
  }

  function layoutGraph(nodes, edges) {
    const columns = [];
    for (const n of nodes) {
      const c = COLUMNS[n.kind];
      (columns[c] = columns[c] || []).push(n);
    }
    for (const col of columns) if (col) col.sort((a, b) => a.label.localeCompare(b.label));
    const neighbours = new Map();
    for (const e of edges) {
      if (!neighbours.has(e.from)) neighbours.set(e.from, []);
      if (!neighbours.has(e.to)) neighbours.set(e.to, []);
      neighbours.get(e.from).push(e.to);
      neighbours.get(e.to).push(e.from);
    }
    const index = new Map();
    const reindex = () => columns.forEach((col) => col && col.forEach((n, i) => index.set(n.id, i)));
    reindex();
    // Barycentre sweeps reduce crossings; a few passes are enough for readable layouts.
    const sweeps = nodes.length > 1500 ? 1 : 4;
    for (let s = 0; s < sweeps; s++) {
      const order = s % 2 === 0 ? columns.map((_, i) => i) : columns.map((_, i) => columns.length - 1 - i);
      for (const c of order) {
        const col = columns[c];
        if (!col) continue;
        const bary = new Map(col.map((n) => {
          const nb = (neighbours.get(n.id) || []).map((id) => index.get(id)).filter((v) => v !== undefined);
          return [n.id, nb.length ? nb.reduce((a, b) => a + b, 0) / nb.length : index.get(n.id)];
        }));
        col.sort((a, b) => bary.get(a.id) - bary.get(b.id));
        col.forEach((n, i) => index.set(n.id, i));
      }
    }
    // Only columns that have nodes take space.
    const pos = new Map();
    const columnX = new Map();
    let height = 0;
    let slot = 0;
    columns.forEach((col, c) => {
      if (!col || col.length === 0) return;
      const x = slot++ * (NODE_W + GAP_X);
      columnX.set(c, x);
      col.forEach((n, i) => pos.set(n.id, { x, y: i * (NODE_H + GAP_Y) }));
      height = Math.max(height, col.length * (NODE_H + GAP_Y));
    });
    return { pos, columns, columnX, width: Math.max(1, slot) * (NODE_W + GAP_X), height: height + 40 };
  }

  function neighbourhood(id, edges) {
    // Everything upstream (callers) and downstream (implementation) of the node.
    const out = new Set([id]);
    const down = new Map();
    const up = new Map();
    for (const e of edges) {
      (down.get(e.from) || down.set(e.from, []).get(e.from)).push(e.to);
      (up.get(e.to) || up.set(e.to, []).get(e.to)).push(e.from);
    }
    const walk = (start, map) => {
      const stack = [start];
      while (stack.length) {
        const n = stack.pop();
        for (const m of map.get(n) || []) {
          if (!out.has(m)) {
            out.add(m);
            stack.push(m);
          }
        }
      }
    };
    walk(id, down);
    walk(id, up);
    return out;
  }

  /** How each kind of relationship was inferred, shown next to it. */
  const EDGE_REASON = {
    consumes: 'calls a function that returns this response',
    calls: 'makes this request',
    matches: 'method and path match this route',
    ambiguous: 'one of several routes that match equally well',
    tests: 'test request to this route',
    handles: 'route handler',
    uses: 'called from the handler',
    stores: 'data access (model, repository or DAO)',
  };

  function nodeDetails(nodes, edges, id) {
    const n = nodes.find((x) => x.id === id);
    if (!n) return empty('Select a node to highlight its callers and implementation. Double-click or press O to open its source.');
    const byId = new Map(nodes.map((x) => [x.id, x]));
    const incoming = edges.filter((e) => e.to === id && byId.has(e.from)).map((e) => [byId.get(e.from), e.kind]);
    const outgoing = edges.filter((e) => e.from === id && byId.has(e.to)).map((e) => [byId.get(e.to), e.kind]);
    const ep = n.endpointId ? model.endpoints.find((e) => e.id === n.endpointId) : null;
    const item = ([x, kind]) => h('li', {}, h('button', { type: 'button', class: 'link', onclick: () => {
      ui.graph.selected = x.id;
      persist();
      render();
    } }, x.label), h('span', { class: 'muted', text: ` ${x.kind}` }), h('div', { class: 'muted small', text: EDGE_REASON[kind] || '' }));
    return h(
      'div',
      {},
      h('h2', {}, n.method ? [methodBadge(n.method), ' '] : null, h('span', { text: n.label })),
      h('p', { class: 'muted', text: `${n.kind}${n.detail ? ' · ' + n.detail : ''}` }),
      h('div', { class: 'row' }, linkButton('Open source', n.ref), ep ? button('Endpoint details', () => {
        ui.explorer.selected = ep.id;
        ui.explorer.view = 'endpoints';
        selectTab('explorer');
      }) : null),
      n.unmatched ? h('p', { class: 'warn-text', text: 'No discovered route matches this request. It may call another service or use a URL built at runtime.' }) : null,
      n.ambiguous ? h('p', { class: 'warn-text', text: 'Several routes match equally well; all candidates are linked.' }) : null,
      n.uncalled ? h('p', { class: 'muted', text: 'No caller found in the workspace. External clients may still use it.' }) : null,
      n.impacted ? h('p', { class: 'danger-text', text: `Affected by the current change (risk ${n.impacted}).` }) : null,
      incoming.length ? h('section', {}, h('h3', { text: `Used by (${incoming.length})` }), h('ul', { class: 'plain' }, incoming.map(item))) : null,
      outgoing.length ? h('section', {}, h('h3', { text: `Uses (${outgoing.length})` }), h('ul', { class: 'plain' }, outgoing.map(item))) : null,
    );
  }

  function truncate(s, n) {
    return s.length > n ? s.slice(0, n - 1) + '…' : s;
  }

  // ---------------------------------------------------------------------------------------------
  // Contracts
  // ---------------------------------------------------------------------------------------------

  function contracts() {
    const c = model.contracts;
    const files = c.files.length
      ? h('ul', { class: 'plain' }, c.files.map((f) => h('li', {}, h('code', { text: f.path }), ' ', button('Compare with git revision…', () => send({ type: 'compareContract', index: f.index })))))
      : h('p', { class: 'muted', text: 'No OpenAPI 3 document (openapi.json/yaml, swagger.yaml, *.openapi.yaml…) was found. Add one, list it in apiShadow.contracts.files, or compare the inferred API instead.' });
    const actions = h('div', { class: 'row' }, button('Compare OpenAPI contracts…', () => command('apiShadow.compareContracts')), button('Compare inferred API with branch… (best effort)', () => command('apiShadow.compareWithRef')));
    let last = null;
    if (c.last) {
      const l = c.last;
      const compat = l.counts.breaking ? ['Breaking', 'danger'] : l.counts['potentially-breaking'] ? ['Potentially breaking', 'warn'] : ['Compatible', 'ok'];
      const byOp = new Map();
      for (const ch of l.changes) {
        if (!byOp.has(ch.operation)) byOp.set(ch.operation, []);
        byOp.get(ch.operation).push(ch);
      }
      last = h(
        'section',
        { class: 'card' },
        h('h2', { text: `${l.title}: ${l.beforeLabel} → ${l.afterLabel}` }),
        l.bestEffort ? h('p', { class: 'warn-text', text: 'Best effort: compared from static analysis, not from an API specification.' }) : null,
        l.file ? h('p', { class: 'muted', text: l.file }) : null,
        h('p', {}, 'Compatibility: ', badge(compat[0], compat[1]), ' ', `${l.counts.breaking || 0} breaking · ${l.counts['potentially-breaking'] || 0} potentially breaking · ${l.counts['non-breaking'] || 0} non-breaking · ${l.counts.info || 0} informational`),
        l.changes.length === 0 ? h('p', { text: 'No differences.' }) : null,
        [...byOp].map(([op, list]) => h('div', { class: 'op' }, h('h3', {}, h('code', { text: op })), h('ul', { class: 'plain' }, list.map((ch) => h('li', {}, badge(ch.severity, ch.severity === 'breaking' ? 'danger' : ch.severity === 'potentially-breaking' ? 'warn' : ch.severity === 'info' ? 'muted' : 'ok'), ' ', h('span', { class: 'muted', text: `${ch.area}: ` }), rich(ch.text)))))),
      );
    }
    return h('div', {}, h('section', { class: 'card' }, h('h2', { text: 'OpenAPI documents' }), files, actions), last || empty('Run a comparison to see the contract diff here.'));
  }

  // ---------------------------------------------------------------------------------------------
  // Tests
  // ---------------------------------------------------------------------------------------------

  function tests() {
    const x = ui.tests;
    const known = new Set(model.endpoints.map((e) => e.id));
    x.selected = x.selected.filter((id) => known.has(id));
    const terms = x.text.toLowerCase().split(/\s+/).filter(Boolean);
    const rows = model.endpoints.filter((e) => !terms.length || terms.every((t) => `${e.method} ${e.path} ${handlerLabel(e)} ${e.where}`.toLowerCase().includes(t)));
    const projects = model.testProjects.length
      ? h('ul', { class: 'plain' }, model.testProjects.map((p) => h('li', {}, h('code', { text: p.label }), ` · ${p.kind === 'java' ? 'JUnit 5 + MockMvc' : p.kind === 'php' ? 'PHPUnit feature tests' : `${p.runner} + Supertest`}`)))
      : h('p', { class: 'muted', text: 'No project detected.' });
    const list = h(
      'div',
      { class: 'list checklist', role: 'group', 'aria-label': 'Endpoints to generate tests for' },
      rows.slice(0, 500).map((e) =>
        h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: x.selected.includes(e.id), onchange: (ev) => {
          x.selected = ev.target.checked ? [...x.selected, e.id] : x.selected.filter((id) => id !== e.id);
          persist();
          updateCount();
        } }), ' ', methodBadge(e.method), ' ', h('code', { text: e.path }), h('span', { class: 'muted small', text: ` ${handlerLabel(e)} · ${e.where}` })),
      ),
    );
    const countEl = h('span', { role: 'status', class: 'muted' });
    function updateCount() {
      countEl.textContent = `${x.selected.length} selected`;
      gen.disabled = x.selected.length === 0;
    }
    const gen = button('Preview and create…', () => send({ type: 'generateTests', endpointIds: x.selected, runner: x.runner }), { class: 'primary', title: 'Shows the generated file and asks before writing it' });
    const toolbar = h(
      'div',
      { class: 'toolbar' },
      search('Filter endpoints…', x.text, (v) => {
        x.text = v;
        persist();
        render();
      }),
      select('Framework', x.runner, [['auto', 'Detect from project'], ['jest', 'Jest + Supertest'], ['vitest', 'Vitest + Supertest'], ['mocha', 'Mocha + Chai + Supertest'], ['junit', 'JUnit 5 + MockMvc'], ['phpunit', 'PHPUnit (Laravel)']], (v) => {
        x.runner = v;
        persist();
      }),
      button('Select shown', () => {
        x.selected = [...new Set([...x.selected, ...rows.map((e) => e.id)])];
        persist();
        render();
      }),
      button('Clear', () => {
        x.selected = [];
        persist();
        render();
      }),
      countEl,
      gen,
    );
    updateCount();
    return h(
      'div',
      {},
      h('section', { class: 'card' }, h('h2', { text: 'Detected test setup' }), projects, h('p', { class: 'muted small', text: 'Generated files are editable starting points: expectations come from what the code shows, gaps are marked TODO or left pending. Nothing is written without your confirmation, existing files are never overwritten, and tests are never run automatically.' })),
      toolbar,
      list,
    );
  }

  // ---------------------------------------------------------------------------------------------
  // Messages
  // ---------------------------------------------------------------------------------------------

  window.addEventListener('message', (event) => {
    const msg = event.data;
    if (!msg || typeof msg !== 'object') return;
    if (msg.type === 'model') {
      if (model && model.graph && msg.model.graph && model.graph.focus !== msg.model.graph.focus) fitted = false;
      model = msg.model;
      if (typeof msg.tab === 'string' && TABS.some((t) => t[0] === msg.tab)) ui.tab = msg.tab;
      if (msg.focus) focusId = msg.focus;
      render();
      revealFocus();
    } else if (msg.type === 'focus') {
      if (TABS.some((t) => t[0] === msg.tab)) ui.tab = msg.tab;
      focusId = msg.id;
      render();
      revealFocus();
    }
  });

  function revealFocus() {
    if (!focusId) return;
    const el = document.getElementById(`finding-${focusId}`) || document.getElementById(`impact-${focusId}`);
    if (el) {
      el.classList.add('flash');
      el.scrollIntoView({ block: 'center' });
      el.setAttribute('tabindex', '-1');
      el.focus();
    }
    focusId = undefined;
  }

  send({ type: 'ready' });
})();

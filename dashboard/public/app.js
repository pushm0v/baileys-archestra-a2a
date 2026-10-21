// Dashboard UI: plain DOM, no build step. All data comes from /api and the /api/live WebSocket.

const $ = sel => document.querySelector(sel)

// Build DOM nodes without innerHTML, so text from the API is never parsed as HTML
function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag)
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === null || v === undefined || v === false) continue
    if (k.startsWith('on')) el.addEventListener(k.slice(2).toLowerCase(), v)
    else if (k === 'class') el.className = v
    else if (v === true) el.setAttribute(k, '')
    else el.setAttribute(k, v)
  }
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue
    el.append(c instanceof Node ? c : document.createTextNode(String(c)))
  }
  return el
}

// replaceChildren, skipping null/false the same way h() does
const fill = (el, ...children) => el.replaceChildren(...children.flat(Infinity).filter(c => c !== null && c !== undefined && c !== false))

async function api(method, path, body) {
  const res = await fetch(`/api${path}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  })
  if (res.status === 401) { location.href = '/login'; throw new Error('Signed out') }
  const data = res.status === 204 ? null : await res.json().catch(() => null)
  if (!res.ok) {
    const err = new Error(data?.error || `HTTP ${res.status}`)
    err.errors = data?.errors
    throw err
  }
  return data
}

function toast(message, kind = 'info') {
  const t = $('#toast')
  t.textContent = message
  t.className = `toast ${kind}`
  t.hidden = false
  clearTimeout(toast.timer)
  toast.timer = setTimeout(() => { t.hidden = true }, kind === 'error' ? 8000 : 4000)
}

const fail = e => toast(e.errors?.join('\n') || e.message, 'error')

function ago(ts) {
  if (!ts) return 'never'
  const s = Math.round((Date.now() - ts) / 1000)
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.round(s / 60)} min ago`
  if (s < 86400) return `${Math.round(s / 3600)} h ago`
  return new Date(ts).toLocaleDateString()
}

// ---------- Live state ----------

const live = { statuses: {}, qrs: {}, logs: {}, onlineRunners: new Set(), listeners: new Set() }
const notify = event => { for (const fn of live.listeners) fn(event) }

function connectLive(attempt = 0) {
  const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/live`)
  ws.onopen = () => { attempt = 0; $('#live-dot').className = 'dot on' }
  ws.onmessage = e => {
    const msg = JSON.parse(e.data)
    if (msg.type === 'snapshot') {
      live.statuses = msg.live
      live.qrs = msg.qrs
      live.logs = msg.logs
      live.onlineRunners = new Set(msg.onlineRunners)
    } else if (msg.type === 'status') {
      const { type, numberId, ...s } = msg
      live.statuses[numberId] = s
    } else if (msg.type === 'qr') {
      if (msg.svg) live.qrs[msg.numberId] = msg.svg
      else delete live.qrs[msg.numberId]
    } else if (msg.type === 'log') {
      const lines = (live.logs[msg.numberId] ??= [])
      lines.push({ stream: msg.stream, line: msg.line, at: msg.at })
      if (lines.length > 500) lines.splice(0, lines.length - 500)
    } else if (msg.type === 'runner') {
      if (msg.online) live.onlineRunners.add(msg.runnerId)
      else live.onlineRunners.delete(msg.runnerId)
    } else if (msg.type === 'cleared') {
      delete live.statuses[msg.numberId]
      delete live.qrs[msg.numberId]
      delete live.logs[msg.numberId]
    }
    notify(msg)
  }
  ws.onclose = e => {
    $('#live-dot').className = 'dot off'
    if (e.code === 4401 || e.code === 4403) { location.href = '/login'; return }
    setTimeout(() => connectLive(attempt + 1), Math.min(30_000, 1000 * 2 ** attempt))
  }
}

// ---------- Status display ----------

const STATES = {
  connected: ['Connected', 'ok'],
  waiting_for_scan: ['Waiting for QR scan', 'warn'],
  starting: ['Starting', 'info'],
  connecting: ['Connecting', 'info'],
  reconnecting: ['Reconnecting', 'warn'],
  logged_out: ['Logged out', 'bad'],
  crashed: ['Crashed', 'bad'],
  error: ['Config error', 'bad'],
  stopped: ['Stopped', 'muted'],
}

function statusOf(number) {
  if (!number.runnerId) return { label: 'No runner', tone: 'muted' }
  if (!live.onlineRunners.has(number.runnerId)) return { label: 'Runner offline', tone: 'bad' }
  if (!number.enabled) return { label: 'Disabled', tone: 'muted' }
  const s = live.statuses[number.id]
  if (!s) return { label: 'Waiting for runner', tone: 'muted' }
  const [label, tone] = STATES[s.state] || [s.state, 'muted']
  return { label, tone, detail: s.detail }
}

const pill = ({ label, tone }) => h('span', { class: `pill ${tone}` }, label)

// ---------- Views ----------

let cleanup = () => {}
function onLive(fn) {
  live.listeners.add(fn)
  const prev = cleanup
  cleanup = () => { prev(); live.listeners.delete(fn) }
}

async function viewNumbers(root) {
  const [numbers, runners] = await Promise.all([api('GET', '/numbers'), api('GET', '/runners')])
  const runnerName = Object.fromEntries(runners.map(r => [r.id, r.name]))
  const grid = h('div', { class: 'grid' })

  const render = () => {
    fill(grid, ...numbers.map(n => {
      const s = live.statuses[n.id] || {}
      const st = statusOf(n)
      return h('a', { class: 'card number', href: `#/numbers/${n.id}` },
        h('div', { class: 'row between' }, h('strong', {}, n.name), pill(st)),
        h('div', { class: 'muted' }, s.phone ? `+${s.phone}${s.pushName ? ` · ${s.pushName}` : ''}` : 'Not linked yet'),
        h('div', { class: 'meta' },
          h('span', {}, `Runner: ${runnerName[n.runnerId] || 'none'}`),
          h('span', {}, `Last message: ${ago(s.lastMessageAt)}`)),
        live.qrs[n.id] && h('div', { class: 'hint' }, 'QR code ready: open to link this number'))
    }))
    if (!numbers.length) fill(grid, h('p', { class: 'muted' }, 'No numbers yet. Add a runner first, then add a number.'))
  }
  render()
  onLive(render)

  fill(root, 
    h('div', { class: 'row between' }, h('h1', {}, 'Numbers'), h('a', { class: 'button primary', href: '#/numbers/new' }, 'Add number')),
    grid)
}

const listText = arr => (arr || []).join('\n')
const parseList = text => text.split(/[\s,]+/).map(s => s.trim()).filter(Boolean)

function field(label, input, help) {
  return h('label', { class: 'field' }, h('span', {}, label), input, help && h('small', { class: 'muted' }, help))
}

function routeRow(r = {}, onRemove) {
  const row = h('div', { class: 'route' },
    field('Group ID or phone', h('input', { name: 'r_key', value: r.key || '', placeholder: '1203…@g.us or 6281…', required: true })),
    field('Label', h('input', { name: 'r_name', value: r.name || '' })),
    field('Agent ID', h('input', { name: 'r_agentId', value: r.agentId || '', required: true })),
    field('Answer', h('select', { name: 'r_trigger' },
      h('option', { value: 'mention', selected: r.trigger !== 'all' }, 'When @mentioned'),
      h('option', { value: 'all', selected: r.trigger === 'all' }, 'Every message'))),
    field('Allowed members', h('textarea', { name: 'r_allowedNumbers', rows: 2, placeholder: 'Anyone in the group' }, listText(r.allowedNumbers))),
    field('Archestra URL', h('input', { name: 'r_url', value: r.url || '', placeholder: 'Same as the number' })),
    field('Token env var', h('input', { name: 'r_tokenRef', value: r.tokenRef || '', placeholder: 'Same as the number' })),
    h('button', { type: 'button', class: 'link danger', onclick: () => { row.remove(); onRemove?.() } }, 'Remove'))
  return row
}

function readRoute(row) {
  const v = name => row.querySelector(`[name=r_${name}]`).value.trim()
  const allowed = parseList(v('allowedNumbers'))
  return { key: v('key'), name: v('name') || null, agentId: v('agentId'), trigger: v('trigger'), allowedNumbers: allowed.length ? allowed : null, url: v('url') || null, tokenRef: v('tokenRef') || null }
}

async function viewNumber(root, id) {
  const isNew = id === 'new'
  const [runners, number] = await Promise.all([api('GET', '/runners'), isNew ? null : api('GET', `/numbers/${id}`)])
  const n = number || { name: '', runnerId: runners[0]?.id ?? null, enabled: true, agentId: '', allowedNumbers: [], routes: [], mediaTypes: null }

  // --- Live status, QR, pairing code, actions ---
  const statusBox = h('section', { class: 'card' })
  const logBox = h('pre', { class: 'logs' })
  let pairingResult = h('div')

  async function action(name, body, confirmText) {
    if (confirmText && !confirm(confirmText)) return null
    try {
      const { result } = await api('POST', `/numbers/${id}/actions/${name}`, body)
      return result
    } catch (e) { fail(e); return null }
  }

  const renderStatus = () => {
    if (isNew) return fill(statusBox, h('p', { class: 'muted' }, 'Save the number, then link it to WhatsApp here.'))
    const st = statusOf(n)
    const s = live.statuses[id] || {}
    const qr = live.qrs[id]
    const phoneInput = h('input', { placeholder: 'Phone with country code, e.g. 6281234567890', inputmode: 'numeric' })
    fill(statusBox, 
      h('div', { class: 'row between' }, h('h2', {}, 'Status'), pill(st)),
      st.detail && h('p', { class: 'muted' }, st.detail),
      s.phone && h('p', {}, `Linked to +${s.phone}${s.pushName ? ` (${s.pushName})` : ''}`),
      h('p', { class: 'muted' }, `Last message ${ago(s.lastMessageAt)}${s.messageCount ? ` · ${s.messageCount} handled since the dashboard started tracking` : ''}`),
      qr && h('div', { class: 'qr' },
        h('img', { src: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(qr)}`, alt: 'WhatsApp pairing QR code' }),
        h('div', {},
          h('p', {}, 'On the phone: WhatsApp → Linked devices → Link a device, then scan this code. It refreshes every few seconds.'),
          h('p', { class: 'muted' }, 'Or link with a code instead:'),
          h('div', { class: 'row' }, phoneInput, h('button', { onclick: async () => {
            const r = await action('pairingCode', { phone: phoneInput.value })
            if (r?.code) fill(pairingResult, h('p', {}, 'Enter this code on the phone (Link with phone number instead): ', h('code', { class: 'big' }, r.code)))
          } }, 'Get pairing code')),
          pairingResult)),
      h('div', { class: 'row actions' },
        h('button', { onclick: async () => { if (await action('restart')) toast('Restarting') } }, 'Restart'),
        h('button', { onclick: async () => { if (await action('unlink', null, 'Log this number out of WhatsApp and show a new QR code?')) toast('Session removed, waiting for a new QR code') } }, 'Re-pair')),
    )
  }

  const renderLogs = () => {
    const lines = live.logs[id] || []
    logBox.textContent = lines.map(l => `${new Date(l.at).toLocaleTimeString()} ${l.line}`).join('\n') || 'No log lines yet.'
    logBox.scrollTop = logBox.scrollHeight
  }

  // --- Settings form ---
  const media = new Set(n.mediaTypes || ['image', 'document'])
  const routesBox = h('div', { class: 'routes' }, ...(n.routes || []).map(r => routeRow(r)))
  const groupsBox = h('div', { class: 'groups' })
  const form = h('form', { class: 'card stack' },
    h('h2', {}, isNew ? 'New number' : 'Settings'),
    field('Name', h('input', { name: 'name', value: n.name, required: true, placeholder: 'Support line' })),
    field('Runner', h('select', { name: 'runnerId' },
      h('option', { value: '' }, 'None (not running)'),
      runners.map(r => h('option', { value: r.id, selected: r.id === n.runnerId }, `${r.name}${r.online ? '' : ' (offline)'}`))),
      'Moving a number to another runner starts a fresh session there; it has to be linked again.'),
    h('label', { class: 'check' }, h('input', { type: 'checkbox', name: 'enabled', checked: n.enabled }), 'Enabled'),
    h('h3', {}, 'Default agent'),
    field('Agent ID', h('input', { name: 'agentId', value: n.agentId, required: true }), 'Archestra → Agent Triggers → Webhook / A2A shows it. Used for direct chats without a route.'),
    field('Archestra URL', h('input', { name: 'archestraUrl', value: n.archestraUrl || '', placeholder: "Runner's ARCHESTRA_URL" })),
    field('Token env var', h('input', { name: 'tokenRef', value: n.tokenRef || '', placeholder: 'ARCHESTRA_TOKEN' }),
      'Name of the env var on the runner that holds the Archestra token. Tokens never leave the runner.'),
    field('Allowed phone numbers (direct chats)', h('textarea', { name: 'allowedNumbers', rows: 3, placeholder: 'One per line, country code, no +. Empty allows anyone.' }, listText(n.allowedNumbers))),
    h('h3', {}, 'Attachments'),
    h('div', { class: 'row wrap' }, ['image', 'document', 'audio', 'video', 'sticker'].map(k =>
      h('label', { class: 'check' }, h('input', { type: 'checkbox', name: 'media', value: k, checked: media.has(k) }), k))),
    h('div', { class: 'row wrap' },
      field('Max size (MB)', h('input', { name: 'maxMediaMb', type: 'number', min: 1, max: 100, value: n.maxMediaMb ?? '', placeholder: '10' })),
      field('Send files as', h('select', { name: 'mediaInline' },
        ['', 'auto', 'always', 'never'].map(v => h('option', { value: v, selected: (n.mediaInline || '') === v }, v || 'default (auto)')))),
      field('Agent timeout (ms)', h('input', { name: 'agentTimeoutMs', type: 'number', min: 1000, value: n.agentTimeoutMs ?? '', placeholder: '300000' }))),
    h('h3', {}, 'Routes'),
    h('p', { class: 'muted' }, 'Send a group (or a specific phone number) to its own agent. Groups without a route are ignored.'),
    routesBox,
    h('div', { class: 'row' },
      h('button', { type: 'button', onclick: () => routesBox.append(routeRow()) }, 'Add route'),
      !isNew && h('button', { type: 'button', onclick: async () => {
        const groups = await action('groups')
        if (!groups) return
        const taken = new Set([...routesBox.querySelectorAll('[name=r_key]')].map(i => i.value))
        fill(groupsBox, h('h4', {}, `Groups this number is in (${groups.length})`),
          ...groups.map(g => h('div', { class: 'row between group' },
            h('span', {}, g.subject || g.jid, h('small', { class: 'muted' }, ` ${g.size ?? '?'} members`)),
            taken.has(g.jid) ? h('small', { class: 'muted' }, 'routed') :
              h('button', { type: 'button', onclick: e => { routesBox.append(routeRow({ key: g.jid, name: g.subject })); e.target.replaceWith(h('small', { class: 'muted' }, 'added')) } }, 'Add'))))
      } }, 'Pick from groups')),
    groupsBox,
    h('div', { class: 'row actions' },
      h('button', { class: 'primary', type: 'submit' }, isNew ? 'Create' : 'Save'),
      !isNew && h('button', { type: 'button', class: 'danger', onclick: async () => {
        if (!confirm(`Delete "${n.name}"? It will be logged out of WhatsApp and its session removed.`)) return
        try {
          const r = await api('DELETE', `/numbers/${id}`)
          toast(r.unlinked ? 'Number deleted and logged out' : 'Number deleted (its runner was offline; unlink the device from the phone)')
          location.hash = '#/'
        } catch (e) { fail(e) }
      } }, 'Delete')))

  form.addEventListener('submit', async e => {
    e.preventDefault()
    const f = form.elements
    const num = name => f[name].value === '' ? null : Number(f[name].value)
    const body = {
      name: f.name.value, runnerId: f.runnerId.value || null, enabled: f.enabled.checked,
      agentId: f.agentId.value, archestraUrl: f.archestraUrl.value || null, tokenRef: f.tokenRef.value || null,
      allowedNumbers: parseList(f.allowedNumbers.value),
      mediaTypes: [...form.querySelectorAll('[name=media]:checked')].map(i => i.value),
      maxMediaMb: num('maxMediaMb'), mediaInline: f.mediaInline.value || null, agentTimeoutMs: num('agentTimeoutMs'),
      routes: [...routesBox.querySelectorAll('.route')].map(readRoute),
    }
    try {
      const saved = await api(isNew ? 'POST' : 'PUT', isNew ? '/numbers' : `/numbers/${id}`, body)
      toast(isNew ? 'Number created' : 'Saved. The runner restarts it with the new settings.')
      if (isNew) location.hash = `#/numbers/${saved.id}`
      else Object.assign(n, saved)
    } catch (err) { fail(err) }
  })

  renderStatus()
  renderLogs()
  onLive(msg => {
    if (msg.type === 'log' && msg.numberId === id) return renderLogs()
    if (msg.type === 'snapshot' || msg.numberId === id || msg.type === 'runner') { renderStatus(); renderLogs() }
  })

  fill(root, 
    h('a', { href: '#/', class: 'back' }, '← Numbers'),
    h('h1', {}, isNew ? 'Add number' : n.name),
    h('div', { class: 'columns' },
      h('div', { class: 'stack' }, statusBox, !isNew && h('section', { class: 'card' }, h('h2', {}, 'Logs'), logBox)),
      form))
}

function tokenNotice(token) {
  const url = location.origin
  return h('div', { class: 'card notice' },
    h('h3', {}, 'Runner token (shown once)'),
    h('p', {}, 'Copy it now. Only a hash is stored, so it can\'t be shown again.'),
    h('code', { class: 'block' }, token),
    h('p', { class: 'muted' }, 'Docker:'),
    h('code', { class: 'block' }, `docker run -d --name wa-runner --restart unless-stopped -v wa-runner:/data -e DASHBOARD_URL=${url} -e RUNNER_TOKEN=${token} -e ARCHESTRA_URL=https://archestra.example.com -e ARCHESTRA_TOKEN=… ghcr.io/pushm0v/baileys-archestra-a2a node src/runner.mjs`),
    h('p', { class: 'muted' }, 'Helm:'),
    h('code', { class: 'block' }, `helm upgrade --install wa-runner charts/baileys-archestra-a2a --set mode=runner --set runner.dashboardUrl=${url} --set runner.token=${token} --set archestra.url=https://archestra.example.com --set archestra.token=…`))
}

async function viewRunners(root) {
  const list = h('div', { class: 'stack' })
  const notice = h('div')
  const render = async () => {
    const runners = await api('GET', '/runners')
    fill(list, ...runners.map(r => h('div', { class: 'card row between' },
      h('div', {},
        h('strong', {}, r.name), ' ',
        pill(live.onlineRunners.has(r.id) ? { label: 'Online', tone: 'ok' } : { label: 'Offline', tone: 'bad' }),
        h('div', { class: 'muted' }, `${r.numbers} number(s) · last seen ${ago(r.lastSeenAt)}`)),
      h('div', { class: 'row' },
        h('button', { onclick: async () => {
          if (!confirm(`Issue a new token for "${r.name}"? The runner disconnects until it is restarted with the new token.`)) return
          try { const { token } = await api('POST', `/runners/${r.id}/rotate`); fill(notice, tokenNotice(token)); render() } catch (e) { fail(e) }
        } }, 'New token'),
        h('button', { class: 'danger', onclick: async () => {
          if (!confirm(`Remove runner "${r.name}"?`)) return
          try { await api('DELETE', `/runners/${r.id}`); render() } catch (e) { fail(e) }
        } }, 'Remove')))))
    if (!runners.length) fill(list, h('p', { class: 'muted' }, 'No runners yet. Add one, then start it on your server with the token it gives you.'))
  }
  const name = h('input', { placeholder: 'e.g. k8s-prod', required: true })
  const form = h('form', { class: 'row' }, name, h('button', { class: 'primary' }, 'Add runner'))
  form.addEventListener('submit', async e => {
    e.preventDefault()
    try {
      const r = await api('POST', '/runners', { name: name.value })
      name.value = ''
      fill(notice, tokenNotice(r.token))
      render()
    } catch (err) { fail(err) }
  })
  onLive(msg => { if (msg.type === 'runner' || msg.type === 'snapshot') render() })
  fill(root, h('h1', {}, 'Runners'),
    h('p', { class: 'muted' }, 'A runner is a server that runs the WhatsApp sessions. It connects out to this dashboard, so it needs no open ports. Archestra tokens stay on the runner as env vars.'),
    form, notice, list)
  await render()
}

async function viewAdmins(root) {
  const list = h('div', { class: 'stack' })
  const render = async () => {
    const users = await api('GET', '/users')
    fill(list, ...users.map(u => h('div', { class: 'card row between' },
      h('div', {}, h('strong', {}, u.email),
        h('div', { class: 'muted' }, u.source === 'config' ? 'Default admin (ADMIN_EMAILS in wrangler.jsonc)' : `Added by ${u.addedBy} · ${ago(u.createdAt)}`)),
      u.source === 'dashboard' && h('button', { class: 'danger', onclick: async () => {
        if (!confirm(`Remove ${u.email}?`)) return
        try { await api('DELETE', `/users/${encodeURIComponent(u.email)}`); render() } catch (e) { fail(e) }
      } }, 'Remove'))))
  }
  const email = h('input', { type: 'email', placeholder: 'name@gmail.com', required: true })
  const form = h('form', { class: 'row' }, email, h('button', { class: 'primary' }, 'Add admin'))
  form.addEventListener('submit', async e => {
    e.preventDefault()
    try { await api('POST', '/users', { email: email.value }); email.value = ''; render() } catch (err) { fail(err) }
  })
  fill(root, h('h1', {}, 'Admins'),
    h('p', { class: 'muted' }, 'Admins sign in with Google and have full access. Default admins come from ADMIN_EMAILS and can only be changed there.'),
    form, list)
  await render()
}

async function viewActivity(root) {
  const rows = await api('GET', '/audit?limit=200')
  fill(root, h('h1', {}, 'Activity'),
    h('table', {},
      h('thead', {}, h('tr', {}, h('th', {}, 'When'), h('th', {}, 'Who'), h('th', {}, 'What'), h('th', {}, 'Target'), h('th', {}, 'Details'))),
      h('tbody', {}, rows.map(r => h('tr', {},
        h('td', { title: new Date(r.at).toLocaleString() }, ago(r.at)), h('td', {}, r.email), h('td', {}, r.action),
        h('td', { class: 'mono' }, r.target || ''), h('td', { class: 'mono' }, r.detail ? JSON.stringify(r.detail) : ''))))))
}

// ---------- Router ----------

async function route() {
  cleanup()
  cleanup = () => {}
  const root = $('#view')
  const hash = location.hash.replace(/^#/, '') || '/'
  const [, section, id] = hash.split('/')
  for (const a of document.querySelectorAll('[data-nav]')) a.classList.toggle('active', a.dataset.nav === (section || 'numbers'))
  try {
    if (section === 'numbers' && id) await viewNumber(root, id)
    else if (section === 'runners') await viewRunners(root)
    else if (section === 'admins') await viewAdmins(root)
    else if (section === 'activity') await viewActivity(root)
    else await viewNumbers(root)
  } catch (e) {
    fill(root, h('p', { class: 'error' }, e.message))
  }
}

window.addEventListener('hashchange', route)
api('GET', '/me').then(me => {
  $('#me').textContent = me.email
  connectLive()
  route()
})

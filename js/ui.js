// User interface. Plain DOM, re-rendered from state after every change.
(function (OMM) {
  'use strict';

  const { hidpp, device, actions: A } = OMM;
  const VERSION = '0.1.0';
  const HID_FILTERS = [
    { vendorId: 0x046d, usagePage: 0xff00 },
    { vendorId: 0x046d, usagePage: 0xff43 },
  ];
  const HOST_MODE_URL = 'https://support.logi.com/hc/articles/360057433714';

  const state = {
    devices: [], // { transport, hid, channel, mouse, status, label, error }
    selected: null,
    profile: null,
    gshift: false,
    busy: false,
    recording: null,
    identifyHit: -1,
  };

  let openCombo = null;
  let pendingRender = false;
  let rendering = false;

  // Lucide icon names (https://lucide.dev/icons) with optional attribute overrides
  const ICONS = {
    logo: ['Mouse'],
    chevron: ['ChevronDown', { class: 'chev', 'stroke-width': 3 }],
    gear: ['Settings'],
    battery: ['BatteryFull'],
    charging: ['BatteryCharging'],
    wireless: ['Wifi'],
    usb: ['Usb'],
    restore: ['RotateCcw'],
    info: ['Info'],
    warning: ['TriangleAlert'],
    eye: ['Eye'],
    eyeOff: ['EyeOff'],
    dots: ['EllipsisVertical'],
    diamond: ['Diamond', { fill: '#fff', stroke: 'none' }],
    shift: ['Move', { style: 'color:#ff6600' }],
    link: ['Link'],
    unlink: ['Unlink'],
    spinner: ['LoaderCircle', { class: 'big spin' }],
    question: ['CircleQuestionMark', { class: 'big' }],
    gshift: ['ArrowBigUp'],
  };

  function h(tag, props, ...kids) {
    const el = document.createElement(tag);
    for (const k in props || {}) {
      const v = props[k];
      if (v === false || v === null || v === undefined) continue;
      if (k === 'class') el.className = v;
      else if (k === 'html') el.innerHTML = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v === true ? '' : v);
    }
    for (const kid of kids.flat()) {
      if (kid !== null && kid !== undefined && kid !== false) el.append(kid);
    }
    return el;
  }

  // Returns null if Lucide failed to load, so the UI still renders without icons
  function icon(name) {
    const lib = window.lucide;
    const [id, attrs] = ICONS[name];
    if (!lib || !lib.icons[id]) return null;
    const el = lib.createElement(lib.icons[id], attrs);
    // Size comes from the stylesheet
    el.removeAttribute('width');
    el.removeAttribute('height');
    return el;
  }

  const $ = (id) => document.getElementById(id);
  const mouseOf = () => (state.selected && state.selected.status === 'ready' ? state.selected.mouse : null);

  // Dropdown. items: { value, label, color, dim, disabled, separator, extra }
  function combo(o) {
    const root = h('div', { class: 'combo ' + (o.class || '') });
    const current = o.items.find((i) => !i.separator && i.value === o.value);
    const label = h('span', { class: 'combo-label' }, o.label || (current ? current.label : o.placeholder || ''));
    if (o.color || (current && current.color)) label.style.color = o.color || current.color;
    const btn = h('button', { class: 'combo-btn', type: 'button', disabled: !!o.disabled, 'aria-haspopup': 'listbox', 'aria-label': o.aria, title: o.title },
      o.button || [label, icon('chevron')]);
    const list = h('div', { class: 'combo-list' + (o.right ? ' right' : ''), role: 'listbox', hidden: true });

    const close = () => {
      if (openCombo !== api) return;
      openCombo = null;
      list.hidden = true;
      root.classList.remove('open');
    };
    const api = { close, root };
    const open = () => {
      if (openCombo) openCombo.close();
      openCombo = api;
      list.hidden = false;
      list.classList.remove('up');
      root.classList.add('open');
      const bounds = $('app').getBoundingClientRect();
      const r = list.getBoundingClientRect();
      if (r.bottom > bounds.bottom - 4 && r.height < root.getBoundingClientRect().top - bounds.top) list.classList.add('up');
      const sel = list.querySelector('.selected');
      if (sel) sel.scrollIntoView({ block: 'nearest' });
    };

    for (const item of o.items) {
      if (item.separator) {
        list.append(h('div', { class: 'combo-sep' }));
        continue;
      }
      const row = h('button', {
        class: 'combo-item' + (item.value === o.value ? ' selected' : '') + (item.dim ? ' dim' : ''),
        type: 'button', role: 'option', disabled: !!item.disabled,
        onclick: () => {
          close();
          o.onSelect(item);
        },
      }, h('span', null, item.label), item.extra);
      if (item.color) row.style.color = item.color;
      list.append(row);
    }
    btn.addEventListener('click', () => (openCombo === api ? closeCombo() : open()));
    root.append(btn, list);
    return root;
  }

  function closeCombo() {
    if (openCombo) openCombo.close();
    if (pendingRender) render();
  }

  document.addEventListener('mousedown', (e) => {
    if (openCombo && !openCombo.root.contains(e.target)) closeCombo();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && openCombo) closeCombo();
  });

  // Modal dialog, resolves with the value of the pressed button
  function dialog(o) {
    return new Promise((resolve) => {
      const overlay = $('overlay');
      const done = (value) => {
        overlay.hidden = true;
        overlay.replaceChildren();
        resolve(value);
      };
      const box = h('div', { class: 'dialog', role: 'dialog', 'aria-modal': 'true' },
        h('h3', null, o.title),
        (o.body || []).map((b) => (typeof b === 'string' ? h('p', null, b) : b)),
        h('div', { class: 'dialog-actions' }, o.buttons.map((b) => h('button', {
          class: 'btn ' + (b.primary ? 'btn-primary' : 'btn-tertiary'), type: 'button', onclick: () => done(b.value),
        }, b.label))));
      overlay.replaceChildren(box);
      overlay.hidden = false;
      const first = box.querySelector('.btn-primary') || box.querySelector('button');
      if (first) first.focus();
    });
  }

  function showError(e) {
    console.error(e);
    return dialog({
      title: 'Error',
      body: [e && e.message ? e.message : String(e)],
      buttons: [{ label: 'Dismiss', primary: true }],
    });
  }

  // Runs a device operation with the interface locked, like the original does while writing
  async function run(fn) {
    if (state.busy) return;
    state.busy = true;
    render(true);
    try {
      await fn();
    } catch (e) {
      await showError(e);
    } finally {
      state.busy = false;
      render(true);
    }
  }

  // ---- Device management ----

  async function addTransport(transport, hid) {
    if (hid && state.devices.some((d) => d.hid === hid)) return;
    // Profile access needs long reports, skip interfaces that only carry short ones
    if (!transport.hasLong) return;
    const entry = { transport, hid, channel: null, mouse: null, status: 'probing', label: transport.name, error: '' };
    state.devices.push(entry);
    if (!state.selected) state.selected = entry;
    render();
    try {
      await transport.open();
    } catch (e) {
      entry.status = 'error';
      entry.error = e.message || 'Could not open the device';
      render();
      return;
    }
    entry.channel = new hidpp.Channel(transport);
    await probe(entry);
  }

  async function removeHid(hid) {
    const entry = state.devices.find((d) => d.hid === hid);
    if (!entry) return;
    state.devices.splice(state.devices.indexOf(entry), 1);
    if (state.selected === entry) {
      state.selected = state.devices[0] || null;
      selectDefaultProfile();
    }
    try {
      await entry.transport.close();
    } catch (e) {
      // already gone
    }
    render(true);
  }

  // Find the mouse: directly on the cable (index 0xFF) or behind a receiver (index 1, 2)
  async function probe(entry) {
    if (entry.probing) return;
    entry.probing = true;
    const before = entry.status;
    try {
      let dev = null;
      for (const index of [0xff, 1, 2]) {
        const candidate = new hidpp.Device(entry.channel, index);
        try {
          if ((await candidate.ping(800)).major >= 2) {
            dev = candidate;
            break;
          }
        } catch (e) {
          // not here
        }
        candidate.dispose();
      }
      if (!dev) {
        entry.status = 'offline';
        return;
      }
      entry.status = 'loading';
      render();
      const mouse = new device.Mouse(dev, { wired: dev.index === 0xff });
      mouse.onchange = () => onMouseChanged(entry);
      try {
        await mouse.init();
        entry.mouse = mouse;
        entry.label = mouse.name;
        entry.status = 'ready';
        entry.error = '';
        if (state.selected === entry) selectDefaultProfile();
      } catch (e) {
        dev.dispose();
        console.warn('Device init failed', e);
        entry.error = e.message || '';
        entry.status = e instanceof device.UnsupportedError ? 'unsupported' : 'offline';
      }
    } finally {
      entry.probing = false;
      if (entry.status !== before) render();
    }
  }

  function selectDefaultProfile() {
    const m = mouseOf();
    state.profile = m ? m.activeProfile || m.profiles[0] : null;
    state.gshift = false;
  }

  function onMouseChanged(entry) {
    if (entry !== state.selected || !entry.mouse) return;
    const m = entry.mouse;
    if (m.activeProfile && m.activeProfile !== state.profile && !state.busy) state.profile = m.activeProfile;
    render();
  }

  // Host mode poll, also notices a mouse that went to sleep or came back
  async function tick() {
    if (state.busy || document.hidden) return;
    for (const e of state.devices) {
      if (e.probing || !e.channel) continue;
      if (e.status === 'ready') {
        try {
          if (await e.mouse.poll()) onMouseChanged(e);
        } catch (err) {
          e.status = 'offline';
          render();
        }
      } else if (e.status === 'offline') {
        if (e.mouse) {
          try {
            await e.mouse.dev.ping(800);
            await e.mouse.refreshState();
            e.status = 'ready';
            render();
          } catch (err) {
            // still away
          }
        } else {
          await probe(e);
        }
      }
    }
  }

  async function connect() {
    try {
      const picked = await navigator.hid.requestDevice({ filters: HID_FILTERS });
      for (const hid of picked) {
        const before = state.devices.length;
        await addTransport(new hidpp.WebHidTransport(hid), hid);
        if (state.devices.length > before) state.selected = state.devices[state.devices.length - 1];
      }
      selectDefaultProfile();
      render(true);
    } catch (e) {
      showError(e);
    }
  }

  // ---- Rendering ----

  function isEditing() {
    const a = document.activeElement;
    return !!a && a.classList && a.classList.contains('dpi-input');
  }

  function render(force) {
    if (!force && (isEditing() || openCombo || state.recording)) {
      pendingRender = true;
      return;
    }
    if (rendering) return;
    rendering = true;
    try {
      pendingRender = false;
      if (openCombo) openCombo.close();
      renderTop();
      renderContent();
      renderHostBar();
    } finally {
      rendering = false;
    }
  }

  function renderTop() {
    const entry = state.selected;
    const m = mouseOf();
    const p = state.profile;
    const locked = state.busy;
    const loading = state.devices.some((d) => d.status === 'loading' || d.status === 'probing') || state.busy;

    const logo = h('span', { class: 'logo' + (loading ? ' spin' : ''), title: 'OMM Web' }, icon('logo'));

    const deviceItems = state.devices.map((d) => ({ value: d, label: d.label }));
    if (deviceItems.length) deviceItems.push({ separator: true });
    deviceItems.push({ value: 'add', label: 'Add device...', color: 'var(--primary)', disabled: !navigator.hid });
    const deviceCombo = combo({
      items: deviceItems, value: entry, placeholder: 'No device', disabled: locked, aria: 'Device',
      onSelect: (item) => {
        if (item.value === 'add') {
          connect();
          return;
        }
        state.selected = item.value;
        selectDefaultProfile();
        render(true);
      },
    });
    deviceCombo.style.width = '236px';

    const row = [logo, deviceCombo];
    if (m && p) {
      const multi = m.profiles.length !== 1;
      const profileItems = m.profiles.map((pr) => {
        const eye = multi ? h('span', {
          class: 'eye', role: 'button', tabindex: '0', title: pr.enabled ? 'Disable profile' : 'Enable profile',
          onclick: (e) => {
            e.stopPropagation();
            run(() => m.toggleEnabled(pr));
          },
        }, icon(pr.enabled ? 'eye' : 'eyeOff')) : null;
        return { value: pr, label: pr.title + (pr.dirty ? ' *' : ''), dim: !pr.enabled, extra: eye };
      });
      const profileCombo = combo({
        items: profileItems, value: p, disabled: locked, aria: 'Profile',
        onSelect: (item) => {
          state.profile = item.value;
          state.gshift = false;
          if (!m.hostMode && m.activeProfile !== item.value && item.value.enabled) {
            run(() => m.activateProfile(item.value));
          } else {
            render(true);
          }
        },
      });
      profileCombo.style.width = '236px';
      row.push(profileCombo);
    }
    row.push(h('span', { class: 'spacer' }));
    if (m && p) {
      const dirty = m.profiles.filter((x) => x.dirty);
      row.push(
        h('button', { class: 'btn btn-tertiary', type: 'button', disabled: locked || !p.dirty, onclick: revert }, 'Revert'),
        h('button', { class: 'btn btn-primary', type: 'button', disabled: locked || !dirty.length, onclick: save },
          dirty.length > 1 ? 'Save ' + dirty.length + ' Profiles' : 'Save'));
    }
    row.push(h('button', { class: 'icon-btn', type: 'button', title: 'Settings', 'aria-label': 'Settings', onclick: settings }, icon('gear')));
    $('top-row').replaceChildren(...row);

    const status = [];
    if (m && p) {
      const b = m.battery;
      status.push(h('span', { class: 'battery' },
        b ? h('span', { title: 'Battery is at ' + b.percent + '%, ' + (b.charging ? 'charging' : 'discharging') + '.' }, b.percent + '%') : null,
        b ? icon(b.charging ? 'charging' : 'battery') : null,
        h('span', { class: 'dim', title: m.wired ? 'USB' : 'Wireless receiver' }, icon(m.wired ? 'usb' : 'wireless'))));
      if (m.info.profileCountOob > 0) {
        status.push(h('button', { class: 'btn btn-tertiary', type: 'button', disabled: locked, onclick: restore }, icon('restore'), 'Restore Defaults'));
      }
      if (p.supportsAdvanced) {
        status.push(h('label', { class: 'check' + (locked ? ' disabled' : '') },
          h('input', {
            type: 'checkbox', checked: p.advanced, disabled: locked,
            onchange: (e) => {
              p.setAdvanced(e.target.checked);
              render(true);
            },
          }), 'Advanced'));
      }
    }
    $('status-row').replaceChildren(...status);
  }

  function notice(kind, title, extra) {
    return h('div', { class: 'notice ' + (kind || '') }, extra && extra.icon ? icon(extra.icon) : null, h('h1', null, title), extra ? extra.body : null);
  }

  function renderContent() {
    const content = $('content');
    const entry = state.selected;
    const connectBtn = () => h('button', { class: 'btn btn-primary', type: 'button', onclick: connect }, 'Connect Device');

    if (!navigator.hid && !state.devices.length) {
      content.replaceChildren(notice('idle', 'CONNECT YOUR LOGITECH G GEAR', {
        body: h('p', null, 'This browser does not support WebHID. Use a Chromium based desktop browser such as Chrome, Edge or Opera.'),
      }));
      return;
    }
    if (!entry) {
      content.replaceChildren(notice('idle', 'CONNECT YOUR LOGITECH G GEAR', {
        body: [connectBtn(), h('p', null, 'Pick your mouse or its wireless receiver in the browser dialog. Close G HUB first, it can keep the device busy.')],
      }));
      return;
    }
    if (entry.status === 'probing' || entry.status === 'loading') {
      content.replaceChildren(notice('', 'LOADING INFORMATION', { icon: 'spinner' }));
      return;
    }
    if (entry.status === 'unsupported') {
      content.replaceChildren(notice('', 'UNSUPPORTED DEVICE', { icon: 'question', body: entry.error ? h('p', null, entry.error) : null }));
      return;
    }
    if (entry.status === 'error') {
      content.replaceChildren(notice('', 'DEVICE UNAVAILABLE', {
        icon: 'question', body: h('p', null, entry.error + '. Another program may be using it, close G HUB and reload the page.'),
      }));
      return;
    }
    if (entry.status === 'offline' || !state.profile) {
      content.replaceChildren(notice('idle', 'CONNECT YOUR LOGITECH G GEAR', {
        body: h('p', null, 'Waiting for the mouse. Turn it on or move it to wake it up.' + (entry.error ? ' (' + entry.error + ')' : '')),
      }));
      return;
    }

    const m = entry.mouse;
    const p = state.profile;
    const scroll = content.scrollTop;
    content.replaceChildren(h('div', { class: 'profile' + (state.busy ? ' locked' : '') },
      h('div', { class: 'col-left' }, dpiPanel(m, p), ratePanels(m, p), bhopPanel(p)),
      h('div', { class: 'col-right' }, assignmentsPanel(m, p))));
    content.scrollTop = scroll;
  }

  function renderHostBar() {
    const bar = $('host-bar');
    const m = mouseOf();
    if (!m || !m.hostMode) {
      bar.hidden = true;
      return;
    }
    bar.hidden = false;
    bar.replaceChildren(icon('warning'),
      h('span', null, 'Settings will not take effect until the device is switched to onboard mode.'),
      h('button', { type: 'button', onclick: () => run(() => m.setOnboardMode()) }, 'Switch now'),
      h('a', { href: HOST_MODE_URL, target: '_blank', rel: 'noopener noreferrer' }, 'Learn More'));
  }

  // ---- DPI ----

  function dpiInput(value, o) {
    const el = h('input', { class: 'dpi-input', type: 'text', inputmode: 'numeric', autocomplete: 'off', value: String(value), disabled: !!o.disabled, 'aria-label': o.aria });
    let original = String(value);
    let cancelled = false;
    el.addEventListener('focus', () => {
      original = el.value;
      cancelled = false;
      el.select();
    });
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') el.blur();
      if (e.key === 'Escape') {
        cancelled = true;
        el.blur();
      }
    });
    el.addEventListener('input', () => {
      const n = Number(el.value);
      el.classList.toggle('invalid', !(Number.isInteger(n) && n >= (o.min || 1)));
    });
    el.addEventListener('wheel', (e) => {
      if (document.activeElement !== el) return;
      e.preventDefault();
      const n = parseInt(el.value, 10);
      if (!Number.isFinite(n)) return;
      el.value = String(o.nearest(n + (o.step || 100) * (e.deltaY < 0 ? 1 : -1)));
    }, { passive: false });
    el.addEventListener('blur', () => {
      const n = parseInt(el.value, 10);
      if (!cancelled && el.value.trim() !== original && Number.isFinite(n) && n > 0) o.onCommit(n);
      render(true);
    });
    return el;
  }

  function dpiPanel(m, p) {
    const adv = p.advanced && p.supportsAdvanced;
    const showY = adv && p.supportsDpiY;
    const showLod = adv && p.supportsLod;
    const slots = [];
    for (let n = 1; n <= p.dpis.length; n++) slots.push({ value: n, label: n === 1 ? '1 Slot' : n + ' Slots' });

    const head = h('div', { class: 'dpi-head' },
      combo({
        items: slots, value: p.slotCount, aria: 'DPI slots',
        onSelect: (item) => {
          p.setSlotCount(item.value);
          render(true);
        },
      }),
      h('span', { class: 'sub dpi-cols' },
        h('span', { style: showY ? 'width:124px' : '' }, showY ? 'x-Axis' : 'Speed'),
        showY ? h('span', { style: 'width:96px' }, 'y-Axis') : null,
        showLod ? h('span', null, 'Lift Off Distance') : null));

    const active = m.activeProfile === p && !m.hostMode;
    const rows = p.dpis.map((r) => {
      const current = active && r.enabled && m.currentDpiIndex === r.order && r.value === r.savedValue;
      const menuItems = [
        { value: 'active', label: 'Set As Current DPI', disabled: !active || !r.enabled || p.dirty },
        { value: 'default', label: 'Set As Profile Default', disabled: !r.enabled },
        { value: 'shift', label: 'Assign DPI Shift', disabled: !r.enabled },
        { value: 'reset', label: 'Reset' },
      ];
      const row = h('div', { class: 'dpi-row' + (current ? ' current' : '') + (r.enabled ? '' : ' off') },
        h('span', { class: 'dpi-num' }, String(r.order + 1)),
        h('span', { class: 'dpi-icons' },
          r.enabled && r.isDefault ? h('span', { title: 'Default DPI for profile. Use the menu to change.' }, icon('diamond')) : null,
          r.enabled && r.isShift ? h('span', { title: 'DPI Shift assignment. Use the menu to change.' }, icon('shift')) : null),
        dpiInput(r.value, {
          aria: 'DPI ' + (r.order + 1), disabled: !r.enabled,
          nearest: (n) => device.nearestDpi(m.dpiRanges, n),
          onCommit: (n) => p.setDpiValue(r, n, 'x'),
        }));
      if (showY) {
        row.append(
          h('button', {
            class: 'icon-btn dpi-link' + (r.linked ? ' on' : ''), type: 'button', disabled: !r.enabled,
            title: r.linked ? 'Unlink axes' : 'Link axes', 'aria-pressed': String(r.linked),
            onclick: () => {
              p.setLinked(r, !r.linked);
              render(true);
            },
          }, icon(r.linked ? 'link' : 'unlink')),
          dpiInput(r.yValue, {
            aria: 'DPI y ' + (r.order + 1), disabled: !r.enabled || r.linked,
            nearest: (n) => device.nearestDpi(m.dpiRangesY || m.dpiRanges, n),
            onCommit: (n) => p.setDpiValue(r, n, 'y'),
          }));
      }
      if (showLod) {
        row.append(combo({
          class: 'lod', aria: 'Lift off distance', disabled: !r.enabled, value: r.lod,
          items: [{ value: 1, label: 'Low' }, { value: 2, label: 'Medium' }, { value: 3, label: 'High' }],
          onSelect: (item) => {
            p.setLod(r, item.value);
            render(true);
          },
        }));
      }
      row.append(combo({
        class: 'menu', aria: 'DPI options', button: icon('dots'), items: menuItems, right: true,
        onSelect: (item) => {
          if (item.value === 'active') {
            run(() => m.setCurrentDpi(r.order));
            return;
          }
          if (item.value === 'default') p.setDefault(r);
          if (item.value === 'shift') p.setShift(r);
          if (item.value === 'reset') p.resetDpi(r);
          render(true);
        },
      }));
      return row;
    });

    return h('section', { class: 'panel' },
      h('h2', { title: 'DPI is the speed of your mouse on the screen.' }, 'DPI'), head, rows);
  }

  // ---- Report rate and BHOP ----

  function rateCombo(options, value, onSelect) {
    const items = options.slice();
    if (!items.some((i) => i.value === value)) items.push({ value, label: 'Unknown (' + value + ')', dim: true });
    return combo({ items, value, aria: 'Report rate', onSelect });
  }

  function ratePanels(m, p) {
    const tip = 'Adjust how often the mouse reports information to your computer.';
    const d = p.data;
    if (p.hasExtendedReportRate) {
      const panels = [];
      const add = (title, kind, get, set, limited) => {
        const options = m.reportRateOptions(kind);
        if (!options.length) return;
        panels.push(h('section', { class: 'panel rate' }, h('h2', { title: tip }, title),
          h('div', { class: 'rate-row' },
            rateCombo(options, get(), (item) => {
              set(item.value);
              render(true);
            }),
            limited ? h('span', {
              class: 'tip',
              title: 'Your mouse is currently connected to a receiver that limits its wireless report rate.',
            }, icon('info')) : null)));
      };
      add('Wired', 'wired', () => d.reportRateWired, (v) => { d.reportRateWired = v; }, false);
      add('Wireless', 'wireless', () => d.reportRateWireless, (v) => { d.reportRateWireless = v; }, m.wirelessRateLimited);
      return panels;
    }
    if (!d.has(OMM.profile.C.REPORT_RATE)) return null;
    return h('section', { class: 'panel rate' }, h('h2', { title: tip }, 'Report Rate'),
      rateCombo(m.reportRateOptions(), d.reportRate, (item) => {
        d.reportRate = item.value;
        render(true);
      }));
  }

  function bhopPanel(p) {
    if (!p.supportsBunnyHopping) return null;
    const raw = p.data.bunnyHopping;
    const enabled = raw !== 0 && raw !== 0xff;
    const ms = enabled ? Math.min(1000, Math.max(100, raw * 10)) : p.bhopCache || 100;
    const tip = 'BHOP mode helps prevent unintended jumping if the scroll wheel is accidentally bumped. When enabled, the mouse ignores the first scroll event unless a second one occurs within the time window of 100-1000ms.';
    return h('section', { class: 'panel' }, h('h2', { title: tip }, 'BHOP Mode'),
      h('div', { class: 'bhop' },
        h('label', { class: 'check' }, 'ENABLED',
          h('input', {
            type: 'checkbox', checked: enabled,
            onchange: (e) => {
              if (e.target.checked) {
                p.data.bunnyHopping = Math.round(ms / 10);
              } else {
                p.bhopCache = ms;
                p.data.bunnyHopping = 0;
              }
              render(true);
            },
          })),
        dpiInput(ms, {
          aria: 'BHOP time window in ms', disabled: !enabled, min: 100, step: 100,
          nearest: (n) => Math.min(1000, Math.max(100, Math.round(n / 100) * 100)),
          onCommit: (n) => {
            p.data.bunnyHopping = Math.min(1000, Math.max(100, Math.round(n / 100) * 100)) / 10;
          },
        }),
        h('span', { class: 'sub' }, 'ms')));
  }

  // ---- Assignments ----

  function stopRecording() {
    if (state.recording) {
      state.recording.stop();
      state.recording = null;
    }
  }

  function startRecording(p, index, gshift) {
    stopRecording();
    const finish = (bytes) => {
      stopRecording();
      if (bytes) {
        p.recorded = (p.recorded || []).filter((b) => A.id(b) !== A.id(bytes)).concat([bytes]).slice(-6);
        p.setAssignment(index, gshift, bytes);
      }
      render(true);
    };
    const down = (e) => {
      e.preventDefault();
      e.stopPropagation();
      const bytes = A.fromKeyEvent(e);
      if (bytes) finish(bytes);
    };
    const up = (e) => {
      e.preventDefault();
      const bytes = A.fromModifierCode(e.code);
      if (bytes) finish(bytes);
    };
    const cancel = () => finish(null);
    window.addEventListener('keydown', down, true);
    window.addEventListener('keyup', up, true);
    const timer = setTimeout(() => window.addEventListener('mousedown', cancel, true), 0);
    state.recording = {
      index, gshift,
      stop: () => {
        clearTimeout(timer);
        window.removeEventListener('keydown', down, true);
        window.removeEventListener('keyup', up, true);
        window.removeEventListener('mousedown', cancel, true);
      },
    };
    render(true);
  }

  function assignmentsPanel(m, p) {
    const gshift = state.gshift;
    const multi = m.info.profileCount >= 2;
    const rows = p.assignments(gshift).map((r) => {
      const recording = state.recording && state.recording.index === r.index && state.recording.gshift === gshift;
      const list = A.defaults(gshift).filter((b) => multi || !A.isProfileCycling(b));
      for (const b of (p.recorded || []).concat([r.bytes])) {
        if (!list.some((x) => A.id(x) === A.id(b))) list.splice(list.length - 1, 0, b);
      }
      const items = list.map((b) => ({ value: A.id(b), label: A.title(b), color: A.color(b), bytes: b }));
      items.push({ separator: true }, { value: 'record', label: 'Keystroke + Modifier', color: 'var(--primary)' });
      const c = combo({
        items, value: A.id(r.bytes), disabled: !r.enabled, aria: 'Button ' + r.label,
        label: recording ? '⬤ Recording Keystroke...' : undefined, color: recording ? 'var(--error)' : undefined,
        onSelect: (item) => {
          if (item.value === 'record') {
            startRecording(p, r.index, gshift);
            return;
          }
          p.setAssignment(r.index, gshift, item.bytes);
          render(true);
        },
      });
      return h('div', { class: 'assign-row' + (state.identifyHit === r.index ? ' hit' : '') }, h('span', { class: 'num' }, String(r.label)), c);
    });

    const actions = [];
    if (m.hasButtonSpy) {
      actions.push(h('button', {
        class: 'btn btn-outline' + (m.spying ? ' active' : ''), type: 'button',
        title: 'Use to identify a hardware button on your mouse.', onclick: () => identify(m),
      }, icon('info'), m.spying ? 'Press Button Now' : 'Identify Button'));
    }
    actions.push(h('button', {
      class: 'btn btn-outline' + (gshift ? ' shift-on' : ''), type: 'button', 'aria-pressed': String(gshift),
      title: 'Assign a secondary function accessed when in G-Shift mode.',
      onclick: () => {
        stopRecording();
        state.gshift = !gshift;
        render(true);
      },
    }, icon('gshift'), 'G Shift'));

    return h('section', { class: 'panel' }, h('h2', null, 'Assignments'),
      h('div', { class: 'assign-head sub' }, h('span', null, 'Button'), h('span', null, 'Assignment')),
      rows, h('div', { class: 'assign-actions' }, actions));
  }

  // The spy feature swallows button presses, so it is always stopped after one hit or a timeout
  function identify(m) {
    if (m.spying) {
      m.stopButtonSpy().catch(() => {}).then(() => render(true));
      return;
    }
    const stop = () => m.stopButtonSpy().catch(() => {}).then(() => render(true));
    const timeout = setTimeout(stop, 10000);
    m.startButtonSpy((index) => {
      clearTimeout(timeout);
      state.identifyHit = index;
      stop();
      setTimeout(() => {
        state.identifyHit = -1;
        render();
      }, 2500);
    }).then(() => render(true), (e) => {
      clearTimeout(timeout);
      showError(e);
    });
  }

  // ---- Header actions ----

  function revert() {
    stopRecording();
    if (state.profile && state.profile.dirty) state.profile.reset();
    render(true);
  }

  function save() {
    const m = mouseOf();
    if (!m) return;
    stopRecording();
    run(async () => {
      for (const p of m.profiles) {
        if (!p.dirty) continue;
        if (p.slotCount < 1) throw new Error('At least one DPI value is required to save a profile');
        await m.saveProfile(p);
      }
    });
  }

  async function restore() {
    const m = mouseOf();
    const p = state.profile;
    if (!m || !p) return;
    const ok = await dialog({
      title: 'Are you sure?',
      body: ['All of your saved settings will be lost. This action cannot be undone.'],
      buttons: [{ label: 'Cancel', value: false }, { label: 'Restore Defaults', value: true, primary: true }],
    });
    if (ok) run(() => m.restoreDefaults(p));
  }

  async function settings() {
    const entry = state.selected;
    const body = [
      'Version ' + VERSION,
      'Unofficial browser based configuration tool for the onboard memory of Logitech G mice. Not affiliated with or endorsed by Logitech.',
      'Everything runs locally in this page through WebHID. Nothing is sent anywhere.',
    ];
    const m = mouseOf();
    if (m) {
      body.push(m.name + ': profile format ' + m.info.format + ', ' + m.info.profileCount + ' profile(s), ' + m.info.buttonCount + ' buttons, sector size ' + m.info.sectorSize + '.');
    }
    const buttons = [];
    if (entry && entry.hid && entry.hid.forget) buttons.push({ label: 'Forget Device', value: 'forget' });
    buttons.push({ label: 'Back', value: null, primary: true });
    const choice = await dialog({ title: 'OMM Web', body, buttons });
    if (choice === 'forget') {
      const hid = entry.hid;
      await removeHid(hid);
      try {
        await hid.forget();
      } catch (e) {
        // not supported everywhere
      }
    }
  }

  // ---- Startup ----

  async function start() {
    render(true);
    const demo = new URLSearchParams(location.search).get('demo');
    if (demo !== null) await addTransport(new OMM.mock.MockTransport(Number(demo) || 10), null);
    if (navigator.hid) {
      navigator.hid.addEventListener('connect', (e) => addTransport(new hidpp.WebHidTransport(e.device), e.device));
      navigator.hid.addEventListener('disconnect', (e) => removeHid(e.device));
      for (const hid of await navigator.hid.getDevices()) {
        await addTransport(new hidpp.WebHidTransport(hid), hid);
      }
    }
    selectDefaultProfile();
    render(true);
    setInterval(tick, 3000);
  }

  window.addEventListener('beforeunload', (e) => {
    const m = mouseOf();
    if (m && m.profiles.some((p) => p.dirty)) {
      e.preventDefault();
      e.returnValue = '';
    }
  });

  // Block the browser context menu, but keep it in text fields for copy/paste
  document.addEventListener('contextmenu', (e) => {
    if (!e.target.closest('input, textarea, [contenteditable]')) e.preventDefault();
  });

  start();
})(globalThis.OMM = globalThis.OMM || {});

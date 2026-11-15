// Mouse model: reads and writes onboard profiles through HID++ 2.0 features.
(function (OMM) {
  'use strict';

  const { C, DPI_SLOTS, OnboardProfile, crcValid, parseDirectory, buildDirectory } = OMM.profile;
  const A = OMM.actions;

  const F = {
    DEVICE_INFO: 0x0003, DEVICE_NAME: 0x0005, BATTERY_LEVEL: 0x1000, BATTERY_VOLTAGE: 0x1001,
    UNIFIED_BATTERY: 0x1004, ADJUSTABLE_DPI: 0x2201, EXTENDED_DPI: 0x2202, EXTENDED_REPORT_RATE: 0x8061,
    ONBOARD_PROFILES: 0x8100, MOUSE_BUTTON_SPY: 0x8110,
  };

  const MODE_ONBOARD = 1;
  const MODE_HOST = 2;
  const ROM_SECTOR = 0x0100;

  // Extended report rate value -> Hz
  const REPORT_RATES_EXT = [125, 250, 500, 1000, 2000, 4000, 8000];
  // Legacy report rate, stored as interval in ms
  const REPORT_RATES = [[8, 125], [4, 250], [2, 500], [1, 1000]];

  // Friendly names keyed by the model id reported by feature 0x0003
  const NAME_OVERRIDES = {
    '406cc5390000': 'G603', '407400000000': 'G305', '4079c0880000': 'Pro Wireless', '407fc07d0000': 'G502',
    '407fc08d0000': 'G502', '4086c0900000': 'G703', '4087c0910000': 'G903', '409ec0970000': 'G303 SHROUD',
    '40a9c09b0000': 'PRO X SUPERLIGHT 2', 'b02440850000': 'G604', 'b02e409d0000': 'G705',
    'b03c40b10000': 'G309 LIGHTSPEED', 'c07e00000000': 'G402', 'c07f00000000': 'G302', 'c08000000000': 'G303',
    'c08100000000': 'G900', 'c08200000000': 'G403 Wireless', 'c08300000000': 'G403', 'c08400000000': 'G102 / G203',
    'c08500000000': 'Pro Mouse', 'c08600000000': 'G903 SE', 'c08700000000': 'G703', 'c08b00000000': 'G502 Hero',
    'c08d00000000': 'G502 Wireless', 'c08e00000000': 'MX518', 'c08f00000000': 'G403 Wireless',
    'c09100000000': 'G900', 'c09200000000': 'G102 / G203', 'c33200000000': 'G502 Spectrum',
  };

  class UnsupportedError extends Error {}

  const u16 = (v) => [(v >> 8) & 0xff, v & 0xff];

  // DPI lists are big-endian words: value, optional 0xE000|step, value, ... terminated by 0
  function parseDpiWords(words) {
    const ranges = [];
    let i = 0;
    while (i < words.length && words[i] !== 0) {
      const start = words[i];
      const next = words[i + 1];
      if (next !== undefined && (next & 0xe000) === 0xe000) {
        const end = words[i + 2];
        if (!end) break;
        ranges.push({ start, end, step: next & 0x1fff });
        i += 2;
        if (words[i + 1] === undefined || words[i + 1] === 0 || (words[i + 1] & 0xe000) !== 0xe000) i++;
      } else {
        ranges.push({ start, end: start, step: 1 });
        i++;
      }
    }
    return ranges.filter((r) => r.step > 0);
  }

  function dpiValid(ranges, dpi) {
    if (!ranges || !ranges.length) return true;
    return ranges.some((r) => r.start <= dpi && r.end >= dpi && (dpi - r.start) % r.step === 0);
  }

  function nearestDpi(ranges, dpi) {
    if (!ranges || !ranges.length) return dpi;
    let best = 0;
    let bestDelta = Infinity;
    for (const r of ranges) {
      let v = r.start + Math.round((dpi - r.start) / r.step) * r.step;
      v = Math.min(r.end, Math.max(r.start, v));
      const delta = Math.abs(v - dpi);
      if (delta < bestDelta) {
        bestDelta = delta;
        best = v;
      }
    }
    return best;
  }

  // Editable view of one profile slot
  class ProfileModel {
    constructor(mouse, entry, data) {
      this.mouse = mouse;
      this.entry = entry; // { sector, enabled, flags, extra, virtual, index }
      this.data = data;
      this.saved = data.clone();
      this.oobDefaultLod = 2;
      this.populate();
    }

    get sector() { return this.entry.sector; }
    get index() { return this.entry.index; }
    get enabled() { return this.entry.enabled; }
    get dirty() { return !this.data.equals(this.saved); }

    get title() {
      const name = this.data.name.trim();
      return name && name !== 'PROFILE_NAME_DEFAULT' ? name : 'Profile ' + this.index;
    }

    get supportsAdvanced() {
      const caps = this.mouse.sensorCaps;
      return !!caps && this.data.dpiKind !== 'v1' && (this.supportsDpiY || this.supportsLod);
    }

    get supportsDpiY() {
      return !!this.mouse.sensorCaps && this.mouse.sensorCaps.dpiY && this.data.dpiKind !== 'v1';
    }

    get supportsLod() {
      return !!this.mouse.sensorCaps && this.mouse.sensorCaps.lod && this.data.dpiKind === 'v6';
    }

    get hasExtendedReportRate() {
      return this.mouse.reportRates !== null && this.data.has(C.REPORT_RATE_WIRED) && this.data.has(C.REPORT_RATE_WIRELESS);
    }

    get supportsBunnyHopping() {
      return this.data.has(C.BUNNY_HOPPING);
    }

    // Rebuild the editable DPI rows from the profile bytes
    populate() {
      const d = this.data;
      const advancedKind = d.dpiKind !== 'v1';
      this.dpis = [];
      for (let i = 0; i < DPI_SLOTS; i++) {
        const raw = d.getDpi(i);
        const s = this.saved.getDpi(i);
        this.dpis.push({
          order: i,
          value: raw.x || 800,
          yValue: raw.y || raw.x || 800,
          lod: raw.lod || 2,
          savedValue: s.x || 800,
          savedYValue: s.y || s.x || 800,
          savedLod: s.lod || 2,
          enabled: raw.x > 0,
          linked: !advancedKind || raw.x === raw.y || raw.y === 0,
          isDefault: i === d.dpiDefaultIndex,
          isShift: i === d.dpiShiftIndex,
        });
      }
      this.advanced = this.isAdvancedActive;
    }

    get isAdvancedActive() {
      if (!this.supportsAdvanced) return false;
      return this.dpis.some((r) => r.enabled && (!r.linked || r.yValue !== r.value || (this.supportsLod && r.lod !== this.oobDefaultLod)));
    }

    get slotCount() {
      let n = 0;
      while (n < this.dpis.length && this.dpis[n].enabled) n++;
      return n;
    }

    // Write the DPI rows back into the profile bytes
    commitDpis() {
      const d = this.data;
      const kind = d.dpiKind;
      for (const r of this.dpis) {
        if (r.enabled) {
          d.setDpi(r.order, { x: r.value, y: kind === 'v1' ? 0 : r.yValue, lod: kind === 'v6' ? r.lod : 0 });
        } else {
          d.setDpi(r.order, { x: 0, y: 0, lod: 0 });
        }
        if (r.isShift) d.dpiShiftIndex = r.order;
        if (r.isDefault) d.dpiDefaultIndex = r.order;
      }
    }

    setSlotCount(count) {
      const last = count - 1;
      for (const r of this.dpis) {
        const enabled = r.order <= last;
        if (r.enabled === enabled) continue;
        r.enabled = enabled;
        if (!enabled && r.isShift) this.setShift(this.dpis[last]);
        if (!enabled && r.isDefault) this.setDefault(this.dpis[0]);
      }
      this.commitDpis();
    }

    setDefault(row) {
      for (const r of this.dpis) r.isDefault = r === row;
      this.commitDpis();
    }

    setShift(row) {
      for (const r of this.dpis) r.isShift = r === row;
      this.commitDpis();
    }

    setDpiValue(row, value, axis) {
      const m = this.mouse;
      if (axis === 'y') {
        row.yValue = nearestDpi(m.dpiRangesY || m.dpiRanges, value);
      } else {
        row.value = nearestDpi(m.dpiRanges, value);
        if (row.linked) row.yValue = row.value;
      }
      this.commitDpis();
    }

    setLinked(row, linked) {
      row.linked = linked;
      if (linked) row.yValue = row.value;
      this.commitDpis();
    }

    setLod(row, lod) {
      row.lod = lod;
      this.commitDpis();
    }

    resetDpi(row) {
      row.value = row.savedValue;
      row.yValue = row.savedYValue;
      row.lod = row.savedLod;
      row.linked = row.value === row.yValue;
      this.commitDpis();
    }

    setAdvanced(on) {
      this.advanced = on;
      if (on || !this.supportsAdvanced) return;
      for (const r of this.dpis) {
        r.linked = true;
        r.yValue = r.value;
        if (this.supportsLod) r.lod = this.oobDefaultLod;
      }
      this.commitDpis();
    }

    // Assignment rows for the normal or the G-Shift layer
    assignments(gshift) {
      const count = Math.min(this.mouse.info.buttonCount, this.data.buttonCount(false), this.data.buttonCount(true));
      const rows = [];
      for (let i = 0; i < count; i++) {
        const main = this.data.getButton(i, false);
        const mainIsGShift = A.isFn(main, A.FN.G_SHIFT);
        const bytes = gshift ? (mainIsGShift ? main : this.data.getButton(i, true)) : main;
        rows.push({ index: i, label: i + 1, bytes, enabled: gshift ? !mainIsGShift : i >= 2 });
      }
      return rows;
    }

    setAssignment(index, gshift, bytes) {
      if (gshift) {
        this.data.setButton(index, true, bytes);
        return;
      }
      const previous = this.data.getButton(index, false);
      this.data.setButton(index, false, bytes);
      // A button that stops being G-Shift gets its G-Shift layer function cleared
      if (A.isFn(previous, A.FN.G_SHIFT) && !A.isFn(bytes, A.FN.G_SHIFT)) {
        this.data.setButton(index, true, A.fn(A.FN.NONE));
      }
    }

    reset() {
      this.data = this.saved.clone();
      this.populate();
    }

    markSaved() {
      this.saved = this.data.clone();
      this.populate();
    }
  }

  class Mouse {
    constructor(dev, options) {
      this.dev = dev;
      this.wired = !!(options && options.wired);
      this.name = '';
      this.info = null;
      this.profiles = [];
      this.activeProfile = null;
      this.hostMode = false;
      this.currentDpiIndex = -1;
      this.sensorCaps = null;
      this.dpiRanges = [];
      this.dpiRangesY = null;
      this.reportRates = null; // { wired, wireless, actual } bit masks when 0x8061 is present
      this.battery = null; // { percent, charging }
      this.hasButtonSpy = false;
      this.dirModified = false;
      this.onchange = null; // called after device initiated changes
      this._spy = null;
    }

    _changed() {
      if (this.onchange) this.onchange();
    }

    async init() {
      const dev = this.dev;
      const proto = await dev.ping();
      if (proto.major < 2) throw new UnsupportedError('HID++ 1.0 device');
      const hasOld = await dev.hasFeature(F.ADJUSTABLE_DPI);
      const hasNew = await dev.hasFeature(F.EXTENDED_DPI);
      const required = [F.DEVICE_INFO, F.DEVICE_NAME, F.ONBOARD_PROFILES];
      for (const id of required) {
        if (!(await dev.hasFeature(id))) throw new UnsupportedError('Missing feature 0x' + id.toString(16));
      }
      if (!hasOld && !hasNew) throw new UnsupportedError('No adjustable DPI feature');

      this.name = await this._readName();
      this.info = await this._readInfo();
      if (!OMM.profile.layoutFor(this.info.format)) {
        throw new UnsupportedError('Profile format not supported: ' + this.info.format);
      }

      if (hasNew) {
        const caps = await dev.call(F.EXTENDED_DPI, 1, [0]);
        this.sensorCaps = { levels: caps[1], dpiY: (caps[2] & 1) !== 0, lod: (caps[2] & 2) !== 0 };
        this.dpiRanges = await this._readDpiRanges(0);
        if (this.sensorCaps.dpiY) this.dpiRangesY = await this._readDpiRanges(1);
      } else {
        const r = await dev.call(F.ADJUSTABLE_DPI, 1, [0]);
        const words = [];
        for (let i = 1; i + 1 < r.length; i += 2) words.push((r[i] << 8) | r[i + 1]);
        this.dpiRanges = parseDpiWords(words);
      }

      if (await dev.hasFeature(F.EXTENDED_REPORT_RATE)) {
        const word = (r) => (r[0] << 8) | r[1];
        this.reportRates = {
          wired: word(await dev.call(F.EXTENDED_REPORT_RATE, 0, [0])),
          wireless: word(await dev.call(F.EXTENDED_REPORT_RATE, 0, [1])),
          actual: word(await dev.call(F.EXTENDED_REPORT_RATE, 1, [])),
        };
      }

      this.hasButtonSpy = await dev.hasFeature(F.MOUSE_BUTTON_SPY);
      await this._initBattery();
      await this._loadProfiles();
      if (!this.profiles.length) throw new UnsupportedError('No readable profiles');

      dev.on(F.ONBOARD_PROFILES, (event, params) => {
        if (event === 0) {
          this._setActiveSector((params[0] << 8) | params[1]);
          this._changed();
        } else if (event === 1) {
          this.currentDpiIndex = params[0];
          this._changed();
        }
      });
      await this.refreshState();
    }

    async _readName() {
      const dev = this.dev;
      const info = await dev.call(F.DEVICE_INFO, 0, []);
      const model = Array.from(info.slice(7, 13), (b) => b.toString(16).padStart(2, '0')).join('');
      const extended = info[13];
      if (NAME_OVERRIDES[model] && (model !== '40a9c09b0000' || extended <= 2)) return NAME_OVERRIDES[model];
      const length = (await dev.call(F.DEVICE_NAME, 0, []))[0];
      let name = '';
      while (name.length < length) {
        const chunk = await dev.call(F.DEVICE_NAME, 1, [name.length]);
        const before = name.length;
        for (let i = 0; i < chunk.length && name.length < length; i++) name += String.fromCharCode(chunk[i]);
        if (name.length === before) break;
      }
      return name || 'Mouse';
    }

    async _readInfo() {
      const r = await this.dev.call(F.ONBOARD_PROFILES, 0, []);
      return {
        memoryModel: r[0], format: r[1], macroFormat: r[2], profileCount: r[3], profileCountOob: r[4],
        buttonCount: r[5], sectorCount: r[6], sectorSize: (r[7] << 8) | r[8],
      };
    }

    async _readDpiRanges(direction) {
      const words = [];
      let carry = -1;
      for (let chunk = 0; chunk < 32; chunk++) {
        const r = await this.dev.call(F.EXTENDED_DPI, 2, [0, direction, chunk]);
        for (let i = 3; i < r.length; i++) {
          if (carry < 0) {
            carry = r[i];
          } else {
            words.push((carry << 8) | r[i]);
            carry = -1;
            if (words[words.length - 1] === 0) return parseDpiWords(words);
          }
        }
      }
      return parseDpiWords(words);
    }

    async _initBattery() {
      const dev = this.dev;
      const unified = (r) => {
        this.battery = { percent: r[0], charging: r[2] !== 0 };
      };
      const level = (r) => {
        this.battery = { percent: r[0], charging: r[2] !== 0 };
      };
      const voltage = (r) => {
        const v = ((r[0] << 8) | r[1]) / 1000;
        const low = v < 3.655;
        const used = (low ? -15695.751 : 8350.133) * v ** 3 + (low ? 166612.55 : -95306.16) * v ** 2
          + (low ? -589698.94 : 360382.25) * v + (low ? 696795.9 : -450903.6);
        const percent = Math.round(Math.min(100, Math.max(0, 100 * ((902.34 - used) / 902.34))));
        this.battery = { percent, charging: (r[2] & 0x80) !== 0 };
      };
      const setup = async (id, fn, parse) => {
        dev.on(id, (event, params) => {
          if (event === 0) {
            parse(params);
            this._changed();
          }
        });
        try {
          parse(await dev.call(id, fn, []));
        } catch (e) {
          this.battery = null;
        }
      };
      if (await dev.hasFeature(F.UNIFIED_BATTERY)) await setup(F.UNIFIED_BATTERY, 1, unified);
      else if (await dev.hasFeature(F.BATTERY_VOLTAGE)) await setup(F.BATTERY_VOLTAGE, 0, voltage);
      else if (await dev.hasFeature(F.BATTERY_LEVEL)) await setup(F.BATTERY_LEVEL, 0, level);
    }

    // Sectors are read 16 bytes at a time, the last read is shifted back to stay in bounds
    async readSector(sector) {
      const size = this.info.sectorSize;
      const bytes = new Uint8Array(size);
      let offset = 0;
      while (offset < size) {
        const at = Math.min(offset, size - 16);
        const r = await this.dev.call(F.ONBOARD_PROFILES, 5, [...u16(sector), ...u16(at), 16]);
        bytes.set(r.slice(0, 16), at);
        offset = at + 16;
      }
      return bytes;
    }

    async writeSector(sector, bytes) {
      const dev = this.dev;
      await dev.call(F.ONBOARD_PROFILES, 6, [...u16(sector), 0, 0, ...u16(bytes.length)]);
      for (let offset = 0; offset < bytes.length; offset += 16) {
        const chunk = new Uint8Array(16).fill(0xff);
        chunk.set(bytes.slice(offset, offset + 16));
        await dev.call(F.ONBOARD_PROFILES, 7, chunk);
      }
      await dev.call(F.ONBOARD_PROFILES, 8, []);
    }

    _romSector(sector) {
      const oob = this.info.profileCountOob;
      if (oob < 1) return 0;
      return ROM_SECTOR + (oob >= sector ? sector : 1);
    }

    async _readRomProfile(sector) {
      const rom = this._romSector(sector);
      if (!rom) return null;
      const data = new OnboardProfile(this.info.format, await this.readSector(rom));
      migrateV10(data);
      return data;
    }

    async _loadProfiles() {
      const info = this.info;
      let entries = [];
      try {
        entries = parseDirectory(await this.readSector(0)).slice(0, info.profileCount);
      } catch (e) {
        entries = [];
      }
      entries.forEach((e) => { e.virtual = false; });
      // Slots missing from the directory still show up, backed by the factory profile until saved
      while (entries.length < info.profileCount) {
        let free = 0;
        for (let s = 1; s <= info.profileCount && !free; s++) {
          if (!entries.some((e) => e.sector === s)) free = s;
        }
        if (!free) break;
        entries.push({ sector: free, enabled: false, flags: 0, extra: 0, virtual: true });
      }
      entries.forEach((e, n) => { e.index = n + 1; });

      this.profiles = [];
      for (const entry of entries) {
        let data = null;
        if (!entry.virtual) {
          try {
            const bytes = await this.readSector(entry.sector);
            if (crcValid(bytes)) {
              data = new OnboardProfile(info.format, bytes);
              migrateV10(data);
            }
          } catch (e) {
            if (e instanceof OMM.hidpp.HidppError && e.kind !== 'device') throw e;
          }
        }
        if (!data) data = await this._readRomProfile(entry.sector);
        if (!data) continue;
        const model = new ProfileModel(this, entry, data);
        if (model.supportsLod) {
          try {
            const rom = await this._readRomProfile(entry.sector);
            if (rom) model.oobDefaultLod = rom.getDpi(rom.dpiDefaultIndex).lod || 2;
          } catch (e) {
            // keep the default
          }
          model.populate();
        }
        this.profiles.push(model);
      }
    }

    _setActiveSector(sector) {
      this.activeProfile = this.profiles.find((p) => p.sector === sector) || null;
      if (this.activeProfile) this.currentDpiIndex = this.activeProfile.saved.dpiDefaultIndex;
    }

    // Host or onboard mode, active profile and active DPI slot
    async refreshState() {
      const dev = this.dev;
      const mode = (await dev.call(F.ONBOARD_PROFILES, 2, []))[0];
      this.hostMode = mode === MODE_HOST;
      if (this.hostMode) {
        this.activeProfile = null;
        this.currentDpiIndex = -1;
        return;
      }
      const r = await dev.call(F.ONBOARD_PROFILES, 4, []);
      this._setActiveSector((r[0] << 8) | r[1]);
      try {
        this.currentDpiIndex = (await dev.call(F.ONBOARD_PROFILES, 11, []))[0];
      } catch (e) {
        // older firmware without the resolution getter
      }
    }

    // Periodic check, cheap enough to double as a liveness probe
    async poll() {
      const mode = (await this.dev.call(F.ONBOARD_PROFILES, 2, [], 1500))[0];
      const host = mode === MODE_HOST;
      if (host !== this.hostMode) {
        await this.refreshState();
        return true;
      }
      return false;
    }

    async setOnboardMode() {
      await this.dev.call(F.ONBOARD_PROFILES, 1, [MODE_ONBOARD]);
      await this.refreshState();
    }

    async activateProfile(profile) {
      if (this.hostMode || !profile.enabled) return false;
      await this.dev.call(F.ONBOARD_PROFILES, 3, u16(profile.sector));
      this._setActiveSector(profile.sector);
      return true;
    }

    async setCurrentDpi(index) {
      if (this.hostMode || index < 0) return;
      await this.dev.call(F.ONBOARD_PROFILES, 12, [index]);
      this.currentDpiIndex = index;
    }

    async writeDirectory() {
      const all = this.profiles.map((p) => p.entry);
      if (!all.some((e) => e.enabled)) all[0].enabled = true;
      let last = -1;
      all.forEach((e, n) => {
        if (e.enabled || !e.virtual) last = n;
      });
      const listed = all.slice(0, last + 1);
      await this.writeSector(0, buildDirectory(listed, this.info.sectorSize));
      listed.forEach((e) => { e.virtual = false; });
      this.dirModified = false;
    }

    async saveProfile(profile) {
      await this.writeSector(profile.sector, profile.data.finalize());
      if (this.dirModified) await this.writeDirectory();
      const live = this.currentDpiIndex;
      const wasActive = this.activeProfile === profile;
      profile.markSaved();
      if (!this.hostMode && wasActive) {
        // Re-activating makes the mouse load the new settings, then restore the DPI slot in use
        if (await this.activateProfile(profile)) {
          if (live >= 0 && profile.dpis[live] && profile.dpis[live].enabled) await this.setCurrentDpi(live);
        }
      }
    }

    async toggleEnabled(profile) {
      const enabledCount = this.profiles.filter((p) => p.enabled).length;
      if (profile.enabled && enabledCount === 1) return false;
      profile.entry.enabled = !profile.entry.enabled;
      this.dirModified = true;
      if (profile.entry.virtual) await this.writeSector(profile.sector, profile.saved.finalize());
      await this.writeDirectory();
      if (!this.hostMode && !profile.enabled && this.activeProfile === profile) {
        const next = this.profiles.find((p) => p.enabled);
        if (next) await this.activateProfile(next);
      }
      return true;
    }

    // Copy the factory profile back into the user sector
    async restoreDefaults(profile) {
      const rom = await this._readRomProfile(profile.sector);
      if (!rom) throw new Error('Device does not have any stored factory profiles');
      profile.data = rom;
      profile.saved = rom.clone();
      await this.writeSector(profile.sector, rom.finalize());
      if (this.dirModified) await this.writeDirectory();
      profile.populate();
      if (!this.hostMode && this.activeProfile === profile) await this.activateProfile(profile);
    }

    // Reports the index of the next physical button that is released. Buttons do nothing while spying.
    async startButtonSpy(callback) {
      if (!this.hasButtonSpy || this._spy) return;
      let previous = 0;
      this._spy = (event, params) => {
        if (event !== 0) return;
        const state = (params[0] << 8) | params[1];
        const released = previous & ~state;
        previous = state;
        if (released) callback(31 - Math.clz32(released & -released));
      };
      this.dev.on(F.MOUSE_BUTTON_SPY, this._spy);
      await this.dev.call(F.MOUSE_BUTTON_SPY, 1, []);
    }

    async stopButtonSpy() {
      if (!this._spy) return;
      const set = this.dev.handlers.get(F.MOUSE_BUTTON_SPY);
      if (set) set.delete(this._spy);
      this._spy = null;
      await this.dev.call(F.MOUSE_BUTTON_SPY, 2, []);
    }

    get spying() {
      return !!this._spy;
    }

    reportRateOptions(kind) {
      if (!this.reportRates) return REPORT_RATES.map(([value, hz]) => ({ value, label: hz + ' Hz' }));
      const mask = this.reportRates[kind];
      const options = [];
      REPORT_RATES_EXT.forEach((hz, value) => {
        if (mask & (1 << value)) options.push({ value, label: hz + ' Hz' });
      });
      return options;
    }

    // True when the receiver in use cannot do the highest rate the mouse supports
    get wirelessRateLimited() {
      if (!this.reportRates) return false;
      const top = (m) => 31 - Math.clz32(m || 1);
      return top(this.reportRates.wireless) !== top(this.reportRates.actual);
    }
  }

  // Format 10 profiles written by older firmware keep the rate in the legacy byte and
  // have no y-axis table yet. Bring them to the current shape, like the vendor tool does.
  function migrateV10(data) {
    if (data.format !== 10) return false;
    let changed = false;
    for (let i = 0; i < DPI_SLOTS; i++) {
      const d = data.getDpi(i);
      if (d.y === 0xffff) {
        data.setDpi(i, { x: d.x, y: d.x, lod: 0 });
        changed = true;
      }
    }
    if (data.reportRate !== 0xff) {
      const ext = { 1: 3, 2: 2, 4: 1, 8: 0 }[data.reportRate];
      const rate = ext === undefined ? 3 : ext;
      data.reportRateWireless = rate;
      data.reportRateWired = rate;
      data.reportRate = 0xff;
      changed = true;
    }
    return changed;
  }

  OMM.device = { F, Mouse, ProfileModel, UnsupportedError, parseDpiWords, dpiValid, nearestDpi, migrateV10 };
})(globalThis.OMM = globalThis.OMM || {});

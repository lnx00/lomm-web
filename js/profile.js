// Onboard profile sector layouts (HID++ feature 0x8100) and the profile directory.
// A sector is sectorSize bytes, the last two hold a big-endian CRC-16/CCITT-FALSE.
(function (OMM) {
  'use strict';

  // Component ids, same numbering the vendor tool uses internally
  const C = {
    REPORT_RATE: 0, DPI_V1: 1, COLOR: 2, POWER_MODE: 3, ANGLE_SNAPPING: 4,
    BUTTONS: 5, GSHIFT_BUTTONS: 6, NAME: 7, LOGO_LIGHT: 8, SIDE_LIGHT: 9,
    WRITE_COUNTER: 10, POWER_SAVE_TIMEOUT: 11, POWER_OFF_TIMEOUT: 12,
    LOGO_POWER_SAVE: 13, SIDE_POWER_SAVE: 14,
    CLUSTER0_ACTIVE: 15, CLUSTER0_PASSIVE: 16, CLUSTER1_ACTIVE: 17, CLUSTER1_PASSIVE: 18,
    LIGHTING_FLAGS: 19, REPORT_RATE_WIRELESS: 20, REPORT_RATE_WIRED: 21,
    DPI_V6: 22, DPI_DELTA: 23, BUNNY_HOPPING: 24, ANALOG_BUTTONS: 25, DPI_V10_Y: 26,
  };

  const DPI_SLOTS = 5;

  // [offset, size, count]
  function baseV1() {
    return {
      [C.REPORT_RATE]: [0, 1], [C.DPI_V1]: [1, 12], [C.COLOR]: [13, 3], [C.POWER_MODE]: [16, 1],
      [C.ANGLE_SNAPPING]: [17, 1], [C.BUTTONS]: [32, 64, 16], [C.GSHIFT_BUTTONS]: [96, 64, 16],
      [C.NAME]: [160, 48],
    };
  }

  function timers(wc, ps, po) {
    return { [C.WRITE_COUNTER]: [wc, 2], [C.POWER_SAVE_TIMEOUT]: [ps, 2], [C.POWER_OFF_TIMEOUT]: [po, 2] };
  }

  function clusters() {
    return {
      [C.CLUSTER0_ACTIVE]: [208, 11], [C.CLUSTER1_ACTIVE]: [219, 11],
      [C.CLUSTER0_PASSIVE]: [230, 11], [C.CLUSTER1_PASSIVE]: [241, 11], [C.LIGHTING_FLAGS]: [252, 1],
    };
  }

  function baseV6() {
    return Object.assign({
      [C.REPORT_RATE_WIRELESS]: [0, 1], [C.REPORT_RATE_WIRED]: [1, 1], [C.DPI_V6]: [2, 27],
      [C.DPI_DELTA]: [29, 4], [C.POWER_MODE]: [33, 1], [C.ANGLE_SNAPPING]: [34, 1],
      [C.BUTTONS]: [48, 48, 12], [C.GSHIFT_BUTTONS]: [112, 48, 12], [C.NAME]: [160, 48],
    }, timers(35, 44, 46), clusters());
  }

  function layoutFor(format) {
    switch (format) {
      case 1:
        return baseV1();
      case 2:
      case 3:
        return Object.assign(baseV1(), { [C.LOGO_LIGHT]: [208, 11], [C.SIDE_LIGHT]: [219, 11] });
      case 4:
        return Object.assign(baseV1(), { [C.LOGO_LIGHT]: [208, 11], [C.SIDE_LIGHT]: [219, 11] },
          timers(18, 28, 30), { [C.LOGO_POWER_SAVE]: [230, 11], [C.SIDE_POWER_SAVE]: [241, 11] });
      case 5:
        return Object.assign(baseV1(), timers(18, 28, 30), clusters());
      case 6:
        return baseV6();
      case 7:
        return Object.assign(baseV6(), { [C.BUNNY_HOPPING]: [37, 1] });
      case 8:
        return Object.assign(baseV6(), { [C.BUNNY_HOPPING]: [37, 1], [C.ANALOG_BUTTONS]: [38, 6, 2] });
      case 10:
        return Object.assign(baseV1(), timers(18, 28, 30), clusters(), {
          [C.REPORT_RATE_WIRELESS]: [20, 1], [C.REPORT_RATE_WIRED]: [21, 1], [C.DPI_DELTA]: [22, 4],
          [C.BUTTONS]: [32, 52, 13], [C.DPI_V10_Y]: [86, 10],
        });
      default:
        return null;
    }
  }

  function crc16(bytes, length) {
    let crc = 0xffff;
    for (let i = 0; i < length; i++) {
      crc ^= bytes[i] << 8;
      for (let b = 0; b < 8; b++) {
        crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
      }
    }
    return crc;
  }

  function crcValid(bytes) {
    const n = bytes.length;
    return n >= 2 && crc16(bytes, n - 2) === ((bytes[n - 2] << 8) | bytes[n - 1]);
  }

  function writeCrc(bytes) {
    const n = bytes.length;
    const crc = crc16(bytes, n - 2);
    bytes[n - 2] = crc >> 8;
    bytes[n - 1] = crc & 0xff;
    return bytes;
  }

  class OnboardProfile {
    constructor(format, bytes) {
      this.format = format;
      this.layout = layoutFor(format);
      if (!this.layout) throw new Error('Profile format not supported: ' + format);
      this.bytes = new Uint8Array(bytes);
      for (const id in this.layout) {
        const [off, size] = this.layout[id];
        if (off + size > this.bytes.length - 2) throw new Error('Profile sector size mismatch');
      }
    }

    clone() {
      return new OnboardProfile(this.format, this.bytes);
    }

    has(id) {
      return id in this.layout;
    }

    // Compares everything except the trailing checksum
    equals(other) {
      const n = this.bytes.length - 2;
      if (other.bytes.length !== this.bytes.length) return false;
      for (let i = 0; i < n; i++) if (this.bytes[i] !== other.bytes[i]) return false;
      return true;
    }

    // Returns the sector image with a fresh checksum
    finalize() {
      return writeCrc(new Uint8Array(this.bytes));
    }

    _byte(id) {
      return this.bytes[this.layout[id][0]];
    }

    _setByte(id, v) {
      this.bytes[this.layout[id][0]] = v & 0xff;
    }

    _u16le(off) {
      return this.bytes[off] | (this.bytes[off + 1] << 8);
    }

    _setU16le(off, v) {
      this.bytes[off] = v & 0xff;
      this.bytes[off + 1] = (v >> 8) & 0xff;
    }

    // Legacy report rate, stored as the interval in ms: 1, 2, 4 or 8
    get reportRate() { return this._byte(C.REPORT_RATE); }
    set reportRate(v) { this._setByte(C.REPORT_RATE, v); }

    // Extended report rates, 0 = 125 Hz up to 6 = 8000 Hz
    get reportRateWireless() { return this._byte(C.REPORT_RATE_WIRELESS); }
    set reportRateWireless(v) { this._setByte(C.REPORT_RATE_WIRELESS, v); }
    get reportRateWired() { return this._byte(C.REPORT_RATE_WIRED); }
    set reportRateWired(v) { this._setByte(C.REPORT_RATE_WIRED, v); }

    get bunnyHopping() { return this._byte(C.BUNNY_HOPPING); }
    set bunnyHopping(v) { this._setByte(C.BUNNY_HOPPING, v); }

    // 'v6': x, y and lift-off distance per slot. 'v10': x plus a separate y table. 'v1': x only.
    get dpiKind() {
      if (this.has(C.DPI_V6)) return 'v6';
      if (this.has(C.DPI_V1) && this.has(C.DPI_V10_Y)) return 'v10';
      return 'v1';
    }

    get _dpiBase() {
      return this.layout[this.has(C.DPI_V6) ? C.DPI_V6 : C.DPI_V1][0];
    }

    get dpiDefaultIndex() { return this.bytes[this._dpiBase]; }
    set dpiDefaultIndex(v) { this.bytes[this._dpiBase] = v; }
    get dpiShiftIndex() { return this.bytes[this._dpiBase + 1]; }
    set dpiShiftIndex(v) { this.bytes[this._dpiBase + 1] = v; }

    getDpi(i) {
      const base = this._dpiBase + 2;
      if (this.dpiKind === 'v6') {
        const o = base + i * 5;
        return { x: this._u16le(o), y: this._u16le(o + 2), lod: this.bytes[o + 4] };
      }
      const x = this._u16le(base + i * 2);
      const y = this.dpiKind === 'v10' ? this._u16le(this.layout[C.DPI_V10_Y][0] + i * 2) : 0;
      return { x, y, lod: 0 };
    }

    setDpi(i, d) {
      const base = this._dpiBase + 2;
      if (this.dpiKind === 'v6') {
        const o = base + i * 5;
        this._setU16le(o, d.x);
        this._setU16le(o + 2, d.y);
        this.bytes[o + 4] = d.lod;
        return;
      }
      this._setU16le(base + i * 2, d.x);
      if (this.dpiKind === 'v10') this._setU16le(this.layout[C.DPI_V10_Y][0] + i * 2, d.y);
    }

    buttonCount(gshift) {
      return this.layout[gshift ? C.GSHIFT_BUTTONS : C.BUTTONS][2];
    }

    getButton(i, gshift) {
      const off = this.layout[gshift ? C.GSHIFT_BUTTONS : C.BUTTONS][0] + i * 4;
      return this.bytes.slice(off, off + 4);
    }

    setButton(i, gshift, four) {
      this.bytes.set(four, this.layout[gshift ? C.GSHIFT_BUTTONS : C.BUTTONS][0] + i * 4);
    }

    // UTF-16LE, zero terminated, 0xFFFF when never set
    get name() {
      const [off, size] = this.layout[C.NAME];
      let s = '';
      for (let i = 0; i < size; i += 2) {
        const ch = this._u16le(off + i);
        if (ch === 0 || ch === 0xffff) break;
        s += String.fromCharCode(ch);
      }
      return s;
    }
  }

  // Directory sector: 4 bytes per profile [sectorHi, sectorLo, flags, reserved], 0xFFFF ends the list.
  function parseDirectory(bytes) {
    const entries = [];
    if (!crcValid(bytes)) return entries;
    for (let i = 0; i + 3 < bytes.length - 2; i += 4) {
      const sector = (bytes[i] << 8) | bytes[i + 1];
      if (sector === 0xffff) break;
      entries.push({ sector, enabled: (bytes[i + 2] & 1) === 1, flags: bytes[i + 2] & 0xfe, extra: bytes[i + 3] });
    }
    return entries;
  }

  function buildDirectory(entries, sectorSize) {
    if (!entries.length) throw new Error('Directory cannot be empty');
    if (entries.length * 4 + 2 > sectorSize) throw new Error('Directory exceeds sector size');
    if (!entries.some((e) => e.enabled)) throw new Error('Directory must have at least one enabled entry');
    const bytes = new Uint8Array(sectorSize).fill(0xff);
    entries.forEach((e, n) => {
      bytes[n * 4] = e.sector >> 8;
      bytes[n * 4 + 1] = e.sector & 0xff;
      bytes[n * 4 + 2] = (e.enabled ? 1 : 0) + (e.flags || 0);
      bytes[n * 4 + 3] = e.extra || 0;
    });
    return writeCrc(bytes);
  }

  OMM.profile = { C, DPI_SLOTS, layoutFor, crc16, crcValid, writeCrc, OnboardProfile, parseDirectory, buildDirectory };
})(globalThis.OMM = globalThis.OMM || {});

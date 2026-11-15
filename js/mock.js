// Simulated mouse behind a receiver, used by the demo mode (index.html?demo).
// It speaks enough HID++ 2.0 to exercise the whole app without hardware.
(function (OMM) {
  'use strict';

  const P = OMM.profile;
  const A = OMM.actions;

  const FEATURES = [0x0000, 0x0001, 0x0003, 0x0005, 0x1004, 0x2202, 0x8061, 0x8100, 0x8110];
  const SECTOR_SIZE = 255;
  const NAME = 'PRO X SUPERLIGHT 2';

  function factoryProfile(format) {
    const p = new P.OnboardProfile(format, new Uint8Array(SECTOR_SIZE).fill(0xff));
    const dpi = [400, 800, 1600, 0, 0];
    dpi.forEach((x, i) => p.setDpi(i, { x, y: x, lod: x ? 2 : 0 }));
    p.dpiDefaultIndex = 1;
    p.dpiShiftIndex = 0;
    if (p.has(P.C.REPORT_RATE)) p.reportRate = format === 10 ? 0xff : 1;
    if (p.has(P.C.REPORT_RATE_WIRED)) {
      p.reportRateWired = 3;
      p.reportRateWireless = 3;
    }
    if (p.has(P.C.BUNNY_HOPPING)) p.bunnyHopping = 0;
    const buttons = [A.mouse(1), A.mouse(2), A.mouse(4), A.mouse(8), A.mouse(16)];
    buttons.forEach((b, i) => {
      p.setButton(i, false, b);
      p.setButton(i, true, b);
    });
    return p.finalize();
  }

  class MockTransport {
    constructor(format) {
      this.name = 'Demo Receiver';
      this.hasShort = true;
      this.hasLong = true;
      this.onreport = null;
      this.format = format || 10;
      this.mode = 1;
      this.active = 1;
      this.resolution = 1;
      this.write = null;
      const rom = factoryProfile(this.format);
      this.sectors = new Map([
        [0x0101, rom],
        [1, new Uint8Array(rom)],
        [0, P.buildDirectory([{ sector: 1, enabled: true }], SECTOR_SIZE)],
      ]);
    }

    async open() {}
    async close() {}

    async send(reportId, data) {
      const dev = data[0];
      const feat = data[1];
      const fnsw = data[2];
      const params = data.slice(3);
      let reply;
      if (dev !== 1) {
        // The receiver itself only speaks HID++ 1.0
        reply = [dev, 0x8f, feat, fnsw, 0x01, 0, 0];
        this._emit(0x10, reply);
        return;
      }
      try {
        const out = this._handle(FEATURES[feat], fnsw >> 4, params);
        reply = new Uint8Array(19);
        reply.set([dev, feat, fnsw]);
        reply.set(out.slice(0, 16), 3);
      } catch (code) {
        reply = new Uint8Array(19);
        reply.set([dev, 0xff, feat, fnsw, typeof code === 'number' ? code : 2]);
      }
      this._emit(0x11, reply);
    }

    _emit(reportId, bytes) {
      Promise.resolve().then(() => {
        if (this.onreport) this.onreport(reportId, Uint8Array.from(bytes));
      });
    }

    _sector(id) {
      const s = this.sectors.get(id);
      if (!s) throw 2;
      return s;
    }

    _handle(feature, fn, p) {
      switch (feature) {
        case 0x0000:
          if (fn === 0) {
            const idx = FEATURES.indexOf((p[0] << 8) | p[1]);
            return [idx < 0 ? 0 : idx, 0, 0];
          }
          return [4, 2, p[2]];
        case 0x0003:
          return [1, 0, 0, 0, 0, 0, 0, 0x40, 0xa9, 0xc0, 0x9b, 0, 0, 0, 0];
        case 0x0005:
          if (fn === 0) return [NAME.length];
          return Array.from(NAME.slice(p[0], p[0] + 16), (c) => c.charCodeAt(0));
        case 0x1004:
          if (fn === 0) return [0, 0x0f];
          return [95, 8, 0, 0, 0, 0];
        case 0x2202:
          if (fn === 0) return [1];
          if (fn === 1) return [0, 5, this.format === 10 ? 0x01 : 0x03];
          if (fn === 2) return p[2] === 0 ? [p[0], p[1], 0, 0x00, 0x64, 0xe0, 0x01, 0xad, 0x9c, 0, 0] : [p[0], p[1], p[2], 0, 0];
          return [0, 0x03, 0x20, 0x03, 0x20, 0x03, 0x20, 0x03, 0x20, 2];
        case 0x8061:
          if (fn === 0) return p[0] === 0 ? [0x00, 0x0f] : [0x00, 0x7f];
          return [0x00, 0x0f];
        case 0x8100:
          return this._onboard(fn, p);
        case 0x8110:
          return [];
        default:
          throw 6;
      }
    }

    _onboard(fn, p) {
      switch (fn) {
        case 0:
          return [1, this.format, 1, 1, 1, 5, 2, SECTOR_SIZE >> 8, SECTOR_SIZE & 0xff, 0x0a, 0x01, 0, 0];
        case 1:
          this.mode = p[0];
          return [];
        case 2:
          return [this.mode];
        case 3:
          this.active = (p[0] << 8) | p[1];
          this.resolution = this._sector(this.active)[this.format >= 6 && this.format <= 8 ? 2 : 1];
          return [];
        case 4:
          return [this.active >> 8, this.active & 0xff];
        case 5: {
          const s = this._sector((p[0] << 8) | p[1]);
          const off = (p[2] << 8) | p[3];
          if (off + 16 > s.length) throw 2;
          return s.slice(off, off + 16);
        }
        case 6: {
          const sector = (p[0] << 8) | p[1];
          if (sector >= 0x100) throw 5;
          this.write = { sector, size: (p[4] << 8) | p[5], data: [] };
          return [];
        }
        case 7:
          if (!this.write) throw 5;
          this.write.data.push(...p.slice(0, 16));
          return [];
        case 8: {
          const w = this.write;
          this.write = null;
          if (!w || w.data.length < w.size) throw 2;
          const bytes = Uint8Array.from(w.data.slice(0, w.size));
          if (!P.crcValid(bytes)) throw 2;
          this.sectors.set(w.sector, bytes);
          return [];
        }
        case 11:
          return [this.resolution];
        case 12:
          this.resolution = p[0];
          return [];
        default:
          throw 7;
      }
    }
  }

  OMM.mock = { MockTransport, factoryProfile };
})(globalThis.OMM = globalThis.OMM || {});

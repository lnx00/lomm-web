// HID++ 2.0 transport on top of WebHID.
// A report is [deviceIndex, featureIndex, (function << 4) | softwareId, params...].
(function (OMM) {
  'use strict';

  const REPORT_SHORT = 0x10; // 6 payload bytes
  const REPORT_LONG = 0x11; // 19 payload bytes
  const SOFTWARE_ID = 0x0b; // any non-zero nibble, zero is reserved for notifications

  const ERROR_NAMES = {
    1: 'Unknown', 2: 'Invalid argument', 3: 'Out of range', 4: 'Hardware error',
    5: 'Not allowed', 6: 'Invalid feature index', 7: 'Invalid function', 8: 'Busy', 9: 'Unsupported',
  };

  class HidppError extends Error {
    constructor(message, code, kind) {
      super(message);
      this.name = 'HidppError';
      this.code = code;
      this.kind = kind; // 'timeout' | 'device' | 'receiver' | 'io'
    }
  }

  // Wraps a WebHID HIDDevice. The mock transport implements the same surface.
  class WebHidTransport {
    constructor(hid) {
      this.hid = hid;
      this.name = hid.productName || 'HID device';
      this.onreport = null;
      this.hasShort = false;
      this.hasLong = false;
      const scan = (collections) => {
        for (const c of collections || []) {
          for (const r of c.outputReports || []) {
            if (r.reportId === REPORT_SHORT) this.hasShort = true;
            if (r.reportId === REPORT_LONG) this.hasLong = true;
          }
          scan(c.children);
        }
      };
      scan(hid.collections);
      if (!this.hasShort && !this.hasLong) this.hasLong = true;
      this._handler = (e) => {
        if (this.onreport) {
          this.onreport(e.reportId, new Uint8Array(e.data.buffer, e.data.byteOffset, e.data.byteLength));
        }
      };
    }

    async open() {
      if (!this.hid.opened) await this.hid.open();
      this.hid.addEventListener('inputreport', this._handler);
    }

    async close() {
      this.hid.removeEventListener('inputreport', this._handler);
      if (this.hid.opened) await this.hid.close();
    }

    send(reportId, data) {
      return this.hid.sendReport(reportId, data);
    }
  }

  // Serializes requests: one in flight at a time, matched by device, feature and function.
  class Channel {
    constructor(transport) {
      this.transport = transport;
      this.queue = Promise.resolve();
      this.pending = null;
      this.listeners = new Set();
      transport.onreport = (id, data) => this._onReport(id, data);
    }

    request(deviceIndex, featureIndex, fn, params, timeout) {
      const run = () => this._request(deviceIndex, featureIndex, fn, params || [], timeout || 3000);
      const result = this.queue.then(run, run);
      this.queue = result.catch(() => {});
      return result;
    }

    async _request(deviceIndex, featureIndex, fn, params, timeout) {
      const t = this.transport;
      const long = params.length > 3 || !t.hasShort;
      if (long && !t.hasLong) throw new HidppError('Device does not accept long reports', 0, 'io');
      const buf = new Uint8Array(long ? 19 : 6);
      buf[0] = deviceIndex;
      buf[1] = featureIndex;
      buf[2] = ((fn & 0x0f) << 4) | SOFTWARE_ID;
      buf.set(params, 3);

      let timer;
      const reply = new Promise((resolve, reject) => {
        this.pending = { deviceIndex, featureIndex, fnsw: buf[2], resolve, reject };
        timer = setTimeout(() => reject(new HidppError('Request timed out', 0, 'timeout')), timeout);
      });
      reply.catch(() => {});
      try {
        await t.send(long ? REPORT_LONG : REPORT_SHORT, buf);
        return await reply;
      } catch (e) {
        if (e instanceof HidppError) throw e;
        throw new HidppError(e && e.message ? e.message : 'HID write failed', 0, 'io');
      } finally {
        clearTimeout(timer);
        this.pending = null;
      }
    }

    _onReport(reportId, data) {
      if (reportId !== REPORT_SHORT && reportId !== REPORT_LONG) return;
      if (data.length < 3) return;
      const dev = data[0];
      const feat = data[1];
      const fnsw = data[2];
      const p = this.pending;
      if (p && dev === p.deviceIndex) {
        if (feat === p.featureIndex && fnsw === p.fnsw) {
          p.resolve(data.slice(3));
          return;
        }
        // HID++ 2.0 error (0xFF) and HID++ 1.0 error (0x8F) echo the failed request
        if ((feat === 0xff || feat === 0x8f) && data[2] === p.featureIndex && data[3] === p.fnsw) {
          const code = data[4];
          const kind = feat === 0xff ? 'device' : 'receiver';
          const text = feat === 0xff ? (ERROR_NAMES[code] || 'Error') : 'Receiver error';
          p.reject(new HidppError(text + ' (0x' + code.toString(16).padStart(2, '0') + ')', code, kind));
          return;
        }
      }
      if ((fnsw & 0x0f) === 0) {
        for (const l of this.listeners) l(dev, feat, fnsw >> 4, data.slice(3));
      }
    }
  }

  // One HID++ 2.0 device reachable through a channel at a given device index.
  class Device {
    constructor(channel, index) {
      this.channel = channel;
      this.index = index;
      this.features = new Map([[0x0000, 0]]); // feature id -> index (0 = absent, except root)
      this.handlers = new Map(); // feature id -> Set of handlers
      this._listener = (dev, featIndex, event, params) => {
        if (dev !== this.index) return;
        for (const [id, idx] of this.features) {
          if (idx === featIndex && (idx !== 0 || id === 0)) {
            const set = this.handlers.get(id);
            if (set) for (const h of set) h(event, params);
          }
        }
      };
      channel.listeners.add(this._listener);
    }

    dispose() {
      this.channel.listeners.delete(this._listener);
    }

    // Root feature ping. Resolves with the protocol version, rejects for HID++ 1.0 or silence.
    async ping(timeout) {
      const r = await this.channel.request(this.index, 0, 1, [0, 0, 0x5a], timeout || 1000);
      return { major: r[0], minor: r[1] };
    }

    async featureIndex(id) {
      if (this.features.has(id)) return this.features.get(id);
      const r = await this.channel.request(this.index, 0, 0, [id >> 8, id & 0xff]);
      this.features.set(id, r[0]);
      return r[0];
    }

    async hasFeature(id) {
      return id === 0 || (await this.featureIndex(id)) !== 0;
    }

    async call(id, fn, params, timeout) {
      const idx = await this.featureIndex(id);
      if (id !== 0 && idx === 0) {
        throw new HidppError('Feature 0x' + id.toString(16).padStart(4, '0') + ' not supported', 0, 'device');
      }
      return this.channel.request(this.index, idx, fn, params, timeout);
    }

    on(id, handler) {
      if (!this.handlers.has(id)) this.handlers.set(id, new Set());
      this.handlers.get(id).add(handler);
    }
  }

  OMM.hidpp = { HidppError, WebHidTransport, Channel, Device, REPORT_SHORT, REPORT_LONG };
})(globalThis.OMM = globalThis.OMM || {});

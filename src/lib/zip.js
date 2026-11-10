// 极简 ZIP 打包（store 模式，边读边写，不占内存）
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crcUpdate(crc, buf) {
  let c = crc;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return c >>> 0;
}

function dosDateTime(d = new Date()) {
  const time = ((d.getHours() & 0x1f) << 11) | ((d.getMinutes() & 0x3f) << 5) | ((d.getSeconds() / 2) & 0x1f);
  const date = (((d.getFullYear() - 1980) & 0x7f) << 9) | (((d.getMonth() + 1) & 0x0f) << 5) | (d.getDate() & 0x1f);
  return { time: time & 0xffff, date: date & 0xffff };
}

/**
 * @param {Array<{name:string,size:number,open:()=>Promise<ReadableStream>}>} entries
 * @returns {ReadableStream}
 */
export function buildZipStream(entries) {
  return new ReadableStream({
    async start(controller) {
      const encoder = new TextEncoder();
      const central = [];
      let offset = 0;
      const now = new Date();

      const push = (u8) => {
        controller.enqueue(u8);
        offset += u8.length;
      };

      try {
        for (const entry of entries) {
          const nameBytes = encoder.encode(entry.name);
          const { time, date } = dosDateTime(entry.mtime ? new Date(entry.mtime * 1000) : now);
          const localOffset = offset;
          const isDir = entry.name.endsWith('/');

          const header = new Uint8Array(30 + nameBytes.length);
          const dv = new DataView(header.buffer);
          dv.setUint32(0, 0x04034b50, true);
          dv.setUint16(4, 20, true);
          dv.setUint16(6, 0x0808, true); // data descriptor + UTF-8
          dv.setUint16(8, 0, true); // store
          dv.setUint16(10, time, true);
          dv.setUint16(12, date, true);
          dv.setUint32(14, 0, true);
          dv.setUint32(18, 0, true);
          dv.setUint32(22, 0, true);
          dv.setUint16(26, nameBytes.length, true);
          dv.setUint16(28, 0, true);
          header.set(nameBytes, 30);
          push(header);

          let crc = 0xffffffff;
          let size = 0;
          if (!isDir && entry.size > 0) {
            const stream = await entry.open();
            const reader = stream.getReader();
            try {
              for (;;) {
                const { done, value } = await reader.read();
                if (done) break;
                const u8 = value instanceof Uint8Array ? value : new Uint8Array(value);
                if (!u8.length) continue;
                crc = crcUpdate(crc, u8);
                size += u8.length;
                push(u8);
              }
            } finally {
              try { reader.releaseLock(); } catch {}
            }
          }
          const crcFinal = (crc ^ 0xffffffff) >>> 0;

          const desc = new Uint8Array(16);
          const ddv = new DataView(desc.buffer);
          ddv.setUint32(0, 0x08074b50, true);
          ddv.setUint32(4, crcFinal, true);
          ddv.setUint32(8, size, true);
          ddv.setUint32(12, size, true);
          push(desc);

          central.push({ nameBytes, crc: crcFinal, size, localOffset, time, date, isDir });
        }

        const cdStart = offset;
        for (const c of central) {
          const rec = new Uint8Array(46 + c.nameBytes.length);
          const dv = new DataView(rec.buffer);
          dv.setUint32(0, 0x02014b50, true);
          dv.setUint16(4, 20, true);
          dv.setUint16(6, 20, true);
          dv.setUint16(8, 0x0808, true);
          dv.setUint16(10, 0, true);
          dv.setUint16(12, c.time, true);
          dv.setUint16(14, c.date, true);
          dv.setUint32(16, c.crc, true);
          dv.setUint32(20, c.size, true);
          dv.setUint32(24, c.size, true);
          dv.setUint16(28, c.nameBytes.length, true);
          dv.setUint16(30, 0, true);
          dv.setUint16(32, 0, true);
          dv.setUint16(34, 0, true);
          dv.setUint16(36, 0, true);
          dv.setUint32(38, c.isDir ? 0x10 : 0, true);
          dv.setUint32(42, c.localOffset, true);
          rec.set(c.nameBytes, 46);
          push(rec);
        }
        const cdSize = offset - cdStart;

        const eocd = new Uint8Array(22);
        const ev = new DataView(eocd.buffer);
        ev.setUint32(0, 0x06054b50, true);
        ev.setUint16(4, 0, true);
        ev.setUint16(6, 0, true);
        ev.setUint16(8, central.length, true);
        ev.setUint16(10, central.length, true);
        ev.setUint32(12, cdSize, true);
        ev.setUint32(16, cdStart, true);
        ev.setUint16(20, 0, true);
        push(eocd);

        controller.close();
      } catch (err) {
        controller.error(err);
      }
    },
  });
}

export function zipHeaders(filename) {
  return {
    'Content-Type': 'application/zip',
    'Content-Disposition': `attachment; filename="${filename.replace(/[^\x20-\x7e]/g, '_')}"; filename*=UTF-8''${encodeURIComponent(filename)}`,
    'Cache-Control': 'no-store',
  };
}

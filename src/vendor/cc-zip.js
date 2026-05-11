// [SECURITY] Minimal in-house ZIP writer. STORE (uncompressed) method only.
// Keeps the extension free of CDN-fetched dependencies (fflate, JSZip, etc.).
// Output is a valid PKZIP v2.0 archive — verified against `unzip`, Obsidian's
// import flow, and Windows Explorer's native ZIP handler.
//
// Scope: write-only, single-shot, in-memory. No reading, no streaming, no
// compression. Replace with fflate later if compression is needed.
(() => {
	'use strict';

	const CC = (globalThis.ClaudeCounter = globalThis.ClaudeCounter || {});

	// [CONFIG] Precomputed CRC-32 lookup table (polynomial 0xEDB88320).
	let CRC_TABLE = null;
	function crc32Table() {
		if (CRC_TABLE) return CRC_TABLE;
		const table = new Uint32Array(256);
		for (let n = 0; n < 256; n++) {
			let c = n;
			for (let k = 0; k < 8; k++) {
				c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
			}
			table[n] = c >>> 0;
		}
		CRC_TABLE = table;
		return table;
	}

	function crc32(bytes) {
		const table = crc32Table();
		let c = 0xFFFFFFFF;
		for (let i = 0; i < bytes.length; i++) {
			c = (table[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8)) >>> 0;
		}
		return (c ^ 0xFFFFFFFF) >>> 0;
	}

	function utf8Bytes(str) {
		return new TextEncoder().encode(typeof str === 'string' ? str : String(str));
	}

	function dosDateTime(ts) {
		const d = new Date(typeof ts === 'number' ? ts : Date.now());
		const year = Math.max(1980, d.getFullYear());
		const time = ((d.getHours() & 0x1f) << 11) | ((d.getMinutes() & 0x3f) << 5) | ((d.getSeconds() / 2) & 0x1f);
		const date = (((year - 1980) & 0x7f) << 9) | (((d.getMonth() + 1) & 0x0f) << 5) | (d.getDate() & 0x1f);
		return { time: time & 0xffff, date: date & 0xffff };
	}

	function u16(view, off, v) { view.setUint16(off, v & 0xffff, true); }
	function u32(view, off, v) { view.setUint32(off, v >>> 0, true); }

	/**
	 * Build a ZIP archive from a map of `{ filename: Uint8Array | string }`.
	 * Returns a Blob with type 'application/zip'.
	 */
	function build(files) {
		if (!files || 'object' !== typeof files) throw new TypeError('zip.build: files must be an object');

		const entries = [];
		let totalLocalSize = 0;

		for (const [rawName, rawContent] of Object.entries(files)) {
			const name = String(rawName);
			const data = rawContent instanceof Uint8Array ? rawContent : utf8Bytes(String(rawContent ?? ''));
			const nameBytes = utf8Bytes(name);
			const checksum = crc32(data);
			const { time, date } = dosDateTime(Date.now());

			const localHeaderSize = 30 + nameBytes.length;
			const localBytes = new Uint8Array(localHeaderSize + data.length);
			const lv = new DataView(localBytes.buffer);
			u32(lv, 0, 0x04034b50);                   // local file header signature
			u16(lv, 4, 20);                           // version needed
			u16(lv, 6, 0x0800);                       // gp flag bit 11 set (utf-8 names)
			u16(lv, 8, 0);                            // compression: store
			u16(lv, 10, time);
			u16(lv, 12, date);
			u32(lv, 14, checksum);
			u32(lv, 18, data.length);                 // compressed size
			u32(lv, 22, data.length);                 // uncompressed size
			u16(lv, 26, nameBytes.length);
			u16(lv, 28, 0);                           // extra field length
			localBytes.set(nameBytes, 30);
			localBytes.set(data, 30 + nameBytes.length);

			entries.push({
				nameBytes,
				dataLength: data.length,
				checksum,
				time, date,
				localOffset: totalLocalSize,
				localBytes
			});
			totalLocalSize += localBytes.length;
		}

		// Central directory
		const centralEntries = entries.map((e) => {
			const size = 46 + e.nameBytes.length;
			const buf = new Uint8Array(size);
			const v = new DataView(buf.buffer);
			u32(v, 0, 0x02014b50);
			u16(v, 4, 20);                  // version made by
			u16(v, 6, 20);                  // version needed
			u16(v, 8, 0x0800);
			u16(v, 10, 0);
			u16(v, 12, e.time);
			u16(v, 14, e.date);
			u32(v, 16, e.checksum);
			u32(v, 20, e.dataLength);
			u32(v, 24, e.dataLength);
			u16(v, 28, e.nameBytes.length);
			u16(v, 30, 0);
			u16(v, 32, 0);
			u16(v, 34, 0);
			u16(v, 36, 0);
			u32(v, 38, 0);
			u32(v, 42, e.localOffset);
			buf.set(e.nameBytes, 46);
			return buf;
		});

		const centralSize = centralEntries.reduce((a, b) => a + b.length, 0);

		// End of Central Directory
		const eocd = new Uint8Array(22);
		const ev = new DataView(eocd.buffer);
		u32(ev, 0, 0x06054b50);
		u16(ev, 4, 0);
		u16(ev, 6, 0);
		u16(ev, 8, entries.length);
		u16(ev, 10, entries.length);
		u32(ev, 12, centralSize);
		u32(ev, 16, totalLocalSize);
		u16(ev, 20, 0);

		const parts = [];
		for (const e of entries) parts.push(e.localBytes);
		for (const c of centralEntries) parts.push(c);
		parts.push(eocd);

		return new Blob(parts, { type: 'application/zip' });
	}

	CC.zip = { build };
})();

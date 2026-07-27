export function decodeMessage(buffer) {
  const bytes = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  const fields = [];
  let offset = 0;
  while (offset < bytes.length) {
    const key = readVarint(bytes, offset); offset = key.offset;
    const fieldNo = Number(key.value >> 3n);
    const wire = Number(key.value & 7n);
    if (!fieldNo) break;
    if (wire === 0) {
      const v = readVarint(bytes, offset); offset = v.offset;
      fields.push({ fieldNo, wire, value: v.value });
    } else if (wire === 1) {
      const v = bytes.subarray(offset, offset + 8); offset += 8;
      fields.push({ fieldNo, wire, value: v });
    } else if (wire === 2) {
      const len = readVarint(bytes, offset); offset = len.offset;
      const n = Number(len.value);
      const v = bytes.subarray(offset, offset + n); offset += n;
      fields.push({ fieldNo, wire, value: v });
    } else if (wire === 5) {
      const v = bytes.subarray(offset, offset + 4); offset += 4;
      fields.push({ fieldNo, wire, value: v });
    } else {
      throw new Error(`Unsupported protobuf wire type ${wire} at field ${fieldNo}`);
    }
  }
  return fields;
}

export function readVarint(bytes, offset) {
  let result = 0n;
  let shift = 0n;
  let pos = offset;
  while (pos < bytes.length) {
    const b = BigInt(bytes[pos++]);
    result |= (b & 0x7fn) << shift;
    if ((b & 0x80n) === 0n) return { value: result, offset: pos };
    shift += 7n;
    if (shift > 70n) throw new Error('protobuf varint too long');
  }
  throw new Error('unterminated protobuf varint');
}

export function str(bytes) { return Buffer.from(bytes).toString('utf8'); }
export function hex(bytes) { return Buffer.from(bytes).toString('hex'); }
export function double(bytes) { return Buffer.from(bytes).readDoubleLE(0); }
export function bool(v) { return v !== 0n; }
export function first(fields, n) { return fields.find(f => f.fieldNo === n); }
export function all(fields, n) { return fields.filter(f => f.fieldNo === n); }

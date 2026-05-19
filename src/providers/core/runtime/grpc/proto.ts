/**
 * Protobuf wire format codec — zero-dependency, schema-less.
 * Ported from WindsurfAPI/src/proto.js (Apache-2.0).
 */

export function encodeVarint(value: number | bigint): Buffer {
  const bytes: number[] = [];
  if (typeof value === 'bigint' || value < 0 || value > 0x7FFFFFFF) {
    let b = (typeof value === 'bigint' ? value : BigInt(value)) & 0xFFFFFFFFFFFFFFFFn;
    while (true) {
      const byte = Number(b & 0x7Fn);
      b >>= 7n;
      if (b === 0n) { bytes.push(byte); break; }
      bytes.push(byte | 0x80);
    }
    return Buffer.from(bytes);
  }
  let v = Number(value);
  do {
    let byte = v & 0x7F;
    v >>>= 7;
    if (v > 0) byte |= 0x80;
    bytes.push(byte);
  } while (v > 0);
  return Buffer.from(bytes);
}

export function decodeVarint(buf: Buffer, offset = 0): { value: number | bigint; length: number } {
  let result = 0, shift = 0, pos = offset;
  while (pos < buf.length && shift < 28) {
    const byte = buf[pos++];
    result |= (byte & 0x7F) << shift;
    if (!(byte & 0x80)) return { value: result >>> 0, length: pos - offset };
    shift += 7;
  }
  if (pos >= buf.length) throw new Error('Truncated varint');
  let big = BigInt(result >>> 0);
  let bigShift = BigInt(shift);
  while (pos < buf.length) {
    const byte = buf[pos++];
    big |= BigInt(byte & 0x7F) << bigShift;
    if (!(byte & 0x80)) {
      const asNum = Number(big);
      return { value: Number.isSafeInteger(asNum) ? asNum : big, length: pos - offset };
    }
    bigShift += 7n;
    if (bigShift >= 64n) throw new Error('Varint overflow');
  }
  throw new Error('Truncated varint');
}

function makeTag(field: number, wireType: number): Buffer {
  return encodeVarint((field << 3) | wireType);
}

export function writeVarintField(field: number, value: number): Buffer {
  return Buffer.concat([makeTag(field, 0), encodeVarint(value)]);
}

export function writeStringField(field: number, str: string): Buffer {
  if (!str && str !== '') return Buffer.alloc(0);
  const data = Buffer.from(str, 'utf-8');
  return Buffer.concat([makeTag(field, 2), encodeVarint(data.length), data]);
}

export function writeBytesField(field: number, data: Buffer | string): Buffer {
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data as string);
  return Buffer.concat([makeTag(field, 2), encodeVarint(buf.length), buf]);
}

export function writeMessageField(field: number, msgBuf: Buffer): Buffer {
  if (!msgBuf || msgBuf.length === 0) return Buffer.alloc(0);
  return Buffer.concat([makeTag(field, 2), encodeVarint(msgBuf.length), msgBuf]);
}

export function writeBoolField(field: number, value: boolean): Buffer {
  if (!value) return Buffer.alloc(0);
  return writeVarintField(field, 1);
}

export interface ProtoField {
  field: number;
  wireType: number;
  value: number | bigint | Buffer;
}

export function parseFields(buf: Buffer): ProtoField[] {
  const fields: ProtoField[] = [];
  let pos = 0;
  while (pos < buf.length) {
    const tag = decodeVarint(buf, pos);
    pos += tag.length;
    const tagVal = Number(tag.value);
    const fieldNum = tagVal >>> 3;
    const wireType = tagVal & 0x07;
    if (wireType === 0) {
      const val = decodeVarint(buf, pos);
      pos += val.length;
      fields.push({ field: fieldNum, wireType, value: val.value });
    } else if (wireType === 2) {
      const len = decodeVarint(buf, pos);
      pos += len.length;
      const data = buf.subarray(pos, pos + Number(len.value));
      pos += Number(len.value);
      fields.push({ field: fieldNum, wireType, value: data });
    } else if (wireType === 1) {
      fields.push({ field: fieldNum, wireType, value: buf.subarray(pos, pos + 8) });
      pos += 8;
    } else if (wireType === 5) {
      fields.push({ field: fieldNum, wireType, value: buf.subarray(pos, pos + 4) });
      pos += 4;
    } else {
      throw new Error('Unsupported wire type ' + wireType + ' at pos ' + pos);
    }
  }
  return fields;
}

export function getField(fields: ProtoField[], fieldNum: number, wireType: number): ProtoField | undefined {
  return fields.find(f => f.field === fieldNum && f.wireType === wireType);
}

export function getAllFields(fields: ProtoField[], fieldNum: number, wireType?: number): ProtoField[] {
  return fields.filter(f => f.field === fieldNum && (wireType === undefined || f.wireType === wireType));
}

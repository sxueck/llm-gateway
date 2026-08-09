// Minimal NumPy .npy reader for the SetFit classification head weights
// (`head_coef.npy` shape [num_classes, hidden] and `head_intercept.npy` shape
// [num_classes]). Supports little/big-endian float32 and float64, which covers
// the artifacts shipped by `snival/intent-router-zh-setfit-v1`.

export interface NpyArray {
  shape: number[];
  data: Float64Array;
}

const MAGIC = Buffer.from([0x93, 0x4e, 0x55, 0x4d, 0x50, 0x59]); // \x93NUMPY

export function parseNpy(buffer: Buffer): NpyArray {
  for (let i = 0; i < MAGIC.length; i++) {
    if (buffer[i] !== MAGIC[i]) {
      throw new Error('Invalid .npy file: magic bytes mismatch');
    }
  }

  let offset = MAGIC.length;
  const major = buffer[offset];
  const minor = buffer[offset + 1];
  offset += 2;

  let headerLen: number;
  if (major === 1) {
    headerLen = buffer.readUInt16LE(offset);
    offset += 2;
  } else if (major >= 2) {
    headerLen = buffer.readUInt32LE(offset);
    offset += 4;
  } else {
    throw new Error(`Unsupported .npy version: ${major}.${minor}`);
  }

  const header = buffer.subarray(offset, offset + headerLen).toString('latin1');
  offset += headerLen;

  const { dtype, shape, fortranOrder } = parseHeader(header);
  if (fortranOrder) {
    throw new Error('Fortran-ordered .npy arrays are not supported');
  }

  const count = shape.reduce((a, b) => a * b, 1);
  const data = readValues(buffer, offset, dtype, count);

  return { shape, data };
}

interface HeaderInfo {
  dtype: string;
  shape: number[];
  fortranOrder: boolean;
}

function parseHeader(header: string): HeaderInfo {
  // Header is a Python dict literal, e.g.:
  // "{'descr': '<f4', 'fortran_order': False, 'shape': (21, 1024), }"
  const descrMatch = header.match(/'descr':\s*'([^']+)'/);
  const fortranMatch = header.match(/'fortran_order':\s*(True|False)/);
  const shapeMatch = header.match(/'shape':\s*\(([^)]*)\)/);

  if (!descrMatch || !fortranMatch || !shapeMatch) {
    throw new Error(`Unparseable .npy header: ${header}`);
  }

  const shapeStr = shapeMatch[1].trim();
  // numpy writes tuples with trailing commas, e.g. "(2, 3,)" or "(21, 1024,)";
  // filter empty segments so they don't parse to NaN.
  const shape = shapeStr
    ? shapeStr
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s.length > 0)
        .map((s) => Number.parseInt(s, 10))
    : [];

  return {
    dtype: descrMatch[1],
    shape,
    fortranOrder: fortranMatch[1] === 'True',
  };
}

function readValues(buffer: Buffer, offset: number, dtype: string, count: number): Float64Array {
  const littleEndian = !dtype.startsWith('>');
  const code = dtype.slice(-2);
  if (!littleEndian) {
    throw new Error(`Big-endian .npy not supported (dtype ${dtype})`);
  }

  const out = new Float64Array(count);

  if (code === 'f4') {
    for (let i = 0; i < count; i++) {
      out[i] = buffer.readFloatLE(offset + i * 4);
    }
    return out;
  }

  if (code === 'f8') {
    for (let i = 0; i < count; i++) {
      out[i] = buffer.readDoubleLE(offset + i * 8);
    }
    return out;
  }

  throw new Error(`Unsupported .npy dtype: ${dtype} (only f4/f8)`);
}

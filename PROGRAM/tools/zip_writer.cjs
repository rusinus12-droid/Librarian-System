'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const ZIP_LOCAL_SIGNATURE = 0x04034b50;
const ZIP_CENTRAL_SIGNATURE = 0x02014b50;
const ZIP_EOCD_SIGNATURE = 0x06054b50;
const ZIP_UTF8_FLAG = 0x0800;
const ZIP_DEFLATE = 8;
const ZIP_VERSION = 20;
const ZIP_UNIX_VERSION = (3 << 8) | ZIP_VERSION;
const ZIP_MAX_32 = 0xffffffff;
const ZIP_MAX_READBACK_ENTRY_BYTES = 512 * 1024 * 1024;
const ZIP_MAX_READBACK_TOTAL_BYTES = 2 * 1024 * 1024 * 1024;

const crcTable = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0);
    table[index] = value >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let value = 0xffffffff;
  for (const byte of buffer) value = crcTable[(value ^ byte) & 0xff] ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function fsyncDirectory(directoryPath) {
  let fd = null;
  try {
    fd = fs.openSync(directoryPath, 'r');
    fs.fsyncSync(fd);
  } catch (_) {
    // Windows and some virtual filesystems do not permit directory fsync.
  } finally {
    if (fd != null) try { fs.closeSync(fd); } catch (_) {}
  }
}

function normalizeArchivePath(value) {
  const normalized = String(value || '').replace(/\\/g, '/').replace(/^\.\//, '');
  if (!normalized || normalized.startsWith('/') || /^[A-Za-z]:\//.test(normalized)) {
    throw new Error(`zip_archive_path_must_be_relative:${value}`);
  }
  const parts = normalized.split('/');
  if (parts.some(part => !part || part === '.' || part === '..')) throw new Error(`zip_archive_path_is_unsafe:${value}`);
  if (parts.some(part => /[\x00-\x1f\x7f]/.test(part))) throw new Error(`zip_archive_path_has_control_character:${value}`);
  for (const part of parts) {
    if (/[<>:"|?*]/.test(part) || /[. ]$/.test(part)) throw new Error(`zip_archive_path_is_not_windows_portable:${value}`);
    const stem = part.split('.')[0].toUpperCase();
    if (/^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/.test(stem)) {
      throw new Error(`zip_archive_path_is_not_windows_portable:${value}`);
    }
  }
  return parts.join('/');
}

function portableArchivePathKey(value) {
  return normalizeArchivePath(value).normalize('NFC').toLocaleLowerCase('en-US');
}

function listFiles(rootDir) {
  const root = path.resolve(rootDir);
  const rows = [];
  const walk = current => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const fullPath = path.join(current, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`zip_symbolic_link_is_not_allowed:${fullPath}`);
      if (entry.isDirectory()) walk(fullPath);
      else if (entry.isFile()) rows.push(fullPath);
      else throw new Error(`zip_unsupported_file_type:${fullPath}`);
    }
  };
  walk(root);
  return rows.sort((left, right) => path.relative(root, left).localeCompare(path.relative(root, right), 'en'));
}

function unixModeFor(relativePath) {
  return /(?:^|\/)[^/]+\.(?:sh|command)$/i.test(relativePath) ? 0o100755 : 0o100644;
}

function dosDateTime(dateValue) {
  const date = dateValue instanceof Date && Number.isFinite(dateValue.getTime()) ? dateValue : new Date();
  const year = Math.max(1980, Math.min(2107, date.getFullYear()));
  const month = Math.max(1, Math.min(12, date.getMonth() + 1));
  const day = Math.max(1, Math.min(31, date.getDate()));
  const hour = Math.max(0, Math.min(23, date.getHours()));
  const minute = Math.max(0, Math.min(59, date.getMinutes()));
  const second = Math.max(0, Math.min(59, date.getSeconds()));
  return {
    time: ((hour << 11) | (minute << 5) | Math.floor(second / 2)) & 0xffff,
    date: (((year - 1980) << 9) | (month << 5) | day) & 0xffff
  };
}

function createZipFromDirectory(sourceDir, archivePath, options = {}) {
  const root = path.resolve(sourceDir);
  const destination = path.resolve(archivePath);
  if (!fs.statSync(root).isDirectory()) throw new Error(`zip_source_is_not_directory:${root}`);
  const rootName = options.rootName ? normalizeArchivePath(options.rootName) : '';
  const files = listFiles(root);
  if (files.length === 0) throw new Error(`zip_source_has_no_files:${root}`);
  const localParts = [];
  const centralParts = [];
  const manifest = [];
  const portableNames = new Set();
  let localOffset = 0;

  for (const filePath of files) {
    const sourceRelative = path.relative(root, filePath).split(path.sep).join('/');
    const archiveName = normalizeArchivePath(rootName ? `${rootName}/${sourceRelative}` : sourceRelative);
    const portableName = portableArchivePathKey(archiveName);
    if (portableNames.has(portableName)) throw new Error(`zip_portable_name_collision:${archiveName}`);
    portableNames.add(portableName);
    const nameBytes = Buffer.from(archiveName, 'utf8');
    if (nameBytes.length > 0xffff) throw new Error(`zip_entry_name_is_too_long:${archiveName}`);
    const bytes = fs.readFileSync(filePath);
    const compressed = zlib.deflateRawSync(bytes, { level: 9 });
    const crc = crc32(bytes);
    const stats = fs.statSync(filePath);
    const timestamp = dosDateTime(options.timestamp || stats.mtime);
    const mode = unixModeFor(archiveName);
    if (bytes.length > ZIP_MAX_32 || compressed.length > ZIP_MAX_32 || localOffset > ZIP_MAX_32) {
      throw new Error(`zip64_is_not_supported:${archiveName}`);
    }

    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(ZIP_LOCAL_SIGNATURE, 0);
    localHeader.writeUInt16LE(ZIP_VERSION, 4);
    localHeader.writeUInt16LE(ZIP_UTF8_FLAG, 6);
    localHeader.writeUInt16LE(ZIP_DEFLATE, 8);
    localHeader.writeUInt16LE(timestamp.time, 10);
    localHeader.writeUInt16LE(timestamp.date, 12);
    localHeader.writeUInt32LE(crc, 14);
    localHeader.writeUInt32LE(compressed.length, 18);
    localHeader.writeUInt32LE(bytes.length, 22);
    localHeader.writeUInt16LE(nameBytes.length, 26);
    localHeader.writeUInt16LE(0, 28);
    localParts.push(localHeader, nameBytes, compressed);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(ZIP_CENTRAL_SIGNATURE, 0);
    centralHeader.writeUInt16LE(ZIP_UNIX_VERSION, 4);
    centralHeader.writeUInt16LE(ZIP_VERSION, 6);
    centralHeader.writeUInt16LE(ZIP_UTF8_FLAG, 8);
    centralHeader.writeUInt16LE(ZIP_DEFLATE, 10);
    centralHeader.writeUInt16LE(timestamp.time, 12);
    centralHeader.writeUInt16LE(timestamp.date, 14);
    centralHeader.writeUInt32LE(crc, 16);
    centralHeader.writeUInt32LE(compressed.length, 20);
    centralHeader.writeUInt32LE(bytes.length, 24);
    centralHeader.writeUInt16LE(nameBytes.length, 28);
    centralHeader.writeUInt16LE(0, 30);
    centralHeader.writeUInt16LE(0, 32);
    centralHeader.writeUInt16LE(0, 34);
    centralHeader.writeUInt16LE(0, 36);
    centralHeader.writeUInt32LE((mode << 16) >>> 0, 38);
    centralHeader.writeUInt32LE(localOffset, 42);
    centralParts.push(centralHeader, nameBytes);

    manifest.push({ archiveName, sourceRelative, bytes: bytes.length, sha256: sha256(bytes), mode });
    localOffset += localHeader.length + nameBytes.length + compressed.length;
  }

  const centralBuffer = Buffer.concat(centralParts);
  if (manifest.length > 0xffff || centralBuffer.length > ZIP_MAX_32 || localOffset > ZIP_MAX_32) {
    throw new Error('zip64_is_not_supported_for_this_archive');
  }
  const end = Buffer.alloc(22);
  end.writeUInt32LE(ZIP_EOCD_SIGNATURE, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(manifest.length, 8);
  end.writeUInt16LE(manifest.length, 10);
  end.writeUInt32LE(centralBuffer.length, 12);
  end.writeUInt32LE(localOffset, 16);
  end.writeUInt16LE(0, 20);

  fs.mkdirSync(path.dirname(destination), { recursive: true });
  if (fs.existsSync(destination)) throw new Error(`zip_destination_already_exists:${destination}`);
  const temporary = `${destination}.${process.pid}.${crypto.randomBytes(5).toString('hex')}.tmp`;
  let fd = null;
  try {
    const archiveBytes = Buffer.concat([...localParts, centralBuffer, end]);
    fd = fs.openSync(temporary, 'wx', 0o600);
    let offset = 0;
    while (offset < archiveBytes.length) offset += fs.writeSync(fd, archiveBytes, offset, archiveBytes.length - offset);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;
    fs.renameSync(temporary, destination);
    fsyncDirectory(path.dirname(destination));
  } catch (error) {
    if (fd != null) try { fs.closeSync(fd); } catch (_) {}
    try { fs.rmSync(temporary, { force: true }); } catch (_) {}
    throw error;
  }
  return { archivePath: destination, files: manifest, bytes: fs.statSync(destination).size, sha256: sha256(fs.readFileSync(destination)) };
}

function findEndOfCentralDirectory(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 22) throw new Error('zip_file_is_too_short');
  const minimum = Math.max(0, buffer.length - 0xffff - 22);
  for (let offset = buffer.length - 22; offset >= minimum; offset -= 1) {
    if (buffer.readUInt32LE(offset) !== ZIP_EOCD_SIGNATURE) continue;
    const commentLength = buffer.readUInt16LE(offset + 20);
    if (offset + 22 + commentLength === buffer.length) return offset;
  }
  throw new Error('zip_end_of_central_directory_not_found');
}

function readZipEntries(archivePath) {
  const archive = fs.readFileSync(archivePath);
  const endOffset = findEndOfCentralDirectory(archive);
  const diskNumber = archive.readUInt16LE(endOffset + 4);
  const centralDiskNumber = archive.readUInt16LE(endOffset + 6);
  const entriesOnDisk = archive.readUInt16LE(endOffset + 8);
  const entryCount = archive.readUInt16LE(endOffset + 10);
  const centralSize = archive.readUInt32LE(endOffset + 12);
  const centralOffset = archive.readUInt32LE(endOffset + 16);
  if (diskNumber !== 0 || centralDiskNumber !== 0 || entriesOnDisk !== entryCount) {
    throw new Error('zip_multidisk_is_not_supported');
  }
  if (entryCount === 0xffff || centralSize === ZIP_MAX_32 || centralOffset === ZIP_MAX_32) {
    throw new Error('zip64_is_not_supported_for_readback');
  }
  if (centralOffset + centralSize !== endOffset) throw new Error('zip_central_directory_bounds_invalid');
  const rows = [];
  const names = new Set();
  const portableNames = new Set();
  const localRanges = [];
  let totalUncompressedBytes = 0;
  let cursor = centralOffset;
  for (let index = 0; index < entryCount; index += 1) {
    if (cursor + 46 > endOffset) throw new Error(`zip_central_header_bounds_invalid:${index}`);
    if (archive.readUInt32LE(cursor) !== ZIP_CENTRAL_SIGNATURE) throw new Error(`zip_central_signature_invalid:${index}`);
    const flags = archive.readUInt16LE(cursor + 8);
    const method = archive.readUInt16LE(cursor + 10);
    const expectedCrc = archive.readUInt32LE(cursor + 16);
    const compressedSize = archive.readUInt32LE(cursor + 20);
    const uncompressedSize = archive.readUInt32LE(cursor + 24);
    const nameLength = archive.readUInt16LE(cursor + 28);
    const extraLength = archive.readUInt16LE(cursor + 30);
    const commentLength = archive.readUInt16LE(cursor + 32);
    const externalAttributes = archive.readUInt32LE(cursor + 38);
    const localOffset = archive.readUInt32LE(cursor + 42);
    const centralEnd = cursor + 46 + nameLength + extraLength + commentLength;
    if (centralEnd > endOffset) throw new Error(`zip_central_entry_bounds_invalid:${index}`);
    const centralNameBytes = archive.subarray(cursor + 46, cursor + 46 + nameLength);
    const name = centralNameBytes.toString('utf8');
    if (!Buffer.from(name, 'utf8').equals(centralNameBytes)) throw new Error(`zip_entry_name_is_not_valid_utf8:${index}`);
    normalizeArchivePath(name);
    if ((flags & ZIP_UTF8_FLAG) === 0) throw new Error(`zip_entry_is_not_utf8:${name}`);
    if ((flags & 0x0001) !== 0) throw new Error(`zip_encrypted_entry_is_not_supported:${name}`);
    if (method !== ZIP_DEFLATE && method !== 0) throw new Error(`zip_compression_method_unsupported:${name}:${method}`);
    if (names.has(name)) throw new Error(`zip_duplicate_entry:${name}`);
    names.add(name);
    const portableName = portableArchivePathKey(name);
    if (portableNames.has(portableName)) throw new Error(`zip_portable_name_collision:${name}`);
    portableNames.add(portableName);
    if (uncompressedSize > ZIP_MAX_READBACK_ENTRY_BYTES) throw new Error(`zip_entry_exceeds_readback_limit:${name}`);
    totalUncompressedBytes += uncompressedSize;
    if (totalUncompressedBytes > ZIP_MAX_READBACK_TOTAL_BYTES) throw new Error('zip_archive_exceeds_readback_limit');
    if (localOffset + 30 > centralOffset) throw new Error(`zip_local_header_bounds_invalid:${name}`);
    if (archive.readUInt32LE(localOffset) !== ZIP_LOCAL_SIGNATURE) throw new Error(`zip_local_signature_invalid:${name}`);
    const localFlags = archive.readUInt16LE(localOffset + 6);
    const localMethod = archive.readUInt16LE(localOffset + 8);
    const localCrc = archive.readUInt32LE(localOffset + 14);
    const localCompressedSize = archive.readUInt32LE(localOffset + 18);
    const localUncompressedSize = archive.readUInt32LE(localOffset + 22);
    const localNameLength = archive.readUInt16LE(localOffset + 26);
    const localExtraLength = archive.readUInt16LE(localOffset + 28);
    const localNameStart = localOffset + 30;
    const localNameEnd = localNameStart + localNameLength;
    const dataOffset = localOffset + 30 + localNameLength + localExtraLength;
    const dataEnd = dataOffset + compressedSize;
    if (localNameEnd > centralOffset || dataOffset > centralOffset || dataEnd > centralOffset) {
      throw new Error(`zip_local_entry_bounds_invalid:${name}`);
    }
    const localNameBytes = archive.subarray(localNameStart, localNameEnd);
    if (!localNameBytes.equals(centralNameBytes)) throw new Error(`zip_local_name_mismatch:${name}`);
    if (localFlags !== flags || localMethod !== method || localCrc !== expectedCrc
      || localCompressedSize !== compressedSize || localUncompressedSize !== uncompressedSize) {
      throw new Error(`zip_local_metadata_mismatch:${name}`);
    }
    const compressed = archive.subarray(dataOffset, dataOffset + compressedSize);
    const bytes = method === ZIP_DEFLATE
      ? zlib.inflateRawSync(compressed, { maxOutputLength: Math.max(1, uncompressedSize) })
      : compressed;
    if (bytes.length !== uncompressedSize) throw new Error(`zip_uncompressed_size_mismatch:${name}`);
    if (crc32(bytes) !== expectedCrc) throw new Error(`zip_crc_mismatch:${name}`);
    rows.push({ name, bytes, sha256: sha256(bytes), mode: externalAttributes >>> 16, flags, method });
    localRanges.push({ start: localOffset, end: dataEnd, name });
    cursor = centralEnd;
  }
  if (cursor !== centralOffset + centralSize) throw new Error('zip_central_directory_size_mismatch');
  localRanges.sort((left, right) => left.start - right.start);
  if (localRanges.length && localRanges[0].start !== 0) throw new Error('zip_local_entries_have_prefix_data');
  for (let index = 1; index < localRanges.length; index += 1) {
    if (localRanges[index].start < localRanges[index - 1].end) {
      throw new Error(`zip_local_entries_overlap:${localRanges[index - 1].name}:${localRanges[index].name}`);
    }
    if (localRanges[index].start !== localRanges[index - 1].end) {
      throw new Error(`zip_local_entries_have_gap:${localRanges[index - 1].name}:${localRanges[index].name}`);
    }
  }
  if (localRanges.length && localRanges[localRanges.length - 1].end !== centralOffset) {
    throw new Error('zip_local_entries_do_not_reach_central_directory');
  }
  return rows;
}

function verifyZipAgainstDirectory(archivePath, sourceDir, options = {}) {
  const root = path.resolve(sourceDir);
  const rootName = options.rootName ? normalizeArchivePath(options.rootName) : '';
  const expected = new Map(listFiles(root).map(filePath => {
    const relative = path.relative(root, filePath).split(path.sep).join('/');
    const archiveName = normalizeArchivePath(rootName ? `${rootName}/${relative}` : relative);
    const bytes = fs.readFileSync(filePath);
    return [archiveName, { sha256: sha256(bytes), mode: unixModeFor(archiveName) }];
  }));
  const entries = readZipEntries(archivePath);
  if (entries.length !== expected.size) throw new Error(`zip_entry_count_mismatch:${entries.length}!=${expected.size}`);
  for (const entry of entries) {
    const wanted = expected.get(entry.name);
    if (!wanted) throw new Error(`zip_unexpected_entry:${entry.name}`);
    if (entry.sha256 !== wanted.sha256) throw new Error(`zip_content_digest_mismatch:${entry.name}`);
    if (entry.mode !== wanted.mode) throw new Error(`zip_unix_mode_mismatch:${entry.name}:${entry.mode.toString(8)}!=${wanted.mode.toString(8)}`);
    expected.delete(entry.name);
  }
  if (expected.size) throw new Error(`zip_missing_entries:${[...expected.keys()].join(',')}`);
  return { ok: true, files: entries.length, archiveSha256: sha256(fs.readFileSync(archivePath)) };
}

module.exports = {
  crc32,
  createZipFromDirectory,
  readZipEntries,
  verifyZipAgainstDirectory,
  unixModeFor
};

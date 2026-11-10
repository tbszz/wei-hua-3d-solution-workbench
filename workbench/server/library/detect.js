// File-format recognition by extension and magic bytes.
import path from 'node:path';

export const MODEL_FORMATS = new Set(['glb', 'gltf', 'obj', 'stl', 'ply', 'fbx', 'dae', '3mf', 'step', 'iges', 'brep']);
export const SITE_FORMATS = new Set(['dxf', 'dwg']);
export const IMAGE_FORMATS = new Set(['png', 'jpg', 'webp']);
export const DOCUMENT_FORMATS = new Set(['pdf', 'docx', 'doc', 'xlsx', 'xls', 'pptx', 'ppt', 'txt', 'csv', 'md', 'json', 'gif', 'bmp', 'tif']);

const EXT_ALIASES = {
  stp: 'step', step: 'step', p21: 'step', igs: 'iges', iges: 'iges', brep: 'brep', brp: 'brep',
  jpeg: 'jpg', jpg: 'jpg', tiff: 'tif', tif: 'tif', markdown: 'md',
};
const OFFICE_ZIPS = new Set(['docx', 'xlsx', 'pptx']);

export function extOf(filename = '') {
  const ext = path.extname(String(filename)).slice(1).toLowerCase();
  return EXT_ALIASES[ext] ?? ext;
}

const startsWith = (buffer, text, offset = 0) => buffer.length >= offset + text.length && buffer.toString('latin1', offset, offset + text.length) === text;

function headText(buffer, length = 4096) {
  return buffer.toString('latin1', 0, Math.min(buffer.length, length));
}

function isBinaryStl(buffer) {
  if (buffer.length < 84) return false;
  const faces = buffer.readUInt32LE(80);
  return buffer.length === 84 + faces * 50;
}

// Returns the format implied by content, or null when the bytes are not decisive.
export function sniff(buffer) {
  if (!buffer?.length) return null;
  if (startsWith(buffer, 'glTF')) return 'glb';
  if (startsWith(buffer, 'PK\x03\x04') || startsWith(buffer, 'PK\x05\x06')) return 'zip';
  if (startsWith(buffer, '%PDF')) return 'pdf';
  if (startsWith(buffer, 'Kaydara FBX Binary')) return 'fbx';
  if (/^AC1\d{3}/.test(buffer.toString('latin1', 0, 6))) return 'dwg';
  if (startsWith(buffer, '\x89PNG\r\n\x1a\n')) return 'png';
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'jpg';
  if (startsWith(buffer, 'RIFF') && startsWith(buffer, 'WEBP', 8)) return 'webp';
  if (startsWith(buffer, 'GIF8')) return 'gif';
  if (startsWith(buffer, 'BM') && buffer.length > 26 && buffer.readUInt32LE(2) === buffer.length) return 'bmp';
  if (startsWith(buffer, 'AutoCAD Binary DXF')) return 'dxf';
  if (startsWith(buffer, '\xd0\xcf\x11\xe0')) return 'ole'; // legacy .doc/.xls
  if (isBinaryStl(buffer)) return 'stl';
  const head = headText(buffer).replace(/^﻿|^\xef\xbb\xbf/, '');
  const trimmed = head.trimStart();
  if (trimmed.startsWith('ISO-10303-21')) return 'step';
  if (/^ply\r?\n/.test(trimmed)) return 'ply';
  if (/^solid[ \t\r\n]/.test(trimmed) && /facet\s+normal|endsolid/.test(headText(buffer, 1 << 16))) return 'stl';
  if (/^;\s*FBX/.test(trimmed) || trimmed.startsWith('FBXHeaderExtension')) return 'fbx';
  if (/<COLLADA[\s>]/.test(head)) return 'dae';
  if (/^0\s*\r?\n\s*SECTION\s*\r?\n/.test(trimmed) || /^999\s*\r?\n/.test(trimmed)) return 'dxf';
  if (trimmed.startsWith('{') && /"asset"\s*:/.test(headText(buffer, 1 << 16))) return 'gltf';
  if (/^DBRep_DrawableShape|^CASCADE Topology/.test(trimmed)) return 'brep';
  const lines = head.split(/\r?\n/).filter(Boolean);
  if (lines.length >= 2 && lines.slice(0, 3).every((line) => line.length >= 73 && /[SG]\s*\d+\s*$/.test(line.slice(72)))) return 'iges';
  return null;
}

// Text-like formats where content sniffing is weak; accept the extension if bytes look textual.
const TEXTUAL = new Set(['obj', 'txt', 'csv', 'md', 'json', 'gltf', 'dae', 'dxf', 'iges', 'stl', 'ply', 'brep', 'step']);

function looksTextual(buffer) {
  const sample = buffer.subarray(0, Math.min(buffer.length, 4096));
  let control = 0;
  for (const byte of sample) if (byte < 9 || (byte > 13 && byte < 32)) control += 1;
  return control <= sample.length * 0.02;
}

// Decide { format, detectedBy } from filename and bytes. Content wins over a mismatching extension.
export function detectFormat(filename, buffer) {
  const ext = extOf(filename);
  const magic = sniff(buffer);
  if (magic === 'zip') {
    if (ext === '3mf') return { format: '3mf', detectedBy: 'magic+ext' };
    if (OFFICE_ZIPS.has(ext)) return { format: ext, detectedBy: 'magic+ext' };
    return { format: 'zip', detectedBy: ext === 'zip' ? 'magic+ext' : 'magic' };
  }
  if (magic === 'ole') return { format: ['doc', 'xls', 'ppt'].includes(ext) ? ext : 'doc', detectedBy: 'magic' };
  if (magic) return { format: magic, detectedBy: magic === ext ? 'magic+ext' : 'magic' };
  if (ext && TEXTUAL.has(ext) && looksTextual(buffer)) return { format: ext, detectedBy: 'ext' };
  if (ext === 'obj') return { format: 'obj', detectedBy: 'ext' };
  if (ext && (MODEL_FORMATS.has(ext) || SITE_FORMATS.has(ext) || IMAGE_FORMATS.has(ext) || DOCUMENT_FORMATS.has(ext))) {
    return { format: ext, detectedBy: 'ext', suspicious: true };
  }
  if (looksTextual(buffer) && /^\s*(#.*\r?\n\s*)*(v|o|g|mtllib)\s/m.test(headText(buffer))) return { format: 'obj', detectedBy: 'content' };
  return { format: ext || 'unknown', detectedBy: 'none', unknown: true };
}

export function kindOf(format) {
  if (MODEL_FORMATS.has(format)) return 'model';
  if (SITE_FORMATS.has(format)) return 'site';
  if (IMAGE_FORMATS.has(format)) return 'image';
  if (DOCUMENT_FORMATS.has(format) || ['doc', 'xls', 'ppt'].includes(format)) return 'document';
  if (format === 'zip') return 'zip';
  return null;
}

const MIMES = { png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif' };

// Width/height of png/jpeg/webp/gif without decoding pixels.
export function imageInfo(buffer) {
  const format = sniff(buffer);
  try {
    if (format === 'png') return { mime: MIMES.png, width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
    if (format === 'gif') return { mime: MIMES.gif, width: buffer.readUInt16LE(6), height: buffer.readUInt16LE(8) };
    if (format === 'webp') {
      const chunk = buffer.toString('latin1', 12, 16);
      if (chunk === 'VP8X') return { mime: MIMES.webp, width: 1 + buffer.readUIntLE(24, 3), height: 1 + buffer.readUIntLE(27, 3) };
      if (chunk === 'VP8 ') return { mime: MIMES.webp, width: buffer.readUInt16LE(26) & 0x3fff, height: buffer.readUInt16LE(28) & 0x3fff };
      if (chunk === 'VP8L') {
        const bits = buffer.readUInt32LE(21);
        return { mime: MIMES.webp, width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
      }
      return { mime: MIMES.webp };
    }
    if (format === 'jpg') {
      let offset = 2;
      while (offset + 9 < buffer.length) {
        if (buffer[offset] !== 0xff) { offset += 1; continue; }
        const marker = buffer[offset + 1];
        const length = buffer.readUInt16BE(offset + 2);
        if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
          return { mime: MIMES.jpg, height: buffer.readUInt16BE(offset + 5), width: buffer.readUInt16BE(offset + 7) };
        }
        offset += 2 + length;
      }
      return { mime: MIMES.jpg };
    }
  } catch {
    return format && MIMES[format] ? { mime: MIMES[format] } : null;
  }
  return null;
}

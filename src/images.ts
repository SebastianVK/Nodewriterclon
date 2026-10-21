import Dexie, { type Table } from 'dexie';
import { uid } from './types';
import type { BackupImage } from './backup';

export interface ImageRec {
  id: string;
  blob: Blob;
  mime: string;
  ext: string;
  name: string;
  w: number;
  h: number;
  createdAt: string;
}

class ImageDB extends Dexie {
  images!: Table<ImageRec, string>;
  constructor() {
    super('storygraph-images');
    this.version(1).stores({ images: 'id, createdAt' });
  }
}

const db = new ImageDB();

const MAX_DIM = 1600;
const QUALITY = 0.85;
const IMG_ID = /[A-Za-z0-9_-]+/;

function extFor(mime: string): string {
  if (mime === 'image/jpeg') return 'jpg';
  if (mime === 'image/webp') return 'webp';
  if (mime === 'image/gif') return 'gif';
  return 'png';
}

/** Ids `img://id` referenciados en un texto/markdown. */
export function collectImgIds(text: string): string[] {
  const out = new Set<string>();
  for (const m of (text || '').matchAll(/img:\/\/([A-Za-z0-9_-]+)/g)) {
    if (IMG_ID.test(m[1])) out.add(m[1]);
  }
  return [...out];
}

async function readSize(blob: Blob): Promise<{ w: number; h: number }> {
  try {
    const bmp = await createImageBitmap(blob);
    const s = { w: bmp.width, h: bmp.height };
    bmp.close();
    return s;
  } catch {
    return { w: 0, h: 0 };
  }
}

async function toBlob(canvas: HTMLCanvasElement, mime: string): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob(resolve, mime, QUALITY));
}

/** Redimensiona a máx. 1600px y convierte a WebP/JPEG. Los GIF se conservan. */
async function compress(file: File): Promise<{ blob: Blob; mime: string; w: number; h: number }> {
  if (file.type === 'image/gif') {
    const { w, h } = await readSize(file);
    return { blob: file, mime: file.type, w, h };
  }
  let w = 0;
  let h = 0;
  try {
    const bmp = await createImageBitmap(file);
    w = bmp.width;
    h = bmp.height;
    const scale = Math.min(1, MAX_DIM / Math.max(w, h));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(w * scale));
    canvas.height = Math.max(1, Math.round(h * scale));
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('sin canvas');
    ctx.drawImage(bmp, 0, 0, canvas.width, canvas.height);
    bmp.close();
    w = canvas.width;
    h = canvas.height;
    let blob = await toBlob(canvas, 'image/webp');
    if (!blob || blob.type !== 'image/webp') blob = await toBlob(canvas, 'image/jpeg');
    if (blob) return { blob, mime: blob.type, w, h };
  } catch {
    /* cae al original */
  }
  const size = await readSize(file);
  return { blob: file, mime: file.type || 'image/png', w: size.w, h: size.h };
}

export function isImageFile(f: File): boolean {
  return f.type.startsWith('image/') && f.type !== 'image/svg+xml';
}

/** Comprime y guarda una imagen; devuelve la referencia para el markdown. */
export async function putImage(file: File): Promise<{ id: string; name: string }> {
  if (!isImageFile(file)) throw new Error('Formato de imagen no soportado (SVG no permitido).');
  const { blob, mime, w, h } = await compress(file);
  const id = uid();
  const rec: ImageRec = { id, blob, mime, ext: extFor(mime), name: file.name, w, h, createdAt: new Date().toISOString() };
  await db.images.put(rec);
  return { id, name: file.name };
}

const urlCache = new Map<string, string>();

async function blobUrl(id: string): Promise<string | null> {
  const hit = urlCache.get(id);
  if (hit) return hit;
  const rec = await db.images.get(id);
  if (!rec) return null;
  const url = URL.createObjectURL(rec.blob);
  urlCache.set(id, url);
  return url;
}

/** objectURL de una imagen (con caché). */
export async function imageUrl(id: string): Promise<string | null> {
  return blobUrl(id);
}

/** Reemplaza `src="img://id"` por objectURL; si falta la imagen, elimina el <img>. */
export async function resolveImgRefs(html: string): Promise<string> {
  if (!html || !html.includes('img://')) return html;
  const ids = [...html.matchAll(/src="img:\/\/([A-Za-z0-9_-]+)"/g)].map((m) => m[1]);
  const map = new Map<string, string | null>();
  for (const id of new Set(ids)) map.set(id, await blobUrl(id));
  return html
    .replace(/<img[^>]*src="img:\/\/[A-Za-z0-9_-]+"[^>]*>/g, (tag) => {
      const id = tag.match(/src="img:\/\/([A-Za-z0-9_-]+)"/)?.[1] ?? '';
      const url = map.get(id) ?? null;
      return url ? tag.replace(`img://${id}`, url) : '';
    });
}

/** data URL (base64) de una imagen. */
async function blobToDataUrl(blob: Blob): Promise<string> {
  const buf = await blob.arrayBuffer();
  let bin = '';
  const bytes = new Uint8Array(buf);
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return `data:${blob.type || 'image/png'};base64,${btoa(bin)}`;
}

/** data URL (base64) de una imagen, para EPUB/impresión. */
export async function imageDataUrl(id: string): Promise<string | null> {
  const rec = await db.images.get(id);
  if (!rec) return null;
  return blobToDataUrl(rec.blob);
}

export interface ImageBlobMeta {
  dataUrl: string;
  mime: string;
  ext: string;
}

/** data URL + metadatos (EPUB). */
export async function imageData(id: string): Promise<ImageBlobMeta | null> {
  const rec = await db.images.get(id);
  if (!rec) return null;
  return { dataUrl: await blobToDataUrl(rec.blob), mime: rec.mime, ext: rec.ext };
}

export async function getImage(id: string): Promise<BackupImage | null> {
  const rec = await db.images.get(id);
  if (!rec) return null;
  return { id: rec.id, blob: rec.blob, mime: rec.mime, ext: rec.ext, name: rec.name, w: rec.w, h: rec.h };
}

export async function getImages(ids: string[]): Promise<BackupImage[]> {
  const out: BackupImage[] = [];
  for (const id of ids) {
    const img = await getImage(id);
    if (img) out.push(img);
  }
  return out;
}

/** Inserta imágenes importadas (del ZIP). No pisa existentes. */
export async function importImages(imgs: BackupImage[]): Promise<void> {
  for (const i of imgs) {
    const exists = await db.images.get(i.id);
    if (exists) continue;
    await db.images.put({
      id: i.id,
      blob: i.blob,
      mime: i.mime,
      ext: i.ext,
      name: i.name,
      w: i.w,
      h: i.h,
      createdAt: new Date().toISOString(),
    });
  }
}

/** Borra imágenes que ninguna tarjeta de ningún proyecto referencia. */
export async function purgeOrphans(validIds: Set<string>): Promise<void> {
  const keys = await db.images.toCollection().primaryKeys();
  const dead = keys.filter((k) => typeof k === 'string' && !validIds.has(k));
  if (dead.length) await db.images.bulkDelete(dead as string[]);
}

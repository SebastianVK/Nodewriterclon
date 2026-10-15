import JSZip from 'jszip';
import { cardLabel, markdownToHtml, wordCount, type Card } from './types';

function escXml(s: string): string {
  return (s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Contenido HTML del markdown, saneado para XHTML del EPUB. */
function chapterBody(card: Card, withSummaries: boolean): string {
  let html = markdownToHtml(card.content || '');
  html = html.replace(/ target="_blank" rel="noopener"/g, '');
  const summary = withSummaries && card.summary ? `<p><em>${escXml(card.summary)}</em></p>` : '';
  return `<?xml version="1.0" encoding="utf-8"?>\n<!DOCTYPE html>\n<html xmlns="http://www.w3.org/1999/xhtml">\n<head><title>${escXml(cardLabel(card))}</title></head>\n<body>\n<h1>${escXml(cardLabel(card))}</h1>\n${summary}\n${html || '<p></p>'}\n</body>\n</html>`;
}

export async function buildEpub(
  projectName: string,
  projectId: string,
  seq: Card[],
  withSummaries: boolean,
): Promise<Blob> {
  const body = seq.filter((c) => c.type !== 'start');
  const zip = new JSZip();
  zip.file('mimetype', 'application/epub+zip', { compression: 'STORE' });
  zip.file(
    'META-INF/container.xml',
    `<?xml version="1.0" encoding="utf-8"?>\n<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">\n  <rootfiles>\n    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>\n  </rootfiles>\n</container>`,
  );

  const items: string[] = [];
  const spine: string[] = [];
  const ncxNav: string[] = [];
  body.forEach((c, i) => {
    const n = i + 1;
    zip.file(`OEBPS/ch${n}.xhtml`, chapterBody(c, withSummaries));
    items.push(`    <item id="ch${n}" href="ch${n}.xhtml" media-type="application/xhtml+xml"/>`);
    spine.push(`    <itemref idref="ch${n}"/>`);
    ncxNav.push(
      `    <navPoint id="np${n}" playOrder="${n}"><navLabel><text>${escXml(cardLabel(c))}</text></navLabel><content src="ch${n}.xhtml"/></navPoint>`,
    );
  });

  const totalWords = body.reduce((n, c) => n + wordCount(c.content), 0);
  zip.file(
    'OEBPS/content.opf',
    `<?xml version="1.0" encoding="utf-8"?>\n<package version="2.0" unique-identifier="uid" xmlns="http://www.idpf.org/2007/opf">\n  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">\n    <dc:title>${escXml(projectName)}</dc:title>\n    <dc:language>es</dc:language>\n    <dc:identifier id="uid">storygraph-${escXml(projectId)}</dc:identifier>\n    <dc:description>${body.length} tarjetas, ${totalWords} palabras. Creado con StoryGraph.</dc:description>\n  </metadata>\n  <manifest>\n    <item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>\n${items.join('\n')}\n  </manifest>\n  <spine toc="ncx">\n${spine.join('\n')}\n  </spine>\n</package>`,
  );
  zip.file(
    'OEBPS/toc.ncx',
    `<?xml version="1.0" encoding="utf-8"?>\n<ncx version="2005-1" xmlns="http://www.daisy.org/z3986/2005/ncx/">\n  <head><meta name="dtb:uid" content="storygraph-${escXml(projectId)}"/></head>\n  <docTitle><text>${escXml(projectName)}</text></docTitle>\n  <navMap>\n${ncxNav.join('\n')}\n  </navMap>\n</ncx>`,
  );
  return zip.generateAsync({ type: 'blob', mimeType: 'application/epub+zip' });
}

/** Abre el documento en una ventana de impresión (para guardar como PDF). */
export function printDocument(projectName: string, seq: Card[], withSummaries: boolean): void {
  const body = seq.filter((c) => c.type !== 'start');
  const blocks = body
    .map(
      (c) =>
        `<section><h2>${escXml(cardLabel(c))}</h2>` +
        (withSummaries && c.summary ? `<p class="sum">${escXml(c.summary)}</p>` : '') +
        `${markdownToHtml(c.content || '')}</section>`,
    )
    .join('\n');
  const w = window.open('', '_blank', 'width=800,height=900');
  if (!w) return;
  w.document.write(
    `<!doctype html><html lang="es"><head><meta charset="utf-8"><title>${escXml(projectName)}</title>` +
      `<style>body{font-family:Georgia,serif;max-width:640px;margin:40px auto;line-height:1.6;color:#111}h1{border-bottom:2px solid #111;padding-bottom:8px}section{break-inside:avoid;margin-bottom:2em}.sum{color:#555;font-style:italic}a{color:#111}</style>` +
      `</head><body><h1>${escXml(projectName)}</h1>${blocks || '<p></p>'}<script>onload=()=>{print();}<\/script></body></html>`,
  );
  w.document.close();
}

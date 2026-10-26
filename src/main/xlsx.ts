/* The first sheet of an .xlsx file as rows of text cells: enough for a time-system export
   (shared strings, inline strings and numbers). An .xlsx is a zip of XML; Node's zlib
   inflates it, so no spreadsheet library ships with the app. */

import { inflateRawSync } from "node:zlib";

export function unzip(buf: Buffer): Map<string, Buffer> {
    const files = new Map<string, Buffer>();
    const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
    if (eocd < 0) throw new Error("This is not an .xlsx file.");
    const count = buf.readUInt16LE(eocd + 10);
    let off = buf.readUInt32LE(eocd + 16);
    for (let i = 0; i < count && buf.readUInt32LE(off) === 0x02014b50; i++) {
        const method = buf.readUInt16LE(off + 10), size = buf.readUInt32LE(off + 20);
        const nameLen = buf.readUInt16LE(off + 28), extraLen = buf.readUInt16LE(off + 30), commentLen = buf.readUInt16LE(off + 32);
        const local = buf.readUInt32LE(off + 42);
        const name = buf.toString("utf8", off + 46, off + 46 + nameLen);
        const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
        const data = buf.subarray(start, start + size);
        files.set(name, method === 8 ? inflateRawSync(data) : Buffer.from(data));
        off += 46 + nameLen + extraLen + commentLen;
    }
    return files;
}

const unescape = (s: string): string => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n))).replace(/&amp;/g, "&");
const texts = (xml: string): string => [...xml.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((m) => unescape(m[1])).join("");
const column = (ref: string): number => [...(ref.match(/^[A-Z]+/)?.[0] ?? "A")].reduce((n, c) => n * 26 + c.charCodeAt(0) - 64, 0) - 1;

export function readXlsx(buf: Buffer): string[][] {
    const files = unzip(buf);
    const shared = [...(files.get("xl/sharedStrings.xml")?.toString("utf8") ?? "").matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) => texts(m[1]));
    const sheetName = [...files.keys()].filter((k) => /^xl\/worksheets\/sheet\d+\.xml$/.test(k)).sort()[0];
    if (!sheetName) throw new Error("The workbook has no sheet.");
    const sheet = files.get(sheetName)!.toString("utf8");
    const rows: string[][] = [];
    for (const r of sheet.matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)) {
        const row: string[] = [];
        for (const c of r[1].matchAll(/<c([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
            const attrs = c[1], body = c[2] ?? "";
            const idx = column(attrs.match(/r="([A-Z]+)\d+"/)?.[1] ?? String.fromCharCode(65 + row.length));
            const type = attrs.match(/t="(\w+)"/)?.[1];
            const v = body.match(/<v>([\s\S]*?)<\/v>/)?.[1];
            row[idx] = type === "s" ? shared[Number(v)] ?? "" : type === "inlineStr" ? texts(body) : unescape(v ?? "");
        }
        rows.push(Array.from(row, (x) => x ?? ""));
    }
    return rows;
}

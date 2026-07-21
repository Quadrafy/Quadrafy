// Fonte determinística dos pins da TASK-71. Execute `node generate-achievement-pins.mjs`
// a partir desta pasta para regenerar os SVGs e PNGs de 128/256 px.
import { deflateSync } from "node:zlib";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const output = dirname(fileURLToPath(import.meta.url));
const pins = [
  ["pin-jogos-bronze", "matches", "bronze"], ["pin-jogos-prata", "matches", "prata"], ["pin-jogos-ouro", "matches", "ouro"], ["pin-jogos-diamante", "matches", "diamante"], ["pin-jogos-elite", "matches", "elite"],
  ["pin-vitorias-bronze", "wins", "bronze"], ["pin-vitorias-prata", "wins", "prata"], ["pin-vitorias-ouro", "wins", "ouro"], ["pin-vitorias-diamante", "wins", "diamante"], ["pin-vitorias-elite", "wins", "elite"],
  ["pin-sequencia-bronze", "streak", "bronze"], ["pin-sequencia-prata", "streak", "prata"], ["pin-sequencia-ouro", "streak", "ouro"],
  ["pin-torneios-bronze", "events", "bronze"], ["pin-torneios-prata", "events", "prata"], ["pin-torneios-ouro", "events", "ouro"],
  ["pin-nivel-bronze", "level", "bronze"], ["pin-nivel-prata", "level", "prata"], ["pin-nivel-ouro", "level", "ouro"], ["pin-nivel-diamante", "level", "diamante"],
  ["pin-social-parceiros-bronze", "social", "bronze"], ["pin-social-rivais-prata", "social", "prata"],
  ["pin-campeao-super8", "champion", "champion"],
];
const tiers = { bronze: "#b47a3b", prata: "#cbd3df", ouro: "#e8b84b", diamante: "#8ed3e8", elite: "#f5d16b", champion: "#e8b84b" };
const svgIcons = {
  matches: '<circle cx="106" cy="109" r="30" fill="none" stroke="#f6f4ef" stroke-width="10"/><path d="M128 132l31 31" stroke="#f6f4ef" stroke-width="11" stroke-linecap="round"/><circle cx="151" cy="82" r="10" fill="#ff6b4a"/>',
  wins: '<path d="M83 85h12v-9h22v9h12c0 15-6 25-18 28v12h11v10H84v-10h11v-12c-12-3-18-13-18-28Z" fill="#ff6b4a"/><path d="M83 91c-9 0-12 4-12 10 0 8 7 13 16 13M129 91c9 0 12 4 12 10 0 8-7 13-16 13" fill="none" stroke="#ff6b4a" stroke-width="7" stroke-linecap="round"/>',
  streak: '<path d="M109 64c10 25-4 31 7 42 7-4 10-13 8-22 18 19 16 55-10 66-24 10-46-7-43-30 2-17 14-24 20-39 5 8 8 11 12 2 3-7 4-13 6-19Z" fill="#ff6b4a"/><path d="M107 116c-6 10-3 20 5 23 10-5 11-17 5-27-1 8-5 12-10 4Z" fill="#f6f4ef"/>',
  events: '<circle cx="93" cy="92" r="13" fill="#f6f4ef"/><circle cx="129" cy="92" r="13" fill="#ff6b4a"/><path d="M70 137c4-19 13-29 23-29s19 10 23 29M106 137c4-19 13-29 23-29s19 10 23 29" fill="none" stroke="#f6f4ef" stroke-width="8" stroke-linecap="round"/>',
  level: '<path d="M77 135l25-25 16 16 39-44" fill="none" stroke="#ff6b4a" stroke-width="12" stroke-linecap="round" stroke-linejoin="round"/><path d="M135 82h22v22" fill="none" stroke="#ff6b4a" stroke-width="12" stroke-linecap="round" stroke-linejoin="round"/>',
  social: '<circle cx="91" cy="92" r="13" fill="#f6f4ef"/><circle cx="137" cy="93" r="13" fill="#ff6b4a"/><circle cx="114" cy="132" r="13" fill="#f6f4ef"/><path d="M100 101l12 20m15-20-12 20m-10-24h18" stroke="#f6f4ef" stroke-width="7" stroke-linecap="round"/>',
  champion: '<path d="M114 66l35 15v32c0 24-15 39-35 47-20-8-35-23-35-47V81l35-15Z" fill="none" stroke="#f6f4ef" stroke-width="9" stroke-linejoin="round"/><path d="M94 74h40l-6-10h-28l-6 10Z" fill="#e8b84b"/><path d="M100 109v20m14-30v30m14-20v20" stroke="#ff6b4a" stroke-width="7" stroke-linecap="round"/>',
};

function svg(name, kind, tier) {
  const ring = tiers[tier];
  const champion = kind === "champion";
  return `<?xml version="1.0" encoding="UTF-8"?><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 228 268" role="img" aria-labelledby="${name}-title"><title id="${name}-title">Pin Quadrafy</title><defs><linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop stop-color="#1b2a4a"/><stop offset="1" stop-color="#10192e"/></linearGradient></defs><path d="M82 181 68 254l46-27 46 27-14-73Z" fill="#1b2a4a"/><circle cx="114" cy="111" r="92" fill="url(#bg)" stroke="${ring}" stroke-width="14"/>${champion ? `<circle cx="114" cy="111" r="104" fill="none" stroke="${ring}" stroke-width="6"/>` : ""}<g transform="translate(0 2)">${svgIcons[kind]}</g></svg>`;
}

function crc32(buffer) { let crc = 0xffffffff; for (const byte of buffer) { crc ^= byte; for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0); } return (crc ^ 0xffffffff) >>> 0; }
function chunk(type, data) { const name = Buffer.from(type); const head = Buffer.alloc(4); head.writeUInt32BE(data.length, 0); const tail = Buffer.alloc(4); tail.writeUInt32BE(crc32(Buffer.concat([name, data])), 0); return Buffer.concat([head, name, data, tail]); }
function png(width, height, pixels) { const raw = Buffer.alloc((width * 4 + 1) * height); for (let y = 0; y < height; y += 1) { raw[y * (width * 4 + 1)] = 0; Buffer.from(pixels.buffer, pixels.byteOffset + y * width * 4, width * 4).copy(raw, y * (width * 4 + 1) + 1); } const header = Buffer.alloc(13); header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 6; return Buffer.concat([Buffer.from("\x89PNG\r\n\x1a\n", "binary"), chunk("IHDR", header), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]); }
function hex(value) { const clean = value.slice(1); return [parseInt(clean.slice(0, 2), 16), parseInt(clean.slice(2, 4), 16), parseInt(clean.slice(4, 6), 16), 255]; }
function drawPin(size, kind, tier) {
  const width = size, height = Math.round(size * 1.176), p = new Uint8Array(width * height * 4), scale = size / 228;
  const pixel = (x, y, color) => { x = Math.round(x); y = Math.round(y); if (x < 0 || y < 0 || x >= width || y >= height) return; p.set(color, (y * width + x) * 4); };
  const circle = (cx, cy, r, color, fill = true, stroke = 1) => { for (let y = Math.floor(cy-r); y <= Math.ceil(cy+r); y += 1) for (let x = Math.floor(cx-r); x <= Math.ceil(cx+r); x += 1) { const d = Math.hypot(x-cx, y-cy); if ((fill && d <= r) || (!fill && d <= r && d >= r-stroke)) pixel(x,y,color); } };
  const line = (x1,y1,x2,y2,w,color) => { const steps = Math.max(Math.abs(x2-x1),Math.abs(y2-y1)); for(let i=0;i<=steps;i+=1){ const t=i/steps; circle(x1+(x2-x1)*t,y1+(y2-y1)*t,w/2,color); } };
  const ring = hex(tiers[tier]), white = hex("#f6f4ef"), coral = hex("#ff6b4a"), navy = hex("#1b2a4a"), deep = hex("#10192e");
  for (let y=0;y<height;y+=1) for(let x=0;x<width;x+=1) pixel(x,y,[0,0,0,0]);
  const cx=114*scale, cy=111*scale, r=92*scale; circle(cx,cy,r+7*scale,ring); circle(cx,cy,r,deep); circle(cx-18*scale,cy-18*scale,r*.88,navy); if (kind==="champion") { circle(cx,cy,r+19*scale,ring,false,5*scale); }
  const ribbon=[[82,181],[68,254],[114,227],[160,254],[146,181]].map(([x,y])=>[x*scale,y*scale]); for(let y=Math.round(181*scale);y<height;y+=1){ const minX=Math.max(0,Math.round(68*scale)); const maxX=Math.min(width-1,Math.round(160*scale)); for(let x=minX;x<=maxX;x+=1){ const upper=181*scale+Math.abs(x-cx)*0.3; const lower=254*scale-Math.abs(x-cx)*0.58; if(y>=upper&&y<=lower) pixel(x,y,navy); } }
  if(kind==="matches"){ circle(106*scale,109*scale,30*scale,white,false,9*scale); line(128*scale,132*scale,159*scale,163*scale,10*scale,white); circle(151*scale,82*scale,10*scale,coral); }
  if(kind==="wins"){ for(let y=86;y<126;y+=1) for(let x=90;x<122;x+=1) if((y<114)|| (x>100&&x<112)) pixel(x*scale,y*scale,coral); line(79*scale,94*scale,86*scale,112*scale,6*scale,coral); line(133*scale,94*scale,126*scale,112*scale,6*scale,coral); line(85*scale,135*scale,125*scale,135*scale,8*scale,white); }
  if(kind==="streak"){ circle(110*scale,120*scale,37*scale,coral); circle(112*scale,132*scale,11*scale,white); line(95*scale,90*scale,110*scale,64*scale,9*scale,coral); }
  if(kind==="events"){ circle(93*scale,92*scale,13*scale,white); circle(129*scale,92*scale,13*scale,coral); line(78*scale,137*scale,107*scale,112*scale,8*scale,white); line(150*scale,137*scale,122*scale,112*scale,8*scale,white); }
  if(kind==="level"){ line(77*scale,135*scale,102*scale,110*scale,11*scale,coral); line(102*scale,110*scale,118*scale,126*scale,11*scale,coral); line(118*scale,126*scale,157*scale,82*scale,11*scale,coral); line(157*scale,82*scale,136*scale,82*scale,11*scale,coral); line(157*scale,82*scale,157*scale,103*scale,11*scale,coral); }
  if(kind==="social"){ circle(91*scale,92*scale,13*scale,white); circle(137*scale,93*scale,13*scale,coral); circle(114*scale,132*scale,13*scale,white); line(100*scale,101*scale,112*scale,121*scale,7*scale,white); line(128*scale,102*scale,116*scale,121*scale,7*scale,white); line(105*scale,93*scale,123*scale,93*scale,7*scale,white); }
  if(kind==="champion"){ line(86*scale,85*scale,86*scale,124*scale,8*scale,white); line(142*scale,85*scale,142*scale,124*scale,8*scale,white); line(86*scale,124*scale,114*scale,151*scale,8*scale,white); line(142*scale,124*scale,114*scale,151*scale,8*scale,white); line(91*scale,76*scale,137*scale,76*scale,10*scale,ring); line(100*scale,109*scale,100*scale,129*scale,7*scale,coral); line(114*scale,99*scale,114*scale,129*scale,7*scale,coral); line(128*scale,109*scale,128*scale,129*scale,7*scale,coral); }
  return png(width,height,p);
}

await mkdir(output, { recursive: true });
for (const [name, kind, tier] of pins) {
  await writeFile(resolve(output, `${name}.svg`), svg(name, kind, tier));
  await writeFile(resolve(output, `${name}-128.png`), drawPin(128, kind, tier));
  await writeFile(resolve(output, `${name}-256.png`), drawPin(256, kind, tier));
}

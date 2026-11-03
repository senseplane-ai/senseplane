// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

// The labels burned into a story (ADR 0070): a caption bar with the camera's
// name and the time, and the "+3 min" cards between pieces. Drawn here as raw
// RGBA frames with a small built-in pixel font, so ffmpeg needs no font
// library (drawtext needs FreeType and fontconfig) and the image needs no
// font files. Letters are drawn in capitals; anything the font lacks is a "?".

/** 5×7 glyphs, one string of five "#"/"." per row. */
const GLYPHS: Record<string, string> = {
  A: ".###.#...##...#######...##...##...#", B: "####.#...##...#####.#...##...#####.", C: ".###.#...##....#....#....#...#.###.",
  D: "####.#...##...##...##...##...#####.", E: "######....#....####.#....#....#####", F: "######....#....####.#....#....#....",
  G: ".###.#...##....#.####...##...#.####", H: "#...##...##...#######...##...##...#", I: ".###...#....#....#....#....#...###.",
  J: "..###...#....#....#....#.#..#..##..", K: "#...##..#.#.#..##...#.#..#..#.#...#", L: "#....#....#....#....#....#....#####",
  M: "#...###.###.#.##.#.##...##...##...#", N: "#...###..##.#.##..###...##...##...#", O: ".###.#...##...##...##...##...#.###.",
  P: "####.#...##...#####.#....#....#....", Q: ".###.#...##...##...##.#.##..#..##.#", R: "####.#...##...#####.#.#..#..#.#...#",
  S: ".#####....#.....###.....#....#####.", T: "#####..#....#....#....#....#....#..", U: "#...##...##...##...##...##...#.###.",
  V: "#...##...##...##...##...#.#.#...#..", W: "#...##...##...##.#.##.#.##.#.#.#.#.", X: "#...##...#.#.#...#...#.#.#...##...#",
  Y: "#...##...#.#.#...#....#....#....#..", Z: "#####....#...#...#...#...#....#####",
  "0": ".###.#...##..###.#.###..##...#.###.", "1": "..#...##....#....#....#....#...###.", "2": ".###.#...#....#...#...#...#...#####",
  "3": "#####...#...#.....#.....##...#.###.", "4": "...#...##..#.#.#..#.#####...#....#.", "5": "######....####.....#....##...#.###.",
  "6": "..##..#...#....####.#...##...#.###.", "7": "#####....#...#...#...#....#....#...", "8": ".###.#...##...#.###.#...##...#.###.",
  "9": ".###.#...##...#.####....#...#..##..",
  " ": "...................................", ":": "......#....#.........#....#........", "-": "................###................",
  ".": ".........................##...##...", ",": "....................##....#...#....", "/": "....#...#....#...#...#....#...#....",
  "+": "......#....#..#####..#....#........", "'": "..#....#...#.......................", "(": "...#...#...#....#....#.....#.....#.",
  ")": ".#.....#.....#....#....#...#...#...", "&": ".##..#..#.#.#...#...#.#.##..#..##.#", _: "..............................#####",
  "#": ".#.#..#.#.#####.#.#.#####.#.#..#.#.", "!": "..#....#....#....#....#.........#..", "?": ".###.#...#....#...#...#.........#..",
  "·": "...............#...................",
};
const FALLBACK = GLYPHS["?"]!;
const W = 5;
const H = 7;

function glyph(ch: string): string {
  const g = GLYPHS[ch] ?? GLYPHS[ch.toUpperCase()];
  if (g) return g;
  if (ch === "–" || ch === "—") return GLYPHS["-"]!;
  return FALLBACK;
}

/** Characters of `text` that fit in `width` pixels at `scale`. */
export function fitText(text: string, width: number, scale: number): string {
  const per = (W + 1) * scale;
  const max = Math.max(0, Math.floor(width / per));
  const chars = [...text];
  return chars.length <= max ? text : chars.slice(0, Math.max(0, max - 1)).join("") + ".";
}

export interface Rgba {
  width: number;
  height: number;
  data: Buffer;
}

type Color = [number, number, number, number];

function fill(img: Rgba, c: Color, x0 = 0, y0 = 0, w = img.width, h = img.height) {
  for (let y = Math.max(0, y0); y < Math.min(img.height, y0 + h); y++) {
    for (let x = Math.max(0, x0); x < Math.min(img.width, x0 + w); x++) {
      const i = (y * img.width + x) * 4;
      img.data[i] = c[0];
      img.data[i + 1] = c[1];
      img.data[i + 2] = c[2];
      img.data[i + 3] = c[3];
    }
  }
}

/** Width in pixels of `text` drawn at `scale`. */
export const textWidth = (text: string, scale: number) => Math.max(0, [...text].length * (W + 1) * scale - scale);

function draw(img: Rgba, text: string, x: number, y: number, scale: number, c: Color) {
  let cx = x;
  for (const ch of text) {
    const g = glyph(ch);
    for (let row = 0; row < H; row++) {
      for (let col = 0; col < W; col++) if (g[row * W + col] === "#") fill(img, c, cx + col * scale, y + row * scale, scale, scale);
    }
    cx += (W + 1) * scale;
  }
}

const WHITE: Color = [255, 255, 255, 255];
const DIM: Color = [200, 205, 215, 255];

/** The caption bar along the bottom of a piece: the camera's name on the left, the time on the right. */
export function captionBar(width: number, label: string, time: string): Rgba {
  const scale = Math.max(2, Math.round(width / 320));
  const height = H * scale + 4 * scale;
  const img: Rgba = { width, height, data: Buffer.alloc(width * height * 4) };
  fill(img, [12, 14, 20, 190]);
  const pad = 3 * scale;
  const y = 2 * scale;
  const timeW = textWidth(time, scale);
  draw(img, time, width - pad - timeW, y, scale, DIM);
  draw(img, fitText(label, width - timeW - pad * 4, scale), pad, y, scale, WHITE);
  return img;
}

/** A full frame between pieces: "+3 min" large, and what follows small under it. */
export function gapCard(width: number, height: number, big: string, small: string): Rgba {
  const img: Rgba = { width, height, data: Buffer.alloc(width * height * 4) };
  fill(img, [12, 14, 20, 255]);
  const s1 = Math.max(4, Math.round(width / 120));
  const s2 = Math.max(2, Math.round(width / 400));
  const top = Math.round(height / 2 - (H * s1) / 2 - H * s2);
  draw(img, big, Math.round((width - textWidth(big, s1)) / 2), top, s1, WHITE);
  const line = fitText(small, width - 8 * s2, s2);
  draw(img, line, Math.round((width - textWidth(line, s2)) / 2), top + H * s1 + 3 * s2, s2, DIM);
  return img;
}

/** "+45 s", "+3 min", "+2 h 10 min" for a gap between pieces. */
export function gapText(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 90) return `+${s} s`;
  const min = Math.round(s / 60);
  if (min < 60) return `+${min} min`;
  const h = Math.floor(min / 60);
  const rest = min % 60;
  if (h >= 48) return `+${Math.round(h / 24)} days`;
  return rest ? `+${h} h ${rest} min` : `+${h} h`;
}

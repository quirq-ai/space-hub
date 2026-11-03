/**
 * The live wallpaper: a slow flight around a gravity well in spacetime's fabric. Planets orbit in it and dent it as
 * they go, ripples roll out from a black hole at the bottom of the well, dust swirls in toward its glowing disk, stars
 * turn overhead and now and then one falls. Plain 3D on a 2D canvas, no library: a camera orbits the well and every
 * point is projected through it. Up to 30 frames a second, one still frame when motion is reduced, nothing while the
 * tab is hidden.
 */

/** How deep the fabric sags at (x, z): the black hole's well, a dimple under each planet, ripples rolling outward. */
export function fabric(x: number, z: number, t: number, bodies: Body[]): number {
  const r = Math.sqrt(x * x + z * z);
  let y = 0.25 - CORE / Math.sqrt(r * r + .64) + .09 * Math.sin(1.5 * r - 1.3 * t) * Math.exp(-r / 6);
  for (const b of bodies) { const dx = x - b.x, dz = z - b.z; y -= b.m / Math.sqrt(dx * dx + dz * dz + .12); }
  return y;
}

export type Body = { x: number; z: number; m: number };
export type Camera = { yaw: number; pitch: number; dist: number; target: number; focal: number; cx: number; cy: number };

/** A camera's eye and axes: right, up and forward. */
export function lens(c: Camera) {
  const cp = Math.cos(c.pitch), ex = c.dist * cp * Math.sin(c.yaw), ey = c.target + c.dist * Math.sin(c.pitch), ez = c.dist * cp * Math.cos(c.yaw);
  let fx = -ex, fy = c.target - ey, fz = -ez;
  const fl = Math.hypot(fx, fy, fz); fx /= fl; fy /= fl; fz /= fl;
  let rx = -fz, rz = fx;
  const rl = Math.hypot(rx, rz); rx /= rl; rz /= rl;
  return { ex, ey, ez, fx, fy, fz, rx, rz, ux: -rz * fy, uy: rz * fx - rx * fz, uz: rx * fy, focal: c.focal, cx: c.cx, cy: c.cy };
}
export type Lens = ReturnType<typeof lens>;

/** Where a point lands on screen and how far it is, or null behind the camera. */
export function project(l: Lens, x: number, y: number, z: number): [number, number, number] | null {
  const vx = x - l.ex, vy = y - l.ey, vz = z - l.ez, d = vx * l.fx + vy * l.fy + vz * l.fz;
  if (d < .3) return null;
  return [l.cx + l.focal * (vx * l.rx + vz * l.rz) / d, l.cy - l.focal * (vx * l.ux + vy * l.uy + vz * l.uz) / d, d];
}

const CORE = 2, GRID = 9, STEP = .5, FPS = 30;
const PLANETS = [
  { r: 2.7, m: .2, size: .15, phase: .6, color: [95, 214, 207] },
  { r: 4.5, m: .36, size: .24, phase: 2.9, color: [131, 214, 58] },
  { r: 6.6, m: .26, size: .19, phase: 4.6, color: [164, 140, 246] },
];
/** Kepler: the closer in, the faster round. */
const spin = (r: number, k: number) => k * Math.pow(r, -1.5);
const ease = (u: number) => { const v = Math.min(1, Math.max(0, u)); return v * v * (3 - 2 * v); };
const rgba = (c: number[], a: number) => `rgba(${c[0]},${c[1]},${c[2]},${a})`;

type Palette = {
  dark: boolean; base: string; clouds: [number, number, number, number[], number][]; line: number[]; lineAlpha: number;
  dust: number[][]; dustAlpha: number; star: number[]; starAlpha: number; glow: number[]; hole: string; disk: [number[], number[]];
};
const DARK: Palette = {
  dark: true, base: "#03070a",
  clouds: [[.18, .22, .62, [30, 150, 140], .2], [.82, .72, .55, [131, 214, 58], .13], [.86, .12, .48, [110, 84, 220], .16], [.1, .9, .5, [40, 90, 200], .12]],
  line: [131, 214, 58], lineAlpha: .3, dust: [[131, 214, 58], [95, 214, 207], [230, 244, 220]], dustAlpha: .75,
  star: [255, 255, 255], starAlpha: 1, glow: [131, 214, 58], hole: "#010203", disk: [[255, 250, 225], [131, 214, 58]],
};
const LIGHT: Palette = {
  dark: false, base: "#e4ece9",
  clouds: [[.18, .22, .62, [80, 190, 180], .24], [.82, .72, .55, [131, 214, 58], .2], [.86, .12, .48, [150, 130, 235], .16], [.5, .5, .4, [255, 255, 255], .5]],
  line: [44, 110, 28], lineAlpha: .24, dust: [[63, 125, 28], [31, 143, 136], [70, 90, 82]], dustAlpha: .45,
  star: [40, 70, 62], starAlpha: .28, glow: [120, 200, 50], hole: "#0b1411", disk: [[255, 252, 230], [100, 180, 40]],
};

type Star = { x: number; y: number; z: number; size: number; bright: number; tw: number; ph: number };
type Mote = { r: number; a: number; h: number; c: number; size: number };
type Comet = { x: number; y: number; dx: number; dy: number; born: number };

/** Runs the scene on a canvas until the returned stop is called. */
export function startSpace(canvas: HTMLCanvasElement, ctx: CanvasRenderingContext2D): () => void {
  const rand = mulberry(7);
  const stars: Star[] = Array.from({ length: 3500 }, () => {
    const u = rand() * 2 - 1, a = rand() * Math.PI * 2, s = Math.sqrt(1 - u * u), d = 60 + rand() * 30, b = rand() ** 3;
    return { x: d * s * Math.cos(a), y: d * u, z: d * s * Math.sin(a), size: .7 + b * 1.8, bright: .3 + b * .7, tw: .4 + rand() * 1.6, ph: rand() * 7 };
  });
  const dust: Mote[] = Array.from({ length: 700 }, () => ({ r: 1.3 + 7.4 * rand() ** 1.5, a: rand() * Math.PI * 2, h: (rand() - .5) * .08, c: Math.floor(rand() * 3), size: .7 + rand() * 1.3 }))
    .sort((p, q) => p.c - q.c);
  const disk: Mote[] = Array.from({ length: 700 }, () => ({ r: .34 + 1.2 * rand() ** 1.4, a: rand() * Math.PI * 2, h: (rand() - .5) * .04, c: 0, size: .8 + rand() * 1.4 }));
  const comets: Comet[] = [];
  const nebula = document.createElement("canvas");
  const still = matchMedia("(prefers-reduced-motion: reduce)");
  let palette = DARK, w = 0, h = 0, t = 40, last = 0, frame = 0, nextComet = 6, lookX = 0, lookY = 0, aimX = 0, aimY = 0;

  const paintNebula = () => {
    // A quarter size is plenty: it's all soft light, and it pans a little as the camera turns.
    const nw = nebula.width = Math.max(1, Math.ceil(w * 1.1 / 4)), nh = nebula.height = Math.max(1, Math.ceil(h * 1.1 / 4));
    const n = nebula.getContext("2d");
    if (!n) return;
    n.fillStyle = palette.base; n.fillRect(0, 0, nw, nh);
    for (const [x, y, r, c, a] of palette.clouds) {
      const g = n.createRadialGradient(x * nw, y * nh, 0, x * nw, y * nh, r * Math.max(nw, nh));
      g.addColorStop(0, rgba(c, a)); g.addColorStop(1, rgba(c, 0));
      n.fillStyle = g; n.fillRect(0, 0, nw, nh);
    }
    if (palette.dark) {
      const g = n.createRadialGradient(nw / 2, nh / 2, Math.min(nw, nh) * .3, nw / 2, nh / 2, Math.max(nw, nh) * .75);
      g.addColorStop(0, "rgba(0,0,0,0)"); g.addColorStop(1, "rgba(0,0,0,.55)");
      n.fillStyle = g; n.fillRect(0, 0, nw, nh);
    }
  };
  const resize = () => {
    const dpr = Math.min(devicePixelRatio || 1, 1.5);
    w = canvas.clientWidth; h = canvas.clientHeight;
    canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    paintNebula();
  };
  const retheme = () => { palette = document.documentElement.dataset.theme === "dark" ? DARK : LIGHT; paintNebula(); };

  const draw = () => {
    const p = palette, lighter = p.dark ? "lighter" : "source-over";
    const l = lens({ yaw: .7 + t * .022 + lookX, pitch: .5 + .04 * Math.sin(t * .05) + lookY, dist: 12, target: -1.1, focal: .8 * Math.max(w, h * .9), cx: w / 2, cy: h * .5 });
    const bodies = PLANETS.map(pl => { const a = pl.phase + t * spin(pl.r, 1.6); return { ...pl, a, x: pl.r * Math.cos(a), z: pl.r * Math.sin(a) }; });
    const sag = (x: number, z: number) => fabric(x, z, t, bodies);
    ctx.globalCompositeOperation = "source-over"; ctx.globalAlpha = 1;
    ctx.drawImage(nebula, -w * .05 + Math.sin(t * .022) * w * .03, -h * .05, w * 1.1, h * 1.1);

    // Stars, twinkling.
    ctx.fillStyle = rgba(p.star, 1);
    for (const s of stars) {
      const q = project(l, s.x, s.y, s.z);
      if (!q || q[0] < -4 || q[0] > w + 4 || q[1] < -4 || q[1] > h + 4) continue;
      ctx.globalAlpha = p.starAlpha * s.bright * (.65 + .35 * Math.sin(t * s.tw + s.ph));
      ctx.fillRect(q[0], q[1], s.size, s.size);
      if (s.bright > .85) ctx.fillRect(q[0] - s.size, q[1] + s.size / 2 - .3, s.size * 3, .6), ctx.fillRect(q[0] + s.size / 2 - .3, q[1] - s.size, .6, s.size * 3);
    }

    // A star falling now and then.
    if (t > nextComet) {
      const right = rand() < .5, a = .35 + rand() * .3;
      comets.push({ x: w * (.15 + rand() * .7), y: h * rand() * .4, dx: (right ? 1 : -1) * Math.cos(a), dy: Math.sin(a), born: t });
      nextComet = t + 5 + rand() * 7;
    }
    ctx.lineCap = "round";
    for (let i = comets.length - 1; i >= 0; i--) {
      const c = comets[i], age = (t - c.born) / .9;
      if (age > 1) { comets.splice(i, 1); continue; }
      const hx = c.x + c.dx * 820 * age * .9, hy = c.y + c.dy * 820 * age * .9, len = 150 * Math.min(1, age * 3);
      const g = ctx.createLinearGradient(hx, hy, hx - c.dx * len, hy - c.dy * len);
      g.addColorStop(0, rgba(p.star, .9 * p.starAlpha)); g.addColorStop(1, rgba(p.star, 0));
      ctx.globalAlpha = Math.sin(Math.PI * age); ctx.strokeStyle = g; ctx.lineWidth = 1.4;
      ctx.beginPath(); ctx.moveTo(hx, hy); ctx.lineTo(hx - c.dx * len, hy - c.dy * len); ctx.stroke();
    }

    // The fabric: a square lattice cut to a disc, fading out toward its rim, drawn in short runs so each fades on its own.
    ctx.globalCompositeOperation = lighter; ctx.strokeStyle = rgba(p.line, 1); ctx.lineWidth = 1;
    const lines = Math.floor(GRID / STEP);
    for (let i = -lines; i <= lines; i++) {
      const c = i * STEP, half = Math.sqrt(GRID * GRID - c * c), n = Math.max(2, Math.ceil(half / .11));
      for (let axis = 0; axis < 2; axis++) {
        for (let j0 = 0; j0 < 2 * n; j0 += 8) {
          const j1 = Math.min(2 * n, j0 + 8), mid = -half + (j0 + j1) / 2 / n * half, fade = ease((GRID - Math.hypot(c, mid)) / (GRID * .62));
          if (fade < .02) continue;
          ctx.globalAlpha = Math.min(1, p.lineAlpha * fade * (1 + 1.2 * Math.exp(-Math.hypot(c, mid) / 2)));
          ctx.beginPath();
          let pen = false;
          for (let j = j0; j <= j1; j++) {
            const s = -half + j / n * half, x = axis ? s : c, z = axis ? c : s, q = project(l, x, sag(x, z), z);
            if (!q) { pen = false; continue; }
            if (pen) ctx.lineTo(q[0], q[1]); else { ctx.moveTo(q[0], q[1]); pen = true; }
          }
          ctx.stroke();
        }
      }
    }

    // Orbits, and a fading trail behind each planet.
    for (const b of bodies) {
      ctx.strokeStyle = rgba(b.color, 1); ctx.lineWidth = 1; ctx.globalAlpha = p.dark ? .1 : .14;
      ctx.beginPath();
      for (let k = 0; k <= 120; k++) {
        const a = k / 120 * Math.PI * 2, x = b.r * Math.cos(a), z = b.r * Math.sin(a), q = project(l, x, sag(x, z) + .02, z);
        if (q) k ? ctx.lineTo(q[0], q[1]) : ctx.moveTo(q[0], q[1]);
      }
      ctx.stroke();
      ctx.lineWidth = 2;
      let prev: [number, number, number] | null = null;
      for (let k = 0; k <= 18; k++) {
        const a = b.a - k * .06, x = b.r * Math.cos(a), z = b.r * Math.sin(a), q = project(l, x, sag(x, z) + b.size * .4, z);
        if (q && prev) { ctx.globalAlpha = .55 * (1 - k / 18); ctx.beginPath(); ctx.moveTo(prev[0], prev[1]); ctx.lineTo(q[0], q[1]); ctx.stroke(); }
        prev = q;
      }
    }

    // Dust riding the fabric, swirling in.
    for (let i = 0, c = -1; i < dust.length; i++) {
      const m = dust[i];
      if (m.c !== c) { c = m.c; ctx.fillStyle = rgba(p.dust[c], 1); }
      const a = m.a + t * spin(m.r, 1.1), x = m.r * Math.cos(a), z = m.r * Math.sin(a), q = project(l, x, sag(x, z) + m.h, z);
      if (!q) continue;
      ctx.globalAlpha = p.dustAlpha * ease((GRID - m.r) / 3);
      const s = m.size * 10 / q[2];
      ctx.fillRect(q[0] - s / 2, q[1] - s / 2, s, s);
    }

    // The black hole: its glow, its disk (the far half behind it, the near half in front), planets in depth order.
    const coreY = sag(0, 0) + .12, core = project(l, 0, coreY, 0);
    const behind = (q: number[] | null) => !!q && !!core && q[2] > core[2];
    const planet = (b: typeof bodies[number]) => {
      const q = project(l, b.x, sag(b.x, b.z) + b.size, b.z);
      if (!q) return;
      const r = l.focal * b.size / q[2], lx = core ? core[0] - q[0] : 0, ly = core ? core[1] - q[1] : 0, ll = Math.hypot(lx, ly) || 1;
      ctx.globalCompositeOperation = lighter; ctx.globalAlpha = p.dark ? .35 : .25;
      const halo = ctx.createRadialGradient(q[0], q[1], 0, q[0], q[1], r * 3.2);
      halo.addColorStop(0, rgba(b.color, .8)); halo.addColorStop(1, rgba(b.color, 0));
      ctx.fillStyle = halo; ctx.beginPath(); ctx.arc(q[0], q[1], r * 3.2, 0, Math.PI * 2); ctx.fill();
      ctx.globalCompositeOperation = "source-over"; ctx.globalAlpha = 1;
      const lit = ctx.createRadialGradient(q[0] + lx / ll * r * .45, q[1] + ly / ll * r * .45, r * .05, q[0], q[1], r);
      lit.addColorStop(0, "rgba(255,255,255,.95)"); lit.addColorStop(.35, rgba(b.color, 1)); lit.addColorStop(1, rgba(b.color.map(v => Math.round(v * .25)), 1));
      ctx.fillStyle = lit; ctx.beginPath(); ctx.arc(q[0], q[1], r, 0, Math.PI * 2); ctx.fill();
    };
    const diskHalf = (far: boolean) => {
      ctx.globalCompositeOperation = lighter;
      for (const m of disk) {
        const a = m.a + t * spin(m.r, 1.4), x = m.r * Math.cos(a), z = m.r * Math.sin(a), q = project(l, x, coreY + m.h, z);
        if (!q || behind(q) !== far) continue;
        const heat = (m.r - .34) / 1.2;
        ctx.globalAlpha = .9 - heat * .65; ctx.fillStyle = rgba(heat < .4 ? p.disk[0] : p.disk[1], 1);
        const s = m.size * 11 / q[2];
        ctx.fillRect(q[0] - s / 2, q[1] - s / 2, s, s);
      }
    };
    for (const b of bodies) if (behind(project(l, b.x, 0, b.z))) planet(b);
    if (core) {
      const r = l.focal / core[2];
      ctx.globalCompositeOperation = lighter; ctx.globalAlpha = 1;
      const glow = ctx.createRadialGradient(core[0], core[1], 0, core[0], core[1], r * 2.2);
      glow.addColorStop(0, rgba(p.glow, p.dark ? .5 : .35)); glow.addColorStop(.35, rgba(p.glow, p.dark ? .16 : .12)); glow.addColorStop(1, rgba(p.glow, 0));
      ctx.fillStyle = glow; ctx.beginPath(); ctx.arc(core[0], core[1], r * 2.2, 0, Math.PI * 2); ctx.fill();
      diskHalf(true);
      ctx.globalCompositeOperation = "source-over";
      ctx.fillStyle = p.hole; ctx.beginPath(); ctx.arc(core[0], core[1], r * .24, 0, Math.PI * 2); ctx.fill();
      ctx.globalCompositeOperation = lighter; ctx.strokeStyle = rgba(p.disk[0], .85); ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.arc(core[0], core[1], r * .26, 0, Math.PI * 2); ctx.stroke();
      diskHalf(false);
    }
    for (const b of bodies) if (!behind(project(l, b.x, 0, b.z))) planet(b);
  };

  const tick = (now: number) => {
    frame = requestAnimationFrame(tick);
    if (now - last < 1000 / FPS - 2) return;
    t += Math.min(.1, (now - (last || now)) / 1000); last = now;
    lookX += (aimX - lookX) * .04; lookY += (aimY - lookY) * .04;
    draw();
  };
  const play = () => {
    cancelAnimationFrame(frame); last = 0;
    if (still.matches) draw(); else if (!document.hidden) frame = requestAnimationFrame(tick);
  };
  const aim = (e: PointerEvent) => { aimX = (e.clientX / (w || 1) - .5) * .12; aimY = (e.clientY / (h || 1) - .5) * .05; };
  const onResize = () => { resize(); draw(); };
  const theme = new MutationObserver(() => { retheme(); draw(); });

  retheme(); resize(); draw(); play();
  theme.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
  addEventListener("resize", onResize);
  addEventListener("pointermove", aim, { passive: true });
  document.addEventListener("visibilitychange", play);
  still.addEventListener("change", play);
  return () => {
    cancelAnimationFrame(frame); theme.disconnect();
    removeEventListener("resize", onResize); removeEventListener("pointermove", aim);
    document.removeEventListener("visibilitychange", play); still.removeEventListener("change", play);
  };
}

/** A small seeded random, so the sky is the same on every visit. */
function mulberry(seed: number) {
  return () => {
    seed = seed + 0x6d2b79f5 | 0;
    let r = Math.imul(seed ^ seed >>> 15, 1 | seed);
    r = r + Math.imul(r ^ r >>> 7, 61 | r) ^ r;
    return ((r ^ r >>> 14) >>> 0) / 4294967296;
  };
}
